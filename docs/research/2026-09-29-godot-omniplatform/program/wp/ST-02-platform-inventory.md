# ST-02 Platform inventory generator and `--check` (`Env` ↔ inventory ↔ wrangler comment), adding the 16 missing names

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings architecture (S-18) (phase 0: stop the bleeding)                                |
| Size        | 0.4–0.55 engineer-weeks                                                                      |
| Depends on  | none                                                                                         |
| Unblocks    | [ST-06](ST-06-settings-docs-coverage.md), [ST-09](ST-09-platform-settings-area.md)           |
| Role        | `pkey-implementer`                                                                           |
| Plan mode   | no                                                                                           |
| Gates       | drift gate (`--check`); generated docs pages (`docs gen:check`; regenerate, never hand-edit) |
| Human input | none                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                    |

## Goal

A generated platform inventory lists every `Env` binding and variable, and `gen:platform-inventory --check` fails when `Env`, the inventory and the wrangler comment block disagree; the 16 names missing today are added.

## Why

Platform settings that exist only as deploy variables are invisible to operators and to the docs ([S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home)); the inventory is the source the Platform area's Limits page and the coverage test read ([S-18 §4.13](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.2](../../notes/S-18-settings-architecture.md#22-settings-with-no-proper-home), [S-18 §4.13](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-02.
- `packages/worker/src/env.ts`, `packages/worker/wrangler.toml` (and `wrangler.deltas.toml`).

## Scope

**In:**

- The generator script and its `--check` mode, wired into the green gate.
- The 16 missing names documented.
- The rule 3 generated-file banner.

**Out** (and where it belongs instead):

- The settings registry (→ ST-03) and generated settings page (→ ST-06).

## Design notes

- Generated files are never hand-edited (rule 3).
- **Corrections from the code (2026-10-04, the implementer):** the Worker's config is
  `packages/worker/wrangler.toml`, not `wrangler.jsonc`. "The inventory" the 16 names were missing
  from is the hand-kept pair of lists in `GET /manage/api/platform/settings`
  (`admin/handlers/platformSettings.ts`, S-18 §2.4); that handler now reads the generated
  inventory, so the names reach the API (and the console's Secrets, Delivery and Email sections)
  without a second list. Four names `src/` read only through `Env`'s index signature
  (`BLOBS_BUCKET_NAME`, `R2_ACCOUNT_ID`, `R2_PARENT_ACCESS_KEY_ID`,
  `R2_PARENT_SECRET_ACCESS_KEY`) are now declared members, and `--check` also refuses a new such
  read. The tag is `@inventory <kind> <area>` (S-18 §4.13 names only the kind; the area is what
  the console groups by). Output: `packages/worker/src/platformInventory.generated.ts`.

## Steps

1. Write the generator.
2. Add the missing names.
3. Wire `--check` into CI.

## Acceptance criteria

- [ ] `--check` fails when a name is added to `Env` without the inventory (test or scripted check).
- [ ] All 16 missing names are present.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:platform-inventory -- --check
```

## Hand-off

- ST-06 and ST-09 read the inventory.

The role agent sets `--set ST-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-02 done`.
