import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudbaseMetadataStore, FileMetadataStore, MemoryMetadataStore, type CloudbaseDatabase, type CloudbaseDocument } from "../apps/server/src/storage";
import { CloudbaseLease } from "../apps/server/src/lease";
import { createLeaseRuntime } from "../apps/server/src/lease-runtime";
import { createChatServer } from "../apps/server/src/server";

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
  it("hands off on routed demand even for an identical cached image, never on passive polling", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old");
    const next = new CloudbaseLease(fixture.db, undefined, "next");
    expect(await old.renew(false)).toBe(true);
    expect(await next.renew(false)).toBe(false);
    expect(await old.renew(false)).toBe(true);
    expect(fixture.records.get("chat_runtime/singleton")?.handoffOwner).toBeUndefined();
    expect(await next.renew(true)).toBe(false);
    expect(next.isValid()).toBe(false);
    expect(fixture.records.get("chat_runtime/singleton")?.owner).toBe("old");
    expect(await old.renew(false)).toBe(false); expect(old.isValid()).toBe(false);
    await old.release();
    expect(fixture.records.get("chat_runtime/singleton")?.handoffOwner).toBe("next");
    const restarted = new CloudbaseLease(fixture.db, undefined, "old-restarted");
    expect(await restarted.renew(false)).toBe(false);
    expect(await next.renew(false)).toBe(true);
    expect(await restarted.renew(false)).toBe(false);
    expect(await next.renew(false)).toBe(true);
    expect(fixture.records.get("chat_runtime/singleton")?.handoffOwner).toBeUndefined();
  });
  it("reserves one requester across concurrent demands without extending its deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old");
    const next = new CloudbaseLease(fixture.db, undefined, "next");
    const other = new CloudbaseLease(fixture.db, undefined, "other");
    await old.renew();
    expect(await Promise.all([next.renew(true), other.renew(true)])).toEqual([false, false]);
    const request = structuredClone(fixture.records.get("chat_runtime/singleton"));
    expect(request?.handoffOwner).toBe("next");
    vi.setSystemTime(5_000);
    expect(await Promise.all([next.renew(true), next.renew(true), old.renew(false)])).toEqual([false, false, false]);
    expect(fixture.records.get("chat_runtime/singleton")).toEqual(request);
    await old.release();
    expect(await other.renew(true)).toBe(false);
    expect(await next.renew(false)).toBe(true);
    expect(await old.renew(false)).toBe(false); expect(await next.renew(false)).toBe(true);
  });
  it("reserves takeover until abandonment expires, then permits passive recovery", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old");
    const next = new CloudbaseLease(fixture.db, undefined, "next");
    await old.renew(); await next.renew(true);
    vi.setSystemTime(31_001);
    expect(await old.renew(false)).toBe(false);
    vi.setSystemTime(61_001);
    expect(await old.renew(false)).toBe(true);
    expect(await next.renew(true)).toBe(false); // An abandoned requester can make a fresh demand.
    expect(fixture.records.get("chat_runtime/singleton")?.handoffExpiresAt).toBe(121_001);
    await old.release(); expect(await next.renew()).toBe(true);
  });
  it("lets the designated requester acquire after an unresponsive owner expires", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const fixture = fakeDatabase();
    const old = new CloudbaseLease(fixture.db, undefined, "old");
    const next = new CloudbaseLease(fixture.db, undefined, "next");
    await old.renew(); await next.renew(true);
    vi.setSystemTime(31_001);
    expect(await next.renew(false)).toBe(true);
    await old.release();
    expect(fixture.records.get("chat_runtime/singleton")?.owner).toBe("next");
    expect(await old.renew(false)).toBe(false);
    expect(await next.renew(false)).toBe(true);
  });
  it("acquires expired or empty leases and clears obsolete release-order metadata", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const fixture = fakeDatabase();
    const lease = new CloudbaseLease(fixture.db, undefined, "next");
    fixture.records.set("chat_runtime/singleton", { owner: "old", expiresAt: 0,
      release: "legacy", handoffRelease: "legacy", handoffExpiresAt: 999_999 });
    expect(await lease.renew(false)).toBe(true);
    expect(fixture.records.get("chat_runtime/singleton")).toEqual({ owner: "next", expiresAt: 130_000 });
  });
  it("fails closed on corrupt owner, expiry and demand reservation metadata", async () => {
    const fixture = fakeDatabase();
    const lease = new CloudbaseLease(fixture.db, undefined, "next");
    for (const extra of [{ owner: 42 }, { expiresAt: NaN }, { handoffOwner: "" },
      { handoffOwner: "next" }, { handoffOwner: "next", handoffExpiresAt: NaN },
      { handoffOwner: "next", handoffExpiresAt: "tomorrow" },
      { handoffExpiresAt: 1 }]) {
      fixture.records.set("chat_runtime/singleton", { owner: "old", expiresAt: 0, ...extra });
      await expect(lease.renew()).rejects.toThrow("lease");
      await expect(lease.release()).rejects.toThrow("lease");
      expect(lease.isValid()).toBe(false);
    }
  });
  it("invalidates local authority on renewal or release failure, and checks code errors", async () => {
    const fixture = fakeDatabase(); const lease = new CloudbaseLease(fixture.db);
    await lease.renew(); fixture.fail("throw"); await expect(lease.renew()).rejects.toThrow("network"); expect(lease.isValid()).toBe(false);
    fixture.fail(undefined); await lease.renew(); fixture.fail("code");
    await expect(lease.release()).rejects.toThrow("PERMISSION_DENIED"); expect(lease.isValid()).toBe(false);
  });
});


describe("two routed versions sharing one database", () => {
  it("moves real HTTP service and metadata to the requested version without background ping-pong", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const fixture = fakeDatabase();
    const instances: { runtime: ReturnType<typeof createLeaseRuntime>; chat: ReturnType<typeof createChatServer>; origin: string }[] = [];
    async function instance(owner: string) {
      const lease = new CloudbaseLease(fixture.db, "chat_runtime", owner);
      let runtime: ReturnType<typeof createLeaseRuntime>;
      const chat = createChatServer({
        store: new CloudbaseMetadataStore(fixture.db, "chat_rooms", { owner, collection: "chat_runtime" }),
        publicDir: "/nonexistent", ownsLease: () => runtime.ownsLease(), onActivity: () => runtime.demand()
      });
      runtime = createLeaseRuntime({ lease, pause: chat.pause, resume: chat.resume, onError: () => {} });
      await runtime.start();
      await new Promise<void>(resolve => chat.server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(chat.server.address() as { port: number }).port}`;
      const entry = { runtime, chat, origin }; instances.push(entry); return entry;
    }
    try {
      const old = await instance("old");
      const created = await fetch(`${old.origin}/api/rooms`, { method: "POST", body: "{}" });
      expect(created.status).toBe(201); const room = await created.json();
      const next = await instance("next"); // Cached identical image is also a distinct process owner.
      expect((await fetch(`${next.origin}/api/runtime`)).status).toBe(503);
      expect(fixture.records.get("chat_runtime/singleton")?.owner).toBe("old");
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await fetch(`${next.origin}/readyz`)).status).toBe(200);
      expect((await fetch(`${old.origin}/readyz`)).status).toBe(503);
      expect((await fetch(`${old.origin}/healthz`)).status).toBe(200);
      expect((await fetch(`${next.origin}/api/rooms/${room.roomId}`)).status).toBe(200);
      const restartedOld = await instance("old-restarted");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(fixture.records.get("chat_runtime/singleton")?.owner).toBe("next");
      expect(restartedOld.runtime.ownsLease()).toBe(false);
    } finally {
      for (const { runtime, chat } of instances.reverse()) { await runtime.stop(); await chat.close(); }
    }
  });
});
