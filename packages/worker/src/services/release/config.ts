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

import type { ManifestAppDeliverable } from "@polaris-key/manifest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { Db } from "../../db/types.js";
import { hasArtifactMap } from "./artifactMap.js";

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
  /** NOT READ for any access decision since P2b-04: the artifacts mode is Distribution's
   *  `dist_access` (backfilled from this column by 0038). Kept because dropping a column needs a
   *  table rebuild; resync still writes the manifest's value here, and the truth-store snapshot
   *  (`artifactsAccessSnapshot`) copies it into rows nothing reads for access either. */
  artifacts_access?: string | null;
  /** Owner of BOTH access modes (0022_b): NULL/'manifest' ⇒ resync writes them, 'admin' ⇒ skips. */
  access_source?: string | null;
  /** OPERATOR-owned artifact policy (0022_c): requireSparkleSignature, minimumSystemVersion.
   *  No manifest path ever writes this column. */
  operator_policy_json?: string | null;
  /** `release.stableTagPattern` (0023). NULL ⇒ `DEFAULT_STABLE_TAG_PATTERN`. */
  stable_tag_pattern?: string | null;
  /** `release.ignoreTags` as a JSON array (0023). NULL ⇒ none. */
  ignore_tags_json?: string | null;
  /** `release.releaseKeys` as `[{kid, publicKey}]` (0044, P3-03). NULL ⇒ none declared, so no
   *  record is accepted. Never a product signing key (`release_key_is_product_key` at sync). */
  release_keys_json?: string | null;
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
 * This column is written by the setting `update.operatorPolicy` (the console's `update/settings`,
 * through `writeSetting()`) and by nothing else: no manifest shape carries either key (R6-03), and resync never names the column. It is
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
 * The METADATA mode comes from its own column; whether a resync may rewrite it is decided by
 * `access_source` (the `update.metadataAccess` column adapter). The ARTIFACTS mode is not Release's any more
 * (P2b-04): it is Distribution's delivery access (`dist_access`), which a caller reads through
 * `delivery.accessMode()` and passes as `artifactsAccess`. Without one it fails CLOSED to
 * `entitled`, the strictest mode — never back to `release_config.artifacts_access`.
 */
export function artifactPolicy(
  cfg: ReleaseConfigRow,
  artifactsAccess?: ReleaseAccess,
): ArtifactPolicy {
  return {
    requireSparkleSignature: operatorPolicy(cfg).requireSparkleSignature,
    access: {
      metadata: readAccessMode(cfg.metadata_access),
      artifacts: artifactsAccess ?? "entitled",
    },
  };
}

/**
 * The value the truth store's per-row `access` columns (`release_metadata.artifacts_access`,
 * `release_artifacts.access`, 0007) are written with. A SNAPSHOT, and nothing reads it for an
 * access decision since P2b-04 — the portal, its one consumer, now asks Distribution. Kept so
 * those NOT NULL columns keep carrying the value they always carried.
 */
export function artifactsAccessSnapshot(cfg: ReleaseConfigRow): ReleaseAccess {
  return readAccessMode(cfg.artifacts_access);
}

/** Who owns the access modes right now. NULL and anything unrecognised read as `manifest`. */
export function accessSourceOf(
  cfg: Pick<ReleaseConfigRow, "access_source">,
): "manifest" | "admin" {
  return cfg.access_source === "admin" ? "admin" : "manifest";
}

/**
 * Does the manifest's artifact policy EXPLICITLY require a macOS DMG? Only `requireDmg: true`
 * does — the manifest normaliser's own reading. No policy, an unreadable one, or one that does
 * not say so requires nothing.
 */
export function policyRequiresDmg(
  policyJson: string | null | undefined,
): boolean {
  if (!policyJson) return false;
  try {
    const parsed = JSON.parse(policyJson) as { requireDmg?: unknown } | null;
    return parsed?.requireDmg === true;
  } catch {
    return false;
  }
}

/** Does a declared artifact map name a macOS `dmg` build? */
export function mapDeclaresDmg(
  app: ManifestAppDeliverable | null | undefined,
): boolean {
  return (
    hasArtifactMap(app) &&
    app.artifacts.some((e) => e.platform === "macos" && e.format === "dmg")
  );
}

/**
 * The "ships DMGs" predicate — the gate on every Sparkle check — shared by release health and
 * the console's setup state so the two cannot drift. Decided from EVIDENCE, never from a missing
 * policy:
 *
 *   - the policy explicitly requires a DMG (`requireDmg: true`); or
 *   - the product declares an artifact map and it names a macOS `dmg` build (the map is the
 *     declaration, so an undeclared `.dmg` upload does not count); or
 *   - it declares no map and its latest release carries a `.dmg`.
 *
 * Anything else — a Linux-only product with no policy, say — ships no DMGs, has no appcast to
 * sign, and gets no Sparkle key or signature checks. A stored `requireDmg: false` does not
 * override the evidence above: the manifest normaliser writes `false` for every policy block
 * that merely omits the field, so it cannot be told apart from "unstated".
 */
export function shipsDmgs(evidence: {
  policyJson: string | null | undefined;
  app: ManifestAppDeliverable | null | undefined;
  latestReleaseHasDmg: boolean;
}): boolean {
  if (policyRequiresDmg(evidence.policyJson)) return true;
  if (hasArtifactMap(evidence.app)) return mapDeclaresDmg(evidence.app);
  return evidence.latestReleaseHasDmg;
}

/**
 * The release surfaces, as the access classification names them.
 *
 * Still one union after the split, because it is what the SHARED gateway keys on: which lane
 * the rate limiter charges, whether the edge cache may hold the answer, and which of the two
 * access modes governs. Through the gateway today: Release's `changelog` and Update's
 * `appcast`/`channelAppcast`/`version`. `install`, `cli`, `dmg`, `build`, `file` and `blob` are
 * Distribution's routes since P2b-04; they stay in the union because `entitledSelectorFor` (behind
 * `releaseCatalog.accessSelector`) classifies their selectors.
 */
export type ReleaseKind =
  | "appcast"
  | "channelAppcast"
  | "cli"
  | "dmg"
  | "version"
  | "changelog"
  | "install"
  /** P2-05's three byte routes: a declared build, an exact file, a content-addressed blob. */
  | "build"
  | "file"
  | "blob"
  /** P3-03: the signed channel feed (`/update/{channel}/feed.jws`) and the release record
   *  (`/release/records/{sha256}`). Both are metadata: a client that may read a feed must be
   *  able to fetch every record it pins. */
  | "feed"
  | "record"
  /** P3-09: the app-updater feeds (`/update/{channel}/winsparkle.xml`, `…/velopack/…`,
   *  `…/app.appinstaller`, `…/{buildId}.AppImage.zsync`). Artifacts-governed, like the appcast:
   *  each one tells an updater where to download the app. */
  | "winsparkle"
  | "velopack"
  | "appinstaller"
  | "zsync";

/** Which access mode governs a surface: metadata for the informational reads, else artifacts. */
export function accessModeFor(
  policy: ArtifactPolicy,
  kind: ReleaseKind,
): ReleaseAccess {
  return kind === "version" ||
    kind === "changelog" ||
    kind === "install" ||
    kind === "feed" ||
    kind === "record"
    ? policy.access.metadata
    : policy.access.artifacts;
}

/**
 * The operator-only artifact policy (`operator_policy_json`) after a patch, as the object to store
 * (`null` when nothing is left). `undefined` leaves a key alone; `minimumSystemVersion: null`
 * removes it. The caller validates the values (`MINIMUM_SYSTEM_VERSION_RE`, a boolean for the
 * signature flag). Keys the stored object already carries are preserved, and an unreadable stored
 * value is replaced — the reader treats it as the defaults already, so nothing an operator could
 * see is lost.
 *
 * There is no ownership marker because there is no second writer: this column has no manifest
 * spelling at all, so it is operator-owned by construction. ST-04: the write is the registry
 * setting `update.operatorPolicy` through `writeSetting()` (the column adapter is in
 * `settingsColumns.ts`), as is the METADATA access mode (`update.metadataAccess`, claimed through
 * `access_source`; the artifacts mode moved to Distribution's `dist_access` in P2b-04).
 */
export function mergeOperatorPolicy(
  storedJson: string | null | undefined,
  patch: {
    requireSparkleSignature?: boolean;
    minimumSystemVersion?: string | null;
  },
): Record<string, unknown> | null {
  let current: Record<string, unknown> = {};
  if (storedJson) {
    try {
      const parsed: unknown = JSON.parse(storedJson);
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
  return Object.keys(current).length > 0 ? current : null;
}
