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

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { Product } from "../../core/products.js";
import { json, notFound } from "../../core/errors.js";
import { bearer } from "../../platform/http.js";
import { resolvedReleaseRefusal } from "../../core/licensing/entitledAccess.js";
import type { UpdateArch } from "@polaris-key/protocol/update";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import type { FetchImpl } from "../release/githubApp.js";
import {
  fetchAssetStream,
  fetchTextAsset,
  getReleaseByTag,
  MAX_TEXT_ASSET_BYTES,
  NotFoundError,
  type Release,
  type ReleaseAsset,
} from "../release/github.js";
import { matchAsset, normalizeArch, sigAssetName } from "../release/assets.js";
import { extractSummary } from "../release/changelog.js";
import {
  isMovingSelector,
  versionFromTag,
  type ChannelSelector,
} from "../release/channels.js";
import {
  resolveStoreSelector,
  storeReleaseByTag,
} from "../release/storeRelease.js";
import {
  MAX_VERIFY_BYTES,
  verifyEd25519OverBytes,
  verifySparkleSignature,
} from "../release/sparkle.js";
import { openStoredAsset, storedTextAsset } from "../release/storeBytes.js";
import {
  accessModeFor,
  artifactPolicy,
  isResolved,
  operatorPolicy,
  type ResolvedConfig,
} from "../release/config.js";
import {
  APPCAST_CACHE,
  cacheHeader,
  channelSuffix,
  installationToken,
  resolveSelector,
  type ReleaseParams,
} from "../release/gateway.js";
import {
  serveReleaseSurface,
  type SurfaceContext,
} from "../release/surface.js";
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
        ? computeVersion(ctx, "legacy")
        : computeAppcast(
            kind === "appcast"
              ? { ...ctx.params, channel: "stable" }
              : ctx.params,
            ctx,
            artifactsAccess,
            waitUntil,
            "legacy",
          ),
    artifactsAccess !== undefined ? { artifactsAccess } : {},
  );
}

/**
 * Where a compute step reads the release from (P2-12.4, plans/P2-12.md §6.3).
 *
 *   `legacy`: GitHub, as every served route does today (`resolveSelector`, the `v<version>` twin
 *             by a tag lookup).
 *   `store`:  the truth store in GitHub's shape (`resolveStoreSelector`, the twin from the same
 *             rows). Not routed in PR 1: the comparison job (`resolverCompare.ts`) and the golden
 *             suite are its only callers; PR 2 routes to it.
 *
 * The two steps share every line after the resolution, so they differ in nothing but the release
 * they are given, and in where the Sparkle sidecar and DMG come from (P2-12.5): the legacy step
 * reads both from GitHub by asset id; the store step reads Polaris Key's own copy first
 * (`storeBytes.ts`) and falls back to the asset by id. The store step lists no release, reads
 * no tag and no workflow run from GitHub while serving.
 */
export type UpdateStep = "legacy" | "store";

interface StepSource {
  resolve(selector: string | undefined): Promise<{
    release: Release;
    sel: ChannelSelector;
  }>;
  /** The release tagged exactly `tag`, or null (the appcast's `v<version>` twin check). */
  byTag(tok: string, tag: string): Promise<Release | null>;
  /** The installation token, minted on first use. */
  token(): Promise<string>;
  /** A `.sig` sidecar's text. */
  text(tok: string, asset: ReleaseAsset): Promise<string>;
  /** Verify the Sparkle signature over `dmg`'s bytes. */
  verify(
    tok: string,
    dmg: ReleaseAsset,
    signature: string,
    publicKey: string,
    waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  ): Promise<boolean>;
}

function stepSource(
  step: UpdateStep,
  { env, db, now, fetchImpl }: SurfaceContext,
  cfg: ResolvedConfig,
): StepSource {
  let minted: Promise<string> | undefined;
  const token = () => (minted ??= installationToken(env, cfg, now, fetchImpl));
  const sizeOf = (dmg: ReleaseAsset) =>
    Number.isSafeInteger(dmg.size) && dmg.size >= 0
      ? { expectedSize: dmg.size }
      : {};
  if (step === "store")
    return {
      resolve: (selector) => resolveStoreSelector(db, cfg, selector),
      byTag: (_tok, tag) => storeReleaseByTag(db, cfg, tag),
      token,
      text: async (_tok, asset) =>
        (await storedTextAsset(
          env,
          db,
          cfg.product,
          asset,
          MAX_TEXT_ASSET_BYTES,
        )) ??
        fetchTextAsset(
          await token(),
          cfg.gh_owner,
          cfg.gh_repo,
          asset.id,
          fetchImpl,
        ),
      verify: (_tok, dmg, signature, publicKey, waitUntil) =>
        verifyEd25519OverBytes(env, cfg.product, {
          // The memo subject stays the asset id: a verdict the legacy step memoised holds.
          subject: dmg.id,
          signature,
          publicKey,
          maxBytes: MAX_VERIFY_BYTES,
          ...sizeOf(dmg),
          ...(waitUntil ? { waitUntil } : {}),
          open: async () => {
            const stored = await openStoredAsset(env, db, cfg.product, dmg);
            if (stored) return stored;
            try {
              return await fetchAssetStream(
                await token(),
                cfg.gh_owner,
                cfg.gh_repo,
                dmg.id,
                MAX_VERIFY_BYTES,
                fetchImpl,
              );
            } catch (err) {
              if (err instanceof NotFoundError) return null;
              throw err;
            }
          },
        }),
    };
  return {
    token,
    text: (tok, asset) =>
      fetchTextAsset(tok, cfg.gh_owner, cfg.gh_repo, asset.id, fetchImpl),
    verify: (tok, dmg, signature, publicKey, waitUntil) =>
      verifySparkleSignature(env, cfg.product, {
        token: tok,
        owner: cfg.gh_owner,
        repo: cfg.gh_repo,
        assetId: dmg.id,
        signature,
        publicKey,
        fetchImpl,
        ...sizeOf(dmg),
        ...(waitUntil ? { waitUntil } : {}),
      }),
    resolve: (selector) =>
      resolveSelector(env, db, cfg, selector, now, fetchImpl),
    byTag: (tok, tag) =>
      getReleaseByTag(tok, cfg.gh_owner, cfg.gh_repo, tag, fetchImpl),
  };
}

/** The version check (`/update/version`) as the legacy or the store step computes it. */
export async function computeVersion(
  ctx: SurfaceContext,
  step: UpdateStep,
): Promise<Response> {
  const { req, env, db, cfg, product, params, now } = ctx;
  if (!isResolved(cfg)) return notFound();
  const { release, sel } = await stepSource(step, ctx, cfg).resolve(
    params.version ?? params.channel,
  );
  // The window is re-asserted against the RESOLVED release. `/update/version` is the surface
  // that TELLS a caller which version is current, so answering `latest` or a channel with a
  // release outside the caller's ceiling advertises the artifact the pinned download refuses.
  // Governed by the METADATA mode, like the check itself.
  if (isMovingSelector(sel)) {
    const blocked = await resolvedReleaseRefusal(
      env,
      db,
      product,
      bearer(req),
      accessModeFor(artifactPolicy(cfg), "version"),
      release.tag_name,
      now,
    );
    if (blocked) return blocked;
  }
  return json(
    {
      version: versionFromTag(release.tag_name),
      tag: release.tag_name,
      url: release.html_url,
    },
    { headers: { "cache-control": cacheHeader(sel) } },
  );
}

/** The appcast and channel appcast as the legacy or the store step computes them. */
export async function computeAppcast(
  params: ReleaseParams,
  ctx: SurfaceContext,
  artifactsAccess: ReleaseAccess | undefined,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  step: UpdateStep,
): Promise<Response> {
  const { req, env, db, cfg, product, origin, now } = ctx;
  if (!isResolved(cfg)) return notFound();
  const binaryName = cfg.binary_name ?? product.slug;
  const arch = params.arch ?? DEFAULT_APPCAST_ARCH;
  const selectorStr = params.channel ?? params.version ?? "stable";
  const source = stepSource(step, ctx, cfg);
  const { release, sel } = await source.resolve(selectorStr);
  const policy = artifactPolicy(cfg, artifactsAccess);
  // A bare `/update/appcast.xml` or a channel appcast names no version, so the grant's ceiling
  // was never applied to it: the release the selector resolved to is checked now. The feed's
  // whole job is to hand an updater an enclosure URL, so listing one for an out-of-window
  // release discloses it as surely as serving the DMG would.
  if (isMovingSelector(sel)) {
    const blocked = await resolvedReleaseRefusal(
      env,
      db,
      product,
      bearer(req),
      accessModeFor(policy, "appcast"),
      release.tag_name,
      now,
    );
    if (blocked) return blocked;
  }

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
  if (policy.requireSparkleSignature && !cfg.sparkle_ed25519_pub) {
    return notFound();
  }
  // The legacy step mints its token here, as it always has; the store step mints one only if a
  // read has to fall back to GitHub.
  const tok = step === "legacy" ? await source.token() : "";

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
  // ignoreTags (test/surfaces/console/releaseResolution.test.ts pins both).
  if (sel.kind === "stable" && release.tag_name !== `v${segment}`) {
    const shadow = await source.byTag(tok, `v${segment}`);
    if (shadow && shadow.tag_name !== release.tag_name) return notFound();
  }

  const sig = release.assets.find((a) => a.name === sigAssetName(dmg.name));
  if (!sig && (cfg.sparkle_ed25519_pub || policy.requireSparkleSignature)) {
    return notFound();
  }
  let edSignature: string | undefined;
  if (sig) {
    const claimed = (await source.text(tok, sig)).trim();
    // The sidecar is repo-controlled. Verify it against the configured public key over the
    // DMG's own bytes before it goes anywhere near the feed — the pubkey used to be a mere
    // presence flag, so any string in the `.sig` shipped as `sparkle:edSignature`.
    const verified = cfg.sparkle_ed25519_pub
      ? await source.verify(
          tok,
          dmg,
          claimed,
          cfg.sparkle_ed25519_pub,
          waitUntil,
        )
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
