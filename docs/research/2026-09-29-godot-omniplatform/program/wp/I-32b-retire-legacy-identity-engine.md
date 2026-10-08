# I-32b Retire the legacy identity engine: `oidc_config` and `licenses.sub` unread, `PLATFORM_OIDC_*` removed (release N)

| Field       | Value                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                                                                                                                                                       |
| Size        | 0.5–0.7 engineer-weeks                                                                                                                                                                                                                                  |
| Depends on  | [I-27](I-27-plan-identity-consolidation.md), [I-32](I-32-product-connections-absorbs-i-22.md), [SP-40](SP-40-retire-react-cookie-mode-browser.md), [LX-38](LX-38-account-keyed-automatic-licences.md), [U-27](U-27-keep-licence-config-layer-delete.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-32c](I-32c-identity-contract-drops.md)                                                                                                                                                                       |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                   |
| Plan mode   | yes: executes the approved [`plans/I-27.md`](../plans/I-27.md) (2026-10-08) §7, §7.1, §7.2 and its I-32b rows in §3 and §6                                                                                                                              |
| Gates       | `plan-mode`, `migration`, `rule-9`, `rule-10`, `threat-model`, `drift-gate`, `cli-bundle`                                                                                                                                                               |
| Human input | the owner-set date for `legacy-sub-sunset`; DJDL's own `.pkey/product` drops `oidc` and `provisioning` (owner step)                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                               |

## Goal

The legacy identity engine (`I/oidc.ts`, I-17's report, the legacy `auth/callback` and device poll) is gone, nothing reads `oidc_config` or predicates on `licenses.sub`, and `PLATFORM_OIDC_*` is removed from `Env`, the platform inventory and `adminOidcConfig`'s fallback. Done when every acceptance criterion holds and the green gate passes.

## Why

I-27 replaces the env-held Pocket ID and per-product `oidc_config` with connections (I-30, I-32) and account-keyed licences (I-08, LX-38). This is release N of the retirement: reads stop here, and I-32c drops the table and indexes one release later.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [`plans/I-27.md`](../plans/I-27.md) §7 (the retirement table and the native-binary rule), §7.1 (every `oidc_config` site and the edge-mint approval basis), §7.2 (every `licenses.sub` reader), §3 (the retired manifest fields), §6 (migrations and P0-49 jobs) and §10 (tests).

## Scope

**In:**

- Every §7.1 site and every §7.2 reader moved or deleted as the plan's tables say; `enrollFate`'s guard is the one `sub` read that stays.
- The approval's issuer half: `00XX_edge_mint_approvals_connections.sql` (`connections_json`) and the P0-49 job `edge-mint-approval-connections`.
- `00XX_index_assertion.sql` without `idx_licenses_sub` and `idx_licenses_sub_global`; both leave `REQUIRED_INDEXES` in the same change.
- The seeded Pocket ID row's audience written once from the last `PLATFORM_OIDC_MIGRATION` and `_SUNSET` values, recorded in P0-24; then both names retire.
- `PLATFORM_OIDC_*` removed from `Env`, the inventory and `adminOidcConfig`'s fallback, after confirming `ADMIN_OIDC_*` is set in production.
- §3's retired fields (`oidc.*`, `provisioning[]`) become validator errors naming their replacement (rule 9), and `products/djdl/product.json` migrates in the same change. `provisioning_config`'s readers and writers are listed as §7.1 lists `oidc_config`'s.
- The P0-49 job `legacy-sub-sunset` at the owner-set date.
- Before any route goes, production request logs confirm no native client calls it, recorded in P0-24.

**Out** (and where it belongs instead):

- The drops (→ I-32c); product connections (→ I-32); cookie mode (→ SP-40); the policy half of the approval basis (→ LX-36).

## Design notes

- Name each migration `00XX_<name>.sql`; the lead assigns numbers at merge. One `ALTER` per file, replay-safe, with a down script.
- Pocket ID stays a connection with audience `both`; `PLATFORM_OIDC_SUNSET` is never set (owner, 2026-10-08, I-27 Q3).
- Rollback: revert while `sub` is still populated; the `PLATFORM_OIDC_*` secrets stay set until I-32c is the rollback target (§9).

## Steps

1. Verify §7.1 and §7.2's line references against the code and record corrections here.
2. Run the two P0-49 jobs' dry runs and record the reports.
3. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] No `oidc_config` anywhere in `packages/worker/src` or `packages/worker/scripts` (grep test).
- [ ] No predicate on `licenses.sub` except `enrollFate`'s guard (grep test).
- [ ] `edge-mint-approval-connections` runs on a fixture with one approved custom-issuer product.
- [ ] `REQUIRED_INDEXES` equals the newest assertion file.
- [ ] A manifest with a retired `oidc.*` or `provisioning[]` field fails validation naming its replacement; `products/djdl/product.json` resyncs clean.
- [ ] The native-binary check is recorded in P0-24 before any route is removed.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

`plans/I-27.md` §10's commands, then the full green gate in `AGENTS.md`.

## Hand-off

I-32c drops `oidc_config`, the two `licenses.sub` indexes and, if nothing reads it, `provisioning_config`. The role agent sets `--set I-32b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-32b done`.
