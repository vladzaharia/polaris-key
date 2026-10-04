import { markParts } from "@polaris-key/brand/svg";

/**
 * One part of a kit mark (the star, the terminal bit) as a path plus the viewBox that frames it.
 * The geometry comes from @polaris-key/brand untouched: nothing is redrawn here (BRAND.md §10).
 */
export function markPartPath(
  role: "star" | "gold",
  opts: Parameters<typeof markParts>[0],
): { d: string; viewBox: string } {
  const part = markParts(opts).parts.find((p) => p.role === role);
  if (!part) throw new Error(`the brand mark has no ${role} part`);
  const nums = (part.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...ys) - minY;
  const side = Math.max(w, h);
  // Square, centred on the part.
  const x = minX - (side - w) / 2;
  const y = minY - (side - h) / 2;
  return { d: part.d, viewBox: `${x} ${y} ${side} ${side}` };
}
