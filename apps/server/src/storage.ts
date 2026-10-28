/** Process-local room metadata only. Nothing is written to disk or a database. */
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

export class MemoryMetadataStore {
  private readonly rooms = new Map<string, Record<string, unknown>>();
  async load(roomId: string): Promise<Record<string, unknown> | undefined> {
    const values = this.rooms.get(roomId);
    return values === undefined ? undefined : copy(values);
  }
  async save(roomId: string, values: Record<string, unknown>): Promise<void> {
    this.rooms.set(roomId, metadata(values));
  }
  snapshot(): Record<string, Record<string, unknown>> { return copy(Object.fromEntries(this.rooms)); }
}
