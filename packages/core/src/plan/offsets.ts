/**
 * Planners that read a JS string emit ranges in UTF-8 bytes — the unit every
 * {@link ElisionPlan} speaks. This is the one conversion, shared: every converted
 * index is a unit boundary (a node, a member, a line), so a range can never split a
 * multi-byte character. One forward pass, so the conversion is linear.
 */
export function utf8OffsetIndex(
  text: string,
  indices: readonly number[],
): ReadonlyMap<number, number> {
  const sorted = [...new Set(indices)].toSorted((a, b) => a - b);
  const map = new Map<number, number>();
  let previousIndex = 0;
  let previousByte = 0;
  for (const index of sorted) {
    previousByte += Buffer.byteLength(text.slice(previousIndex, index), 'utf8');
    previousIndex = index;
    map.set(index, previousByte);
  }
  return map;
}
