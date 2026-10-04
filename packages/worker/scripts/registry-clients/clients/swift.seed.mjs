#!/usr/bin/env node
/**
 * Seed the Swift registry harness (F-06, plans/F-01.md §5.3 and §6.8). `run.mjs` runs it after
 * the migrations and before `wrangler dev` starts, for the `swift`, `swift-compat` and
 * `swift-linux` clients, with STATE (the local state directory) and OWNER in its environment.
 *
 *   1. A THROWAWAY CA for this run only, in STATE (never committed, deleted with STATE): an EC
 *      P-256 root and a leaf with `codeSigning`, as SwiftPM's signing policy expects.
 *   2. The fixture package (`swift/fixture/`) published as `smoke.SmokeKit` through SwiftPM's own
 *      signer: `swift package-registry publish --dry-run --private-key-path … --cert-chain-paths
 *      …` writes the source archive, its `cms-1.0.0` signature and the signed manifests into a
 *      scratch directory and contacts no registry (§5.3). Three versions: 1.0.0 (stable), 1.1.0
 *      (stable, then yanked) and 2.0.0-beta.1 (the beta channel).
 *   3. The rows and blobs F-03's ingest would write for those releases, into the local D1 and R2
 *      through wrangler's platform proxy (R2 objects carry their SHA-256, as `putVerified`
 *      writes them, so `blobResponse` serves them). The local Worker cannot run the real
 *      `pkey release publish` path, whose uploads presign against a real R2 account.
 *   4. `STATE/swift/fixture.json`: what the clients check against (versions, checksums).
 *
 * Nothing here reaches a deployed environment: the proxy is `--env test`, persisted under STATE.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { WORKER } from "../lib.mjs";

const STATE = process.env.STATE;
const OWNER = process.env.OWNER;
if (!STATE || !OWNER) {
  console.error("swift.seed.mjs: STATE and OWNER are required");
  process.exit(2);
}

const SWIFT = process.env.SWIFT ?? "swift";
const SCOPE = "smoke";
const ID = `${SCOPE}.SmokeKit`;
const DELIVERABLE = "swift.smokekit";
const REPOSITORY = "https://github.com/example/SmokeKit";
const VERSIONS = [
  { version: "1.0.0", channel: "stable", state: "live" },
  { version: "1.1.0", channel: "stable", state: "yanked" },
  { version: "2.0.0-beta.1", channel: "beta", state: "live" },
];

const work = join(STATE, "swift");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (cmd, args, cwd = work) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

// ── 1. The throwaway CA ───────────────────────────────────────────────────────────────────────
const ca = join(work, "ca");
mkdirSync(ca);
const ossl = (...args) => run("openssl", args, ca);
ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key");
ossl(
  "req",
  "-x509",
  "-new",
  "-key",
  "root.key",
  "-sha256",
  "-days",
  "2",
  "-subj",
  "/CN=Polaris Key registry harness throwaway root",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
  "-out",
  "root.pem",
);
ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key");
ossl(
  "req",
  "-new",
  "-key",
  "leaf.key",
  "-subj",
  "/CN=Polaris Key registry harness signer/O=Polaris Key test",
  "-out",
  "leaf.csr",
);
writeFileSync(
  join(ca, "leaf.ext"),
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n",
);
ossl(
  "x509",
  "-req",
  "-in",
  "leaf.csr",
  "-CA",
  "root.pem",
  "-CAkey",
  "root.key",
  "-CAcreateserial",
  "-days",
  "1",
  "-sha256",
  "-extfile",
  "leaf.ext",
  "-out",
  "leaf.pem",
);
ossl("x509", "-in", "leaf.pem", "-outform", "DER", "-out", "leaf.der");
ossl("x509", "-in", "root.pem", "-outform", "DER", "-out", "root.der");
ossl(
  "pkcs8",
  "-topk8",
  "-nocrypt",
  "-in",
  "leaf.key",
  "-outform",
  "DER",
  "-out",
  "leaf.p8.der",
);
mkdirSync(join(ca, "trusted"));
cpSync(join(ca, "root.der"), join(ca, "trusted", "root.der"));

// ── 2. Signed releases through SwiftPM's own signer ───────────────────────────────────────────
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const fixtureSrc = join(
  WORKER,
  "scripts",
  "registry-clients",
  "swift",
  "fixture",
);
const releases = [];
for (const v of VERSIONS) {
  const pkg = join(work, `pkg-${v.version}`);
  cpSync(fixtureSrc, pkg, { recursive: true });
  writeFileSync(
    join(pkg, "Sources", "SmokeKit", "Version.swift"),
    `/// Written by the harness seed: the version this archive was published as.\nlet smokeVersion = "${v.version}"\n`,
  );
  const scratch = join(work, `scratch-${v.version}`);
  mkdirSync(scratch);
  run(
    SWIFT,
    [
      "package-registry",
      "publish",
      ID,
      v.version,
      "--url",
      "https://registry.invalid/swift/unused",
      "--dry-run",
      "--scratch-directory",
      scratch,
      "--private-key-path",
      join(ca, "leaf.p8.der"),
      "--cert-chain-paths",
      join(ca, "leaf.der"),
      join(ca, "root.der"),
    ],
    pkg,
  );
  // What the CLI's Swift extractor uploads (packages/cli/src/package/swift.ts).
  const names = readdirSync(scratch).sort();
  const pick = (n, type) => {
    const bytes = readFileSync(join(scratch, n));
    return { name: n, type, sha256: sha256(bytes), size: bytes.length, bytes };
  };
  const zip = names.find((n) => n.endsWith(".zip"));
  const sig = names.find((n) => n.endsWith(".sig"));
  if (!zip || !sig) throw new Error(`no signed archive in ${scratch}`);
  const files = [
    pick(zip, "source-archive"),
    pick(sig, "source-archive-signature"),
    ...names
      .filter((n) => /^Package(@swift-[0-9][0-9.]*)?\.swift$/.test(n))
      .map((n) => pick(n, "manifest")),
  ];
  const toolsVersions = names
    .map((n) => /^Package@swift-([0-9.]+)\.swift$/.exec(n)?.[1])
    .filter(Boolean);
  releases.push({ ...v, files, toolsVersions });
}

// ── 3. The rows and blobs ingest would write ──────────────────────────────────────────────────
const proxy = await getPlatformProxy({
  configPath: join(WORKER, "wrangler.toml"),
  environment: "test",
  persist: { path: join(STATE, "v3") },
  remoteBindings: false,
});
try {
  const { DB, BLOBS } = proxy.env;
  const now = Math.floor(Date.now() / 1000);
  const q = (sql, ...params) =>
    DB.prepare(sql)
      .bind(...params)
      .run();
  for (const r of releases)
    for (const f of r.files)
      await BLOBS.put(`blobs/sha256/${f.sha256}`, f.bytes, {
        sha256: f.sha256,
        httpMetadata: { contentType: "application/octet-stream" },
      });
  await q(
    `INSERT OR REPLACE INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)`,
    OWNER,
    now,
  );
  await q(
    `INSERT OR REPLACE INTO dist_registry_feeds
       (product, ecosystem, enabled, namespace_json, max_package_bytes, ext_json, updated_at)
     VALUES (?, 'swift', 1, ?, 52428800, ?, ?)`,
    OWNER,
    JSON.stringify({ scope: SCOPE }),
    JSON.stringify({
      requireSigned: true,
      repositoryUrls: { [ID]: [REPOSITORY] },
    }),
    now,
  );
  await q(
    `INSERT OR REPLACE INTO release_deliverables
       (product, deliverable_id, kind, pack_type, def_json, def_source, created_at, modified_at,
        ecosystem, package_name)
     VALUES (?, ?, 'package', NULL, ?, 'manifest', ?, ?, 'swift', ?)`,
    OWNER,
    DELIVERABLE,
    // The `.pkey/release` declaration, as manifest sync persists it (`readPackageDeliverables`).
    JSON.stringify({
      kind: "package",
      ecosystem: "swift",
      name: ID,
      artifacts: { archive: { match: "*.zip" } },
    }),
    now,
    now,
    ID,
  );
  await q(
    `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, ?, 'public', NULL, 'manifest', ?)`,
    OWNER,
    DELIVERABLE,
    now,
  );
  let seq = 0;
  for (const r of releases) {
    seq++;
    const releaseId = `${DELIVERABLE}@${r.version}`;
    await q(
      `INSERT OR REPLACE INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url, metadata_access,
          artifacts_access, published_at, metadata_json, created_at, modified_at, deliverable_id,
          seq, channel)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'public', 'public', ?, NULL, ?, ?, ?, ?, ?)`,
      OWNER,
      releaseId,
      r.version,
      `${ID} ${r.version}`,
      now + seq,
      now,
      now,
      DELIVERABLE,
      seq,
      r.channel,
    );
    await q(
      `INSERT OR REPLACE INTO release_packages
         (product, ecosystem, name_norm, version, deliverable_id, release_id, name, state,
          state_message, files_json, metadata_json, source_json, published_at)
       VALUES (?, 'swift', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      OWNER,
      ID.toLowerCase(),
      r.version,
      DELIVERABLE,
      releaseId,
      ID,
      r.state,
      r.state === "yanked" ? "yanked by the harness" : null,
      JSON.stringify(
        r.files.map(({ name, type, sha256: s, size }) => ({
          name,
          type,
          sha256: s,
          size,
        })),
      ),
      JSON.stringify({
        name: ID,
        version: r.version,
        ...(r.toolsVersions.length ? { toolsVersions: r.toolsVersions } : {}),
        signatureFormat: "cms-1.0.0",
      }),
      JSON.stringify({ kind: "static" }),
      now + seq,
    );
  }
} finally {
  await proxy.dispose();
}

// ── 4. What the clients check against ─────────────────────────────────────────────────────────
writeFileSync(
  join(work, "fixture.json"),
  JSON.stringify(
    {
      scope: SCOPE,
      name: "SmokeKit",
      id: ID,
      repository: REPOSITORY,
      trustedRoots: join(ca, "trusted"),
      releases: releases.map((r) => ({
        version: r.version,
        channel: r.channel,
        state: r.state,
        toolsVersions: r.toolsVersions,
        archive: r.files.find((f) => f.type === "source-archive").sha256,
      })),
    },
    null,
    2,
  ),
);
console.log(
  `seeded ${ID}: ${releases.map((r) => `${r.version} (${r.state})`).join(", ")}`,
);
