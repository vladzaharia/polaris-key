# I-23 App-specific profiles per account × product, with consent and per-product export and deletion

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                  |
| Size        | 1–1.4 engineer-weeks                                                                                          |
| Depends on  | [I-20](I-20-layer-2-plan.md)                                                                                  |
| Unblocks    | none                                                                                                          |
| Role        | `pkey-implementer`                                                                                            |
| Plan mode   | no: follows the approved [`plans/I-20.md`](../plans/I-20.md) where it names this package                      |
| Gates       | D1 migration; `TABLE_OWNERS`; THREAT-MODEL; privacy docs; rule 10 (OpenAPI + `routeCoverage`); privacy review |
| Human input | none                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive only if a product needs per-app profile fields that a Cloud Sync record cannot hold. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> App-specific profiles duplicate Cloud Sync account x product data. Partial sharing is I-34's granular consent. Revive only if a product needs per-app profile fields that a Cloud Sync record cannot hold.

- Optional now (was required).

## Goal

Each account can hold an app-specific profile per product, with the shape from `plans/I-20.md`, shared only by consent and covered by per-product export and deletion.

## Why

App-specific profiles are part of the layer 2 scope the owner approved ([S-16 owner decisions](../../notes/S-16-identity-service.md)); they are account × product data, so deletion and merge must reach them ([S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; [`plans/I-20.md`](../plans/I-20.md).
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (account × product data), [S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-23.

## Scope

**In:** the profile table and API per the plan, consent on Continue-to-App, merge and deletion hooks registered in I-05's registries, export entries.

**Out** (and where it belongs instead):

- Issuer claims (→ I-21).

## Design notes

- App-specific profiles are part of the per-product Identity service and exist only for products with Identity on (owner, 2026-10-04). Consent rides on the D22 "Continue to <App>" grant (decided 2026-10-04).
- Consented profile claims are join keys between developers; say so on the consent screen ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 12).

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Steps

1. Table, API and consent.
2. Hooks and export.

## Acceptance criteria

- [ ] A profile is visible only to its product and only with consent (tests).
- [ ] Per-product removal and account deletion delete it (tests).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity profile
```

## Hand-off

- I-21 can expose consented profile claims.

The role agent sets `--set I-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-23 done`.
