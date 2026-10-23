import { randomUUID } from "node:crypto";
import { assertDatabaseSuccess, type CloudbaseDatabase } from "./storage.js";

const RELEASE_PATTERN = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDOFF_MS = 60_000;
type LeaseDocument = Record<string, unknown> & { owner: string; expiresAt: number; release?: string; handoffRelease?: string; handoffExpiresAt?: number };

function readLease(value: unknown): LeaseDocument | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime lease response");
  const lease = value as LeaseDocument;
  if (typeof lease.owner !== "string" || typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt) ||
      (lease.release !== undefined && (typeof lease.release !== "string" || !RELEASE_PATTERN.test(lease.release))) ||
      ((lease.handoffRelease !== undefined || lease.handoffExpiresAt !== undefined) &&
        (typeof lease.handoffRelease !== "string" || !RELEASE_PATTERN.test(lease.handoffRelease) ||
         typeof lease.handoffExpiresAt !== "number" || !Number.isFinite(lease.handoffExpiresAt) ||
         lease.handoffRelease <= (lease.release ?? "")))) throw new Error("Invalid runtime lease document");
  return lease;
}

/** A global lease prevents two containers from independently admitting users to one room. */
export class CloudbaseLease {
  private expiresAt = 0;
  constructor(
    private readonly db: CloudbaseDatabase,
    private readonly collection = "chat_runtime",
    readonly owner = randomUUID(),
    private readonly leaseMs = 30_000,
    private readonly releaseId?: string
  ) {
    if (releaseId !== undefined && !RELEASE_PATTERN.test(releaseId)) throw new Error("Invalid runtime lease release identifier");
    if (leaseMs <= 5_000) throw new Error("Lease duration must exceed the 5 second safety window");
  }
  isValid(): boolean { return Date.now() < this.expiresAt - 5_000; }
  async renew(): Promise<boolean> {
    try {
      const expiresAt = await this.db.runTransaction(async (transaction) => {
        const document = transaction.collection(this.collection).doc("singleton");
        const result = await document.get();
        assertDatabaseSuccess(result);
        const lease = readLease(result.data);
        const now = Date.now();
        const pending = lease?.handoffRelease && lease.handoffExpiresAt! > now ? lease.handoffRelease : undefined;
        if (lease && lease.expiresAt > now) {
          if (lease.owner !== this.owner) {
            // Request a drain; never grant a new owner authority while the old lease is live.
            if (this.releaseId && this.releaseId > (lease.release ?? "") && (!pending || this.releaseId > pending)) {
              assertDatabaseSuccess(await document.set({ ...lease, handoffRelease: this.releaseId, handoffExpiresAt: now + HANDOFF_MS }));
            }
            return 0;
          }
          if (pending && pending > (lease.release ?? "")) return 0;
        } else if (pending && pending > (this.releaseId ?? "")) {
          // Reserve the short shutdown/polling gap for the requested image, then allow recovery.
          return 0;
        }
        const expiry = now + this.leaseMs;
        assertDatabaseSuccess(await document.set({ owner: this.owner, expiresAt: expiry, ...(this.releaseId ? { release: this.releaseId } : {}) }));
        return expiry;
      });
      this.expiresAt = expiresAt;
      return expiresAt !== 0;
    } catch (error) { this.expiresAt = 0; throw error; }
  }
  async release(): Promise<void> {
    this.expiresAt = 0;
    await this.db.runTransaction(async (transaction) => {
      const document = transaction.collection(this.collection).doc("singleton");
      const result = await document.get();
      assertDatabaseSuccess(result);
      const lease = readLease(result.data);
      if (lease?.owner === this.owner) {
        // Keep a pending handoff across graceful shutdown so an old restart cannot win the gap.
        assertDatabaseSuccess(await document.set({ ...lease, expiresAt: 0 }));
      }
    });
  }
}
