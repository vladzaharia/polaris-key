/**
 * Per-release, per-locale STORE NOTES (A-18b; notes/S-15 §5.5). `release_metadata.notes` is one
 * string per release, usually GitHub Markdown, with no locale, and the stores' limits differ by an
 * order of magnitude (Play and F-Droid 500, Microsoft 1,500, Apple 4,000, winget 10,000). So:
 *
 *   - a stored row (`dist_listing_release_notes`) is the notes in that locale, `text` plus an
 *     optional `short` (≤ 500) for Play and F-Droid;
 *   - a release WITHOUT a row in the default locale shows a DEFAULT, never stored: its release
 *     notes with light Markdown stripped (the same rules as `release/changelog.ts`, in their
 *     linear-time form from the download page, `page/model.ts`);
 *   - when the text is longer than 500 and no short form is stored, a sentence-boundary cut is
 *     PROPOSED for edit (`proposeCut`); it is shown, never stored or sent unseen.
 *
 * Read through Core's `releaseCatalog` hook (Distribution never reads Release's tables).
 */

import type { Db } from "../../../core/platform.js";
import type { ReleaseCatalog } from "../../../core/hooks.js";
import {
  LISTING_LIMITS,
  type ListingReleaseNotes,
} from "../../../core/storefront/listingModel.js";
import { proposeCut } from "../../../core/storefront/projection.js";
import { stripMarkdown } from "../page/model.js";
import { listReleaseNotes, notesOf } from "./store.js";

/** Release notes as store text: light Markdown stripped, runs of blank lines collapsed. */
export function storeNotesText(markdown: string): string {
  return stripMarkdown(markdown.replace(/\r\n?/g, "\n")).replace(
    /\n[ \t]*\n(?:[ \t]*\n)+/g,
    "\n\n",
  );
}

export interface NotesLocaleView {
  locale: string;
  text: string;
  short: string | null;
  /** `default`: derived from the release notes, not stored. */
  source: "admin" | "import" | "default";
  /** A cut to 500 at a sentence boundary when `short` is absent and `text` is longer. */
  proposedShort: string | null;
  modifiedAt: number | null;
  modifiedBy: string | null;
}

export interface NotesView {
  releaseId: string;
  version: string;
  locales: NotesLocaleView[];
}

function proposal(n: ListingReleaseNotes): string | null {
  return n.short === null && n.text.length > LISTING_LIMITS.releaseNotesShort
    ? proposeCut(n.text, LISTING_LIMITS.releaseNotesShort)
    : null;
}

/**
 * One release's store notes by locale: the stored rows, plus the default in `defaultLocale` when
 * nothing is stored there and the release has notes. Null when the release does not exist.
 */
export async function releaseNotesView(
  db: Db,
  catalog: ReleaseCatalog,
  product: string,
  releaseId: string,
  defaultLocale: string,
): Promise<NotesView | null> {
  const release = await catalog.releaseNotes(releaseId);
  if (!release) return null;
  const rows = await listReleaseNotes(db, product, releaseId);
  const locales: NotesLocaleView[] = rows.map((r) => ({
    locale: r.locale,
    text: r.text,
    short: r.short,
    source: r.source,
    proposedShort: proposal(notesOf(r)),
    modifiedAt: r.modified_at,
    modifiedBy: r.modified_by,
  }));
  if (!rows.some((r) => r.locale === defaultLocale) && release.notes) {
    const text = storeNotesText(release.notes);
    if (text !== "")
      locales.unshift({
        locale: defaultLocale,
        text,
        short: null,
        source: "default",
        proposedShort: proposal({ text, short: null }),
        modifiedAt: null,
        modifiedBy: null,
      });
  }
  return { releaseId: release.releaseId, version: release.version, locales };
}

/** The notes the projection reads (`ProjectionInput.releaseNotes`), or null for no release. */
export function notesForProjection(
  view: NotesView | null,
): Record<string, ListingReleaseNotes> | null {
  if (!view) return null;
  return Object.fromEntries(
    view.locales.map((l) => [l.locale, { text: l.text, short: l.short }]),
  );
}
