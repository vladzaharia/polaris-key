/// <reference types="@cloudflare/workers-types" />

/**
 * The Update service descriptor — the FEED over Release's truth (design spec §5.1, D-05).
 *
 * Update owns the Sparkle appcast, the version check, and the eligibility rules that decide
 * which build a given caller is offered. It owns no tables: every row it reads is Release's,
 * which is why `update → release` is the one sanctioned cross-service import in the worker.
 *
 * The chain is release ← distribution ← update (README §3.2): `validateServices` refuses Update
 * without Distribution (`update_requires_distribution`), and Distribution without Release, so
 * Update never runs over an empty truth store. What Distribution knows (transports,
 * availability, outlet capabilities) reaches Update only through Core's descriptor hooks
 * (`ctx.hooks.delivery()`, `ctx.hooks.outletCapabilities()`), which answer `null` while
 * Distribution is off — never through an import.
 */

import type {
  DiscoveryContext,
  ServiceContext,
  ServiceDescriptor,
} from "../../core/registry.js";
import type { AdminSession } from "../../core/adminApi.js";
import { getReleaseConfig } from "../release/config.js";
import { parseManualChannels } from "../release/channels.js";
import { handleUpdateRoutes } from "./routes.js";
import { handleUpdateAdmin } from "./admin.js";

export const updateService: ServiceDescriptor = {
  slug: "update",
  handle: handleUpdateRoutes,
  adminHandle: (ctx: ServiceContext & { session: AdminSession }) =>
    handleUpdateAdmin(ctx),
  /**
   * Update's slice of `/.well-known/polaris.json` (design spec §4.3): the feed URLs, the channels
   * a client may ask for, and the Sparkle public key an app bundle should be pinning.
   *
   * The CANONICAL URLs are advertised, not the permanent aliases — an alias exists so shipped
   * `SUFeedURL` values keep resolving, not so new clients learn it. `arch` is documented as a
   * parameter rather than enumerated into four URLs: a client knows its own architecture, and
   * listing the cross product would imply the un-parameterised feed is something other than the
   * arm64 one it has always been.
   */
  discoveryFragment: async ({ product, db, base }: DiscoveryContext) => {
    const cfg = await getReleaseConfig(db, product.slug);
    return {
      enabled: true,
      configured: Boolean(cfg),
      channels: cfg
        ? [
            "stable",
            "beta",
            ...parseManualChannels(cfg.manual_channels_json).map((c) => c.name),
          ]
        : [],
      sparkleEd25519PublicKey: cfg?.sparkle_ed25519_pub ?? null,
      endpoints: {
        version: `${base}/update/version`,
        appcast: `${base}/update/appcast.xml`,
        channelAppcast: `${base}/update/{channel}/appcast.xml`,
      },
      /** `?arch=` on either appcast URL; omitted means `arm64` (see `feed.ts`). */
      archParameter: ["arm64", "x86_64"],
    };
  },
};

// ── The service's public face ────────────────────────────────────────────────
export {
  appcastArch,
  DEFAULT_APPCAST_ARCH,
  handleUpdate,
  type UpdateSurfaceKind,
} from "./feed.js";
export { updateParams } from "./eligibility.js";
