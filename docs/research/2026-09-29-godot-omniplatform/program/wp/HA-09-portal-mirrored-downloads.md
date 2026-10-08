# HA-09 Portal licensed downloads prefer the mirrored R2 copy with PX-W3's download ticket over GitHub's `browser_download_url` (fixes private-repo 404s)

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 3: serve) |
| Size        | 0.2–0.4 engineer-weeks                                                            |
| Depends on  | [HA-08](HA-08-release-mirroring.md), [PX-W3](PX-W3-licensed-r2-downloads.md)      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-09](PX-09-get-it-complete.md)         |
| Role        | `pkey-implementer`                                                                |
| Plan mode   | no                                                                                |
| Gates       | portal e2e; THREAT-MODEL                                                          |
| Human input | none                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Small; ship before PX-09 (fixes private-repo 404s). P0-23 later moves its mint behind the delivery.downloadToken hook.

## Goal

`downloadTarget` picks the R2 copy with a ticket first, then today's order. A licensed file in a private GitHub repo downloads from the portal instead of 404ing.

## Why

GitHub's `browser_download_url` for a private repo 404s for an anonymous browser ([S-20 §4.3](../../notes/S-20-hosted-assets.md#43-release-deliverables-and-update-feeds) R3). Once files are mirrored, PX-W3's ticket covers them.

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- PX-W3 plan (`plans/PX-W3.md`).
- `portal/api.ts` (`downloadTarget`, `redirectableSourceUrl`).

## Scope

**In:**

- Reorder `downloadTarget`. Tests for public, licensed with a mirror, and licensed without a mirror.

**Out** (and where it belongs instead):

- The ticket itself (PX-W3).

## Design notes

- No new reason code. `not_hosted` stays for files with no serving location.

## Steps

1. Reorder and test.

## Acceptance criteria

- [ ] A licensed private-repo fixture returns a dl URL with `?ticket=` (test).
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

None.

The role agent sets `--set HA-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-09 done`.
