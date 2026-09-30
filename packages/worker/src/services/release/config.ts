/// <reference types="@cloudflare/workers-types" />

/**
 * `release_config` — the row that says where a product's software comes from and who may have
 * it (design spec §5.2: Release owns this table).
 *
 * Split out of the old `release/index.ts` in P2.T1 so BOTH services can read it. Update renders
 * a feed over Release's truth (D-05) and therefore needs the same coordinates, the same Sparkle
 * key and the same access policy; a second copy of this parsing next door is exactly the drift
 * the split is meant to prevent.
 */

import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db } from "../../core/platform.js";

export interface ReleaseConfigRow {
  product: string;
  gh_owner: string | null;
  gh_repo: string | null;
  gh_installation_id: number | null;
  channel_workflow: string | null;
  beta_branch: string;
  manual_channels_json: string | null;
  binary_name: string | null;
  install_template: string | null;
  sparkle_ed25519_pub: string | null;
  summary_marker: string;
  artifact_policy_json: string | null;
  metadata_access?: string | null;
  artifacts_access?: string | null;
  /** `release.stableTagPattern` (0023). NULL ⇒ `DEFAULT_STABLE_TAG_PATTERN`. */
  stable_tag_pattern?: string | null;
  /** `release.ignoreTags` as a JSON array (0023). NULL ⇒ none. */
  ignore_tags_json?: string | null;
}

/** A release config that has the GitHub coordinates needed to talk to the API. */
export interface ResolvedConfig extends ReleaseConfigRow {
  gh_owner: string;
  gh_repo: string;
  gh_installation_id: number;
}

export function isResolved(cfg: ReleaseConfigRow): cfg is ResolvedConfig {
  return Boolean(cfg.gh_owner && cfg.gh_repo && cfg.gh_installation_id);
}

export async function getReleaseConfig(
  db: Db,
  product: string,
): Promise<ReleaseConfigRow | null> {
  return db.first<ReleaseConfigRow>(
    "SELECT * FROM release_config WHERE product = ?",
    product,
  );
}

/**
 * Read one access-mode column.
 *
 * `entitled` (D-13) joins the set in P2.T3. Validation is in code, not DDL: `release_config`'s
 * two columns are bare `TEXT NOT NULL DEFAULT 'public'` (0007's non-idempotent tail) with no
 * CHECK, so widening the value set needs no migration — and an unrecognised string still falls
 * back to `public`, which is the pre-existing behaviour for garbage in this column.
 */
export function readAccessMode(value: unknown): ReleaseAccess {
  if (value === "authenticated") return "authenticated";
  if (value === "licensed") return "licensed";
  if (value === "entitled") return "entitled";
  return "public";
}

/** The four modes an operator (or `.pkey/release`) may write. */
export const RELEASE_ACCESS_MODES: readonly ReleaseAccess[] = [
  "public",
  "authenticated",
  "licensed",
  "entitled",
];

export function isReleaseAccess(value: unknown): value is ReleaseAccess {
  return (
    typeof value === "string" &&
    (RELEASE_ACCESS_MODES as readonly string[]).includes(value)
  );
}

export interface ArtifactPolicy {
  requireSparkleSignature: boolean;
  access: { metadata: ReleaseAccess; artifacts: ReleaseAccess };
}

/**
 * Resolve the effective artifact policy.
 *
 * `requireSparkleSignature` is OPERATOR-owned (R6-03): `parseManifest` no longer carries the
 * field, so a `.pkey/release.*` push can never write `false` into `artifact_policy_json` and
 * disarm the platform's own signing requirement. Only an operator editing the row directly
 * can opt a product out, and the default is always "required".
 */
export function artifactPolicy(cfg: ReleaseConfigRow): ArtifactPolicy {
  const defaults = {
    requireSparkleSignature: true,
    access: { metadata: "public", artifacts: "public" } as const,
  };
  const columnAccess = {
    metadata: readAccessMode(cfg.metadata_access),
    artifacts: readAccessMode(cfg.artifacts_access),
  };
  if (!cfg.artifact_policy_json) {
    return { ...defaults, access: columnAccess };
  }
  try {
    const parsed = JSON.parse(cfg.artifact_policy_json) as {
      requireSparkleSignature?: unknown;
    };
    return {
      requireSparkleSignature: parsed.requireSparkleSignature !== false,
      access: columnAccess,
    };
  } catch {
    return { ...defaults, access: columnAccess };
  }
}

/**
 * The seven surfaces the two services serve between them.
 *
 * Still one union after the split, because it is what the SHARED gateway keys on: which lane
 * the rate limiter charges, whether the edge cache may hold the answer, and which of the two
 * access modes governs. Release owns `install`/`changelog`/`cli`/`dmg`; Update owns
 * `appcast`/`channelAppcast`/`version`.
 */
export type ReleaseKind =
  | "appcast"
  | "channelAppcast"
  | "cli"
  | "dmg"
  | "version"
  | "changelog"
  | "install";

/** Which access mode governs a surface: metadata for the informational reads, else artifacts. */
export function accessModeFor(
  policy: ArtifactPolicy,
  kind: ReleaseKind,
): ReleaseAccess {
  return kind === "version" || kind === "changelog" || kind === "install"
    ? policy.access.metadata
    : policy.access.artifacts;
}

/**
 * Set a product's release access modes.
 *
 * The WRITER lives with the table (spec §5.2: `release_config` is Release's), even though the
 * admin endpoint that calls it is `update/settings` — Update reaches it across the one
 * sanctioned cross-service edge rather than issuing SQL against a table it does not own. The two
 * modes are validated by the caller against `isReleaseAccess`; this function does not re-check,
 * because a silent fallback here would turn a rejected value into a quiet downgrade.
 */
export async function setReleaseAccess(
  db: Db,
  product: string,
  access: { metadata?: ReleaseAccess; artifacts?: ReleaseAccess },
): Promise<void> {
  await db.run(
    `UPDATE release_config
        SET metadata_access = COALESCE(?, metadata_access),
            artifacts_access = COALESCE(?, artifacts_access)
      WHERE product = ?`,
    access.metadata ?? null,
    access.artifacts ?? null,
    product,
  );
}
