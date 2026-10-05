---
title: "Storefront listing"
description: "The shared listing model: one listing per product, projected to every store's limits, with per-store overrides, per-release store notes, the fit report and the .pkey/distribution import."
sidebar:
  order: 15
---

Every store asks for the same name, descriptions, URLs, art and release notes, each at its own
lengths. The **shared listing** is that information entered once (or imported) per product, and
every store's listing is projected from it. It is Distribution data that you edit in the console,
not a manifest: `.pkey/distribution` `listing` stays one import source, and a repo push never
changes the shared listing. Nothing in it is signed or sent to devices.

## What it holds

| Part          | Fields and the model's limits                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app       | default locale, name (30), developer name, category id, content descriptors, IARC certificate id, URLs (website, support, privacy, marketing, EULA; https only), contact email, copyright, tint and dark tint (`#rrggbb`)                                                    |
| Each locale   | name (30, overrides the app's), subtitle (30), short description (78), description (4,000), keywords (50 of 40), features (20 of 200), promotional text (170)                                                                                                                |
| Assets        | one image per slot and locale, with its digest, size and text rule: `none` (key art only, such as Steam's library hero), `title` (the game name only, such as the capsules) or `free`. They are made by `pkey listing assets` and uploaded; the console does not make images |
| Release notes | per release and locale: the text (10,000) and a short form (500, for Google Play and F-Droid)                                                                                                                                                                                |
| Overrides     | a replacement for one field on one store, in one locale or every locale                                                                                                                                                                                                      |

The model's limits are the tightest any store puts on a field it shares with others: a name of 30
fits the App Store and Google Play, a short description of 78 fits the Snap Store and Google Play's 80. A store that allows more gets it through an **override** (a Steam short description longer than
78, a Microsoft description over 4,000), which bypasses the model's limit but never the store's.

**Nothing is ever cut to fit.** A value over a limit is refused with the field named, and a value
that suits the model but not a store is an issue in the fit report. The same holds for imports: an
imported value over a limit is reported, not shortened. Listing text is data: it is stored as typed
and shown escaped, never as HTML.

## The fit report

The fit report has one row per store (App Store, Google Play, Microsoft Store, Steam, Flathub, Snap
Store, winget, F-Droid) and one cell per field and locale:

- **green**: it fits;
- **amber**: a recommendation is exceeded (Flathub's name over 15 characters, Microsoft's short
  description over the 270 it shows) or keyword packing left terms out;
- **red**: a value is over the store's limit or a required field is missing. A red row blocks
  that store: its adapter gets no payload until it is fixed.

Keywords are packed per store: the App Store joins them with commas within 100 bytes, Microsoft
takes at most 7 terms of at most 30 characters within 21 words, winget at most 16 tags of 40. Each
term left out is shown. Steam's fields are copy cards (you paste them in Steamworks) and
Microsoft's name is the one you reserved in Partner Center, so neither is checked or sent.

## Release notes

A release's store notes default to its release notes with Markdown stripped, in the default locale.
That default is shown, not stored. When the text is longer than 500 characters and no short form is
stored, Google Play and F-Droid are red and a cut at a sentence end is **proposed** for you to accept
or edit. The proposal is never stored or sent until you save it. The App Store gets the full text
(up to 4,000), Microsoft up to 1,500, winget up to 10,000.

The App Store Connect Distribute flow reads these notes: given the release being distributed, an
App Store version's What's New defaults to the release's store notes in that locale, and its
promotional text to the listing's, each only when you do not type one. The preflight shows the
listing's App Store fit. It is advisory until the listing itself is pushed to App Store Connect.

## Importing from `.pkey/distribution`

**Import** copies the listing an outlet shows (the document's `listing` with that outlet's override
merged over it) into the shared listing: name, developer name, category, website and tint at the
app level, subtitle and description in the default locale. It is an explicit action, and:

- it fills gaps: a value you typed is kept unless you ask to overwrite it;
- a value over the model's limit is refused and listed, never shortened;
- asset URLs (`iconUrl`, `headerUrl`, `screenshots`) are not imported, because listing assets
  are uploaded files with a digest.

Each import source wins in a default order per field: the store that is live first (App Store,
then Google Play, then Microsoft Store), then the Godot project, `.pkey/distribution` and
`.pkey/product`. You can reorder it per field. The store and Godot imports arrive later; the
manifest import is here now.

## The AltStore and Obtainium feeds

The AltStore (and AltStore PAL) source and the Obtainium config read the shared listing, field by
field, and fall back to `.pkey/distribution` `listing` for anything it does not hold (the icon,
header and screenshots always come from the manifest). An override for the store `altstore` or
`obtainium` applies to that feed alone. A product with no shared listing renders exactly what it
did before. An edit reaches the feeds at once: the feed cache follows the listing.

## Listing assets

The images come from CI, never from the console's own image tools:
[`pkey listing assets`](/docs/build/ci/#listing-assets) derives every store icon from the icon
master and composes every store's art from the key art and the wordmark. It fits each screenshot
for each store, using a crop or pad only where you accept it. It then uploads every output that passed (a red one stays in CI) with its digests, sizes and
alpha. Each derived row records the master it came from (`derivedFrom`), so Google Play's adapter
can declare template outputs as not AI-generated; masters and fitted screenshots get no
declaration. A screenshot fitted for a
store is stored as `<store>:screenshot:<class>:<n>`, and each store's ZIP pack as `pack:<store>`.
An image you upload yourself is never replaced by CI.

## The console API

Narrative-only (not in the wire spec), under `/manage/api/products/<slug>/distribution/listing`.
Every write is audited with the fields it changed, never their text.

| Method | Path                         | Does                                                                                                                                            |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `listing`                    | the listing, locales, overrides, assets and precedence, with the limits, slots and stores the editor needs                                      |
| `PUT`  | `listing`                    | `{ app?, locales?: { "<locale>": { … } \| null }, precedence? }`; `null` clears a field or removes a locale; creating needs `app.defaultLocale` |
| `PUT`  | `listing/overrides`          | `{ store, locale?, field, value }`; `value: null` removes it                                                                                    |
| `GET`  | `listing/release-notes/<id>` | the release's store notes per locale, stored or default, with a proposed short form                                                             |
| `PUT`  | `listing/release-notes/<id>` | `{ locale, text, short? }`; `text: null` removes that locale's notes                                                                            |
| `GET`  | `listing/fit[?release=<id>]` | the fit report (`&store=` for one store), with each store's payload when nothing blocks it                                                      |
| `POST` | `listing/import`             | `{ source: "manifest", outlet?, locale?, overwrite? }`                                                                                          |

A refused value answers 422 with `reason: "invalid_listing"`, the `fields` and one message per
problem. The audit actions are `distribution.listing.update`, `distribution.listing.override`,
`distribution.listing.override.remove`, `distribution.listing.notes`,
`distribution.listing.notes.remove` and `distribution.listing.import` (only when something was
imported).
