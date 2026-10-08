# I-20 Plan layer 2 on I-08's endpoints (re-scoped)

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-2)                                                                                       |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                             |
| Depends on  | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md), [I-12](I-12-console-users.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-21](I-21-product-issuer.md), [I-23](I-23-app-profiles.md)                                                               |
| Role        | `pkey-wire-planner` (planning only)                                                                                                                                |
| Plan mode   | yes: planning only; writes `plans/I-20.md`, which needs human approval (merging the plan PR)                                                                       |
| Gates       | plan mode; human approval                                                                                                                                          |
| Human input | none                                                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                          |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/LX-01.md`](../plans/LX-01.md):** the issuer's `pkey:entitlements` claim is `resolveSubjectEntitlements(p, sub)`, filtered to `userGrant` keys. No corpus change.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Re-scoped layer-2 plan, after the consolidation: the issuer extends I-08's endpoints (no oauth/\* tree), product connections (I-32) replace product-IdP kinds, app-specific profiles dropped, clients extend PX-W13's record.

- Title: was "Plan layer 2: app-specific profiles, apps signing users in beyond licence attach, product-IdP kinds and their scoping, the per-product issuer (in-house `jose` against Ory Hydra), clients and consent".
- Estimate: 0.4–0.6 engineer-weeks (was 0.6–0.85).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the same endpoints; `openid`; clients extend `ClientRecord`; the §12.8 sentence.

## Goal

An approved plan, `plans/I-20.md`, for layer 2 (per-app identity): app-specific profiles, apps signing users in beyond licence attach, product-IdP kinds and their scoping (D18), and the per-product OIDC issuer ("Sign in with <Product>"), including the build choice between in-house on `jose` and Ory Hydra, clients and consent.

## Why

The owner approved layer 2 in full but put it after layer 1, leaning in-house on `jose` for the issuer ([S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D12). It needs its own plan because the issuer is a new signed artefact with key, consent and conformance duties ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §4](../../notes/S-16-identity-service.md#4-options) (Option F), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) ("Sign in with <Product>"), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 10 and 14, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-20, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D12 and D18.

## Scope

**In:**

- App-specific profiles per account × product (shape for I-23).
- Product-IdP exchange kinds (`oidc`, `firebase`) yielding product-only principals, and portal-side linking under step-up (D18) (for I-22).
- The issuer: discovery, JWKS (separate RS256 keyring sealed under `PLATFORM_KEK`), authorize, token, userinfo, refresh rotation, revocation, end-session; `sub` = pairwise subject; scopes `openid`, `email`, `profile`, `offline_access`, `pkey:licenses`, `pkey:entitlements`; static clients registered in the console or manifest (no DCR); consent and the connected-apps grants (for I-21).
- The `jose` versus Ory Hydra decision, with the owner's lean recorded.

**Out** (and where it belongs instead):

- Code (planning only); custom auth domains (deferred, owner).

## Design notes

- Layer 1 already fixes `sub` as the pairwise subject, so issuer tokens add no join key.
- Everything in layer 2 belongs to the per-product Identity service and exists only for products with Identity on; the account stays platform-level (owner, 2026-10-04).
- Decided by the owner 2026-10-04 and binding on the plan: D17 (credentials only on the login card; an in-app credential API is revisited only for app-specific profiles), D18 (a product's own IdP stays product-only, linkable from the portal under step-up), D19 (the account email reaches a product only with consent), D21 (merge: survivor's subject wins, alias, `subject.merged`) and D22 (no silent SSO: first sign-in per app, and every device code, needs "Continue to <App>"; issuer consent builds on that grant).
- Access tokens 5–15 minutes; claims carry entitlements, not licence state.

## Steps

1. Draft `plans/I-20.md` against the layer 1 code.
2. Set status `awaiting-approval` and stop.

## Acceptance criteria

- [ ] `plans/I-20.md` covers every item in Scope → In and names the OIDF conformance target for I-21.
- [ ] Status is `awaiting-approval`; nothing is implemented.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```

## Hand-off

- I-21, I-22 execute this plan; I-23 follows it.

The role agent sets `--set I-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-20 done`.
