/** "Did you mean": the nearest of `candidates` to a mistyped `word`, or `undefined` when none is near. */
export function nearest(
  word: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  // Within two edits, and never more than half the word: `x` is not a typo of `doctor`.
  return best !== undefined &&
    bestDistance <= Math.min(2, Math.floor(Math.max(word.length, 3) / 2))
    ? best
    : undefined;
}

/** Edit distance with a transposition counted as one edit (the usual typo). */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j++) rows[i]![j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = d;
    }
  return rows[a.length]![b.length]!;
}
