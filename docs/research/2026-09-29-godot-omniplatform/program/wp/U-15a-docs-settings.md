# U-15a Cloud Sync docs, settings half: concepts, the five-minute quickstart, client-writable banner, "no Cloud Sync without sign-in", the operators' migration notice, clock limits

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | U: Cloud Sync (S-17) (U1 MVP)                                                            |
| Size        | 0.4–0.55 engineer-weeks                                                                  |
| Depends on  | [U-06](U-06-sdk-settings-node-python.md), [U-21](U-21-sdk-settings-godot.md)             |
| Unblocks    | [U-15b](U-15b-docs-saves.md), [U-15c](U-15c-docs-records.md)                             |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/U-01.md`](../plans/U-01.md) where it names this package |
| Gates       | `check:links`; generated docs pages (`gen-docs` drift)                                   |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Goal

Developers can adopt synced settings from the docs: concepts, the five-minute quickstart, the client-writable banner, a plain "no Cloud Sync without sign-in" statement, the migration notice for operators, and clock limits.

## Why

The owner's decisions change what developers get (no zero-sign-in sync; licence overrides removed); the docs must say so ([S-17 §5.16](../../notes/S-17-user-data-sync.md#516-quickstart-synced-settings-in-five-minutes), [S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision)).

## Read first

- `AGENTS.md` (always).
- [S-17 §5.16](../../notes/S-17-user-data-sync.md#516-quickstart-synced-settings-in-five-minutes), [S-17 §5.12](../../notes/S-17-user-data-sync.md#512-the-account-override-layer-and-the-licence-override-migration-owner-decision), [S-17 §6](../../notes/S-17-user-data-sync.md#6-phases-and-work-packages) row U-15.
- `packages/docs/src/content/docs/services/`.

## Scope

**In:** the settings half of the Cloud Sync docs and the operators' migration notice page.

**Out** (and where it belongs instead):

- Saves (→ U-15b); collections (→ U-15c).

## Design notes

- The quickstart lists `identity` among the required services ((owner, 2026-10-04, final answers): Cloud Sync needs sign-in and requires Identity); devices sync only after signing in through the product.
- Never hand-edit generated pages.

## Steps

1. Concepts and quickstart. 2. Migration notice and limits.

## Acceptance criteria

- [ ] Pages exist and links resolve.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- U-15b and U-15c add their halves.

The role agent sets `--set U-15a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set U-15a done`.
