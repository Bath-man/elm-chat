/** Pixel offsets include each row's trailing gap, so spacers match mounted rows. */
export function messageOffsets(messages: readonly { id: string }[], heights: ReadonlyMap<string, number>, estimate: number): number[] {
  const offsets = [0];
  for (const message of messages) offsets.push(offsets[offsets.length - 1] + (heights.get(message.id) ?? estimate));
  return offsets;
}

export function visibleMessageRange(offsets: readonly number[], top: number, height: number, overscan: number) {
  const count = offsets.length - 1;
  const lower = Math.max(0, top - overscan);
  const upper = top + height + overscan;
  let start = 0;
  let end = count;
  // First row whose bottom is beyond the lower bound.
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (offsets[middle + 1] <= lower) start = middle + 1;
    else end = middle;
  }
  end = start;
  while (end < count && offsets[end] < upper) end++;
  return { start, end };
}
