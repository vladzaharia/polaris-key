#!/usr/bin/env node
/**
 * Recover a product's update feeds after a suspected signer compromise (P3-03, plans/P3-01.md
 * §2.3, WIRE-CONTRACT-V4 §4): the `seq` ceiling.
 *
 *   pnpm --filter @polaris-key/worker feed:seq-ceiling --product <slug> [--env prod] [--local]
 *
 * A signer holding the product key (a compromised Worker or KEK) can sign a fresh feed at
 * `seq = 2^53 - 1` for any channel name a client asks for. Every install that commits it refuses
 * the recovered Worker's lower `seq` as `rollback` and freezes once it is stale. This script, in
 * ONE batch, for the WHOLE product (there is deliberately no per-channel option: a fast-forward
 * can target a channel that has no row yet — a manual channel nobody requested, a `pr-<n>`):
 *
 *   1. sets the product's ceiling flag (`update_feed_ceiling`; idempotent, never cleared), from
 *      which every `update_feed_state` row created later starts at the ceiling;
 *   2. raises every existing `update_feed_state` row of the product to the ceiling;
 *   3. deletes the product's stored feed documents (`update_feed_docs`),
 *
 * so the next request on ANY channel signs at the ceiling with the current `issuedAt`, which is
 * newer than any `issuedAt` the attacker's feed can carry (clients refuse one more than 300 s
 * ahead), and §2.5 step 8 accepts it. No client change is needed. Run it after rotating the
 * product key, for every affected product, without waiting for evidence (docs/RUNBOOK.md
 * "Recovering the update feeds after a signer compromise").
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `MAX_WIRE_INTEGER` (`@polaris-key/protocol/core`), 2^53 − 1. */
export const MAX_WIRE_INTEGER = 9007199254740991;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/**
 * The batch, as SQL statements. `product` must be a product slug (checked: it is interpolated,
 * and the slug alphabet cannot break out of a string literal); `now` is epoch seconds.
 */
export function seqCeilingStatements(product, now) {
  if (typeof product !== "string" || !SLUG_RE.test(product))
    throw new Error(`--product must be a product slug (${SLUG_RE.source})`);
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("now must be epoch seconds");
  return [
    `INSERT INTO update_feed_ceiling (product, set_at) VALUES ('${product}', ${now}) ON CONFLICT (product) DO NOTHING`,
    `UPDATE update_feed_state SET seq = ${MAX_WIRE_INTEGER} WHERE product = '${product}'`,
    `DELETE FROM update_feed_docs WHERE product = '${product}'`,
  ];
}

function parseArgs(argv) {
  const out = { product: null, env: "prod", local: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--product") out.product = argv[++i] ?? null;
    else if (a === "--env") out.env = argv[++i] ?? "prod";
    else if (a === "--local") out.local = true;
    else if (a === "--") continue;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.product) {
    console.error(
      "usage: feed:seq-ceiling --product <slug> [--env prod|staging|dev] [--local]",
    );
    process.exit(2);
  }
  const statements = seqCeilingStatements(
    args.product,
    Math.floor(Date.now() / 1000),
  );
  const dir = mkdtempSync(join(tmpdir(), "pkey-seq-ceiling-"));
  const file = join(dir, "seq-ceiling.sql");
  writeFileSync(file, statements.map((s) => `${s};`).join("\n") + "\n");
  try {
    // `--file` runs the statements as one batch.
    execFileSync(
      "wrangler",
      [
        "d1",
        "execute",
        "DB",
        "--env",
        args.env,
        args.local ? "--local" : "--remote",
        "--file",
        file,
        "--yes",
      ],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    `${args.product}: the ceiling flag is set, every update_feed_state row is at ${MAX_WIRE_INTEGER}, and the stored feeds are dropped. Check one channel: GET /${args.product}/update/stable/feed.jws?platform=<p> must carry seq ${MAX_WIRE_INTEGER}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
