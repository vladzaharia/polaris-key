/**
 * The public download page's MODEL (P2b-06): everything `GET /<p>/distribution/download.json`
 * answers and the ONLY input the HTML renderer (`render.ts`) reads, so the tests assert this
 * object and a smaller set of HTML properties.
 *
 * ── WHAT IS LISTED ──────────────────────────────────────────────────────────────────────────
 *
 * The page offers the product's STABLE channel to strangers, so it follows the storefront feeds'
 * rules exactly (`feeds/select.ts`, P2b-05) — the same functions, not a copy of them:
 *
 *   - no page at all unless the app's delivery access is `public` (`feedReaders`): a non-public
 *     deliverable has no page, and the console's not-found is what a stranger sees;
 *   - only releases the channel serves by Release's rules (`channelReleases`: an undeclared
 *     channel, a yanked release, a non-public deliverable never appear), live on the outlet
 *     (availability: derived for a self-hosted outlet, reported for a store), and not held there
 *     by a paused, halted or partial rollout;
 *   - only bytes with an immutable delivery URL, on the bytes host.
 *
 * A self-hosted outlet's entry (direct downloads, AltStore, F-Droid, Obtainium, Scoop) comes from
 * `selectFeed`. A STORE outlet (App Store, Play, Microsoft Store, Steam, itch, Flathub, Snap,
 * winget) is linked only while the channel has a release REPORTED live there (a CI report or a
 * connector); before that a store link would be a dead page. TestFlight and Play testing are
 * left out: they are for entitled accounts, and the bytes host has no sign-in (README §6.3).
 * `app-installer` and `web` wait for their own surfaces (P3-09's `.appinstaller`, P6-04's hosted
 * web build).
 *
 * ── WHAT IS NEVER TAKEN VERBATIM ────────────────────────────────────────────────────────────
 *
 * Outlet identities and listings come from `.pkey/distribution`, which any repo writer can push.
 * The manifest validator checks them on ingest; this module checks them AGAIN against the same
 * shapes before building anything from them (a row could predate a rule), and builds every URL
 * itself: store URLs from validated ids, deep links (`altstore://`, `sidestore://`,
 * `altstore-pal://`, `obtainium://`, `fdroidrepos://`, `ms-windows-store://`, `steam://`) from
 * Worker-minted feed URLs with `encodeURIComponent`. The only listing URL kept is `website`, and
 * only as a parsed `https:` URL. The renderer escapes every string on top of that.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────────
 *
 * One selection per outlet. The catalog and delivery readers are memoised for the build of one
 * model (`memoHooks`), so a release's builds and artifacts are read once however many outlets ask
 * (P2b-05's note: the per-release hooks re-read every release row per call, so nothing here calls
 * `availability()` or `deliveryUrl()` in a loop). The routes cache the result (`index.ts`).
 */

import {
  APP_DELIVERABLE_ID,
  HOMEBREW_CASK_PATTERN,
  NUMERIC_ID_PATTERN,
} from "@polaris-key/manifest";
import type { Db, Env } from "../../../core/platform.js";
import type {
  Delivery,
  ReleaseCatalog,
  ServiceHooks,
} from "../../../core/hooks.js";
import { listOutlets } from "../outlets.js";
import { FULL_ROLLOUT_BP } from "../rollouts.js";
import {
  feedOutlet,
  feedReaders,
  MAX_FEED_SCAN,
  pickOutlet,
  selectFeed,
  type FeedOutlet,
  type FeedReadContext,
} from "../feeds/select.js";
import type { RenderEntry } from "../feeds/render.js";
import { obtainiumConfig } from "../feeds/index.js";
import { FDROID_FEED } from "../feeds/fdroid.js";
import {
  PAGE_PLATFORMS,
  PLATFORM_LABELS,
  type PagePlatform,
} from "./detect.js";
import { QR_MAX_VERSION, qrCapacity } from "./qr.js";

/** The model's own version: bumped when a field changes meaning (SDKs read this document). */
export const DOWNLOAD_MODEL_VERSION = 1;

/** The channel the page offers. Beta channels are not on the page (P2b-06 Out). */
export const PAGE_CHANNEL = "stable";

/** Key purposes a stranger checks a download against; the upload key never signs what ships. */
const PUBLIC_KEY_PURPOSES = new Set([
  "android-app-signing",
  "android-sideload",
  "fdroid-repo",
  "sparkle-ed25519",
  "release",
  "msix-publisher",
]);

export type ActionKind =
  | "app-store"
  | "play"
  | "ms-store"
  | "steam"
  | "itch"
  | "flathub"
  | "snap"
  | "winget"
  | "homebrew"
  | "scoop"
  | "download"
  | "altstore"
  | "sidestore"
  | "altstore-pal"
  | "obtainium"
  | "fdroid";

/** One downloadable build: a payload with its immutable URL. */
export interface PageBuild {
  releaseId: string;
  version: string;
  buildId: string;
  platform: PagePlatform;
  arch: string;
  format: string | null;
  name: string;
  size: number | null;
  sha256: string | null;
  minOs: string | null;
  url: string;
  outletId: string;
}

/** One way to get the product. Every string here is Worker-built or validated. */
export interface PageAction {
  /** Stable within a model: `<kind>:<outletId>[:<platform>]`. */
  id: string;
  kind: ActionKind;
  outletId: string;
  platforms: PagePlatform[];
  /** A fixed Worker string ("App Store", "Add to AltStore", …). */
  label: string;
  /** An `https:` URL, or `null`. */
  url: string | null;
  /** A custom-scheme link the Worker built, or `null`. */
  deepLink: string | null;
  /** What the page's QR code encodes, or `null` for no code. */
  qr: string | null;
  /** A command to paste (Scoop, winget, Homebrew, Flatpak, Snap), or `null`. */
  command: string | null;
  /** The F-Droid repository's signing-certificate fingerprint, when the inventory has one. */
  fingerprint: string | null;
  /** The version the action leads to, when known. */
  version: string | null;
  /** `download` only: the build it downloads by default. */
  build: PageBuild | null;
}

export interface PagePlatformGroup {
  platform: PagePlatform;
  label: string;
  /** The id of the action to offer first, or `null`. */
  primary: string | null;
  /** Every action for this platform, best first (the primary included). */
  actions: string[];
  /** Every downloadable build for this platform, newest release first. */
  builds: PageBuild[];
}

export interface DownloadModel {
  schemaVersion: number;
  product: { slug: string; name: string };
  channel: string;
  /** The HTML page on the bytes host, or `null` when this deployment has no bytes host. */
  pageUrl: string | null;
  listing: {
    name: string;
    subtitle: string | null;
    description: string | null;
    developerName: string | null;
    website: string | null;
  };
  /** The newest release any action or build leads to, or `null`. */
  release: {
    releaseId: string;
    version: string;
    title: string | null;
    publishedAt: number | null;
    /** A plain-text summary of the notes, only when the product's metadata is public. */
    summary: string | null;
  } | null;
  platforms: PagePlatformGroup[];
  actions: PageAction[];
  /** The key inventory's public fingerprints (operator entries only). */
  keys: { purpose: string; sha256: string; outletId: string | null }[];
}

export interface PageContext {
  db: Db;
  env: Env;
  product: { slug: string; name: string };
  hooks: ServiceHooks;
  /** Where the storefront feeds are served (the console host), or `null`: feed rows are then
   *  left out rather than linked to a host that does not serve them. */
  consoleOrigin: string | null;
  /** The bytes host's origin, or `null`. */
  bytesOrigin: string | null;
}

// ── Memoised readers ─────────────────────────────────────────────────────────────────────────

function memoCatalog(c: ReleaseCatalog): ReleaseCatalog {
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: unknown[], f: () => Promise<T>): Promise<T> => {
    const k = JSON.stringify(key);
    let p = memo.get(k);
    if (!p) {
      p = f();
      memo.set(k, p);
    }
    return p as Promise<T>;
  };
  return {
    deliverables: () => once(["d"], () => c.deliverables()),
    releases: (d) => once(["r", d], () => c.releases(d)),
    builds: (r) => once(["b", r], () => c.builds(r)),
    artifacts: (r, b) =>
      b === undefined
        ? once(["a", r], () => c.artifacts(r))
        : c.artifacts(r, b),
    channelPolicies: (d) => c.channelPolicies(d),
    yanks: () => once(["y"], () => c.yanks()),
    channelReleases: (d, ch) =>
      once(["c", d, ch], () => c.channelReleases(d, ch)),
    metadataAccess: () => once(["m"], () => c.metadataAccess()),
    accessSelector: (s) => c.accessSelector(s),
    resolve: (q) => c.resolve(q),
    openSource: (ref, req) => c.openSource(ref, req),
    installScript: (o) => c.installScript(o),
  };
}

function memoDelivery(d: Delivery): Delivery {
  const access = new Map<string, ReturnType<Delivery["accessMode"]>>();
  return {
    ...d,
    accessMode: (deliverable) => {
      let p = access.get(deliverable);
      if (!p) {
        p = d.accessMode(deliverable);
        access.set(deliverable, p);
      }
      return p;
    },
  };
}

/** The hooks with their catalog and delivery readers memoised for one model build. */
export function memoHooks(h: ServiceHooks): ServiceHooks {
  const catalog = h.releaseCatalog();
  const delivery = h.delivery();
  const c = catalog ? memoCatalog(catalog) : null;
  const d = delivery ? memoDelivery(delivery) : null;
  return {
    releaseCatalog: () => c,
    delivery: () => d,
    outletCapabilities: (id) => h.outletCapabilities(id),
  };
}

// ── Validation (the manifest's shapes, re-checked) ──────────────────────────────────────────

const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MS_PRODUCT_ID_RE = /^[A-Za-z0-9]{12}$/;
const ITCH_TARGET_RE = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/;
const FLATPAK_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const SNAP_NAME_RE = /^[a-z0-9](?:-?[a-z0-9]){0,39}$/;
const WINGET_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,31}(\.[A-Za-z0-9][A-Za-z0-9-]{0,31}){1,7}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** One line of listing text: no control characters (the manifest's `LINE_RE`). */
const LINE_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const PROSE_RE = /^[^\u0000-\u0008\u000b-\u001f\u007f]{1,4000}$/;

function idOf(v: unknown, re: RegExp, max = 255): string | null {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  return typeof s === "string" && s.length <= max && re.test(s) ? s : null;
}

function lineOf(v: unknown): string | null {
  return typeof v === "string" && LINE_RE.test(v) ? v : null;
}

/** An `https:` URL, re-serialised by the URL parser; anything else is `null`. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.username === "" && u.password === ""
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

/** A plain-text summary of release notes: the `pkey:summary` block, else the first paragraph
 *  above the first `## ` heading, light Markdown stripped, at most 600 characters. */
export function notesSummary(notes: string | null): string | null {
  if (!notes) return null;
  const strip = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]+/g, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
  const fenced = notes.match(
    /<!--\s*pkey:summary\s*-->\s*([\s\S]*?)\s*<!--\s*\/pkey:summary\s*-->/,
  )?.[1];
  let text = fenced && fenced.trim() ? strip(fenced) : "";
  if (!text) {
    const head = notes.split(/^##\s/m)[0] ?? "";
    text =
      head
        .split(/\n\s*\n/)
        .map(strip)
        .find((p) => p.length > 0) ?? "";
  }
  if (!text) return null;
  return text.length > 600 ? `${text.slice(0, 600).trimEnd()}…` : text;
}

// ── Building ─────────────────────────────────────────────────────────────────────────────────

const STORE_KINDS = [
  "app-store",
  "play",
  "ms-store",
  "steam",
  "itch",
  "flathub",
  "snap",
  "winget",
] as const;
type StoreKind = (typeof STORE_KINDS)[number];

/** The order actions are offered in, per platform: the first present is the primary. */
const PRIORITY: Readonly<Record<PagePlatform, readonly ActionKind[]>> = {
  ios: ["app-store", "altstore", "sidestore", "altstore-pal", "download"],
  android: ["play", "download", "fdroid", "obtainium"],
  macos: ["download", "homebrew", "steam", "itch"],
  windows: ["ms-store", "download", "steam", "itch", "winget", "scoop"],
  linux: ["download", "flathub", "snap", "steam", "itch"],
};

const DESKTOP: PagePlatform[] = ["windows", "macos", "linux"];

/** A build's arch preference when the visitor's is unknown (a universal build first). */
const ARCH_PREFERENCE: Readonly<Record<PagePlatform, readonly string[]>> = {
  ios: ["universal", "any", "arm64"],
  android: ["universal", "any", "arm64", "armv7", "x86_64"],
  macos: ["universal", "any", "arm64", "x86_64"],
  windows: ["universal", "any", "x86_64", "arm64", "x86"],
  linux: ["universal", "any", "x86_64", "arm64"],
};

/** The build of `builds` (one release) to offer by default, or with a known `arch`. */
export function pickBuild(
  builds: readonly PageBuild[],
  platform: PagePlatform,
  arch: string | null = null,
): PageBuild | null {
  if (!builds.length) return null;
  const newest = builds[0]!.releaseId;
  const same = builds.filter((b) => b.releaseId === newest);
  if (arch) {
    const exact = same.find((b) => b.arch === arch);
    if (exact) return exact;
  }
  const pref = ARCH_PREFERENCE[platform];
  const rank = (a: string) => {
    const i = pref.indexOf(a);
    return i < 0 ? pref.length : i;
  };
  return [...same].sort((a, b) => rank(a.arch) - rank(b.arch))[0] ?? null;
}

function pageBuild(e: RenderEntry, outletId: string): PageBuild | null {
  if (!(PAGE_PLATFORMS as readonly string[]).includes(e.platform ?? ""))
    return null;
  const url = httpsUrl(e.url) ?? null;
  if (!url) return null;
  const meta = e.metadata ?? {};
  const minOs =
    e.minOs ??
    (typeof meta.minOSVersion === "string"
      ? lineOf(meta.minOSVersion)
      : null) ??
    (typeof meta.minSdk === "number" && Number.isSafeInteger(meta.minSdk)
      ? `API ${meta.minSdk}`
      : null);
  return {
    releaseId: e.releaseId,
    version: e.version,
    buildId: e.buildId,
    platform: e.platform as PagePlatform,
    arch: e.arch,
    format: formatOf(e.name),
    name: e.name,
    size: e.size,
    sha256: e.sha256 && FINGERPRINT_RE.test(e.sha256) ? e.sha256 : null,
    minOs: minOs === null ? null : lineOf(minOs),
    url,
    outletId,
  };
}

/** The archive format a payload name ends in, as the page labels it. */
function formatOf(name: string): string | null {
  const lower = name.toLowerCase();
  for (const ext of [
    "appimage",
    "flatpak",
    "tar.gz",
    "tar.xz",
    "dmg",
    "pkg",
    "msix",
    "msi",
    "exe",
    "zip",
    "apk",
    "ipa",
    "deb",
    "rpm",
  ])
    if (lower.endsWith(`.${ext}`)) return ext;
  return null;
}

/** `?outlet=<id>` when `outlet` is not the one a feed URL without it would pick. */
async function outletQuery(
  db: Db,
  product: string,
  kind: string,
  outlet: FeedOutlet,
): Promise<string> {
  const fallback = await pickOutlet(db, product, { kinds: [kind] });
  return fallback?.id === outlet.id
    ? ""
    : `?outlet=${encodeURIComponent(outlet.id)}`;
}

interface StoreState {
  /** outlet → release → live (any build reported live). */
  live: Map<string, Set<string>>;
  /** outlet → releases held back there. */
  held: Map<string, Set<string>>;
}

async function storeState(db: Db, product: string): Promise<StoreState> {
  const live = new Map<string, Set<string>>();
  for (const r of await db.all<{ outlet_id: string; release_id: string }>(
    `SELECT DISTINCT outlet_id, release_id FROM dist_availability
      WHERE product = ? AND state = 'live'`,
    product,
  )) {
    const set = live.get(r.outlet_id) ?? new Set<string>();
    set.add(r.release_id);
    live.set(r.outlet_id, set);
  }
  const held = new Map<string, Set<string>>();
  for (const r of await db.all<{
    outlet_id: string;
    release_id: string;
    rollout_bp: number;
    state: string;
  }>(
    `SELECT outlet_id, release_id, rollout_bp, state FROM dist_rollouts
      WHERE product = ? AND deliverable_id = ?`,
    product,
    APP_DELIVERABLE_ID,
  )) {
    // `feeds/select.ts` `heldReleases`: anything but complete (or active at 100%) holds.
    const done =
      r.state === "complete" ||
      (r.state === "active" && r.rollout_bp >= FULL_ROLLOUT_BP);
    if (done) continue;
    const set = held.get(r.outlet_id) ?? new Set<string>();
    set.add(r.release_id);
    held.set(r.outlet_id, set);
  }
  return { live, held };
}

/** A store outlet's link (and the platforms it serves), or `null` when its identity is unusable. */
function storeLink(
  kind: StoreKind,
  identity: Record<string, unknown>,
): Pick<
  PageAction,
  "label" | "url" | "deepLink" | "command" | "platforms"
> | null {
  switch (kind) {
    case "app-store": {
      const id = idOf(identity.appleId, NUMERIC_ID_PATTERN, 20);
      return id
        ? {
            label: "App Store",
            url: `https://apps.apple.com/app/id${id}`,
            deepLink: null,
            command: null,
            platforms: ["ios"],
          }
        : null;
    }
    case "play": {
      const id = idOf(identity.packageName, ANDROID_PACKAGE_RE);
      return id
        ? {
            label: "Google Play",
            url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`,
            deepLink: null,
            command: null,
            platforms: ["android"],
          }
        : null;
    }
    case "ms-store": {
      const id = idOf(identity.productId, MS_PRODUCT_ID_RE);
      return id
        ? {
            label: "Microsoft Store",
            url: `https://apps.microsoft.com/detail/${encodeURIComponent(id)}`,
            deepLink: `ms-windows-store://pdp/?productid=${encodeURIComponent(id)}`,
            command: null,
            platforms: ["windows"],
          }
        : null;
    }
    case "steam": {
      const id = idOf(identity.appId, NUMERIC_ID_PATTERN, 20);
      return id
        ? {
            label: "Steam",
            url: `https://store.steampowered.com/app/${id}/`,
            deepLink: `steam://store/${id}`,
            command: null,
            platforms: DESKTOP,
          }
        : null;
    }
    case "itch": {
      const m =
        typeof identity.target === "string"
          ? ITCH_TARGET_RE.exec(identity.target)
          : null;
      if (!m) return null;
      const user = m[1]!.toLowerCase().replace(/_/g, "-");
      return {
        label: "itch.io",
        url: `https://${user}.itch.io/${encodeURIComponent(m[2]!)}`,
        deepLink: null,
        command: null,
        platforms: DESKTOP,
      };
    }
    case "flathub": {
      const id = idOf(identity.appId, FLATPAK_ID_RE);
      return id
        ? {
            label: "Flathub",
            url: `https://flathub.org/apps/${encodeURIComponent(id)}`,
            deepLink: null,
            command: `flatpak install flathub ${id}`,
            platforms: ["linux"],
          }
        : null;
    }
    case "snap": {
      const id = idOf(identity.name, SNAP_NAME_RE);
      return id
        ? {
            label: "Snap Store",
            url: `https://snapcraft.io/${id}`,
            deepLink: null,
            command: `sudo snap install ${id}`,
            platforms: ["linux"],
          }
        : null;
    }
    case "winget": {
      const id = idOf(identity.packageIdentifier, WINGET_ID_RE);
      return id
        ? {
            label: "winget",
            url: null,
            deepLink: null,
            command: `winget install --id ${id} --exact`,
            platforms: ["windows"],
          }
        : null;
    }
  }
}

function action(
  a: Omit<PageAction, "id" | "fingerprint" | "build" | "qr"> &
    Partial<Pick<PageAction, "fingerprint" | "build" | "qr">>,
  suffix = "",
): PageAction {
  const out: PageAction = {
    id: `${a.kind}:${a.outletId}${suffix}`,
    fingerprint: null,
    build: null,
    qr: null,
    ...a,
  };
  // A code is offered only for text the page's encoder can draw (version 10, 213 bytes): an
  // Obtainium app config does not fit, and its https link is there to tap instead.
  if (
    out.qr !== null &&
    new TextEncoder().encode(out.qr).length > qrCapacity(QR_MAX_VERSION)
  )
    out.qr = null;
  return out;
}

/**
 * Build the page model, or `null` when the product has no public page (no release configuration,
 * Release or Distribution off, a non-public app deliverable, or a channel that does not exist).
 */
export async function buildDownloadModel(
  ctx: PageContext,
): Promise<DownloadModel | null> {
  const hooks = memoHooks(ctx.hooks);
  const fctx: FeedReadContext = {
    db: ctx.db,
    product: ctx.product,
    hooks,
    origin: ctx.consoleOrigin ?? ctx.bytesOrigin ?? "https://invalid.invalid",
    env: ctx.env,
  };
  const readers = await feedReaders(fctx);
  if (!readers) return null;
  const { catalog, delivery, notesPublic } = readers;
  const history = await catalog.channelReleases(
    APP_DELIVERABLE_ID,
    PAGE_CHANNEL,
  );
  if (!history) return null;
  const slug = ctx.product.slug;
  const outlets = (await listOutlets(ctx.db, slug))
    .filter((o) => o.removed_at === null)
    .map(feedOutlet);

  const actions: PageAction[] = [];
  const builds: PageBuild[] = [];
  const feedBase = ctx.consoleOrigin
    ? `${ctx.consoleOrigin}/${slug}/distribution`
    : null;
  const seenUrls = new Set<string>();
  const addBuilds = (entries: readonly RenderEntry[], outletId: string) => {
    for (const e of entries) {
      const b = pageBuild(e, outletId);
      if (b && !seenUrls.has(b.url)) {
        seenUrls.add(b.url);
        builds.push(b);
      }
    }
  };
  const one = (
    outlet: FeedOutlet,
    platform: string,
    extra: { allBuilds?: boolean; limit?: number } = {},
  ) =>
    selectFeed(fctx, history.channel, {
      kinds: [outlet.kind],
      outletId: outlet.id,
      platform,
      liveness: "availability",
      limit: extra.limit ?? 1,
      ...(extra.allBuilds ? { allBuilds: true } : {}),
    });

  let state: StoreState | null = null;
  for (const outlet of outlets) {
    switch (outlet.kind) {
      case "direct": {
        const offered = Array.isArray(outlet.identity.platforms)
          ? (outlet.identity.platforms as unknown[]).filter(
              (p): p is PagePlatform =>
                (PAGE_PLATFORMS as readonly string[]).includes(p as string),
            )
          : // A direct outlet that names no platforms offers what can be installed from a file:
            // an iOS build cannot (it goes through AltStore or a store), unless named.
            PAGE_PLATFORMS.filter((p) => p !== "ios");
        for (const platform of offered) {
          const sel = await one(outlet, platform, { allBuilds: true });
          if (!sel?.entries.length) continue;
          addBuilds(sel.entries, outlet.id);
          if (platform === "windows" && feedBase) {
            const q = await outletQuery(ctx.db, slug, "direct", outlet);
            actions.push(
              action({
                kind: "scoop",
                outletId: outlet.id,
                platforms: ["windows"],
                label: "Scoop",
                url: null,
                deepLink: null,
                command: `scoop install ${feedBase}/scoop/${encodeURIComponent(history.channel)}.json${q}`,
                version: sel.entries[0]!.version,
              }),
            );
          }
          const cask = idOf(
            outlet.identity.homebrewCask,
            HOMEBREW_CASK_PATTERN,
          );
          if (platform === "macos" && cask)
            actions.push(
              action({
                kind: "homebrew",
                outletId: outlet.id,
                platforms: ["macos"],
                label: "Homebrew",
                url: null,
                deepLink: null,
                command: `brew install --cask ${cask}`,
                version: null,
              }),
            );
        }
        break;
      }

      case "altstore":
      case "altstore-pal": {
        if (!feedBase) break;
        const sel = await one(outlet, "ios");
        const head = sel?.entries[0];
        if (!head) break;
        if (
          outlet.kind === "altstore-pal" &&
          typeof outlet.identity.marketplaceId !== "string"
        )
          break;
        const q = await outletQuery(ctx.db, slug, outlet.kind, outlet);
        const source = `${feedBase}/${outlet.kind}/${encodeURIComponent(history.channel)}/source.json${q}`;
        const enc = encodeURIComponent(source);
        if (outlet.kind === "altstore-pal") {
          actions.push(
            action({
              kind: "altstore-pal",
              outletId: outlet.id,
              platforms: ["ios"],
              label: "Add to AltStore PAL",
              url: source,
              deepLink: `altstore-pal://source?url=${enc}`,
              qr: `altstore-pal://source?url=${enc}`,
              command: null,
              version: head.version,
            }),
          );
          break;
        }
        actions.push(
          action({
            kind: "altstore",
            outletId: outlet.id,
            platforms: ["ios"],
            label: "Add to AltStore",
            url: source,
            deepLink: `altstore://source?url=${enc}`,
            qr: `altstore://source?url=${enc}`,
            command: null,
            version: head.version,
          }),
          action({
            kind: "sidestore",
            outletId: outlet.id,
            platforms: ["ios"],
            label: "Add to SideStore",
            url: source,
            deepLink: `sidestore://source?url=${enc}`,
            qr: `sidestore://source?url=${enc}`,
            command: null,
            version: head.version,
          }),
        );
        break;
      }

      case "obtainium": {
        const sel = await one(outlet, "android");
        if (!sel?.entries.length) break;
        addBuilds(sel.entries, outlet.id);
        if (!feedBase) break;
        const config = await obtainiumConfig(
          { ...fctx, origin: ctx.consoleOrigin! },
          history.channel,
          outlet.id,
        );
        if (config === null) break;
        const deep = `obtainium://app/${encodeURIComponent(JSON.stringify(config))}`;
        const fallback = `https://apps.obtainium.imranr.dev/redirect?r=${encodeURIComponent(deep)}`;
        actions.push(
          action({
            kind: "obtainium",
            outletId: outlet.id,
            platforms: ["android"],
            label: "Add to Obtainium",
            url: fallback,
            deepLink: deep,
            qr: fallback,
            command: null,
            version: sel.entries[0]!.version,
          }),
        );
        break;
      }

      case "fdroid-repo": {
        const sel = await one(outlet, "android");
        if (!sel?.entries.length) break;
        addBuilds(sel.entries, outlet.id);
        if (!feedBase) break;
        // The relay serves only what CI registered: no `entry.jar`, no repository yet.
        const registered = await ctx.db.first<{ one: number }>(
          `SELECT 1 AS one FROM dist_feed_files
            WHERE product = ? AND feed = ? AND channel = ? AND path = 'entry.jar'`,
          slug,
          FDROID_FEED,
          history.channel,
        );
        if (!registered) break;
        // Only the default F-Droid outlet has a repository (the relay takes no `?outlet=`).
        const fallback = await pickOutlet(ctx.db, slug, {
          kinds: ["fdroid-repo"],
        });
        if (fallback?.id !== outlet.id) break;
        const keys = (await delivery.keys({ purpose: "fdroid-repo" })).filter(
          (k) => FINGERPRINT_RE.test(k.sha256),
        );
        // F-Droid pins ONE fingerprint; with several entries (a rotation) none is guessed.
        const fingerprint = keys.length === 1 ? keys[0]!.sha256 : null;
        const repo = `${feedBase}/fdroid/${encodeURIComponent(history.channel)}/repo`;
        const withFp = fingerprint
          ? `${repo}?fingerprint=${fingerprint}`
          : repo;
        actions.push(
          action({
            kind: "fdroid",
            outletId: outlet.id,
            platforms: ["android"],
            label: "Add to F-Droid",
            url: withFp,
            deepLink: `fdroidrepos://${withFp.slice("https://".length)}`,
            qr: withFp,
            command: null,
            fingerprint,
            version: sel.entries[0]!.version,
          }),
        );
        break;
      }

      default: {
        if (!(STORE_KINDS as readonly string[]).includes(outlet.kind)) break;
        const link = storeLink(outlet.kind as StoreKind, outlet.identity);
        if (!link) break;
        state ??= await storeState(ctx.db, slug);
        const live = state.live.get(outlet.id);
        const held = state.held.get(outlet.id);
        const release = history.releases
          .slice(0, MAX_FEED_SCAN)
          .find(
            (r) =>
              !r.yanked && !held?.has(r.releaseId) && live?.has(r.releaseId),
          );
        if (!release) break;
        actions.push(
          action({
            kind: outlet.kind as StoreKind,
            outletId: outlet.id,
            ...link,
            qr: null,
            version: release.version,
          }),
        );
      }
    }
  }

  // One `download` action per platform with builds, leading to its default build.
  const order = new Map(history.releases.map((r, i) => [r.releaseId, i]));
  builds.sort(
    (a, b) =>
      (order.get(a.releaseId) ?? 1e9) - (order.get(b.releaseId) ?? 1e9) ||
      PAGE_PLATFORMS.indexOf(a.platform) - PAGE_PLATFORMS.indexOf(b.platform) ||
      (a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0),
  );
  for (const platform of PAGE_PLATFORMS) {
    const pick = pickBuild(
      builds.filter((b) => b.platform === platform),
      platform,
    );
    if (!pick) continue;
    actions.push(
      action(
        {
          kind: "download",
          outletId: pick.outletId,
          platforms: [platform],
          label: "Download",
          url: pick.url,
          deepLink: null,
          command: null,
          version: pick.version,
          build: pick,
        },
        `:${platform}`,
      ),
    );
  }

  const platforms: PagePlatformGroup[] = [];
  for (const platform of PAGE_PLATFORMS) {
    const mine = actions.filter((a) => a.platforms.includes(platform));
    const rank = (k: ActionKind) => {
      const i = PRIORITY[platform].indexOf(k);
      return i < 0 ? PRIORITY[platform].length : i;
    };
    mine.sort(
      (a, b) =>
        rank(a.kind) - rank(b.kind) ||
        (a.outletId < b.outletId ? -1 : a.outletId > b.outletId ? 1 : 0),
    );
    const platformBuilds = builds.filter((b) => b.platform === platform);
    if (!mine.length && !platformBuilds.length) continue;
    platforms.push({
      platform,
      label: PLATFORM_LABELS[platform],
      primary: mine[0]?.id ?? null,
      actions: mine.map((a) => a.id),
      builds: platformBuilds,
    });
  }

  // The release the page talks about: the newest any action or build leads to.
  const offered = new Set<string>([
    ...builds.map((b) => b.version),
    ...actions.map((a) => a.version).filter((v): v is string => v !== null),
  ]);
  const newest = history.releases.find((r) => offered.has(r.version)) ?? null;

  const listingSource =
    outlets.find((o) => o.kind === "direct" && o.listing)?.listing ??
    outlets.find((o) => o.listing)?.listing ??
    null;
  const listingName = lineOf(listingSource?.name);
  const description =
    typeof listingSource?.description === "string" &&
    PROSE_RE.test(listingSource.description)
      ? listingSource.description
      : null;

  const keys = (await delivery.keys())
    .filter(
      (k) =>
        PUBLIC_KEY_PURPOSES.has(k.purpose) && FINGERPRINT_RE.test(k.sha256),
    )
    .map((k) => ({
      purpose: k.purpose,
      sha256: k.sha256,
      outletId: k.outletId,
    }));

  return {
    schemaVersion: DOWNLOAD_MODEL_VERSION,
    product: { slug, name: lineOf(ctx.product.name) ?? slug },
    channel: history.channel,
    pageUrl: ctx.bytesOrigin ? `${ctx.bytesOrigin}/${slug}` : null,
    listing: {
      name: listingName ?? lineOf(ctx.product.name) ?? slug,
      subtitle: lineOf(listingSource?.subtitle),
      description,
      developerName: lineOf(listingSource?.developerName),
      website: httpsUrl(listingSource?.website),
    },
    release: newest
      ? {
          releaseId: newest.releaseId,
          version: newest.version,
          title: lineOf(newest.title),
          publishedAt: newest.publishedAt,
          summary: notesPublic ? notesSummary(newest.notes) : null,
        }
      : null,
    platforms,
    actions,
    keys,
  };
}
