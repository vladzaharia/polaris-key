# I-15 Native redirect sign-in: loopback, claimed-HTTPS and registered-scheme redirects on I-08's token route, retire `/auth/poll`, `signIn({redirect})` in all six SDKs (system browser only)

| Field       | Value                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1b)                                                                                |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                |
| Depends on  | [I-08](I-08-app-passthrough.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md)                                  |
| Unblocks    | [PX-14](PX-14-passthrough-header.md)                                                                                                                                  |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                  |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/I-15.md` first; it needs human approval before code                                                                            |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); all six SDKs (`parity:check`); THREAT-MODEL |
| Human input | none                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                             |

## Goal

Desktop and mobile apps sign in by a native redirect: loopback, claimed-HTTPS and registered-scheme redirect URIs on I-08's code-exchange route, `signIn({redirect})` in all six SDKs with the system browser only, and `/auth/poll` retired.

## Why

Device code is a poor fit on a phone, and four native SDK rows are planned and unowned ([S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J9). I-08 already built the code exchange; this extends its redirect rules to native URIs.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); `plans/I-15.md` once approved; `plans/I-04.md`.
- [S-16 §2](../../notes/S-16-identity-service.md#2-what-identity-is-for-the-jobs) J9, [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK table, `signIn({redirect})` row), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 13, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-15.
- `packages/worker/src/services/identity/oidc.ts:1871-1885`, `packages/worker/src/services/identity/index.ts:67` (the `/auth/poll` note), `packages/worker/src/core/cors.ts`.

## Scope

**In:**

- Native redirect URI classes on the token route: loopback (any port, RFC 8252), claimed HTTPS on the product's domains, per-product registered schemes.
- `signIn({redirect})`: Node and Python loopback, Swift `ASWebAuthenticationSession`, Kotlin Custom Tabs, Godot desktop OS browser plus loopback (device code elsewhere); React already has the web redirect.
- Retire `/auth/poll` and its rate-limit buckets; transcripts.

**Out** (and where it belongs instead):

- Web redirect (done in I-08).

## Design notes

- No non-http(s) schemes except per-product registered native schemes; never an embedded web view. Account credentials are entered only on the `key.plrs.im` login card (D17, decided by the owner 2026-10-04).
- Identity service only (owner, 2026-10-04): native redirect is app passthrough sign-in ("<App> wants you to sign in"), offered only for products with Identity on. The first sign-in to each app ends on "Continue to <App>" (D22).
- Cloud Sync does not need this or the Identity toggle: on a product with Identity off, its principal is the licence owner's subject (`devices.subject ?? subjectFor(license.account_id, product)`, S-17), so the soft dependency below applies only to Identity-on products.
- Returns the activation response; no `PROTOCOL_VERSION` bump.
- Native sign-in in S-17's MVP is device code or QR until this lands; it is a soft dependency of U-06, U-07 and U-21.

## Steps

1. Plan, approved.
2. Redirect URI rules and the `/auth/poll` retirement.
3. Six SDKs and transcripts.

## Acceptance criteria

- [ ] Each URI class is accepted only as registered; unregistered schemes and hosts are refused (tests).
- [ ] `/auth/poll` no longer answers; discovery and transcripts updated.
- [ ] All six SDKs complete a redirect sign-in against transcripts; parity rows updated.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity redirect
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- U-06, U-07 and U-21 switch native sign-in from device code to redirect where available.

The role agent sets `--set I-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-15 done`.
