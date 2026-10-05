/// <reference types="@cloudflare/workers-types" />

/**
 * The app-updater feed routes (P3-09, README §3.6 "App-updater feeds"), under `/<p>/update`:
 *
 *     GET /<channel>/winsparkle.xml                     WinSparkle appcast (Windows installers)
 *     GET /<channel>/velopack/releases.<vch>.json       Velopack feed (`<vch>` = win|osx|linux[-x64|-arm64][-…])
 *     GET /<channel>/velopack/<FileName>                302 to the delivery URL of a package the
 *                                                       Velopack feed lists (`FileName` is bare)
 *     GET /<channel>/app.appinstaller[?arch=|?outlet=]  MSIX App Installer file (2021 schema)
 *     GET /<channel>/<buildId>.AppImage.zsync           AppImageUpdate control file
 *     GET /appcast.xml, /<channel>/appcast.xml          the Sparkle appcast, EXTENDED for a product
 *                                                       that publishes release records
 *     GET /version?platform=&arch=&outlet=              the version check, EXTENDED
 *
 * ── ONE RECORD, MANY FEEDS ──────────────────────────────────────────────────────────────────
 *
 * Every feed lists only releases with a stored release record (`release_records`, P3-03) — the
 * releases the signed channel feed can pin — chosen by P2b-05's selection through Distribution's
 * hook (`Delivery.feedSelection`): the channel's history from Release, a build for the outlet,
 * live there, not yanked, not held by a rollout, with an immutable delivery URL. So a yank or a
 * halt removes a release from every feed at once, and the previous release is listed instead.
 * Per feed, a rollout in progress:
 *
 *   Sparkle      phases on the client: an ACTIVE rollout lists the release with
 *                `phasedRolloutInterval` (`phasedSchedule`); paused or halted serves the previous.
 *   WinSparkle, Velopack, App Installer, zsync, /version
 *                have no rollout concept: the previous release until the rollout completes.
 *
 * The appcast keeps its legacy GitHub-resolved path for a product with NO release record (every
 * product before v4): its URLs, aliases and bytes are unchanged (`feed.ts`).
 *
 * ── ACCESS, CACHE, HEADERS ──────────────────────────────────────────────────────────────────
 *
 * Access is the release gateway's (`enforceReleaseAccess`): the appcasts and the four new feeds
 * are governed by Distribution's delivery access for the app (`delivery.accessMode`), the version
 * check by the metadata mode, exactly as the appcast and version check always were. A public
 * answer is cached for five minutes in Core's feed cache, keyed by the path, only the query
 * inputs the renderer reads, and a stamp of the state that must take effect at once
 * (`delivery.feedStamp()` plus the channel policies); a non-public answer is never cached and is
 * `private, no-store`. Every answer carries a strong ETag (304 on `If-None-Match`), `nosniff`
 * and the platform security headers. Per-IP rate limit `updateFeed`, failing open.
 */

import { APP_DELIVERABLE_ID, RELEASE_PLATFORMS } from "@polaris-key/manifest";
import { OUTLET_KINDS } from "@polaris-key/protocol/distribution";
import { BUILD_ID_PATTERN } from "@polaris-key/protocol/release";
import type { ServiceContext } from "../../core/registry.js";
import type {
  CatalogChannelPolicy,
  CatalogSourceArtifact,
  Delivery,
  FeedSelection,
  FeedSelectionEntry,
  FeedSelectionQuery,
  ReleaseCatalog,
} from "../../core/hooks.js";
import { errorResponse, notFound } from "../../core/errors.js";
import { bearer } from "../../core/platform.js";
import {
  accessRefusal,
  fixedReleaseSelector,
} from "../../core/entitledAccess.js";
import {
  DOWNLOAD_TICKET_PARAM,
  mintDownloadTicket,
} from "../../core/downloadTicket.js";
import { isBytesHost } from "../../core/bytesHostname.js";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import {
  cachedFeedBytes,
  cachedFeedText,
  feedCacheKey,
} from "../../core/feedCache.js";
import {
  accessModeFor,
  artifactPolicy,
  getReleaseConfig,
  operatorPolicy,
  type ReleaseConfigRow,
  type ReleaseKind,
} from "../release/config.js";
import { enforceReleaseAccess, type ReleaseParams } from "../release/access.js";
import { harden } from "../release/gateway.js";
import { recordedReleaseIds } from "../release/records.js";
import { listDeliverables } from "../release/model.js";
import { versionSchemeOf } from "../release/resolve.js";
import {
  artifactSha1,
  MAX_ZSYNC_BYTES,
  readSmallArtifact,
  verifiedSidecarSignature,
  type ArtifactReadContext,
} from "./artifactBytes.js";
import {
  msixArchitecture,
  msixVersion,
  renderAppInstaller,
  renderSparkleAppcast,
  renderVelopackFeed,
  renderWinSparkleAppcast,
  rewriteZsync,
  velopackNotes,
  velopackPackageId,
  VELOPACK_ARCH,
  VELOPACK_OS,
  versionDocument,
  type ChannelPolicyView,
  type SparkleSource,
  type VelopackAsset,
  type WinSparkleSource,
} from "./updaterRender.js";
import type { ManifestAppInstallerUpdateSettings } from "@polaris-key/manifest";

/** Feed reads per IP per minute: a D1-read budget, not a secret (fails open). */
const UPDATER_FEED_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;
/** What a public feed answer promises clients (the appcast's own `APPCAST_CACHE`). */
const PUBLIC_FEED_CACHE = "public, max-age=300";
/** The version check's moving answer (the legacy check's `MOVING_CACHE`). */
const PUBLIC_VERSION_CACHE = "public, max-age=120";
const PRIVATE_CACHE = "private, no-store";
/**
 * How many releases the appcasts list, newest first: the current one, and older ones a client
 * falls back to (a Sparkle group the phased rollout has not reached yet, an older OS). Each
 * listed enclosure costs one streamed signature verification per release, ever (memoised).
 */
const APPCAST_RELEASES = 3;
/**
 * How many releases' DELTAS the Velopack feed lists (Velopack's own default
 * `MaximumDeltasBeforeFallback`). Only the newest release's FULL package is listed: Velopack
 * applies deltas to the full package it already holds, so older full packages are never fetched,
 * and listing them would cost a streamed SHA-1 each.
 */
const VELOPACK_RELEASES = 10;

export const CONTENT_TYPES = {
  xml: "application/xml; charset=utf-8",
  json: "application/json; charset=utf-8",
  appinstaller: "application/appinstaller",
  /** The type zsync's own tooling and AppImageUpdate use for a control file. */
  zsync: "application/x-zsync",
} as const;

/**
 * The releases with a stored `kind: app` record, sorted. One narrow read (the ids only, never the
 * JWS bytes): every updater feed request runs it, before the cache, because it is in the stamp.
 */
export function recordedAppReleases(
  ctx: Pick<ServiceContext, "db" | "product">,
): Promise<string[]> {
  return recordedReleaseIds(
    ctx.db,
    ctx.product.slug,
    APP_DELIVERABLE_ID,
    "app",
  );
}

async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** What one updater feed request needs rendered. */
interface FeedPlan {
  kind: ReleaseKind;
  /** For the gateway's access rule (`entitled` checks the channel). */
  params: ReleaseParams;
  /** The query inputs the renderer reads, for the cache key. */
  cacheInputs: ReadonlyArray<readonly [string, string | null | undefined]>;
  contentType: string;
  publicCache: string;
  /**
   * `null` = not found. A `Response` is answered as it is (hardened): only a non-public render may
   * return one (the Velopack package route's per-file refusal, SP-09), never a cached one.
   */
  render: (r: RenderContext) => Promise<string | Uint8Array | Response | null>;
  /**
   * The rendered string is a URL to answer with a 302 rather than a body (the Velopack package
   * route). Everything before the answer — rate limit, access, cache — is the feed's own.
   */
  redirect?: boolean;
}

/** What a feed renderer is handed once access is decided. */
export interface RenderContext {
  ctx: ServiceContext;
  cfg: ReleaseConfigRow;
  catalog: ReleaseCatalog;
  delivery: Delivery;
  origin: string;
  /** The releases with a stored record (the only ones a feed lists). */
  recorded: string[];
  artifacts: ArtifactReadContext;
  /** `?outlet=`, when the route reads it. */
  outletParam: string | null;
  /** The app deliverable's delivery access mode, the one this request was admitted under. */
  mode: ReleaseAccess;
}

/** Run one updater feed request: rate limit, access, cache, render, headers. */
async function serveFeed(
  ctx: ServiceContext,
  plan: FeedPlan,
  recorded: string[],
): Promise<Response> {
  const { req, env, db, product } = ctx;
  const now = Math.floor(Date.now() / 1000);
  // First, so a flood past the limit costs only the route's release-id read and this check.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "updateFeed", id: clientIp(req), ...UPDATER_FEED_RATE_LIMIT },
      now,
    ))
  )
    return harden(errorResponse(429, "rate_limited", "too many feed requests"));
  const cfg = await getReleaseConfig(db, product.slug);
  const catalog = ctx.hooks.releaseCatalog();
  const delivery = ctx.hooks.delivery();
  if (!cfg || !catalog || !delivery) return harden(notFound());
  const artifactsAccess = await delivery.accessMode(APP_DELIVERABLE_ID);
  const mode = accessModeFor(artifactPolicy(cfg, artifactsAccess), plan.kind);
  if (mode !== "public") {
    const denied = await enforceReleaseAccess(
      req,
      env,
      db,
      product,
      cfg,
      plan.kind,
      plan.params,
      now,
      artifactsAccess,
    );
    if (denied) return harden(denied);
  }

  const url = new URL(req.url);
  const outletParam = url.searchParams.get("outlet");
  const rctx: RenderContext = {
    ctx,
    cfg,
    catalog,
    delivery,
    origin: url.origin,
    recorded,
    outletParam,
    mode,
    artifacts: {
      env,
      db,
      product: product.slug,
      catalog,
      waitUntil: ctx.waitUntil,
    },
  };
  let body: string | Uint8Array | null;
  if (mode === "public") {
    // Never cached: the access decision above. Cached: the rendered answer, under a key that
    // moves with every state change a feed must follow at once.
    const stamp = await sha256Hex(
      JSON.stringify([
        await delivery.feedStamp(),
        await catalog.channelPolicies(APP_DELIVERABLE_ID),
        recorded,
      ]),
    );
    const key = feedCacheKey(
      url.origin,
      url.pathname,
      outletParam,
      stamp.slice(0, 32),
      plan.cacheInputs,
    );
    body =
      plan.contentType === CONTENT_TYPES.zsync
        ? await cachedFeedBytes(key, async () => {
            const b = publicBody(await plan.render(rctx));
            return b === null
              ? null
              : typeof b === "string"
                ? new TextEncoder().encode(b)
                : b;
          })
        : await cachedFeedText(key, async () => {
            const b = publicBody(await plan.render(rctx));
            return b === null
              ? null
              : typeof b === "string"
                ? b
                : new TextDecoder().decode(b);
          });
  } else {
    const rendered = await plan.render(rctx);
    if (rendered instanceof Response) return harden(rendered);
    body = rendered;
  }
  if (body === null) return harden(notFound());
  const cacheControl = mode === "public" ? plan.publicCache : PRIVATE_CACHE;
  if (plan.redirect) {
    const location =
      typeof body === "string" ? body : new TextDecoder().decode(body);
    return harden(
      new Response(null, {
        status: 302,
        headers: {
          location,
          "cache-control": cacheControl,
          "x-content-type-options": "nosniff",
        },
      }),
    );
  }
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const etag = `"${await sha256Hex(bytes)}"`;
  const headers = {
    "content-type": plan.contentType,
    "cache-control": cacheControl,
    etag,
    "x-content-type-options": "nosniff",
  };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))
    return harden(new Response(null, { status: 304, headers }));
  return harden(
    new Response(req.method === "HEAD" ? null : bytes, {
      status: 200,
      headers,
    }),
  );
}

/**
 * A public render's body. A public answer is cached, so it can never be a `Response` (only the
 * Velopack package route's non-public per-file refusal is one): treat one as a bug, fail closed.
 */
function publicBody(
  b: string | Uint8Array | Response | null,
): string | Uint8Array | null {
  if (b instanceof Response)
    throw new Error("a public feed render returned a Response");
  return b;
}

// ── Shared reads ─────────────────────────────────────────────────────────────────────────────

function select(
  r: RenderContext,
  q: Omit<FeedSelectionQuery, "origin" | "releaseIds">,
): Promise<FeedSelection | null> {
  return r.delivery.feedSelection({
    ...q,
    origin: r.origin,
    releaseIds: r.recorded,
  });
}

function policyView(
  policies: readonly CatalogChannelPolicy[],
  channel: string,
): ChannelPolicyView | null {
  const p = policies.find(
    (x) => x.deliverableId === APP_DELIVERABLE_ID && x.channel === channel,
  );
  return p
    ? {
        critical: p.critical,
        pointerReleaseId: p.pointerReleaseId,
        minSupported: p.minSupported,
      }
    : null;
}

/**
 * Whether unsigned enclosures may be listed, and the key signatures must verify against: the
 * appcast's own rule (R6-03). A configured Sparkle key means every enclosure must carry a
 * signature that verifies; without one, enclosures are listed unsigned only when an operator
 * opted the product out of `requireSparkleSignature`.
 */
function signaturePolicy(cfg: ReleaseConfigRow): {
  publicKey: string | null;
  unsignedOk: boolean;
} {
  const publicKey = cfg.sparkle_ed25519_pub ?? null;
  return {
    publicKey,
    unsignedOk: !publicKey && !operatorPolicy(cfg).requireSparkleSignature,
  };
}

function channelTitle(name: string, channel: string): string {
  return channel === "stable" ? name : `${name} (${channel})`;
}

// ── Sparkle (extended) ───────────────────────────────────────────────────────────────────────

/** The extended Sparkle appcast for `channel` and `arch` (the appcast routes' store path). */
export function serveSparkle(
  ctx: ServiceContext,
  channel: string,
  arch: "arm64" | "x86_64",
  recorded: string[],
): Promise<Response> {
  return serveFeed(
    ctx,
    {
      kind: channel === "stable" ? "appcast" : "channelAppcast",
      params: { channel, arch },
      cacheInputs: [["arch", arch]],
      contentType: CONTENT_TYPES.xml,
      publicCache: PUBLIC_FEED_CACHE,
      render: async (r) => {
        const sel = await select(r, {
          channel,
          kinds: ["direct"],
          outletId: r.outletParam,
          platform: "macos",
          arches: [arch, "universal"],
          liveness: "availability",
          limit: APPCAST_RELEASES,
          allBuilds: true,
          rollouts: "phase",
          withArtifacts: true,
        });
        if (!sel) return null;
        const sig = signaturePolicy(r.cfg);
        const sources: SparkleSource[] = [];
        for (const entry of preferArch(sel.entries, arch)) {
          const edSignature = await verifiedSidecarSignature(
            r.artifacts,
            entry.payload,
            entry.artifacts,
            sig.publicKey,
          );
          if (!edSignature && !sig.unsignedOk) continue;
          const deltas: SparkleSource["deltas"] = [];
          for (const a of entry.artifacts) {
            const from = a.metadata?.deltaFrom;
            if (
              !isBuildFile(a, entry.buildId, "delta") ||
              typeof from !== "string" ||
              !a.url
            )
              continue;
            const dsig = await verifiedSidecarSignature(
              r.artifacts,
              a,
              entry.artifacts,
              sig.publicKey,
            );
            if (!dsig && !sig.unsignedOk) continue;
            deltas.push({
              url: a.url,
              size: a.sizeBytes ?? 0,
              deltaFrom: from,
              ...(dsig ? { edSignature: dsig } : {}),
            });
          }
          sources.push({
            entry,
            ...(edSignature ? { edSignature } : {}),
            deltas,
          });
        }
        const deliverable = (
          await listDeliverables(r.ctx.db, r.ctx.product.slug)
        ).find((d) => d.deliverable_id === APP_DELIVERABLE_ID);
        const minSys = operatorPolicy(r.cfg).minimumSystemVersion;
        return renderSparkleAppcast({
          channelTitle: channelTitle(r.ctx.product.name, channel),
          link: r.origin,
          productName: r.ctx.product.name,
          scheme: versionSchemeOf(deliverable ?? null),
          sources,
          policy: policyView(
            await r.catalog.channelPolicies(APP_DELIVERABLE_ID),
            sel.channel,
          ),
          ...(minSys ? { minimumSystemVersion: minSys } : {}),
        });
      },
    },
    recorded,
  );
}

/** One build per release: the exact arch over a universal one. */
function preferArch(
  entries: readonly FeedSelectionEntry[],
  arch: string,
): FeedSelectionEntry[] {
  const byRelease = new Map<string, FeedSelectionEntry>();
  for (const e of entries) {
    const held = byRelease.get(e.releaseId);
    if (!held || (held.arch !== arch && e.arch === arch))
      byRelease.set(e.releaseId, e);
  }
  return [...byRelease.values()];
}

// ── WinSparkle ───────────────────────────────────────────────────────────────────────────────

function serveWinSparkle(
  ctx: ServiceContext,
  channel: string,
  recorded: string[],
): Promise<Response> {
  return serveFeed(
    ctx,
    {
      kind: "winsparkle",
      params: { channel },
      cacheInputs: [],
      contentType: CONTENT_TYPES.xml,
      publicCache: PUBLIC_FEED_CACHE,
      render: async (r) => {
        const sel = await select(r, {
          channel,
          kinds: ["direct"],
          outletId: r.outletParam,
          platform: "windows",
          // WinSparkle downloads and RUNS an installer: never a zip or a package.
          payloadSuffixes: [".exe", ".msi"],
          liveness: "availability",
          limit: APPCAST_RELEASES,
          allBuilds: true,
          withArtifacts: true,
        });
        if (!sel) return null;
        const sig = signaturePolicy(r.cfg);
        const sources: WinSparkleSource[] = [];
        for (const entry of sel.entries) {
          const edSignature = await verifiedSidecarSignature(
            r.artifacts,
            entry.payload,
            entry.artifacts,
            sig.publicKey,
          );
          if (!edSignature && !sig.unsignedOk) continue;
          sources.push({ entry, ...(edSignature ? { edSignature } : {}) });
        }
        return renderWinSparkleAppcast({
          channelTitle: channelTitle(r.ctx.product.name, channel),
          link: r.origin,
          productName: r.ctx.product.name,
          sources,
        });
      },
    },
    recorded,
  );
}

// ── Velopack ─────────────────────────────────────────────────────────────────────────────────

/**
 * `releases.<vch>.json` → the platform and arch it is for: the channel's first token is the OS
 * (`win`, `osx`, `linux`, Velopack's defaults), the second, when it is `x64` or `arm64`, the
 * arch; else the client's own `?arch=` (Velopack appends it), else x64. `null` = not a feed.
 */
function velopackTarget(
  file: string,
  archParam: string | null,
): { platform: string; arch: string } | null {
  const m = /^releases\.([A-Za-z0-9_-]{1,64})\.json$/.exec(file);
  if (!m) return null;
  const tokens = m[1]!.toLowerCase().split("-");
  const platform = VELOPACK_OS[tokens[0]!];
  if (!platform) return null;
  const arch =
    VELOPACK_ARCH[tokens[1] ?? ""] ??
    VELOPACK_ARCH[(archParam ?? "").toLowerCase()] ??
    "x86_64";
  return { platform, arch };
}

/**
 * One package the Velopack feed for a target lists, before its SHA-1 is read: what the asset
 * says, the artifact whose bytes give the SHA-1, and the immutable delivery URL the package
 * route redirects to.
 */
export interface VelopackCandidate {
  asset: Omit<VelopackAsset, "SHA1">;
  artifact: CatalogSourceArtifact;
  url: string;
  /** The release the package belongs to, and its STORED version (SP-09's per-file check). */
  releaseId: string;
  version: string;
  /** The file's name and recorded SHA-256 (lowercase hex), what a download ticket binds. */
  name: string;
  sha256: string;
  /**
   * The full package this one is listed only with: the newest release's deltas go with its full
   * package, so a full package whose bytes give no SHA-1 takes its deltas out of the feed too.
   */
  full?: VelopackCandidate;
}

/**
 * The packages the Velopack feed for `target` lists, in feed order: the newest release's full
 * package, then each listed release's descriptor-named deltas. ONE selection serves the feed and
 * the package route, so the route can redirect to nothing the feed would not list.
 */
async function velopackCandidates(
  r: RenderContext,
  channel: string,
  target: { platform: string; arch: string },
): Promise<VelopackCandidate[] | null> {
  const sel = await select(r, {
    channel,
    kinds: ["direct"],
    outletId: r.outletParam,
    platform: target.platform,
    arches: [target.arch, "universal", "any"],
    payloadSuffixes: ["-full.nupkg"],
    liveness: "availability",
    limit: VELOPACK_RELEASES,
    withArtifacts: true,
  });
  return sel ? velopackCandidatesFrom(sel.entries) : null;
}

/**
 * The Velopack candidates of a selection (newest first), with no I/O: `velopackCandidates`'s
 * second half, exported so P5-07's end-to-end runs (sdks/godot/native/e2e/gen_feeds.mts) build
 * their feed with this exact code over local files.
 */
export function velopackCandidatesFrom(
  entries: readonly FeedSelectionEntry[],
): VelopackCandidate[] {
  const out: VelopackCandidate[] = [];
  for (const [i, e] of entries.entries()) {
    const packageId = velopackPackageId(e.name, e.version);
    if (!packageId || !e.sha256 || e.size === null) continue;
    const notes = velopackNotes(e.notes);
    let full: VelopackCandidate | undefined;
    if (i === 0) {
      if (!isVelopackFileName(e.name)) continue;
      full = {
        asset: {
          PackageId: packageId,
          Version: e.version,
          Type: "Full",
          FileName: e.name,
          SHA256: e.sha256.toUpperCase(),
          Size: e.size,
          ...notes,
        },
        artifact: e.payload,
        url: e.url,
        releaseId: e.releaseId,
        version: e.version,
        name: e.name,
        sha256: e.sha256.toLowerCase(),
      };
      out.push(full);
    }
    for (const a of e.artifacts) {
      if (
        !isBuildFile(a, e.buildId, "delta") ||
        !a.url ||
        !a.sha256 ||
        a.sizeBytes === null ||
        !a.name.toLowerCase().endsWith("-delta.nupkg") ||
        !isVelopackFileName(a.name)
      )
        continue;
      out.push({
        asset: {
          PackageId: packageId,
          Version: e.version,
          Type: "Delta",
          FileName: a.name,
          SHA256: a.sha256.toUpperCase(),
          Size: a.sizeBytes,
          ...notes,
        },
        artifact: a,
        url: a.url,
        releaseId: e.releaseId,
        version: e.version,
        name: a.name,
        sha256: a.sha256.toLowerCase(),
        ...(full ? { full } : {}),
      });
    }
  }
  return out;
}

function serveVelopack(
  ctx: ServiceContext,
  channel: string,
  file: string,
  recorded: string[],
): Promise<Response | null> {
  const target = velopackTarget(
    file,
    new URL(ctx.req.url).searchParams.get("arch"),
  );
  if (!target) return Promise.resolve(null);
  return serveFeed(
    ctx,
    {
      kind: "velopack",
      params: { channel },
      // The renderer reads the file name (in the path) and the resolved arch; Velopack's other
      // parameters (`os`, `rid`, `id`, `localVersion`) change nothing, so they key nothing.
      cacheInputs: [["arch", target.arch]],
      contentType: CONTENT_TYPES.json,
      publicCache: PUBLIC_FEED_CACHE,
      render: async (r) => {
        const candidates = await velopackCandidates(r, channel, target);
        if (!candidates) return null;
        return renderVelopackFeed(
          await velopackAssets(candidates, (a) => artifactSha1(r.artifacts, a)),
        );
      },
    },
    recorded,
  );
}

/**
 * The feed's assets for `candidates`, in order, with each SHA-1 from `sha1Of` (the stored bytes').
 * A package whose bytes give no SHA-1 is left out, and so are the deltas listed only with a full
 * package that was left out. Exported with `velopackCandidatesFrom` for P5-07's end-to-end runs.
 */
export async function velopackAssets(
  candidates: readonly VelopackCandidate[],
  sha1Of: (artifact: CatalogSourceArtifact) => Promise<string | null>,
): Promise<VelopackAsset[]> {
  const assets: VelopackAsset[] = [];
  const unlisted = new Set<VelopackCandidate>();
  for (const c of candidates) {
    const sha1 =
      c.full && unlisted.has(c.full) ? null : await sha1Of(c.artifact);
    if (!sha1) {
      unlisted.add(c);
      continue;
    }
    const a = c.asset;
    assets.push({
      PackageId: a.PackageId,
      Version: a.Version,
      Type: a.Type,
      FileName: a.FileName,
      SHA1: sha1.toUpperCase(),
      SHA256: a.SHA256,
      Size: a.Size,
      NotesMarkdown: a.NotesMarkdown,
      NotesHTML: a.NotesHTML,
    });
  }
  return assets;
}

/**
 * What a Velopack `FileName` may be: one plain file-name segment ending in `.nupkg`, as `vpk pack`
 * writes them. Velopack's Rust core saves a package to `packages_dir.join(FileName)` (notes/S-11
 * §4.2), so the feed names a package by its bare file name; the package route refuses anything
 * else before any read: no separator, no `..`, no leading dot, nothing outside this alphabet.
 */
const VELOPACK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.nupkg$/;

function isVelopackFileName(name: string): boolean {
  return VELOPACK_FILE_RE.test(name) && !name.includes("..");
}

/** Every target a Velopack feed renders for (`velopackTarget`'s range), in a fixed order. */
const VELOPACK_TARGETS: ReadonlyArray<{ platform: string; arch: string }> =
  Object.values(VELOPACK_OS).flatMap((platform) =>
    [...new Set(Object.values(VELOPACK_ARCH))].map((arch) => ({
      platform,
      arch,
    })),
  );

/**
 * `GET /<channel>/velopack/<FileName>`: a 302 to the immutable delivery URL of the package the
 * channel's Velopack feed lists under that `FileName`. Velopack resolves a bare `FileName`
 * against the feed URL, so this is where it asks. The answer is the feed's own: the same rate
 * limit, the same access decision (`kind: velopack`, `enforceReleaseAccess` for a non-public
 * delivery), the same cache, and the same selection (`velopackCandidates`) over every target a
 * feed can name, including the feed's rule that a package whose stored bytes do not give a SHA-1
 * is not listed. So it widens nothing: it redirects only to a URL the caller could read in the
 * feed, and that URL enforces the delivery access again on its own. Under a non-public delivery
 * the route also runs that URL's own per-file decision with the caller's bearer and, when it
 * allows, appends a download ticket, because Velopack drops `Authorization` on the redirect
 * (SP-09, `ticketedPackageUrl`). `null` = not a package name.
 */
function serveVelopackPackage(
  ctx: ServiceContext,
  channel: string,
  file: string,
  recorded: string[],
): Promise<Response | null> {
  // `handleUpdaterFeedRoutes` already refused a bad name before its D1 read; kept here so no
  // other caller can skip it.
  if (!isVelopackFileName(file)) return Promise.resolve(null);
  return serveFeed(
    ctx,
    {
      kind: "velopack",
      params: { channel },
      // The path names the file. Velopack resolves `FileName` against the feed URL, which drops
      // the feed's query, so only `?outlet=` (read by `serveFeed`, and in the key) can arrive.
      cacheInputs: [],
      contentType: CONTENT_TYPES.json,
      publicCache: PUBLIC_FEED_CACHE,
      redirect: true,
      render: async (r) => {
        for (const target of VELOPACK_TARGETS) {
          const hit = (await velopackCandidates(r, channel, target))?.find(
            (c) => c.asset.FileName === file,
          );
          if (!hit) continue;
          // Listed only when the feed would list it: its bytes, and its full package's, give a
          // SHA-1 (both memoised by the feed's own reads).
          const listed =
            (!hit.full ||
              (await artifactSha1(r.artifacts, hit.full.artifact))) &&
            (await artifactSha1(r.artifacts, hit.artifact));
          if (!listed) return null;
          return r.mode === "public" ? hit.url : ticketedPackageUrl(r, hit);
        }
        return null;
      },
    },
    recorded,
  );
}

/**
 * SP-09 (plans/SP-09.md §6): the answer for a listed package under a NON-public delivery.
 * Velopack's HTTP client drops `Authorization` on every redirect, so the second hop would be
 * anonymous. The route therefore runs, with the bearer it saw, the bytes route's own `file`
 * decision for this package (Core's `accessRefusal` over the release's STORED version, pinned)
 * and answers its refusal if any; then it appends a download ticket (PX-W3's
 * `core/downloadTicket.ts`) bound to the file by content, so the second hop needs no header.
 *
 * Fails closed to today's answer: with no signing key, no bytes host, or a URL off the bytes
 * host, the bare URL (whose second hop refuses an anonymous client, as before). A ticket is
 * never logged (THREAT-MODEL R12); the answer is `private, no-store`, and `harden` gives every
 * answer `referrer-policy: no-referrer`.
 */
async function ticketedPackageUrl(
  r: RenderContext,
  hit: VelopackCandidate,
): Promise<string | Response> {
  const { ctx } = r;
  const now = Math.floor(Date.now() / 1000);
  const refused = await accessRefusal(
    ctx.env,
    ctx.db,
    ctx.product,
    bearer(ctx.req),
    r.mode,
    fixedReleaseSelector(hit.version),
    true,
    now,
  );
  if (refused) return refused;
  return ticketedDeliveryUrl(ctx.env, ctx.product.slug, hit, now);
}

/**
 * `file.url` with a download ticket for that file appended, or `file.url` unchanged when this
 * deployment cannot mint one (no `DOWNLOAD_TICKET_KEY`, no bytes host), the URL is off the bytes
 * host, or it already has a query. The caller has decided access; this only mints. Exported for
 * the workerd lane (test-workerd/downloadTicket.test.ts).
 */
export async function ticketedDeliveryUrl(
  env: ServiceContext["env"],
  product: string,
  file: Pick<VelopackCandidate, "url" | "releaseId" | "name" | "sha256">,
  now: number,
): Promise<string> {
  let target: URL;
  try {
    target = new URL(file.url);
  } catch {
    return file.url;
  }
  // Tickets verify on the bytes host only, so none is minted for a URL anywhere else.
  if (target.search !== "" || !isBytesHost(target, env)) return file.url;
  const ticket = await mintDownloadTicket(
    env,
    {
      product,
      releaseId: file.releaseId,
      name: file.name,
      sha256: file.sha256,
    },
    now,
  );
  if (!ticket) return file.url;
  return `${file.url}?${DOWNLOAD_TICKET_PARAM}=${encodeURIComponent(ticket)}`;
}

// ── App Installer ────────────────────────────────────────────────────────────────────────────

const MSIX_SUFFIXES = [".msixbundle", ".appxbundle", ".msix", ".appx"];
const APPINSTALLER_ARCH: Readonly<Record<string, string>> = {
  x64: "x86_64",
  x86_64: "x86_64",
  arm64: "arm64",
};

function serveAppInstaller(
  ctx: ServiceContext,
  channel: string,
  recorded: string[],
): Promise<Response | null> {
  const url = new URL(ctx.req.url);
  // App Installer refuses a `Uri` with more than one query pair, and the `Uri` must be the URL
  // the file is served from: so the route reads at most ONE recognised parameter, and that one
  // pair is the whole query of the `Uri` it renders.
  const recognised = (["arch", "outlet"] as const).filter((k) =>
    url.searchParams.has(k),
  );
  if (recognised.length > 1) return Promise.resolve(null);
  const pair = recognised[0];
  const archParam =
    pair === "arch" ? (url.searchParams.get("arch") ?? "") : null;
  const arch =
    archParam !== null ? APPINSTALLER_ARCH[archParam.toLowerCase()] : undefined;
  if (archParam !== null && !arch) return Promise.resolve(null);
  const uri = `${url.origin}${url.pathname}${
    pair
      ? `?${pair}=${encodeURIComponent(url.searchParams.get(pair) ?? "")}`
      : ""
  }`;
  return serveFeed(
    ctx,
    {
      kind: "appinstaller",
      params: { channel },
      // The body embeds `uri`, which carries the request's own spelling of its one query pair
      // (`?arch=X64` and `?arch=x86_64` select the same build but must each get their own `Uri`),
      // so the rendered `uri` itself is part of the key.
      cacheInputs: [
        ["arch", arch],
        ["uri", uri],
      ],
      contentType: CONTENT_TYPES.appinstaller,
      publicCache: PUBLIC_FEED_CACHE,
      render: async (r) => {
        const sel = await select(r, {
          channel,
          kinds: ["app-installer"],
          outletId: pair === "outlet" ? r.outletParam : null,
          platform: "windows",
          ...(arch ? { arches: [arch, "universal", "any"] } : {}),
          payloadSuffixes: MSIX_SUFFIXES,
          liveness: "availability",
          limit: 1,
        });
        const head = sel?.entries[0];
        if (!sel || !head) return null;
        const family = sel.outlet.identity.packageFamilyName;
        const publisher = sel.outlet.identity.publisher;
        if (typeof family !== "string" || typeof publisher !== "string")
          return null;
        const name = family.slice(0, family.lastIndexOf("_"));
        const version = msixVersion(head);
        if (!name || !version) return null;
        const bundle = /\.(msix|appx)bundle$/i.test(head.name);
        const settings = sel.outlet.identity.updateSettings;
        return renderAppInstaller({
          uri,
          name,
          publisher,
          version,
          packageUri: head.url,
          bundle,
          ...(bundle ? {} : { architecture: msixArchitecture(head.arch) }),
          updateSettings:
            settings && typeof settings === "object" && !Array.isArray(settings)
              ? (settings as ManifestAppInstallerUpdateSettings)
              : null,
        });
      },
    },
    recorded,
  );
}

/**
 * Is `a` a file the descriptor named for this build, in this role? Every file a feed points a
 * client at beside the payload (a delta, a control file) must be: the CI-signed release record
 * covers those. A release-level row (build_id NULL: a GitHub asset the descriptor did not name,
 * whose only digest is GitHub's own) is never one, so whoever can write to the GitHub release
 * without holding the release key cannot reach a feed through it.
 */
function isBuildFile(
  a: CatalogSourceArtifact,
  buildId: string,
  role: "delta" | "checksum",
): boolean {
  return a.buildId !== null && a.buildId === buildId && a.role === role;
}

// ── zsync ────────────────────────────────────────────────────────────────────────────────────

function serveZsync(
  ctx: ServiceContext,
  channel: string,
  buildId: string,
  recorded: string[],
): Promise<Response> {
  return serveFeed(
    ctx,
    {
      kind: "zsync",
      params: { channel },
      cacheInputs: [],
      contentType: CONTENT_TYPES.zsync,
      publicCache: PUBLIC_FEED_CACHE,
      render: async (r) => {
        const sel = await select(r, {
          channel,
          kinds: ["direct"],
          outletId: r.outletParam,
          platform: "linux",
          buildIds: [buildId],
          payloadSuffixes: [".AppImage"],
          liveness: "availability",
          limit: 1,
          withArtifacts: true,
        });
        const head = sel?.entries[0];
        if (!head || head.size === null) return null;
        // Only the build's own descriptor-named control file, which the CI-signed record
        // covers. A release-level `.zsync` (a GitHub asset the descriptor did not name, synced
        // with build_id NULL and GitHub's own digest) is never served: whoever can write to the
        // GitHub release without holding the release key must not reach this route.
        const control = head.artifacts.find(
          (a) =>
            a.name === `${head.name}.zsync` &&
            isBuildFile(a, head.buildId, "checksum"),
        );
        if (!control) return null;
        const bytes = await readSmallArtifact(
          r.artifacts,
          control,
          MAX_ZSYNC_BYTES,
        );
        return bytes ? rewriteZsync(bytes, head.url, head.size) : null;
      },
    },
    recorded,
  );
}

// ── The extended version check ───────────────────────────────────────────────────────────────

/**
 * Is this a version check that asks for the extended answer? Only `?platform=` asks: the legacy
 * check documents `?arch=` as accepted and discarded, so `?arch=`, `?outlet=` or `?build=` on
 * their own keep the legacy answer.
 */
export function isExtendedVersionRequest(req: Request): boolean {
  return new URL(req.url).searchParams.has("platform");
}

export function serveExtendedVersion(
  ctx: ServiceContext,
  channel: string,
  recorded: string[],
): Promise<Response | null> {
  const q = new URL(ctx.req.url).searchParams;
  const platform = q.get("platform");
  const archParam = q.get("arch");
  const buildParam = q.get("build");
  if (buildParam !== null && !BUILD_ID_RE.test(buildParam))
    return Promise.resolve(null);
  if (!platform || !(RELEASE_PLATFORMS as readonly string[]).includes(platform))
    return Promise.resolve(null);
  const arch =
    archParam === null ? null : (APPINSTALLER_ARCH[archParam] ?? archParam);
  if (arch !== null && !/^[a-z0-9_]{1,16}$/.test(arch))
    return Promise.resolve(null);
  return serveFeed(
    ctx,
    {
      kind: "version",
      params: { channel },
      cacheInputs: [
        ["channel", channel],
        ["platform", platform],
        ["arch", arch],
        ["build", buildParam],
      ],
      contentType: CONTENT_TYPES.json,
      publicCache: PUBLIC_VERSION_CACHE,
      render: async (r) => {
        const sel = await select(r, {
          channel,
          // Any self-hosted outlet may be named; by default the direct download.
          kinds: r.outletParam ? OUTLET_KINDS : ["direct"],
          outletId: r.outletParam,
          platform,
          ...(arch ? { arches: [arch, "universal", "any"] } : {}),
          ...(buildParam ? { buildIds: [buildParam] } : {}),
          liveness: "availability",
          limit: 1,
          allBuilds: true,
        });
        // One build of the newest release: the exact arch over a universal one, then by id.
        const head = sel
          ? (sel.entries.find((e) => arch !== null && e.arch === arch) ??
            sel.entries[0])
          : undefined;
        if (!sel || !head) return null;
        const repo =
          r.cfg.gh_owner && r.cfg.gh_repo
            ? `${r.cfg.gh_owner}/${r.cfg.gh_repo}`
            : null;
        return `${JSON.stringify(
          versionDocument({
            entry: head,
            policy: policyView(
              await r.catalog.channelPolicies(APP_DELIVERABLE_ID),
              sel.channel,
            ),
            githubRepo: repo,
          }),
        )}\n`;
      },
    },
    recorded,
  );
}

// ── Routing ──────────────────────────────────────────────────────────────────────────────────

const ZSYNC_SUFFIX = ".AppImage.zsync";
const BUILD_ID_RE = new RegExp(BUILD_ID_PATTERN.source);

/**
 * The four new feed routes (and the Velopack package route), over `rest = [channel, …]` (the channel already checked against the
 * route alphabet). `null` = not one of them.
 */
export async function handleUpdaterFeedRoutes(
  ctx: ServiceContext,
  channel: string,
  tail: readonly string[],
): Promise<Response | null> {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return null;
  const name = tail[0] ?? "";
  if (tail.length === 1 && name === "winsparkle.xml")
    return serveWinSparkle(ctx, channel, await recordedAppReleases(ctx));
  if (tail.length === 1 && name === "app.appinstaller")
    return serveAppInstaller(ctx, channel, await recordedAppReleases(ctx));
  if (tail.length === 1 && name.endsWith(ZSYNC_SUFFIX)) {
    const buildId = name.slice(0, -ZSYNC_SUFFIX.length);
    if (!BUILD_ID_RE.test(buildId)) return null;
    return serveZsync(ctx, channel, buildId, await recordedAppReleases(ctx));
  }
  if (tail.length === 2 && name === "velopack") {
    const file = tail[1] ?? "";
    if (/^releases\./.test(file))
      return serveVelopack(ctx, channel, file, await recordedAppReleases(ctx));
    // The package name is checked before ANY read, the recorded-releases D1 read included.
    if (!isVelopackFileName(file)) return null;
    return serveVelopackPackage(
      ctx,
      channel,
      file,
      await recordedAppReleases(ctx),
    );
  }
  return null;
}
