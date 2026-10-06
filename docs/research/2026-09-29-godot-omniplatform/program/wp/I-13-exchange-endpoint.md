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

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

**Pre-decided for this plan.** When the person has candidates,
`POST /<p>/identity/token` answers `200 {"status":"choose","choices":LicenseChoiceView}` instead
of binding. A follow-up call carries `choice`, with an optional `replaceDeviceId`, and goes
through I-08's `freeAccountDevice()`. The kits gain a native **LicenseChoice** component, with
Replace, and the in-app device list. That plan names its transcripts and all six SDKs.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- `POST /<p>/identity/token` answers `200 {"status":"choose","choices":LicenseChoiceView}` with the amended view (`current`, `access` a display label with the real seat count (SIGN-IN.md D-53), `getLicense.keyEntry`) and takes `choice` on a follow-up call (I-04 §D, §F). The plan names its transcripts and all six SDKs.
- Carry the device list for an in-kit Replace (the `ReplaceView` shape) so the kit's **Replace a device** expands inline like the card's; until then it opens `manageUrl`.
- Native LicenseChoice copy is `signin.choice.*` (title "Choose a license for this device", primary **Use this license and continue**, row anatomy of SIGN-IN.md §3.6).

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- **Supersedes the pre-decided follow-up call.** `POST /<p>/identity/token` takes `licenseChoice` (default `"app"`). When a choice is due it answers `200 {"status":"choose","grant","expiresIn":300,"choices":LicenseChoiceView}`, and the app completes through I-08's grant routes (`choice/licenses`, `choice/devices`, `choice/complete`, `choice/cancel`), not a second call to `token`. With `"card"` a due choice answers `interstitial_required` with the card URL at the choice step.
- The in-kit device list for **Replace a device** is `choice/devices` (I-04 §G.5), so Replace is inline in every kit's form.
- **Transcript:** `exchange-choose.json`. `exchange({kind, token, licenseChoice})` in all six SDKs.
- **Depends on I-08** for the grant routes (already transitive through I-10a and I-10b).

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
