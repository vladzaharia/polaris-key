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
import type { AdminSession } from "../../core/adminApi.js";
import { handleReleaseRoutes } from "./routes.js";
import { handleReleaseAdmin } from "./admin.js";
import { getReleaseConfig } from "./config.js";
import { bytesHostname } from "../../core/bytesHost.js";
import { releaseCatalog } from "./catalog.js";

export const releaseService: ServiceDescriptor = {
  slug: "release",
  handle: handleReleaseRoutes,
  adminHandle: (ctx: ServiceContext & { session: AdminSession }) =>
    handleReleaseAdmin(ctx),
  /**
   * The `releaseCatalog` descriptor hook (`core/hooks.ts`): the read-only view of what exists
   * that Distribution and later consumers read through Core instead of importing this service.
   */
  releaseCatalog,
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
      },
    };
  },
};

// ── The service's public face ────────────────────────────────────────────────
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
