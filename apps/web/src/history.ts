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
};

type StoredMessage = HistoryMessage & { roomId: string; sessionId: string };

const DATABASE = "elm-chat-history";
const STORE = "messages";
const SCOPE_INDEX = "room-session";

function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable; chat history cannot be persisted."));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ["roomId", "sessionId", "id"] });
      store.createIndex(SCOPE_INDEX, ["roomId", "sessionId"]);
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
        .map(({ roomId: _roomId, sessionId: _sessionId, ...message }) => message)
        .sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    };
    return () => messages;
  });
}

/** Upsert supplied messages only; concurrent tabs' other messages are never erased. */
export function saveHistory(roomId: string, sessionId: string, messages: readonly HistoryMessage[]): Promise<void> {
  return withHistory("readwrite", (store) => {
    for (const message of messages) store.put({ ...message, roomId, sessionId });
    return () => undefined;
  });
}
