// @polaris-key/protocol/release — Release service wire types (spec §A/D-13).

import type { AppContent } from "./packs.js";

/** Release surface visibility. `entitled` (v3, D-13) additionally enforces the caller's
 *  per-license channel entitlement + version window on feeds and artifacts — the
 *  per-product opt-in that closes the R3 "stable-only license fetches the beta appcast"
 *  gap without breaking public/anonymous update checking for products that want it. */
export type ReleaseAccess =
  | "public"
  | "authenticated"
  | "licensed"
  | "entitled";

export interface ReleaseAccessPolicy {
  metadata: ReleaseAccess;
  artifacts: ReleaseAccess;
}

export const DEFAULT_RELEASE_ACCESS: ReleaseAccessPolicy = {
  metadata: "public",
  artifacts: "public",
};

// ── The release record, `pkey-release+jws` (WIRE-CONTRACT-V4 §2.4) ─────────────────────────
//
// Signed in CI by a release key the app pins; the Worker never holds the private half and
// never signs one. It is P2-04's release descriptor moved into a signed payload, without the
// locations (they change after signing) and with `minSupportedSeq`. A feed pins a record by
// the lowercase hex SHA-256 of its exact compact JWS, checked before the signature.

/** A build id: ASCII, so uniqueness and the decision's tie-break compare bytes in every SDK.
 *  The release-descriptor validator imports it as its build-id rule. */
export const BUILD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The record kinds a P4 SDK acts on: `app`, `pack` (plans/P4-01.md §2.13, V4 §2.5.1),
 *  `revocation` (plans/P4-13.md §2.3, V4 §2.5.3) and `delegation` (plans/P4-19.md §2.2,
 *  V4 §2.5.4). */
export const RECORD_KINDS = [
  "app",
  "pack",
  "revocation",
  "delegation",
] as const;

/** Record kinds a client verifies and never acts on. Empty since P4-19 filled `delegation`'s
 *  slot; a v4 SDK that predates a kind still verifies such a record and never acts on it. */
export const RESERVED_RECORD_KINDS = [] as const;

/** The kid of a pack record signed by a delegated content key (plans/P4-19.md §2.2): `pkd1-`
 *  and the delegation's record hash. 69 bytes, longer than any declared release-key kid, so a
 *  release key can never collide with it; an SDK refuses a pinned release kid matching it. */
export const DELEGATED_KID_PATTERN = /^pkd1-[0-9a-f]{64}$/;

export interface ReleaseRecordArtifact {
  name: string;
  /** v4 reads only `payload`. */
  role: string;
  /** 64 lowercase hex. */
  sha256: string;
  size: number;
  contentType?: string;
}

export interface ReleaseRecordBuild {
  id: string;
  platform: string;
  arch: string;
  format: string;
  buildNumber?: string;
  minOS?: string;
  /** `engine` (a string) and `minBinary` (a version) are read by the decision; the rest is
   *  reserved for P4. */
  requires?: { [key: string]: unknown };
  /** Empty for a store-only build. */
  artifacts: ReleaseRecordArtifact[];
  /** The packs this build ships embedded (pack ids, unique; plans/P4-01.md §2.4). */
  embeds?: string[];
}

/** A `pkey-release+jws` payload. There is no `iss`: the pinned `kid` names the signer. */
export interface ReleaseRecordDoc {
  schemaVersion: 1;
  aud: string;
  deliverable: string;
  kind: string;
  version: string;
  seq: number;
  issuedAt: number;
  minSupportedSeq?: number;
  tag?: string;
  channel?: string;
  title?: string;
  notes?: string;
  provenance?: { commit?: string; workflowRun?: string };
  /** Required for `kind: "app"`; absent on `kind: "pack"`. */
  builds?: ReleaseRecordBuild[];
  /** An app record's packs: the content stamp moved into the record (plans/P4-01.md §2.4). */
  content?: AppContent;
}

/** A revocation's replacement: a pack record of the same deliverable (plans/P4-13.md §2.3). */
export interface RevocationReplacement {
  /** 64 lowercase hex, never equal to `revokes`. */
  sha256: string;
  seq: number;
  version: string;
}

/**
 * A `pkey-release+jws` payload with `kind: "revocation"` (plans/P4-13.md §2.3, V4 §2.5.3), signed
 * in CI by a release key and never by a product or delegated key. `deliverable`, `version` and
 * `seq` are the revoked pack record's, so the record names exactly what it revokes. Revocations
 * are permanent; a later one of the same target may change `replacement` (newest `issuedAt`
 * wins, `newerRevocation`).
 */
export interface RevocationRecordDoc {
  schemaVersion: 1;
  aud: string;
  /** A pack id: an app build is revoked by License's compatibility window, not by this. */
  deliverable: string;
  kind: "revocation";
  version: string;
  seq: number;
  issuedAt: number;
  /** The revoked pack record's hash, 64 lowercase hex. */
  revokes: string;
  replacement?: RevocationReplacement;
  /** 1–`REVOCATION_REASON_MAX_BYTES` bytes, display only. */
  reason: string;
  tag?: string;
  channel?: string;
  title?: string;
  notes?: string;
  provenance?: { commit?: string; workflowRun?: string };
}

/**
 * A `pkey-release+jws` payload with `kind: "delegation"` (plans/P4-19.md §2.2, V4 §2.5.4), signed
 * in CI by a pinned release key and never by a product or content key. It lets one content key
 * (`delegate.publicKey`) sign tree-layout pack records of the effective `types` under the pack-id
 * scope `deliverable` (whole segments), with `issuedAt` inside `[issuedAt, expiresAt]`. A pack
 * record signed under it carries the header kid `pkd1-<this record's hash>`.
 */
export interface DelegationRecordDoc {
  schemaVersion: 1;
  aud: string;
  /** The scope root: a pack id, never `app`. */
  deliverable: string;
  kind: "delegation";
  /** Display only; the CLI writes the decimal `seq`. */
  version: string;
  /** Per (product, deliverable), ≥ 1. */
  seq: number;
  /** The window opens. */
  issuedAt: number;
  /** The window closes; `issuedAt < expiresAt ≤ issuedAt + MAX_DELEGATION_TTL_SECONDS`. */
  expiresAt: number;
  /** The content key: base64url of its 32 raw Ed25519 bytes. */
  delegate: { publicKey: string };
  /** 1–`MAX_DELEGATION_TYPES` unique pack types; only those in `DELEGABLE_PACK_TYPES` count. */
  types: string[];
  tag?: string;
  channel?: string;
  title?: string;
  notes?: string;
  provenance?: { commit?: string; workflowRun?: string };
}
