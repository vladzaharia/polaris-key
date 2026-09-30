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
  /** MANIFEST-owned artifact expectations only: channels, architectures, requireDmg, requireCli,
   *  allowAmbiguousAssets. A resync rewrites it on every push. */
  artifact_policy_json: string | null;
  metadata_access?: string | null;
  artifacts_access?: string | null;
  /** Owner of BOTH access modes (0022_b): NULL/'manifest' ⇒ resync writes them, 'admin' ⇒ skips. */
  access_source?: string | null;
  /** OPERATOR-owned artifact policy (0022_c): requireSparkleSignature, minimumSystemVersion.
   *  No manifest path ever writes this column. */
  operator_policy_json?: string | null;
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
 * The shape `sparkle:minimumSystemVersion` must have before it is rendered. Sparkle compares the
 * value rather than displaying it, and one it cannot parse silently makes every update
 * ineligible — so the writer refuses anything else and the reader drops anything else.
 */
export const MINIMUM_SYSTEM_VERSION_RE = /^\d+(?:\.\d+){0,2}$/;

/** The operator-only half of the artifact policy, as the readers see it. */
export interface OperatorPolicy {
  requireSparkleSignature: boolean;
  minimumSystemVersion?: string;
}

/**
 * Resolve the OPERATOR-owned artifact policy from `operator_policy_json` (0022_c).
 *
 * This column is written by `setOperatorPolicy` (the console's `update/settings`) and by nothing
 * else: no manifest shape carries either key (R6-03), and resync never names the column. It is
 * separate from `artifact_policy_json` precisely because that blob is manifest-owned and a
 * resync rewrites it whole — which used to drop these keys on every push.
 *
 * Fail-safe in both directions: a NULL or unreadable value means "signature required, no
 * minimum". Only an explicit JSON `false` opts a product out of the signature requirement.
 */
export function operatorPolicy(
  cfg: Pick<ReleaseConfigRow, "operator_policy_json">,
): OperatorPolicy {
  const raw = cfg.operator_policy_json;
  if (!raw) return { requireSparkleSignature: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { requireSparkleSignature: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { requireSparkleSignature: true };
  const obj = parsed as {
    requireSparkleSignature?: unknown;
    minimumSystemVersion?: unknown;
  };
  const min = obj.minimumSystemVersion;
  return {
    requireSparkleSignature: obj.requireSparkleSignature !== false,
    ...(typeof min === "string" && MINIMUM_SYSTEM_VERSION_RE.test(min)
      ? { minimumSystemVersion: min }
      : {}),
  };
}

/**
 * Resolve the effective artifact policy.
 *
 * `requireSparkleSignature` is OPERATOR-owned (R6-03) and read from `operator_policy_json`,
 * which no manifest path writes: `parseManifest` does not carry the field, and resync rewrites
 * only the manifest-owned `artifact_policy_json`. So a `.pkey/release.*` push can neither write
 * `false` and disarm the platform's own signing requirement, nor erase an operator's deliberate
 * `false`. The default is always "required".
 *
 * The access modes come from their own columns; whether a resync may rewrite them is decided by
 * `access_source` (see `setReleaseAccess`).
 */
export function artifactPolicy(cfg: ReleaseConfigRow): ArtifactPolicy {
  return {
    requireSparkleSignature: operatorPolicy(cfg).requireSparkleSignature,
    access: {
      metadata: readAccessMode(cfg.metadata_access),
      artifacts: readAccessMode(cfg.artifacts_access),
    },
  };
}

/** Who owns the access modes right now. NULL and anything unrecognised read as `manifest`. */
export function accessSourceOf(
  cfg: Pick<ReleaseConfigRow, "access_source">,
): "manifest" | "admin" {
  return cfg.access_source === "admin" ? "admin" : "manifest";
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
 * Set a product's release access modes, and CLAIM them for the operator.
 *
 * The WRITER lives with the table (spec §5.2: `release_config` is Release's), even though the
 * admin endpoint that calls it is `update/settings` — Update reaches it across the one
 * sanctioned cross-service edge rather than issuing SQL against a table it does not own. The two
 * modes are validated by the caller against `isReleaseAccess`; this function does not re-check,
 * because a silent fallback here would turn a rejected value into a quiet downgrade.
 *
 * Setting either mode flips `access_source` to `admin`, so the next resync skips BOTH (the guard
 * is in resync's own UPDATE). Without that, `entitled` — which no manifest can express — would be
 * downgraded to the manifest's mode (default `public`) by the very next push.
 */
export async function setReleaseAccess(
  db: Db,
  product: string,
  access: { metadata?: ReleaseAccess; artifacts?: ReleaseAccess },
): Promise<void> {
  await db.run(
    `UPDATE release_config
        SET metadata_access = COALESCE(?, metadata_access),
            artifacts_access = COALESCE(?, artifacts_access),
            access_source = 'admin'
      WHERE product = ?`,
    access.metadata ?? null,
    access.artifacts ?? null,
    product,
  );
}

/**
 * Hand the access modes back to manifest control.
 *
 * Only the OWNER flips — the stored modes stay exactly as the operator left them, and the next
 * resync re-applies `.pkey/release`. Same contract as `revertServicesToManifest`: reverting never
 * reaches out to GitHub on the spot.
 */
export async function revertReleaseAccessToManifest(
  db: Db,
  product: string,
): Promise<void> {
  await db.run(
    "UPDATE release_config SET access_source = 'manifest' WHERE product = ?",
    product,
  );
}

/**
 * Patch the operator-only artifact policy (`operator_policy_json`).
 *
 * `undefined` leaves a key alone; `minimumSystemVersion: null` removes it. The caller validates
 * the values (`MINIMUM_SYSTEM_VERSION_RE`, a boolean for the signature flag). Keys the stored
 * object already carries are preserved, and an unreadable stored value is replaced — the reader
 * treats it as the defaults already, so nothing an operator could see is lost.
 *
 * There is no ownership marker because there is no second writer: this column has no manifest
 * spelling at all, so it is operator-owned by construction.
 */
export async function setOperatorPolicy(
  db: Db,
  product: string,
  patch: {
    requireSparkleSignature?: boolean;
    minimumSystemVersion?: string | null;
  },
): Promise<void> {
  const row = await db.first<{ operator_policy_json: string | null }>(
    "SELECT operator_policy_json FROM release_config WHERE product = ?",
    product,
  );
  let current: Record<string, unknown> = {};
  if (row?.operator_policy_json) {
    try {
      const parsed: unknown = JSON.parse(row.operator_policy_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        current = parsed as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  if (patch.requireSparkleSignature !== undefined)
    current.requireSparkleSignature = patch.requireSparkleSignature;
  if (patch.minimumSystemVersion === null) delete current.minimumSystemVersion;
  else if (patch.minimumSystemVersion !== undefined)
    current.minimumSystemVersion = patch.minimumSystemVersion;
  await db.run(
    "UPDATE release_config SET operator_policy_json = ? WHERE product = ?",
    Object.keys(current).length > 0 ? JSON.stringify(current) : null,
    product,
  );
}
