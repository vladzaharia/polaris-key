# F-21 Registry auth: tokens, the per-feed access-mode switch, console and portal token UI

| Field       | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-2)                                                                |
| Size        | 2–3 engineer-weeks                                                                                     |
| Depends on  | [F-20](F-20-registry-credentials-plan.md), [F-11](F-11-console-feeds.md)                               |
| Unblocks    | [F-22](F-22-native-publish.md), [F-23](F-23-docker-push.md)                                            |
| Role        | `pkey-implementer`                                                                                     |
| Plan mode   | no separate plan: executes the approved `plans/F-20.md`                                                |
| Gates       | D1 migration and `TABLE_OWNERS` (registry tokens); THREAT-MODEL; rule 10 (`/v2/token`, Swift `/login`) |
| Human input | none                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                              |

## Goal

Feeds can be switched to `authenticated`, `licensed` or `entitled` from their Settings, and
clients authenticate with `pkeyr_` tokens minted in the console or the portal, as `plans/F-20.md`
specifies. No route, renderer or stored document changes.

## Why

This is the "auth later" half of the owner's access decision ([S-12 §7](../../notes/S-12-package-feeds.md#7-access-public-now-auth-as-configuration)).

## Read first

- `plans/F-20.md`; [`plans/F-01.md`](../plans/F-01.md) §6.6.

## Scope

**In:**

- Tokens and their table.
- `feedPrincipal` token parsing.
- The access-mode switch enabled in F-11's Settings.
- Console and portal token pages.
- `/v2/token`, Swift `/login` and the Cargo flag.
- Snippets with credentials (F-12's renderer).

**Out:**

- Native publish (→ F-22, F-23).

## Design notes

- Non-public answers stay `private, no-store` and outside the Cache API.

## Steps

1. Follow `plans/F-20.md`'s step order.

## Acceptance criteria

- [ ] Each tier-1 client matrix also passes against an `authenticated` feed with a token.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry auth routeCoverage
```

## Corrections (implementation, 2026-10-04)

Where the code disagreed with the brief or the plan, the code was the fact:

- **F-12 has not landed**, so there is no `renderFeedSetup` in `@polaris-key/manifest` to extend.
  The credential argument (`none | env | token | godot-url`) went into the console's interim
  renderer, `admin/src/console/areas/feeds/model.ts` `setupSnippets`, which F-12 moves into the
  manifest package keeping the argument. `pkey feeds setup --token-env` goes to F-12, as
  `plans/F-20.md` §5 says for this case.
- **No Cargo feed exists** (tier 3, F-30): the "Cargo flag" (`auth-required`, the `Cargo`
  challenge) has nothing to attach to and stays F-30's.
- **`feedPrincipal(req)` was removed**, not extended: resolution needs D1, so
  `authorizeFeedRead(ctx, credential, …)` takes the extracted credential and resolves it lazily at
  step 5 (`plans/F-20.md` §6.2's **[change]**). The principal type and the store live in Core
  (`core/registryVocabulary.ts`, `core/registryTokens.ts`).
- **Swift's login is a route, not a dispatcher answer.** `RegistryRoute.methods` and a second route
  mark (`FEED_AUTH_ROUTE`, built by `feedAuthRoute`) admit exactly `swift.login`; the structural
  test admits read routes and this one credential route. `/v2/token` is an
  `OwnerlessRegistryRoute` passed to `dispatchRegistryHost` beside `REGISTRY_ROUTES`
  (`mount.ts` `REGISTRY_OWNERLESS_ROUTES`).
- **A raw `pkeyr_` token is accepted as Bearer on the OCI routes** as well as through the pull
  token (one extractor for every route); the plan's pull-token path is what docker, podman,
  crane and oras use.
- **Cascades.** No licence-delete path and no portal link-removal path exist (`syncAccountLicenseLinks`
  only adds links), so those two plan-named cascades have nothing to hook; a disabled licence
  stops its tokens through `licenseUsable`. Account erasure (`account_deleted`) and product
  deletion (`product_deleted`, beside the lookup's status join) revoke in their own batches.
- **The portal "Package access" card** is PORTAL.md's, built in the portal waves; F-21 ships its
  API (`GET|POST /portal/api/licenses/:product/:licenseId/registry-tokens`,
  `DELETE …/:tokenId`), whose `GET` answers `available`, the private feeds with their base URLs
  (through Distribution's `delivery.packageFeed` hook, which gains `accessMode` and `baseUrl`),
  the tokens, the username and the limits.
- **The licence page's Registry tokens panel** sits on the licence's Keys tab (shown while the
  product's package feeds are on).
- **SwiftPM sends registry credentials only over HTTPS** (measured with SwiftPM 6.4: no token or
  basic credential, from netrc or `registries.json`, reaches an `http://` registry). The
  registry-clients harness is plain HTTP on loopback, so in `--auth` runs SwiftPM resolution runs
  against public feeds only; the authenticated Swift feed is checked over HTTP (login 200/401,
  list and archive with and without the token), and SwiftPM's own authenticated resolution is to
  be verified against `pkg-staging` over HTTPS after the deploy. The swiftlang compatibility
  suite has no credential option and runs against public feeds only.
- The migration is `0063_registry_tokens.sql` (the next free number after main's `0062_store_operations_plane.sql`), and `LATEST_MIGRATION`
  follows.

## Hand-off

- F-22 and F-23 use `publish`-scoped tokens.

The role agent sets `--set F-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-21 done`.
