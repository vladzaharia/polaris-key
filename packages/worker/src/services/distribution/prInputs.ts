/**
 * The PR plane's CI read (A-18i; notes/S-15 §4.4): `GET /<p>/distribution/pr/<store>?channel=<c>
 * [&outlet=<id>]` with a `pkeyci_` token and `distribution:report` (the default CI grant, the
 * same token that reports the step back). It answers everything a PR-plane generator in the CLI
 * needs to write one outlet's manifest for the channel's newest release, so the CLI never has to
 * reassemble Release's and Distribution's rules from public feeds:
 *
 *   - the outlet and its identity (winget's `packageIdentifier`, the tap and cask, the bucket and
 *     `scoop`, Flathub's `appId`);
 *   - the release the channel serves on that outlet, by the storefront feeds' own selection
 *     (`feeds/select.ts`): its version, date and the builds of the store's platform with their
 *     immutable HTTPS delivery URLs, SHA-256 and sizes;
 *   - the listing model's projection for the store's column (winget, Flathub; A-18b), with the
 *     release's per-locale store notes; the app-level fields the generators also read (the name,
 *     short description, website, developer, copyright, `tint` and `tintDark`, the content
 *     descriptors); `screenshots` stays empty until S-20's media host serves hosted copies
 *     (HA-02 with HA-06/HA-07): a storefront manifest never carries a developer's raw URL or a
 *     `dl` blob URL (notes/S-20 §4.2 L6), so the manifest listing's own URLs are not projected;
 *   - the public URLs a manifest points back at: `download.json` (Homebrew's livecheck), the
 *     Scoop feed (its `checkver` and `autoupdate`), the Flathub checker feed (`x-checker-data`);
 *   - for Scoop, the feed's own manifest, rendered by the same renderer as `/scoop/<ch>.json`;
 *   - whether the outlet's binaries update themselves (Homebrew's `auto_updates`).
 *
 * A PR-plane manifest sends strangers to our bytes, so, like the feeds, it exists only while the
 * app's delivery access is public: otherwise, and for an unknown store, outlet or channel, the
 * answer is the not-found. Nothing here is a secret.
 */

import { renderScoopManifest } from "./feeds/render.js";
import {
  feedReaders,
  selectFeedWith,
  type FeedOutlet,
  type FeedReadContext,
} from "./feeds/select.js";
import { readListing } from "./listing/store.js";
import { notesForProjection, releaseNotesView } from "./listing/notes.js";
import {
  fitReport,
  type FitReportRow,
} from "../../core/storefront/projection.js";
import type { ListingStore } from "../../core/storefront/listingProfiles.js";
import type {
  ListingModel,
  ListingReleaseNotes,
} from "../../core/storefront/listingModel.js";
import { PR_STORE_IDS, type PrStoreId } from "../../core/storefront/prPlane.js";

const FALLBACK_LOCALE = "en-US";

/** Which outlet and builds each PR-plane store reads. */
const SELECTION: Readonly<
  Record<
    PrStoreId,
    {
      kinds: readonly string[];
      platform: string;
      liveness: "availability" | "bytes";
      /** The listing column the store projects, if it has one. */
      column: ListingStore | null;
      accepts?: (o: FeedOutlet) => boolean;
    }
  >
> = {
  // winget installs our bytes: the outlet is a store kind with no report of its own, so its
  // builds are the ones we serve (the Flathub checker's rule).
  winget: {
    kinds: ["winget"],
    platform: "windows",
    liveness: "bytes",
    column: "winget",
  },
  homebrew: {
    kinds: ["direct"],
    platform: "macos",
    liveness: "availability",
    column: null,
    accepts: (o) =>
      typeof o.identity.homebrewCask === "string" &&
      (!Array.isArray(o.identity.platforms) ||
        o.identity.platforms.includes("macos")),
  },
  scoop: {
    kinds: ["direct"],
    platform: "windows",
    liveness: "availability",
    column: null,
    accepts: (o) =>
      !Array.isArray(o.identity.platforms) ||
      o.identity.platforms.includes("windows"),
  },
  flathub: {
    kinds: ["flathub"],
    platform: "linux",
    liveness: "bytes",
    column: "flathub",
  },
};

/** A PR-plane store id, or null. */
export function prInputStore(store: string): PrStoreId | null {
  return (PR_STORE_IDS as readonly string[]).includes(store)
    ? (store as PrStoreId)
    : null;
}

export interface PrInputBuild {
  platform: string | null;
  arch: string;
  name: string;
  url: string;
  sha256: string | null;
  size: number | null;
}

export interface PrInputs {
  store: PrStoreId;
  channel: string;
  product: { slug: string; name: string };
  outlet: { id: string; kind: string; identity: Record<string, unknown> };
  /** The channel's newest release on the outlet, or null when it serves none yet. */
  release: {
    releaseId: string;
    version: string;
    publishedAt: number | null;
    builds: PrInputBuild[];
  } | null;
  /** The release's store notes by locale (stored rows, and the default in the default locale). */
  notes: Record<string, ListingReleaseNotes> | null;
  /** The store column's projection (winget, Flathub), or null for a store without one. */
  listing: {
    exists: boolean;
    status: FitReportRow["status"];
    payload: FitReportRow["payload"];
    issues: FitReportRow["issues"];
  } | null;
  app: {
    defaultLocale: string;
    name: string;
    subtitle: string | null;
    shortDescription: string | null;
    description: string | null;
    developerName: string | null;
    copyright: string | null;
    website: string | null;
    supportUrl: string | null;
    privacyUrl: string | null;
    tint: string | null;
    tintDark: string | null;
    contentDescriptors: Record<string, unknown> | null;
    /** Per locale: the localized name and subtitle (Flathub's `xml:lang` name and summary). */
    locales: Record<string, { name: string | null; subtitle: string | null }>;
    /** Hosted copies on S-20's media host only; empty until HA-02/06/07 land. */
    screenshots: string[];
  };
  links: {
    downloadJson: string;
    scoopFeed: string;
    flathubFeed: string;
  };
  /** Scoop only: the feed's manifest for this release, or null. */
  scoop?: unknown | null;
  /** The outlet's binaries update themselves (`binaryUpdates: self`). */
  selfUpdates: boolean;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/** `https:` URLs only (the manifest's website). */
const httpsOrNull = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
};

/**
 * The inputs for `store` on `channel`, or null (the route's not-found): the deliverable is not
 * public, or there is no such channel or outlet.
 */
export async function prInputs(
  fctx: FeedReadContext,
  store: PrStoreId,
  channel: string,
  outletParam: string | null,
): Promise<PrInputs | null> {
  const readers = await feedReaders(fctx);
  if (!readers) return null;
  const spec = SELECTION[store];
  const sel = await selectFeedWith(fctx, readers, channel, {
    kinds: spec.kinds,
    outletId: outletParam,
    platform: spec.platform,
    liveness: spec.liveness,
    limit: 1,
    allBuilds: true,
    ...(spec.accepts ? { accepts: spec.accepts } : {}),
  });
  if (!sel) return null;
  const slug = fctx.product.slug;
  const first = sel.entries[0] ?? null;
  const release = first
    ? {
        releaseId: first.releaseId,
        version: first.version,
        publishedAt: first.publishedAt,
        builds: sel.entries
          .filter((e) => e.releaseId === first.releaseId)
          .map((e) => ({
            platform: e.platform,
            arch: e.arch,
            name: e.name,
            url: e.url,
            sha256: e.sha256,
            size: e.size,
          }))
          // A stable order for the generators (and their golden files): by architecture, then name.
          .sort((a, b) =>
            a.arch === b.arch
              ? a.name.localeCompare(b.name)
              : a.arch.localeCompare(b.arch),
          ),
      }
    : null;

  const stored = await readListing(fctx.db, slug);
  const model: ListingModel = stored?.model ?? {
    app: { defaultLocale: FALLBACK_LOCALE },
    locales: {},
    overrides: [],
  };
  const defaultLocale = model.app.defaultLocale ?? FALLBACK_LOCALE;
  const notes = release
    ? notesForProjection(
        await releaseNotesView(
          fctx.db,
          readers.catalog,
          slug,
          release.releaseId,
          defaultLocale,
        ),
      )
    : null;
  let listing: PrInputs["listing"] = null;
  if (spec.column) {
    const [row] = fitReport({ model, releaseNotes: notes }, [spec.column]);
    listing = {
      exists: stored !== null,
      status: row!.status,
      payload: row!.payload,
      issues: row!.issues,
    };
  }

  const manifest = sel.outlet.listing ?? {};
  const loc = model.locales[defaultLocale] ?? {};
  const urls = model.app.urls ?? {};
  const app: PrInputs["app"] = {
    defaultLocale,
    name:
      str(loc.name) ??
      str(model.app.name) ??
      str(manifest.name) ??
      fctx.product.name,
    subtitle: str(loc.subtitle) ?? str(manifest.subtitle),
    shortDescription: str(loc.shortDescription),
    description: str(loc.description) ?? str(manifest.description),
    developerName: str(model.app.developerName) ?? str(manifest.developerName),
    copyright: str(model.app.copyright),
    website: str(urls.website) ?? httpsOrNull(manifest.website),
    supportUrl: str(urls.support),
    privacyUrl: str(urls.privacy),
    tint: str(model.app.tint) ?? str(manifest.tintColor),
    tintDark: str(model.app.tintDark),
    contentDescriptors: model.app.contentDescriptors ?? null,
    locales: Object.fromEntries(
      Object.entries(model.locales).map(([l, v]) => [
        l,
        { name: str(v.name), subtitle: str(v.subtitle) },
      ]),
    ),
    // S-20 §4.2 L6: never the manifest listing's raw URLs. HA-07's hosted copies fill this.
    screenshots: [],
  };

  const base = `${fctx.origin}/${encodeURIComponent(slug)}/distribution`;
  const query = outletParam ? `?outlet=${encodeURIComponent(outletParam)}` : "";
  const ch = encodeURIComponent(sel.channel);
  const links = {
    downloadJson: `${base}/download.json`,
    scoopFeed: `${base}/scoop/${ch}.json${query}`,
    flathubFeed: `${base}/flathub/${ch}.json${query}`,
  };

  const caps = await fctx.hooks.outletCapabilities(sel.outlet.id);
  const out: PrInputs = {
    store,
    channel: sel.channel,
    product: { slug, name: fctx.product.name },
    outlet: {
      id: sel.outlet.id,
      kind: sel.outlet.kind,
      identity: sel.outlet.identity,
    },
    release,
    notes,
    listing,
    app,
    links,
    selfUpdates: caps?.binaryUpdates === "self",
  };
  if (store === "scoop") {
    const scoop = sel.outlet.identity.scoop as
      | { bin?: string | string[]; shortcuts?: [string, string][] }
      | undefined;
    out.scoop = renderScoopManifest({
      feedUrl: links.scoopFeed,
      productName: fctx.product.name,
      listing: sel.outlet.listing,
      ...(scoop?.bin !== undefined ? { bin: scoop.bin } : {}),
      ...(scoop?.shortcuts !== undefined ? { shortcuts: scoop.shortcuts } : {}),
      entries: sel.entries,
    });
  }
  return out;
}
