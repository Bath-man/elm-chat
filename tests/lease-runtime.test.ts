import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeaseRuntime } from "../apps/server/src/lease-runtime";

afterEach(() => vi.useRealTimers());
function fixture() {
  let available = false;
  const events: string[] = [];
  const lease = { renew: vi.fn(async (_request = false) => available), isValid: () => available,
    release: vi.fn(async () => { events.push("release"); }) };
  const runtime = createLeaseRuntime({ lease,
    pause: async () => { events.push("pause"); }, resume: () => { events.push("resume"); },
    onError: vi.fn() });
  return { lease, runtime, events, available(value: boolean) { available = value; } };
}
describe("traffic-driven runtime lifecycle", () => {
  it("checks startup once but idle standbys do not poll or request handoff", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.runtime.start();
    expect(f.lease.renew).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.lease.renew).toHaveBeenCalledTimes(1);
    f.available(true); await f.runtime.demand();
    expect(f.lease.renew).toHaveBeenLastCalledWith(true);
    expect(f.runtime.ownsLease()).toBe(true); await f.runtime.stop();
  });
  it("bounds standby retries and can resume on a later real request", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.runtime.start(); await f.runtime.demand();
    await vi.advanceTimersByTimeAsync(35_000); const count = f.lease.renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000); expect(f.lease.renew).toHaveBeenCalledTimes(count);
    f.available(true); await f.runtime.demand(); expect(f.runtime.ownsLease()).toBe(true); await f.runtime.stop();
  });
  it("drains before release and never reclaims from background after handing off", async () => {
    vi.useFakeTimers(); const f = fixture(); f.available(true); await f.runtime.start();
    await f.runtime.demand(); f.available(false); await vi.advanceTimersByTimeAsync(10_000);
    expect(f.events).toEqual(["resume", "pause", "release"]);
    expect(f.runtime.ownsLease()).toBe(false); const count = f.lease.renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000); expect(f.lease.renew).toHaveBeenCalledTimes(count);
    f.available(true); await f.runtime.demand(); expect(f.events.at(-1)).toBe("resume"); await f.runtime.stop();
  });
  it("propagates startup credential/database errors without a retry loop", async () => {
    vi.useFakeTimers(); const f = fixture(); f.lease.renew.mockRejectedValueOnce(new Error("credentials"));
    await expect(f.runtime.start()).rejects.toThrow("credentials");
    await vi.advanceTimersByTimeAsync(120_000); expect(f.lease.renew).toHaveBeenCalledTimes(1); await f.runtime.stop();
  });
  it("deduplicates simultaneous demand and recovers from renewal failure with fresh state", async () => {
    vi.useFakeTimers(); const f = fixture(); f.available(true); await f.runtime.start();
    await Promise.all(Array.from({ length: 10 }, () => f.runtime.demand()));
    expect(f.lease.renew).toHaveBeenCalledTimes(1);
    f.lease.renew.mockRejectedValueOnce(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(10_000); expect(f.events).toEqual(["resume", "pause", "release"]);
    await f.runtime.demand(); expect(f.events.at(-1)).toBe("resume"); await f.runtime.stop();
  });
});
