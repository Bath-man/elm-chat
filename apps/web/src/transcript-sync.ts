/** Leave space for relay wrappers, signatures and escaped JSON below the 256 KiB frame limit. */
export function transcriptBatches<T>(events: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [], bytes = 2;
  for (const event of events) {
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
    if (batch.length && bytes + size > 180_000) { batches.push(batch); batch = []; bytes = 2; }
    batch.push(event); bytes += size;
  }
  if (batch.length || !batches.length) batches.push(batch);
  return batches;
}
