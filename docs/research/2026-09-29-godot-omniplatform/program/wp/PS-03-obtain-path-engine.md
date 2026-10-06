# PS-03 Obtain-path engine: dry-run `obtainPaths` beside Discover, the `open` path through `delivery().openAccess()`, listing modes and audience, Discover rebuilt on it byte-identical in `auto`

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 2: engine and portal)                                                                                    |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                     |
| Depends on  | [PS-02](PS-02-storefront-listing-settings.md)                                                                                                                                            |
| Unblocks    | [PS-04](PS-04-storefront-portal-api.md), [PS-07](PS-07-store-owned-path.md), [PS-08](PS-08-product-idp-path.md), [PS-09](PS-09-email-domain-path.md), [CM-04](CM-04-offers-catalogue.md) |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | rule 6 (boundaries test); THREAT-MODEL (Discover); workerd                                                                                                                               |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

One dry-run function, `obtainPaths(account, product)`, answers whether and how a signed-in person can add a product now, Discover is rebuilt on it with byte-identical results in `auto` mode, the `open` path works, and the no-enumeration table from the S-21 prototype passes as a unit test.

## Why

Discover evaluates only sign-in auto-issue and the platform group map. The owner wants anything the person could obtain and use to appear ([S-21 §6.3](../../notes/S-21-polaris-storefront.md#63-the-eligibility-engine-obtain-paths-ps-03), D4, D5).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `packages/worker/src/services/identity/portal/discover.ts`, `portal/repo.ts` (`listDiscoverCandidates`, `listHeldProducts`, `AUTO_LINK_ENABLED_SQL`), `services/identity/oidc.ts` (`identityTier`, `previewIdentityIssue`).
- `packages/worker/src/core/hooks.ts` (`DescriptorHooks`, `Delivery`, `hookProvider`); `services/distribution/access.ts` (`accessModeOf`).
- `docs/research/2026-09-29-godot-omniplatform/prototype/polaris-storefront/obtain.mjs` (the acceptance table).
- `packages/worker/test/portalDiscover.test.ts` (21 tests, the baseline).

## Scope

**In:**

- `services/identity/portal/store/obtain.ts`: `ObtainPathKind`, `ObtainPath` (S-21 §6.3, with `action: "add" | "link"`), `obtainPaths`, `storefrontOffers`, the evaluation order and the listing modes and audience.
- Paths in this package: `group`, `auto_issue` (unchanged policy through `identityTier`) and `open`.
- `Delivery` gains `openAccess(): Promise<boolean>` (true when every deliverable is `public` or `authenticated`), implemented by Distribution.
- `discoverOffers` and `discoverCount` become thin wrappers; candidates exclude held products and `library_entries` (once PS-04 adds the table, read it if present).
- Unit tests: the prototype's table ported; dry run against the refusing database; `auto` results identical to the pre-change suite.

**Out** (and where it belongs instead):

- The routes and `library_entries` (→ PS-04). `store_owned` (→ PS-07), `product_idp` (→ PS-08), `email_domain` (→ PS-09).

## Design notes

- Keep the platform-issuer and auto-link predicate on identity paths (R5-01, R5-02).
- No multi-provider hook: every method used has one provider (`hookProvider`).
- Reason codes: `free_with_account`, `group:<g>`, `open`; trials keep their path and the copy derives from `expiryDays`.
- Commerce seam (S-21 §6.10): `action` is a union S-22 extends; do not add `buy` now.

### Corrections from the code (PS-03 implementation, 2026-10-06)

Recorded under step 1; the code is the fact. Each was decided on the recommended option (decisions
delegated to the lead).

- **The Discover baseline is 22 tests, not 21.** PS-02 added "auto and listed keep today's offers;
  unlisted hides them, from either column". All 22 pass unchanged.
- **`storefront.polarisKey.enabled` is read here.** PS-02 registered it `pending: PS-03` ("PS-03's
  candidate query is the first reader"). `core/storefrontSwitch.ts` reads the `platform_settings`
  row under the registry key itself (scalar storage, no A-13 alias): no row or a tombstone is the
  default `on`, `"off"` is off, and any other value or an unreadable store is off (fail-safe, as an
  A-13 kill switch). It is not an A-13 key, so ST-05's generic API is its writer. The entry is no
  longer pending; `pnpm gen:settings` regenerated the reference page and the console index (the
  index has no console consumer yet).
- **At most one identity path per product.** `identityTier` returns one grant (the first mapped
  group, else the `oidcDefault` rule), and the claim mints exactly that. A group member of a product
  that also auto-issues therefore gets `[group]`, not the prototype's `[group, auto_issue]`: an
  `auto_issue` path would promise the default tier, which the claim would never mint. The
  prototype's check (the group path first, with the group's tier) passes unchanged.
- **`open` with Distribution off.** S-21 §6.3 keeps the path "unless the licence service is off and
  the product has a website". The website lives only in Distribution's listing
  (`delivery().listing()`), so with Distribution off there is no website and no `open` path.
- **`openAccess()` is fail-closed and gate-aware.** It is true only when the product has an `app`
  row and every `dist_access` row is `public` or `authenticated` **with no `entitlement` gate**: a
  gated pack needs a licence flag whatever its mode says (P4-02). It is a required `Delivery`
  method; Distribution is its only provider.
- **Discover's wrappers serve the identity paths only, until PS-04.** `GET /api/discover`'s `offer`
  is the licence terms, which the portal's `PortalDiscoverTerms` expects non-null, and the claim can
  only mint through `activateFromIdentity`. So `discoverOffers`, `discoverCount` and the claim run
  the engine with no other source and no link-only listings. `storefrontOffers` and `obtainPaths`
  evaluate `open` and audience `everyone`; PS-04 serves them with the claim by path. The claim is
  rebuilt on the engine too (`evaluateObtain`), so `offerPaths`, the switch and the listing modes
  apply to the listing, the count and the claim alike.
- **Candidates.** `listDiscoverCandidates` became `listStorefrontCandidates`: it no longer filters
  on the platform issuer and auto-link predicate. That predicate rides along per row
  (`identity_eligible`) and gates the identity paths only, unchanged (R5-01/R5-02).
- **`auto` counts the identity kinds only** (D3: "`listed` adds every other obtain path"), and
  `offerPaths` narrows every mode, as in the prototype.
- **Link targets for audience `everyone`** are the listing's website or a store page from
  `delivery().customerDownloads({channel: "stable"}).stores` (S-21 §6.1's `stores[]`). No new hook
  method was needed.
- **`library_entries` is read if present.** Only D1's "no such table: library_entries" reads as an
  empty library; any other error throws. PS-04's migration makes the read live with no code change.
- **The prototype table's later kinds.** `store_owned`, `product_idp` and `email_domain` run as
  stand-in `PathSource`s in `test/obtainPaths.test.ts`, each the prototype's rule over the
  prototype's fixture, so the table runs whole on the real engine. PS-07 to PS-09 replace their
  stand-in with the real source in `STOREFRONT_SOURCES` and keep the row.
- **`OBTAIN_PATH_KINDS` is not the evaluation order.** Its comment in
  `core/storefront/polarisKeyListing.ts` said it was. It is the build and storage order; the engine
  evaluates in `OBTAIN_PATH_ORDER`. Only the comment changed (the settings enum and stored lists
  keep their order).
- **The first-party `status` port** (`core/storefront/firstParty.ts`: "offers visible today (PS-03,
  PS-06)") has no implementation of any port yet. PS-06 wires the ports; the engine is ready for it.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-03:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-03 in-review`.

## Acceptance criteria

- [x] The 21 existing Discover tests pass unchanged (22 on main since PS-02; all pass, the file is
      untouched).
- [x] The prototype table passes as a Worker unit test (same rows and expectations):
      `test/obtainPaths.test.ts`, "the prototype's acceptance table".
- [x] Unknown, unlisted and ineligible products produce identical results everywhere the engine is
      used: one frozen `{ visible: false }` from `obtainPaths`, absent from `storefrontOffers`,
      `discoverOffers` and the count, one `409 not_eligible` body from the claim.
- [x] `boundaries.test.ts` passes.
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header
      (`/Users/vlad/Repos/pk-wt/_lead/gate.sh`, GATE GREEN, scope changed; workerd typecheck and
      smoke included; `pnpm gen:settings -- --check` up to date).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test portalDiscover obtain boundaries
```

## Hand-off

PS-04 serves the paths; PS-07–PS-09 add path kinds by adding a branch and a test row.

The role agent sets `--set PS-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-03 done`.
