# I-13 Exchange endpoint `POST /<p>/identity/token` for platform kinds (native Apple and Google ID tokens first), tenant-scoped links, `interstitial_required`; `exchange` in all six SDKs

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)                                                                                                |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                  |
| Depends on  | [I-05](I-05-accounts-core.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md)                                                    |
| Unblocks    | [I-14](I-14-game-verifiers.md), [I-22](I-22-bring-your-own-auth.md), [I-25](I-25-backend-assertion.md)                                                                                |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                 |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-13.md` first; it needs human approval before code                                                                                            |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`); THREAT-MODEL; `test:workerd` |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W13.md`](../plans/PX-W13.md):** §2.5: the request carries `deviceName` under §2.1 and the entry creates a `native` handle.

## Goal

`POST /<p>/identity/token` exchanges a platform identity token (native Sign in with Apple and Google ID tokens first) for the activation response, through tenant-scoped links; a link not seen before answers `interstitial_required` with a login-card URL; all six SDKs gain `exchange`.

## Why

Native apps should not be limited to device code ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J9, J4). Native Apple and Google subjects are scoped to the developer's team or client, so they are links that recognise the person only inside that developer's products ([S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model)). The first native sign-in cannot finish silently because the interstitial is required ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/I-13.md` once approved; `plans/I-04.md`.
- [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) ("Tenant-scoped links"), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (exchange row, "First native sign-in needs the interstitial"), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 2 and 16, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-13.
- `packages/worker/src/services/identity/idToken.ts`, `oidc.ts`; the I-10a and I-10b SDK identity clients.

## Scope

**In:**

- The exchange route for platform kinds, with `kind` values and the discovery member `exchange.kinds[]`.
- Native Apple (audience = the product's `identity.native.apple` bundle ids) and native Google (the developer's client ids) verifiers.
- Tenant-scoped link creation and lookup on `(issuer_key, tenant_scope, subject)`.
- `interstitial_required` with a Worker-built login-card URL for a first link; silent sign-in afterwards.
- `exchange({kind, token})` in all six SDKs with transcripts.

**Out** (and where it belongs instead):

- Game platform verifiers (→ I-14); product-owned IdP kinds (`oidc`, `firebase`) (→ I-22, layer 2).

## Design notes

- A token for a developer's bundle id is never a login-card sign-in, and the reverse ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2).
- A Game Center or native Apple subject for team A must never resolve an account for team B (test).
- Returns the existing activation response; no `PROTOCOL_VERSION` bump.
- **Identity service only (owner, 2026-10-04).** The Polaris Key account is platform-level (Core and the portal) and always present; the per-product Identity service is the toggle. The exchange is app sign-in, so it is available only for products with Identity on. With Identity off the product's discovery advertises none of it and the route refuses.
- **No silent first sign-in to an app (D22, decided by the owner 2026-10-04).** Besides a new link, a known link with no "Continue to <App>" grant for this product (`account_product_grants`) also answers `interstitial_required`; only after both exist is the exchange silent.
- **Joining on the email step (owner, 2026-10-04).** If the email confirmed in the interstitial already belongs to another Polaris Key account, the card offers to join the two accounts with both proven in one session; it never joins silently (S-16 §5.1).

## Steps

1. Plan (`plans/I-13.md`), approved.
2. `errors.json`, route and verifiers with fixtures.
3. Transcripts, then the six SDKs.

## Acceptance criteria

- [ ] First exchange answers `interstitial_required`; after the card visit the same token signs in silently (tests).
- [ ] A known link without a Continue-to-<App> grant for this product answers `interstitial_required` (D22, test); with the product's Identity toggle off the route refuses and discovery omits `exchange` (test).
- [ ] Cross-team tenant-scoped miss (test); wrong audience refused (test).
- [ ] All six SDKs replay the exchange transcripts; parity rows updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity exchange
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- I-14 adds game-platform kinds; I-22 adds product-IdP kinds; I-25 builds the backend assertion on this route.

The role agent sets `--set I-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-13 done`.
