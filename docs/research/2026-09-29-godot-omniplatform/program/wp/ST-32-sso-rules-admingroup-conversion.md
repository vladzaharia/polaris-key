# ST-32 SSO rules and the adminGroup conversion

| Field       | Value                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity) |
| Size        | 0.8–1.1 engineer-weeks                                                                                                   |
| Depends on  | [ST-31](ST-31-roles-bindings-invites-members-pages.md), [I-30](I-30-connections-one-oidc-relying-party.md)               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-35](ST-35-rbac-docs-lockout-recovery-docs-gate.md)                           |
| Role        | `pkey-implementer`                                                                                                       |
| Plan mode   | no                                                                                                                       |
| Gates       | `threat-model`, `rule-9`                                                                                                 |
| Human input | none                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-05** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.

- Clears its entries in `packages/admin/test/copy.debt.json` (ST-37's console copy ledger).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: it owns the `ClaimMatcher` JSON, `PRIVILEGE_GRANT_KEYS` and the operator-audience write gate. It evaluates rules per request over stored link claims, not only at sign-in, and reads `claims_json`, which I-30 owns. It owns the stopped `admin_group` writes, the non-default-only offers and their outcome rows, the `product.adminGroup` refusal (`invalid_admin_group`, both spellings, schema `false`), the deleted parser read and spelling row, and the migration of `products/djdl/product.json`.
- [`plans/I-27.md`](../plans/I-27.md) §12: `SignInFacts`; `connection:<id>` in `amr`; one Pocket ID connection with audience `both`.

## Goal

SSO rules and the adminGroup conversion, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-05** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, for **AC-05**.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- SSO rules as the platform setting console.access in exactly license.access's rule JSON, written through writeSetting (step-up, audit, history) with one RuleEditor and match preview shared with LX-36 and P2-10; issuer allowlist check; matchers (groups includes, one claim equals, and a verified email domain that only matches an email vouched by a DNS-verified, enforced I-30 connection); minimal claims_json retention; evaluation at sign-in; identifier-first routing of operators to their SSO connection (moved from ST-30); the root rule card; core.adminGroup conversion offers and the manifest deprecation warning.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-05**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Rules evaluate identically in preview and at sign-in (test)
- [ ] An address confirmed only by email code never matches a console domain rule (test)
- [ ] Every product with an adminGroup gets a one-click conversion offer
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/console/members`, `reference/roles`, the runbook's lockout recovery and the rule 11 text.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-32 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-32 done`.
