/**
 * The listing model's own limits (S-15 §7.1, the A-18b brief). The Worker's listing model
 * (`core/storefront/listingModel.ts`) enforces them and refuses an over-limit value; the manifest
 * validator reads the same numbers to warn about a `.pkey/distribution` listing text the model
 * would refuse to import (`listing_exceeds_model_limit`, A-27.5). Characters are JavaScript string
 * length.
 */
export const LISTING_LIMITS = {
  name: 30,
  subtitle: 30,
  shortDescription: 78,
  description: 4000,
  promotionalText: 170,
  keywords: { maxItems: 50, maxItemChars: 40 },
  features: { maxItems: 20, maxItemChars: 200 },
  developerName: 100,
  category: 64,
  copyright: 200,
  contactEmail: 254,
  url: 2048,
  iarcCertificateId: 64,
  /** The serialised content descriptors. */
  contentDescriptorsBytes: 8192,
  /** winget's ReleaseNotes, the largest store limit. */
  releaseNotes: 10000,
  /** Play's and F-Droid's. */
  releaseNotesShort: 500,
  /** An override's value: generous, since it exists to exceed the model (each store still checks). */
  override: 10000,
  locales: 50,
  overrides: 400,
} as const;
