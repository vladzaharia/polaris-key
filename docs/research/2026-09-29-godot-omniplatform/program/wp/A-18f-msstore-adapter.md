# A-18f Microsoft Store storefront adapter: MSI/EXE and classic submission APIs

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                         |
| Size        | 2–3 engineer-weeks                                                                                                                 |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md), [P5-04](P5-04-msstore-connector.md)                   |
| Unblocks    | none                                                                                                                               |
| Role        | `pkey-implementer`                                                                                                                 |
| Plan mode   | no                                                                                                                                 |
| Gates       | adapter conformance suite; hand-written operation list pinned by fetch date (docs-drift review trigger); THREAT-MODEL (rule table) |
| Human input | none to build (fakes); the Partner Center Entra application and seller id are already in A-16                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Goal

Microsoft Store is a registered `StorefrontAdapter` on the Worker plane, with its own write client
(P5-04 stays GET-only for polling). It covers both submission APIs, chosen by package type: the
MSI/EXE API (metadata modules, package by URL, assets create and commit, submit) and the classic
API (submission create, update, ZIP to SAS, commit; flights; rollout update, halt and finalize).

## Why

After the human bootstrap (name reservation, first submission and IARC), Microsoft's listing,
category, price tier and rollout are writable by API. Godot's Windows export is an EXE, so the
MSI/EXE API's package-by-URL can point at the release's own artifact with no upload
([S-15 §4.2](../../notes/S-15-storefront-provisioning.md#42-microsoft-store-worker-plane)).

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§4.2**, §6.2–§6.6, §8.4, §11
  (A-18f), owner decision 2.
- `connectors/msstore/{client,map,poll}.ts` (P5-04); A-16's platform credentials.
- A-18e as the most recent adapter: S-15 orders A-18f after A-18e for shared patterns. That is a
  preference, not a graph dependency.

## Scope

**In:**

- A write client: classic token (`resource=https://manage.devcenter.microsoft.com`) and MSI/EXE
  token (`scope=https://api.store.microsoft.com/.default` plus `X-Seller-Account-Id`).
- `rules/microsoftStore.ts`: a hand-written operation list from the two reference pages, pinned
  by fetch date and covered by a docs-drift review trigger (no machine-readable spec exists).
- MSI/EXE: `listings`, `properties` (privacy, website, support URLs; category), `availability`
  modules; `packages` by URL then `packages/commit`; `listings/assets/create` to SAS then commit;
  submit.
- Classic: submission create (copy of the last published), update, the asset ZIP to the SAS
  `fileUploadUrl`, commit, status with `certificationReports`; flights; package rollout update,
  halt and finalize; category; price tier (`pricing.priceId`, not Pricing Version 2).
- Natural keys (§6.3): reuse a `pendingApplicationSubmission` only if the ledger created it.
- Deep links: name reservation, first submission and IARC, MSIX Properties URLs, and the post-UI
  edit case.

**Out:**

- MSIX upload (`ci`, decision 2). Add-ons (P6-01 has no Microsoft row; they wait for a commerce
  extension). Console (→ A-18j).

## Design notes

- **Typed confirmation** (phrase: Microsoft's primary name) for submission `commit`,
  `finalizepackagerollout` and any `pricing` change.
- **Never:** all 5 `DELETE`s (submission, add-on, add-on submission, flight, flight submission).
  Partner Center users, payout and tax have no API.
- **"Never edit an API-created submission in the UI":** doing so makes it uncommittable by API and
  only deletable. The flow warns before handing off to Partner Center, and afterwards offers only
  a deep link, since deleting is denied.
- **CI caution:** `msstore publish` deletes the pending draft, so the CI allow-list (A-18h) must
  not run it while the ledger shows a Worker-staged draft.
- Replacing an asset set with an MSI/EXE `commit` is an update, not a deletion; plain confirm
  (§8.4).
- Budget: honour `Retry-After`, otherwise self-throttle. Redact certification report URLs in audit
  (they carry tokens).
- [U] for A-18k: whether Developer suffices instead of Manager; whether a redirecting
  `packageUrl` is accepted.

## Corrections from the code (A-18f, 2026-10-04)

Where the brief or S-15 and the code disagreed, the code won:

- **Adapter id `microsoft-store`, not `msstore`.** The conformance suite requires an adapter's id to
  equal its A-16 credential's store (`microsoft-store.partner-center` → `microsoft-store`) and every
  deep-link id to start with the store id, so S-15 §6.5's `msstore.properties` is
  `microsoft-store.properties`. The audit action segment stays `msstore`
  (`distribution.msstore.<op>`).
- **MSI/EXE metadata is written whole or patched.** The reference page (fetched 2026-10-04) has
  `PUT` and `PATCH /submission/v1/product/{id}/metadata`; per-module paths
  (`/metadata/{module}`) are reads only. The gate types a full-module `PUT` that carries
  `availability`, and a `PATCH` that names `availability.pricing` or `freeTrial`.
- **The JSON matcher gained a `map` shape** (`core/storefront/match/json.ts`): Microsoft keys
  listings by language and prices by market, which a fixed-key object cannot express.
- **Flight commit and flight finalize are typed too** (a flight submission goes to certification;
  finalize releases to the whole flight).
- **No route.** The steps are functions in `connectors/msstore/provision.ts`; the console that
  calls them is A-18j's.
- **Added [U] items for A-18k:** whether a classic `PUT` that omits `pricing` (or another
  top-level field) keeps its current value (the step omits `pricing` unless the price changes); the
  exact shape of the `listings/assets/create` answer (the step reads `primaryAssetUploadUrl`);
  whether MSI/EXE products answer the classic `GET applications/{id}` that supplies the
  `primaryName` phrase (if not, the typed confirmation refuses, never passes).

## Acceptance criteria

- [x] Every operation in the pinned list is allowed by a rule or denied with a reason.
- [x] The conformance suite passes for Microsoft, including the five denied `DELETE`s and typed
      commit, finalize and pricing.
- [x] P5-04's poller is unchanged and still GET-only.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront msstore
```

## Hand-off

A-18h reads the ledger to refuse `msstore publish` over a staged draft. A-18k verifies role,
`Retry-After` and the redirecting `packageUrl` live.

The role agent sets `--set A-18f in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18f done`.
