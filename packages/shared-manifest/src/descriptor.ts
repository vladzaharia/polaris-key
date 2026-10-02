/**
 * The release descriptor (P2-04, README §3.4): the UNSIGNED body of the future release record —
 * one release of one deliverable, its builds, every build's files with their sizes and SHA-256s,
 * and where those bytes live. CI produces it (P2-06), and it reaches the Worker either attached
 * to a GitHub release as `pkey-release.json` or through P2-02's submit route. Either way it is
 * ingested once per release.
 *
 * Field names line up with README §3.3's release record so P3-01 can make this the signed
 * payload by MOVING it, not reshaping it. It lives here and not in `@polaris-key/protocol`
 * because it is a CI → Worker body rather than a device-facing document, and because validating
 * it needs the parsed manifest's artifact map; P3-01 decides whether the signed record moves.
 *
 * `validateReleaseDescriptor` is authoritative; `schemas/v1/release-descriptor.schema.json`
 * mirrors its structural half, and `test/schema-parity.test.ts` keeps the two honest (every code
 * below has a mutation-table entry). The cross-checks against the manifest are validator-only.
 *
 * The cross-checks the WORKER adds on top (they need D1, the blob store or GitHub): the release
 * does not already exist with different content, `seq` is monotonic, an `r2` key is stored and
 * this product holds or just earned a ref to it, and a `github` location names an asset of an
 * immutable release with the same digest.
 *
 * NOTE: this module imports from `./index.js`, which re-exports it. Nothing at this module's top
 * level may READ an import (the cycle leaves them uninitialised at that point); functions only.
 */

import {
  ANDROID_ABIS,
  APP_DELIVERABLE_ID,
  ARTIFACT_ROLES,
  BUILT_IN_CHANNELS,
  isCanonicalChannelName,
  matchesArtifactGlob,
  RELEASE_ARCHES,
  RELEASE_PLATFORMS,
  type ArtifactRole,
  type ManifestAppDeliverable,
  type ReleaseArch,
  type ReleasePlatform,
  type ValidationMessage,
} from "./index.js";
import {
  BUILD_ID_PATTERN,
  type ReleaseRecordBuild,
  type ReleaseRecordDoc,
} from "@polaris-key/protocol/release";

/** The one descriptor version this code reads. */
export const DESCRIPTOR_VERSION = 1;
/** The GitHub release asset a descriptor is attached as. */
export const DESCRIPTOR_ASSET_NAME = "pkey-release.json";
/** The largest descriptor accepted, serialised (the GitHub asset read is capped at the same). */
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;
/** Where an artifact's bytes may live. Every location is pinned by the artifact's SHA-256. */
export const LOCATION_PROVIDERS = [
  "r2",
  "github",
  "store",
  "external",
] as const;
export type LocationProvider = (typeof LOCATION_PROVIDERS)[number];

export const MAX_DESCRIPTOR_BUILDS = 64;
export const MAX_BUILD_ARTIFACTS = 32;
export const MAX_ARTIFACT_LOCATIONS = 8;

export type DescriptorLocation =
  /** A content-addressed blob-store key: `blobs/sha256/<sha256>` (or under `gated/`). */
  | { provider: "r2"; key: string }
  /** An asset of the release's GitHub tag, by name (the artifact's own name). */
  | { provider: "github"; asset: string }
  /** Published to a store; the bytes are not ours to serve, so the location carries none. */
  | { provider: "store" }
  /** Anywhere else, over https. */
  | { provider: "external"; url: string };

export interface DescriptorArtifact {
  /** The file name, unique within the release. */
  name: string;
  role: ArtifactRole;
  /** Lower-case hex SHA-256 of the whole file. */
  sha256: string;
  size: number;
  /** What the uploader says it is. Recorded, never served as-is (R6-04). */
  contentType?: string;
  /**
   * A `delta` artifact only (P3-09): the build number (Sparkle's `sparkle:version`, else the
   * version) of the release this delta updates FROM — what the Sparkle appcast renders as
   * `sparkle:deltaFrom`. Not part of the release record (§2.4 maps artifacts without it); an
   * updater checks a delta against its own signature or hash, never against this value.
   */
  deltaFrom?: string;
  locations: DescriptorLocation[];
}

export interface DescriptorBuild {
  /** An `artifacts` map entry id of the deliverable. */
  id: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  format: string;
  buildNumber?: string;
  minOS?: string;
  requires?: Record<string, unknown>;
  /**
   * What `pkey release publish` read out of the payload (P2b-05): the storefront feeds' facts,
   * extracted in CI because the Worker never unzips an archive. Only `ios` and `android` builds
   * carry it, each in its platform's shape.
   */
  metadata?: IosBuildMetadata | AndroidBuildMetadata;
  /** Empty for a store-only build, which still records its version and build number. */
  artifacts: DescriptorArtifact[];
}

/** An IPA's facts (its `Info.plist` and the main executable's entitlements). */
export interface IosBuildMetadata {
  /** `CFBundleIdentifier`. */
  bundleIdentifier: string;
  /** `CFBundleShortVersionString`. */
  version: string;
  /** `CFBundleVersion`. */
  buildVersion: string;
  /** `MinimumOSVersion`. */
  minOSVersion?: string;
  /** What AltStore checks the IPA against: the entitlement keys and the `*UsageDescription`s. */
  appPermissions: {
    entitlements: string[];
    privacy: Record<string, string>;
  };
}

/** An APK's facts (its binary manifest, its native libraries and its signing certificate). */
export interface AndroidBuildMetadata {
  packageName: string;
  versionCode: number;
  versionName: string;
  minSdk?: number;
  /** `targetSdkVersion`; an F-Droid index states `usesSdk` only when both SDKs are known. */
  targetSdk?: number;
  /** ABIs under `lib/`; empty or absent for a pure-JVM APK. */
  nativecode?: string[];
  /** Lower-case hex SHA-256 of the signing certificate (DER). */
  signerSha256: string;
}

/** The platforms whose builds may carry `metadata`. */
export const BUILD_METADATA_PLATFORMS = ["ios", "android"] as const;
const MAX_ENTITLEMENTS = 256;
const MAX_PRIVACY_KEYS = 64;
const MAX_PRIVACY_TEXT = 1000;
const ENTITLEMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const PRIVACY_KEY_RE = /^NS[A-Za-z0-9]{1,100}UsageDescription$/;
const META_BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const META_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const VERSION_NAME_RE = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const MAX_VERSION_CODE = 2100000000;

/**
 * What is wrong with a build's `metadata`, or `null`. The shape follows the build's platform;
 * any other platform carries none.
 */
function buildMetadataProblem(platform: unknown, m: unknown): string | null {
  if (platform !== "ios" && platform !== "android")
    return "only ios and android builds carry metadata";
  if (!isRecord(m)) return "metadata must be an object";
  const allowed =
    platform === "ios"
      ? [
          "bundleIdentifier",
          "version",
          "buildVersion",
          "minOSVersion",
          "appPermissions",
        ]
      : [
          "packageName",
          "versionCode",
          "versionName",
          "minSdk",
          "targetSdk",
          "nativecode",
          "signerSha256",
        ];
  const extra = Object.keys(m).find((k) => !allowed.includes(k));
  if (extra) return `${extra} is not a ${platform} metadata field`;
  if (platform === "ios") {
    if (
      typeof m.bundleIdentifier !== "string" ||
      m.bundleIdentifier.length > 155 ||
      !META_BUNDLE_ID_RE.test(m.bundleIdentifier)
    )
      return "bundleIdentifier must be a reverse-DNS bundle id";
    for (const f of ["version", "buildVersion"] as const)
      if (typeof m[f] !== "string" || !VERSION_RE.test(m[f] as string))
        return `${f} must be 1-64 version characters`;
    if (
      m.minOSVersion !== undefined &&
      (typeof m.minOSVersion !== "string" || !MIN_OS_RE.test(m.minOSVersion))
    )
      return "minOSVersion must be at most 32 version characters";
    const p = m.appPermissions;
    if (
      !isRecord(p) ||
      Object.keys(p).some((k) => k !== "entitlements" && k !== "privacy")
    )
      return "appPermissions must be { entitlements, privacy }";
    const ents = p.entitlements;
    if (
      !Array.isArray(ents) ||
      ents.length > MAX_ENTITLEMENTS ||
      new Set(ents).size !== ents.length ||
      !ents.every((e) => typeof e === "string" && ENTITLEMENT_RE.test(e))
    )
      return `appPermissions.entitlements must be at most ${MAX_ENTITLEMENTS} distinct entitlement keys`;
    const priv = p.privacy;
    if (
      !isRecord(priv) ||
      Object.keys(priv).length > MAX_PRIVACY_KEYS ||
      !Object.entries(priv).every(
        ([k, v]) =>
          PRIVACY_KEY_RE.test(k) &&
          typeof v === "string" &&
          codePoints(v) <= MAX_PRIVACY_TEXT &&
          !v.includes("\u0000"),
      )
    )
      return `appPermissions.privacy must map at most ${MAX_PRIVACY_KEYS} NS…UsageDescription keys to text`;
    return null;
  }
  if (
    typeof m.packageName !== "string" ||
    m.packageName.length > 255 ||
    !META_PACKAGE_RE.test(m.packageName)
  )
    return "packageName must be an Android package name";
  if (
    !Number.isSafeInteger(m.versionCode) ||
    (m.versionCode as number) < 1 ||
    (m.versionCode as number) > MAX_VERSION_CODE
  )
    return `versionCode must be an integer from 1 to ${MAX_VERSION_CODE}`;
  if (typeof m.versionName !== "string" || !VERSION_NAME_RE.test(m.versionName))
    return "versionName must be 1-128 characters with no control characters";
  if (
    m.minSdk !== undefined &&
    !(
      Number.isSafeInteger(m.minSdk) &&
      (m.minSdk as number) >= 1 &&
      (m.minSdk as number) <= 1000
    )
  )
    return "minSdk must be an integer from 1 to 1000";
  if (
    m.targetSdk !== undefined &&
    !(
      Number.isSafeInteger(m.targetSdk) &&
      (m.targetSdk as number) >= 1 &&
      (m.targetSdk as number) <= 1000
    )
  )
    return "targetSdk must be an integer from 1 to 1000";
  const abis: readonly string[] = ANDROID_ABIS;
  if (
    m.nativecode !== undefined &&
    (!Array.isArray(m.nativecode) ||
      new Set(m.nativecode).size !== m.nativecode.length ||
      !m.nativecode.every((a) => typeof a === "string" && abis.includes(a)))
  )
    return `nativecode must be distinct ABIs from ${ANDROID_ABIS.join(", ")}`;
  if (typeof m.signerSha256 !== "string" || !SHA256_RE.test(m.signerSha256))
    return "signerSha256 must be 64 lower-case hex characters";
  return null;
}

export interface ReleaseDescriptor {
  descriptorVersion: 1;
  product: string;
  deliverable: string;
  kind: "app";
  version: string;
  /** Publication order within the deliverable; assigned by the Worker when absent. */
  seq?: number;
  /** The git tag; also the release id. Without one the id is `<deliverable>@<version>`. */
  tag?: string;
  /** The canonical channel this release is published to. */
  channel?: string;
  title?: string;
  notes?: string;
  /** RFC 3339. */
  publishedAt?: string;
  provenance?: { commit?: string; workflowRun?: string };
  builds: DescriptorBuild[];
}

/** What a descriptor is checked against: the parsed manifest, or the persisted equivalent. */
export interface DescriptorManifest {
  product?: { slug: string };
  release?: {
    app: ManifestAppDeliverable | null;
    manualChannels?: readonly { name: string }[];
  };
}

export type DescriptorError = Omit<ValidationMessage, "file">;

export type DescriptorValidation =
  | { ok: true; descriptor: ReleaseDescriptor; releaseId: string }
  | { ok: false; errors: DescriptorError[] };

/** The release id a descriptor names: its tag, else `<deliverable>@<version>` (P2-03). */
export function descriptorReleaseId(
  d: Pick<ReleaseDescriptor, "tag" | "deliverable" | "version">,
): string {
  return d.tag ?? `${d.deliverable}@${d.version}`;
}

/** The content-addressed blob-store key an `r2` location must name (P2-01's layout). */
export function isContentAddressedKey(key: string, sha256: string): boolean {
  return (
    key === `blobs/sha256/${sha256}` || key === `gated/blobs/sha256/${sha256}`
  );
}

/**
 * A stable serialisation (object keys sorted, recursively) — what the Worker hashes to tell "the
 * same descriptor again" from a different one, independent of key order or whitespace.
 */
export function canonicalDescriptorJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalDescriptorJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalDescriptorJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── From the descriptor to the release record (P3-03, WIRE-CONTRACT-V4 §2.4) ─

/** What the record carries that the descriptor does not: the release's `seq` (from the upload
 *  answer), the signing time, and the optional `--min-supported-seq`. */
export interface RecordFields {
  seq: number;
  issuedAt: number;
  minSupportedSeq?: number;
}

/**
 * The `pkey-release+jws` payload a descriptor MOVES into (plans/P3-01.md §2.4): `product` becomes
 * `aud`, `descriptorVersion` becomes `schemaVersion: 1`, `publishedAt` and every artifact's
 * `locations` are dropped (locations change after signing), a build's `metadata` is dropped (CI's
 * unsigned claim for the storefront feeds, P2b-05; the record's build shape has no such field),
 * and everything else moves unchanged.
 * An optional field the descriptor omits stays absent, and a store-only build keeps
 * `artifacts: []`. The CLI signs exactly this object (`pkey release publish`), and the Worker's
 * ingest refuses a record that is not this object for the descriptor it arrived with
 * (`release_record_rejected`, reason `descriptor-mismatch`).
 */
export function descriptorToRecord(
  d: ReleaseDescriptor,
  fields: RecordFields,
): ReleaseRecordDoc {
  const record: ReleaseRecordDoc = {
    schemaVersion: 1,
    aud: d.product,
    deliverable: d.deliverable,
    kind: d.kind,
    version: d.version,
    seq: fields.seq,
    issuedAt: fields.issuedAt,
  };
  if (fields.minSupportedSeq !== undefined)
    record.minSupportedSeq = fields.minSupportedSeq;
  if (d.tag !== undefined) record.tag = d.tag;
  if (d.channel !== undefined) record.channel = d.channel;
  if (d.title !== undefined) record.title = d.title;
  if (d.notes !== undefined) record.notes = d.notes;
  if (d.provenance !== undefined) {
    const provenance: { commit?: string; workflowRun?: string } = {};
    if (d.provenance.commit !== undefined)
      provenance.commit = d.provenance.commit;
    if (d.provenance.workflowRun !== undefined)
      provenance.workflowRun = d.provenance.workflowRun;
    record.provenance = provenance;
  }
  record.builds = d.builds.map((b) => {
    const build: ReleaseRecordBuild = {
      id: b.id,
      platform: b.platform,
      arch: b.arch,
      format: b.format,
      artifacts: b.artifacts.map((a) => ({
        name: a.name,
        role: a.role,
        sha256: a.sha256,
        size: a.size,
        ...(a.contentType !== undefined ? { contentType: a.contentType } : {}),
      })),
    };
    if (b.buildNumber !== undefined) build.buildNumber = b.buildNumber;
    if (b.minOS !== undefined) build.minOS = b.minOS;
    if (b.requires !== undefined) build.requires = b.requires;
    return build;
  });
  return record;
}

// ── Field rules (mirrored as patterns in release-descriptor.schema.json) ─────

const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const DELIVERABLE_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FOUR_PART_RE = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/;
const TAG_RE = /^[^\u0000-\u0020\u007f]{1,255}$/u;
/** The record's build-id rule (WIRE-CONTRACT-V4 §2.4), one source for both. */
const BUILD_ID_RE = BUILD_ID_PATTERN;
const FORMAT_RE = /^[a-z0-9][a-z0-9.+-]{0,31}$/;
const BUILD_NUMBER_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MIN_OS_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const NAME_RE = /^[^/\\\u0000-\u001f\u007f]{1,255}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const KEY_SHAPE_RE = /^(gated\/)?blobs\/sha256\/[0-9a-f]{64}$/;
const HTTPS_URL_RE = /^https:\/\/[^\s\u0000-\u001f\u007f]{1,2040}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TITLE = 200;
const MAX_NOTES = 20000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function codePoints(s: string): number {
  return [...s].length;
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || !HTTPS_URL_RE.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Does `version` parse under the deliverable's version scheme? */
function versionFitsScheme(
  version: string,
  scheme: ManifestAppDeliverable["versioning"]["scheme"],
): boolean {
  return scheme === "4part"
    ? FOUR_PART_RE.test(version)
    : SEMVER_RE.test(version);
}

/**
 * Check a descriptor's shape, then cross-check it against the manifest's declaration of its
 * deliverable. Returns the descriptor (typed) and its release id, or every problem found.
 *
 * The cross-checks (README §3.4 "declared, not sniffed"): the product is this product; the
 * deliverable is declared (only `app`, kind `app`, until P4-02); every build id is an `artifacts`
 * entry with the same platform, arch and format; the file playing the entry's role matches its
 * `match`; roles come from `ARTIFACT_ROLES`; names are unique within the release; an `r2` key is
 * the content address of that file's SHA-256; a `github` location names the artifact itself; a
 * `store` location carries no bytes; an `external` URL is https; the channel is canonical and
 * declared; the version fits the scheme, and a tag spells that version.
 */
export function validateReleaseDescriptor(
  descriptor: unknown,
  manifest: DescriptorManifest,
): DescriptorValidation {
  const errors: DescriptorError[] = [];
  const err = (path: string, code: string, message: string) =>
    errors.push({ path, code, message });

  if (!isRecord(descriptor)) {
    err(
      "/",
      "invalid_descriptor",
      "A release descriptor must be a JSON object.",
    );
    return { ok: false, errors };
  }
  const d = descriptor;
  if (d.descriptorVersion !== DESCRIPTOR_VERSION) {
    err(
      "/descriptorVersion",
      "unsupported_descriptor_version",
      `descriptorVersion must be ${DESCRIPTOR_VERSION}.`,
    );
    return { ok: false, errors };
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(d);
  } catch {
    // A cycle or a BigInt: not JSON, so not a descriptor.
  }
  if (
    !serialized ||
    new TextEncoder().encode(serialized).length > MAX_DESCRIPTOR_BYTES
  ) {
    err(
      "/",
      "invalid_descriptor",
      `A release descriptor must serialise to JSON of at most ${MAX_DESCRIPTOR_BYTES} bytes.`,
    );
    return { ok: false, errors };
  }

  // ── Identity ──
  if (typeof d.product !== "string" || !SLUG_RE.test(d.product))
    err("/product", "invalid_descriptor", "product must be a product slug.");
  if (
    typeof d.deliverable !== "string" ||
    d.deliverable.length > 64 ||
    !DELIVERABLE_RE.test(d.deliverable)
  )
    err(
      "/deliverable",
      "invalid_descriptor",
      "deliverable must be a deliverable id.",
    );
  if (d.kind === "pack")
    err(
      "/kind",
      "unsupported_deliverable_kind",
      "pack releases are not supported yet (P4-02); kind must be app.",
    );
  else if (d.kind !== "app")
    err("/kind", "invalid_descriptor", "kind must be app.");
  if (typeof d.version !== "string" || !VERSION_RE.test(d.version))
    err(
      "/version",
      "invalid_descriptor",
      "version must be 1-64 characters of letters, digits, '.', '+' and '-'.",
    );
  if (
    !Array.isArray(d.builds) ||
    d.builds.length === 0 ||
    d.builds.length > MAX_DESCRIPTOR_BUILDS
  )
    err(
      "/builds",
      "invalid_descriptor",
      `builds must be an array of 1 to ${MAX_DESCRIPTOR_BUILDS} builds.`,
    );

  // ── Optional fields ──
  if (
    d.seq !== undefined &&
    !(Number.isSafeInteger(d.seq) && (d.seq as number) > 0)
  )
    err("/seq", "invalid_descriptor_field", "seq must be a positive integer.");
  if (d.tag !== undefined && (typeof d.tag !== "string" || !TAG_RE.test(d.tag)))
    err(
      "/tag",
      "invalid_descriptor_field",
      "tag must be 1-255 characters with no spaces or control characters.",
    );
  if (d.channel !== undefined && !isCanonicalChannelName(d.channel))
    err(
      "/channel",
      "invalid_descriptor_field",
      "channel must be a canonical channel name (lower-case, digits and '-'; not an alias).",
    );
  if (
    d.title !== undefined &&
    (typeof d.title !== "string" ||
      codePoints(d.title) > MAX_TITLE ||
      CONTROL_RE.test(d.title))
  )
    err(
      "/title",
      "invalid_descriptor_field",
      `title must be at most ${MAX_TITLE} characters with no control characters.`,
    );
  if (
    d.notes !== undefined &&
    (typeof d.notes !== "string" ||
      codePoints(d.notes) > MAX_NOTES ||
      d.notes.includes("\u0000"))
  )
    err(
      "/notes",
      "invalid_descriptor_field",
      `notes must be at most ${MAX_NOTES} characters.`,
    );
  if (
    d.publishedAt !== undefined &&
    (typeof d.publishedAt !== "string" ||
      !RFC3339_RE.test(d.publishedAt) ||
      !Number.isFinite(Date.parse(d.publishedAt)))
  )
    err(
      "/publishedAt",
      "invalid_descriptor_field",
      "publishedAt must be an RFC 3339 timestamp.",
    );
  if (d.provenance !== undefined) {
    const p = d.provenance;
    if (
      !isRecord(p) ||
      (p.commit !== undefined &&
        (typeof p.commit !== "string" || !COMMIT_RE.test(p.commit))) ||
      (p.workflowRun !== undefined && !isHttpsUrl(p.workflowRun))
    )
      err(
        "/provenance",
        "invalid_descriptor_field",
        "provenance is { commit?: a 40- or 64-hex commit, workflowRun?: an https URL }.",
      );
  }

  // ── Builds and artifacts (shape) ──
  const builds = Array.isArray(d.builds)
    ? d.builds.slice(0, MAX_DESCRIPTOR_BUILDS)
    : [];
  const buildIds = new Set<string>();
  const names = new Set<string>();
  for (const [bi, b] of builds.entries()) {
    if (!isRecord(b)) {
      err(
        `/builds/${bi}`,
        "invalid_descriptor_build",
        "each build must be an object.",
      );
      continue;
    }
    if (typeof b.id !== "string" || !BUILD_ID_RE.test(b.id))
      err(
        `/builds/${bi}/id`,
        "invalid_descriptor_build",
        `build id must match ${BUILD_ID_RE.source}.`,
      );
    else if (buildIds.has(b.id))
      err(
        `/builds/${bi}/id`,
        "duplicate_build_id",
        `build ${b.id} appears twice.`,
      );
    else buildIds.add(b.id);
    if (!oneOf(RELEASE_PLATFORMS, b.platform))
      err(
        `/builds/${bi}/platform`,
        "invalid_descriptor_build",
        `platform must be one of ${RELEASE_PLATFORMS.join(", ")}.`,
      );
    if (!oneOf(RELEASE_ARCHES, b.arch))
      err(
        `/builds/${bi}/arch`,
        "invalid_descriptor_build",
        `arch must be one of ${RELEASE_ARCHES.join(", ")}.`,
      );
    if (typeof b.format !== "string" || !FORMAT_RE.test(b.format))
      err(
        `/builds/${bi}/format`,
        "invalid_descriptor_build",
        `format must match ${FORMAT_RE.source}.`,
      );
    if (
      b.buildNumber !== undefined &&
      (typeof b.buildNumber !== "string" ||
        !BUILD_NUMBER_RE.test(b.buildNumber))
    )
      err(
        `/builds/${bi}/buildNumber`,
        "invalid_descriptor_build",
        "buildNumber must be a string of at most 64 version characters.",
      );
    if (
      b.minOS !== undefined &&
      (typeof b.minOS !== "string" || !MIN_OS_RE.test(b.minOS))
    )
      err(
        `/builds/${bi}/minOS`,
        "invalid_descriptor_build",
        "minOS must be a string of at most 32 version characters.",
      );
    if (b.requires !== undefined && !isRecord(b.requires))
      err(
        `/builds/${bi}/requires`,
        "invalid_descriptor_build",
        "requires must be an object.",
      );
    if (b.metadata !== undefined) {
      const problem = buildMetadataProblem(b.platform, b.metadata);
      if (problem)
        err(`/builds/${bi}/metadata`, "invalid_build_metadata", `${problem}.`);
    }
    if (
      !Array.isArray(b.artifacts) ||
      b.artifacts.length > MAX_BUILD_ARTIFACTS
    ) {
      err(
        `/builds/${bi}/artifacts`,
        "invalid_descriptor_build",
        `artifacts must be an array of at most ${MAX_BUILD_ARTIFACTS} files (empty for a store-only build).`,
      );
      continue;
    }
    for (const [ai, a] of b.artifacts.entries()) {
      if (!isRecord(a)) {
        err(
          `/builds/${bi}/artifacts/${ai}`,
          "invalid_descriptor_artifact",
          "each artifact must be an object.",
        );
        continue;
      }
      if (typeof a.name !== "string" || !NAME_RE.test(a.name))
        err(
          `/builds/${bi}/artifacts/${ai}/name`,
          "invalid_descriptor_artifact",
          "name must be a file name of 1-255 characters with no '/', '\\' or control characters.",
        );
      else if (names.has(a.name))
        err(
          `/builds/${bi}/artifacts/${ai}/name`,
          "duplicate_artifact_name",
          `${a.name} appears twice; names are unique within a release.`,
        );
      else names.add(a.name);
      if (!oneOf(ARTIFACT_ROLES, a.role))
        err(
          `/builds/${bi}/artifacts/${ai}/role`,
          "invalid_descriptor_artifact",
          `role must be one of ${ARTIFACT_ROLES.join(", ")}.`,
        );
      const sha =
        typeof a.sha256 === "string" && SHA256_RE.test(a.sha256)
          ? a.sha256
          : null;
      if (!sha)
        err(
          `/builds/${bi}/artifacts/${ai}/sha256`,
          "invalid_descriptor_artifact",
          "sha256 must be 64 lower-case hex characters.",
        );
      if (!(Number.isSafeInteger(a.size) && (a.size as number) >= 0))
        err(
          `/builds/${bi}/artifacts/${ai}/size`,
          "invalid_descriptor_artifact",
          "size must be a non-negative integer.",
        );
      if (
        a.contentType !== undefined &&
        (typeof a.contentType !== "string" ||
          a.contentType.length > 127 ||
          !CONTENT_TYPE_RE.test(a.contentType))
      )
        err(
          `/builds/${bi}/artifacts/${ai}/contentType`,
          "invalid_descriptor_artifact",
          "contentType must be a lower-case type/subtype.",
        );
      if (a.deltaFrom !== undefined) {
        if (a.role !== "delta")
          err(
            `/builds/${bi}/artifacts/${ai}/deltaFrom`,
            "invalid_delta_from",
            "deltaFrom applies only to an artifact whose role is delta.",
          );
        else if (
          typeof a.deltaFrom !== "string" ||
          !BUILD_NUMBER_RE.test(a.deltaFrom)
        )
          err(
            `/builds/${bi}/artifacts/${ai}/deltaFrom`,
            "invalid_delta_from",
            "deltaFrom must be 1-64 version characters: the build number the delta updates from.",
          );
      }
      if (
        !Array.isArray(a.locations) ||
        a.locations.length === 0 ||
        a.locations.length > MAX_ARTIFACT_LOCATIONS
      ) {
        err(
          `/builds/${bi}/artifacts/${ai}/locations`,
          "invalid_descriptor_artifact",
          `locations must be an array of 1 to ${MAX_ARTIFACT_LOCATIONS} locations.`,
        );
        continue;
      }
      for (const [li, loc] of a.locations.entries()) {
        if (!isRecord(loc) || !oneOf(LOCATION_PROVIDERS, loc.provider)) {
          err(
            `/builds/${bi}/artifacts/${ai}/locations/${li}`,
            "invalid_artifact_location",
            `a location's provider must be one of ${LOCATION_PROVIDERS.join(", ")}.`,
          );
          continue;
        }
        switch (loc.provider) {
          case "r2":
            if (typeof loc.key !== "string" || !KEY_SHAPE_RE.test(loc.key))
              err(
                `/builds/${bi}/artifacts/${ai}/locations/${li}/key`,
                "r2_key_not_content_addressed",
                "an r2 key must be blobs/sha256/<sha256> (or gated/blobs/sha256/<sha256>).",
              );
            else if (sha && !isContentAddressedKey(loc.key, sha))
              err(
                `/builds/${bi}/artifacts/${ai}/locations/${li}/key`,
                "r2_key_not_content_addressed",
                "an r2 key must be named by this artifact's own sha256.",
              );
            break;
          case "github":
            if (typeof loc.asset !== "string" || !NAME_RE.test(loc.asset))
              err(
                `/builds/${bi}/artifacts/${ai}/locations/${li}/asset`,
                "invalid_artifact_location",
                "a github location names a release asset.",
              );
            else if (loc.asset !== a.name)
              err(
                `/builds/${bi}/artifacts/${ai}/locations/${li}/asset`,
                "invalid_artifact_location",
                "a github location names the artifact itself (asset equals name).",
              );
            break;
          case "store":
            if (
              loc.key !== undefined ||
              loc.asset !== undefined ||
              loc.url !== undefined
            )
              err(
                `/builds/${bi}/artifacts/${ai}/locations/${li}`,
                "invalid_artifact_location",
                "a store location carries no bytes: no key, asset or url.",
              );
            break;
          case "external":
            if (!isHttpsUrl(loc.url))
              err(
                `/builds/${bi}/artifacts/${ai}/locations/${li}/url`,
                "invalid_artifact_location",
                "an external location's url must be https:// without credentials.",
              );
            break;
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // ── Cross-checks against the manifest (validator-only) ──
  const desc = d as unknown as ReleaseDescriptor;
  const slug = manifest.product?.slug;
  if (slug !== undefined && desc.product !== slug)
    err(
      "/product",
      "product_mismatch",
      `this descriptor is for ${desc.product}, not ${slug}.`,
    );
  const app = manifest.release?.app ?? null;
  if (!app) {
    err(
      "/deliverable",
      "unknown_deliverable",
      "the product declares no deliverables.app with an artifacts map in .pkey/release.",
    );
    return { ok: false, errors };
  }
  if (desc.deliverable !== APP_DELIVERABLE_ID) {
    err(
      "/deliverable",
      "unknown_deliverable",
      `${desc.deliverable} is not a deliverable this product declares.`,
    );
    return { ok: false, errors };
  }
  if (!versionFitsScheme(desc.version, app.versioning.scheme))
    err(
      "/version",
      "invalid_version_for_scheme",
      `version ${desc.version} does not parse under the ${app.versioning.scheme} scheme.`,
    );
  if (desc.tag !== undefined && desc.tag.replace(/^v/, "") !== desc.version)
    err(
      "/tag",
      "tag_version_mismatch",
      `tag ${desc.tag} does not spell version ${desc.version} (the tag minus a leading v must equal it).`,
    );
  if (desc.channel !== undefined) {
    const known = new Set<string>([
      ...BUILT_IN_CHANNELS,
      ...(manifest.release?.manualChannels ?? []).map((c) => c.name),
      ...Object.keys(app.channels),
    ]);
    if (!known.has(desc.channel))
      err(
        "/channel",
        "unknown_channel",
        `channel ${desc.channel} is not declared for this product.`,
      );
  }
  const entries = new Map(app.artifacts.map((e) => [e.id, e]));
  for (const [bi, b] of desc.builds.entries()) {
    const entry = entries.get(b.id);
    if (!entry) {
      err(
        `/builds/${bi}/id`,
        "undeclared_build",
        `build ${b.id} is not an entry of deliverables.app.artifacts.`,
      );
      continue;
    }
    for (const field of ["platform", "arch", "format"] as const) {
      if (b[field] !== entry[field])
        err(
          `/builds/${bi}/${field}`,
          "build_mismatch",
          `build ${b.id} declares ${field} ${entry[field]}, not ${b[field]}.`,
        );
    }
    if (b.artifacts.length === 0) continue; // a store-only build
    const declared = b.artifacts.filter((a) => a.role === entry.role);
    if (declared.length !== 1)
      err(
        `/builds/${bi}/artifacts`,
        "invalid_build_payload",
        `build ${b.id} must carry exactly one ${entry.role} file (it has ${declared.length}).`,
      );
    for (const [ai, a] of b.artifacts.entries()) {
      if (a.role === entry.role && !matchesArtifactGlob(entry.match, a.name))
        err(
          `/builds/${bi}/artifacts/${ai}/name`,
          "artifact_name_mismatch",
          `${a.name} does not match ${entry.match}, the declared name of build ${b.id}.`,
        );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, descriptor: desc, releaseId: descriptorReleaseId(desc) };
}
