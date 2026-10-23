import type { CloudbaseLease } from "./lease.js";

/** Idle/retired containers never compete; only freshly routed traffic requests a handoff. */
export function createLeaseRuntime(options: {
  lease: Pick<CloudbaseLease, "renew" | "isValid" | "release">;
  pause: () => Promise<void>; resume: () => void; onError: (error: unknown) => void;
}) {
  let active = false, stopped = false, demandUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  async function drain() {
    active = false; demandUntil = 0;
    // Clear cached membership and pending work before another owner is allowed to write.
    await options.pause();
    await options.lease.release().catch(options.onError);
  }
  function run(initial = false): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer);
    inFlight = (async () => {
      try {
        const acquired = await options.lease.renew(!active && demandUntil > Date.now());
        if (stopped) return;
        if (acquired) {
          if (!active) { active = true; options.resume(); }
        } else if (active) await drain();
      } catch (error) {
        if (active) await drain();
        if (initial) throw error; // Invalid startup credentials must not open a healthy port.
        options.onError(error);
      }
    })().finally(() => {
      inFlight = undefined;
      if (!stopped && (active || demandUntil > Date.now())) {
        timer = setTimeout(() => { void run(); }, active ? 10_000 : 2_000);
        timer.unref();
      }
    });
    return inFlight;
  }
  return {
    start: () => run(true),
    ownsLease: () => !stopped && active && options.lease.isValid(),
    demand() {
      if (stopped) return Promise.resolve();
      demandUntil = Date.now() + 30_000;
      return active && options.lease.isValid() ? Promise.resolve() : run();
    },
    async stop() {
      if (stopped) return; stopped = true; clearTimeout(timer);
      await inFlight?.catch(options.onError);
      await drain();
    }
  };
}
