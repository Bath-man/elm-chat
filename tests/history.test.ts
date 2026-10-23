import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHistory, saveHistory, type HistoryMessage } from "../apps/web/src/history";

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
  const getAllForScope = vi.fn(() => getAll);
  transaction.objectStore = () => ({ put, index: () => ({ getAll: getAllForScope }) });
  const db = { transaction: vi.fn(() => transaction), close: vi.fn() };
  vi.stubGlobal("indexedDB", { open: () => request });
  return { request, transaction, getAll, getAllForScope, put, db, open() { request.result = db; request.onsuccess(); } };
}

describe("local chat history", () => {
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
    expect(storage.put).toHaveBeenCalledWith({ ...message, roomId: "room", sessionId: "session" });
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
