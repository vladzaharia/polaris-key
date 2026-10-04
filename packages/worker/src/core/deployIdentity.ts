/**
 * Deploy identity (A-11, notes/S-13 §4): which build of Polaris Key is running, and which D1
 * migrations the database has. Read by the platform-admin `GET /manage/api/platform/version` and
 * `/deployment` (`admin/handlers/platform.ts`). Product-less, read-only, no outbound call.
 */

import { PROTOCOL_VERSION } from "@polaris-key/protocol";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { DISCOVERY_VERSION } from "./discovery.js";
import { RELEASE_TAG } from "./platformOps.js";

/**
 * The newest file in `migrations/` that this build ships. `test/deployIdentity.test.ts` pins it
 * to the directory (the same pattern as `REQUIRED_INDEXES` against the newest
 * `*_index_assertion.sql`), so adding a migration without bumping this fails the suite. Compared
 * with `d1_migrations` to say whether the database has caught up with the code.
 */
export const LATEST_MIGRATION = "0062_dist_listing.sql";

const GIT_SHA = /^[0-9a-f]{40}$/;

export interface CloudflareVersion {
  /** Cloudflare's version id for the running version. */
  id: string;
  /** The version's tag (`wrangler deploy --tag`), `null` when none was set. */
  tag: string | null;
  /** When the version was uploaded, as Cloudflare reports it. */
  uploadedAt: string | null;
}

export interface DeployIdentity {
  /** `PKEY_RELEASE_TAG`, validated; `null` when unset or malformed (never echoed raw). */
  releaseTag: string | null;
  /** `PKEY_GIT_SHA`, validated (40 lowercase hex); `null` otherwise. */
  gitSha: string | null;
  /** The version metadata binding; `null` without it (tests, `wrangler dev` without it). */
  cloudflare: CloudflareVersion | null;
  protocolVersion: number;
  discoveryVersion: number;
  latestMigration: string;
}

export function deployIdentity(env: Env): DeployIdentity {
  const tag = env.PKEY_RELEASE_TAG?.trim() ?? "";
  const sha = env.PKEY_GIT_SHA?.trim().toLowerCase() ?? "";
  const meta = env.CF_VERSION_METADATA;
  return {
    releaseTag: RELEASE_TAG.test(tag) ? tag : null,
    gitSha: GIT_SHA.test(sha) ? sha : null,
    cloudflare:
      meta && typeof meta.id === "string" && meta.id
        ? {
            id: meta.id,
            tag: meta.tag || null,
            uploadedAt: meta.timestamp || null,
          }
        : null,
    protocolVersion: PROTOCOL_VERSION,
    discoveryVersion: DISCOVERY_VERSION,
    latestMigration: LATEST_MIGRATION,
  };
}

export interface AppliedMigration {
  name: string;
  appliedAt: string | null;
}

/**
 * The migrations recorded in `d1_migrations`, oldest first. That table is written by
 * `wrangler d1 migrations apply` (and by `@cloudflare/vitest-pool-workers`' `applyD1Migrations`,
 * which reads it back through the same binding API). It is an ordinary table, not a reserved
 * `_cf_*` one. Answers `null`, never throws, when it cannot be read: the Node test harness and a
 * hand-built database have no such table, and "unknown" is the honest answer there.
 */
export async function appliedMigrations(
  db: Db,
): Promise<AppliedMigration[] | null> {
  try {
    const rows = await db.all<{ name: string; applied_at: string | null }>(
      "SELECT name, applied_at FROM d1_migrations ORDER BY id",
    );
    return rows.map((r) => ({
      name: String(r.name),
      appliedAt: r.applied_at == null ? null : String(r.applied_at),
    }));
  } catch {
    return null;
  }
}
