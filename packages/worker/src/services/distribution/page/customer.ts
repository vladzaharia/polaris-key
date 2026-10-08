/**
 * Distribution's `customerDownloads` hook (`core/hooks.ts`, PX-W2, portal gaps G2 and G4): the
 * app's downloads on one channel, shaped for a person who already holds the product. The
 * customer portal (Identity) reads it through Core, never by importing this file (AGENTS.md
 * rule 6).
 *
 * ── HOW IT DIFFERS FROM THE PUBLIC PAGE ─────────────────────────────────────────────────────
 *
 * The public download page (`model.ts`) is for strangers, so it exists only for a `public`
 * deliverable and lists only bytes with an immutable bytes-host URL that an outlet serves live.
 * This answer is for a signed-in customer, so it applies NO delivery access and mints NO URL:
 * the portal decides, per release, whether the account's licences cover it (Core's
 * `licenseEntitled`, the decision the token mint already makes) and, per file, whether it can
 * be served (the mint's own redirect predicate). What the two share is everything about the
 * PRODUCT rather than the visitor — taken from `model.ts`, not copied:
 *
 *   - the channel history (Release's `channelReleases`: membership, includes, pins; yanked
 *     releases are skipped here);
 *   - the platform set and labels (`core/platformDetect.ts`);
 *   - the arch preference behind the recommended picks (`ARCH_PREFERENCE`: a universal build
 *     alone; otherwise every arch, Apple silicon first on macOS), which is the "honest detection"
 *     rule of the portal spec (§4.20): a universal build is named as such, and two Mac builds are
 *     both offered because a server cannot tell Apple silicon from Intel;
 *   - the store links (`storeLink`: every URL built from a re-validated identity) and their
 *     liveness (`storeState`: reported live for a non-yanked channel release that no rollout
 *     holds back). A store that is not live is still returned, flagged, so the portal can say
 *     "coming soon" rather than nothing; the page omits it;
 *   - on request (`installSources`, P0-48), the page's own install sources (Homebrew, Scoop,
 *     AltStore, SideStore, F-Droid, Obtainium), read from the page model itself.
 *
 * Read-only, like every hook.
 */

import {
  APP_DELIVERABLE_ID,
  platformFromFileName,
} from "@polaris-key/manifest";
import type {
  CatalogArtifact,
  CatalogBuild,
  CustomerDownloads,
  CustomerDownloadsQuery,
  CustomerFile,
  CustomerPick,
  CustomerInstallSource,
  CustomerRelease,
  CustomerStoreLink,
  HookContext,
} from "../../../core/hooks.js";
import { qrSvg } from "../../../core/qr.js";
import {
  PAGE_PLATFORMS,
  type PagePlatform,
} from "../../../core/platformDetect.js";
import { listOutlets } from "../outlets.js";
import { feedOutlet, MAX_FEED_SCAN } from "../feeds/select.js";
import {
  ARCH_PREFERENCE,
  buildDownloadModel,
  FINGERPRINT_RE,
  formatOf,
  INSTALL_SOURCE_KINDS,
  lineOf,
  minOsOf,
  STORE_KINDS,
  storeLink,
  storeState,
  type PageAction,
  type StoreKind,
} from "./model.js";
import { consoleOriginOf } from "./index.js";
// The download page's own escaper (`render.ts`), so the portal's QR label matches the page's.
import { escapeHtmlDecimalApostrophe as esc } from "../../../core/platform.js";

/** The most releases one answer reads (each costs a builds and an artifacts read). */
export const CUSTOMER_MAX_RELEASES = 20;

/** Steam's key-activation page; the consumer appends `?key=<the held Steam key>` (G8). */
export const STEAM_ACTIVATE_URL =
  "https://store.steampowered.com/account/registerkey";

/** Artifact roles that are a person's download. Deltas, chunk indexes and bundles are update
 *  plumbing; signatures and checksums are verification material, not downloads. */
const USER_ROLES = new Set(["payload"]);

/** A GitHub-synced file with no role: verification sidecars by name are not downloads. */
const SIDECAR_RE =
  /\.(sig|asc|minisig|sha256|sha512|sha256sum|sha512sum|md5|blockmap)$|^(sha256sums|sha512sums|checksums)(\.txt)?$/i;

function isUserFacing(a: CatalogArtifact): boolean {
  if (a.role !== null) return USER_ROLES.has(a.role);
  return !SIDECAR_RE.test(a.name);
}

function pagePlatform(v: string | null | undefined): PagePlatform | null {
  return (PAGE_PLATFORMS as readonly string[]).includes(v ?? "")
    ? (v as PagePlatform)
    : null;
}

/** A file's platform: its own, else its build's, else (tied to no build) the one its name says.
 *  The same read-time inference the portal's release listing applies. */
function platformOf(
  a: CatalogArtifact,
  build: CatalogBuild | undefined,
): PagePlatform | null {
  if (a.platform !== null) return pagePlatform(a.platform);
  if (a.buildId !== null) return pagePlatform(build?.platform ?? null);
  return pagePlatform(platformFromFileName(a.name));
}

function archRank(platform: PagePlatform, arch: string | null): number {
  const pref = ARCH_PREFERENCE[platform];
  const i = arch === null ? -1 : pref.indexOf(arch);
  return i < 0 ? pref.length : i;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function customerFile(
  release: { releaseId: string; version: string },
  a: CatalogArtifact,
  build: CatalogBuild | undefined,
): CustomerFile {
  const platform = platformOf(a, build);
  return {
    releaseId: release.releaseId,
    artifactId: a.artifactId,
    version: release.version,
    name: a.name,
    buildId: a.buildId,
    platform,
    arch: a.arch ?? build?.arch ?? null,
    format: formatOf(a.name),
    role: a.role,
    sizeBytes:
      typeof a.sizeBytes === "number" && Number.isSafeInteger(a.sizeBytes)
        ? a.sizeBytes
        : null,
    sha256:
      a.sha256 && FINGERPRINT_RE.test(a.sha256.toLowerCase())
        ? a.sha256.toLowerCase()
        : null,
    minOs: build ? minOsOf(build.minOs, build.metadata) : null,
  };
}

/** Files in display order: platform, then the platform's arch preference, then name. */
function sortFiles(files: CustomerFile[]): CustomerFile[] {
  const pi = (p: string | null) => {
    const i =
      p === null ? -1 : (PAGE_PLATFORMS as readonly string[]).indexOf(p);
    return i < 0 ? PAGE_PLATFORMS.length : i;
  };
  return [...files].sort(
    (a, b) =>
      pi(a.platform) - pi(b.platform) ||
      (a.platform && b.platform
        ? archRank(a.platform as PagePlatform, a.arch) -
          archRank(b.platform as PagePlatform, b.arch)
        : 0) ||
      cmp(a.arch ?? "", b.arch ?? "") ||
      cmp(a.name, b.name),
  );
}

/**
 * The recommended files per platform for one release: one per arch (the first in display
 * order), best arch first. A universal (or arch-free `any`) build is offered ALONE and named as
 * such; otherwise every arch is, so a Mac visitor sees both builds, Apple silicon first.
 */
export function picksOf(
  files: readonly CustomerFile[],
): Partial<Record<PagePlatform, CustomerPick>> {
  const out: Partial<Record<PagePlatform, CustomerPick>> = {};
  for (const platform of PAGE_PLATFORMS) {
    const perArch = new Map<string, CustomerFile>();
    for (const f of files) {
      if (f.platform !== platform) continue;
      const arch = f.arch ?? "";
      if (!perArch.has(arch)) perArch.set(arch, f);
    }
    if (perArch.size === 0) continue;
    const ordered = [...perArch.values()].sort(
      (a, b) =>
        archRank(platform, a.arch) - archRank(platform, b.arch) ||
        cmp(a.arch ?? "", b.arch ?? ""),
    );
    const universal =
      ordered[0]!.arch === "universal" || ordered[0]!.arch === "any";
    out[platform] = {
      artifactIds: universal
        ? [ordered[0]!.artifactId]
        : ordered.map((f) => f.artifactId),
      universal,
    };
  }
  return out;
}

/** Build the answer (see the file comment). */
export async function customerDownloads(
  ctx: HookContext,
  q: CustomerDownloadsQuery,
): Promise<CustomerDownloads | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  if ((await catalog.metadataAccess()) === null) return null;
  const history = await catalog.channelReleases(APP_DELIVERABLE_ID, q.channel);
  if (!history) return null;
  const limit = Math.max(
    1,
    Math.min(CUSTOMER_MAX_RELEASES, Math.floor(q.limit) || 1),
  );

  const releases: CustomerRelease[] = [];
  for (const r of history.releases) {
    if (releases.length >= limit) break;
    if (r.yanked) continue;
    const builds = new Map(
      (await catalog.builds(r.releaseId)).map((b) => [b.buildId, b]),
    );
    const files = sortFiles(
      (await catalog.artifacts(r.releaseId))
        .filter(isUserFacing)
        .map((a) =>
          customerFile(
            r,
            a,
            a.buildId === null ? undefined : builds.get(a.buildId),
          ),
        ),
    );
    releases.push({
      releaseId: r.releaseId,
      version: r.version,
      title: lineOf(r.title),
      publishedAt: r.publishedAt,
      channel: r.channel,
      files,
      picks: picksOf(
        files.filter((f) => f.role === "payload" || f.role === null),
      ),
    });
  }

  const slug = ctx.product.slug;
  const stores: CustomerStoreLink[] = [];
  const outlets = (await listOutlets(ctx.db, slug))
    .filter((o) => o.removed_at === null)
    .map(feedOutlet)
    .filter((o) => (STORE_KINDS as readonly string[]).includes(o.kind));
  if (outlets.length) {
    const state = await storeState(ctx.db, slug);
    for (const outlet of outlets) {
      const link = storeLink(outlet.kind as StoreKind, outlet.identity);
      if (!link) continue;
      const live = state.live.get(outlet.id);
      const held = state.held.get(outlet.id);
      const release = history.releases
        .slice(0, MAX_FEED_SCAN)
        .find(
          (r) => !r.yanked && !held?.has(r.releaseId) && live?.has(r.releaseId),
        );
      stores.push({
        id: `${outlet.kind}:${outlet.id}`,
        kind: outlet.kind,
        outletId: outlet.id,
        platforms: [...link.platforms],
        label: link.label,
        url: link.url,
        deepLink: link.deepLink,
        command: link.command,
        activateUrl: outlet.kind === "steam" ? STEAM_ACTIVATE_URL : null,
        live: release !== undefined,
        version: release?.version ?? null,
      });
    }
    stores.sort(
      (a, b) =>
        STORE_KINDS.indexOf(a.kind as StoreKind) -
          STORE_KINDS.indexOf(b.kind as StoreKind) ||
        cmp(a.outletId, b.outletId),
    );
  }

  return {
    channel: history.channel,
    releases,
    stores,
    ...(q.installSources
      ? { installSources: await installSources(ctx, history.channel) }
      : {}),
  };
}

/**
 * The download page's install sources for one channel (P0-48): what a stranger is offered there
 * beyond the stores and the files, so an owner signed in to the portal sees every channel too.
 * Taken from the page model itself, not rebuilt: the same feed liveness, the same validated
 * identities, the same URLs. Empty when the page has no model (a non-public deliverable has no
 * feeds), and the feed-served sources are left out when the console origin is unknown.
 */
async function installSources(
  ctx: HookContext,
  channel: string,
): Promise<CustomerInstallSource[]> {
  const model = await buildDownloadModel({
    db: ctx.db,
    env: ctx.env,
    product: { slug: ctx.product.slug, name: ctx.product.name },
    hooks: ctx.hooks,
    consoleOrigin: consoleOriginOf(ctx.env),
    bytesOrigin: null,
    channel,
  });
  const kinds: readonly string[] = INSTALL_SOURCE_KINDS;
  return (model?.actions ?? [])
    .filter((a) => kinds.includes(a.kind))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      outletId: a.outletId,
      platforms: [...a.platforms],
      label: a.label,
      url: a.url,
      deepLink: a.deepLink,
      command: a.command,
      activateUrl: null,
      live: true,
      version: a.version,
      fingerprint: a.fingerprint,
      qr: scanCode(a),
    }));
}

/**
 * The QR code the portal shows on a computer, for the phone that will act on it (P0-48): the
 * deep link where there is one (scanned, `altstore://` or `fdroidrepos://` opens the app that
 * adds the source, while the source's `https:` URL opens JSON or a 404 in a browser), else the
 * page's own QR text (also when the deep link is too long to encode). A `data:` URI, as the
 * portal's sign-in code is (`identity/portal/deviceLogin.ts`): the portal's CSP allows
 * `img-src 'self' data:`. `null` for a command, or when neither fits the encoder (`core/qr.ts`).
 */
function scanCode(a: PageAction): string | null {
  for (const text of [a.deepLink, a.qr]) {
    const svg = text ? qrSvg(text, esc(`QR code: ${a.label}`)) : null;
    if (svg) return `data:image/svg+xml;base64,${btoa(svg)}`;
  }
  return null;
}
