/**
 * The PyPI client fixture (F-05, plans/F-01.md §6.8): the fixture owner's PyPI feed and the
 * package `polaris-smoke`, seeded into the harness's local D1 and R2 before `wrangler dev` starts.
 *
 *   0.8.0    stable, then deprecated ("use 1.x")  — listed as live: PyPI has no deprecation
 *   0.9.0    stable, then yanked ("broken build") — PEP 592: listed with the reason
 *   1.0.0    stable: a wheel, its PEP 658 metadata and an sdist
 *   1.1.0b1  beta                                  — a PEP 440 pre-release
 *
 * The rows are the ones `pkey release publish` writes for a package release (F-03:
 * `release_deliverables`, `release_metadata`, `release_artifacts`, `release_packages`, `blob_objects`,
 * `blob_refs`), and every object goes into the `--env test` bucket with its SHA-256, as
 * `putVerified` stores it, through wrangler's local platform proxy (the same persistence directory
 * `wrangler dev --persist-to` then opens). Publishing through the real CLI needs a staging bucket
 * and an upload ticket, which a local Worker cannot mint (`/release/publish/uploads` needs R2
 * credentials); the ingest itself is covered end to end in `test/registry/pypi.test.ts`.
 *
 * The files are built by `fixtures/build_pypi.py` (standard library only, fixed timestamps), so
 * two seeds are byte-identical. Nothing here reaches a deployed environment.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER } from "./lib.mjs";
import { FIXTURE_OWNER } from "./seed.mjs";

export const PYPI_PROJECT = "polaris-smoke";
const DELIVERABLE = "pypi.smoke";
const VERSIONS = [
  {
    version: "0.8.0",
    channel: "stable",
    state: "deprecated",
    message: "use 1.x",
  },
  {
    version: "0.9.0",
    channel: "stable",
    state: "yanked",
    message: "broken build",
  },
  { version: "1.0.0", channel: "stable", state: "live", message: null },
  { version: "1.1.0b1", channel: "beta", state: "live", message: null },
];

function typeOf(name) {
  if (name.endsWith(".whl.metadata")) return "core-metadata";
  if (name.endsWith(".whl")) return "wheel";
  return "sdist";
}

/**
 * Seed the PyPI fixture into the local state under `persistTo`, once per state directory: each
 * client's seed runs in its own process, so a marker file in the state directory is the guard.
 */
export async function seedPypi(persistTo) {
  if (!persistTo) throw new Error("seedPypi: no state directory (STATE)");
  const marker = join(persistTo, ".pypi-fixture-seeded");
  if (existsSync(marker)) return;
  const dir = mkdtempSync(join(tmpdir(), "pkey-pypi-fixture-"));
  try {
    execFileSync("python3", [
      join(WORKER, "scripts", "registry-clients", "fixtures", "build_pypi.py"),
      dir,
    ]);
    const files = readdirSync(dir).map((name) => {
      const bytes = readFileSync(join(dir, name));
      return {
        name,
        bytes,
        type: typeOf(name),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    const { getPlatformProxy } = await import("wrangler");
    const proxy = await getPlatformProxy({
      configPath: join(WORKER, "wrangler.toml"),
      environment: "test",
      persist: { path: join(persistTo, "v3") },
    });
    try {
      const { DB, BLOBS } = proxy.env;
      for (const f of files)
        await BLOBS.put(`blobs/sha256/${f.sha256}`, f.bytes, {
          sha256: f.sha256,
        });
      const now = Math.floor(Date.now() / 1000);
      const owner = FIXTURE_OWNER;
      const stmts = [
        DB.prepare(
          `INSERT OR IGNORE INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)`,
        ).bind(owner, now),
        DB.prepare(
          `INSERT OR IGNORE INTO dist_registry_feeds (product, ecosystem, enabled, access_mode,
             namespace_json, max_package_bytes, ext_json, updated_at)
           VALUES (?, 'pypi', 1, 'public', ?, 52428800, '{}', ?)`,
        ).bind(owner, JSON.stringify({ prefixes: ["polaris-smoke"] }), now),
        DB.prepare(
          `INSERT OR IGNORE INTO dist_access (product, deliverable_id, mode, source, modified_at)
           VALUES (?, ?, 'public', 'manifest', ?)`,
        ).bind(owner, DELIVERABLE, now),
        DB.prepare(
          `INSERT OR IGNORE INTO release_deliverables (product, deliverable_id, kind, def_json,
             def_source, created_at, modified_at, ecosystem, package_name)
           VALUES (?, ?, 'package', ?, 'manifest', ?, ?, 'pypi', ?)`,
        ).bind(
          owner,
          DELIVERABLE,
          JSON.stringify({
            kind: "package",
            ecosystem: "pypi",
            name: PYPI_PROJECT,
            artifacts: {
              wheel: { match: "*.whl" },
              sdist: { match: "*.tar.gz" },
            },
          }),
          now,
          now,
          PYPI_PROJECT,
        ),
      ];
      for (const f of files)
        stmts.push(
          DB.prepare(
            `INSERT OR IGNORE INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
             VALUES (?, ?, ?, 'blob', 0, ?, ?)`,
          ).bind(
            `blobs/sha256/${f.sha256}`,
            f.sha256,
            f.bytes.length,
            now,
            now,
          ),
        );
      VERSIONS.forEach((v, i) => {
        const releaseId = `${DELIVERABLE}@${v.version}`;
        const own = files.filter((f) =>
          f.name.startsWith(`polaris_smoke-${v.version}`),
        );
        stmts.push(
          DB.prepare(
            `INSERT OR IGNORE INTO release_metadata (product, release_id, version, published_at,
               created_at, modified_at, deliverable_id, seq, channel)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            owner,
            releaseId,
            v.version,
            now,
            now,
            now,
            DELIVERABLE,
            i + 1,
            v.channel,
          ),
          DB.prepare(
            `INSERT OR IGNORE INTO release_packages (product, ecosystem, name_norm, version,
               deliverable_id, release_id, name, state, state_message, files_json, metadata_json,
               source_json, published_at)
             VALUES (?, 'pypi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            owner,
            PYPI_PROJECT,
            v.version,
            DELIVERABLE,
            releaseId,
            PYPI_PROJECT,
            v.state,
            v.message,
            JSON.stringify(
              own.map((f) => ({
                name: f.name,
                type: f.type,
                sha256: f.sha256,
                size: f.bytes.length,
              })),
            ),
            JSON.stringify({
              name: PYPI_PROJECT,
              version: v.version,
              requiresPython: ">=3.8",
            }),
            JSON.stringify({ kind: "static" }),
            now + i,
          ),
        );
        for (const f of own)
          stmts.push(
            DB.prepare(
              `INSERT OR IGNORE INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
               VALUES (?, ?, 'artifact', ?, ?)`,
            ).bind(
              owner,
              `blobs/sha256/${f.sha256}`,
              `${releaseId}/${f.name}`,
              now,
            ),
          );
      });
      await DB.batch(stmts);
      writeFileSync(marker, "");
    } finally {
      await proxy.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
