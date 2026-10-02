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

/** The record kinds a P4 SDK acts on (plans/P4-01.md §2.13): `app`, and `pack` (§2.5.1). */
export const RECORD_KINDS = ["app", "pack"] as const;

/** Record kinds a client verifies and never acts on (P4-13, P4-19). `pack` left this list when
 *  packs v1 filled its slot (plans/P4-01.md); a v4 SDK that predates packs still verifies a
 *  pack record and never acts on it. */
export const RESERVED_RECORD_KINDS = ["revocation", "delegation"] as const;

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
