/**
 * `GET /api/products/<product>/downloads[?channel=<channel>]` — one product's downloads and
 * store links, shaped for the product page's "Get it" section (PX-W2; portal spec §4.20, §5.4,
 * gaps G2 and G4).
 *
 * ── WHERE EACH PART COMES FROM ───────────────────────────────────────────────────────────────
 *
 * The portal is Identity's, and Identity may not import Distribution or Release (AGENTS.md
 * rule 6), so every product fact arrives through Core:
 *
 *   - the files per platform and release, the recommended picks and the store links come from
 *     Distribution's `customerDownloads` descriptor hook (`core/hooks.ts`, implemented over the
 *     public page's own helpers in `services/distribution/page/customer.ts`);
 *   - the visitor's platform comes from Core's `detectPlatform` (`core/platformDetect.ts`), the
 *     function the public page uses, reading only the request's User-Agent and low-entropy
 *     client hints;
 *   - what THIS account may download is decided here, by the predicates the token mint and the
 *     redemption already apply (`api.ts`): `accountMayDownload` per release (delivery access over
 *     the account's linked licences) and `downloadTarget` per file (a redirectable source). So
 *     the page never offers a button the mint would refuse, and a refused file says why.
 *
 * ── WHAT A FILE'S `reason` MEANS ─────────────────────────────────────────────────────────────
 *
 *   - `license_inactive`: the deliverable needs a usable licence and none of the account's is
 *     (expired, suspended, past its offline grace).
 *   - `not_entitled`: the deliverable is `entitled` and no licence's entitlement window holds
 *     this release's channel or version (an update window that ended, a beta not included).
 *   - `not_hosted`: covered, but nothing here can hand the bytes to a browser: no bytes-host
 *     copy and no GitHub storage URL in a PUBLIC repository, or, for a non-public deliverable, a
 *     deployment without download tickets (`DOWNLOAD_TICKET_KEY` unset, PX-W3), a file with no
 *     recorded SHA-256, or a file whose only source is a PRIVATE GitHub repository (left out,
 *     plans/PX-W3.md Q7). A PUBLIC build is served from the bytes host whatever its location, a
 *     private repository's included.
 *
 * The portal UI turns those into the "Not included" text (§4.20); the codes are not copy.
 *
 * ── GATES, IN ORDER ──────────────────────────────────────────────────────────────────────────
 *
 * The same three as the release listing (portal enabled, releases enabled, Release on), then a
 * linked licence for the product (a stranger learns nothing, not even that the product has
 * builds: every refusal is the same 404), then the per-product rate-limit shard (R5-05),
 * charged only after ownership is proven.
 */

import { CHANNEL_STABLE } from "@polaris-key/protocol";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import { APP_DELIVERABLE_ID } from "@polaris-key/manifest";
import type { Db, Env } from "../../../core/platform.js";
import type {
  CustomerFile,
  CustomerRelease,
  CustomerStoreLink,
} from "../../../core/hooks.js";
import {
  PAGE_PLATFORMS,
  PLATFORM_LABELS,
  detectPlatform,
  type DetectedPlatform,
  type PagePlatform,
} from "../../../core/platformDetect.js";
import { ErrorCode } from "../../../core/errors.js";
import { getProduct } from "../../../core/data.js";
import {
  getPortalProductSettings,
  listPortalArtifacts,
  releaseServiceEnabled,
} from "./repo.js";
import type { PortalSession } from "./session.js";
import {
  accountMayDownload,
  deliveryGate,
  downloadTarget,
  err,
  hasLinkedProductLicense,
  notFound,
  portalJson,
  requireActionRateLimit,
  type PortalHooksFor,
} from "./api.js";

/** How many of the channel's newest releases the page considers (the recommendation may fall
 *  back to an older covered one, §5.4 "Download <last covered version>"). */
export const PORTAL_DOWNLOAD_RELEASES = 10;

/** The page's per-account budget in the product's own shard (reads only; a page load is one). */
const DOWNLOADS_RATE_LIMIT = 60;

/** A channel name as the query may carry it; anything else is refused before any read. */
const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type PortalFileReason =
  | "license_inactive"
  | "not_entitled"
  | "not_hosted";

export interface PortalFile extends CustomerFile {
  /** The token mint (`POST /api/releases/<p>/<releaseId>/artifacts/<artifactId>/token`) will
   *  answer this file for this account. */
  canDownload: boolean;
  /** Why not, when `canDownload` is false; `null` otherwise. */
  reason: PortalFileReason | null;
}

export interface PortalRecommendation {
  platform: PagePlatform;
  label: string;
  releaseId: string;
  version: string;
  /** `files[0]` runs on every arch of the platform; say "Universal", offer nothing else. */
  universal: boolean;
  /** The release is the platform's newest; `false` = an older covered one (expired update window). */
  latest: boolean;
  /** Downloadable files, best first: one when universal, else one per arch (Apple silicon
   *  first on a Mac; the detected arch first when the browser said which). */
  files: PortalFile[];
}

export interface PortalPlatformDownloads {
  platform: PagePlatform;
  label: string;
  /** What to offer first, or `null` when nothing on this platform can be downloaded. */
  recommended: PortalRecommendation | null;
  /** The platform's files in its newest release, covered or not ("Not included" rows). */
  files: PortalFile[];
}

export interface PortalDownloads {
  product: { slug: string; name: string };
  channel: string;
  /** `false` when the product serves no downloads here (Distribution off, no release
   *  configuration, or the channel does not exist); every list is then empty. */
  available: boolean;
  /** The app's delivery access, or `null` when unavailable. */
  access: ReleaseAccess | null;
  detected: DetectedPlatform;
  /** The channel's newest release, whatever it covers. */
  latest: {
    releaseId: string;
    version: string;
    title: string | null;
    publishedAt: number | null;
  } | null;
  /** The detected platform's recommendation, or `null` (unknown platform, no build for it, or
   *  nothing covered: the page then shows "See downloads" or the phone actions, §5.4). */
  recommended: PortalRecommendation | null;
  /** Platforms with files, in `PAGE_PLATFORMS` order. */
  platforms: PortalPlatformDownloads[];
  /** Platform-free files of the newest release that has any (§4.20 "Extras"). */
  extras: PortalFile[];
  /** Every store outlet, `live` or not (§4.20 "Also yours on"). */
  stores: CustomerStoreLink[];
}

function emptyDownloads(
  product: { slug: string; name: string },
  channel: string,
  detected: DetectedPlatform,
): PortalDownloads {
  return {
    product,
    channel,
    available: false,
    access: null,
    detected,
    latest: null,
    recommended: null,
    platforms: [],
    extras: [],
    stores: [],
  };
}

/**
 * Shape one product's downloads for one account. The caller has proven the account holds a
 * licence for the product and that the portal serves its releases. Exported so the product page
 * call (`GET /api/products/<p>`, PX-W1) can embed the same answer.
 */
export async function productDownloads(
  env: Env,
  db: Db,
  q: {
    accountId: string;
    product: string;
    channel: string;
    headers: Headers;
    now: number;
    hooksFor: PortalHooksFor | undefined;
  },
): Promise<PortalDownloads | null> {
  const detected = detectPlatform(q.headers);
  const gate = await deliveryGate(db, q.hooksFor, q.product, q.now);
  if (!gate) {
    const row = await getProduct(db, q.product);
    if (!row) return null;
    return emptyDownloads(
      { slug: row.slug, name: row.name },
      q.channel,
      detected,
    );
  }
  const productName = { slug: gate.product.slug, name: gate.product.name };
  const shaped = gate.delivery.customerDownloads
    ? await gate.delivery.customerDownloads({
        channel: q.channel,
        limit: PORTAL_DOWNLOAD_RELEASES,
      })
    : null;
  if (!shaped) return emptyDownloads(productName, q.channel, detected);
  const mode = await gate.delivery.accessMode(APP_DELIVERABLE_ID);

  // Per release, LAZILY (each costs an artifact read and, for a public deliverable, a delivery
  // URL per file): is it covered for this account, and which files can be served? Most pages
  // need only the newest release; an older one is read only when a platform falls back to it.
  interface Annotated {
    release: CustomerRelease;
    files: PortalFile[];
    byId: Map<string, PortalFile>;
  }
  const memo = new Map<number, Promise<Annotated>>();
  // Entitlement is decided from the version and channel the hook returns (Release's
  // channelReleases), while the mint reads them through getPortalReleaseFacts. Both read the
  // same release_metadata rows today; if either source moves, the two can drift, which
  // test/portalDownloads.test.ts ("every file it offers is one the token mint
  // answers") guards against.
  const annotateNow = async (release: CustomerRelease): Promise<Annotated> => {
    const covered = await accountMayDownload(
      db,
      q.accountId,
      gate,
      mode,
      {
        deliverable_id: APP_DELIVERABLE_ID,
        version: release.version,
        channel: release.channel,
      },
      q.now,
    );
    // The portal's own artifact rows: the mint's input. A file the listing leaves out
    // (a signature or checksum by kind) is not offered.
    const rows = new Map(
      (await listPortalArtifacts(db, q.product, release.releaseId)).map((r) => [
        r.artifact_id,
        r,
      ]),
    );
    const files: PortalFile[] = [];
    for (const f of release.files) {
      const row = rows.get(f.artifactId);
      if (!row) continue;
      let reason: PortalFileReason | null = null;
      if (!covered)
        reason = mode === "entitled" ? "not_entitled" : "license_inactive";
      else if ((await downloadTarget(env, row, gate, mode)) === null)
        reason = "not_hosted";
      files.push({ ...f, canDownload: reason === null, reason });
    }
    return {
      release,
      files,
      byId: new Map(files.map((f) => [f.artifactId, f])),
    };
  };
  const annotate = (i: number): Promise<Annotated> => {
    let p = memo.get(i);
    if (!p) {
      p = annotateNow(shaped.releases[i]!);
      memo.set(i, p);
    }
    return p;
  };
  /** The newest release with a file matching `has`, annotated; `null` when none has one. A
   *  release is annotated only when its unannotated files already match. */
  const newestWith = async (
    has: (f: CustomerFile) => boolean,
  ): Promise<Annotated | null> => {
    for (let i = 0; i < shaped.releases.length; i++) {
      if (!shaped.releases[i]!.files.some(has)) continue;
      const a = await annotate(i);
      if (a.files.some(has)) return a;
    }
    return null;
  };

  const recommendationFor = async (
    platform: PagePlatform,
    newest: Annotated,
  ): Promise<PortalRecommendation | null> => {
    for (let i = 0; i < shaped.releases.length; i++) {
      const pick = shaped.releases[i]!.picks[platform];
      if (!pick) continue;
      const a = await annotate(i);
      let files = pick.artifactIds
        .map((id) => a.byId.get(id))
        .filter((f): f is PortalFile => f !== undefined && f.canDownload);
      if (!files.length) continue;
      const universal =
        pick.universal && files[0]!.artifactId === pick.artifactIds[0];
      if (!universal && detected.platform === platform && detected.arch) {
        const exact = files.filter((f) => f.arch === detected.arch);
        files = [...exact, ...files.filter((f) => f.arch !== detected.arch)];
      }
      return {
        platform,
        label: PLATFORM_LABELS[platform],
        releaseId: a.release.releaseId,
        version: a.release.version,
        universal,
        latest: newest.release.releaseId === a.release.releaseId,
        files: universal ? [files[0]!] : files,
      };
    }
    return null;
  };

  const platforms: PortalPlatformDownloads[] = [];
  for (const platform of PAGE_PLATFORMS) {
    const newest = await newestWith((f) => f.platform === platform);
    if (!newest) continue;
    platforms.push({
      platform,
      label: PLATFORM_LABELS[platform],
      recommended: await recommendationFor(platform, newest),
      files: newest.files.filter((f) => f.platform === platform),
    });
  }
  const withExtras = await newestWith((f) => f.platform === null);
  const head = shaped.releases[0];
  return {
    product: productName,
    channel: shaped.channel,
    available: true,
    access: mode,
    detected,
    latest: head
      ? {
          releaseId: head.releaseId,
          version: head.version,
          title: head.title,
          publishedAt: head.publishedAt,
        }
      : null,
    recommended: detected.platform
      ? (platforms.find((p) => p.platform === detected.platform)?.recommended ??
        null)
      : null,
    platforms,
    extras: withExtras?.files.filter((f) => f.platform === null) ?? [],
    stores: shaped.stores,
  };
}

/** `GET /api/products/<product>/downloads` (dispatched by `handlePortalApi`). */
export async function handleProductDownloads(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  product: string,
  now: number,
  hooksFor: PortalHooksFor | undefined,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  const productRow = await getProduct(db, product);
  if (!productRow) return notFound();
  const settings = await getPortalProductSettings(db, product);
  // The release listing's three gates (Task 7.2): the portal on, its releases module on, and
  // Release running for the product at all.
  if (
    settings.portal_enabled !== 1 ||
    settings.releases_enabled !== 1 ||
    !releaseServiceEnabled(productRow.services_json)
  )
    return notFound();
  if (!(await hasLinkedProductLicense(db, session.accountId, product)))
    return notFound();
  const limited = await requireActionRateLimit(
    req,
    env,
    session,
    "portalDownloads",
    now,
    DOWNLOADS_RATE_LIMIT,
    product,
  );
  if (limited) return limited;
  const requested = new URL(req.url).searchParams.get("channel");
  const channel = requested ?? CHANNEL_STABLE;
  if (!CHANNEL_RE.test(channel))
    return err(400, ErrorCode.BadRequest, "invalid channel");
  const body = await productDownloads(env, db, {
    accountId: session.accountId,
    product,
    channel,
    headers: req.headers,
    now,
    hooksFor,
  });
  if (!body) return notFound();
  return portalJson(body, 200, {
    // The answer depends on what detection read.
    vary: "Sec-CH-UA-Platform, Sec-CH-UA-Mobile, User-Agent",
  });
}
