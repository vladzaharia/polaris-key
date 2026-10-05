# PX-W17 Identity as a per-product service (G34): `services.identity` toggle, refusal on every app-sign-in entry when off, pairwise subjects for product users, developer surfaces on pairwise ids

| Field       | Value                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                                            |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                             |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-05](I-05-accounts-core.md)                                                                                                                                               |
| Unblocks    | none                                                                                                                                                                                                               |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                              |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                  |
| Gates       | the PORTAL.md §11 green gate; plan mode; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; corpus and transcripts (`gen:corpus -- --check`, `gen:transcripts -- --check`); `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                          |

## Goal

`services.identity` is a per-product toggle; every app-sign-in entry (`/authorize`, native redirect, RFC 8628, the broker) refuses a product with Identity off with `identity_disabled`; licenses attach to the account regardless; product users exist only for Identity products and carry a pairwise subject (keyed HMAC of account and product), which every developer-facing surface uses instead of the account id.

## Why

Owner decision: one account, Identity per product ([PORTAL.md §3.1](../../../../design/PORTAL.md#31-model), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G34). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §3.1](../../../../design/PORTAL.md#31-model), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `plans/I-04.md`; `wp/I-05-accounts-core.md`
- `docs/security/THREAT-MODEL.md`

## Scope

**In:**

- The toggle, the refusals, pairwise subjects and developer surfaces per I-04's plan.

**Out** (and where it belongs instead):

- The friendly error card UI (→ PX-14)

## Design notes

- **Plan mode** where the ID token or SDK contract changes (corpus, transcripts); executes I-04's plan.
- **THREAT-MODEL (cross-product correlation).**
- **Overlap with the re-cut S-16/S-17 graph:** I-05 and I-04 also name pairwise subjects and the Identity toggle. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I; the graph maps them onto the re-cut S-16 ids (see README §8, phase PX): portal I-06 → I-05 (accounts, links, pairwise subjects), I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06, I-08 (email login) → I-07, I-14 (passkeys) → I-16, I-13 (native redirect) → I-15, I-15 (sessions) → I-07, I-16 (per-product issuer) → I-08 for layer 1 (I-21 later), S-17 → U-05.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W17:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W17 in-review`.

## Acceptance criteria

- [ ] Test: two products see two different ids for one account.
- [ ] Every app-sign-in entry refuses a product with Identity off (tests).
- [ ] Corpus and transcripts are regenerated if the token shape changes.
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity
```

## Hand-off

PX-14 shows the `identity_disabled` error card.

The role agent sets `--set PX-W17 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W17 done`.
