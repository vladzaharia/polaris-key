---
title: "Polaris Locker: the built-in storefront"
description: "Ship builds → Storefronts → Polaris Locker: readiness, how Polaris Locker lists the product, who it is shown to, the ways to add it, group labels, a persona preview and 28 days of analytics."
type: "reference"
lastReviewed: "2026-10-28"
sidebar:
  order: 15
---

**Polaris Locker** is the storefront built into the platform: its
**Discover** and **Library**. A product listed there is shown to the signed-in people who can add
it, and **Add to library** puts it in their library. Its page in the console is
**Ship builds → Storefronts → Locker** (`#/p/<slug>/distribution/storefronts/polaris-key`),
for platform admins.

On the [Storefronts](/docs/features/ship-builds/channels/storefronts/) page its tile reads **Built in: always connected**.
There is nothing to connect: no credential, no app to assign, and nothing in
Store connections. Every operation it performs is marked
**Built in**, and the ones it does not perform say what applies instead (a listed product is
obtained without payment, for example). **Manage** opens this page. Add to storefronts leaves
Locker out, because it is always on.

## Readiness

Five checks, each **Ready**, **Ready, with a note** or **Needs a fix**, with the reason:

| Check           | Ready when                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Locker          | Locker is on for the product (App sign-in → Polaris Locker)                                           |
| Listing         | The listing has a name, an icon and a short description that fit Polaris Locker in its default locale |
| A way to add it | At least one way to add it is offered, or the audience is everyone (a note)                           |
| Get it          | A release download or a live store link; the developer's website alone is a note                      |
| License tiers   | Every tier a way to add it issues exists and has a device limit                                       |

For a product that is not listed, the third check counts the ways it would offer once listed.

## Listing and audience

- **Listing.** **Automatic** (the default) shows the product to the people auto-issue or a mapped
  group would give it to, as Discover always has. **Listed** also shows it through every other way
  to add it. **Not listed** shows it to no one in Locker; sign-in, auto-issue and every license
  keep working. A change asks you to confirm.
- **Audience.** **People who can add it** (the default) or **Everyone signed in**. Everyone signed
  in shows a Listed product to every signed-in person; someone who cannot add it gets a link to
  its store pages or website, never **Add**. It is the one exception to showing a product only to
  the people who can get it, so it asks you to type the product's slug. Going back to People who
  can add it saves at once.

These are the settings `storefront.polarisKey.listed` and `storefront.polarisKey.audience`
([Locker listing](/docs/features/sign-in/customer-portal/#polaris-locker-listing)). The deployment switch
`storefront.polarisKey.enabled` hides every listing when a platform admin turns it off; the page
then says so.

## Ways to add

One switch for each way to add the product that its policy configures. A way that is not
configured is not listed at all:

| Way                       | Configured when                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Members of a mapped group | The product's sign-in maps an IdP group (`groupRoleMap`), on the Polaris Locker sign-in   |
| Free with an account      | The product auto-issues to everyone signed in (`autoIssue`, mode `oidcDefault` or `both`) |
| Free to use               | License is off and every download is public or for signed-in people (nothing to license)  |

The first two need the product's sign-in to use the Locker sign-in with automatic license
linking on. Automatic counts only those two; the rest count once the product is Listed. Turning a
way off asks you to confirm and removes it from Discover and from **Add to library**, so a person
whose only way it was no longer sees the product. Licenses already added keep working.

## Group labels

One row per mapped group. A label (at most 40 characters) is what Discover shows: "Included with
Aperture Seven". Without one, Discover says "For `<group>`". A label whose group is no
longer mapped is listed so you can clear it. Labels save together, with no confirmation.

## Who can see this?

The ways to add that the listing offers now, in plain words: "Members of `beta` at the Locker
sign-in", "Everyone with a Locker account", "Everyone signed in: it is free to use", and
"Everyone else signed in, with a link to get it" for the everyone audience. People who already
have the product see it in their Library instead.

**Preview a person** describes someone and shows the Discover tile they would see: the reason
line, the terms and the action, or why the product is not shown to them. You choose whether they
signed in with the Locker sign-in, which mapped groups they are in, and whether they already
have it. It is a made-up person: the preview takes no email address and no account, never looks
one up, and writes nothing, not even an impression. So it tells you what your settings do, never
anything about a real person.

## Last 28 days

Impressions, adds and first activations, with the activation rate, in total and per way to add
(and "Link to get it" for the everyone audience). They are daily totals and never per person.

- An **impression** is the product shown to one signed-in person on Discover or its product page,
  once per person per day. A deployment without `KEY_HASH_PEPPER` counts no impressions, and the
  card says so.
- An **add** is **Add to library** creating what its way implies (a license, or a library entry).
- A **first activation** is the license's first device, within 7 days of the add, counted on the
  add's day. The newest week's activations are still arriving.

## The readiness and audience API

Narrative-only, under `/manage/api/products/<slug>/storefronts/polaris-key`. None of them writes.

| Method | Path          | Does                                                                                                                                       |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `polaris-key` | the store's status: `listing`, the configured (`available`) and offered (`active`) ways to add, `groups`, `autoIssue`, `readiness`         |
| `POST` | `…/preview`   | `{platformAccount?, groups?, emailDomain?, stores?, holds?}`: a persona, answered with `{visible, hidden, tile}`; any other field is a 422 |
| `GET`  | `…/analytics` | the last 28 days: `totals`, `byKind`, `daily` and `impressionsCounted`                                                                     |

The page writes through `/manage/api/products/<slug>/identity/portal` (PATCH) (`storeListed`,
`storeAudience` with `"confirm": "storefront.polarisKey.audience"` when widening,
`storeOfferPaths`, `storeGroupLabels`). Each change is a `storefront.polarisKey.update` row in
the product's activity.

## Storefront listing

Every store asks for the same name, descriptions, URLs, art and release notes, each at its own
lengths. The **shared listing** is that information entered once (or imported) per product, and
every store's listing is projected from it. It is Distribution data that you edit in the console,
not a manifest: `.pkey/distribution` `listing` stays one import source, and a repo push never
changes the shared listing. Nothing in it is signed or sent to devices.

## In the console

**Settings → Presentation → Listing** is the home. The **Storefront** switcher in its header picks
**Every storefront** (the whole listing) or one storefront. The page is also reached from
**Edit listing** on Storefronts, and the old Ship builds → Listing address shows Page moved. Edits
here show in Polaris Locker, on the download page and on every storefront.

For every storefront there are five tabs:

- **Text**: the app's fields and each locale's (switch locale, or add one), saved together, each
  field with the place it came from (Console, `.pkey/distribution`, a store import, or From
  Presentation; **Revert to manifest** and **Use Presentation** per field), and the import with its
  field-by-field diff;
- **Fit report**: every store's fit, with **Override…** on each field that does not fit;
- **Images**: the [slot board](/docs/features/ship-builds/channels/storefronts/#the-slot-board), where every derived or
  composed image is accepted before any store receives it;
- **Release notes**: each release's store notes per locale, with the proposed short form;
- **Push**: **Push listing** for each store whose adapter writes listings (see
  [Storefronts](/docs/features/ship-builds/channels/storefronts/#listing-push)).

With one storefront chosen, the page shows that storefront's view: its **Overrides** (Edit and
Remove each; shared text is edited under Every storefront), its fit row, its image slots and its
Push. Polaris Locker has nothing to push: it reads the listing directly.

The listing's name, developer name, accent and icon default to
Presentation (Settings → Presentation): a field you leave empty follows it, and a
field you set wins.

The same fit report, import and slot board are steps of
[Add to storefronts](/docs/features/ship-builds/channels/storefronts/).

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
App Store version's release notes default to the release's store notes in that locale, and its
promotional text to the listing's, each only when you do not type one. The preflight shows the
listing's App Store fit. It is advisory: App Store Connect's own listing is what review sees until
you push the listing's text and screenshots to it
([Pushing the listing](/docs/features/ship-builds/channels/app-store-distribute/#pushing-the-listing)).

## Importing

The shared listing fills itself from what already exists. **Import** reads one or more sources and
shows a **field-by-field diff** against the listing; nothing is written until you confirm that
diff. The sources:

| Source      | What is read                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-store` | The App Store listing on sale (else the newest): name, subtitle and privacy policy URL per locale, the primary category, the age-rating answers as content descriptors, copyright, description, keywords, promotional text, support and marketing URLs per locale |
| `play`      | Google Play's listing: the default language, contact website and email, title, short and full description per language                                                                                                                                            |
| `ms-store`  | The Microsoft Store's last published submission: title, description, short description, keywords and features per language, the category, copyright and the developer name                                                                                        |
| `godot`     | What `pkey listing import --godot` read from the project (below)                                                                                                                                                                                                  |
| `manifest`  | `.pkey/distribution` `listing` as a channel shows it: name, developer name, category, website and tint; subtitle and description in the default locale                                                                                                            |
| `product`   | `.pkey/product`'s product name                                                                                                                                                                                                                                    |

Importing from a store only **reads** it: App Store Connect through its write gate (every request
is a read), Google Play inside a read-only edit that is deleted afterwards and never committed,
the Microsoft Store through the read-only status client. A store that is not set up, or whose
credential is pinned to another app, is reported in the diff and nothing is sent to it.

Each change in the diff is one of:

- **add**: the listing has nothing there;
- **replace**: the value came from an earlier import that this source outranks, or from this same
  source and it changed;
- **keep**: the listing's value stays, with the reason: you typed it, or a source that outranks
  this one wrote it.

**Precedence is "the store that is live wins".** An App Store listing has passed a review, so its
text wins over every other source; then Google Play, the Microsoft Store, the Godot project,
`.pkey/distribution` and `.pkey/product`. Within one import the highest-ranked source with a value
wins each field (the others are shown beside it), and a later import never replaces a value a
higher-ranked source wrote. You can reorder the sources per field (`precedence` on the listing); a
source you leave out of a field's order only fills that field when it is empty.

When you confirm, the listing is written as previewed, or not at all: if a source or the listing
changed since the preview, the import is refused with the new diff to review. You can confirm some
of the changes only. The written rows are marked as imported, with the source of each field, and
one audit row names the sources and the fields (never their text). **A value you type in the
console is yours**: an import keeps it unless you ask it to overwrite, and editing an imported
value makes it yours.

What is never imported: a value over the model's limit (it is listed as refused, never shortened);
release notes, which belong to each release; Godot's `application/config/description`, which is
only the Project Manager's tooltip. Screenshots, icons and videos the sources point at are
**listed** with their size and digest where known, never stored: listing assets are uploaded files
made by `pkey listing assets`, which checks each one against the target store before another store
sees it. Version and bundle ids a source declares are shown beside the channels' identities, so a
mismatch is visible.

### From a Godot project

```sh title="Terminal"
# sign in once; the import uses that sign-in (an API token cannot reach it)
pkey login
# prints the diff
pkey listing import --godot path/to/project --product <slug>
# writes it
pkey listing import --godot path/to/project --product <slug> --apply
```

`pkey listing import` reads `project.godot` and `export_presets.cfg` itself, so no Godot editor is
needed, in CI or anywhere:

| Listing fact         | Godot setting                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Name                 | `application/config/name`, and `application/config/name_localized` per locale                                                          |
| Version              | `application/config/version`; Android `version/name`, iOS and macOS `application/short_version`, Windows `application/product_version` |
| Bundle ids           | iOS and macOS `application/bundle_identifier`, Android `package/unique_name` (a `$genname` template is skipped)                        |
| Category hint        | macOS `application/app_category`, Android `package/app_category`                                                                       |
| Copyright            | macOS, then Windows `application/copyright`                                                                                            |
| Developer name       | Windows `application/company_name`                                                                                                     |
| Icon master          | iOS `icons/app_store_1024x1024`, else `application/config/icon`                                                                        |
| Adaptive icon layers | Android `launcher_icons/adaptive_{foreground,background,monochrome}_432x432`                                                           |

The first export preset of each platform is read; `--preset <name>` (repeatable) reads the named
ones instead. Icons are resolved under the project (a path that leaves it is not followed) and
listed with their digest and size. Other flags: `--locale` (a new listing's default locale),
`--overwrite` (replace values typed in the console), `--fields a,b` with `--apply` (write some
changes only), `--json`, `--base-url` (https, or http on localhost or 127.0.0.1: the cookie goes to
whatever origin it names), and `--dry-run`, which prints what would be uploaded and
contacts nothing.

## The AltStore and Obtainium feeds

The AltStore (and AltStore PAL) source and the Obtainium config read the shared listing, field by
field, and fall back to `.pkey/distribution` `listing` for anything it does not hold (the icon,
header and screenshots always come from the manifest). An override for the store `altstore` or
`obtainium` applies to that feed alone. A product with no shared listing renders exactly what it
did before. An edit reaches the feeds at once: the feed cache follows the listing.

## Listing assets

`pkey listing assets` makes every store's listing art from three images a person draws: a square
icon master (1024×1024 is best), key art with no logo on it, and the wordmark on transparency.
Export them in sRGB: an image with another embedded color profile is converted first, and that
conversion is not guaranteed to give identical bytes on every device. It needs the `sharp` image
library beside `pkey` (`npm install sharp`):

```yaml title=".github/workflows/release.yml"
- run: |
    npm install sharp
    node pkey.mjs listing assets --out listing --icon art/icon.png --key-art art/key-art.png \
      --key-art-portrait art/key-art-portrait.png --wordmark art/wordmark.png --focal 0.4,0.35 \
      --screenshots art/screenshots --accept play/phone-portrait/01-menu \
      --upload --product your-product
```

- **Icons** are derived from the master: Google Play 512, the Microsoft tile 300, Steam's 184 JPG
  and 256 icons, and Flathub, Snap, winget and F-Droid. Android's adaptive layers are derived only
  when the mark sits inside the central 66 of 108 dp (about 61 %); otherwise the report marks them
  `human`, for you to draw.
- **Store art** is composed: the key art is cropped to each slot's shape around `--focal` (x,y as
  fractions), and the wordmark is placed only on slots that allow a title. The Steam library hero,
  the page background and the Microsoft super hero never get text. With no key art, every slot
  gets an icon-only fallback marked red. A title slot with no wordmark is marked red too.
- **Screenshots** sit under `--screenshots`, one directory per size class (`phone-portrait`,
  `tablet`, `desktop-16x9`, `desktop-16x10`, `tv`, `wear`, `xr`). Each is checked for the App
  Store, Google Play, the Microsoft Store and Steam. One that does not fit gets a crop or pad
  proposal: an iPhone 6.9″ shot is over Play's 2:1, and a Mac 16:10 shot is not Steam's 16:9. The
  proposal is previewed under `--out/proposals/` and used only for the images you name with
  `--accept <store>/<class>/<name>` (the crop) or `--pad <store>/<class>/<name>`.

Each derived row records the master it came from (`derivedFrom`), so Google Play's adapter can declare template outputs as not AI-generated; masters and fitted screenshots get no declaration. A screenshot fitted for a store is stored as `<store>:screenshot:<class>:<n>`, and each store's ZIP pack as `pack:<store>`.

Everything lands under `--out`: one directory per store, `report.json` (every slot's status, size,
alpha, format and digest), `preview.html` to look at, and a ZIP per store under `packs/` (Steam has
no listing API, so its pack is what you upload by hand). `--upload` stores the images in the
product's shared listing. It needs `distribution:listing`,
which an operator adds deliberately. Only `ok` and `warn` outputs go up: a red output (an icon-only
fallback, a title slot with no wordmark, a file over the store's size limit) stays in `--out` and is
listed as not uploaded, as are `human` and `missing` slots and pending proposals. It never pushes
anything to a store, and it never replaces an image an operator uploaded in the console. Rerunning with the same `--out` replaces only the files
the last run wrote.

## Hosted assets

Some art is not on the web: an icon made for the store, screenshots CI captures. `pkey assets push`
and the Action's `assets` input send such files to Polaris Key, which hosts a copy and serves it
from its image host, exactly like the files a manifest names (`.pkey/product`
`presentation.icon`, the `.pkey/distribution` listing's `icon`, `header` and `screenshots`).

```yaml title=".github/workflows/release.yml"
- uses: vladzaharia/polaris-key/actions/publish@<sha>
  with:
    product: diceroll
    assets: |
      art/icon.png: presentation.icon
      # numbered 1, 2, 3, … in path order
      art/screens/*.png: listing.screenshot
      art/play-feature.png: play:feature-graphic@de-DE
```

Each line is `<glob>: <slot>[@<locale>]`. A slot is `presentation.icon`, `listing.icon`,
`listing.header`, `listing.screenshot:<1-16>` or a store slot of the
[shared listing](/docs/features/ship-builds/channels/polaris-key/) (`icon-master`, `play:feature-graphic`, …).
Every glob must match exactly one file, except for the unnumbered `listing.screenshot`, whose
matches become screenshots 1 to n. Globs resolve against `dir` when it is set, else the workspace.
From a shell, one file at a time:

```sh title="Terminal"
pkey assets push art/icon.png --slot presentation.icon --product diceroll
```

- **Files.** PNG, JPEG, WebP, GIF or AVIF, decided from the file's first bytes (never SVG); up to
  10 MiB for icon slots and 20 MiB for the rest. A refused file fails the step and changes
  nothing.
- **Who wins a slot.** An upload in the console, then the manifest, then CI. A slot an operator
  uploaded, or one the manifest names, is reported as kept and left as it is; that is not a
  failure. See Presentation (console members).
- **Credentials.** The token needs `assets:write`, which an operator adds deliberately (it is not
  a default scope). The files go up through the same upload ticket as a release, so Release must
  be on for the product.

## The storefront listing API

Narrative-only (not in the wire spec), under `/manage/api/products/<slug>/distribution/listing`.
Every write is audited with the fields it changed, never their text.

| Method | Path                         | Does                                                                                                                                                                                                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `listing`                    | the listing, locales, overrides, assets and precedence, with the limits, slots and stores the editor needs                                                                                                                            |
| `PUT`  | `listing`                    | `{ app?, locales?: { "<locale>": { … } \| null }, precedence? }`; `null` clears a field or removes a locale; creating needs `app.defaultLocale`                                                                                       |
| `PUT`  | `listing/overrides`          | `{ store, locale?, field, value }`; `value: null` removes it                                                                                                                                                                          |
| `GET`  | `listing/release-notes/<id>` | the release's store notes per locale, stored or default, with a proposed short form                                                                                                                                                   |
| `PUT`  | `listing/release-notes/<id>` | `{ locale, text, short? }`; `text: null` removes that locale's notes                                                                                                                                                                  |
| `GET`  | `listing/fit[?release=<id>]` | the fit report (`&store=` for one store), with each store's payload when nothing blocks it                                                                                                                                            |
| `POST` | `listing/import`             | `{ sources: [{ source, outlet?, godot? }] }` (or one `source`), `locale?`, `overwrite?`: the diff, nothing written; add `confirm: <digest>` (and `fields?`) to write it. A changed diff answers 409 `import_changed` with the new one |

A refused value answers 422 with `reason: "invalid_listing"`, the `fields` and one message per
problem. The audit actions are `distribution.listing.update`, `distribution.listing.override`,
`distribution.listing.override.remove`, `distribution.listing.notes`,
`distribution.listing.notes.remove` and `distribution.listing.import` (only when something was
written).
