/// <reference types="@cloudflare/workers-types" />

/**
 * The Release service descriptor — TRUTH, not feed (design spec §5.1, D-05).
 *
 * Release owns where a product's software comes from and what it is: the GitHub link, the
 * channel rules, the artifacts, the changelog, the installer, and the truth store those are
 * recorded in. Update renders a feed OVER this (`services/update/`), which is why
 * `update → release` is the one sanctioned cross-service import and why nothing here points
 * back the other way. Every other reader — Distribution first — goes through the
 * `releaseCatalog` hook below, which Core gates on this service's enablement.
 */

import type {
  DiscoveryContext,
  ServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type { AdminSession } from "../../core/console/session.js";
import { handleReleaseRoutes } from "./routes.js";
import { handleReleaseAdmin } from "./admin.js";
import { getReleaseConfig } from "./config.js";
import { bytesHostname } from "../../core/assets/bytesHost.js";
import { releaseCatalog } from "./catalog.js";
import { releaseKeyFingerprints } from "./records.js";
import { sweepNativeSessions } from "./packages/native/index.js";
import { RELEASE_SETTINGS_SLICE } from "./settings.js";

export const releaseService: ServiceDescriptor = {
  slug: "release",
  /** ST-03: this service's settings registry slice (`settings.ts`). */
  settings: RELEASE_SETTINGS_SLICE,
  handle: handleReleaseRoutes,
  adminHandle: (ctx: ServiceContext & { session: AdminSession }) =>
    handleReleaseAdmin(ctx),
  /**
   * The `releaseCatalog` descriptor hook (`core/hooks.ts`): the read-only view of what exists
   * that Distribution and later consumers read through Core instead of importing this service.
   */
  releaseCatalog,
  /**
   * F-22: the connector cron's sweep of native-client upload sessions (twine and Maven send a
   * version as several requests): publish the sessions left idle, fail the abandoned ones, purge
   * finished rows (`packages/native/sessions.ts`). One indexed read for a product with none.
   */
  scheduled: async (ctx) => ({ nativeUploads: await sweepNativeSessions(ctx) }),
  /**
   * Release's slice of `/.well-known/polaris.json` (design spec §4.3).
   *
   * `configured` is separate from `enabled` on purpose: a product can consent to the service
   * (spec §2.2) before anybody has linked a repo, and a client that cannot tell "on but not set
   * up" from "on and serving" will retry a 404 forever.
   *
   * The URLs advertised are the CANONICAL ones (§R1), not the permanent aliases: an alias exists
   * so shipped `SUFeedURL`s and published curl-pipe URLs keep working, not so new clients learn
   * it. Discovery is where a compatibility path stops being advertised first.
   */
  discoveryFragment: async ({ product, db, env, base }: DiscoveryContext) => {
    const cfg = await getReleaseConfig(db, product.slug);
    // The byte routes (P2-05) are advertised on the bytes host when there is one, so a client
    // downloads from `dl.plrs.im` and never from the origin that holds the console's sessions.
    const bytesBase =
      bytesHostname(env) && env.BLOB_ORIGIN
        ? `${new URL(env.BLOB_ORIGIN).origin}/${product.slug}`
        : base;
    return {
      enabled: true,
      configured: Boolean(cfg),
      binaryName: cfg?.binary_name ?? product.slug,
      repository:
        cfg?.gh_owner && cfg.gh_repo
          ? { owner: cfg.gh_owner, name: cfg.gh_repo }
          : null,
      // `install`, `download`, `builds` and `blobs` are Distribution's routes since P2b-04, and
      // Distribution's fragment advertises their CANONICAL `/<p>/distribution/…` URLs. These four
      // keys stay because the discovery document is wire (removing a key is a plan-mode change,
      // `test/discoveryGolden.test.ts`); the URLs they name are permanent router aliases that
      // answer byte-identically, so a client reading them keeps working.
      endpoints: {
        changelog: `${base}/release/changelog`,
        install: `${base}/release/install.sh`,
        download: `${base}/release/dl`,
        // Templated: `{selector}` is a channel or a version, `{buildId}` an artifact-map id.
        builds: `${bytesBase}/release/builds/{selector}/{buildId}`,
        blobs: `${bytesBase}/release/blobs/sha256/{sha256}`,
        // P3-03: a CI-signed release record by the lowercase hex SHA-256 a feed pins.
        record: `${base}/release/records/{sha256}`,
      },
      // P3-03: lowercase hex SHA-256 of each declared release key's raw bytes, for tooling
      // (`pkey release keys check`). No SDK reads it: apps pin their release keys at build time.
      releaseKeyFingerprints: await releaseKeyFingerprints(cfg),
      // P4-02: this Worker ingests pack records and mirrors app releases' pins. The CLI refuses
      // to publish a pack or stamp `content` without it, so no app record carries pins a Worker
      // did not mirror.
      packs: true,
      // P4-22: this Worker ingests a pack variant's `chunks` (a `pkey-chunks/1` index, parsed and
      // its bundles held by the pack) and keeps every bundle a live index names. The CLI omits
      // `chunks` without it, so no record carrying one lands on a Worker that does not check it.
      chunks: true,
      // P4-13: this Worker ingests CI-signed `kind: revocation` records, serves them on the
      // record route and lists them in the channel feed. `pkey release revoke` requires it.
      revocations: true,
      // P4-19: this Worker ingests `kind: delegation` records and delegated pack records, serves
      // delegations on the record route and answers `…/release/publish/delegations`.
      // `pkey release delegate` and a content-key publish require it.
      delegations: true,
    };
  },
};

// ── The service's public face ────────────────────────────────────────────────
/** F-22: the native publish routes on the registry host (`mount.ts` adds them to
 *  `REGISTRY_ROUTES`), and their OpenAPI rows (`routeCoverage`). */
export {
  NATIVE_PUBLISH_ROUTES as RELEASE_PUBLISH_ROUTES,
  NATIVE_PUBLISH_OPENAPI as RELEASE_PUBLISH_OPENAPI,
} from "./packages/native/index.js";
/** F-23: the OCI push routes on the registry host, and their OpenAPI rows. */
export {
  OCI_PUSH_OPENAPI as RELEASE_REGISTRY_OPENAPI,
  OCI_PUSH_ROUTES as RELEASE_REGISTRY_ROUTES,
} from "./packages/ociPush.js";
export { handleRelease, type ReleaseSurfaceKind } from "./surfaces.js";
export {
  accessModeFor,
  artifactPolicy,
  getReleaseConfig,
  isResolved,
  isReleaseAccess,
  readAccessMode,
  RELEASE_ACCESS_MODES,
  type ArtifactPolicy,
  type ReleaseConfigRow,
  type ReleaseKind,
  type ResolvedConfig,
} from "./config.js";
export type { ReleaseParams } from "./access.js";
