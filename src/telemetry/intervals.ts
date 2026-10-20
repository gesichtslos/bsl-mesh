export type Interval = { start: number; end: number };

export function unionDuration(intervals: readonly Interval[]): number | null {
  const sorted = intervals
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start)
    .map((item) => ({ start: item.start, end: item.end }))
    .sort((left, right) => left.start - right.start);
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }
  let cursor = first.end;
  let total = first.end - first.start;
  for (const item of sorted.slice(1)) {
    if (item.end <= cursor) {
      continue;
    }
    const start = Math.max(item.start, cursor);
    total += item.end - start;
    cursor = item.end;
  }
  return total;
}
