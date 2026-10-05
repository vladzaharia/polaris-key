# PS-03 Obtain-path engine: dry-run `obtainPaths` beside Discover, the `open` path through `delivery().openAccess()`, listing modes and audience, Discover rebuilt on it byte-identical in `auto`

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 2: engine and portal)                                                |
| Size        | 1–1.5 engineer-weeks                                                                                                                                 |
| Depends on  | [PS-02](PS-02-storefront-listing-settings.md)                                                                                                        |
| Unblocks    | [PS-04](PS-04-storefront-portal-api.md), [PS-07](PS-07-store-owned-path.md), [PS-08](PS-08-product-idp-path.md), [PS-09](PS-09-email-domain-path.md) |
| Role        | `pkey-implementer`                                                                                                                                   |
| Plan mode   | no                                                                                                                                                   |
| Gates       | rule 6 (boundaries test); THREAT-MODEL (Discover); workerd                                                                                           |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

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

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-03:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-03 in-review`.

## Acceptance criteria

- [ ] The 21 existing Discover tests pass unchanged.
- [ ] The prototype table passes as a Worker unit test (same rows and expectations).
- [ ] Unknown, unlisted and ineligible products produce identical results everywhere the engine is used.
- [ ] `boundaries.test.ts` passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test portalDiscover obtain boundaries
```

## Hand-off

PS-04 serves the paths; PS-07–PS-09 add path kinds by adding a branch and a test row.

The role agent sets `--set PS-03 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-03 done`.
