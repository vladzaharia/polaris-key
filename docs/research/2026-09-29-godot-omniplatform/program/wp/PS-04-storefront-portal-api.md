# PS-04 Portal API for the storefront: additive `GET /api/discover`, `GET /api/discover/<p>`, claim by path through `issueFromPath`, `library_entries`, `DELETE /api/library/<p>`, `storefront_daily` analytics

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PS: Polaris Key storefront: the Library as a distribution channel (S-21) (phase 2: engine and portal)                           |
| Size        | 1–1.5 engineer-weeks                                                                                                            |
| Depends on  | [PS-03](PS-03-obtain-path-engine.md)                                                                                            |
| Unblocks    | [PS-05](PS-05-storefront-portal-ui.md), [PS-06](PS-06-console-polaris-key-storefront.md), [CM-05](CM-05-checkout-fulfilment.md) |
| Role        | `pkey-implementer`                                                                                                              |
| Plan mode   | no                                                                                                                              |
| Gates       | rule 10 (OpenAPI and `routeCoverage`); migration; table owners; THREAT-MODEL; workerd                                           |
| Human input | none                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## Goal

The portal API serves the storefront: offers with all their paths, a storefront product page that answers only for visible products, a claim that takes a path and issues through one function, library entries for products that need no licence, and daily aggregate analytics.

## Why

[S-21 §6.4](../../notes/S-21-polaris-storefront.md#64-add-to-library-ps-04) and §6.7 define what Add creates and the additive API; §6.6 defines the analytics.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-21](../../notes/S-21-polaris-storefront.md): the owner-decisions block (it wins over the sections below it) and the sections in this brief's refs.
- `services/identity/portal/{api,discover,library}.ts`, `accounts/claim.ts` (`attachLicense`), `oidc.ts` (`activateFromIdentity`).
- `packages/worker/openapi/polaris-key.v3.yaml`, `test/routeCoverage.test.ts`.
- THREAT-MODEL "Discover: free offers and Add to library (PX-W10)".

## Scope

**In:**

- `GET /api/discover`: per offer add `paths[]`, `cta`, `shortDescription`; `reason` and `offer` stay the first path.
- `GET /api/discover/<p>`: listing (description, screenshots, platforms), paths with terms; `404 not_found` for anything not visible.
- `POST /api/discover/<p>/claim` with optional `{path}`; `issueFromPath(path, account)` is the only issuance function.
- Migration: `library_entries` (S-21 §6.4 DDL) and `storefront_daily`, `storefront_seen` (S-21 §6.6); owners: identity.
  Remove `listLibraryEntryProducts`' no-such-table catch once this migration lands.
- `libraryView` unions entries (`kind: "entry"`); `DELETE /api/library/<p>` removes an entry only; account deletion deletes entries.
- Impression counting on `GET /api/discover` and the product page; add counting on claim; activation counting when a device first binds to a licence whose audit source is `discover`.

**Out** (and where it belongs instead):

- UI (→ PS-05). Console analytics (→ PS-06).

## Design notes

- Claim answers `409 not_eligible` identically for every invisible case and charges `portalClaimKey` before any lookup.
- Never mint a second licence for a held product (the I-26 rule); never bind a device.
- `storefront_seen.account_key = HMAC(daily salt, account_id)`; delete rows older than two days.

## Corrections (PS-04 builder, verified against the code)

- **Migration name.** `packages/worker/migrations/0096_storefront_library.sql` (all three tables;
  the lead's number). `LATEST_MIGRATION` and the data-model page follow it.
- **`DELETE /api/library/<p>` never reaches a licence.** It deletes `library_entries` rows only and
  answers `404` for a product with no entry, so LX-26's `detachLicense` (and its auto-attach block)
  is not on its path: a licence leaves the library only by that detach, unchanged.
- **`GET /api/products/<p>` answers for an entry too** (`kind: "entry"`, `licenses: []`): S-21 §6.5
  sends the person to `#/p/:product` after Add, which reads this route. Licence items and views
  gain `kind: "license"`. An entry reads `status: "active"`, `license: null`, `licenseCount: 0`.
- **Additive fields beyond the brief's three:** `stores` (S-21 §6.3 names `stores[]`: a link
  offer's live store pages, every live store page on the product page) and a `label` on each path
  (the operator's group label, S-21 D10; own properties only).
- **Screenshots need a media slot.** HA-07 (the media host) is `todo`, so the product page serves
  screenshots through the existing `/media/<p>/<asset>` proxy, which gains `screenshot-<n>` (n below
  16, 5 MiB, same allowlist and rules). No new route.
- **The product page has its own budget** (`portalStorefrontPage`, 60 a minute per account, before
  any lookup), so probing it is bounded like the claim.
- **Activation counting** needs a seam Core did not have: `core/authorizationListeners.ts`, a
  listener registry `authorizeDevice` notifies after a new authorization (total, `waitUntil`).
  Identity's listener counts the first device on a licence whose `portal.discover.claim` row is at
  most seven days old (PS-06's "within 7 days"), on the ADD's day and path kind, once per licence
  (a marker row in the account's own `portal_audit`). The claim summary now carries
  `path: <kind>`.
- **`path_kind = 'link'`** counts impressions of audience-`everyone` links (no path to name).
- **Deletion and merge.** Account deletion deletes entries (the brief), a merge moves them to the
  survivor, and product deletion clears entries, `storefront_daily` and `storefront_seen`.
- **The shipped portal client is guarded.** PX-16's Discover tile reads `offer` as terms and the
  library model reads `license` on every item, so `packages/admin/src/portal/api.ts` filters open
  offers, links and entries out until PS-05 renders them (a few lines; no UI change). PS-05 removes
  the filter.

## Steps

1. Re-read the S-21 sections above; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PS-04:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the gates in the header; set `--set PS-04 in-review`.

## Acceptance criteria

- [x] Route coverage and OpenAPI updated; tests for each route, including the identical-answer cases.
- [x] Claim is idempotent (double submit) for every path kind, including `open`.
- [x] Library shows an entry for an open product and hides it once a licence exists.
- [x] Analytics tables hold no account id (test).
- [x] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.
      (GATE GREEN; the migration is 0096, the lead's number.)

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test portal routeCoverage
```

## Hand-off

PS-05 builds the UI on these routes; PS-06 reads `storefront_daily`. S-22 calls `issueFromPath` from a verified checkout event.

The role agent sets `--set PS-04 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PS-04 done`.
