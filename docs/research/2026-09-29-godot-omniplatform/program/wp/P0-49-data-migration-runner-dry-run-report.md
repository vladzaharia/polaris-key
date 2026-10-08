# P0-49 Data-migration runner (dry run, report, apply)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md), [P0-18](P0-18-table-ownership-owner-stores-one-audit.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Unblocks    | [P0-28](P0-28-one-sealed-credential-store-resolver.md), [P0-51](P0-51-1-0-readiness-review.md), [P2-12](P2-12-one-update-resolver-retire-github.md), [U-27](U-27-keep-licence-config-layer-delete.md), [U-28](U-28-one-config-chain-default-profile-one.md), [PS-12](PS-12-discover-visibility-one-setting.md), [CM-21](CM-21-storefront-connection-notifications.md), [LX-33](LX-33-licence-tier-platform-default-every.md), [LX-34](LX-34-entitlement-catalog-in-licensing-tier.md), [LX-35](LX-35-add-on-definitions-grantaddon.md), [LX-36](LX-36-access-policy-license-access-absorbs-ps.md), [LX-38](LX-38-account-keyed-automatic-licences.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Gates       | `rule-10`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-17** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the seven jobs in §6.
- [`plans/P2-12.md`](../plans/P2-12.md) §7: P2-12's `update-resolver` job, with its classes, its pacing and its down steps. [`plans/CM-29.md`](../plans/CM-29.md) §10: no CM-29 consumer (a pre-deploy check replaces the job).

## Goal

Data-migration runner (dry run, report, apply), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-17** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.1, §4.2, §4.3, for **CQW-17**.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- core/migrate/: a Core job kind with dry run -> report -> apply, resumable and idempotent, keyed per product, audited through P0-18's writer, with a down path per job; lead-run from the CLI and an admin route (no console page, no notices, no per-product fallback flags); each report recorded in P0-24's ledger. Semantic changes run in two releases: release N materialises explicit values under the old semantics through a job; release N+1 switches the resolver once the job's report shows zero diffs. Consumers: LX-33 (tier backfill, channel and window materialisation, semver-aware), U-28 (profile stacks), LX-34 (entitlement buckets), LX-35 and LX-36 (add-on and grant backfills), LX-38 (duplicate check), LX-39 (pre-flip report), LX-40 (the entitlementModel switch), PS-12, CM-21, I-29, U-27 (the provisioning backfill), P0-28 (re-seal), P2-12 (per-product golden comparison).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-17**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A job dry-runs, reports, applies, resumes after a kill and re-applies as a no-op (test)
- [ ] Every apply is audited and has a down path
- [ ] No consumer ships its own one-off runner (grep)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry routeCoverage
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-49 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-49 done`.
