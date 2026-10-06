# I-06 Login-card providers: Google, Apple (Polaris Services ID) and Steam (OpenID 2.0) as platform clients, OIDC discovery behind SSRF and allowlist gates, RFC 9207

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                   |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                     |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-05](I-05-accounts-core.md)                                                                                                                     |
| Unblocks    | [PX-W16](PX-W16-profile-avatars.md), [PX-12](PX-12-login-card-v2.md), [PS-07](PS-07-store-owned-path.md)                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package                                                                                                 |
| Gates       | THREAT-MODEL; `wrangler.toml`; provider fixtures; per-provider audience tests                                                                                                            |
| Human input | a Polaris Apple Services ID with its `.p8` key and registered return URL, a Polaris Google OAuth client, and a Steam Web API key, per environment (live checks only; fixtures otherwise) |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

The login card can sign people in with Google, Apple and Steam through Polaris's own platform clients, every upstream token is checked against its exact audience, discovered URLs pass SSRF and allowlist gates, and RFC 9207 `iss` defends against mix-up.

## Why

Layer 1's methods are platform-wide, so Polaris registers one client per provider and developers configure nothing for web sign-in ([S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface)). Apple is not generic OIDC: an ES256 client secret from a sealed `.p8`, `form_post`, the name only on first consent, and server notifications. This merges the earlier broker and Apple packages.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `plans/I-04.md`.
- [S-16 owner decisions](../../notes/S-16-identity-service.md), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) ("Sign in with Apple and Google are Polaris's own clients", the Apple specifics), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-06.
- `packages/worker/src/services/identity/oidc.ts` (`:200-231` allowlist, `:904-908`, `:1466`, `:1499`), `packages/worker/src/services/identity/idToken.ts`, `keyvault.ts` (sealed secrets).

## Scope

**In:**

- Google (OIDC), Apple (Services ID, ES256 `client_secret` minted from the sealed `.p8`, `response_mode=form_post` with flow state found by `state` server-side, first-consent name captured for the interstitial, server-to-server notifications unlinking or flagging the link) and Steam (OpenID 2.0, persona name and avatar through the Web API key) as platform clients.
- OIDC discovery with SSRF checks on every discovered URL and an allowlist; RFC 9207 `iss`.
- Per-provider audience enforcement (`aud`, `azp`), failing closed when unset.
- Each provider's verified identity handed to `signIn(verifiedIdentity)` with the provider email and whether it was verified, for I-07's interstitial.

**Out** (and where it belongs instead):

- The login card itself and the interstitial (→ I-07).
- Native Apple and Google ID tokens inside developers' apps (→ I-13); game platforms (→ I-14).
- Product-owned IdPs (→ I-22, layer 2).

## Design notes

- A token minted for a developer's bundle id must never be accepted as a login-card sign-in, and the reverse ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 2).
- Entra-style `email` claims are never trusted as verified; only a provider-asserted verified email skips I-07's code.
- Apple's private-relay addresses receive mail only from registered sender domains; coordinate with I-18.
- No Discord (owner). Microsoft/Xbox only if that storefront becomes real.
- These are account sign-in methods, platform-level and never behind a product's `identity` toggle (owner, 2026-10-04): the portal and the Library use them for every product.
- Upstream ID tokens are consumed once and never stored; no upstream access or refresh tokens are kept ([S-16 §5.5](../../notes/S-16-identity-service.md#55-privacy)).

## Steps

1. Platform client configuration and sealed secrets.
2. Google and Apple with fixtures; Steam OpenID 2.0.
3. Discovery gates, RFC 9207 and audience tests.

## Acceptance criteria

- [ ] Each provider signs in against recorded fixtures and yields a verified identity with the provider email and its verified flag (tests).
- [ ] A token for another audience is refused for every provider (tests).
- [ ] A discovered URL pointing at a private or disallowed host is refused (test).
- [ ] Apple's `form_post` flow works without a Lax cookie (test).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity oidc apple steam
```

## Hand-off

- I-07 puts these providers on the card and runs the interstitial on their first sign-in.
- I-13 adds the native (tenant-scoped) Apple and Google audiences.

The role agent sets `--set I-06 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-06 done`.
