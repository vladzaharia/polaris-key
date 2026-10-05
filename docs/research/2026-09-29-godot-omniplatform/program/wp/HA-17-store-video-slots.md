# HA-17 Optional: store video and trailer slots: `trailer-master` hosted as MP4 (512 MiB cap, no transcoding), `youtube-url` as a URL slot (fixes the NOT NULL blob mismatch)

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 6: optional) (optional) |
| Size        | 0.5–0.8 engineer-weeks                                                                          |
| Depends on  | [HA-06](HA-06-upload-paths.md)                                                                  |
| Unblocks    | none                                                                                            |
| Role        | `pkey-implementer`                                                                              |
| Plan mode   | no                                                                                              |
| Gates       | migration; THREAT-MODEL                                                                         |
| Human input | none                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                       |

## Goal

A trailer can be uploaded or pulled and stored as a hosted MP4. A YouTube URL is stored as a URL-only slot. Both are served from the media host, or as a link, for the store pushers.

## Why

The slots exist, but the schema cannot hold them and nothing writes them ([S-20 §4.2](../../notes/S-20-hosted-assets.md#42-storefront-listing-assets-s-15--a-18) L4).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- S-20 §4.2; `core/storefront/listingModel.ts`; `M/0065`.

## Scope

**In:**

- Migration allowing a URL-only listing asset.
- MP4 sniff and cap.
- Media-host `video/mp4` with Range.

**Out** (and where it belongs instead):

- Transcoding (Media Transformations is in beta).

## Design notes

- Video is served with Range support; the media host's headers otherwise apply.

## Steps

1. Migration.
2. Ingest.
3. Serving.

## Acceptance criteria

- [ ] An MP4 upload is served with Range from the media host (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

A-18e/f/m pushers may read these slots.

The role agent sets `--set HA-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-17 done`.
