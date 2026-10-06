// The cross-renderer pixel diff (UI-KITS.md §7.1): React and the elements kit share one
// styles.css and one DOM / data-part contract, so the same state rendered by each must match.
// compareDirs() pairs files by name; it is inert until both baseline directories exist.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { PNG } from "pngjs";

export interface DiffOptions {
  /** Per-channel difference that still counts as equal (anti-aliasing noise). Default 8. */
  tolerance?: number;
  /** Share of differing pixels allowed. Default 0.001 (0.1 %). */
  maxRatio?: number;
  /** Write <name>.diff.png here for every mismatch. */
  outDir?: string;
}

export interface PairResult {
  name: string;
  status: "match" | "mismatch" | "size" | "only-a" | "only-b";
  ratio?: number;
  detail: string;
}

export function diffPng(
  a: PNG,
  b: PNG,
  o: DiffOptions = {},
): { ratio: number; diff: PNG } {
  const tol = o.tolerance ?? 8;
  const diff = new PNG({ width: a.width, height: a.height });
  let off = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i]! - b.data[i]!),
      Math.abs(a.data[i + 1]! - b.data[i + 1]!),
      Math.abs(a.data[i + 2]! - b.data[i + 2]!),
      Math.abs(a.data[i + 3]! - b.data[i + 3]!),
    );
    const bad = d > tol;
    if (bad) off++;
    diff.data[i] = bad ? 255 : a.data[i]! >> 2;
    diff.data[i + 1] = bad ? 0 : a.data[i + 1]! >> 2;
    diff.data[i + 2] = bad ? 64 : a.data[i + 2]! >> 2;
    diff.data[i + 3] = 255;
  }
  return { ratio: off / (a.width * a.height), diff };
}

function pngs(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".png")) out.set(relative(dir, p), p);
    }
  };
  walk(dir);
  return out;
}

/** Compare every same-named PNG under a and b. Returns null when either directory is missing. */
export function compareDirs(
  a: string,
  b: string,
  o: DiffOptions = {},
): PairResult[] | null {
  if (!existsSync(a) || !existsSync(b)) return null;
  const max = o.maxRatio ?? 0.001;
  const A = pngs(a);
  const B = pngs(b);
  const out: PairResult[] = [];
  for (const name of [...new Set([...A.keys(), ...B.keys()])].sort()) {
    const pa = A.get(name);
    const pb = B.get(name);
    if (!pa || !pb) {
      out.push({
        name,
        status: pa ? "only-a" : "only-b",
        detail: `${name} exists only in ${pa ? a : b}: every state is rendered by both renderers`,
      });
      continue;
    }
    const x = PNG.sync.read(readFileSync(pa));
    const y = PNG.sync.read(readFileSync(pb));
    if (x.width !== y.width || x.height !== y.height) {
      out.push({
        name,
        status: "size",
        detail: `${name}: ${x.width}×${x.height} vs ${y.width}×${y.height}`,
      });
      continue;
    }
    const { ratio, diff } = diffPng(x, y, o);
    if (ratio > max && o.outDir) {
      const file = join(o.outDir, name.replace(/\.png$/, ".diff.png"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, PNG.sync.write(diff));
    }
    out.push({
      name,
      status: ratio > max ? "mismatch" : "match",
      ratio,
      detail: `${name}: ${(ratio * 100).toFixed(3)} % of pixels differ (allowed ${(max * 100).toFixed(2)} %)`,
    });
  }
  return out;
}
