/**
 * `pkey feeds prune` (feed retention, owner request 2026-10-06): the backfill of the Worker's
 * automatic prune. For each package of the product (or the one `--deliverable` names), the builds
 * of main below its newest stable release (semver `X-main.N`, PyPI `X.devN`, with X <= that
 * release) are deleted from every feed.
 *
 *   POST /<p>/release/packages/prune  {apply, deliverable?}   `release:yank` (operator-granted)
 *
 * A DRY RUN unless `--apply`: it prints what would be deleted, per package, with counts and bytes
 * (`bytes` the versions' files, `freed` the part no remaining version, package or product shares,
 * which the blob collector reclaims). With `--apply` the Worker deletes and audits each version
 * (`package.version.prune`) and the output says what went. `--json` prints the Worker's report.
 */

import { ciClient, type Out, type Sleep } from "./ci.js";
import { resolveCiToken, type CiEnv } from "./oidc.js";

export const FEEDS_PRUNE_USAGE =
  "Usage: pkey feeds prune --product <slug> [--deliverable id] [--apply] [--json] [--base-url url]";

interface PruneVersion {
  releaseId: string;
  version: string;
  files: number;
  bytes: number;
  freedBytes: number;
}

interface PrunePackage {
  deliverableId: string;
  ecosystem: string;
  name: string;
  stable: string;
  prune: PruneVersion[];
  kept: { releaseId: string; version: string; reason: string }[];
  bytes: number;
  freedBytes: number;
  failed?: { version: string; error: string }[];
}

export interface PruneReport {
  ok: true;
  product: string;
  dryRun: boolean;
  prunePrereleases: boolean;
  packages: PrunePackage[];
  skipped: { deliverableId: string; reason: string }[];
  totals: {
    versions: number;
    bytes: number;
    freedBytes: number;
    failed: number;
  };
}

export interface FeedsPruneOptions {
  product: string;
  deliverable?: string;
  apply: boolean;
  json?: boolean;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

/** `1234567` as `1.2 MB` (decimal units, as the feeds' size ceilings are shown). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** The human report of a prune (dry run or applied). */
export function renderPruneReport(r: PruneReport): string {
  const lines: string[] = [];
  const verb = r.dryRun ? "Would prune" : "Pruned";
  lines.push(
    `${r.dryRun ? "Dry run: nothing was deleted." : "Applied."} Product ${r.product} (automatic retention ${r.prunePrereleases ? "on" : "off"}).`,
  );
  for (const p of r.packages) {
    lines.push(
      `${p.ecosystem} ${p.name}: newest stable ${p.stable}; ${verb.toLowerCase()} ${p.prune.length} build${p.prune.length === 1 ? "" : "s"} of main, ${formatBytes(p.bytes)} (${formatBytes(p.freedBytes)} freed)`,
    );
    for (const v of p.prune)
      lines.push(
        `  - ${v.version}  ${v.files} file${v.files === 1 ? "" : "s"}, ${formatBytes(v.bytes)} (${formatBytes(v.freedBytes)} freed)`,
      );
    for (const k of p.kept) lines.push(`  = ${k.version}  kept (${k.reason})`);
    for (const f of p.failed ?? [])
      lines.push(`  ! ${f.version}  failed: ${f.error}`);
  }
  for (const s of r.skipped)
    lines.push(`${s.deliverableId}: skipped (no stable release yet)`);
  lines.push(
    `Total: ${verb.toLowerCase()} ${r.totals.versions} version${r.totals.versions === 1 ? "" : "s"}, ${formatBytes(r.totals.bytes)}, of which ${formatBytes(r.totals.freedBytes)} is referenced by nothing else.${r.totals.failed ? ` ${r.totals.failed} failed: run it again.` : ""}`,
  );
  if (r.dryRun && r.totals.versions > 0)
    lines.push("Run again with --apply to delete them.");
  return `${lines.join("\n")}\n`;
}

export async function feedsPrune(
  opts: FeedsPruneOptions,
): Promise<PruneReport> {
  if (!opts.product)
    throw new Error(`--product is required.\n${FEEDS_PRUNE_USAGE}`);
  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product,
    env: opts.env,
    out: opts.stdout,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const client = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
  });
  const report = await client.postJson<PruneReport>("release/packages/prune", {
    what: opts.apply ? "Pruning builds of main" : "Planning the prune",
    body: {
      apply: opts.apply,
      ...(opts.deliverable ? { deliverable: opts.deliverable } : {}),
    },
  });
  opts.stdout.write(
    opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderPruneReport(report),
  );
  return report;
}
