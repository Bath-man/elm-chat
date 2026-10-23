import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface MetadataStore {
  load(roomId: string): Promise<Record<string, unknown> | undefined>;
  save(roomId: string, values: Record<string, unknown>): Promise<void>;
}

/** Narrow SDK boundary; normal reads return arrays, transactional reads return one object. */
export interface CloudbaseResult {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}
export interface CloudbaseDocument {
  get(): Promise<CloudbaseResult>;
  set(values: Record<string, unknown>): Promise<CloudbaseResult>;
}
export interface CloudbaseCollectionAccess {
  collection(name: string): { doc(id: string): CloudbaseDocument };
}
export interface CloudbaseDatabase extends CloudbaseCollectionAccess {
  runTransaction<T>(callback: (transaction: CloudbaseCollectionAccess) => Promise<T>): Promise<T>;
}

export function assertDatabaseSuccess(result: CloudbaseResult): void {
  if (result.code) throw new Error(`CloudBase database error ${String(result.code)}: ${String(result.message ?? "request failed")}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function metadata(value: unknown): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => key !== "room:meta" && key !== "room:invites")) {
    throw new Error("Room storage accepts room:meta and room:invites only; chat messages must not be persisted on the server");
  }
  return copy(value);
}

export class MemoryMetadataStore implements MetadataStore {
  protected rooms = new Map<string, Record<string, unknown>>();
  async load(roomId: string): Promise<Record<string, unknown> | undefined> {
    const values = this.rooms.get(roomId);
    return values === undefined ? undefined : copy(values);
  }
  async save(roomId: string, values: Record<string, unknown>): Promise<void> {
    this.rooms.set(roomId, metadata(values));
  }
  snapshot(): Record<string, Record<string, unknown>> { return copy(Object.fromEntries(this.rooms)); }
}

/** Local development only: one process serializes whole-file writes and atomically replaces the file. */
export class FileMetadataStore extends MemoryMetadataStore {
  private initialized: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) { super(); }
  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      let text: string;
      try { text = await readFile(this.file, "utf8"); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      const values: unknown = JSON.parse(text);
      if (!record(values)) throw new Error("Invalid room metadata file");
      this.rooms = new Map(Object.entries(values).map(([id, value]) => [id, metadata(value)]));
    })();
  }
  override async load(roomId: string): Promise<Record<string, unknown> | undefined> {
    await this.initialize(); await this.writes;
    return super.load(roomId);
  }
  override async save(roomId: string, values: Record<string, unknown>): Promise<void> {
    const safeValues = metadata(values);
    const operation = this.writes.then(async () => {
      await this.initialize();
      const next = new Map(this.rooms); next.set(roomId, safeValues);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
        await rename(temporary, this.file);
        this.rooms = next;
      } finally { await rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => undefined);
    await operation;
  }
}

export class CloudbaseMetadataStore implements MetadataStore {
  constructor(
    private readonly db: CloudbaseDatabase,
    private readonly collection = "chat_rooms",
    private readonly lease?: { owner: string; collection: string }
  ) {}
  async load(roomId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.db.collection(this.collection).doc(roomId).get();
    assertDatabaseSuccess(result);
    if (!Array.isArray(result.data)) throw new Error("Invalid CloudBase room response");
    if (result.data.length === 0) return undefined;
    const document: unknown = result.data[0];
    if (!record(document)) throw new Error("Invalid CloudBase room document");
    return metadata(document.values);
  }
  async save(roomId: string, values: Record<string, unknown>): Promise<void> {
    const safeValues = metadata(values);
    if (this.lease) {
      const lease = this.lease;
      await this.db.runTransaction(async (transaction) => {
        const result = await transaction.collection(lease.collection).doc("singleton").get();
        assertDatabaseSuccess(result);
        const value = result.data;
        if (!record(value) || value.owner !== lease.owner || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
          throw new Error("Runtime lease expired or belongs to another server");
        }
        assertDatabaseSuccess(await transaction.collection(this.collection).doc(roomId).set({ values: safeValues }));
      });
    } else {
      assertDatabaseSuccess(await this.db.collection(this.collection).doc(roomId).set({ values: safeValues }));
    }
  }
}
