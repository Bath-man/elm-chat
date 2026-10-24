import { expect, it } from 'vitest';
import { transcriptBatches } from '../apps/web/src/transcript-sync';
it('batches history by wire bytes rather than just message count', () => {
  const events = Array.from({ length: 12 }, (_, i) => ({ id: i, text: '中'.repeat(20000) }));
  const batches = transcriptBatches(events);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flat()).toEqual(events);
  for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(190000);
  expect(transcriptBatches([])).toEqual([[]]);
});
