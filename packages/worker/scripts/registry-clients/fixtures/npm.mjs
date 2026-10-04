/**
 * The npm feed's fixture (F-04): the package `@<owner>/hello` with
 *
 *   0.9.0         stable, deprecated ("use 1.x")
 *   1.0.0         stable, live           → dist-tag latest
 *   1.1.0         stable, yanked         → no dist-tag; installable by exact version, deprecated
 *   2.0.0-beta.1  beta, live             → dist-tag beta
 *
 * and `@<owner>/greeter` 1.0.0 (stable), which depends on `@<owner>/hello@^1.0.0`, so a client
 * resolves a dependency through the feed too, and `@<owner>/tampered` 1.0.0, whose recorded
 * digests are of other bytes, so every client must refuse it. Each tarball is a real `package/`-rooted gzip tar
 * with a `package.json` and an `index.js` that prints its version. The rows are the ones the
 * package ingest writes (`release_deliverables`, `release_metadata`, `release_packages`,
 * `release_yanks`, `dist_access`), with the SHA-512 and SHA-1 it would compute, plus the feed's
 * settings (`dist_registry_owners`, `dist_registry_feeds` with scope `@<owner>`).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const q = (v) =>
  v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

/** The fixture's versions, in publication order. */
export const NPM_FIXTURE = [
  {
    pkg: "hello",
    version: "0.9.0",
    channel: "stable",
    state: "deprecated",
    message: "use 1.x",
  },
  { pkg: "hello", version: "1.0.0", channel: "stable", state: "live" },
  {
    pkg: "hello",
    version: "1.1.0",
    channel: "stable",
    state: "yanked",
    message: "broken build",
  },
  { pkg: "hello", version: "2.0.0-beta.1", channel: "beta", state: "live" },
  {
    pkg: "greeter",
    version: "1.0.0",
    channel: "stable",
    state: "live",
    deps: { hello: "^1.0.0" },
  },
  // Its rows name a SHA-512 and SHA-1 of other bytes: every client must refuse to install it.
  {
    pkg: "tampered",
    version: "1.0.0",
    channel: "stable",
    state: "live",
    tamper: true,
  },
];

function tarball(dir, scope, entry) {
  const root = join(dir, `${entry.pkg}-${entry.version}`);
  mkdirSync(join(root, "package"), { recursive: true });
  const dependencies = Object.fromEntries(
    Object.entries(entry.deps ?? {}).map(([n, r]) => [`${scope}/${n}`, r]),
  );
  const manifest = {
    name: `${scope}/${entry.pkg}`,
    version: entry.version,
    description: `Registry-client fixture ${entry.pkg} ${entry.version}`,
    main: "index.js",
    license: "MIT",
    dependencies,
  };
  writeFileSync(
    join(root, "package", "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "package", "index.js"),
    `module.exports = { name: ${JSON.stringify(manifest.name)}, version: ${JSON.stringify(entry.version)} };\n`,
  );
  const file = join(dir, `${entry.pkg}-${entry.version}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", root, "package"]);
  return { file, manifest };
}

export async function seedFixture(ctx) {
  const { owner, now } = ctx;
  const scope = `@${owner}`;
  const dir = mkdtempSync(join(tmpdir(), "pkey-npm-fixture-"));
  try {
    const sql = [
      `INSERT OR REPLACE INTO dist_registry_owners (product, enabled, updated_at) VALUES (${q(owner)}, 1, ${now});`,
      `INSERT OR REPLACE INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, updated_at)
         VALUES (${q(owner)}, 'npm', 1, 'public', ${q(JSON.stringify({ scope }))}, 52428800, ${now});`,
    ];
    const declared = new Set();
    const seq = new Map();
    NPM_FIXTURE.forEach((entry, i) => {
      const id = `npm.${entry.pkg}`;
      const name = `${scope}/${entry.pkg}`;
      if (!declared.has(id)) {
        declared.add(id);
        const def = {
          kind: "package",
          id,
          ecosystem: "npm",
          name,
          artifacts: { tarball: { match: `${entry.pkg}-*.tgz` } },
        };
        sql.push(
          `INSERT OR REPLACE INTO release_deliverables (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at, ecosystem, package_name)
             VALUES (${q(owner)}, ${q(id)}, 'package', NULL, ${q(JSON.stringify(def))}, 'manifest', ${now}, ${now}, 'npm', ${q(name)});`,
          `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
             VALUES (${q(owner)}, ${q(id)}, 'public', NULL, 'manifest', ${now});`,
        );
      }
      const { file, manifest } = tarball(dir, scope, entry);
      const bytes = readFileSync(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `blobs/sha256/${sha256}`;
      ctx.putObject(key, file);
      const n = (seq.get(id) ?? 0) + 1;
      seq.set(id, n);
      const releaseId = `${id}@${entry.version}`;
      // Thirty days old: Yarn 4's default `npmMinimalAgeGate` quarantines fresher versions.
      const published = now - 30 * 86400 + i * 60;
      const fileName = `${entry.pkg}-${entry.version}.tgz`;
      const files = [
        {
          name: fileName,
          type: "npm-tarball",
          sha256,
          size: bytes.length,
          sha512: createHash("sha512")
            .update(entry.tamper ? Buffer.from("not these bytes") : bytes)
            .digest("hex"),
          sha1: createHash("sha1")
            .update(entry.tamper ? Buffer.from("not these bytes") : bytes)
            .digest("hex"),
        },
      ];
      const marker = JSON.stringify({
        status: "ingested",
        sha256: "0".repeat(64),
        source: "ci",
        at: now,
      });
      sql.push(
        `INSERT OR REPLACE INTO release_metadata (product, release_id, version, title, notes, commit_sha, source_url, metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at, deliverable_id, seq, channel)
           VALUES (${q(owner)}, ${q(releaseId)}, ${q(entry.version)}, ${q(`${name} ${entry.version}`)}, NULL, NULL, NULL, 'public', 'public', ${published}, json_object('descriptor', json(${q(marker)})), ${now}, ${now}, ${q(id)}, ${n}, ${q(entry.channel)});`,
        `INSERT OR REPLACE INTO release_artifacts (product, release_id, artifact_id, name, kind, platform, arch, content_type, size_bytes, sha256, source_url, storage_key, sparkle_signature, access, metadata_json, created_at, build_id, role, locations_json)
           VALUES (${q(owner)}, ${q(releaseId)}, ${q(`file:${fileName}`)}, ${q(fileName)}, 'package', NULL, NULL, 'application/octet-stream', ${bytes.length}, ${q(sha256)}, NULL, ${q(key)}, NULL, 'public', ${q(JSON.stringify({ packageFileType: "npm-tarball" }))}, ${now}, NULL, 'payload', ${q(JSON.stringify([{ provider: "r2", key }]))});`,
        `INSERT OR REPLACE INTO release_packages (product, ecosystem, name_norm, version, deliverable_id, release_id, name, state, state_message, files_json, metadata_json, source_json, published_at)
           VALUES (${q(owner)}, 'npm', ${q(name)}, ${q(entry.version)}, ${q(id)}, ${q(releaseId)}, ${q(name)}, ${q(entry.state)}, ${q(entry.message ?? null)}, ${q(JSON.stringify(files))}, ${q(JSON.stringify(manifest))}, ${q(JSON.stringify({ kind: "static" }))}, ${published});`,
      );
      if (entry.state === "yanked")
        sql.push(
          `INSERT OR REPLACE INTO release_yanks (product, release_id, reason, at, by) VALUES (${q(owner)}, ${q(releaseId)}, ${q(entry.message)}, ${now}, 'registry-clients');`,
        );
    });
    ctx.sql(sql.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
