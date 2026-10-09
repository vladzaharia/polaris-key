# PS-11 Storefront close-out: docs, glossary, THREAT-MODEL S1–S11, ADMIN.md and PORTAL.md amendments, `discover_enabled` readers retired

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 5: close-out)                                               |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                      |
| Depends on  | [PS-05](PS-05-storefront-portal-ui.md), [PS-06](PS-06-console-polaris-key-storefront.md), [PS-12](PS-12-discover-visibility-one-setting.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                          |
| Plan mode   | no                                                                                                                                          |
| Gates       | docs help-link drift gate; THREAT-MODEL; migration (readers retired, column kept)                                                           |
| Human input | none                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                   |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Close-out with the Storefront/Channel vocabulary (ST-37); retires the listed, offerPaths and discover_enabled readers after PS-12 as migration-ledger rows (P0-24).

- Depends on: added PS-12.

## Goal

The storefront is documented for users and operators, the glossary has its terms, THREAT-MODEL carries S1–S11, ADMIN.md and PORTAL.md are amended, and nothing reads `discover_enabled` any more.

## Why

[S-21 §6.9, §11](../../notes/S-21-polaris-storefront.md#69-threat-model-deltas-ps-11-writes-them).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/docs/src/content/docs/users/portal.md`, `services/identity/portal.md`, `start/concepts.md`; `docs/security/THREAT-MODEL.md`; `docs/design/{ADMIN,PORTAL}.md`.

## Scope

**In:**

- Docs pages (users: Discover and the storefront page; admin: the Polaris Key panel); glossary: Polaris Key storefront, obtain path, library entry.
- THREAT-MODEL section "The Polaris Key storefront (PS-01…PS-09)" with S1–S11 and residuals.
- PORTAL.md §4.16 "Who sees what" with the listing modes; ADMIN.md panel.
- Remove the `discover_enabled` dual-read (the column stays; dropping it is a later contract step).

**Out** (and where it belongs instead):

- Commerce docs (→ S-22).

## Design notes

- Rule 4: the concepts page wins; "product", "tier", "device".

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- PORTAL §4.16 amendments: Discover uses the Library's large tile in 3 columns from 1280 px, 2 from 640, 1 on phones; no 'What shows up here' panel (one footnote, 'Purchases appear in your library automatically.'); open products read 'No license needed'; trials show their duration; store-only listings never get Add to library; after a claim, focus moves to Open <product>. No chartreuse hero band or slogan (B12). (portal-23)

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-11:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-11 in-review`.

## Acceptance criteria

- [ ] `check:links` passes; THREAT-MODEL section present; no reader of `discover_enabled` remains (grep).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

None.

The role agent sets `--set PS-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-11 done`.
