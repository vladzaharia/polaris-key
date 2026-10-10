# LX-18 W-LX: the licensing and store-commerce wire train

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase C: the wire)                                                                                                                                                                                                                                                                                                  |
| Size        | 0.6–0.85 engineer-weeks                                                                                                                                                                                                                                                                                                                                                         |
| Depends on  | [LX-01](LX-01-licensing-plan.md), [LX-09](LX-09-entitlement-resolver.md), [LX-12](LX-12-licence-lifecycle.md), [LX-41](LX-41-durations-subscriptions-core-trials.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [CM-20](CM-20-commerce-consolidation-plan-lx-11-plan.md), [P0-44](P0-44-corpus-generator-split-corpus-lane-right.md), [CM-29](CM-29-commerce-service.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-14](P2-14-optional-split-dev-channel-from-dev.md), [LX-19](LX-19-sdks-licensing.md), [LX-20](LX-20-commerce-clients.md), [LX-42](LX-42-quantities-consumables-required.md)                                                                                                                                                          |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                           |
| Plan mode   | yes: the plan [`plans/LX-18.md`](../plans/LX-18.md) needs human approval before code                                                                                                                                                                                                                                                                                            |
| Gates       | plan mode; conformance corpus (`gen corpus --check`); drift gate (`--check`); `PROTOCOL_VERSION`                                                                                                                                                                                                                                                                                |
| Human input | plan approval (`plans/LX-18.md`)                                                                                                                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                       |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** Q6: add `reason: "no_license"` to the licence-less 401, so new SDKs show `needs-activation` instead of `revoked`.
- **[`plans/PX-W8.md`](../plans/PX-W8.md):** Q5: `not_entitled` with `reason: device_limit` on the sign-in path carries `manageUrl` from PX-W8's `core/manageUrl.ts` builder.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- The sign-in seat refusal is no longer the main path: the card's LicenseChoiceStep and inline Replace handle a full licence. `device_limit` + `manageUrl` covers only the bind-time race on surfaces without the card (`plans/PX-W8.md` alignment note).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> W-LX train (plan mode, additive inside v4, corpus appended). Required members: the duration member `term` (replacing licenseExpiresAt; onExpiry stop | keepVersion | tier:<id> for trials; trial end), grants[] with addon/label/quantity, the consumable rows (consume, reverse and acknowledge device routes, their refusal codes; LX-42 implements them), 401 and not_entitled reasons, CM-20's offers[], the app claim kind and the transferred restore result, CM-14's W4 enum. Optional appended members, only if ready: LX-25 redeem, P2-14 dev-bypass split. The channels predicate is unchanged (WIRE-CONTRACT-V4 §5.1 rule 4).

- Title: was "Licensing wire amendment: per-entry `expiresAt`, `licenseExpiresAt`, `grants`, 401 `reason` and `not_entitled` reasons in `shared-protocol`, client-core, parity and the corpus".
- Depends on: added LX-41, LX-35, CM-20 and P0-44.

- Owner 2026-10-07/08: Commerce is a service (CM-29, `plans/CM-29.md`). Its code lives in `services/commerce/`, device routes move to `/<p>/commerce/*` in CM-29's release with the SDK path strings (no aliases), and the store hook URLs stay as Commerce's canonical routes. Reconcile this package with CM-29's approved plan before building.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/CM-20.md`](../plans/CM-20.md) §14: adds §3.3's section, which it numbers, and the enums and features. It changes no commerce corpus file; LX-11 and CM-25 record the transcripts.
- [`plans/CM-29.md`](../plans/CM-29.md) §10: its store-commerce section points to CM-29's §5 bullet, and it adds the `@polaris-key/protocol/commerce` subpath. The W-LX member list starts with CM-29.
- [`plans/LX-41.md`](../plans/LX-41.md) §13: `term` from `licenseTerm()` (§2.5) replaces `licenseExpiresAt`; the 401 reasons are `licenseState().reason`.

## Goal

The device wire carries the model: per-entry `expiresAt`, `licenseExpiresAt`, `grants`, a 401 `reason`, and `not_entitled` reasons, in `shared-protocol`, client-core, parity and appended corpus cases.

## Why

SDKs cannot tell expired from revoked or refunded, and `isEntitled` ignores status (G10, G11, [S-19 §4.3](../../notes/S-19-licensing-model.md#43-gaps)). Decision 9 ships Phase C right after Phase B under `PROTOCOL_VERSION` 4 precedent ([S-19 §10.3](../../notes/S-19-licensing-model.md#103-owner-decisions-recommended-defaults-in-bold) decision 9).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-19 owner decisions](../../notes/S-19-licensing-model.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-19 §7.10](../../notes/S-19-licensing-model.md#710-wire-impact-plan-mode), [S-19 §9](../../notes/S-19-licensing-model.md#9-phased-plan-and-work-packages) row LX-18.
- P4-13, P4-19 and P4-29 plans (precedent).

## Scope

**In:**

- The plan, naming corpus regeneration and every SDK that follows; contract, catalog, corpus, client-core.

**Out** (and where it belongs instead):

- SDKs (→ LX-19).

## Design notes

- An all-languages event: contract → catalog → corpus → SDKs.
- Old SDKs ignore entry expiry (risk 7).

## Steps

1. Plan and approval.
2. Contract and corpus.
3. client-core and parity.

## Acceptance criteria

- [ ] `gen corpus`, `gen constants` and `gen transcripts` `--check` pass.
- [ ] Browser runners pass.
- [ ] `activate-refusals` step 3 carries the expired reason; sync 401s carry it for authenticated tokens ([SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen corpus --check
mise exec node@22 -- pnpm gen constants --check
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- LX-19 executes the same plan in every SDK.

The role agent sets `--set LX-18 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-18 done`.
