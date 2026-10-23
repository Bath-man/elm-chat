import { randomUUID } from "node:crypto";
import { assertDatabaseSuccess, type CloudbaseDatabase } from "./storage.js";

const HANDOFF_MS = 60_000;
type LeaseDocument = { owner: string; expiresAt: number; handoffOwner?: string; handoffExpiresAt?: number };

function readLease(value: unknown): LeaseDocument | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime lease response");
  const lease = value as Record<string, unknown>;
  if (typeof lease.owner !== "string" || !lease.owner ||
      typeof lease.expiresAt !== "number" || !Number.isFinite(lease.expiresAt)) {
    throw new Error("Invalid runtime lease document");
  }
  // Old image-order fields are obsolete. A legacy deadline without handoffOwner is
  // ignored only when explicitly attached to a legacy handoffRelease.
  const hasReservation = lease.handoffOwner !== undefined ||
    (lease.handoffExpiresAt !== undefined && lease.handoffRelease === undefined);
  if (hasReservation && (typeof lease.handoffOwner !== "string" || !lease.handoffOwner ||
      typeof lease.handoffExpiresAt !== "number" || !Number.isFinite(lease.handoffExpiresAt))) {
    throw new Error("Invalid runtime lease handoff");
  }
  return {
    owner: lease.owner,
    expiresAt: lease.expiresAt,
    ...(hasReservation ? { handoffOwner: lease.handoffOwner as string, handoffExpiresAt: lease.handoffExpiresAt as number } : {})
  };
}

/** One owner at a time; only platform-routed user demand requests a handoff. */
export class CloudbaseLease {
  private expiresAt = 0;
  constructor(
    private readonly db: CloudbaseDatabase,
    private readonly collection = "chat_runtime",
    readonly owner = randomUUID(),
    private readonly leaseMs = 30_000
  ) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 5_000) throw new Error("Lease duration must exceed the 5 second safety window");
  }
  isValid(): boolean { return Date.now() < this.expiresAt - 5_000; }
  async renew(requestHandoff = false): Promise<boolean> {
    try {
      const expiresAt = await this.db.runTransaction(async (transaction) => {
        const document = transaction.collection(this.collection).doc("singleton");
        const result = await document.get();
        assertDatabaseSuccess(result);
        const lease = readLease(result.data);
        const now = Date.now();
        const pending = lease?.handoffOwner && lease.handoffExpiresAt! > now ? lease.handoffOwner : undefined;
        if (lease && lease.expiresAt > now) {
          if (lease.owner !== this.owner) {
            // Record one bounded reservation, never replace it or extend its deadline.
            // Authority stays with the live owner until it drains or expires.
            if (requestHandoff && !pending) {
              assertDatabaseSuccess(await document.set({ owner: lease.owner, expiresAt: lease.expiresAt,
                handoffOwner: this.owner, handoffExpiresAt: now + HANDOFF_MS }));
            }
            return 0;
          }
          if (pending && pending !== this.owner) return 0;
        } else if (pending && pending !== this.owner) {
          // Preserve the shutdown/polling gap for the designated process, not an image.
          return 0;
        }
        const expiry = now + this.leaseMs;
        assertDatabaseSuccess(await document.set({ owner: this.owner, expiresAt: expiry }));
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
        // A restarted old process cannot win the gap before the designated one polls.
        assertDatabaseSuccess(await document.set({ ...lease, expiresAt: 0 }));
      }
    });
  }
}
