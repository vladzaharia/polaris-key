import { type ProductCatalog } from "@polaris-key/catalog";
import { type SecretDelivery } from "@polaris-key/protocol/config";
import { parse as parseYaml } from "yaml";

/**
 * What a `.pkey/product` `modules:` block may name.
 *
 * Two vocabularies, both accepted. The first five are the original module names; the last five
 * are the Polaris Key service slugs they became (design spec §2.1). Old manifests keep validating
 * unchanged — `normalizeModules` translates them — so nothing in the field has to be rewritten
 * on the same day the server learns the new words.
 */
export type ProductModule =
  // legacy module vocabulary
  | "licensing"
  | "releases"
  | "oidc"
  | "edgeMint"
  // Polaris Key service slugs
  | "license"
  | "config"
  | "release"
  | "update"
  | "identity";

/**
 * The five opt-in Polaris Key services (design spec §2.4/D-04). Declared here rather than imported
 * from the worker: this package is a *dependency* of the worker (and of the CLI), so the type
 * has to originate on this side of the arrow. The worker's `core/services.ts` declares the
 * structurally-identical pair for its own D1-facing use.
 */
export type ServiceSlug =
  | "license"
  | "config"
  | "release"
  | "update"
  | "identity";

/** Canonical order — iterate this rather than `Object.keys` so output is stable. */
export const SERVICE_SLUGS: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "update",
  "identity",
];

/** The enablement set a manifest declares, in the shape `products.services_json` stores. */
export type ManifestServices = Record<ServiceSlug, { enabled: boolean }>;

/** Who may register a device against this product (design spec §2.3). */
export const REGISTRATION_POLICIES = [
  "open",
  "requires-identity",
  "requires-license",
] as const;

/** The three policies as a type. Structurally identical to `@polaris-key/protocol/core`'s
 *  `RegistrationPolicy` and to the worker's; declared here for the same reason `ServiceSlug`
 *  is — this package is a dependency of both, so the name has to originate on this side. */
export type RegistrationPolicy = (typeof REGISTRATION_POLICIES)[number];

export interface ValidationMessage {
  file: "product" | "schema" | "release";
  path: string;
  code: string;
  message: string;
}

export interface ManifestDocuments {
  product: Record<string, unknown>;
  schema?: unknown;
  release?: unknown;
}

/** The documents ingest is handed: `product` is `undefined` when the file is missing. */
export interface IngestDocuments {
  product: Record<string, unknown> | undefined;
  schema?: unknown;
  release?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  /** The enabled set, always in SERVICE-SLUG vocabulary regardless of what the manifest wrote. */
  enabledModules: ServiceSlug[];
  requiredSecrets: string[];
}

export interface ManifestProduct {
  slug: string;
  name: string;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultDeviceLimit: number;
  adminGroup: string;
}

export interface ManifestOidc {
  provider: "platform" | "custom";
  issuer: string;
  clientId: string;
  clientSecretSecret: string;
  redirectUris: string[];
  groupRoleMap: Record<string, unknown>;
}

/** A product-declared companion-application probe the client answers present/absent. */
export interface ManifestProbe {
  id: string;
  label: string;
  macos?: string;
  windows?: string;
  linux?: string;
}

/** Per-product hardware-fingerprint policy (migrations/0010_fingerprint.sql). */
export interface ManifestFingerprint {
  /** Per-product opt-out. When false, clients are told not to collect hardware components. */
  enabled: boolean;
  /** Default enforcement strength; a tier's own policy overrides it. */
  defaultMode: "off" | "lenient" | "normal" | "strict";
  probes: ManifestProbe[];
}

/** Per-product auto-issue ("always free") policy (migrations/0011_auto_issue.sql). */
export interface ManifestAutoIssue {
  enabled: boolean;
  /** The tier an auto-issued license lands on. Required when enabled. */
  tierId: string | null;
  mode: "anonymous" | "oidcDefault" | "both";
  rateLimitPerHour: number;
}

export interface ManifestTier {
  id: string;
  label: string;
  profileId: string | null;
  policyExpiryDays: number | null;
  policyDeviceLimit: number | null;
  /** Fingerprint enforcement for this tier; null inherits the product default. */
  policyFingerprint: "off" | "lenient" | "normal" | "strict" | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
}

export interface ManifestProfile {
  id: string;
  name: string;
  description?: string | null;
  payload: Record<string, unknown>;
}

export interface ManifestProvisioning {
  claim: string;
  entitlementKey?: string;
  entitlementValue?: unknown;
  secretKey?: string;
  secretUrlTemplate?: string;
  allowedHosts?: string[];
}

/**
 * Repo-owned artifact expectations. `requireSparkleSignature` is deliberately NOT part of
 * this shape: signature enforcement is an operator-owned control and a repo must not be able
 * to disable the platform's own check by pushing one line of YAML (R6-03).
 */
export interface ManifestReleaseArtifactPolicy {
  channels: string[];
  architectures: string[];
  requireDmg: boolean;
  requireCli: boolean;
  allowAmbiguousAssets: boolean;
}

export type ManifestReleaseAccess = "public" | "authenticated" | "licensed";

export interface ManifestReleaseAccessPolicy {
  metadata: ManifestReleaseAccess;
  artifacts: ManifestReleaseAccess;
}

/** A named release channel beyond the built-in stable/beta, matched by tag regex. Persisted
 *  to `release_config.manual_channels_json` in exactly this shape — the worker's
 *  `parseManualChannels` reads it back. */
export interface ManifestManualChannel {
  name: string;
  regex: string;
}

export interface ManifestRelease {
  ghOwner: string;
  ghRepo: string;
  binaryName: string;
  channelWorkflow: string;
  betaBranch: string;
  summaryMarker: string;
  sparkleEd25519Pub: string;
  manualChannels: ManifestManualChannel[];
  /** `release.stableTagPattern` — which tags are real app releases (candidates for
   *  stable/latest and the beta prerelease fallback). `null` when undeclared, which means
   *  `DEFAULT_STABLE_TAG_PATTERN`. Persisted to `release_config.stable_tag_pattern`. */
  stableTagPattern: string | null;
  /** `release.ignoreTags` — exact tag names that are never a resolution candidate on any
   *  moving channel. Persisted to `release_config.ignore_tags_json` (NULL when empty). */
  ignoreTags: string[];
  artifactPolicy: ManifestReleaseArtifactPolicy | null;
  access: ManifestReleaseAccessPolicy;
  /**
   * `deliverables.app` (P2-04): the declared app deliverable. `null` when the document declares
   * no `deliverables` block — the implicit `app` deliverable, classified by legacy filename
   * sniffing. Its `versioning.stableTagPattern`/`ignoreTags` are NOT repeated here: they are
   * normalized into the two fields above, whichever spelling declared them.
   */
  app: ManifestAppDeliverable | null;
}

/** One `deliverables.app.artifacts[]` entry: a build, and the file name that is its payload. */
export interface ManifestArtifactEntry {
  /** The build id (`macos`, `win-zip`, …). */
  id: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  format: string;
  /** The role the matched file plays in its build; `payload` unless declared. */
  role: ArtifactRole;
  /** An anchored, case-sensitive glob over the file name (`*`, `?`). */
  match: string;
}

/** A channel the deliverable declares: the channels whose releases it also offers. */
export interface ManifestDeliverableChannel {
  includes: string[];
}

/** `deliverables.app` — the app deliverable's declaration, persisted as its `def_json`. */
export interface ManifestAppDeliverable {
  kind: "app";
  versioning: {
    scheme: VersionScheme;
    buildNumber: BuildNumberSource | null;
  };
  channels: Record<string, ManifestDeliverableChannel>;
  artifacts: ManifestArtifactEntry[];
}

/** The protocol's `SecretDelivery`, re-exported under the manifest's historical name — one
 *  source of truth for the three delivery modes (the audit's A6). */
export type ManifestSecretDelivery = SecretDelivery;

export type ManifestCatalogEntry = ProductCatalog["entries"][number] & {
  delivery?: ManifestSecretDelivery;
};

export type ManifestCatalog = Omit<ProductCatalog, "entries"> & {
  entries: ManifestCatalogEntry[];
};

export interface ManifestEdgeMint {
  id: string;
  alg: string;
  signingKeySecret: string;
  kid?: string;
  claimsTemplate: Record<string, unknown>;
  ttlSeconds: number;
  audience?: string | null;
}

export interface ParsedManifest {
  product: ManifestProduct;
  catalog: ManifestCatalog;
  oidc?: ManifestOidc;
  profiles: ManifestProfile[];
  tiers: ManifestTier[];
  provisioning: ManifestProvisioning[];
  fingerprint?: ManifestFingerprint;
  autoIssue?: ManifestAutoIssue;
  release?: ManifestRelease;
  edgeMint: ManifestEdgeMint[];
  /**
   * Which Polaris Key services this product runs (design spec §2.2). Always complete — every slug
   * is present with an explicit boolean — so a persist site can `JSON.stringify` it straight
   * into `products.services_json` without deciding anything of its own.
   *
   * This is the value the manifest used to validate and then throw away.
   */
  services: ManifestServices;
  /** `devices.registration` — who may register a device (§2.3). Undefined = undeclared; the
   *  default is derived from the enabled services at the point of use, not baked in here. */
  registration?: RegistrationPolicy;
  /**
   * `web.origins` — the exact browser origins allowed to read this product's device-facing
   * responses through CORS (P0-05). Always present; `[]` when undeclared, which means no
   * origin gets any `Access-Control-*` header. Persisted to `products.web_origins_json`.
   */
  webOrigins: string[];
}

export type ParseManifestResult =
  | { ok: true; manifest: ParsedManifest }
  | { ok: false; errors: string[] };

/**
 * Every module name a `modules:` block may use, mapped to the service slug(s) it enables.
 *
 * The three interesting rows:
 *
 *   `releases` -> release + update. The old module meant "this product distributes software",
 *   which the suite splits into the truth store (Release) and the feed (Update, D-05). Mapping
 *   it to Release alone would silently take the appcast and `/version` away from every product
 *   that already serves them, on the very change that is supposed to preserve behaviour. It
 *   also can never produce an `update_requires_release` violation, because Release comes with
 *   it by construction.
 *
 *   `oidc` -> identity. A rename, not a change of meaning (D-14).
 *
 *   `edgeMint` -> config. Edge-minting is a secret-DELIVERY capability of Config, not a
 *   service of its own (D-19); declaring it therefore turns Config on.
 */
const MODULE_SERVICES: Record<ProductModule, readonly ServiceSlug[]> = {
  licensing: ["license"],
  releases: ["release", "update"],
  oidc: ["identity"],
  edgeMint: ["config"],
  license: ["license"],
  config: ["config"],
  release: ["release"],
  update: ["update"],
  identity: ["identity"],
};

const MODULES = Object.keys(MODULE_SERVICES) as ProductModule[];

/** What a manifest that declares nothing runs: licensing + settings distribution, which is
 *  today's behaviour for every product (design spec §2.2). */
const DEFAULT_ENABLED: readonly ServiceSlug[] = ["license", "config"];
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SECRET_RE = /^[A-Z0-9][A-Z0-9_:-]{1,127}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Release strings reach a shell (`install.sh`), a GitHub API path, or a RegExp source. Every
// one of them is character-class-bounded HERE, at the ingest boundary, so a `.pkey/` push can
// never smuggle a quote, a newline, a `$`, a backtick, or a dot-segment downstream (R6-01,
// R6-07). Reject, never coerce: a manifest that fails these is not applied at all.
/** `binaryName` — interpolated into the served POSIX shell installer. */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `ghOwner` / `ghRepo` — interpolated unencoded into `api.github.com` paths. */
const GH_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** `channelWorkflow` — a workflow filename or numeric id in an API path segment. */
const CHANNEL_WORKFLOW_RE = /^(?:[0-9]{1,20}|[A-Za-z0-9._-]{1,100}\.ya?ml)$/;
/** `betaBranch` — a git branch name used as a query value. */
const BRANCH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
/** `summaryMarker` — embedded (escaped) in a RegExp source; capped to bound the pattern. */
const SUMMARY_MARKER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** `sparkleEd25519Pub` — a base64/base64url public key (or an operator placeholder). */
const SPARKLE_PUB_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;

// The same "reject, never coerce" rule applied to the rest of the manifest surface (R9-01).
// `binaryName` was the one that bit us (R6-01), but it was not the only manifest string that
// reaches a URL, an identifier, or a JOSE header.
/** `adminGroup` and `groupRoleMap` keys — IdP group names, compared against token claims. */
const GROUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$/;
/** `provisioning[].claim` — used as a property lookup on the decoded ID-token claims. */
const CLAIM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * Property names that resolve on `Object.prototype`. A claim name is used as `claims[name]`
 * against a JSON-parsed object, so `constructor` (or `toString`, …) would resolve to an
 * inherited function on *every* identity — the hook would fire unconditionally, for everyone,
 * regardless of what the IdP actually asserted. The character class cannot catch these (they
 * are perfectly ordinary identifiers), so they are named.
 */
const RESERVED_PROPERTY_NAMES = new Set([
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);
/** `oidc.clientId` — echoed into the authorize query, the token POST body, and `aud`. */
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,255}$/;
/** `edgeMint[].kid` — emitted verbatim in a JWS protected header. */
const KID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Channel / architecture names — they reach URL path segments and asset-match patterns. */
const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `release.manualChannels[].regex` source-length cap (see `compileManualChannelRegex`). */
export const MANUAL_CHANNEL_REGEX_MAX = 80;
/**
 * Compile a manual-channel tag regex under the SAME safety rules the worker's runtime
 * `parseManualChannels` applies: anchor it (so `beta` can't match `beta-old` unless the
 * author wrote it), cap its source length, and reject anything that fails to compile.
 * Returns `null` rather than throwing. Exported so ingest validation and the runtime reader
 * are one rule, not two copies (the audit's B1).
 */
export function compileManualChannelRegex(source: string): RegExp | null {
  if (source.length > MANUAL_CHANNEL_REGEX_MAX) return null;
  const anchored = `^(?:${source})$`;
  try {
    return new RegExp(anchored);
  } catch {
    return null;
  }
}
/**
 * The candidate filter used when `release.stableTagPattern` is undeclared: a semver 2.0 tag with
 * an optional leading `v` (`v1.2.3`, `1.2.3-rc.1`, `v2.0.0+build.5`). Written UNANCHORED because
 * `compileManualChannelRegex` anchors every source (`^(?:…)$`) — the written-out
 * `^v?…$` form is 81 characters, one over the cap a declared pattern must meet.
 */
export const DEFAULT_STABLE_TAG_PATTERN =
  "v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?";
// ── Release model vocabulary (P2-03) ───────────────────────────────────────────
//
// The release truth store keeps these as free TEXT with no CHECK (a CHECK change is a table
// rebuild, and the lists grow: P4 adds roles), so they are validated in code, against these
// lists — by the release-descriptor validator (P2-04) and the worker's `release/model.ts`.

/** OS families a build targets (README §3.1 "platform"). iPadOS is `ios`. */
export const RELEASE_PLATFORMS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/** CPU architectures a build targets. `universal` and `any` match every arch. */
export const RELEASE_ARCHES = [
  "arm64",
  "x86_64",
  "universal",
  "armv7",
  "wasm32",
  "any",
] as const;
export type ReleaseArch = (typeof RELEASE_ARCHES)[number];

/** What an artifact is FOR within its build (`release_artifacts.role`). */
export const ARTIFACT_ROLES = [
  "payload",
  "files-index",
  "chunk-index",
  "chunk-bundle",
  "delta",
  "signature",
  "checksum",
] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

/** Something a product releases: its `app`, or a pack. */
export const DELIVERABLE_KINDS = ["app", "pack"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** The id of the product's own application deliverable (README §3.12 `deliverables.app`). */
export const APP_DELIVERABLE_ID = "app";
/** Deliverable ids: lower-case, dot-separated segments (`app`, `diceroll.core3d`). */
export const DELIVERABLE_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const MAX_DELIVERABLE_ID_LENGTH = 64;
/** A well-formed deliverable id: matches `DELIVERABLE_ID_PATTERN`, at most 64 characters. */
export function isDeliverableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_DELIVERABLE_ID_LENGTH &&
    DELIVERABLE_ID_PATTERN.test(value)
  );
}

/** `release.ignoreTags` bounds: how many exact tag names, and how long each may be. */
export const MAX_IGNORE_TAGS = 200;
export const MAX_IGNORE_TAG_LENGTH = 255;
/**
 * One `release.ignoreTags` entry: a non-empty tag name with no control characters or spaces.
 * Its length is counted in code points, as the schema's `maxLength` counts it, not in UTF-16
 * units (`value.length`), so the validator and `release.schema.json` agree on an astral tag.
 */
export function isIgnoreTag(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const codePoints = [...value].length;
  return (
    codePoints > 0 &&
    codePoints <= MAX_IGNORE_TAG_LENGTH &&
    !/[\u0000-\u0020\u007f]/.test(value)
  );
}

// ── Deliverables and the artifact map (P2-04) ─────────────────────────────────
//
// `.pkey/release` `deliverables.app` declares the app deliverable: its version scheme, its
// channels' `includes`, and an `artifacts` map that classifies every release file by
// declaration instead of by filename. A release document without `deliverables` keeps the
// implicit `app` deliverable and legacy filename sniffing.

/** How a deliverable's versions are ordered (README §3.4). */
export const VERSION_SCHEMES = ["semver", "semver+build", "4part"] as const;
export type VersionScheme = (typeof VERSION_SCHEMES)[number];
/** Where a build's build number comes from: the release descriptor, or nowhere. */
export const BUILD_NUMBER_SOURCES = ["descriptor", "none"] as const;
export type BuildNumberSource = (typeof BUILD_NUMBER_SOURCES)[number];

/**
 * A canonical channel name (P0-04's `CHANNEL_NAME_PATTERN`): lower-case letters, digits and `-`.
 * The names a deliverable's `channels` block declares, and the channel a descriptor publishes
 * to, are stored as written, so only canonical names are accepted there.
 */
export const CANONICAL_CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Accepted request aliases (P0-04's `CHANNEL_ALIASES` keys). Never stored. */
export const CHANNEL_ALIAS_NAMES: readonly string[] = ["staging", "latest"];
/** The two channels every product has without declaring them. */
export const BUILT_IN_CHANNELS: readonly string[] = ["stable", "beta"];
/** A canonical, non-alias channel name. */
export function isCanonicalChannelName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_CHANNEL_PATTERN.test(value) &&
    !CHANNEL_ALIAS_NAMES.includes(value)
  );
}

/** An artifact-map entry id, which is also the id of the build it declares. */
export const ARTIFACT_ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A build format: the file type (`dmg`, `zip`, `tar.gz`, `apk`, `ipa`, `exe`, `msix`, …). */
export const ARTIFACT_FORMAT_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,31}$/;
export const MAX_ARTIFACT_MATCH_LENGTH = 128;
export const MAX_ARTIFACT_ENTRIES = 64;
export const MAX_DELIVERABLE_CHANNELS = 32;

/**
 * A well-formed artifact `match` glob: 1–128 characters (code points), no control characters.
 * `*` matches any run of characters (including none), `?` exactly one, and every other
 * character itself; the match is anchored at both ends and case-sensitive.
 */
export function isArtifactMatch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= MAX_ARTIFACT_MATCH_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Does `name` match the artifact glob `glob`? Linear-time wildcard matching with one backtrack
 * point (the last `*`), deliberately NOT a compiled RegExp: a glob of many `*` compiled to
 * `.*.*.*…` backtracks polynomially, and both the glob and the file names are repo-controlled.
 * Every character other than `*` and `?` is literal, which is the "escape everything else"
 * compile rule without a regex to escape into. Matching is over code points.
 */
export function matchesArtifactGlob(glob: string, name: string): boolean {
  const p = [...glob];
  const s = [...name];
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    const c = p[pi];
    if (c !== undefined && c !== "*" && (c === "?" || c === s[si])) {
      pi++;
      si++;
    } else if (c === "*") {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (p[pi] === "*") pi++;
  return pi === p.length;
}

/** `provisioning[].allowedHosts` entries — a host, optionally with a port. */
const HOST_RE = /^[A-Za-z0-9._-]{1,253}(?::[0-9]{1,5})?$/;
/**
 * `web.origins` (P0-05) — the browser origins allowed to READ this product's device-facing
 * responses through CORS. Each entry is compared byte-for-byte against a request's `Origin`
 * header, so the manifest must spell it the way a browser serializes one: lower-case scheme and
 * host, no default port, no trailing slash, no path. The rule is "reject, never coerce": a
 * value that is not already in that form would silently never match, so it is refused at
 * ingest rather than rewritten. Plain `http:` is allowed only for the two loopback hosts a
 * local web-export test server uses; there is no wildcard form.
 */
export const MAX_WEB_ORIGINS = 16;
/** `https://` + a 253-character host + `:65535`. */
const MAX_WEB_ORIGIN_LENGTH = 267;
/** An https origin over DNS labels (or a dotted-quad, which is digits and dots), or one of the
 *  two loopback http origins; either may carry an explicit port. Mirrored as a `pattern` in
 *  `schemas/v1/product.schema.json`. */
const WEB_ORIGIN_RE =
  /^(?:https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|http:\/\/(?:localhost|127\.0\.0\.1))(?::[0-9]{1,5})?$/;
/** Any C0 control character or DEL: never legitimate in a manifest string, and the cheapest
 *  way to keep newlines out of logs, headers, and generated files. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
/** Free-text bounds. Labels are UI strings; descriptions may be a short paragraph. */
const MAX_LABEL_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
/** Probe targets are a bundle id, a registry key, or an absolute path. */
const MAX_PROBE_TARGET_LENGTH = 512;
const MAX_REDIRECT_URIS = 20;
const MAX_URL_LENGTH = 2048;

// ── Ingest limits (R7-02) ────────────────────────────────────────────────────
// `parseDocument` is reachable from a *GitHub push webhook* on a third party's repo
// (`githubWebhook.ts` → `release/resync.ts` → here), so the bytes it parses are attacker-chosen
// and the work it does must be bounded before the parser sees them. Measured on this repo's
// `yaml@2.9.0`: a 1.67 MB flat map parses in 37.7 s (the cost is quadratic in key count).
/** Hard byte cap on one `.pkey/` document. The largest real manifest in this repo is ~1.5 KB;
 *  64 KB is two orders of magnitude of headroom and bounds a single parse to ~0.1 s. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** Structural nesting cap. Depth survives the parser but reaches recursive consumers later
 *  (`JSON.stringify` of a profile payload / claims template at persist time). */
export const MAX_MANIFEST_DEPTH = 32;
/** Bound on YAML anchor expansion ("billion laughs"). Same as the `yaml` default, pinned here
 *  so a dependency default change cannot silently widen it. */
const MAX_YAML_ALIASES = 100;

const RELEASE_ACCESS_VALUES = ["public", "authenticated", "licensed"] as const;
const OIDC_PROVIDER_VALUES = ["platform", "custom"] as const;
const FINGERPRINT_MODE_VALUES = ["off", "lenient", "normal", "strict"] as const;
const AUTO_ISSUE_MODE_VALUES = ["anonymous", "oidcDefault", "both"] as const;

/**
 * Product slugs the platform router reserves ahead of tenant routing. Every one of these is
 * (or fronts) a root path the worker matches before `/<product>/…` — a product registered
 * under such a slug would be permanently shadowed. `validateManifestDocuments` refuses them
 * (`reserved_slug`), and the worker's manual-create admin path checks the same list.
 */
export const RESERVED_PRODUCT_SLUGS: readonly string[] = [
  "docs",
  "manage",
  "api",
  "assets",
  "login",
  "logout",
  "callback",
  "magic",
  "download",
  "webhooks",
  "well-known",
];
const SECRET_DELIVERY_VALUES = [
  "serverOnly",
  "clientScoped",
  "edgeMint",
] as const;
const MANAGEMENT_STATE_VALUES = ["default", "enforced", "hidden"] as const;
const DEFAULT_RELEASE_ACCESS: ManifestReleaseAccessPolicy = {
  metadata: "public",
  artifacts: "public",
};

/**
 * Read a `modules:` block into the set of enabled SERVICE SLUGS.
 *
 * Both vocabularies are accepted and translated (see `MODULE_SERVICES`), so `{licensing: …}`
 * and `{license: …}` mean the same thing and a manifest may mix them. Unknown keys are
 * ignored, exactly as before — a `modules:` block is a declaration of intent, and a name this
 * build does not know is not a reason to refuse the whole product.
 *
 * Output is in canonical `SERVICE_SLUGS` order and duplicate-free, so two module names that
 * map to the same service (`licensing` + `license`) collapse to one entry.
 */
export function normalizeModules(raw: unknown): ServiceSlug[] {
  if (!isRecord(raw)) return [...DEFAULT_ENABLED];
  const enabled = new Set<ServiceSlug>();
  for (const module of MODULES) {
    const cfg = raw[module];
    if (isRecord(cfg) && cfg.enabled === true) {
      for (const slug of MODULE_SERVICES[module]) enabled.add(slug);
    }
  }
  if (enabled.size === 0) return [...DEFAULT_ENABLED];
  return SERVICE_SLUGS.filter((slug) => enabled.has(slug));
}

/** Expand an enabled-slug list into the complete map `products.services_json` stores. */
export function servicesFromModules(
  enabled: readonly ServiceSlug[],
): ManifestServices {
  const out = {} as ManifestServices;
  for (const slug of SERVICE_SLUGS)
    out[slug] = { enabled: enabled.includes(slug) };
  return out;
}

/** Read `devices.registration` off a product document, or undefined when undeclared. */
function registrationPolicy(productRoot: Record<string, unknown>): unknown {
  return asRecord(productRoot.devices).registration;
}

/**
 * Validate the documents as an AUTHOR-side check: the Config-conditional rules apply, so a
 * Config-off product may omit `.pkey/schema`. That is NOT what ingest accepts — link and
 * resync always require the schema. Anything that means to answer "will this link?" (the CLI's
 * `pkey validate`, `parseManifest`) must call {@link validateIngestDocuments} instead.
 */
export function validateManifestDocuments(
  manifest: ManifestDocuments,
): ValidationResult {
  return validateDocuments(manifest, false);
}

/**
 * The one rule for document presence: exactly what ingest (`link`, `resync`) requires. Both the
 * product and schema documents must exist (the schema even when Config is off; an empty catalog
 * is `schemaVersion: 1` with no entries), then everything {@link validateManifestDocuments}
 * checks. `missing_schema` is reported once whether Config is on or off.
 */
export function validateIngestDocuments(
  manifest: IngestDocuments,
): ValidationResult {
  const product = manifest.product;
  if (product === undefined) {
    // Nothing further can be judged without a product; the schema is still reported so the
    // author sees every missing document at once.
    const errors: ValidationMessage[] = [];
    add(
      errors,
      "product",
      "/",
      "missing_product",
      ".pkey/product is required at ingest.",
    );
    requireSchema(errors, manifest.schema);
    return {
      ok: false,
      errors,
      warnings: [],
      enabledModules: [...DEFAULT_ENABLED],
      requiredSecrets: [],
    };
  }
  return validateDocuments({ ...manifest, product }, true);
}

/** True when the schema document is present; otherwise reports `missing_schema`. */
function requireSchema(errors: ValidationMessage[], schema: unknown): boolean {
  if (schema !== undefined) return true;
  add(
    errors,
    "schema",
    "/",
    "missing_schema",
    ".pkey/schema is required at ingest even when Config is off; an empty catalog is schemaVersion: 1 with no entries.",
  );
  return false;
}

function validateDocuments(
  manifest: ManifestDocuments,
  schemaAlwaysRequired: boolean,
): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const productRoot = manifest.product;
  const modules = normalizeModules(productRoot.modules);
  const productNode = nestedProductDoc(productRoot);
  const licensing = asRecord(productRoot.licensing);
  const oidc = asRecord(productRoot.oidc);
  const secrets = asRecord(productRoot.secrets);

  if (
    productRoot.apiVersion !== undefined &&
    productRoot.apiVersion !== "pkey.dev/v1"
  ) {
    add(
      errors,
      "product",
      "/apiVersion",
      "invalid_api_version",
      "apiVersion must be pkey.dev/v1 when present.",
    );
  }
  const productSlug =
    typeof productNode.slug === "string" ? productNode.slug : "";
  if (!productSlug || !SLUG_RE.test(productSlug)) {
    add(
      errors,
      "product",
      "/product/slug",
      "invalid_slug",
      "product.slug must match ^[a-z0-9-]{1,64}$.",
    );
  } else if (RESERVED_PRODUCT_SLUGS.includes(productSlug)) {
    // The worker's root router reserves these ahead of product slugs (`/manage`, `/docs`,
    // the portal paths, `/.well-known/*`, …) — a product registered under one of them would
    // be permanently shadowed, its every route unreachable. Refuse at authoring time; the
    // admin manual-create path enforces the same list.
    add(
      errors,
      "product",
      "/product/slug",
      "reserved_slug",
      `product.slug "${productSlug}" collides with a reserved platform route.`,
    );
  }
  if (!stringAt(productNode, "name")) {
    add(
      errors,
      "product",
      "/product/name",
      "missing_name",
      "Add product.name.",
    );
  }
  boundedText(
    errors,
    "product",
    productNode.name,
    "/product/name",
    "invalid_name",
    MAX_LABEL_LENGTH,
    "product.name",
  );
  // `adminGroup` is matched against an ID-token group claim to decide who administers the
  // product, so it is an identifier, not prose.
  constrained(
    errors,
    "product",
    productNode.adminGroup ?? productRoot.adminGroup,
    "/product/adminGroup",
    "invalid_admin_group",
    GROUP_NAME_RE,
    "product.adminGroup must be a plain group name (^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$).",
  );
  for (const [key, path] of [
    [productNode.compatMin ?? productRoot.compatMin, "/compatMin"],
    [productNode.compatMax ?? productRoot.compatMax, "/compatMax"],
  ] as const) {
    if (
      key !== undefined &&
      (typeof key !== "string" || !SEMVER_RE.test(key))
    ) {
      add(
        errors,
        "product",
        path,
        "invalid_semver",
        "Version bounds must be semver strings.",
      );
    }
  }
  for (const [key, path] of [
    [
      productNode.defaultDeviceLimit ??
        productRoot.defaultDeviceLimit ??
        licensing.defaultDeviceLimit,
      "/licensing/defaultDeviceLimit",
    ],
    [
      productNode.defaultMaxOfflineDays ??
        productRoot.defaultMaxOfflineDays ??
        licensing.defaultMaxOfflineDays,
      "/licensing/defaultMaxOfflineDays",
    ],
  ] as const) {
    if (key !== undefined && !nonNegativeInteger(key)) {
      add(
        errors,
        "product",
        path,
        "invalid_number",
        "Value must be a non-negative integer.",
      );
    }
  }

  if (schemaAlwaysRequired || modules.includes("config")) {
    if (requireSchema(errors, manifest.schema)) {
      const catalog = normalizeCatalog(manifest.schema);
      if (!catalog) {
        add(
          errors,
          "schema",
          "/",
          "invalid_schema",
          "Schema must be a ProductCatalog object with entries[].",
        );
      } else if (modules.includes("config")) {
        // Content is shape-validated only when Config is on: a Config-off product's catalog is
        // otherwise judged only by the looser Catalog.compileAll at link/resync.
        for (const issue of validateCatalogShape(catalog)) {
          add(errors, "schema", "/entries", "invalid_catalog_shape", issue);
        }
      }
    }
  }

  const profiles =
    arrayAt(productRoot, "profiles") ?? arrayAt(licensing, "profiles") ?? [];
  const profileIds = new Set<string>();
  for (const [i, raw] of profiles.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      add(
        errors,
        "product",
        `/licensing/profiles/${i}/id`,
        "invalid_profile_id",
        "Profile ids must be non-empty simple identifiers.",
      );
      continue;
    }
    const record = raw;
    const id = raw.id;
    if (profileIds.has(id)) {
      add(
        errors,
        "product",
        `/licensing/profiles/${i}/id`,
        "duplicate_profile_id",
        "Profile ids must be unique.",
      );
    }
    profileIds.add(id);
    boundedText(
      errors,
      "product",
      record.name ?? record.label,
      `/licensing/profiles/${i}/name`,
      "invalid_profile_name",
      MAX_LABEL_LENGTH,
      "Profile name",
    );
    boundedText(
      errors,
      "product",
      record.description,
      `/licensing/profiles/${i}/description`,
      "invalid_profile_description",
      MAX_TEXT_LENGTH,
      "Profile description",
    );
    if (record.payload !== undefined && !isRecord(record.payload)) {
      add(
        errors,
        "product",
        `/licensing/profiles/${i}/payload`,
        "invalid_payload",
        "Profile payload must be an object.",
      );
    }
  }

  const tiers =
    arrayAt(productRoot, "tiers") ?? arrayAt(licensing, "tiers") ?? [];
  const tierIds = new Set<string>();
  for (const [i, raw] of tiers.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/id`,
        "invalid_tier_id",
        "Tier ids must be non-empty simple identifiers.",
      );
      continue;
    }
    const record = raw;
    const id = raw.id;
    if (tierIds.has(id)) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/id`,
        "duplicate_tier_id",
        "Tier ids must be unique.",
      );
    }
    tierIds.add(id);
    const profile = record.profileId ?? record.profile;
    if (
      profile !== undefined &&
      profile !== null &&
      typeof profile !== "string"
    ) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/profile`,
        "invalid_profile_ref",
        "Tier profile must be a string profile id.",
      );
    } else if (typeof profile === "string" && !profileIds.has(profile)) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/profile`,
        "unknown_profile_ref",
        `Tier references unknown profile ${profile}.`,
      );
    }
    if (
      record.policyDeviceLimit !== undefined &&
      !nonNegativeInteger(record.policyDeviceLimit)
    ) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/policyDeviceLimit`,
        "invalid_device_limit",
        "policyDeviceLimit must be a non-negative integer.",
      );
    }
    boundedText(
      errors,
      "product",
      record.label,
      `/licensing/tiers/${i}/label`,
      "invalid_tier_label",
      MAX_LABEL_LENGTH,
      "Tier label",
    );
    // Channel names become URL path segments on the release routes.
    constrainedList(
      errors,
      "product",
      record.channels,
      `/licensing/tiers/${i}/channels`,
      "invalid_channel",
      CHANNEL_RE,
      "Tier channels must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.",
    );
    for (const bound of ["minVersion", "maxVersion"] as const) {
      constrained(
        errors,
        "product",
        record[bound],
        `/licensing/tiers/${i}/${bound}`,
        "invalid_semver",
        SEMVER_RE,
        `Tier ${bound} must be a semver string.`,
      );
    }
    // Keys the scaffold used to write. Neither is an error (existing manifests keep linking),
    // but both are silently misread, so they warn.
    if (record.deviceLimit !== undefined) {
      add(
        warnings,
        "product",
        `/licensing/tiers/${i}/deviceLimit`,
        "tier_ignored_field",
        "deviceLimit on a tier is ignored; use policyDeviceLimit.",
      );
    }
    if (record.maxOfflineDays !== undefined) {
      // The tier normaliser reads policyExpiryDays, then expiryDays, then maxOfflineDays (each
      // only when it is a number), so the message says "sets the licence expiry" only when
      // maxOfflineDays is the one that wins. Each branch keeps a literal message so the docs
      // generator can extract it.
      if (typeof record.maxOfflineDays !== "number") {
        add(
          warnings,
          "product",
          `/licensing/tiers/${i}/maxOfflineDays`,
          "tier_ignored_field",
          "maxOfflineDays on a tier is ignored because it is not a number; use policyExpiryDays for the licence expiry.",
        );
      } else if (
        typeof record.policyExpiryDays === "number" ||
        typeof record.expiryDays === "number"
      ) {
        add(
          warnings,
          "product",
          `/licensing/tiers/${i}/maxOfflineDays`,
          "tier_ignored_field",
          "maxOfflineDays on a tier is ignored because policyExpiryDays or expiryDays is also set and wins; it is not offline grace.",
        );
      } else {
        add(
          warnings,
          "product",
          `/licensing/tiers/${i}/maxOfflineDays`,
          "tier_ignored_field",
          "maxOfflineDays on a tier sets the licence expiry, policyExpiryDays, not offline grace.",
        );
      }
    }
    // Enforcement strength is an enum, and a typo'd value must be an authoring error — the
    // admin PATCH path (services/license/admin/policy.ts) already rejects these, so this
    // brings the manifest write path up to the same standard instead of silently coercing.
    if (
      record.policyFingerprint !== undefined &&
      record.policyFingerprint !== null &&
      !isOneOf(record.policyFingerprint, FINGERPRINT_MODE_VALUES)
    ) {
      add(
        errors,
        "product",
        `/licensing/tiers/${i}/policyFingerprint`,
        "invalid_tier_fingerprint_mode",
        `Tier policyFingerprint must be one of ${FINGERPRINT_MODE_VALUES.join(", ")}.`,
      );
    }
  }

  if (modules.includes("identity") || productRoot.oidc !== undefined) {
    if (!isRecord(productRoot.oidc)) {
      add(
        errors,
        "product",
        "/oidc",
        "invalid_oidc",
        "oidc must be an object.",
      );
    } else {
      const provider = oidc.provider ?? "platform";
      if (!isOneOf(provider, OIDC_PROVIDER_VALUES)) {
        add(
          errors,
          "product",
          "/oidc/provider",
          "invalid_oidc_provider",
          "oidc.provider must be platform or custom.",
        );
      }
      if (provider === "custom") {
        // R9-01: this value becomes the base of the token POST that carries the product's
        // OIDC client secret, of the JWKS fetch, and of the anonymous 302 from
        // `/<product>/auth/start`. A `.pkey/` push must not be able to aim any of them.
        const issuerProblem = issuerUrlProblem(oidc.issuer);
        if (issuerProblem) {
          add(
            errors,
            "product",
            "/oidc/issuer",
            "invalid_oidc_issuer",
            `oidc.issuer ${issuerProblem}. It is the base of the token request that carries this product's OIDC client secret.`,
          );
        }
        if (!stringAt(oidc, "clientId")) {
          add(
            errors,
            "product",
            "/oidc/clientId",
            "missing_oidc_client_id",
            "OIDC clientId is required for custom OIDC.",
          );
        }
      }
      constrained(
        errors,
        "product",
        oidc.clientId,
        "/oidc/clientId",
        "invalid_oidc_client_id",
        CLIENT_ID_RE,
        "oidc.clientId must match ^[A-Za-z0-9][A-Za-z0-9._:@/~-]{0,255}$.",
      );
      // Group names decide role and tier, so they are identifiers rather than prose.
      if (isRecord(oidc.groupRoleMap)) {
        for (const group of Object.keys(oidc.groupRoleMap)) {
          if (!GROUP_NAME_RE.test(group)) {
            add(
              errors,
              "product",
              `/oidc/groupRoleMap/${group}`,
              "invalid_group_name",
              "oidc.groupRoleMap keys must be plain group names (^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,127}$).",
            );
          }
        }
      }
      const ref = oidc.clientSecretSecret ?? oidc.clientSecretRef;
      if (
        ref !== undefined &&
        (typeof ref !== "string" || !SECRET_RE.test(ref))
      ) {
        add(
          errors,
          "product",
          "/oidc/clientSecretRef",
          "invalid_secret_ref",
          "Secret refs must be stable uppercase names.",
        );
      }
      const redirects = arrayAt(oidc, "redirectUris") ?? [];
      if (redirects.length > MAX_REDIRECT_URIS) {
        add(
          errors,
          "product",
          "/oidc/redirectUris",
          "too_many_redirect_uris",
          `At most ${MAX_REDIRECT_URIS} redirect URIs are allowed.`,
        );
      }
      for (const [i, uri] of redirects.entries()) {
        const problem = redirectUriProblem(uri);
        if (problem) {
          add(
            errors,
            "product",
            `/oidc/redirectUris/${i}`,
            "invalid_redirect_uri",
            `Redirect URIs ${problem}.`,
          );
        }
      }
    }
  }

  const relDoc =
    releaseRoot(manifest.release) ?? releaseRoot(productRoot.release);
  if (modules.includes("release") || relDoc) {
    const relRoot = relDoc;
    if (!relRoot) {
      add(
        errors,
        "release",
        "/",
        "missing_release",
        "Releases are enabled, so .pkey/release.yaml or release.json is required.",
      );
    } else {
      const provider = asRecord(relRoot.provider);
      const owner = relRoot.ghOwner ?? provider.owner;
      const repo = relRoot.ghRepo ?? provider.repo;
      if (provider.type !== undefined && provider.type !== "github") {
        add(
          errors,
          "release",
          "/release/provider/type",
          "unsupported_release_provider",
          "Only github is implemented.",
        );
      }
      if (!stringAt({ owner }, "owner") || !stringAt({ repo }, "repo")) {
        add(
          errors,
          "release",
          "/release/provider",
          "missing_github_repo",
          "GitHub releases require owner and repo.",
        );
      }
      releaseString(
        errors,
        owner,
        "/release/provider/owner",
        "invalid_github_owner",
        GH_SLUG_RE,
        "release owner must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$.",
      );
      releaseString(
        errors,
        repo,
        "/release/provider/repo",
        "invalid_github_repo",
        GH_SLUG_RE,
        "release repo must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$.",
      );
      releaseString(
        errors,
        relRoot.binaryName,
        "/release/binaryName",
        "invalid_binary_name",
        BINARY_NAME_RE,
        "release.binaryName must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ — it is interpolated into the published install.sh.",
      );
      releaseString(
        errors,
        relRoot.channelWorkflow,
        "/release/channelWorkflow",
        "invalid_channel_workflow",
        CHANNEL_WORKFLOW_RE,
        "release.channelWorkflow must be a workflow filename (*.yml / *.yaml) or a numeric workflow id.",
      );
      releaseString(
        errors,
        relRoot.betaBranch,
        "/release/betaBranch",
        "invalid_beta_branch",
        BRANCH_RE,
        "release.betaBranch must be a plain git branch name.",
      );
      releaseString(
        errors,
        relRoot.summaryMarker,
        "/release/summaryMarker",
        "invalid_summary_marker",
        SUMMARY_MARKER_RE,
        "release.summaryMarker must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$.",
      );
      releaseString(
        errors,
        relRoot.sparkleEd25519Pub,
        "/release/sparkleEd25519Pub",
        "invalid_sparkle_pub",
        SPARKLE_PUB_RE,
        "release.sparkleEd25519Pub must be a base64/base64url key of at most 512 characters.",
      );
      const artifactPolicy = asRecord(relRoot.artifactPolicy);
      constrainedList(
        errors,
        "release",
        artifactPolicy.channels,
        "/release/artifactPolicy/channels",
        "invalid_channel",
        CHANNEL_RE,
        "artifactPolicy.channels must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.",
      );
      constrainedList(
        errors,
        "release",
        artifactPolicy.architectures,
        "/release/artifactPolicy/architectures",
        "invalid_architecture",
        CHANNEL_RE,
        "artifactPolicy.architectures must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.",
      );
      if (relRoot.manualChannels !== undefined) {
        if (!Array.isArray(relRoot.manualChannels)) {
          add(
            errors,
            "release",
            "/release/manualChannels",
            "invalid_manual_channel",
            "release.manualChannels must be an array of { name, regex } entries.",
          );
        } else {
          for (const [i, raw] of relRoot.manualChannels.entries()) {
            const at = `/release/manualChannels/${i}`;
            if (!isRecord(raw)) {
              add(
                errors,
                "release",
                at,
                "invalid_manual_channel",
                "Each manual channel must be a { name, regex } object.",
              );
              continue;
            }
            // The name becomes a URL path segment on the release/update routes, exactly
            // like a tier channel; the regex is compiled under the runtime reader's safety
            // rules so a manifest the validator accepts is one `parseManualChannels` keeps.
            if (typeof raw.name !== "string" || !CHANNEL_RE.test(raw.name)) {
              add(
                errors,
                "release",
                `${at}/name`,
                "invalid_manual_channel",
                "manualChannels[].name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.",
              );
            }
            if (
              typeof raw.regex !== "string" ||
              compileManualChannelRegex(raw.regex) === null
            ) {
              add(
                errors,
                "release",
                `${at}/regex`,
                "invalid_manual_channel",
                `manualChannels[].regex must be a compilable regular expression of at most ${MANUAL_CHANNEL_REGEX_MAX} characters (it is matched anchored against release tags).`,
              );
            }
          }
        }
      }
      // The candidate filter for stable/latest: compiled under the manual-channel safety rule
      // (anchored, capped, must compile) so a pattern the validator accepts is one the
      // worker's resolver keeps rather than silently falling back to the default. The same
      // two fields may instead be spelled under `deliverables.app.versioning` (P2-04).
      validateTagFilters(errors, relRoot, "/release", "release");
      validateDeliverables(errors, warnings, relRoot);
      if (relRoot.access !== undefined && !isRecord(relRoot.access)) {
        add(
          errors,
          "release",
          "/release/access",
          "invalid_release_access",
          "release.access must be an object when present.",
        );
      } else {
        const access = asRecord(relRoot.access);
        for (const key of ["metadata", "artifacts"] as const) {
          const value = access[key];
          if (value !== undefined && !isOneOf(value, RELEASE_ACCESS_VALUES)) {
            add(
              errors,
              "release",
              `/release/access/${key}`,
              "invalid_release_access",
              "release.access values must be public, authenticated, or licensed.",
            );
          }
        }
      }
    }
  }

  const provisioning = arrayAt(productRoot, "provisioning") ?? [];
  for (const [i, raw] of provisioning.entries()) {
    if (!isRecord(raw) || !stringAt(raw, "claim")) {
      add(
        errors,
        "product",
        `/provisioning/${i}/claim`,
        "invalid_claim",
        "Provisioning hooks require claim.",
      );
    }
    if (!isRecord(raw)) continue;
    // `claim` and `entitlementKey` are used as property names on the decoded ID-token claims
    // and on the emitted managed payload respectively.
    constrained(
      errors,
      "product",
      raw.claim,
      `/provisioning/${i}/claim`,
      "invalid_claim",
      CLAIM_NAME_RE,
      "Provisioning claim names must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$.",
    );
    constrained(
      errors,
      "product",
      raw.entitlementKey,
      `/provisioning/${i}/entitlementKey`,
      "invalid_entitlement_key",
      ID_RE,
      "Provisioned entitlement keys must be catalog identifiers.",
    );
    for (const [field, code] of [
      ["claim", "invalid_claim"],
      ["entitlementKey", "invalid_entitlement_key"],
      ["secretKey", "invalid_secret_key"],
    ] as const) {
      if (
        typeof raw[field] === "string" &&
        RESERVED_PROPERTY_NAMES.has(raw[field])
      ) {
        add(
          errors,
          "product",
          `/provisioning/${i}/${field}`,
          code,
          `${field} must not be a JavaScript prototype property name — it would resolve on every identity.`,
        );
      }
    }
    if (
      raw.secretKey !== undefined &&
      (typeof raw.secretKey !== "string" || !ID_RE.test(raw.secretKey))
    ) {
      add(
        errors,
        "product",
        `/provisioning/${i}/secretKey`,
        "invalid_secret_key",
        "Provisioned secret keys must be catalog identifiers.",
      );
    }
    if (raw.secretUrlTemplate !== undefined) {
      const problem = secretUrlTemplateProblem(raw.secretUrlTemplate);
      if (problem) {
        add(
          errors,
          "product",
          `/provisioning/${i}/secretUrlTemplate`,
          "invalid_secret_url_template",
          `provisioning.secretUrlTemplate ${problem}.`,
        );
      }
    }
    constrainedList(
      errors,
      "product",
      raw.allowedHosts,
      `/provisioning/${i}/allowedHosts`,
      "invalid_allowed_host",
      HOST_RE,
      "allowedHosts entries must be a host, optionally with a port.",
    );
  }

  const edgeMint =
    arrayAt(productRoot, "edgeMint") ??
    arrayAt(asRecord(manifest.release), "edgeMint") ??
    [];
  for (const [i, raw] of edgeMint.entries()) {
    if (!isRecord(raw) || !stringAt(raw, "id")) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/id`,
        "invalid_edge_mint_id",
        "Edge mint recipes require id.",
      );
      continue;
    }
    // The recipe id is a URL path segment (`/<product>/mint/<id>/auth`) and a table key.
    constrained(
      errors,
      "release",
      raw.id,
      `/edgeMint/${i}/id`,
      "invalid_edge_mint_id",
      ID_RE,
      "Edge mint ids must match ^[A-Za-z0-9._:-]{1,64}$.",
    );
    // `kid` is emitted verbatim in the JWS protected header; `audience` becomes `aud`.
    constrained(
      errors,
      "release",
      raw.kid,
      `/edgeMint/${i}/kid`,
      "invalid_edge_mint_kid",
      KID_RE,
      "Edge mint kid must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$.",
    );
    boundedText(
      errors,
      "release",
      raw.audience,
      `/edgeMint/${i}/audience`,
      "invalid_edge_mint_audience",
      MAX_LABEL_LENGTH,
      "Edge mint audience",
    );
    if (!["ES256", "RS256", "EdDSA"].includes(String(raw.alg ?? ""))) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/alg`,
        "invalid_edge_mint_alg",
        "Edge mint alg must be ES256, RS256, or EdDSA.",
      );
    }
    const ref = raw.signingKeySecret;
    if (typeof ref !== "string" || !SECRET_RE.test(ref)) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/signingKeySecret`,
        "invalid_secret_ref",
        "Edge mint signing key refs must be stable uppercase names.",
      );
    }
    if (raw.ttlSeconds !== undefined && !positiveInteger(raw.ttlSeconds)) {
      add(
        errors,
        "release",
        `/edgeMint/${i}/ttlSeconds`,
        "invalid_ttl",
        "Edge mint TTL must be a positive integer.",
      );
    }
  }

  // ── Fingerprint + auto-issue policy blocks ──────────────────────────────────────────────
  //
  // These are ENFORCEMENT policy, and every enum here used to be silently coerced at the
  // normalize stage (a typo'd `defaultMode: "stricht"` imported as "normal"; a typo'd
  // `autoIssue.mode` fell OPEN to "anonymous" — the mode that opens the keyless enroll
  // endpoint). The admin PATCH path (`services/license/admin/policy.ts`) already validates
  // all of this strictly; these rules make the manifest write path agree with it, the same
  // way `invalid_oidc_provider` / `invalid_registration_policy` already treat their enums.

  if (
    productRoot.fingerprint !== undefined &&
    !isRecord(productRoot.fingerprint)
  ) {
    add(
      errors,
      "product",
      "/fingerprint",
      "invalid_fingerprint",
      "fingerprint must be an object.",
    );
  }
  const fingerprint = asRecord(productRoot.fingerprint);
  if (
    fingerprint.enabled !== undefined &&
    typeof fingerprint.enabled !== "boolean"
  ) {
    add(
      errors,
      "product",
      "/fingerprint/enabled",
      "invalid_fingerprint_enabled",
      "fingerprint.enabled must be a boolean.",
    );
  }
  if (
    fingerprint.defaultMode !== undefined &&
    !isOneOf(fingerprint.defaultMode, FINGERPRINT_MODE_VALUES)
  ) {
    add(
      errors,
      "product",
      "/fingerprint/defaultMode",
      "invalid_fingerprint_mode",
      `fingerprint.defaultMode must be one of ${FINGERPRINT_MODE_VALUES.join(", ")}.`,
    );
  }

  // Fingerprint probes: `id` becomes a key in the device's reported probe map, and each
  // per-platform target is shipped to every client of this product.
  for (const [i, raw] of (arrayAt(fingerprint, "probes") ?? []).entries()) {
    if (!isRecord(raw)) continue;
    constrained(
      errors,
      "product",
      raw.id,
      `/fingerprint/probes/${i}/id`,
      "invalid_probe_id",
      ID_RE,
      "Probe ids must match ^[A-Za-z0-9._:-]{1,64}$.",
    );
    boundedText(
      errors,
      "product",
      raw.label,
      `/fingerprint/probes/${i}/label`,
      "invalid_probe_label",
      MAX_LABEL_LENGTH,
      "Probe label",
    );
    for (const platform of ["macos", "windows", "linux"] as const) {
      boundedText(
        errors,
        "product",
        raw[platform],
        `/fingerprint/probes/${i}/${platform}`,
        "invalid_probe_target",
        MAX_PROBE_TARGET_LENGTH,
        `Probe ${platform} target`,
      );
    }
  }

  // Auto-issue: names the tier keyless licenses land on, plus its own enums/bounds.
  if (productRoot.autoIssue !== undefined && !isRecord(productRoot.autoIssue)) {
    add(
      errors,
      "product",
      "/autoIssue",
      "invalid_auto_issue",
      "autoIssue must be an object.",
    );
  }
  const autoIssue = asRecord(productRoot.autoIssue);
  if (
    autoIssue.enabled !== undefined &&
    typeof autoIssue.enabled !== "boolean"
  ) {
    add(
      errors,
      "product",
      "/autoIssue/enabled",
      "invalid_auto_issue",
      "autoIssue.enabled must be a boolean.",
    );
  }
  if (
    autoIssue.mode !== undefined &&
    !isOneOf(autoIssue.mode, AUTO_ISSUE_MODE_VALUES)
  ) {
    add(
      errors,
      "product",
      "/autoIssue/mode",
      "invalid_auto_issue_mode",
      `autoIssue.mode must be one of ${AUTO_ISSUE_MODE_VALUES.join(", ")}.`,
    );
  }
  // `stringAt`-style non-empty check, matching oidc.clientId's idiom: `typeof !== "string"`
  // alone lets `tierId: ""` sail through every later gate (`constrained` treats "" as unset;
  // ID_RE requires ≥1 char) and pass validation while the policy is silently inert.
  if (
    autoIssue.enabled === true &&
    (typeof autoIssue.tierId !== "string" || autoIssue.tierId.length === 0)
  ) {
    add(
      errors,
      "product",
      "/autoIssue/tierId",
      "missing_auto_issue_tier",
      "autoIssue.tierId is required when autoIssue is enabled — a policy naming no tier cannot issue anything.",
    );
  }
  constrained(
    errors,
    "product",
    autoIssue.tierId,
    "/autoIssue/tierId",
    "invalid_tier_ref",
    ID_RE,
    "autoIssue.tierId must be a tier identifier.",
  );
  // Existence, not just shape — mirrors `unknown_profile_ref` for tier→profile. Without
  // this, a typo'd tier imports cleanly and the failure surfaces at a user's first enroll.
  if (
    typeof autoIssue.tierId === "string" &&
    ID_RE.test(autoIssue.tierId) &&
    !tierIds.has(autoIssue.tierId)
  ) {
    add(
      errors,
      "product",
      "/autoIssue/tierId",
      "unknown_auto_issue_tier_ref",
      `autoIssue.tierId references unknown tier ${autoIssue.tierId}.`,
    );
  }
  if (
    autoIssue.rateLimitPerHour !== undefined &&
    !nonNegativeInteger(autoIssue.rateLimitPerHour)
  ) {
    add(
      errors,
      "product",
      "/autoIssue/rateLimitPerHour",
      "invalid_rate_limit",
      "autoIssue.rateLimitPerHour must be a non-negative integer.",
    );
  }

  // Declared secret names are looked up in the product's sealed-secret store.
  for (const [i, item] of (arrayAt(secrets, "required") ?? []).entries()) {
    const name = isRecord(item) ? item.name : item;
    constrained(
      errors,
      "product",
      name,
      `/secrets/required/${i}`,
      "invalid_secret_ref",
      SECRET_RE,
      "Secret refs must be stable uppercase names.",
    );
  }

  const requiredSecrets = collectRequiredSecrets(
    secrets,
    productRoot,
    manifest.release,
  );
  if (
    modules.includes("config") &&
    !modules.includes("license") &&
    !modules.includes("identity")
  ) {
    add(
      warnings,
      "product",
      "/modules/config",
      "config_without_activation",
      "Config is enabled without an activation method.",
    );
  }

  // Update renders a feed over Release's truth store (D-05). With Release off there are no
  // releases, channels or artifacts to render, so the feed would answer every client with an
  // empty document rather than an error — a silent failure, which is why this is an error and
  // not a warning. `releases`/`release`+`update` manifests cannot trip it (see MODULE_SERVICES).
  if (modules.includes("update") && !modules.includes("release")) {
    add(
      errors,
      "product",
      "/modules/update",
      "update_requires_release",
      "The update service renders a feed over release data, so release must be enabled too.",
    );
  }

  // `devices.registration` decides who may mint a device token (design spec §2.3). An
  // unrecognised value is refused rather than coerced: silently falling back to a default
  // would answer "requires-licence" with "open" for the one manifest that most meant it.
  const registration = registrationPolicy(productRoot);
  if (
    registration !== undefined &&
    !isOneOf(registration, REGISTRATION_POLICIES)
  ) {
    add(
      errors,
      "product",
      "/devices/registration",
      "invalid_registration_policy",
      `devices.registration must be one of ${REGISTRATION_POLICIES.join(", ")}.`,
    );
  }

  // `web.origins` (P0-05): the browser origins the worker answers CORS for on this product's
  // device-facing routes. The block's SHAPE is `invalid_web_origins`; each entry's spelling is
  // `invalid_web_origin`. A duplicate is refused too — it is harmless to the matcher, but it is
  // always a typo'd second entry, and the schema's `uniqueItems` refuses it as well.
  if (productRoot.web !== undefined && !isRecord(productRoot.web)) {
    add(
      errors,
      "product",
      "/web",
      "invalid_web_origins",
      "web must be an object.",
    );
  }
  const webOrigins = asRecord(productRoot.web).origins;
  if (webOrigins !== undefined) {
    if (!Array.isArray(webOrigins) || webOrigins.length > MAX_WEB_ORIGINS) {
      add(
        errors,
        "product",
        "/web/origins",
        "invalid_web_origins",
        `web.origins must be an array of at most ${MAX_WEB_ORIGINS} origins.`,
      );
    } else {
      const seen = new Set<string>();
      for (const [i, origin] of webOrigins.entries()) {
        const problem =
          webOriginProblem(origin) ??
          (seen.has(origin as string)
            ? "must not repeat an earlier entry"
            : null);
        if (problem) {
          add(
            errors,
            "product",
            `/web/origins/${i}`,
            "invalid_web_origin",
            `web.origins entries ${problem}.`,
          );
        }
        if (typeof origin === "string") seen.add(origin);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    enabledModules: modules,
    requiredSecrets,
  };
}

/**
 * `stableTagPattern` and `ignoreTags`, wherever they are spelled: at the release root (P0-02,
 * the legacy spelling) or under `deliverables.app.versioning` (P2-04). One rule for both, so
 * the two spellings can never accept different values.
 */
function validateTagFilters(
  errors: ValidationMessage[],
  node: Record<string, unknown>,
  at: string,
  label: string,
): void {
  if (
    node.stableTagPattern !== undefined &&
    (typeof node.stableTagPattern !== "string" ||
      compileManualChannelRegex(node.stableTagPattern) === null)
  ) {
    add(
      errors,
      "release",
      `${at}/stableTagPattern`,
      "invalid_stable_tag_pattern",
      `${label}.stableTagPattern must be a compilable regular expression of at most ${MANUAL_CHANNEL_REGEX_MAX} characters (it is matched anchored against release tags).`,
    );
  }
  if (node.ignoreTags === undefined) return;
  if (
    !Array.isArray(node.ignoreTags) ||
    node.ignoreTags.length > MAX_IGNORE_TAGS
  ) {
    add(
      errors,
      "release",
      `${at}/ignoreTags`,
      "invalid_ignore_tags",
      `${label}.ignoreTags must be an array of at most ${MAX_IGNORE_TAGS} exact tag names.`,
    );
    return;
  }
  for (const [i, tag] of node.ignoreTags.entries()) {
    if (!isIgnoreTag(tag)) {
      add(
        errors,
        "release",
        `${at}/ignoreTags/${i}`,
        "invalid_ignore_tags",
        `${label}.ignoreTags entries must be non-empty tag names of at most ${MAX_IGNORE_TAG_LENGTH} characters with no spaces or control characters.`,
      );
    }
  }
}

/** The names a deliverable's `includes` may refer to: the built-ins, the manual channels and the
 *  deliverable's own declared channels. */
function knownChannelNames(
  relRoot: Record<string, unknown>,
  declared: Iterable<string>,
): Set<string> {
  const known = new Set<string>(BUILT_IN_CHANNELS);
  if (Array.isArray(relRoot.manualChannels)) {
    for (const m of relRoot.manualChannels) {
      if (isRecord(m) && typeof m.name === "string") known.add(m.name);
    }
  }
  for (const name of declared) known.add(name);
  return known;
}

/**
 * `deliverables` (P2-04, README §3.4/§3.12). Only the `app` deliverable is implemented; a `pack`
 * entry is reported as a warning and ignored until P4-02. Absent ⇒ the implicit `app`
 * deliverable with legacy filename sniffing, so every existing release document stays valid.
 */
function validateDeliverables(
  errors: ValidationMessage[],
  warnings: ValidationMessage[],
  relRoot: Record<string, unknown>,
): void {
  const raw = relRoot.deliverables;
  if (raw === undefined) return;
  const base = "/release/deliverables";
  if (!isRecord(raw)) {
    add(
      errors,
      "release",
      base,
      "invalid_deliverable_id",
      "release.deliverables must be an object keyed by deliverable id.",
    );
    return;
  }
  for (const [id, def] of Object.entries(raw)) {
    const at = `${base}/${id}`;
    if (!isDeliverableId(id)) {
      add(
        errors,
        "release",
        at,
        "invalid_deliverable_id",
        `deliverable ids must match ${DELIVERABLE_ID_PATTERN.source} and be at most ${MAX_DELIVERABLE_ID_LENGTH} characters.`,
      );
      continue;
    }
    const kind = isRecord(def) ? def.kind : undefined;
    if (!isRecord(def) || !isOneOf(kind, DELIVERABLE_KINDS)) {
      add(
        errors,
        "release",
        `${at}/kind`,
        "invalid_deliverable_kind",
        `each deliverable must be an object whose kind is one of ${DELIVERABLE_KINDS.join(", ")}.`,
      );
      continue;
    }
    if ((kind === "app") !== (id === APP_DELIVERABLE_ID)) {
      add(
        errors,
        "release",
        `${at}/kind`,
        "invalid_deliverable_kind",
        `the deliverable named ${APP_DELIVERABLE_ID} is the product's application (kind: app), and no other deliverable may be kind app.`,
      );
      continue;
    }
    if (kind === "pack") {
      add(
        warnings,
        "release",
        at,
        "pack_deliverables_not_supported",
        `pack deliverables are not supported yet; ${id} is ignored.`,
      );
      continue;
    }
    validateAppDeliverable(errors, relRoot, def, at);
  }
}

function validateAppDeliverable(
  errors: ValidationMessage[],
  relRoot: Record<string, unknown>,
  def: Record<string, unknown>,
  at: string,
): void {
  // ── versioning ──
  const versioning = def.versioning;
  if (versioning !== undefined && !isRecord(versioning)) {
    add(
      errors,
      "release",
      `${at}/versioning`,
      "invalid_version_scheme",
      "deliverables.app.versioning must be an object.",
    );
  } else if (isRecord(versioning)) {
    if (
      versioning.scheme !== undefined &&
      !isOneOf(versioning.scheme, VERSION_SCHEMES)
    ) {
      add(
        errors,
        "release",
        `${at}/versioning/scheme`,
        "invalid_version_scheme",
        `versioning.scheme must be one of ${VERSION_SCHEMES.join(", ")}.`,
      );
    }
    if (
      versioning.buildNumber !== undefined &&
      !isOneOf(versioning.buildNumber, BUILD_NUMBER_SOURCES)
    ) {
      add(
        errors,
        "release",
        `${at}/versioning/buildNumber`,
        "invalid_version_scheme",
        `versioning.buildNumber must be one of ${BUILD_NUMBER_SOURCES.join(", ")}.`,
      );
    }
    validateTagFilters(
      errors,
      versioning,
      `${at}/versioning`,
      "deliverables.app.versioning",
    );
    // P0-02 spelled these two at the release root; that spelling stays valid, but a document
    // must pick one. Both at once would make one of them silently win.
    const nested =
      versioning.stableTagPattern !== undefined ||
      versioning.ignoreTags !== undefined;
    const legacy =
      relRoot.stableTagPattern !== undefined ||
      relRoot.ignoreTags !== undefined;
    if (nested && legacy) {
      add(
        errors,
        "release",
        `${at}/versioning`,
        "conflicting_versioning",
        "stableTagPattern and ignoreTags are declared both at the release root and under deliverables.app.versioning; keep one spelling.",
      );
    }
  }

  // ── channels ──
  const channels = def.channels;
  if (channels !== undefined) {
    if (
      !isRecord(channels) ||
      Object.keys(channels).length > MAX_DELIVERABLE_CHANNELS
    ) {
      add(
        errors,
        "release",
        `${at}/channels`,
        "invalid_channel_includes",
        `deliverables.app.channels must be an object of at most ${MAX_DELIVERABLE_CHANNELS} channels.`,
      );
    } else {
      const known = knownChannelNames(relRoot, Object.keys(channels));
      const graph = new Map<string, string[]>();
      for (const [name, decl] of Object.entries(channels)) {
        const cat = `${at}/channels/${name}`;
        if (!isCanonicalChannelName(name)) {
          add(
            errors,
            "release",
            cat,
            "invalid_channel",
            `deliverables.app.channels names must be canonical (${CANONICAL_CHANNEL_PATTERN.source}, and not an alias such as ${CHANNEL_ALIAS_NAMES.join(" or ")}).`,
          );
        }
        if (!isRecord(decl)) {
          add(
            errors,
            "release",
            cat,
            "invalid_channel_includes",
            "each channel must be an object such as { includes: [stable] }.",
          );
          continue;
        }
        if (decl.includes === undefined) continue;
        if (!Array.isArray(decl.includes)) {
          add(
            errors,
            "release",
            `${cat}/includes`,
            "invalid_channel_includes",
            "includes must be an array of channel names.",
          );
          continue;
        }
        const edges: string[] = [];
        for (const [i, inc] of decl.includes.entries()) {
          if (typeof inc !== "string" || !known.has(inc)) {
            add(
              errors,
              "release",
              `${cat}/includes/${i}`,
              "invalid_channel_includes",
              "includes may only name stable, beta, a manual channel or another declared channel.",
            );
          } else edges.push(inc);
        }
        graph.set(name, edges);
      }
      const cycle = findIncludesCycle(graph);
      if (cycle) {
        add(
          errors,
          "release",
          `${at}/channels/${cycle}`,
          "invalid_channel_includes",
          `channel ${cycle} includes itself through its includes chain.`,
        );
      }
    }
  }

  // ── artifacts: the declared map ──
  const artifacts = def.artifacts;
  if (artifacts === undefined) return;
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACT_ENTRIES) {
    add(
      errors,
      "release",
      `${at}/artifacts`,
      "invalid_artifact_entry",
      `deliverables.app.artifacts must be an array of at most ${MAX_ARTIFACT_ENTRIES} entries.`,
    );
    return;
  }
  const seen = new Set<string>();
  for (const [i, entry] of artifacts.entries()) {
    const eat = `${at}/artifacts/${i}`;
    if (!isRecord(entry)) {
      add(
        errors,
        "release",
        eat,
        "invalid_artifact_entry",
        "each artifact entry must be an object { id, platform, arch, format, role?, match }.",
      );
      continue;
    }
    if (
      typeof entry.id !== "string" ||
      !ARTIFACT_ENTRY_ID_PATTERN.test(entry.id)
    ) {
      add(
        errors,
        "release",
        `${eat}/id`,
        "invalid_artifact_entry",
        `artifacts[].id must match ${ARTIFACT_ENTRY_ID_PATTERN.source}.`,
      );
    } else if (seen.has(entry.id)) {
      add(
        errors,
        "release",
        `${eat}/id`,
        "duplicate_artifact_id",
        `artifact id ${entry.id} is declared twice; each entry declares one build.`,
      );
    } else seen.add(entry.id);
    if (!isOneOf(entry.platform, RELEASE_PLATFORMS)) {
      add(
        errors,
        "release",
        `${eat}/platform`,
        "invalid_artifact_platform",
        `artifacts[].platform must be one of ${RELEASE_PLATFORMS.join(", ")}.`,
      );
    }
    if (!isOneOf(entry.arch, RELEASE_ARCHES)) {
      add(
        errors,
        "release",
        `${eat}/arch`,
        "invalid_artifact_arch",
        `artifacts[].arch must be one of ${RELEASE_ARCHES.join(", ")}.`,
      );
    }
    if (
      typeof entry.format !== "string" ||
      !ARTIFACT_FORMAT_PATTERN.test(entry.format)
    ) {
      add(
        errors,
        "release",
        `${eat}/format`,
        "invalid_artifact_entry",
        `artifacts[].format must match ${ARTIFACT_FORMAT_PATTERN.source} (installer versus portable is a format: zip, exe, msi, …).`,
      );
    }
    if (entry.role !== undefined && !isOneOf(entry.role, ARTIFACT_ROLES)) {
      add(
        errors,
        "release",
        `${eat}/role`,
        "invalid_artifact_role",
        `artifacts[].role must be one of ${ARTIFACT_ROLES.join(", ")}.`,
      );
    }
    if (!isArtifactMatch(entry.match)) {
      add(
        errors,
        "release",
        `${eat}/match`,
        "invalid_artifact_match",
        `artifacts[].match must be a file-name glob (* and ?) of 1 to ${MAX_ARTIFACT_MATCH_LENGTH} characters with no control characters.`,
      );
    }
  }
}

/** The first channel on an `includes` cycle (a self-include counts), or null. */
function findIncludesCycle(graph: Map<string, string[]>): string | null {
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const visit = (node: string): string | null => {
    const s = state.get(node);
    if (s === 1) return node;
    if (s === 2) return null;
    state.set(node, 1);
    for (const next of graph.get(node) ?? []) {
      const hit = visit(next);
      if (hit) return hit;
    }
    state.set(node, 2);
    return null;
  };
  for (const node of [...graph.keys()].sort()) {
    const hit = visit(node);
    if (hit) return hit;
  }
  return null;
}

/** `file/pointer: message`, or `file: message` for a whole-document problem (pointer "/"). */
function formatIngestError(e: ValidationMessage): string {
  return `${e.file}${e.path === "/" ? "" : e.path}: ${e.message}`;
}

export function parseManifest(
  files: Record<string, string>,
): ParseManifestResult {
  const errors: string[] = [];
  const docs: Record<string, unknown> = {};
  for (const name of ["schema", "product", "release"] as const) {
    const raw = files[name];
    if (raw === undefined) continue;
    const res = parseDocument(name, raw);
    if ("error" in res) errors.push(res.error);
    else docs[name] = res.value;
  }
  // Missing documents are reported by the same rule `pkey validate` applies
  // (`validateIngestDocuments`), so a manifest that validates is one that links. A schema file
  // that exists but failed to parse is already in `errors`, so it is not also "missing".
  if (files.product === undefined) {
    const missing = validateIngestDocuments({
      product: undefined,
      schema: files.schema === undefined ? undefined : null,
    });
    for (const e of missing.errors) errors.push(formatIngestError(e));
  }
  if (errors.length) return { ok: false, errors };
  if (!isRecord(docs.product))
    return { ok: false, errors: ["product: must be an object"] };

  const validation = validateIngestDocuments({
    product: docs.product,
    schema: docs.schema,
    release: docs.release,
  });
  if (!validation.ok)
    return { ok: false, errors: validation.errors.map(formatIngestError) };

  const productRoot = docs.product;
  const prod = nestedProductDoc(productRoot);
  const licensing = asRecord(productRoot.licensing);
  const catalog = normalizeCatalog(docs.schema) as ManifestCatalog;
  const releaseDoc =
    releaseRoot(docs.release) ?? releaseRoot(productRoot.release);
  const oidcRoot = asRecord(productRoot.oidc);
  const rawProfiles =
    arrayAt(productRoot, "profiles") ?? arrayAt(licensing, "profiles") ?? [];
  const rawTiers =
    arrayAt(productRoot, "tiers") ?? arrayAt(licensing, "tiers") ?? [];
  const rawProvisioning = arrayAt(productRoot, "provisioning") ?? [];
  const rawEdgeMint =
    arrayAt(productRoot, "edgeMint") ??
    arrayAt(asRecord(docs.release), "edgeMint") ??
    [];

  const parsed: ParsedManifest = {
    product: {
      slug: String(prod.slug),
      name: String(prod.name ?? prod.slug),
      compatMin: String(prod.compatMin ?? productRoot.compatMin ?? "0.0.0"),
      compatMax: String(prod.compatMax ?? productRoot.compatMax ?? "99.0.0"),
      defaultMaxOfflineDays: Number(
        prod.defaultMaxOfflineDays ??
          productRoot.defaultMaxOfflineDays ??
          licensing.defaultMaxOfflineDays ??
          30,
      ),
      defaultDeviceLimit: Number(
        prod.defaultDeviceLimit ??
          productRoot.defaultDeviceLimit ??
          licensing.defaultDeviceLimit ??
          5,
      ),
      adminGroup: String(prod.adminGroup ?? productRoot.adminGroup ?? "admin"),
    },
    catalog,
    profiles: rawProfiles.map(normalizeProfile).filter(notNull),
    tiers: rawTiers.map(normalizeTier).filter(notNull),
    provisioning: rawProvisioning.map(normalizeProvisioning).filter(notNull),
    edgeMint: rawEdgeMint.map(normalizeEdgeMint).filter(notNull),
    // The enablement set finally survives parsing. `validation` above already ran the
    // coherence rules over the same list, so this cannot carry an inapplicable combination.
    services: servicesFromModules(validation.enabledModules),
    // Validated above, so every entry is already an exact, canonical origin.
    webOrigins: (arrayAt(asRecord(productRoot.web), "origins") ?? []).filter(
      isString,
    ),
  };

  // Validated above; carried verbatim so the derivation of the default (which depends on the
  // enabled services) stays with the consumer rather than being frozen at ingest.
  const registration = registrationPolicy(productRoot);
  if (isOneOf(registration, REGISTRATION_POLICIES))
    parsed.registration = registration;

  if (productRoot.oidc !== undefined) {
    const provider = isOneOf(oidcRoot.provider, OIDC_PROVIDER_VALUES)
      ? oidcRoot.provider
      : "platform";
    parsed.oidc = {
      provider,
      issuer: String(oidcRoot.issuer ?? ""),
      clientId: String(oidcRoot.clientId ?? ""),
      clientSecretSecret: String(
        oidcRoot.clientSecretSecret ?? oidcRoot.clientSecretRef ?? "",
      ),
      redirectUris: arrayAt(oidcRoot, "redirectUris")?.filter(isString) ?? [],
      groupRoleMap: asRecord(oidcRoot.groupRoleMap),
    };
  }
  if (releaseDoc) parsed.release = normalizeRelease(releaseDoc);
  if (productRoot.fingerprint !== undefined) {
    parsed.fingerprint = normalizeFingerprint(productRoot.fingerprint);
  }
  if (productRoot.autoIssue !== undefined) {
    parsed.autoIssue = normalizeAutoIssue(productRoot.autoIssue);
  }
  return { ok: true, manifest: parsed };
}

function normalizeRelease(rel: Record<string, unknown>): ManifestRelease {
  const provider = asRecord(rel.provider);
  // The tag filters may be spelled at the root (P0-02) or under `deliverables.app.versioning`
  // (P2-04); validation refuses both at once, so at most one of the two is set. Either way they
  // persist to the same `release_config` columns.
  const app = normalizeAppDeliverable(rel.deliverables);
  const versioning = asRecord(
    asRecord(asRecord(rel.deliverables)[APP_DELIVERABLE_ID]).versioning,
  );
  const filters =
    versioning.stableTagPattern !== undefined ||
    versioning.ignoreTags !== undefined
      ? versioning
      : rel;
  return {
    ghOwner: String(rel.ghOwner ?? provider.owner ?? ""),
    ghRepo: String(rel.ghRepo ?? provider.repo ?? ""),
    binaryName: String(rel.binaryName ?? ""),
    channelWorkflow: String(rel.channelWorkflow ?? ""),
    betaBranch: String(rel.betaBranch ?? "main"),
    summaryMarker: String(rel.summaryMarker ?? "pkey:summary"),
    sparkleEd25519Pub: String(rel.sparkleEd25519Pub ?? ""),
    manualChannels: normalizeManualChannels(rel.manualChannels),
    stableTagPattern:
      typeof filters.stableTagPattern === "string" &&
      compileManualChannelRegex(filters.stableTagPattern) !== null
        ? filters.stableTagPattern
        : null,
    ignoreTags: normalizeIgnoreTags(filters.ignoreTags),
    artifactPolicy: normalizeArtifactPolicy(rel.artifactPolicy),
    access: normalizeReleaseAccess(rel.access),
    app,
  };
}

/**
 * Read back a persisted app declaration (`release_deliverables.def_json`, which resync writes
 * from `ManifestRelease.app`). `null` for NULL, unparseable or non-app JSON — the implicit app
 * deliverable, with legacy sniffing.
 */
export function parseManifestAppDeliverable(
  defJson: string | null | undefined,
): ManifestAppDeliverable | null {
  if (!defJson) return null;
  try {
    return normalizeAppDeliverable({
      [APP_DELIVERABLE_ID]: JSON.parse(defJson),
    });
  } catch {
    return null;
  }
}

/**
 * `deliverables.app`, as validated. `null` when the document has no `deliverables` block, or one
 * without an `app` entry (packs alone are ignored until P4-02): the implicit app deliverable.
 */
function normalizeAppDeliverable(raw: unknown): ManifestAppDeliverable | null {
  const def = asRecord(raw)[APP_DELIVERABLE_ID];
  if (!isRecord(def) || def.kind !== "app") return null;
  const versioning = asRecord(def.versioning);
  const channels: Record<string, ManifestDeliverableChannel> = {};
  for (const [name, decl] of Object.entries(asRecord(def.channels))) {
    if (!isCanonicalChannelName(name) || !isRecord(decl)) continue;
    channels[name] = {
      includes: (arrayAt(decl, "includes") ?? []).filter(isString),
    };
  }
  const artifacts: ManifestArtifactEntry[] = [];
  for (const entry of arrayAt(def, "artifacts") ?? []) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !isOneOf(entry.platform, RELEASE_PLATFORMS) ||
      !isOneOf(entry.arch, RELEASE_ARCHES) ||
      typeof entry.format !== "string" ||
      !isArtifactMatch(entry.match)
    )
      continue;
    artifacts.push({
      id: entry.id,
      platform: entry.platform,
      arch: entry.arch,
      format: entry.format,
      role: isOneOf(entry.role, ARTIFACT_ROLES) ? entry.role : "payload",
      match: entry.match,
    });
  }
  return {
    kind: "app",
    versioning: {
      scheme: isOneOf(versioning.scheme, VERSION_SCHEMES)
        ? versioning.scheme
        : "semver",
      buildNumber: isOneOf(versioning.buildNumber, BUILD_NUMBER_SOURCES)
        ? versioning.buildNumber
        : null,
    },
    channels,
    artifacts,
  };
}

/** Keep exactly the entries the runtime reader would: valid name, safe compilable regex.
 *  Drop-the-malformed mirrors `parseManualChannels` (validation has already reported them). */
function normalizeManualChannels(raw: unknown): ManifestManualChannel[] {
  if (!Array.isArray(raw)) return [];
  const out: ManifestManualChannel[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { name, regex } = entry;
    if (
      typeof name === "string" &&
      CHANNEL_RE.test(name) &&
      typeof regex === "string" &&
      compileManualChannelRegex(regex) !== null
    ) {
      out.push({ name, regex });
    }
  }
  return out;
}

/** Keep the well-formed, de-duplicated entries (validation has already reported the rest). */
function normalizeIgnoreTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isIgnoreTag))].slice(0, MAX_IGNORE_TAGS);
}

function normalizeReleaseAccess(raw: unknown): ManifestReleaseAccessPolicy {
  if (!isRecord(raw)) return { ...DEFAULT_RELEASE_ACCESS };
  return {
    metadata: normalizeReleaseAccessValue(
      raw.metadata,
      DEFAULT_RELEASE_ACCESS.metadata,
    ),
    artifacts: normalizeReleaseAccessValue(
      raw.artifacts,
      DEFAULT_RELEASE_ACCESS.artifacts,
    ),
  };
}

function normalizeReleaseAccessValue(
  raw: unknown,
  fallback: ManifestReleaseAccess,
): ManifestReleaseAccess {
  if (!isOneOf(raw, RELEASE_ACCESS_VALUES)) return fallback;
  return raw;
}

function normalizeArtifactPolicy(
  raw: unknown,
): ManifestReleaseArtifactPolicy | null {
  if (!isRecord(raw)) return null;
  return {
    channels: arrayAt(raw, "channels")?.filter(isString) ?? [],
    architectures: arrayAt(raw, "architectures")?.filter(isString) ?? [],
    requireDmg: raw.requireDmg === true,
    requireCli: raw.requireCli === true,
    // `requireSparkleSignature` is intentionally dropped, not copied: see the interface note.
    allowAmbiguousAssets: raw.allowAmbiguousAssets === true,
  };
}

function normalizeProfile(raw: unknown): ManifestProfile | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0)
    return null;
  const id = raw.id;
  return {
    id,
    name: String(raw.name ?? raw.label ?? id),
    description: typeof raw.description === "string" ? raw.description : null,
    payload: asRecord(raw.payload),
  };
}

function normalizeTier(raw: unknown): ManifestTier | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0)
    return null;
  const id = raw.id;
  return {
    id,
    label: String(raw.label ?? id),
    profileId:
      typeof raw.profileId === "string"
        ? raw.profileId
        : typeof raw.profile === "string"
          ? raw.profile
          : null,
    policyExpiryDays:
      typeof raw.policyExpiryDays === "number"
        ? raw.policyExpiryDays
        : typeof raw.expiryDays === "number"
          ? raw.expiryDays
          : typeof raw.maxOfflineDays === "number"
            ? raw.maxOfflineDays
            : null,
    policyDeviceLimit:
      typeof raw.policyDeviceLimit === "number" ? raw.policyDeviceLimit : null,
    policyFingerprint: isOneOf(raw.policyFingerprint, FINGERPRINT_MODE_VALUES)
      ? raw.policyFingerprint
      : null,
    channels: arrayAt(raw, "channels")?.filter(isString) ?? [],
    minVersion: typeof raw.minVersion === "string" ? raw.minVersion : null,
    maxVersion: typeof raw.maxVersion === "string" ? raw.maxVersion : null,
  };
}

function normalizeProbe(raw: unknown): ManifestProbe | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    return null;
  }
  const probe: ManifestProbe = {
    id: raw.id,
    label: typeof raw.label === "string" ? raw.label : raw.id,
  };
  if (typeof raw.macos === "string") probe.macos = raw.macos;
  if (typeof raw.windows === "string") probe.windows = raw.windows;
  if (typeof raw.linux === "string") probe.linux = raw.linux;
  return probe;
}

function normalizeFingerprint(raw: unknown): ManifestFingerprint {
  const record = isRecord(raw) ? raw : {};
  return {
    // Fingerprinting is ON unless a product explicitly opts out.
    enabled: record.enabled === false ? false : true,
    defaultMode: isOneOf(record.defaultMode, FINGERPRINT_MODE_VALUES)
      ? record.defaultMode
      : "normal",
    probes: (arrayAt(record, "probes") ?? [])
      .map(normalizeProbe)
      .filter(notNull),
  };
}

/** Exported so the fail-closed guarantee is directly assertable (and for non-manifest
 *  callers that normalize a policy without running document validation first). */
export function normalizeAutoIssue(raw: unknown): ManifestAutoIssue {
  const record = isRecord(raw) ? raw : {};
  const tierId =
    typeof record.tierId === "string" && record.tierId ? record.tierId : null;
  // An OMITTED mode defaults to "anonymous"; an unrecognized one is null here and disables
  // the whole policy below. The distinction matters: "anonymous" is the mode that opens the
  // keyless enroll endpoint, so falling back to it on garbage would fail OPEN. On the
  // manifest path `validateManifestDocuments` now rejects a bad mode outright
  // (invalid_auto_issue_mode) before this runs; this guard keeps every other caller of the
  // normalizer fail-closed too.
  const mode =
    record.mode === undefined
      ? "anonymous"
      : isOneOf(record.mode, AUTO_ISSUE_MODE_VALUES)
        ? record.mode
        : null;
  return {
    // A policy with no tier can't issue anything coherent, and a policy with an
    // unrecognizable mode can't be honoured coherently either — both count as disabled
    // rather than quietly minting licenses under a policy nobody wrote.
    enabled: record.enabled === true && tierId !== null && mode !== null,
    tierId,
    mode: mode ?? "anonymous",
    rateLimitPerHour:
      typeof record.rateLimitPerHour === "number" &&
      record.rateLimitPerHour >= 0
        ? Math.trunc(record.rateLimitPerHour)
        : 10,
  };
}

function normalizeProvisioning(raw: unknown): ManifestProvisioning | null {
  if (
    !isRecord(raw) ||
    typeof raw.claim !== "string" ||
    raw.claim.length === 0
  ) {
    return null;
  }
  const claim = raw.claim;
  return {
    claim,
    entitlementKey:
      typeof raw.entitlementKey === "string" ? raw.entitlementKey : undefined,
    entitlementValue: raw.entitlementValue,
    secretKey: typeof raw.secretKey === "string" ? raw.secretKey : undefined,
    secretUrlTemplate:
      typeof raw.secretUrlTemplate === "string"
        ? raw.secretUrlTemplate
        : undefined,
    allowedHosts: arrayAt(raw, "allowedHosts")?.filter(isString),
  };
}

function normalizeEdgeMint(raw: unknown): ManifestEdgeMint | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0)
    return null;
  const id = raw.id;
  return {
    id,
    alg: String(raw.alg ?? ""),
    signingKeySecret: String(raw.signingKeySecret ?? ""),
    kid: typeof raw.kid === "string" ? raw.kid : undefined,
    claimsTemplate: asRecord(raw.claimsTemplate),
    ttlSeconds: typeof raw.ttlSeconds === "number" ? raw.ttlSeconds : 3600,
    audience: typeof raw.audience === "string" ? raw.audience : null,
  };
}

function collectRequiredSecrets(
  secrets: Record<string, unknown>,
  product: Record<string, unknown>,
  release: unknown,
): string[] {
  const names = new Set<string>();
  const required = arrayAt(secrets, "required") ?? [];
  for (const item of required) {
    if (isRecord(item) && typeof item.name === "string" && item.name) {
      names.add(item.name);
    } else if (typeof item === "string") names.add(item);
  }
  const oidc = asRecord(product.oidc);
  const oidcSecret = oidc.clientSecretSecret ?? oidc.clientSecretRef;
  const oidcProvider =
    isOneOf(oidc.provider, OIDC_PROVIDER_VALUES) && oidc.provider === "custom"
      ? "custom"
      : "platform";
  if (oidcProvider === "custom" && typeof oidcSecret === "string" && oidcSecret)
    names.add(oidcSecret);
  const edgeMint =
    arrayAt(product, "edgeMint") ??
    arrayAt(asRecord(release), "edgeMint") ??
    [];
  for (const item of edgeMint) {
    if (!isRecord(item)) continue;
    const ref = item.signingKeySecret;
    if (typeof ref === "string" && ref) names.add(ref);
  }
  return [...names].sort();
}

function parseDocument(
  name: string,
  raw: string,
): { value: unknown } | { error: string } {
  // Size first: this runs on bytes fetched from a third party's repo in response to a webhook,
  // so nothing expensive may happen before the cap is checked (R7-02).
  if (overByteCap(raw)) {
    return {
      error: `${name}: larger than the ${MAX_MANIFEST_BYTES}-byte .pkey/ document limit`,
    };
  }
  let value: unknown;
  let parsed = false;
  try {
    value = JSON.parse(raw);
    parsed = true;
  } catch {
    // fall through to YAML
  }
  if (!parsed) {
    try {
      // `uniqueKeys: false` drops the duplicate-key scan, which is what makes the parse
      // quadratic in key count (34× faster on the 40 000-key input measured in R7-02).
      // Nothing downstream depends on duplicate-key *rejection*: every field is read by an
      // explicit key lookup after the parse, and last-wins is deterministic. `maxAliasCount`
      // is pinned rather than inherited so an upstream default change cannot widen it.
      value = parseYaml(raw, {
        uniqueKeys: false,
        maxAliasCount: MAX_YAML_ALIASES,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `${name}: not valid JSON or YAML (${msg})` };
    }
  }
  if (exceedsDepth(value, MAX_MANIFEST_DEPTH)) {
    return {
      error: `${name}: nested deeper than ${MAX_MANIFEST_DEPTH} levels`,
    };
  }
  return { value };
}

/** Is this document over {@link MAX_MANIFEST_BYTES} once encoded as UTF-8? */
function overByteCap(raw: string): boolean {
  // `raw.length` counts UTF-16 code units and is never greater than the UTF-8 byte length, so
  // an oversized document is rejected here without allocating an encoder buffer for it.
  if (raw.length > MAX_MANIFEST_BYTES) return true;
  return new TextEncoder().encode(raw).length > MAX_MANIFEST_BYTES;
}

/** Iterative (never recursive — the input is hostile) structural-depth check. The node count
 *  is bounded by the byte cap, so the walk itself is cheap. */
function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 1 },
  ];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > max) return true;
    const children = Array.isArray(node)
      ? node
      : Object.values(node as Record<string, unknown>);
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

function normalizeCatalog(parsed: unknown): ProductCatalog | null {
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.entries)) return parsed as unknown as ProductCatalog;
  if (Array.isArray(parsed.catalog)) {
    return {
      schemaVersion: Number(parsed.schemaVersion ?? 1),
      entries: parsed.catalog,
    } as unknown as ProductCatalog;
  }
  return null;
}

function validateCatalogShape(catalog: ProductCatalog): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  if (!nonNegativeInteger(catalog.schemaVersion)) {
    issues.push("catalog.schemaVersion must be a non-negative integer.");
  }
  for (const [i, raw] of catalog.entries.entries()) {
    if (!isRecord(raw)) {
      issues.push(`entries[${i}] must be an object.`);
      continue;
    }
    const entry = raw;
    for (const field of ["key", "category", "label"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        issues.push(`entries[${i}].${field} must be a non-empty string.`);
      }
    }
    if (typeof entry.description !== "string") {
      issues.push(`entries[${i}].description must be a string.`);
    }
    if (!["config", "secret", "flag"].includes(String(entry.kind ?? ""))) {
      issues.push(`entries[${i}].kind must be config, secret, or flag.`);
    }
    if (entry.delivery !== undefined) {
      if (entry.kind !== "secret") {
        issues.push(`entries[${i}].delivery is only valid for secret entries.`);
      } else if (!isOneOf(entry.delivery, SECRET_DELIVERY_VALUES)) {
        issues.push(
          `entries[${i}].delivery must be serverOnly, clientScoped, or edgeMint.`,
        );
      }
    }
    // Documented CONFIG-only from day one; on any other kind the worker ignores it, so a
    // manifest carrying one is declaring an intent nothing will honour.
    if (entry.managementDefault !== undefined) {
      if (entry.kind !== "config") {
        issues.push(
          `entries[${i}].managementDefault is only valid for config entries.`,
        );
      } else if (!isOneOf(entry.managementDefault, MANAGEMENT_STATE_VALUES)) {
        issues.push(
          `entries[${i}].managementDefault must be default, enforced, or hidden.`,
        );
      }
    }
    if (typeof entry.key === "string") {
      if (!ID_RE.test(entry.key))
        issues.push(`entries[${i}].key is not valid.`);
      if (keys.has(entry.key)) issues.push(`entries[${i}].key is duplicated.`);
      keys.add(entry.key);
    }
    if (!isRecord(entry.schema)) {
      issues.push(`entries[${i}].schema must be an object.`);
      continue;
    }
    const type = entry.schema.type;
    if (
      type !== undefined &&
      !(
        typeof type === "string" ||
        (Array.isArray(type) && type.every((v) => typeof v === "string"))
      )
    ) {
      issues.push(
        `entries[${i}].schema.type must be a string or string array.`,
      );
    }
  }
  return issues;
}

/**
 * Enforce a character class on an optional manifest string. Absent/empty means "unset" (the
 * worker substitutes its own default), so only present values are checked — but a present
 * value that fails the class is a hard error, never a coerced one.
 */
function constrained(
  errors: ValidationMessage[],
  file: ValidationMessage["file"],
  value: unknown,
  path: string,
  code: string,
  re: RegExp,
  message: string,
): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string" || !re.test(value)) {
    add(errors, file, path, code, message);
  }
}

/** The release-file flavour of {@link constrained} (R6-01, R6-07). */
function releaseString(
  errors: ValidationMessage[],
  value: unknown,
  path: string,
  code: string,
  re: RegExp,
  message: string,
): void {
  constrained(errors, "release", value, path, code, re, message);
}

/**
 * Bound a free-text manifest string: length-capped and free of control characters. Labels and
 * descriptions are legitimately unicode prose, so they get a length + control-character bound
 * rather than a character class.
 */
function boundedText(
  errors: ValidationMessage[],
  file: ValidationMessage["file"],
  value: unknown,
  path: string,
  code: string,
  max: number,
  label: string,
): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    add(errors, file, path, code, `${label} must be a string.`);
    return;
  }
  if (value.length > max || CONTROL_CHAR_RE.test(value)) {
    add(
      errors,
      file,
      path,
      code,
      `${label} must be at most ${max} characters and free of control characters.`,
    );
  }
}

/** Apply a character class to every entry of an optional string array. */
function constrainedList(
  errors: ValidationMessage[],
  file: ValidationMessage["file"],
  values: unknown,
  path: string,
  code: string,
  re: RegExp,
  message: string,
): void {
  if (!Array.isArray(values)) return;
  for (const [i, value] of values.entries()) {
    if (typeof value !== "string" || !re.test(value)) {
      add(errors, file, `${path}/${i}`, code, message);
    }
  }
}

function releaseRoot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.release) ? value.release : value;
}

function nestedProductDoc(p: Record<string, unknown>): Record<string, unknown> {
  return isRecord(p.product) ? p.product : p;
}

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arrayAt(
  v: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  return Array.isArray(v[key]) ? v[key] : undefined;
}

function stringAt<T extends Record<string, unknown>>(
  v: T | undefined,
  key: string,
): v is T & Record<typeof key, string> {
  return typeof v?.[key] === "string" && v[key].length > 0;
}

function isUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// ── Browser origins (P0-05) ──────────────────────────────────────────────────

/**
 * Why is this `web.origins` entry unacceptable? Returns a human-readable reason, or `null` when
 * the value is an exact origin the worker may echo in `Access-Control-Allow-Origin`.
 *
 * Two layers, both required. {@link WEB_ORIGIN_RE} bounds the characters (and is what the JSON
 * Schema mirrors); the `URL` round trip then proves the value is already the browser's own
 * serialization — `https://a.example:443` and `https://a.example:0443` pass the pattern but
 * serialize to `https://a.example`, so a browser would never send them and they are refused.
 * A port above 65535 fails the parse outright.
 */
export function webOriginProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "must be an origin string such as https://app.example.com";
  }
  if (value.length > MAX_WEB_ORIGIN_LENGTH) {
    return `must be at most ${MAX_WEB_ORIGIN_LENGTH} characters`;
  }
  if (!WEB_ORIGIN_RE.test(value)) {
    return (
      "must be a lower-case https://<host>[:port] origin with no path, query, fragment, " +
      "credentials or wildcard (http is accepted only for localhost and 127.0.0.1)"
    );
  }
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return "must be a parseable origin with a port no greater than 65535";
  }
  if (origin !== value) {
    return `must be written exactly as a browser sends it (${origin})`;
  }
  return null;
}

/** Convenience predicate over {@link webOriginProblem}; the worker re-checks stored rows with
 *  it so a row written by any path other than manifest ingest cannot widen the allowlist. */
export function isWebOrigin(value: unknown): value is string {
  return webOriginProblem(value) === null;
}

// ── Outbound-URL safety (R9-01 / R9-02) ──────────────────────────────────────
// `oidc.issuer` is not a label: it is the *base of a request the platform makes with the
// product's OIDC client secret in the body* (`worker/src/oidc.ts` — `/api/oidc/token`), the
// base of the JWKS fetch that decides which keys may sign an ID token, and the host an
// anonymous visitor is 302'd to by `/<product>/auth/start`. "Is an absolute http(s) URL" was
// the entire check, so a `.pkey/` push could name `https://exfil.attacker.example` or
// `http://169.254.169.254/`. These predicates are the fix, and `worker/src/oidc.ts` runs the
// same one again at the sink so rows written before this landed cannot steer either request.

/** The only hosts a manifest may name over plain `http:` — the local-development carve-out.
 *  Written as exact literals, not as `127.0.0.0/8`, so `http://127.0.0.2` stays rejected. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IPV4_LITERAL_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/**
 * Why is this issuer unacceptable? Returns a human-readable reason, or `null` when the value
 * may be used as the base of an outbound OIDC request.
 *
 * Note the residual: this bounds *address literals*, not DNS. A hostname whose A record points
 * at 169.254.169.254 still resolves at fetch time (classic DNS rebinding), which is why the
 * follow-up in `docs/security/findings/R9-injection.md` recommends an operator allowlist.
 */
export function issuerUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "must be an absolute https URL";
  }
  if (value.length > MAX_URL_LENGTH) {
    return `must be at most ${MAX_URL_LENGTH} characters`;
  }
  if (CONTROL_CHAR_RE.test(value)) return "must not contain control characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute https URL";
  }
  if (url.username || url.password) return "must not embed credentials";
  if (url.search || url.hash) {
    // The sink builds `${issuer}/api/oidc/token` by concatenation, so a query or fragment on
    // the issuer silently swallows the path it is supposed to prefix.
    return "must not carry a query string or fragment";
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must use https (http is accepted only for localhost during development)";
  }
  if (!loopback && isReservedAddressLiteral(url.hostname)) {
    return "must not be a private, loopback, link-local, or otherwise reserved address";
  }
  return null;
}

/** Convenience predicate over {@link issuerUrlProblem}. Re-exported to the Worker so the sink
 *  can re-check a stored `oidc_config.issuer` with exactly this rule. */
export function isSafeIssuerUrl(value: unknown): value is string {
  return issuerUrlProblem(value) === null;
}

/** Is this URL host an address literal in a range the platform must never dial? */
function isReservedAddressLiteral(hostname: string): boolean {
  const v4 = hostname.match(IPV4_LITERAL_RE);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    // Out-of-range octets are not a real address; refuse rather than guess what it means.
    if (octets.some((o) => o > 255)) return true;
    return isReservedIpv4(octets as [number, number, number, number]);
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const bytes = parseIpv6(hostname.slice(1, -1));
    return bytes ? isReservedIpv6(bytes) : true;
  }
  return false;
}

/** RFC 1918 / 5735 / 6598 special-use IPv4 space, plus multicast and reserved. */
function isReservedIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Unspecified / loopback / unique-local / link-local / multicast IPv6, and the embedded-IPv4
 *  forms that would otherwise smuggle a reserved v4 address past the v4 checks. */
function isReservedIpv6(b: Uint8Array): boolean {
  const leadingZeros = (n: number): boolean =>
    b.subarray(0, n).every((x) => x === 0);
  if (leadingZeros(16)) return true; // ::
  if (leadingZeros(15) && b[15] === 1) return true; // ::1
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated).
  if (leadingZeros(10) && b[10] === 0xff && b[11] === 0xff) {
    return isReservedIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
  }
  if (leadingZeros(12)) {
    return isReservedIpv4([b[12]!, b[13]!, b[14]!, b[15]!]);
  }
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

/** Expand an IPv6 literal (compressed or not, with an optional trailing dotted-quad) to its
 *  16 bytes. Returns null when the text is not a well-formed address. */
function parseIpv6(text: string): Uint8Array | null {
  const bare = text.split("%")[0] ?? ""; // drop any zone id
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = expandIpv6Groups(halves[0] ?? "");
  const tail = halves.length === 2 ? expandIpv6Groups(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (head.length + tail.length > 16) return null;
  // Without a `::` the address must already be complete.
  if (halves.length === 1 && head.length !== 16) return null;
  const bytes = new Uint8Array(16);
  bytes.set(head, 0);
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

function expandIpv6Groups(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  const groups = part.split(":");
  for (const [i, group] of groups.entries()) {
    const v4 = group.match(IPV4_LITERAL_RE);
    if (v4) {
      // A dotted-quad is only legal as the final group (`::ffff:169.254.169.254`).
      if (i !== groups.length - 1) return null;
      const octets = v4.slice(1).map(Number);
      if (octets.some((o) => o > 255)) return null;
      out.push(octets[0]!, octets[1]!, octets[2]!, octets[3]!);
      continue;
    }
    if (!IPV6_GROUP_RE.test(group)) return null;
    const word = Number.parseInt(group, 16);
    out.push(word >> 8, word & 0xff);
  }
  return out;
}

/**
 * Why is this redirect URI unacceptable? Redirect URIs are *our own* callback URLs handed to
 * the IdP, so loopback stays legal (native/desktop apps genuinely use `http://127.0.0.1:<port>`)
 * — but credentials, control characters, and unbounded length do not.
 */
function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || !isUrl(value)) {
    return "must be an absolute http(s) URL";
  }
  if (value.length > MAX_URL_LENGTH) {
    return `must be at most ${MAX_URL_LENGTH} characters`;
  }
  if (CONTROL_CHAR_RE.test(value)) return "must not contain control characters";
  const url = new URL(value);
  if (url.username || url.password) return "must not embed credentials";
  return null;
}

/**
 * Why is this secret-URL template unacceptable? `provisioning[].secretUrlTemplate` is handed
 * to the client as a "secret" value after `{claim}` substitution (`oidc.ts` — the
 * `secret_url_template` branch), so it must be a real https endpoint and its *host* must be
 * fixed at ingest: a `{claim}` inside the host would let a token claim retarget it.
 */
function secretUrlTemplateProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "must be an absolute https URL";
  }
  if (value.length > MAX_URL_LENGTH) {
    return `must be at most ${MAX_URL_LENGTH} characters`;
  }
  if (CONTROL_CHAR_RE.test(value)) return "must not contain control characters";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute https URL";
  }
  if (url.username || url.password) return "must not embed credentials";
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "must use https (http is accepted only for localhost during development)";
  }
  if (url.hostname.includes("{") || url.hostname.includes("}")) {
    return "must not place the {claim} placeholder in the host";
  }
  return null;
}

function positiveInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function nonNegativeInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

function add(
  list: ValidationMessage[],
  file: ValidationMessage["file"],
  path: string,
  code: string,
  message: string,
): void {
  list.push({ file, path, code, message });
}

// The release descriptor (P2-04): its contract, validator and helpers.
export * from "./descriptor.js";
