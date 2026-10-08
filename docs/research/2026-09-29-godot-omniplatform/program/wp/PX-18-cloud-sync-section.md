# PX-18 Portal Cloud Sync section (absorbs PX-W11)

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-04](PX-04-product-page-today.md), [U-05](U-05-cloud-sync-do.md), [U-12](U-12-privacy-settings-portal.md)                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track G, Managed config and Cloud Sync](../../../2026-10-07-dx-consolidation/tracks.md#g-managed-config-and-cloud-sync)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs PX-W11: the portal Cloud Sync section's API and CloudSyncCard; one card component shared with U-11a.

- Title: was "Cloud Sync section: `CloudSyncCard` on the product page, TOC entry, ⌘K action, export and delete; absent for products without the service".
- Depends on: added U-05 and U-12; removed PX-W11.
- Absorbs PX-W11: One portal Cloud Sync package (API and card). Its 'not on Identity' note was wrong.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/U-01b.md`](../plans/U-01b.md) §11: one quota number per tier, shown read-only with a link to Tiers, plus the ceiling and the pause state. Labels are read server-side.

## Goal

Products with Cloud Sync show `CloudSyncCard` (storage bar, data classes, per-device last sync, export, delete with step-up) with a `#/p/:product/sync` section, a TOC entry and a ⌘K action; products without the service show none of it.

## Why

Cloud Sync lives on the product page only ([PORTAL.md §4.20](../../../../design/PORTAL.md#420-product-page)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.20](../../../../design/PORTAL.md#420-product-page), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `wp/U-12-privacy-settings-portal.md`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `CloudSyncCard`, section route, TOC entry, palette action, export, delete with step-up.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- **Cloud Sync** appears only on the product page of a product whose `services.cloudSync` is on; there is no global Cloud Sync page, nav item or account section.
- **Overlap with the re-cut S-16/S-17 graph:** U-12 also names the product-page Cloud Sync section. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-18:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-18 in-review`.

## Acceptance criteria

- [ ] Test: no sync UI anywhere (section, TOC, palette, route) when `services.cloudSync` is off.
- [ ] Delete requires step-up (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

none.

The role agent sets `--set PX-18 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-18 done`.
