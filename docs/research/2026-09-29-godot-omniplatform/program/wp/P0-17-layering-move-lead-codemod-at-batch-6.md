# P0-17 Layering move (lead codemod at the batch-6 boundary)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Size        | 0.8–1.2 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on  | [LX-08](LX-08-licensing-expand.md), [HA-12](HA-12-presentation-discovery.md), [P0-15](P0-15-platform-primitives-duplicate-helper.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unblocks    | [P0-16](P0-16-first-party-respond-body-module-console.md), [P0-18](P0-18-table-ownership-owner-stores-one-audit.md), [P0-19](P0-19-descriptor-contributions-services-slug.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [P0-21](P0-21-notification-substrate-core-notify.md), [P0-22](P0-22-request-scoped-product-context-lazy.md), [P0-26](P0-26-core-manifest-ingest-pipeline.md), [P0-27](P0-27-one-adapter-store-delivery-commerce.md), [P0-29](P0-29-licence-list-paging-set-queries.md), [P0-30](P0-30-guardrails-test-harness-test-layout.md), [P0-33](P0-33-worker-owned-dto-types-admin-portal-apis.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md), [P0-51](P0-51-1-0-readiness-review.md), [I-28](I-28-accounts-contract-phase.md), [F-33](F-33-personal-tokens-pkeyp-packages-read.md), [ST-05a](ST-05a-one-settings-read-write-path.md), [ST-29](ST-29-admin-route-table-can-usecan.md), [CM-29](CM-29-commerce-service.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Gates       | none beyond the green gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Layering move (lead codemod at the batch-6 boundary), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-03** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.1, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.1, §4.2, §4.3, for **CQW-03**.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.
- [`audits/cq-worker-services.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-services.md), for file and line evidence.

## Scope

**In:**

- Lead-run codemod in the worker window, as soon as batch 6 has landed on main and P0-15 has merged (the console window, P0-31 and P0-39, runs beside it; P0-44 is a corpus-lane item, not part of either window). P0-16, P0-21, P0-22, P0-29 and ST-05a start after it on the new layout: top-level env/crypto/kv/keyvault/http/securityHeaders/platformOidc/fingerprint/merge into platform/; shared admin/lib/\* and AdminSession into core/ or console/; split admin/lib/shape.ts; delete the 13 re-export shims; core/ domain folders (licensing, accounts, notify, trust, assets, registry, ops); admin/ renamed console/; per-service public.ts; test/boundaries.test.ts made transitive. Open branches merge main once afterwards.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-03**; DX consolidation B: Foundations (code quality the feature tracks build on).
- Run by the lead in a short window (tracks.md rule 2); every package that touches the moved files depends on it, so no branch is in flight across the codemod.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Transitive boundary test is blocking (P0-48 seeded it report-only)
- [ ] No re-export shim remains
- [ ] Gate green with no behaviour change

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-17 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-17 done`.
