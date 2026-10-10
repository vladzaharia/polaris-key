# SP-55 `@polaris-key/server`: the Fetch core, Express, Hono and Next.js, `/testing`, their example apps

| Field       | Value                                                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                                                                             |
| Size        | 1.6–2.2 engineer-weeks                                                                                                                                                                                                                                                                                                       |
| Depends on  | [SP-53](SP-53-backend-credential-contract.md), [SP-54](SP-54-signed-in-subject-in-licence-document.md)                                                                                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-60](SP-60-node-server-fastify-nestjs-koa.md), [SP-64](SP-64-framework-drop-ins-integration-and-docs.md), [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md), [SP-67](SP-67-developer-webhooks-delivery-and-adapters.md), [SP-68](SP-68-requiresignin-accepts-i21-tokens.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                           |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                           |
| Gates       | `drift-gate`                                                                                                                                                                                                                                                                                                                 |
| Human input | none                                                                                                                                                                                                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                    |

## Plan follow-through (2026-10-09)

Approved [`plans/SP-53.md`](../plans/SP-53.md) and [`plans/SP-54.md`](../plans/SP-54.md) (2026-10-09) bear on this package; where they differ from the text below, they win.

- **Dependency.** Depends on SP-53 (the verdict, `backend-matrix.json`) and now also on SP-54: `requireSignIn()` reads `profile.user.subject` through TypeScript `licenseUserOf` from client-core, and replays `licenseUserCases` plus the `verdict` rows.
- **Corrections.** The privacy file is `docs/PRIVACY.md`; there are eight locales, not nine (`en`, `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`); `tools/gen-sdk-constants.test.ts` pins the `sdkId` list, which already holds this package's `<lang>-server` value after SP-53.
- **Sequencing.** SP-53 merges first, then SP-54 rebases, swaps SP-53's private subject decoder for `licenseUserOf` and runs the one batched `pnpm gen corpus` after UK-03. This package builds on the integrated tree and regenerates nothing.

## Goal

`@polaris-key/server`: the Fetch core, Express, Hono and Next.js, `/testing`, their example apps, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-55.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-55).

## Scope

**In:** One new package `@polaris-key/server` whose root is the Fetch core (`authenticate(request)`), with the subpaths `./express`, `./hono`, `./next` (App Router route handlers) and `./testing`, each on an optional peer dependency; it depends on `client-core`, `jws` and `protocol` only. `requireLicense`, `requireEntitlement(n)`, `requireSignIn()`, `polarisKey()`, the trust-manifest fetch and LRU cache of §5.1, the `PolarisAuth` context, `onRefusal`/`errors: "throw"`/`onVerdict`, and `POLARIS_REQUEST_HEADERS`. Replays `backend-matrix.json` `verdict` and `problem`. `examples/server-express`, `-hono`, `-next`. In 0.9 `verifyLicenseDocument` moves here from `@polaris-key/node/server` with a `replaces` row and no alias; `examples/node-express` is rewritten on the drop-in. The package joins `publish-sdks.yml`'s npm tiers and the feed-closure check (P0-52's lockstep set).

**Out** (and where it belongs instead):

- Fastify, NestJS, Koa (→ SP-60); Python (→ SP-56); Kotlin (→ SP-57); Swift/Vapor (→ SP-62); the client half (→ SP-58).

## Design notes

- `@polaris-key/node` needs Node ≥ 22.13; Hono, Bun and Deno users live in `@polaris-key/server`, not `@polaris-key/node` (§8).
- Next.js is header-only in v1 (route handlers); a cookie mode can follow after SP-40 (decision 9).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] A gated Express, Hono and Next.js route answers each §5.2 verdict with the right status and `problem+json` body.
- [ ] The trust manifest refreshes on the §5.1 schedule, an unknown `kid` fetches at most once per 60 s, and a Polaris Key outage never refuses a pinned-key document.
- [ ] No secret (the header, the JWS, the holder's name or email) appears in a log line or `toJSON`.
- [ ] `verifyLicenseDocument` is gone from `@polaris-key/node/server` with its `replaces` row (no alias).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-55 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-55 done`.
