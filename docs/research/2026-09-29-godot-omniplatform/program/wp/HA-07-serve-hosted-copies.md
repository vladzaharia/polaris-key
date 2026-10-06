# HA-07 Serve hosted copies everywhere: portal presentation and Discover on media URLs, `/media/<p>/*` becomes a 302, AltStore/SideStore sources, download-page icon, `dist_listing_assets` `source='manifest'`, listing-asset blob route closed (THREAT-MODEL fix)

| Field       | Value                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 3: serve)                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                      |
| Depends on  | [HA-02](HA-02-img-host.md), [HA-03](HA-03-image-variants.md), [HA-05](HA-05-pull-on-sync.md)                              |
| Unblocks    | [HA-12](HA-12-presentation-discovery.md), [HA-15](HA-15-hosted-assets-closeout.md), [HA-16](HA-16-release-note-images.md) |
| Role        | `pkey-implementer`                                                                                                        |
| Plan mode   | no                                                                                                                        |
| Gates       | console CSP parity; portal e2e; feed goldens; THREAT-MODEL; migration                                                     |
| Human input | none                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                 |

## Goal

No Polaris Key surface fetches or hands out a developer's URL any more. The portal, the Discover tiles, the AltStore and SideStore sources and the download page all use image-host URLs for hosted slots. The old portal proxy route 302s. Manifest art reaches the store pushers as `source = 'manifest'` listing rows. Listing and hosted art is no longer reachable through the app-side `blobs` route.

## Why

It turns the stored copies into the owner's outcome, and makes the THREAT-MODEL statement about listing assets true ([S-20 §4.6](../../notes/S-20-hosted-assets.md#46-defects-found-along-the-way) #2).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §4.1, §4.2, §4.6 and §6.8.
- `portal/library.ts` (`presentationFor`), `portal/media.ts`, `feeds/render.ts`, `page/model.ts`/`render.ts`, `blobAccess.ts`, `securityHeaders.ts`, `admin/src/portal/model/library.ts` (`mediaUrl`).

## Scope

**In:**

- `presentationFor` returns image-host URLs, with a variant chosen per surface. SPA `mediaUrl` accepts the media origin. `APP_CSP` `img-src` adds `IMG_ORIGIN`. Update the portal e2e test.
- `/media/<p>/{icon,header}` 302 to the stable alias. The GitHub-only fetch is removed.
- AltStore and SideStore `iconURL`, `headerURL` and `screenshots` use hosted copies when `ready`, else the manifest URL (today's behaviour). Update the feed goldens.
- Download page shows the icon. `inertDocumentPolicy` `img-src` adds the media origin.
- Migration: `dist_listing_assets.source` gains `manifest`. Hosted manifest art is upserted there, never over `admin` rows.
- `blobAccess` classifies `listing-asset` and `hosted-asset` refs as non-app-side. Correct the THREAT-MODEL line.

**Out** (and where it belongs instead):

- Discovery (→ HA-12). Release-note images (→ HA-16).

## Design notes

- Rollback: when HA-10's `assets.hosting.enabled` is off, every surface uses today's path. Until HA-10 lands, a code constant does the same.

## Corrections from the code (HA-07, 2026-10-06)

Where the brief and the code disagreed, the code won. As built:

- **The proxy stays, as the per-slot fallback and as the rollback.** "The GitHub-only fetch is
  removed" conflicts with two things: "turning hosting off restores today's path" (HA-10's
  acceptance), and the rollout. Production had no `hosted_assets` rows at deploy, because DJDL
  last resynced before HA-05 and HA-05 pulls only on resync; removing the fetch would blank
  DJDL's portal art until its next push. So, per slot:
  - with a copy the image host serves, the presentation names the image host and
    `/media/<p>/<asset>` 302s there, fetching nothing;
  - without a copy, the presentation returns its pre-HA-07 `/media` proxy URL, and the proxy
    serves it unchanged and still guarded;
  - the kill switch (`core/assetHosting.ts` `assetHostingEnabled`, a constant until HA-10), or a
    deployment with no `IMG_ORIGIN`, puts every slot on the proxy. Every surface branches on
    `hostedImageOrigin(env)` in `core/hostedImages.ts`.

  The portal shell keeps the image host in `img-src` while hosting is on, so both paths load. The
  download page is unchanged by this: without a copy it shows no icon, as before HA-07.

- **The client record keeps `/media/<p>/icon`.** WIRE-CONTRACT-V4 §12.7.2 and
  `@polaris-key/protocol/identity` name the same-origin path. Changing it to an image-host URL would
  be a wire change, so the sign-in card's `iconUrl` stays the `/media` path (`v` is now the copy's
  hash prefix) and follows the 302.
- **What counts as a copy.** "When `ready`" means what the image host serves: a stored copy with
  its `hosted-asset` ref, including a failed or stale re-pull's last good copy. The feeds are
  stricter: a copy stands in for a listing field only when it was pulled for exactly that field's
  ref (`pulled_ref`) or an operator claimed the slot. So an outlet override that names other art
  keeps its own URL (`feeds/art.ts`).
- **The download page's icon is not in `download.json`.** The model is recorded in a transcript
  (`distribution-download-model.json`) and replayed by every SDK. The icon is resolved per request
  beside the cached model, so neither the transcript nor any SDK changes.
- **Listing rows.** A manifest row never replaces an `admin` row, and never an `import` row either.
  `import` rows are A-18d's store-exact CI derivation, which S-20 §6.6 keeps as the tool for store
  art. A CI register replaces a manifest row like any non-admin row, so the two never flip a slot.
  The slots are `listing.icon` → `icon-master`, `listing.header` → `key-art`, and
  `listing.screenshot:<n>` → `screenshot:<class>`. The class is inferred from the copy's
  dimensions; the first screenshot of each class is that class's master. `alpha` is 0 only for a
  JPEG. The sync runs after a listing pull (the queue consumer) and on Distribution's 15-minute
  connector cron. HA-05's planner drops slots inside Release's resync, which cannot call
  Distribution (rule 6).
- **The PR plane's screenshots.** `prInputs.ts` said "HA-07's hosted copies fill this". They now
  do: image-host originals only, for A-18i's Flathub MetaInfo.
- **The blob-route fix ignores the kill switch.** It is a fix, not a serving choice.
- **Migration** `0099_dist_listing_assets_manifest.sql` (table rebuild; the lead's number).
  `LATEST_MIGRATION` and `reference/data-model.mdx` name it.

## Steps

1. Portal and CSP.
2. Feeds.
3. Download page.
4. Listing rows.
5. Blob route and THREAT-MODEL.

## Acceptance criteria

- [x] The portal e2e test shows icons from the media host and still blocks a raw GitHub image
      (`packages/admin/e2e/portalMedia.e2e.test.ts`).
- [x] Feed goldens show media URLs for a fixture with hosted assets
      (`test/fixtures/feeds/altstore-stable-hosted.json`; the existing goldens are unchanged).
- [x] `GET /<p>/distribution/blobs/sha256/<listing-asset hash>` is a 404 (test:
      `test/distributionDelivery.test.ts`, on both hosts, for `hosted-asset` too).
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header. Before
      the lead numbered the migration, `recordDeploy` and `checkRepresentable` refused the `00XX`
      placeholder; they pass with `0099`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

HA-12 reuses the variant choice. A-18i reads `source='manifest'` screenshots.

As built, the hand-offs are:

- **HA-12** reads copies through `core/hostedImages.ts`: `hostedImages`, `firstHostedImage`,
  `PRESENTATION_ICON_SLOTS`, `hostedImageUrl` and `pickVariantWidth`.
- **HA-10** replaces the body of `assetHostingEnabled` (`core/assetHosting.ts`) with the
  `assets.hosting.enabled` read. Every HA-07 surface already asks it. The rollback tests mock that
  one export: `portalHostedArt`, `storefrontFeeds` ("hosted copies") and `downloadPageIcon`.
- **A-18i's screenshots** arrive in `prInputs.app.screenshots` (image-host originals). The
  `source='manifest'` rows hold class masters for the pushers.

The role agent sets `--set HA-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-07 done`.
