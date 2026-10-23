import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudbaseMetadataStore, FileMetadataStore, MemoryMetadataStore, type CloudbaseDatabase, type CloudbaseDocument } from "../apps/server/src/storage";
import { CloudbaseLease } from "../apps/server/src/lease";

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

function fakeDatabase() {
  const records = new Map<string, Record<string, unknown>>();
  let failure: "throw" | "code" | undefined;
  let queue = Promise.resolve();
  const access = (transaction: boolean) => ({ collection: (name: string) => ({ doc: (id: string): CloudbaseDocument => ({
    async get() {
      if (failure === "throw") throw new Error("network unavailable");
      if (failure === "code") return { code: "PERMISSION_DENIED" };
      const value = records.get(`${name}/${id}`);
      return { data: transaction ? value ?? null : value ? [value] : [] };
    },
    async set(value) {
      if (failure === "throw") throw new Error("network unavailable");
      if (failure === "code") return { code: "PERMISSION_DENIED" };
      records.set(`${name}/${id}`, structuredClone(value)); return {};
    }
  }) }) });
  const db: CloudbaseDatabase = {
    ...access(false),
    runTransaction(callback) {
      const operation = queue.then(() => callback(access(true)));
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
  return { db, records, fail(value: typeof failure) { failure = value; } };
}

describe("metadata storage", () => {
  it("copies memory values and rejects message keys", async () => {
    const store = new MemoryMetadataStore(); const value = { "room:meta": { id: "a" } };
    await store.save("a", value); value["room:meta"].id = "changed";
    const loaded = await store.load("a"); (loaded!["room:meta"] as { id: string }).id = "again";
    const snapshot = store.snapshot(); snapshot.a = {};
    expect(await store.load("a")).toEqual({ "room:meta": { id: "a" } });
    await expect(store.save("a", { messages: "private" })).rejects.toThrow();
    expect(await store.load("missing")).toBeUndefined();
  });
  it("persists all concurrent room writes and reloads after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-storage-")); directories.push(dir);
    const file = join(dir, "nested/rooms.json"); const store = new FileMetadataStore(file);
    await Promise.all(Array.from({ length: 30 }, (_, index) => store.save(String(index), { "room:meta": { index } })));
    const restart = new FileMetadataStore(file);
    expect(await restart.load("29")).toEqual({ "room:meta": { index: 29 } });
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toHaveLength(30);
    await expect(restart.save("x", { plaintext: "never" })).rejects.toThrow();
  });
  it("fails closed on corrupt local metadata instead of resetting rooms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-storage-")); directories.push(dir);
    const file = join(dir, "rooms.json"); await writeFile(file, "{corrupt");
    const store = new FileMetadataStore(file);
    await expect(store.load("a")).rejects.toThrow();
    await expect(store.save("a", {})).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{corrupt");
  });
  it("reads SDK array results and writes direct values fields only", async () => {
    const fixture = fakeDatabase(); const store = new CloudbaseMetadataStore(fixture.db);
    expect(await store.load("missing")).toBeUndefined();
    await store.save("a", { "room:meta": { id: "a" }, "room:invites": [] });
    expect(fixture.records.get("chat_rooms/a")).toEqual({ values: { "room:meta": { id: "a" }, "room:invites": [] } });
    expect(await store.load("a")).toEqual({ "room:meta": { id: "a" }, "room:invites": [] });
    await expect(store.save("a", { ciphertext: "no" })).rejects.toThrow();
  });
  it("fences writes against expired or replaced runtime leases in the same transaction", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const fixture = fakeDatabase();
    const store = new CloudbaseMetadataStore(fixture.db, "chat_rooms", { owner: "a", collection: "chat_runtime" });
    await expect(store.save("room", {})).rejects.toThrow("lease");
    fixture.records.set("chat_runtime/singleton", { owner: "a", expiresAt: 2000 });
    await store.save("room", { "room:meta": { id: "old" } });
    vi.setSystemTime(2000);
    await expect(store.save("room", { "room:meta": { id: "bad" } })).rejects.toThrow("lease");
    fixture.records.set("chat_runtime/singleton", { owner: "b", expiresAt: 3000 });
    await expect(store.save("room", {})).rejects.toThrow("lease");
    fixture.records.set("chat_runtime/singleton", { owner: "a", expiresAt: Number.NaN });
    await expect(store.save("room", {})).rejects.toThrow("lease");
    expect(await store.load("room")).toEqual({ "room:meta": { id: "old" } });
  });
  it("does not treat database failures or corrupt metadata as absent rooms", async () => {
    const fixture = fakeDatabase(); const store = new CloudbaseMetadataStore(fixture.db);
    fixture.fail("throw"); await expect(store.load("a")).rejects.toThrow("network");
    fixture.fail("code"); await expect(store.load("a")).rejects.toThrow("PERMISSION_DENIED");
    await expect(store.save("a", {})).rejects.toThrow("PERMISSION_DENIED");
    fixture.fail(undefined); fixture.records.set("chat_rooms/a", { values: { plaintext: "not allowed" } });
    await expect(store.load("a")).rejects.toThrow();
  });
});

describe("single CloudBase runtime lease", () => {
  it("allows one owner, renews, and permits expired takeover without stale release", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const fixture = fakeDatabase(); const first = new CloudbaseLease(fixture.db, "chat_runtime", "first");
    const second = new CloudbaseLease(fixture.db, "chat_runtime", "second");
    expect(await first.renew()).toBe(true); expect(first.isValid()).toBe(true);
    expect(await second.renew()).toBe(false); expect(second.isValid()).toBe(false);
    vi.setSystemTime(30_000); expect(await first.renew()).toBe(true);
    vi.setSystemTime(55_001); expect(first.isValid()).toBe(false);
    expect(await second.renew()).toBe(false);
    vi.setSystemTime(60_001); expect(await second.renew()).toBe(true);
    await first.release(); expect(first.isValid()).toBe(false);
    expect(fixture.records.get("chat_runtime/singleton")?.owner).toBe("second");
    await second.release(); expect(second.isValid()).toBe(false);
    expect(await first.renew()).toBe(true);
  });
  it("serializes competing transactions and reads time inside transaction", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase(); const a = new CloudbaseLease(fixture.db, undefined, "a");
    const b = new CloudbaseLease(fixture.db, undefined, "b");
    expect(await Promise.all([a.renew(), b.renew()])).toEqual([true, false]);
    let callback: (() => Promise<unknown>) | undefined;
    const delayed: CloudbaseDatabase = { ...fixture.db, runTransaction(fn) { return new Promise((resolve, reject) => { callback = () => fixture.db.runTransaction(fn).then(resolve, reject); }); } };
    const c = new CloudbaseLease(delayed, undefined, "c"); const pending = c.renew();
    vi.setSystemTime(32_000); await callback!(); expect(await pending).toBe(true);
    expect(fixture.records.get("chat_runtime/singleton")?.expiresAt).toBe(62_000);
  });
  const oldRelease = "1700000000000-00000000-0000-4000-8000-000000000001";
  const newRelease = "1700000000001-00000000-0000-4000-8000-000000000002";
  it("requests a newer release handoff without taking live authority, drains then acquires", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old", 30_000, oldRelease);
    const next = new CloudbaseLease(fixture.db, undefined, "next", 30_000, newRelease);
    expect(await old.renew()).toBe(true);
    expect(await next.renew()).toBe(false);
    expect(fixture.records.get("chat_runtime/singleton")?.owner).toBe("old");
    expect(await old.renew()).toBe(false); expect(old.isValid()).toBe(false);
    await old.release();
    expect(fixture.records.get("chat_runtime/singleton")?.handoffRelease).toBe(newRelease);
    // A restarted old image must not win the gap between owner shutdown and standby polling.
    const restarted = new CloudbaseLease(fixture.db, undefined, "old-restarted", 30_000, oldRelease);
    expect(await restarted.renew()).toBe(false);
    expect(await next.renew()).toBe(true);
    expect(await restarted.renew()).toBe(false);
    expect(await next.renew()).toBe(true);
    expect(fixture.records.get("chat_runtime/singleton")?.handoffRelease).toBeUndefined();
  });
  it("never evicts same or newer release owners and preserves requests across competing renewal", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old", 30_000, oldRelease);
    const same = new CloudbaseLease(fixture.db, undefined, "same", 30_000, oldRelease);
    const next = new CloudbaseLease(fixture.db, undefined, "next", 30_000, newRelease);
    await old.renew(); expect(await same.renew()).toBe(false); expect(await old.renew()).toBe(true);
    expect(await Promise.all([old.renew(), next.renew()])).toEqual([true, false]);
    const request = structuredClone(fixture.records.get("chat_runtime/singleton"));
    expect(await Promise.all([next.renew(), old.renew()])).toEqual([false, false]);
    expect(fixture.records.get("chat_runtime/singleton")).toEqual(request);
    await old.release(); await next.renew();
    expect(await old.renew()).toBe(false); expect(await next.renew()).toBe(true);
  });
  it("recovers after expired owners and abandoned bounded handoff requests", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old", 30_000, oldRelease);
    const next = new CloudbaseLease(fixture.db, undefined, "next", 30_000, newRelease);
    await next.renew(); vi.setSystemTime(31_001);
    expect(await old.renew()).toBe(true); // Expired newer version must not prevent disaster recovery.
    expect(await next.renew()).toBe(false); await old.release();
    expect(await old.renew()).toBe(false);
    vi.setSystemTime(91_002); expect(await old.renew()).toBe(true);
  });
  it("fails closed on corrupt release and handoff metadata", async () => {
    const fixture = fakeDatabase();
    const lease = new CloudbaseLease(fixture.db, undefined, "next", 30_000, newRelease);
    for (const extra of [{ release: 42 }, { release: "unknown" }, { handoffRelease: newRelease },
      { handoffRelease: newRelease, handoffExpiresAt: NaN },
      { release: newRelease, handoffRelease: oldRelease, handoffExpiresAt: 1 }]) {
      fixture.records.set("chat_runtime/singleton", { owner: "old", expiresAt: 0, ...extra });
      await expect(lease.renew()).rejects.toThrow("lease");
      await expect(lease.release()).rejects.toThrow("lease");
    }
  });
  it("invalidates local authority on renewal or release failure, and checks code errors", async () => {
    const fixture = fakeDatabase(); const lease = new CloudbaseLease(fixture.db);
    await lease.renew(); fixture.fail("throw"); await expect(lease.renew()).rejects.toThrow("network"); expect(lease.isValid()).toBe(false);
    fixture.fail(undefined); await lease.renew(); fixture.fail("code");
    await expect(lease.release()).rejects.toThrow("PERMISSION_DENIED"); expect(lease.isValid()).toBe(false);
  });
});
