// pnpm ui:report [--out=<file>]   (default packages/ui-qa/.out/report/index.html)
// Exit 1 only when the cross-renderer diff is active and finds a mismatch.
import { resolve } from "node:path";
import { REPO_ROOT } from "../config.ts";
import { writeReport } from "../report.ts";

const args = process.argv.slice(2).filter((a) => a !== "--");
const outArg = args.find((a) => a.startsWith("--out="));
const out = resolve(
  outArg
    ? outArg.slice(6)
    : resolve(REPO_ROOT, "packages/ui-qa/.out/report/index.html"),
);
const r = writeReport(out);
const bySource = new Map<string, number>();
for (const s of r.shots)
  bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
console.log(
  `ui:report: ${r.shots.length} renders, ${r.states.length} states → ${out}`,
);
for (const [src, n] of bySource) console.log(`  ${src.padEnd(18)} ${n}`);
console.log(
  `  component states with no kit render yet: ${r.unrendered.length}`,
);
const bad = (r.crossRenderer ?? []).filter((p) => p.status !== "match");
console.log(
  r.crossRenderer
    ? `  cross-renderer diff: ${r.crossRenderer.length - bad.length}/${r.crossRenderer.length} match`
    : "  cross-renderer diff: inactive (needs both React and elements baselines)",
);
for (const p of bad) console.log(`    ✗ ${p.detail}`);
process.exitCode = bad.length ? 1 : 0;
