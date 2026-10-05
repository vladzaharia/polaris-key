/**
 * EVERY STORE'S LISTING COLUMN (A-18b; notes/S-15 §7.3): which model field each store field is
 * projected from, at which limit, and how. One entry per store of S-15 §7.3's table: Apple, Play,
 * Microsoft, Steam, Flathub, Snap, winget and F-Droid. A store's adapter (A-18e–i, A-18m) declares
 * its `ListingProfile` from its column here (`adapterListingProfile`), so the conformance suite's
 * item 7 and the fit report read the same numbers.
 *
 * Pure data (`test/boundaries.test.ts`): the CLI's generated copy (A-18h) is a straight serialise.
 *
 * The planes, per field:
 *   - `api`: the adapter sends it (a Worker-plane write, a CI command, a generated PR file);
 *   - `copy`: the store takes it only in its own console, so the console shows a copy card (Steam);
 *   - `manual`: the store owns it (Microsoft's reserved name): shown, never checked or sent.
 *
 * Limits are characters (JavaScript string length) unless `unit: "bytes"` (Apple's keywords are
 * 100 bytes of UTF-8). `warnChars` is a recommendation: over it is amber, not red (Flathub's name
 * "ideally ≤ 15"; Microsoft's short description shows 270 of its 1,000). Microsoft's keywords take
 * the stricter of the two documented limits, 7 × 30 (the A-18b brief).
 */

import type {
  ListingField,
  ListingImageSlot,
  ListingProfile,
} from "./listing.js";
import type { ModelField } from "./listingModel.js";

/** The stores with a listing column. Ids follow the storefront and outlet-kind vocabulary. */
export const LISTING_STORES = [
  "app-store",
  "play",
  "ms-store",
  "steam",
  "flathub",
  "snap",
  "winget",
  "fdroid",
] as const;
export type ListingStore = (typeof LISTING_STORES)[number];

/** Where a store field goes (see the file comment). */
export type ListingPlane = "api" | "copy" | "manual";

interface FieldBase {
  /** The model field it is projected from. */
  readonly from: ModelField;
  /** One value per locale, or one for the app. */
  readonly perLocale: boolean;
  /** The store refuses a listing without it: missing is red. */
  readonly required?: boolean;
  readonly plane: ListingPlane;
}

/** A text field. No `maxChars`: the store documents no limit (the model's own still applies). */
export interface TextStoreField extends FieldBase {
  readonly kind: "text";
  readonly maxChars?: number;
  readonly unit?: "chars" | "bytes";
  readonly warnChars?: number;
}

/**
 * A list field. `pack` picks the terms that fit (keywords: Apple comma-joins under `joinBytes`,
 * Microsoft takes at most 7 within 21 words, winget at most 16 tags) and reports each one left
 * out as amber; without `pack`, a list over the limit is red.
 */
export interface ListStoreField extends FieldBase {
  readonly kind: "list";
  readonly maxItems?: number;
  readonly maxItemChars?: number;
  readonly maxWords?: number;
  /** Joined with commas into one value of at most this many UTF-8 bytes (Apple). */
  readonly joinBytes?: number;
  readonly pack?: boolean;
}

export type StoreField = TextStoreField | ListStoreField;

export interface StoreListingColumn {
  readonly store: ListingStore;
  readonly label: string;
  /** Store field name → how it is projected. Names are the store's own where it has one. */
  readonly fields: Readonly<Record<string, StoreField>>;
  /** Image slots (A-18d fills them per store; the substrate's shape). */
  readonly images: Readonly<Record<string, ListingImageSlot>>;
}

const text = (
  from: ModelField,
  maxChars: number | undefined,
  more: Partial<Omit<TextStoreField, "kind" | "from" | "maxChars">> = {},
): TextStoreField => ({
  kind: "text",
  from,
  ...(maxChars !== undefined ? { maxChars } : {}),
  perLocale: true,
  plane: "api",
  ...more,
});
const app = { perLocale: false } as const;
const URL_MAX = 2048;

export const STORE_LISTING_COLUMNS: Readonly<
  Record<ListingStore, StoreListingColumn>
> = {
  "app-store": {
    store: "app-store",
    label: "App Store",
    fields: {
      name: text("name", 30, { required: true }),
      subtitle: text("subtitle", 30),
      description: text("description", 4000, { required: true }),
      keywords: {
        kind: "list",
        from: "keywords",
        perLocale: true,
        plane: "api",
        joinBytes: 100,
        pack: true,
      },
      promotionalText: text("promotionalText", 170),
      whatsNew: text("releaseNotes", 4000),
      supportUrl: text("supportUrl", URL_MAX, { required: true }),
      marketingUrl: text("marketingUrl", URL_MAX),
      privacyPolicyUrl: text("privacyUrl", URL_MAX),
    },
    images: {},
  },
  play: {
    store: "play",
    label: "Google Play",
    fields: {
      title: text("name", 30, { required: true }),
      shortDescription: text("shortDescription", 80, { required: true }),
      fullDescription: text("description", 4000, { required: true }),
      releaseNotes: text("releaseNotesShort", 500),
      contactWebsite: text("website", URL_MAX, app),
      contactEmail: text("contactEmail", 254, { ...app, required: true }),
    },
    images: {},
  },
  "ms-store": {
    store: "ms-store",
    label: "Microsoft Store",
    fields: {
      name: text("name", undefined, { plane: "manual" }),
      shortDescription: text("shortDescription", 1000, { warnChars: 270 }),
      description: text("description", 10000, { required: true }),
      keywords: {
        kind: "list",
        from: "keywords",
        perLocale: true,
        plane: "api",
        maxItems: 7,
        maxItemChars: 30,
        maxWords: 21,
        pack: true,
      },
      features: {
        kind: "list",
        from: "features",
        perLocale: true,
        plane: "api",
        maxItems: 20,
        maxItemChars: 200,
      },
      releaseNotes: text("releaseNotes", 1500),
      supportUrl: text("supportUrl", URL_MAX, app),
      privacyPolicyUrl: text("privacyUrl", URL_MAX, app),
    },
    images: {},
  },
  steam: {
    store: "steam",
    label: "Steam",
    fields: {
      name: text("name", undefined, { plane: "copy", required: true }),
      shortDescription: text("shortDescription", undefined, {
        plane: "copy",
        warnChars: 300,
      }),
      description: text("description", undefined, { plane: "copy" }),
      tags: {
        kind: "list",
        from: "keywords",
        perLocale: true,
        plane: "copy",
      },
    },
    images: {},
  },
  flathub: {
    store: "flathub",
    label: "Flathub",
    fields: {
      name: text("name", 19, { warnChars: 15, required: true }),
      summary: text("subtitle", 35, { required: true }),
      description: text("description", undefined, { required: true }),
      keywords: {
        kind: "list",
        from: "keywords",
        perLocale: true,
        plane: "api",
      },
      releases: text("releaseNotes", undefined),
      homepage: text("website", URL_MAX, app),
      developerName: text("developerName", undefined, app),
    },
    images: {},
  },
  snap: {
    store: "snap",
    label: "Snap Store",
    fields: {
      title: text("name", 40, { required: true }),
      summary: text("shortDescription", 78, { required: true }),
      description: text("description", undefined, { required: true }),
    },
    images: {},
  },
  winget: {
    store: "winget",
    label: "winget",
    fields: {
      PackageName: text("name", 256, { required: true }),
      Publisher: text("developerName", 256, { ...app, required: true }),
      ShortDescription: text("shortDescription", 256, { required: true }),
      Description: text("description", 10000),
      Tags: {
        kind: "list",
        from: "keywords",
        perLocale: true,
        plane: "api",
        maxItems: 16,
        maxItemChars: 40,
        pack: true,
      },
      ReleaseNotes: text("releaseNotes", 10000),
      PublisherSupportUrl: text("supportUrl", URL_MAX, app),
      PrivacyUrl: text("privacyUrl", URL_MAX, app),
      Copyright: text("copyright", 512, app),
    },
    images: {},
  },
  fdroid: {
    store: "fdroid",
    label: "F-Droid",
    fields: {
      name: text("name", 50, { required: true }),
      summary: text("shortDescription", 80, { required: true }),
      description: text("description", 4000, { required: true }),
      whatsNew: text("releaseNotesShort", 500),
    },
    images: {},
  },
};

/**
 * The substrate's `ListingProfile` (A-18a's slot) for a store column: every text field with a
 * character limit, and every list joined under a byte cap as one field of that many characters.
 * A byte limit is declared at its byte count, which the profile's character check can only be
 * looser than; the projection (`projection.ts`) checks the bytes. The field names are the
 * column's, so Apple's stay A-17's (`whatsNew`, `promotionalText`).
 */
export function adapterListingProfile(
  column: StoreListingColumn,
): ListingProfile {
  const fields: Record<string, ListingField> = {};
  for (const [name, f] of Object.entries(column.fields)) {
    if (f.plane !== "api") continue;
    const maxChars =
      f.kind === "text"
        ? f.maxChars
        : f.joinBytes !== undefined
          ? f.joinBytes
          : undefined;
    if (maxChars === undefined) continue;
    fields[name] = {
      maxChars,
      perLocale: f.perLocale,
      ...(f.required ? { required: true } : {}),
    };
  }
  return { fields, images: column.images };
}
