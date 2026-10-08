# P0-28 One sealed credential store and resolver

| Field       | Value                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation H: Distribution channels, storefronts and commerce)                                                                               |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                         |
| Depends on  | [P0-18](P0-18-table-ownership-owner-stores-one-audit.md), [P0-27](P0-27-one-adapter-store-delivery-commerce.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                      |
| Unblocks    | [P0-28b](P0-28b-drop-old-credential-stores-release-n-1.md), [P0-51](P0-51-1-0-readiness-review.md), [A-33](A-33-channels-enable-in-one-confirmation.md), [CM-02](CM-02-provider-webhooks.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                        |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/P0-28.md` first; no code before a human approves it                                                                                                   |
| Gates       | `plan-mode`, `migration`, `table-owners`, `threat-model`                                                                                                                                     |
| Human input | plan approval (`plans/P0-28.md`)                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                    |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQW-14** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: absorbs the secrets of `identity_connections`.

## Goal

One sealed credential store and resolver, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQW-14** in [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§1.5, §3.1, §3.2, §4.2, §4.3, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode), and the skill that applies, if any.
- [Track H, Distribution channels, storefronts and commerce](../../../2026-10-07-dx-consolidation/tracks.md#h-distribution-channels-storefronts-and-commerce): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §1.5, §3.1, §3.2, §4.2, §4.3, §5, for **CQW-14**.
- [`audits/cq-worker-core.md`](../../../2026-10-07-dx-consolidation/audits/cq-worker-core.md), for file and line evidence.

## Scope

**In:**

- Merge product_secrets, outlet_credentials and platform_credentials (plus platform_store_settings meta) into one scoped sealed store with one put/open/pin/version/record API; resolveCredential(kind, product) answers product, then platform, then env, with provenance, and A-33's 'available' state reads it. Release N: re-seal into the new store through a P0-49 job (dry run, report, apply) and switch every reader, keeping the old stores read-only; P0-28b drops them a release later. THREAT-MODEL update and security review. Lands before CM-02.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track H (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQW-14**; DX consolidation H: Distribution channels, storefronts and commerce.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- Plan mode (custody): the plan is approved before any code.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Wait for the approved `plans/P0-28.md` (written by `pkey-wire-planner`).
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Four stores become one
- [ ] Dry-run re-seal report reviewed before apply
- [ ] Security review signed
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): `operate/console/keys-and-secrets`; `operate/platform/connections`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-28 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-28 done`.
