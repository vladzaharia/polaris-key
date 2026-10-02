// The variant key (plans/P4-01.md §2.3; WIRE-CONTRACT-V4 §8): a variant's canonical string.

/** Compare two strings by their UTF-8 bytes (equal to code-point order). */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * The variant key: the variant's `axis=value` pairs sorted by axis-name bytes and joined with
 * `;` (`locale=fr;texture=astc`), and the empty string for `{}`.
 */
export function variantKey(variant: Readonly<Record<string, string>>): string {
  return Object.keys(variant)
    .sort(compareBytes)
    .map((axis) => `${axis}=${variant[axis]}`)
    .join(";");
}
