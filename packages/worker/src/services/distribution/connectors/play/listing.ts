/**
 * The Google Play adapter's `readListing` (A-18c; notes/S-15 §7.2, §5.3): the store listing as
 * Play holds it, read inside ONE read-only edit that is deleted before the request ends:
 *
 *     edits.insert → edits.details.get → edits.listings.list
 *                  → edits.images.list (the default language, each image type) → edits.delete
 *
 * Nothing in the edit is changed and it is never committed: Play's only read path for a listing is
 * an edit, and deleting it is how P5-03's poller ends every read too. Every other call is a GET.
 *
 * Images are REPORTED (their URL and digest), never stored: listing assets are uploaded blobs, made
 * by A-18d's derivation (S-15 §7.4). Category and tags have no field in the API (S-15 §4.1) and the
 * content rating is Play's IARC questionnaire, so neither is read.
 */

import {
  emptySnapshot,
  normaliseLocale,
  splitNames,
  textOf,
  type ListingSnapshot,
  type SnapshotAsset,
} from "../../../../core/storefront/listingImport.js";
import type { PlayPublisher } from "./client.js";

/** `edits.images.list` image types → the model's slots (`tvBanner` has none). */
export const PLAY_IMAGE_SLOTS: Readonly<Record<string, string | null>> = {
  icon: "play:icon",
  featureGraphic: "play:feature-graphic",
  phoneScreenshots: "screenshot:phone-portrait",
  sevenInchScreenshots: "screenshot:tablet",
  tenInchScreenshots: "screenshot:tablet",
  tvScreenshots: "screenshot:tv",
  wearScreenshots: "screenshot:wear",
  tvBanner: null,
};

/** A Play language code as a path segment (the edit's own, re-checked). */
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/**
 * Read the app's listing in a fresh edit (deleted whatever happens). Throws `PlayError` on a
 * failed read, after the edit is deleted.
 */
export async function readPlayListing(
  publisher: PlayPublisher,
  packageName: string,
): Promise<ListingSnapshot> {
  const snap = emptySnapshot("play", packageName);
  const editId = await publisher.insertEdit();
  try {
    const api = publisher.api;
    const details = obj(
      await api.request(
        "GET",
        ["edits", editId, "details"],
        "edits.details.get",
      ),
    );
    const defaultLanguage =
      typeof details?.defaultLanguage === "string"
        ? details.defaultLanguage
        : null;
    snap.defaultLocale = defaultLanguage
      ? normaliseLocale(defaultLanguage)
      : null;
    const website = textOf(details?.contactWebsite);
    if (website) snap.app.urls = { website };
    const email = textOf(details?.contactEmail);
    if (email) snap.app.contactEmail = email;
    if (textOf(details?.contactPhone))
      snap.skipped.push({
        field: "contactPhone",
        reason: "the listing model has no phone number",
      });

    const listed = obj(
      await api.request(
        "GET",
        ["edits", editId, "listings"],
        "edits.listings.list",
      ),
    );
    const names: Record<string, string> = {};
    for (const raw of Array.isArray(listed?.listings) ? listed.listings : []) {
      const l = obj(raw);
      const locale =
        typeof l?.language === "string" ? normaliseLocale(l.language) : null;
      if (!l || !locale) continue;
      const title = textOf(l.title);
      if (title) names[locale] = title;
      const t = (snap.locales[locale] ??= {});
      const short = textOf(l.shortDescription);
      if (short) t.shortDescription = short;
      const full = textOf(l.fullDescription);
      if (full) t.description = full;
      const video = textOf(l.video);
      if (video?.startsWith("https://"))
        snap.assets.push({
          slot: "youtube-url",
          locale,
          ref: video,
          width: null,
          height: null,
          sha256: null,
          vendorSlot: "video",
        });
      if (Object.keys(t).length === 0) delete snap.locales[locale];
    }
    splitNames(snap, snap.defaultLocale, names);

    // Images: the default language only (one list call per image type).
    if (defaultLanguage && LANGUAGE.test(defaultLanguage))
      for (const [type, slot] of Object.entries(PLAY_IMAGE_SLOTS)) {
        const doc = obj(
          await api.request(
            "GET",
            ["edits", editId, "listings", defaultLanguage, type],
            "edits.images.list",
          ),
        );
        const images = Array.isArray(doc?.images) ? doc.images : [];
        if (images.length && slot === null) {
          snap.skipped.push({
            field: type,
            reason: "the listing model has no slot for it",
          });
          continue;
        }
        for (const raw of images) {
          const img = obj(raw);
          const url = textOf(img?.url);
          if (!slot || !url?.startsWith("https://")) continue;
          const asset: SnapshotAsset = {
            slot,
            locale: snap.defaultLocale,
            ref: url,
            width: null,
            height: null,
            sha256:
              typeof img?.sha256 === "string" && HEX64.test(img.sha256)
                ? img.sha256
                : null,
            vendorSlot: type,
          };
          snap.assets.push(asset);
        }
      }
    if (Object.keys(snap.locales).length > 1)
      snap.skipped.push({
        field: "screenshots",
        reason:
          "images are read for the default language only; the other languages' images stay in Play Console",
      });
    return snap;
  } finally {
    // Never leave the edit open: one open edit per user, and the poller needs its own.
    await publisher.deleteEdit(editId);
  }
}
