import { decodeInteraction, deriveInteractionState } from "./interactions";

/** Chat plaintext stays in this browser's IndexedDB, never in the relay database. */
export type HistoryMessage = {
  id: string;
  transportId?: string;
  senderSessionId: string;
  sentAt: number;
  kind: "text";
  plaintext: string;
  expiresAt?: number;
  delivery?: "pending" | "sent";
  imported?: boolean;
  /** Ownership relative to the browser that exported an imported archive. */
  mine?: boolean;
  /** Frozen like count for imported messages; imported interaction events are not replayed. */
  likes?: number;
};

type StoredMessage = HistoryMessage & { roomId: string; sessionId: string; context?: number };

const DATABASE = "elm-chat-history";
const STORE = "messages";
const SCOPE_INDEX = "room-session";
const TIME_INDEX = "room-session-time";
const CONTEXT_INDEX = "room-session-context";

function storedMessage(roomId: string, sessionId: string, message: HistoryMessage): StoredMessage {
  const context = !message.imported && (message.delivery === "pending" || decodeInteraction(message.plaintext)) ? 1 : 0;
  return { ...message, roomId, sessionId, context };
}

function unpack({ roomId: _roomId, sessionId: _sessionId, context: _context, ...message }: StoredMessage): HistoryMessage {
  return message;
}

function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable; chat history cannot be persisted."));
      return;
    }
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = (event) => {
      const store = event.oldVersion === 0
        ? request.result.createObjectStore(STORE, { keyPath: ["roomId", "sessionId", "id"] })
        : request.transaction!.objectStore(STORE);
      if (event.oldVersion === 0) store.createIndex(SCOPE_INDEX, ["roomId", "sessionId"]);
      store.createIndex(TIME_INDEX, ["roomId", "sessionId", "sentAt", "id"]);
      store.createIndex(CONTEXT_INDEX, ["roomId", "sessionId", "context"]);
      // One-time v1 migration; normal room opens only read one history page.
      if (event.oldVersion > 0) {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          const value = cursor.result.value as StoredMessage;
          cursor.result.update(storedMessage(value.roomId, value.sessionId, value));
          cursor.result.continue();
        };
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open local chat history."));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function withHistory<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => () => T
): Promise<T> {
  const db = await openHistory();
  return new Promise<T>((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE, mode);
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? new Error("Local chat history transaction aborted."));
      };
      // Request success alone does not guarantee durability: wait for the commit.
      transaction.oncomplete = () => {
        db.close();
        resolve(result());
      };
      const result = operation(transaction.objectStore(STORE));
    } catch (error) {
      db.close();
      reject(error);
    }
  });
}

export function loadHistory(roomId: string, sessionId: string): Promise<HistoryMessage[]> {
  return withHistory("readonly", (store) => {
    const request = store.index(SCOPE_INDEX).getAll([roomId, sessionId]);
    let messages: HistoryMessage[] = [];
    request.onsuccess = () => {
      messages = (request.result as StoredMessage[])
        .map(unpack)
        .sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    };
    return () => messages;
  });
}

export type HistoryCursor = Pick<HistoryMessage, "sentAt" | "id">;

/** Read at most limit + 1 indexed rows, newest first, then display chronologically. */
export function loadHistoryPage(roomId: string, sessionId: string, before?: HistoryCursor, limit = 100) {
  return withHistory("readonly", (store) => {
    const range = IDBKeyRange.bound(
      [roomId, sessionId],
      before ? [roomId, sessionId, before.sentAt, before.id] : [roomId, sessionId, []],
      false, Boolean(before)
    );
    const request = store.index(TIME_INDEX).openCursor(range, "prev");
    const messages: HistoryMessage[] = [];
    let hasMore = false;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (messages.length === limit) { hasMore = true; return; }
      messages.push(unpack(cursor.value as StoredMessage));
      cursor.continue();
    };
    return () => ({ messages: messages.reverse(), hasMore });
  });
}

/** Keep shared interaction state and the durable outbox independent of the displayed page. */
export function loadHistoryContext(roomId: string, sessionId: string): Promise<HistoryMessage[]> {
  return withHistory("readonly", (store) => {
    const request = store.index(CONTEXT_INDEX).getAll([roomId, sessionId, 1]);
    let messages: HistoryMessage[] = [];
    request.onsuccess = () => { messages = (request.result as StoredMessage[]).map(unpack); };
    return () => messages;
  });
}

/** Existing IDs win, including when another tab imports concurrently. Never enqueue imports. */
export function importHistory(roomId: string, sessionId: string, messages: readonly HistoryMessage[]): Promise<number> {
  // Older archives carry like events but no snapshots. Resolve them within the
  // archive before pagination; never apply imported events to the live room.
  const historicalLikes = deriveInteractionState(messages).likes;
  return withHistory("readwrite", (store) => {
    let added = 0;
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const request = store.get([roomId, sessionId, message.id]);
      request.onsuccess = () => {
        if (request.result) return;
        const likes = message.likes ?? historicalLikes.get(message.id);
        store.put(storedMessage(roomId, sessionId, { ...message, ...(likes === undefined ? {} : { likes }), imported: true, delivery: "sent" }));
        added += 1;
      };
    }
    return () => added;
  });
}

/** Upsert supplied messages only; concurrent tabs' other messages are never erased. */
export function saveHistory(roomId: string, sessionId: string, messages: readonly HistoryMessage[]): Promise<void> {
  return withHistory("readwrite", (store) => {
    for (const message of messages) store.put(storedMessage(roomId, sessionId, message));
    return () => undefined;
  });
}

/** Complete received images are insert-only: retries and malicious inner IDs cannot overwrite history. */
export function saveReceivedImage(roomId: string, sessionId: string, message: HistoryMessage): Promise<boolean> {
  return withHistory("readwrite", store => {
    let added = false;
    const request = store.get([roomId, sessionId, message.id]);
    request.onsuccess = () => {
      if (request.result) return;
      store.put(storedMessage(roomId, sessionId, message));
      added = true;
    };
    return () => added;
  });
}
