/** Minimal runtime boundary for the existing room protocol. */
export interface RoomSocket {
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface RoomContext {
  readonly storage: RoomStorage;
  /** All public room calls must already be serialized by the server queue. */
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  getWebSockets(): RoomSocket[];
}
