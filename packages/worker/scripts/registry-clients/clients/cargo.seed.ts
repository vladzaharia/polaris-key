/**
 * Seed the Cargo feed for the registry-client harness (F-30): the fixture owner's Cargo feed and
 * two crates published through Release's real package ingest (`ingestPackageDescriptor`) into the
 * harness's local D1 and R2, before `wrangler dev` starts.
 *
 *   tsx clients/cargo.seed.ts --persist-to <state dir> --origin <registry origin>
 *
 *   smoke-dep    1.0.0          a sibling crate the next one depends on, from this same feed
 *   smoke-crate  0.9.0          stable, then yanked ("broken build")
 *                1.0.0          stable
 *                1.1.0          stable, depending on smoke-dep through this feed's index URL
 *                1.2.0-beta.1   the `beta` channel, a semver pre-release
 *
 * Each `.crate` is what `cargo package` writes: a gzipped tar of `<name>-<version>/` with a
 * normalised `Cargo.toml` (a dependency on this feed carries its `registry-index`) and the source.
 * The metadata comes from that `Cargo.toml` through the CLI's own extractor
 * (`packages/cli/src/package/cargo.ts` `cargoMetadata`), exactly as `pkey release publish` reads
 * it, so the harness checks the publish path's metadata end to end with a real Cargo.
 *
 * WHY NOT `pkey release publish`: publishing needs upload tickets, which mint S3 credentials for
 * R2 (P2-02) and have no local equivalent in `wrangler dev` (see `godot.seed.ts`). Nothing here
 * reaches a deployed environment: `getPlatformProxy` binds the `--env test` D1 and R2 under the
 * harness's state directory.
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { getPlatformProxy } from "wrangler";
import { cargoMetadata } from "../../../../cli/src/package/cargo.js";
import { D1Db } from "../../../src/db/d1.js";
import type { Env } from "../../../src/platform/env.js";
import { blobKey, recordObject } from "../../../src/core/assets/blobs.js";
import {
  stmtUpsertDeliverable,
  stmtYankRelease,
} from "../../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../../src/services/release/packages/ingest.js";
import { packageStateStatements } from "../../../src/services/release/packages/state.js";
import { FIXTURE_OWNER } from "../seed.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OWNER = FIXTURE_OWNER;

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (!v)
    throw new Error(
      `usage: cargo.seed.ts --persist-to <dir> --origin <url> (missing ${name})`,
    );
  return v;
}

/** A ustar archive of `files` (fixed mode, owner and timestamp), gzipped: a `.crate`. */
export function crateArchive(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write(`${(1735689600).toString(8).padStart(11, "0")}\0`, 136, 12);
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks), { level: 9 }));
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** One crate version: its normalised manifest and its source. */
interface Crate {
  readonly name: string;
  readonly version: string;
  readonly channel: string;
  readonly deps: string;
  readonly lib: string;
}

async function main(): Promise<void> {
  const persistTo = arg("--persist-to");
  const origin = arg("--origin").replace(/\/+$/, "");
  const ownIndex = `sparse+${origin}/cargo/${OWNER}/`;
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

    // `loadProductPublic` (the registry dispatcher's owner check) needs an ACTIVE product key row;
    // no registry route signs, so it is an inert placeholder (as `godot.seed.ts` inserts it).
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
       VALUES (?, 'cargo', 1, 'public', '{}', 52428800, '{}', ?)
       ON CONFLICT(product, ecosystem) DO NOTHING`,
      OWNER,
      now,
    );

    const crates: Crate[] = [
      {
        name: "smoke-dep",
        version: "1.0.0",
        channel: "stable",
        deps: "",
        lib: 'pub fn dep() -> &\'static str { "smoke-dep 1.0.0" }\n',
      },
      ...["0.9.0", "1.0.0", "1.1.0", "1.2.0-beta.1"].map((version) => ({
        name: "smoke-crate",
        version,
        channel: version.includes("-") ? "beta" : "stable",
        deps:
          version === "1.1.0"
            ? `\n[dependencies.smoke-dep]\nversion = "^1.0"\nregistry-index = ${JSON.stringify(ownIndex)}\n`
            : "",
        lib:
          `pub fn version() -> &'static str { ${JSON.stringify(version)} }\n` +
          (version === "1.1.0"
            ? "pub fn dep() -> &'static str { smoke_dep::dep() }\n"
            : 'pub fn dep() -> &\'static str { "none" }\n'),
      })),
    ];

    let at = now - 1000;
    const declared = new Set<string>();
    for (const c of crates) {
      const id = c.name === "smoke-dep" ? "cargo.dep" : "cargo.smoke";
      if (!declared.has(id)) {
        declared.add(id);
        await db.run(
          `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
           VALUES (?, ?, 'public', NULL, 'manifest', ?)
           ON CONFLICT (product, deliverable_id) DO NOTHING`,
          OWNER,
          id,
          now,
        );
        const s = stmtUpsertDeliverable(
          {
            product: OWNER,
            deliverableId: id,
            kind: "package",
            defJson: JSON.stringify({
              kind: "package",
              id,
              ecosystem: "cargo",
              name: c.name,
              artifacts: { crate: { match: "*.crate" } },
            }),
            ecosystem: "cargo",
            packageName: c.name,
          },
          now,
        );
        await db.run(s.sql, ...s.params);
      }
      const dir = `${c.name}-${c.version}`;
      const manifest = [
        "[package]",
        'edition = "2021"',
        `name = ${JSON.stringify(c.name)}`,
        `version = ${JSON.stringify(c.version)}`,
        'description = "The registry-client harness\'s Cargo fixture."',
        'license = "MIT"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        c.deps,
      ].join("\n");
      const archive = crateArchive({
        [`${dir}/Cargo.toml`]: manifest,
        [`${dir}/src/lib.rs`]: c.lib,
      });
      const { metadata } = cargoMetadata(manifest);
      const digest = sha(archive);
      await bucket.put(blobKey(digest), archive, { sha256: digest });
      await recordObject(
        db,
        {
          storageKey: blobKey(digest),
          sha256: digest,
          size: archive.length,
          kind: "blob",
          gated: false,
        },
        now,
      );
      const res = await ingestPackageDescriptor(
        db,
        env,
        OWNER,
        {
          descriptorVersion: 1,
          product: OWNER,
          deliverable: id,
          kind: "package",
          version: c.version,
          channel: c.channel,
          package: {
            ecosystem: "cargo",
            name: c.name,
            files: [
              {
                name: `${dir}.crate`,
                role: "payload",
                type: "crate",
                sha256: digest,
                size: archive.length,
                locations: [{ provider: "r2", key: blobKey(digest) }],
              },
            ],
            metadata,
          },
        },
        {
          now: at,
          promoted: [blobKey(digest)],
          feed: {
            ecosystem: "cargo",
            enabled: true,
            ownerEnabled: true,
            policyEnabled: true,
            namespace: {},
            maxPackageBytes: 52428800,
            ext: {},
          },
          source: { kind: "static" },
        },
      );
      if (!res.ok) throw new Error(`ingest ${dir}: ${JSON.stringify(res)}`);
      at += 100;
    }
    const releaseId = "cargo.smoke@0.9.0";
    const stmts = await packageStateStatements(
      db,
      OWNER,
      releaseId,
      "yank",
      "broken build",
      now,
    );
    stmts.unshift(
      stmtYankRelease(OWNER, releaseId, "broken build", "harness", now),
    );
    await db.batch(stmts);
    console.log(
      `seeded ${OWNER}'s Cargo feed: smoke-dep 1.0.0; smoke-crate 0.9.0 (yanked), 1.0.0, 1.1.0, 1.2.0-beta.1`,
    );
  } finally {
    await proxy.dispose();
  }
}

await main();
