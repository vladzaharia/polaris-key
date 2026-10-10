/// <reference types="@cloudflare/workers-types" />

/**
 * Update's two surfaces: the Sparkle appcast and the version check.
 *
 * ── PER-ARCH FEEDS (P2.T4) ──────────────────────────────────────────────────────────────────
 *
 * Sparkle feeds are per-architecture — one `<enclosure>` per item, one binary per enclosure — so
 * a single feed can only ever describe one slice. The appcast previously hard-coded `arm64`,
 * which meant every Intel Mac on the platform either got an arm64 DMG or nothing. `?arch=` picks
 * the slice; the unparameterised feed still serves `arm64`, because that is what every shipped
 * `SUFeedURL` is already pointed at and changing its meaning would be a silent downgrade for
 * every installed copy.
 *
 * The arch is part of the edge-cache key (`gateway.ts`), so the two feeds cannot collide.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import type { Product } from "../../core/products.js";
import { json, notFound } from "../../core/errors.js";
import type { UpdateArch } from "@polaris-key/protocol/update";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { FetchImpl } from "../release/githubApp.js";
import { fetchTextAsset, getReleaseByTag } from "../release/github.js";
import { matchAsset, normalizeArch, sigAssetName } from "../release/assets.js";
import { extractSummary } from "../release/changelog.js";
import { versionFromTag } from "../release/channels.js";
import { verifySparkleSignature } from "../release/sparkle.js";
import {
  artifactPolicy,
  isResolved,
  operatorPolicy,
} from "../release/config.js";
import {
  APPCAST_CACHE,
  cacheHeader,
  channelSuffix,
  installationToken,
  resolveSelector,
  serveReleaseSurface,
  type ReleaseParams,
  type SurfaceContext,
} from "../release/gateway.js";
import { buildAppcastItem, proseToHtml, renderAppcast } from "./appcast.js";

/** The surfaces this service serves. Release owns the other four. */
export type UpdateSurfaceKind = "appcast" | "channelAppcast" | "version";

/** The architecture an unparameterised feed describes (see the file header). */
export const DEFAULT_APPCAST_ARCH: UpdateArch = "arm64";

/**
 * Read `?arch=` off a feed request.
 *
 * Unrecognised values fall back to the default rather than 404ing: the parameter is a HINT from
 * an updater about the machine it is running on, and a Sparkle client that sends something this
 * build has not heard of should still be offered the mainstream build, not left with no feed.
 * The value never reaches a filesystem or a URL — it selects between two asset matchers.
 */
export function appcastArch(req: Request): UpdateArch {
  const raw = new URL(req.url).searchParams.get("arch");
  return normalizeArch(raw ?? undefined) ?? DEFAULT_APPCAST_ARCH;
}

/**
 * Serve an Update surface. The public entry point for the descriptor's router — and for the
 * suites that drive these handlers directly.
 */
export function handleUpdate(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  kind: UpdateSurfaceKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl = fetch,
  /**
   * Who may read the appcast: Distribution's delivery access for the `app` deliverable
   * (`delivery.accessMode()`, P2b-04) — the same answer the download behind each enclosure
   * enforces, so the feed can no longer offer what the download refuses. The router reads it
   * through the hook; omitted, an appcast fails closed to `entitled` (`artifactPolicy`).
   */
  artifactsAccess?: ReleaseAccess,
  /** The runtime's `waitUntil`, for the Sparkle verification's stream tail and memo write. */
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  return serveReleaseSurface(
    req,
    env,
    db,
    product,
    kind,
    params,
    fetchImpl,
    (ctx) =>
      kind === "version"
        ? handleVersion(ctx)
        : handleAppcast(
            kind === "appcast"
              ? { ...ctx.params, channel: "stable" }
              : ctx.params,
            ctx,
            artifactsAccess,
            waitUntil,
          ),
    artifactsAccess !== undefined ? { artifactsAccess } : {},
  );
}

async function handleVersion({
  env,
  db,
  cfg,
  params,
  now,
  fetchImpl,
}: SurfaceContext): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const { release, sel } = await resolveSelector(
    env,
    db,
    cfg,
    params.version ?? params.channel,
    now,
    fetchImpl,
  );
  return json(
    {
      version: versionFromTag(release.tag_name),
      tag: release.tag_name,
      url: release.html_url,
    },
    { headers: { "cache-control": cacheHeader(sel) } },
  );
}

async function handleAppcast(
  params: ReleaseParams,
  { env, db, cfg, product, origin, now, fetchImpl }: SurfaceContext,
  artifactsAccess: ReleaseAccess | undefined,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const arch = params.arch ?? DEFAULT_APPCAST_ARCH;
  const selectorStr = params.channel ?? params.version ?? "stable";
  const { release, sel } = await resolveSelector(
    env,
    db,
    cfg,
    selectorStr,
    now,
    fetchImpl,
  );

  const suffix = channelSuffix(sel);
  const dmg = matchAsset(release.assets, {
    arch,
    ext: "dmg",
    binaryName,
    channelSuffix: suffix,
  });
  if (!dmg) return notFound();

  // The EdDSA signature lives in a sibling `<dmg>.sig` asset uploaded by the pipeline.
  // Signed Sparkle appcasts are required by default; only an operator (never a `.pkey/`
  // push) can opt a product out. R6-03.
  const policy = artifactPolicy(cfg, artifactsAccess);
  if (policy.requireSparkleSignature && !cfg.sparkle_ed25519_pub) {
    return notFound();
  }
  const tok = await installationToken(env, cfg, now, fetchImpl);

  // Stable feeds (latest/stable/pinned) point the enclosure at the concrete version so the DMG
  // URL is immutable; moving channels point at their channel segment.
  const segment =
    sel.kind === "stable" ? versionFromTag(release.tag_name) : selectorStr;
  // The enclosure route re-resolves that version as a PINNED lookup — `tags/v<version>` first,
  // the bare tag only on its 404 — so when this item came from a bare `1.2.0` and a `v1.2.0` also
  // exists, the DMG a client downloads would be `v1.2.0`'s while the signature below is
  // `1.2.0`'s. Refuse the ambiguity rather than ship a feed whose item and enclosure disagree
  // (P2-03, wave-1 sync). One extra tag lookup, only for a stable item with a bare tag. An
  // operator resolves it by adding the BARE tag to `release.ignoreTags` or deleting one of the two
  // releases; ignoring the `v`-tag does not help, because the pinned lookup never consults
  // ignoreTags (test/releaseResolution.test.ts pins both).
  if (sel.kind === "stable" && release.tag_name !== `v${segment}`) {
    const shadow = await getReleaseByTag(
      tok,
      cfg.gh_owner,
      cfg.gh_repo,
      `v${segment}`,
      fetchImpl,
    );
    if (shadow && shadow.tag_name !== release.tag_name) return notFound();
  }

  const sig = release.assets.find((a) => a.name === sigAssetName(dmg.name));
  if (!sig && (cfg.sparkle_ed25519_pub || policy.requireSparkleSignature)) {
    return notFound();
  }
  let edSignature: string | undefined;
  if (sig) {
    const claimed = (
      await fetchTextAsset(tok, cfg.gh_owner, cfg.gh_repo, sig.id, fetchImpl)
    ).trim();
    // The sidecar is repo-controlled. Verify it against the configured public key over the
    // DMG's own bytes before it goes anywhere near the feed — the pubkey used to be a mere
    // presence flag, so any string in the `.sig` shipped as `sparkle:edSignature`.
    const verified = cfg.sparkle_ed25519_pub
      ? await verifySparkleSignature(env, product.slug, {
          token: tok,
          owner: cfg.gh_owner,
          repo: cfg.gh_repo,
          assetId: dmg.id,
          signature: claimed,
          publicKey: cfg.sparkle_ed25519_pub,
          fetchImpl,
          // The listed size: a body of any other length is no verdict (P0-10 follow-up).
          ...(Number.isSafeInteger(dmg.size) && dmg.size >= 0
            ? { expectedSize: dmg.size }
            : {}),
          ...(waitUntil ? { waitUntil } : {}),
        })
      : false;
    // Fail closed: the item is dropped and the feed 404s rather than shipping an
    // unverifiable enclosure. No log line — the worker deliberately carries no logging
    // sink, so the 404 (and the release health check) is the signal.
    if (!verified) return notFound();
    edSignature = claimed;
  }

  // The enclosure keeps the `/release/dl` spelling, a permanent alias of the canonical
  // `/distribution/dl` (P2b-04): a feed already cached by every installed copy names it, and a
  // changed URL would be a changed feed for no change in what is offered.
  const enclosureUrl = `${origin}/${product.slug}/release/dl/${segment}/${dmg.name}`;
  const channelTitle =
    sel.kind === "stable" ? binaryName : `${binaryName} (${sel.raw})`;
  // Release notes, finally wired (P2.T4) — the curated summary the `/release/changelog` surface
  // already extracts, escaped into HTML and CDATA-neutralised on the way out (`appcast.ts`).
  const summary = extractSummary(release.body, cfg.summary_marker);
  // The operator-declared minimum macOS version. Read from `operator_policy_json`, which is
  // genuinely OPERATOR-owned: no manifest shape carries the key (R6-03) and resync never names the
  // column, so a push can neither write it nor erase it. `operatorPolicy` shape-checks it first —
  // `sparkle:minimumSystemVersion` is compared by Sparkle, not displayed, and a value it cannot
  // parse silently makes every update ineligible.
  const minSys = operatorPolicy(cfg).minimumSystemVersion;
  const item = buildAppcastItem(release, dmg, edSignature, enclosureUrl, {
    title: `${binaryName} ${versionFromTag(release.tag_name)}`,
    ...(summary ? { descriptionHtml: proseToHtml(summary) } : {}),
    ...(minSys ? { minimumSystemVersion: minSys } : {}),
  });
  const xml = renderAppcast({ channelTitle, link: origin, items: [item] });

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": APPCAST_CACHE,
    },
  });
}
