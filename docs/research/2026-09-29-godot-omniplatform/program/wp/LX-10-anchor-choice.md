# LX-10 One rankLicenses() with version-aware re-homing (absorbs LX-21)

| Field       | Value                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase B: the model, server-only)                                                                                                                                                                                                       |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                                                                                                                                                             |
| Depends on  | [LX-09](LX-09-entitlement-resolver.md), [I-09](I-09-key-entry-attach.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md)                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [LX-11](LX-11-commerce-rework.md), [LX-14](LX-14-console-licensing.md), [LX-15](LX-15-portal-licensing.md), [CM-05](CM-05-checkout-fulfilment.md), [CM-25](CM-25-app-purchase-as-licence-source.md), [LX-40](LX-40-retire-licensing-model-settings-7-1.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                                                                                                                                                 |
| Gates       | THREAT-MODEL                                                                                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                          |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q1: keep a usable anchor unless the holder has a candidate with a strictly higher `tiers.rank`, then move the device to it, seat-checked; the `id` tiebreak.
- **[`plans/I-09.md`](../plans/I-09.md):** replace I-09's inline `core/anchor.ts` behind the same signature.

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package (`plans/LX-01.md`, the same-named section):

- **`chooseAnchor` orders, it does not choose.** It becomes `rankAnchorCandidates` behind I-09's
  signature. The order (`rank-first`, `most-free-seats` or `oldest`, then the `id` tiebreak) only
  sets the preselected row of the card's `LicenseChoiceStep`.
- **Q1** (a strictly higher-rank candidate) preselects that licence over **Keep**. It never moves
  a device by itself.
- **Auto-issue** runs only when there are no candidates, or when the person picks **Create a new
  free licence**.
- **Enroll supersede on attach** runs only when the person picked the superseding licence.
- **`signin-anchor.json`** asserts the preselection order, binding to the explicit pick, and full
  rows with Replace instead of `not_entitled`.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- `chooseAnchor` orders and preselects only, and never preselects a higher rank over the device's current licence or **Keep** (`plans/I-04.md` §F.2, `plans/LX-01.md` Q1 amended); `signin-anchor.json` asserts that a device already on the rank-0 licence keeps it preselected.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One rankLicenses() (covers the running build via X-PKey-Version, then rank, no expiry, latest expiry, oldest, id) for chooser, Library, consent and LicenseChoiceStep. Fixed re-home on refresh only when the anchor became unusable or the build left its window, to a covering licence with a free seat. Absorbs LX-21 (portal 'Run this device on'). No anchorPolicy or reanchor. Built in core/licensing/issue.ts.

- Title: was "Anchor choice at activation (`anchorPolicy: rank-first`): sign-in, attach, Discover and base claim; licence-less devices; enroll supersede and grant re-homing on attach".
- Depends on: added P0-20.
- Absorbs LX-21: The reanchor: onRefresh setting goes; the useful behaviour is LX-10's fixed re-home rule and a portal device action.

## Goal

Activation chooses the anchor by `anchorPolicy` (default `rank-first`) for sign-in, attach, Discover and base claims, handles licence-less devices, supersedes an enrolled free licence on attach and re-homes its grants; I-09's inline rule is replaced by `chooseAnchor`.

## Why

Decision 3 accepted `rank-first` ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 3); I-09 carries steps 1–3 inline until this lands (`program/plans/I-04.md` amendment).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.5](../../notes/S-19-licensing-model.md#75-anchor-selection-seats-and-re-anchoring), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-10.

## Scope

**In:**

- `chooseAnchor` in Core; `rank-first`, `most-free-seats`, `oldest`; auto-issue fallback; enroll supersede; grant re-homing.

**Out** (and where it belongs instead):

- `reanchor: onRefresh` (→ LX-21).
- `reason: no_base_licence` on the wire (→ LX-18).

## Design notes

- Default `reanchor: onActivation` (decision 10); licence-less devices: `licensed`/`entitled` gates require an anchor (decision 23).

## Steps

1. `chooseAnchor` with tests.
2. Replace I-09's inline code.
3. Supersede and re-homing.

## Acceptance criteria

- [ ] The anchor order matches §7.5 for each policy (tests).
- [ ] Attach of an enrolled free licence supersedes it and keeps its grants (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- LX-11, LX-14, LX-15, LX-21.

The role agent sets `--set LX-10 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-10 done`.
