import { describe, expect, it } from "vitest";
import { MemoryMetadataStore } from "../apps/server/src/storage";

describe("process-local metadata", () => {
  it("copies memory values and rejects message keys", async () => {
    const store = new MemoryMetadataStore(); const value = { "room:meta": { id: "a" } };
    await store.save("a", value); value["room:meta"].id = "changed";
    const loaded = await store.load("a"); (loaded!["room:meta"] as { id: string }).id = "again";
    const snapshot = store.snapshot(); snapshot.a = {};
    expect(await store.load("a")).toEqual({ "room:meta": { id: "a" } });
    await expect(store.save("a", { messages: "private" })).rejects.toThrow();
    expect(await store.load("missing")).toBeUndefined();
  });
  it("does not share rooms with a fresh store", async () => {
    const store = new MemoryMetadataStore();
    await store.save("room", { "room:meta": { id: "room" }, "room:invites": [] });
    expect(await new MemoryMetadataStore().load("room")).toBeUndefined();
  });
});
