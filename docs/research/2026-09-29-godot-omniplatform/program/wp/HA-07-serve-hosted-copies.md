# HA-07 Serve hosted copies everywhere: portal presentation and Discover on media URLs, `/media/<p>/*` becomes a 302, AltStore/SideStore sources, download-page icon, `dist_listing_assets` `source='manifest'`, listing-asset blob route closed (THREAT-MODEL fix)

| Field       | Value                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 3: serve)                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                      |
| Depends on  | [HA-02](HA-02-media-host.md), [HA-03](HA-03-image-variants.md), [HA-05](HA-05-pull-on-sync.md)                            |
| Unblocks    | [HA-12](HA-12-presentation-discovery.md), [HA-15](HA-15-hosted-assets-closeout.md), [HA-16](HA-16-release-note-images.md) |
| Role        | `pkey-implementer`                                                                                                        |
| Plan mode   | no                                                                                                                        |
| Gates       | console CSP parity; portal e2e; feed goldens; THREAT-MODEL; migration                                                     |
| Human input | none                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                 |

## Goal

No Polaris Key surface fetches or hands out a developer's URL any more. The portal, the Discover tiles, the AltStore and SideStore sources and the download page all use media-host URLs for hosted slots. The old portal proxy route 302s. Manifest art reaches the store pushers as `source = 'manifest'` listing rows. Listing and hosted art is no longer reachable through the app-side `blobs` route.

## Why

It turns the stored copies into the owner's outcome, and makes the THREAT-MODEL statement about listing assets true ([S-20 §4.6](../../notes/S-20-hosted-assets.md#46-defects-found-along-the-way) #2).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §4.1, §4.2, §4.6 and §6.8.
- `portal/library.ts` (`presentationFor`), `portal/media.ts`, `feeds/render.ts`, `page/model.ts`/`render.ts`, `blobAccess.ts`, `securityHeaders.ts`, `admin/src/portal/model/library.ts` (`mediaUrl`).

## Scope

**In:**

- `presentationFor` returns media-host URLs, with a variant chosen per surface. SPA `mediaUrl` accepts the media origin. `APP_CSP` `img-src` adds `MEDIA_ORIGIN`. Update the portal e2e test.
- `/media/<p>/{icon,header}` 302 to the stable alias. The GitHub-only fetch is removed.
- AltStore and SideStore `iconURL`, `headerURL` and `screenshots` use hosted copies when `ready`, else the manifest URL (today's behaviour). Update the feed goldens.
- Download page shows the icon. `inertDocumentPolicy` `img-src` adds the media origin.
- Migration: `dist_listing_assets.source` gains `manifest`. Hosted manifest art is upserted there, never over `admin` rows.
- `blobAccess` classifies `listing-asset` and `hosted-asset` refs as non-app-side. Correct the THREAT-MODEL line.

**Out** (and where it belongs instead):

- Discovery (→ HA-12). Release-note images (→ HA-16).

## Design notes

- Rollback: when HA-10's `assets.hosting.enabled` is off, every surface uses today's path. Until HA-10 lands, a code constant does the same.

## Steps

1. Portal and CSP.
2. Feeds.
3. Download page.
4. Listing rows.
5. Blob route and THREAT-MODEL.

## Acceptance criteria

- [ ] The portal e2e test shows icons from the media host and still blocks a raw GitHub image.
- [ ] Feed goldens show media URLs for a fixture with hosted assets.
- [ ] `GET /<p>/distribution/blobs/sha256/<listing-asset hash>` is a 404 (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

HA-12 reuses the variant choice. A-18i reads `source='manifest'` screenshots.

The role agent sets `--set HA-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-07 done`.
