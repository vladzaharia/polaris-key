# LX-38 Account-keyed automatic licences; Discover for every account

| Field       | Value                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                             |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                       |
| Depends on  | [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-32b](I-32b-retire-legacy-identity-engine.md), [LX-16](LX-16-licensing-contract.md)                                                |
| Role        | `pkey-implementer`                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                           |
| Gates       | `threat-model`                                                                                                                                                               |
| Human input | owner step `I-17-claim`                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-38** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the §2.2 swap; delete `"license-mint"`; `previewIdentityIssue`'s would-be row.

## Goal

Account-keyed automatic licences; Discover for every account, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-38** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.4, §6); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.4, §6, for **LX-38**.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- issueLicense keyed by account, with no key minted and the device bound at once, for product sign-in, the card and passthrough (hook for I-08), Discover for every account including email-only ones, and LicenseChoiceStep Create; every access-policy path writes origin oidc (the kept identifier for 'issued by the access policy', which LX-15 labels Automatic grant); a unique partial index on licenses(product, account_id) WHERE origin = 'oidc' AND account_id IS NOT NULL AND ended_reason IS NULL, inserts with ON CONFLICT returning the existing licence, a new 00XX_index_assertion.sql, and a P0-49 duplicate report resolved before the index ships; no sub on platform products under I-17 claim mode (owner step: PLATFORM_OIDC_MIGRATION=claim in production); a first automatic licence may skip the choice step (D4, decided under the brief); a one-off attach job; THREAT-MODEL Discover rows.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-38**; DX consolidation E: Licensing model.
- Security review and THREAT-MODEL rows before merge (`sec`).
- Needs an owner step (`I-17-claim`; tracks.md Track A, lead action 5, and `~/Downloads/polaris-key-owner-steps.md`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Automatic paths create no key row (test); an admin can add one later
- [ ] Two concurrent sign-ins, or a sign-in racing a Discover self-mint, create one licence (test)
- [ ] Discover self-mint and use-time mint call the same function
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/access` (enrollment and policy merged; automatic licences); `help/activate`, `help/library`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-38 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-38 done`.
