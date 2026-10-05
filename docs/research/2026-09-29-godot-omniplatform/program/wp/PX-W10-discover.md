# PX-W10 Discover (G24, G25): dry-run evaluation of the auto-issue policy, listing, claim through the auto-issue path, `discover` opt-out per product

| Field       | Value                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                             |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                              |
| Depends on  | [PX-W1](PX-W1-library-api-media.md)                                                                                                                                 |
| Unblocks    | [PX-16](PX-16-discover-page.md)                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                  |
| Gates       | the PORTAL.md §11 green gate; rule 6 (Core descriptor hooks; no cross-service imports); rule 10 (OpenAPI + `routeCoverage`); `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                           |

## Goal

`GET /api/discover` lists products whose policy would auto-issue to this account, evaluated by the same policy function as first-load auto-issue in dry-run mode (no rows written), with presentation, terms and a `reason`; `POST /api/discover/:product/claim` re-evaluates and mints through the auto-issue path, idempotent per account and product, with `409 not_eligible` when the offer changed; products can opt out with `discover: false`.

## Why

Discover is the second nav item ([PORTAL.md §4.16](../../../../design/PORTAL.md#416-discover)); it needs no S-16 work ([PORTAL.md §11.4](../../../../design/PORTAL.md#114-order)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.16](../../../../design/PORTAL.md#416-discover), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `packages/worker/src/core/hooks.ts`
- the auto-issue policy in the License service

## Scope

**In:**

- Dry-run policy evaluation through a Core hook; listing; claim; per-product `discover` opt-out.
- Audit `source: discover`; rate limit in the `_portal` buckets shared with preview and add.

**Out** (and where it belongs instead):

- UI (→ PX-16)

## Design notes

- **Rule 6:** Identity (where the portal lives) may not import Distribution, Update or License internals; reach them through descriptor hooks in `packages/worker/src/core/hooks.ts` (PORTAL.md §10.2 notes).
- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- Reasons are always shown (owner decision Q-6); a product cannot hide the reason line.
- **Overlap with the re-cut S-16/S-17 graph:** I-11 also names Discover (Add to library). PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).

## Corrections (verified against the code, PX-W10)

- **The policy is Identity's, not License's, so there is no Core hook.** "First-load auto-issue"
  for an account is the product sign-in's: `activateFromIdentity` in
  `packages/worker/src/services/identity/oidc.ts`, deciding with `identityTier` (the product's
  `groupRoleMap`, else its `oidcDefault` auto-issue rule). It lives in the same service as the
  portal, so Discover calls it directly: `previewIdentityIssue` (the same `identityTier` plus the
  read-only provisioning step, nothing written) to list, `activateFromIdentity` itself to claim.
  Tiers, licences and seats come from Core (`core/data.ts`, `core/authz.ts`); presentation and
  platforms through the descriptor hooks, so rule 6 holds without a new hook. License's own
  auto-issue (`POST /<p>/license/enroll`, mode `anonymous`) is per machine, keyed by a hardware id,
  and is never an account's offer.
- **The account's identity is its platform-IdP subject.** The portal kept no `groups` claim, so
  migration `0068_portal_discover.sql` adds `portal_account_identities.groups_json` (written at
  each portal OIDC sign-in) next to the opt-out column `portal_product_settings.discover_enabled`
  (default 1; console **Identity → Portal → Offer on Discover**; admin `PATCH` field
  `discoverEnabled`). The opt-out is a portal setting rather than a `.pkey/` manifest key, so rule 9
  does not apply. Candidates are restricted to platform-issuer products with auto-linking on (the
  link sweep's R5-01/R5-02 predicate). An account that has only ever signed in by email link has
  no platform subject and is offered nothing until S-16 (I-05/I-06) attaches licences to accounts.
- **Reasons the policy can produce today:** `free_with_account` and `group:<group>`. No
  email-domain or beta rule exists in the code; those reasons arrive with the policies that grant
  them (I-11 / a later policy WP).
- **Rule 10 as built:** PX-W1 pinned its portal routes in OpenAPI and `PORTAL_KIND_PATHS`, so both
  Discover routes are in `polaris-key.v3.yaml` and `routeCoverage`, and on the docs site's portal
  page. `not_eligible` is a new `errors.json` entry (constants regenerated, as PX-W5 did).
- `GET /api/library` gains `discoverCount` for the nav (§10.2 notes, "one library call").

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W10:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W10 in-review`.

## Acceptance criteria

- [x] A test proves listing writes nothing.
- [x] A parity test proves Discover claim ≡ first-load auto-issue (tier, limits, entitlements).
- [x] Claim is idempotent (double-submit test); OpenAPI and `routeCoverage` cover both routes.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

PX-16 builds the Discover page; PX-08 shows the count.

The role agent sets `--set PX-W10 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W10 done`.
