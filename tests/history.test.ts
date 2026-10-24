import { afterEach, describe, expect, it, vi } from "vitest";
import { importHistory, loadHistory, loadHistoryPage, saveHistory, type HistoryMessage } from "../apps/web/src/history";

const message: HistoryMessage = {
  id: "one", senderSessionId: "sender", sentAt: 1, kind: "text", plaintext: "hello", delivery: "pending"
};

afterEach(() => vi.unstubAllGlobals());

// Controlled IndexedDB events verify that request success is not mistaken for durability.
function database() {
  const request: Record<string, any> = {};
  const transaction: Record<string, any> = {};
  const getAll: Record<string, any> = {};
  const put = vi.fn();
  const get = vi.fn(() => ({}));
  const cursor: Record<string, any> = {};
  const openCursor = vi.fn(() => cursor);
  const getAllForScope = vi.fn(() => getAll);
  transaction.objectStore = () => ({ put, get, index: () => ({ getAll: getAllForScope, openCursor }) });
  const db = { transaction: vi.fn(() => transaction), close: vi.fn() };
  vi.stubGlobal("indexedDB", { open: () => request });
  return { request, transaction, getAll, getAllForScope, put, get, cursor, openCursor, db, open() { request.result = db; request.onsuccess(); } };
}

describe("local chat history", () => {
  it("reads only one reverse-ordered page, including equal-time IDs", async () => {
    const storage = database();
    const bound = vi.fn(() => "range");
    vi.stubGlobal("IDBKeyRange", { bound });
    const promise = loadHistoryPage("room", "session", undefined, 2);
    storage.open();
    await Promise.resolve();
    expect(storage.openCursor).toHaveBeenCalledWith("range", "prev");
    const next = vi.fn();
    for (const id of ["c", "b", "a"]) {
      storage.cursor.result = { value: { ...message, id, sentAt: 2, roomId: "room", sessionId: "session" }, continue: next };
      storage.cursor.onsuccess();
    }
    storage.transaction.oncomplete();
    expect(await promise).toEqual({ messages: [{ ...message, id: "b", sentAt: 2 }, { ...message, id: "c", sentAt: 2 }], hasMore: true });
    expect(next).toHaveBeenCalledTimes(2);
    expect(storage.getAllForScope).not.toHaveBeenCalled();
  });

  it("imports only missing IDs and marks them local-only without pending delivery", async () => {
    const storage = database();
    const reads: Record<string, any>[] = [];
    storage.get.mockImplementation(() => { const request = {}; reads.push(request); return request; });
    const promise = importHistory("room", "session", [message, { ...message, id: "two", mine: true, likes: 3 }, { ...message, id: "two" }]);
    storage.open();
    await Promise.resolve();
    reads[0].result = message;
    reads[0].onsuccess();
    reads[1].result = undefined;
    reads[1].onsuccess();
    storage.transaction.oncomplete();
    expect(await promise).toBe(1);
    expect(storage.get).toHaveBeenCalledTimes(2);
    expect(storage.put).toHaveBeenCalledOnce();
    expect(storage.put.mock.calls[0][0]).toMatchObject({ id: "two", imported: true, delivery: "sent", mine: true, likes: 3, context: 0 });
  });

  it("rejects unavailable storage instead of silently using memory", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(loadHistory("room", "session")).rejects.toThrow();
    await expect(saveHistory("room", "session", [message])).rejects.toThrow();
  });

  it("puts messages under a room/session/message composite key and waits for commit", async () => {
    const storage = database();
    let completed = false;
    const promise = saveHistory("room", "session", [message]).then(() => { completed = true; });
    storage.open();
    await Promise.resolve();
    expect(storage.put).toHaveBeenCalledWith({ ...message, roomId: "room", sessionId: "session", context: 1 });
    expect(completed).toBe(false);
    storage.transaction.oncomplete();
    await promise;
    expect(storage.db.close).toHaveBeenCalledOnce();
  });

  it("returns deterministic chronological messages only after the read transaction completes", async () => {
    const storage = database();
    const promise = loadHistory("room", "session");
    storage.open();
    await Promise.resolve();
    expect(storage.getAllForScope).toHaveBeenCalledWith(["room", "session"]);
    storage.getAll.result = [
      { ...message, id: "b", sentAt: 2, roomId: "room", sessionId: "session" },
      { ...message, id: "a", sentAt: 2, roomId: "room", sessionId: "session" },
      { ...message, roomId: "room", sessionId: "session" }
    ];
    storage.getAll.onsuccess();
    storage.transaction.oncomplete();
    expect(await promise).toEqual([message, { ...message, id: "a", sentAt: 2 }, { ...message, id: "b", sentAt: 2 }]);
  });

  it("rejects aborted writes", async () => {
    const storage = database();
    const promise = saveHistory("room", "session", [message]);
    storage.open();
    await Promise.resolve();
    storage.transaction.error = new Error("quota exceeded");
    storage.transaction.onabort();
    await expect(promise).rejects.toThrow("quota exceeded");
  });
});

describe('assembled image persistence', () => {
  it('inserts a complete image atomically without replacing an existing ID', async () => {
    const { saveReceivedImage } = await import('../apps/web/src/history');
    const storage = database();
    const read: Record<string, any> = {};
    storage.get.mockReturnValue(read);
    const result = saveReceivedImage('room', 'session', message);
    storage.open(); await Promise.resolve();
    read.result = { ...message, plaintext: 'original' }; read.onsuccess();
    storage.transaction.oncomplete();
    expect(await result).toBe(false);
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('commits a newly assembled image before reporting success', async () => {
    const { saveReceivedImage } = await import('../apps/web/src/history');
    const storage = database();
    const read: Record<string, any> = {};
    storage.get.mockReturnValue(read);
    const result = saveReceivedImage('room', 'session', message);
    storage.open(); await Promise.resolve();
    read.result = undefined; read.onsuccess();
    storage.transaction.oncomplete();
    expect(await result).toBe(true);
    expect(storage.put).toHaveBeenCalledOnce();
  });
});

it('recovers likes from legacy archive events before pagination without replaying them', async () => {
  const storage = database();
  const reads: Record<string, any>[] = [];
  storage.get.mockImplementation(() => { const request = {}; reads.push(request); return request; });
  const like: HistoryMessage = { ...message, id: 'legacy-like', senderSessionId: 'other', plaintext: 'elm-interaction:v1:{"type":"message.like","id":"legacy-like","replyTo":"one"}' };
  const imported = importHistory('room', 'different-session', [message, like]);
  storage.open(); await Promise.resolve();
  for (const read of reads) { read.result = undefined; read.onsuccess(); }
  storage.transaction.oncomplete();
  expect(await imported).toBe(2);
  expect(storage.put.mock.calls[0]![0]).toMatchObject({ id: 'one', imported: true, likes: 1, context: 0 });
});
