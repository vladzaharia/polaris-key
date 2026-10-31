#!/usr/bin/env node
// Does R2 accept SSE-C (`ssecKey`) on put, get, createMultipartUpload and uploadPart?
// (U-10.1; plans/U-10-U-11a-slices.md §2.8, D-8.)
//
//   node scripts/probe/r2-ssec.mjs --bucket polaris-key-sync-files-staging --remote
//   node scripts/probe/r2-ssec.mjs            # miniflare's local R2: proves call shapes only
//
// `--remote` runs the probe against the named real bucket through wrangler's remote binding
// (wrangler must be logged in, or CLOUDFLARE_API_TOKEN set, for the bucket's account). Without it
// the probe runs on miniflare, which accepts the option and does not enforce it, so its verdict is
// `fallback` by construction; only a remote run can say `supported`.
//
// The probe writes under `probe/ssec/<random>/` and deletes what it wrote. It prints the verdict
// and each check (never a key) and exits 0 for either verdict, 1 when it could not run.
// `supported` ⇒ server-mode files use an R2 SSE-C key per file. `fallback` ⇒ they are sealed as
// `pkey-sync-file/1` under the per-principal key (plan §1.8).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { probeSsec } from "./r2-ssec-probe.mjs";

const { values } = parseArgs({
  options: {
    bucket: { type: "string", default: "pkey-ssec-probe" },
    remote: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (values.remote && values.bucket === "pkey-ssec-probe") {
  process.stderr.write("--remote needs --bucket <the real bucket name>\n");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "pkey-ssec-"));
let proxy;
try {
  const config = join(dir, "wrangler.toml");
  await writeFile(
    config,
    [
      'name = "pkey-ssec-probe"',
      'compatibility_date = "2026-04-07"',
      "[[r2_buckets]]",
      'binding = "SYNC_FILES"',
      `bucket_name = ${JSON.stringify(values.bucket)}`,
      `remote = ${values.remote ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  const { getPlatformProxy } = await import("wrangler");
  proxy = await getPlatformProxy({
    configPath: config,
    persist: false,
    remoteBindings: values.remote,
  });
  const report = await probeSsec(proxy.env.SYNC_FILES);
  const where = values.remote ? `bucket ${values.bucket}` : "miniflare (local)";
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ where, ...report }, null, 2)}\n`);
  } else {
    const lines = [`R2 SSE-C probe on ${where}`];
    for (const c of report.checks)
      lines.push(
        `  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`,
      );
    lines.push(`verdict: ${report.verdict}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
} catch (err) {
  process.stderr.write(
    `probe could not run: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
} finally {
  await proxy?.dispose();
  await rm(dir, { recursive: true, force: true });
}
