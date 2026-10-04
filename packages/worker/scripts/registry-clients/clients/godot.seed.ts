/**
 * Seed the Godot feed for the registry-client harness (F-09): the fixture owner's Godot feed and
 * one addon published through Release's real package ingest (`ingestPackageDescriptor`) into the
 * harness's local D1 and R2, before `wrangler dev` starts.
 *
 *   tsx clients/godot.seed.ts --persist-to <state dir> --origin <registry origin>
 *
 * The addon is `smoke_addon` (deliverable `godot.smoke`), four versions in publication order:
 * 1.0.0 (stable, then deprecated), 1.0.1 (stable, then yanked), 1.1.0 (stable, with an icon: the
 * `latest` tag) and 1.2.0-beta.1 (the `beta` channel). Each zip is a real addon archive
 * (`addons/smoke_addon/plugin.cfg` and a script), so GodotEnv installs it for real.
 *
 * WHY NOT `pkey release publish`: publishing needs upload tickets, which mint S3 credentials for
 * R2 (P2-02) and have no local equivalent in `wrangler dev`. The seed therefore calls the same
 * ingest the publish route calls, after storing the bytes the way `promote` leaves them (under
 * `blobs/sha256/<hex>` with their SHA-256 checksum). Nothing here reaches a deployed environment:
 * `getPlatformProxy` binds the `--env test` D1 and R2 under the harness's state directory.
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { getPlatformProxy } from "wrangler";
import { D1Db } from "../../../src/db/d1.js";
import type { Env } from "../../../src/env.js";
import { blobKey, recordObject } from "../../../src/core/blobs.js";
import {
  stmtUpsertDeliverable,
  stmtYankRelease,
} from "../../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../../src/services/release/packages/ingest.js";
import { packageStateStatements } from "../../../src/services/release/packages/state.js";
import { FIXTURE_OWNER } from "../seed.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OWNER = FIXTURE_OWNER;
const PUBLISHER = "registry-smoke";
const ID = "godot.smoke";
const NAME = "smoke_addon";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (!v)
    throw new Error(
      `usage: godot.seed.ts --persist-to <dir> --origin <url> (missing ${name})`,
    );
  return v;
}

/** A minimal ZIP (deflated entries, fixed timestamps) of `files`. */
export function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = deflateRawSync(data, { level: 9 });
    const fname = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x5a21, 12); // date: 2025-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5a21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fname, packed);
    centrals.push(central, fname);
    offset += local.length + fname.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/**
 * A 1×1 PNG with valid chunk CRCs. (F-09's manual editor check: Godot's PNG loader rejects an
 * image whose IDAT CRC is wrong, so the editor showed no icon for the earlier hand-typed bytes.)
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

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
       VALUES (?, 'godot', 1, 'public', ?, 52428800, ?, ?)
       ON CONFLICT(product, ecosystem) DO NOTHING`,
      OWNER,
      JSON.stringify({ publisher: PUBLISHER }),
      JSON.stringify({
        categoryId: "6",
        license: "MIT",
        minGodotVersion: "4.4",
      }),
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
      ecosystem: "godot" as const,
      name: NAME,
      artifacts: { zip: { match: "*.zip" }, icon: { match: "*.png" } },
    };
    const s = stmtUpsertDeliverable(
      {
        product: OWNER,
        deliverableId: ID,
        kind: "package",
        defJson: JSON.stringify(decl),
        ecosystem: "godot",
        packageName: NAME,
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

    const versions: Array<[string, string, boolean]> = [
      ["1.0.0", "stable", false],
      ["1.0.1", "stable", false],
      ["1.1.0", "stable", true],
      ["1.2.0-beta.1", "beta", false],
    ];
    let at = now - 1000;
    for (const [version, channel, withIcon] of versions) {
      const cfg = [
        "[plugin]",
        "",
        `name="Smoke Addon"`,
        `description="The registry-client harness's Godot fixture."`,
        `author="Polaris Key"`,
        `version="${version}"`,
        `script="plugin.gd"`,
        "",
      ].join("\n");
      const archive = zip({
        [`addons/${NAME}/plugin.cfg`]: cfg,
        [`addons/${NAME}/plugin.gd`]: "@tool\nextends EditorPlugin\n",
        [`addons/${NAME}/VERSION`]: `${version}\n`,
      });
      const zipSha = await store(archive);
      const iconSha = withIcon ? await store(new Uint8Array(PNG)) : null;
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
            ecosystem: "godot",
            name: NAME,
            files: [
              {
                name: `${NAME}-${version}.zip`,
                role: "payload",
                type: "godot-zip",
                sha256: zipSha,
                size: archive.length,
                locations: [{ provider: "r2", key: blobKey(zipSha) }],
              },
              ...(iconSha
                ? [
                    {
                      name: "icon.png",
                      role: "payload",
                      type: "godot-icon",
                      sha256: iconSha,
                      size: PNG.length,
                      locations: [{ provider: "r2", key: blobKey(iconSha) }],
                    },
                  ]
                : []),
            ],
            metadata: {
              name: NAME,
              version,
              displayName: "Smoke Addon",
              author: "Polaris Key",
              description: "The registry-client harness's Godot fixture.",
              script: "plugin.gd",
            },
          },
        },
        {
          now: at,
          promoted: [blobKey(zipSha), ...(iconSha ? [blobKey(iconSha)] : [])],
          feed: {
            ecosystem: "godot",
            enabled: true,
            ownerEnabled: true,
            policyEnabled: true,
            namespace: { publisher: PUBLISHER },
            maxPackageBytes: 52428800,
            ext: {},
          },
          source: { kind: "static" },
        },
      );
      if (!res.ok) throw new Error(`ingest ${version}: ${JSON.stringify(res)}`);
      at += 100;
    }
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
    await state("1.0.0", "deprecate", "use 1.1.0");
    await state("1.0.1", "yank", "broken export");
    console.log(
      `seeded ${OWNER}'s Godot feed: ${NAME} 1.0.0 (deprecated), 1.0.1 (yanked), 1.1.0, 1.2.0-beta.1`,
    );
  } finally {
    await proxy.dispose();
  }
}

await main();
