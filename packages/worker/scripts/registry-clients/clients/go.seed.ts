/**
 * Seed the Go feed for the registry-client harness (F-31): the fixture owner's Go feed and one
 * module published through Release's real package ingest (`ingestPackageDescriptor`) into the
 * harness's local D1 and R2, before `wrangler dev` starts.
 *
 *   tsx clients/go.seed.ts --persist-to <state dir> --origin <registry origin>
 *
 * The module is `go.plrs.test/smoke` (deliverable `go.smoke`), four versions in publication
 * order: 1.0.0 (stable), 1.0.1 (stable, then yanked), 1.1.0 (stable: the `latest` tag) and
 * 1.2.0-beta.1 (the `beta` channel). Each version is a real module source tree run through the
 * CLI's own Go extractor (`packages/cli/src/package/go.ts`: the module zip as
 * `golang.org/x/mod/zip` builds it, the go.mod split out and both go.sum hashes), so the go
 * command downloads, verifies and builds it for real, and the client checks the hashes the CLI
 * recorded against the go.sum lines the go command writes.
 *
 * WHY NOT `pkey release publish`: publishing needs upload tickets, which mint S3 credentials for
 * R2 (P2-02) and have no local equivalent in `wrangler dev`. The seed therefore calls the same
 * extractor and the same ingest the publish path calls, after storing the bytes the way
 * `promote` leaves them. Nothing here reaches a deployed environment: `getPlatformProxy` binds the
 * `--env test` D1 and R2 under the harness's state directory.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { D1Db } from "../../../src/db/d1.js";
import type { Env } from "../../../src/platform/env.js";
import { blobKey, recordObject } from "../../../src/core/assets/blobs.js";
import {
  stmtUpsertDeliverable,
  stmtYankRelease,
} from "../../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../../src/services/release/packages/ingest.js";
import { packageStateStatements } from "../../../src/services/release/packages/state.js";
import { extractGo } from "../../../../cli/src/package/go.ts";
import { FIXTURE_OWNER } from "../seed.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OWNER = FIXTURE_OWNER;
const PREFIX = "go.plrs.test";
const ID = "go.smoke";
const MODULE = `${PREFIX}/smoke`;

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (!v)
    throw new Error(
      `usage: go.seed.ts --persist-to <dir> --origin <url> (missing ${name})`,
    );
  return v;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** One version's source tree: a go.mod and a package whose Version names the release. */
async function moduleTree(dir: string, version: string): Promise<void> {
  await mkdir(join(dir, "internal", "greet"), { recursive: true });
  await writeFile(join(dir, "go.mod"), `module ${MODULE}\n\ngo 1.21\n`);
  await writeFile(
    join(dir, "smoke.go"),
    [
      "// Package smoke is the registry-client harness's Go fixture.",
      "package smoke",
      "",
      `import "${MODULE}/internal/greet"`,
      "",
      "// Version is the release this module version was published as.",
      `const Version = "${version}"`,
      "",
      "// Hello greets.",
      'func Hello() string { return greet.Word() + " " + Version }',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "internal", "greet", "greet.go"),
    'package greet\n\n// Word is the greeting.\nfunc Word() string { return "hello" }\n',
  );
}

async function main(): Promise<void> {
  const persistTo = arg("--persist-to");
  arg("--origin");
  const proxy = await getPlatformProxy<{ DB: D1Database; BLOBS: R2Bucket }>({
    configPath: join(WORKER, "wrangler.toml"),
    environment: "test",
    persist: { path: join(persistTo, "v3") },
  });
  try {
    const db = new D1Db(proxy.env.DB);
    const bucket = proxy.env.BLOBS;
    const env = { BLOBS: bucket } as unknown as Env;
    const now = Math.floor(Date.now() / 1000);

    // `loadProductPublic` (the registry dispatcher's owner check) needs an ACTIVE product key row
    // as well as the product, which `seed.mjs` does not insert. No registry route signs, so the
    // key is an inert placeholder that nothing ever unseals.
    await db.run(
      `INSERT OR IGNORE INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
       VALUES (?, 'registry-smoke-kid', 'Ed25519', 'AAAA', '{}', 'active', ?)`,
      OWNER,
      now,
    );
    await db.run(
      `INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(product) DO UPDATE SET enabled = 1`,
      OWNER,
      now,
    );
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json,
         max_package_bytes, ext_json, updated_at)
       VALUES (?, 'go', 1, 'public', ?, 52428800, '{}', ?)
       ON CONFLICT(product, ecosystem) DO NOTHING`,
      OWNER,
      JSON.stringify({ modulePrefixes: [PREFIX] }),
      now,
    );
    await db.run(
      `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
       VALUES (?, 'app', 'public', NULL, 'manifest', ?)
       ON CONFLICT (product, deliverable_id) DO NOTHING`,
      OWNER,
      now,
    );
    const decl = {
      kind: "package" as const,
      id: ID,
      ecosystem: "go" as const,
      name: MODULE,
      artifacts: { module: { match: "go.mod" } },
    };
    const s = stmtUpsertDeliverable(
      {
        product: OWNER,
        deliverableId: ID,
        kind: "package",
        defJson: JSON.stringify(decl),
        ecosystem: "go",
        packageName: MODULE,
      },
      now,
    );
    await db.run(s.sql, ...s.params);

    const store = async (data: Uint8Array): Promise<string> => {
      const digest = sha(data);
      await bucket.put(blobKey(digest), data, { sha256: digest });
      await recordObject(
        db,
        {
          storageKey: blobKey(digest),
          sha256: digest,
          size: data.length,
          kind: "blob",
          gated: false,
        },
        now,
      );
      return digest;
    };

    const versions: Array<[string, string]> = [
      ["1.0.0", "stable"],
      ["1.0.1", "stable"],
      ["1.1.0", "stable"],
      ["1.2.0-beta.1", "beta"],
    ];
    const scratch = await mkdtemp(join(tmpdir(), "pkey-go-seed-"));
    const sums: Record<string, { h1: unknown; goModH1: unknown }> = {};
    let at = now - 1000;
    try {
      for (const [version, channel] of versions) {
        const src = join(scratch, version, "src");
        const work = join(scratch, version, "work");
        await moduleTree(src, version);
        await mkdir(work, { recursive: true });
        const x = await extractGo({
          declaration: decl as never,
          dir: src,
          workDir: work,
          version,
        });
        const files = [];
        const promoted: string[] = [];
        for (const f of x.files) {
          const data = new Uint8Array(await readFile(f.path));
          const digest = await store(data);
          promoted.push(blobKey(digest));
          files.push({
            name: f.name,
            role: "payload",
            type: f.type,
            sha256: digest,
            size: data.length,
            locations: [{ provider: "r2", key: blobKey(digest) }],
          });
        }
        sums[`v${version}`] = {
          h1: x.metadata.h1,
          goModH1: x.metadata.goModH1,
        };
        const res = await ingestPackageDescriptor(
          db,
          env,
          OWNER,
          {
            descriptorVersion: 1,
            product: OWNER,
            deliverable: ID,
            kind: "package",
            version,
            channel,
            package: {
              ecosystem: "go",
              name: MODULE,
              files,
              metadata: x.metadata,
            },
          },
          {
            now: at,
            promoted,
            feed: {
              ecosystem: "go",
              enabled: true,
              ownerEnabled: true,
              policyEnabled: true,
              namespace: { modulePrefixes: [PREFIX] },
              maxPackageBytes: 52428800,
              ext: {},
            },
            source: { kind: "static" },
          },
        );
        if (!res.ok)
          throw new Error(`ingest ${version}: ${JSON.stringify(res)}`);
        at += 100;
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    // The go.sum hashes the CLI computed, for the client to compare with the go command's own.
    await writeFile(
      join(persistTo, "go-sums.json"),
      `${JSON.stringify(sums, null, 2)}\n`,
    );
    const state = async (
      version: string,
      op: "yank" | "deprecate",
      message: string,
    ) => {
      const releaseId = `${ID}@${version}`;
      const stmts = await packageStateStatements(
        db,
        OWNER,
        releaseId,
        op,
        message,
        now,
      );
      if (op === "yank")
        stmts.unshift(
          stmtYankRelease(OWNER, releaseId, message, "harness", now),
        );
      await db.batch(stmts);
    };
    await state("1.0.1", "yank", "broken build");
    console.log(
      `seeded ${OWNER}'s Go feed: ${MODULE} v1.0.0, v1.0.1 (yanked), v1.1.0 (latest), v1.2.0-beta.1 (beta)`,
    );
  } finally {
    await proxy.dispose();
  }
}

await main();
