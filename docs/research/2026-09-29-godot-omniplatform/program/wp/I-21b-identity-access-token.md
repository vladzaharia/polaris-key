# I-21b `identity.accessToken()`: the device-token exchange in client-core and the six SDKs

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | I                                                                                          |
| Size        | 0.4–0.6 engineer-weeks                                                                     |
| Depends on  | [I-21](I-21-product-issuer.md), [I-20](I-20-layer-2-plan.md)                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-68](SP-68-requiresignin-accepts-i21-tokens.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                       |
| Plan mode   | no                                                                                         |
| Gates       | all-sdks, parity, drift-gate                                                               |
| Human input | none                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Goal

`identity.accessToken()` in client-core and the Node, React, Python, Swift, Kotlin and Godot SDKs: an app exchanges its device token for a 600 s RS256 `at+jwt` that its own backend verifies against the product issuer's JWKS. Own-client `openid` stays `invalid_scope`. Slices I-21b.1-3 (client-core with Node and React; Python and Swift; Kotlin and Godot) are in [`plans/I-20.md`](../plans/I-20.md) §7 and §11.

## Why

I-21 ships the Worker side of the device-token exchange (I-21.13). This package is the client half; SP-68 verifies the result in the server drop-ins. An I-21b SDK on a Worker without the exchange fails with a typed error (plan §10).

## Read first

- `AGENTS.md` (always).
- `plans/I-20.md` §3.3, §3.4, §4, §7, §10, §11
- `conformance/parity/features.json`: the `identity.accessToken` row (devices, proof `transcript`, wp I-21b)

## Acceptance criteria

- [ ] `identity.accessToken()` exists in client-core and all six SDKs, with the `identity-access-token.json` transcript replayed in each.
- [ ] The parity row `identity.accessToken` is `implemented` everywhere it applies; `pnpm gen parity --check` is clean.
- [ ] No verifier is added to client-core: it only builds the request.

## Hand-off

The role agent sets `--set I-21b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-21b done`.
