# PX-W17 plan: Identity as a per-product service (G34)

## Owner decisions (2026-10-05)

**Approved; every recommendation in "Open questions for the owner" accepted as written.** The
owner approved nine plans together (U-01, PX-W3, LX-01, I-24, I-09, PX-W8, PX-W9, PX-W13 and
PX-W17). These cross-plan overrides win over any text below that says otherwise:

- **Refusal link name.** `manageUrl` on **both** `device_limit` and `key_entry_limit`. PX-W8 Q1
  wins over PX-W9 Q3's `portalUrl`. `license_owned` keeps `signInUrl`. Portal paths are root
  paths, per PX-W8's corrections: `/activate?product=<slug>` and `/signin?product=<slug>`, never
  `/portal/activate` or `/portal/signin`. PX-W9, I-09, `plans/I-04.md` and their briefs are
  corrected to match.
- **Reserved display names** (PX-W13 Q4). Warn first, following LX-05 and S-19 (§7.4, decision
  15), then enforce in PX-W13. The rule is not a hard error from day one.
- **I-24** is split into **I-24a** and **I-24b** in `workpackages.json`, with the dependencies I-08
  and I-09 added. **I-09** gains the **ST-04** dependency (I-09 Q3).
- **Brief changes.** Every "Brief changes" list in the nine plans is applied to the named briefs,
  each under a section "Amendments from approved plans (2026-10-05)".
- **Superseded drafts.** The branches `wp/U-01-cloud-sync-plan` and
  `wp/PX-W3-licensed-downloads-plan` are superseded by `plans/U-01.md` and `plans/PX-W3.md` and
  must not be merged.

**Effect on this plan.** The `identity_disabled` redirect targets the root path
`/signin?product=<slug>&error=identity_disabled` (corrected in place). Q3 to Q5 correct PORTAL.md
§3.1 and G34. The correction is recorded in PORTAL.md's amendment block.

> **Approved by the owner (2026-10-05)**; see "Owner decisions (2026-10-05)" above. As first written: It executes
> the approved [`plans/I-04.md`](I-04.md) (§2.1 toggle matrix, §6.2 Core accessors) and fills
> only the gaps PORTAL.md G34 names that I-04, I-05, I-08 and I-09 leave open. The owner decisions
> of S-16, S-17, S-18 and S-19 are taken as given (§0). The questions the research left open are
> under "Open questions for the owner", each with a recommendation.

| Field        | Value                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief        | [`wp/PX-W17-identity-per-product.md`](../wp/PX-W17-identity-per-product.md); spec [PORTAL.md §3.1, §10.2 G34](../../../../design/PORTAL.md#31-model); research S-16, S-17, S-18, S-19 (`notes/`)                                                                                                                     |
| Implementers | **PX-W17** executes §2–§6. **I-10a** (Node, React, Python) and **I-10b** (Swift, Kotlin, Godot) execute §5. I-08, I-11, I-21, PX-14, LX-09, LX-13, ST-05 and U-04 build to the names in §2 and §6                                                                                                                    |
| Wire change  | Inside wire v4. **`PROTOCOL_VERSION` stays 4**, `corpusVersion` unchanged. No new `typ`, claim or signed shape; nothing here enters the licence document. Adds one wire error code that only human-facing pages emit, one `303` on navigations and two admin response members. Device JSON routes keep their answers |
| Corpus       | **None.** Evidence is one new transcript, one parity row, one guard test and UI-kit snapshots                                                                                                                                                                                                                        |
| Line refs    | `main` at `8c28e023`. Re-locate by quoted text after a rebase                                                                                                                                                                                                                                                        |

## 0. Owner decisions encoded (binding, 2026-10-04)

- **S-16 / I-04.** One account per person, platform-level and never a per-product toggle. The
  `identity` toggle gates only sign-in _through the product_ (I-04 §2.1). With Identity off the
  Identity routes answer `404 not_found` (the registry contract), discovery's fragment stays
  `{enabled:false}`, and key entry is unlimited and uncounted. D22 (no silent SSO), D21 (merge
  aliases) and the rule that the global account id never leaves Identity and Core all hold.
- **S-17.** Cloud Sync declares `requires: [config, identity]`. Its principal is `devices.subject`
  only, with no fallback to the licence owner.
- **S-18.** Settings are registry rows. The toggle is the claimable `core.services` entry
  (`products.services_json` and `services_source`, S-18 A.2). Model C applies: a console edit
  claims the field and Revert returns it to the manifest. **No new settings table or column.**
- **S-19.** Model OC: a **licence is the access contract** and **grants** are entitlement
  reasons. The **holder** is `entitlementHolder: device`, which means the account signed in on the
  device or nobody. `licensing.entitlementModel: legacy` keeps documents **byte-identical**. S-19
  §7.3.1 also says that on products without Identity "no device is ever signed in" and grants are
  created licence-held.

## 1. Summary

- **The toggle already exists.** `services.identity` in `products.services_json` came with the P3
  identity carve (`core/services.ts`), and `dispatchService` already 404s every
  `/<p>/identity/*` route while it is off (`core/registry.ts:317`). G34's "Identity is implicit"
  is out of date (correction).
- **Human-facing refusal `identity_disabled`.** A browser navigation to an app-sign-in entry of an
  Identity-off product gets a `303` to the friendly card
  (`/signin?product=<slug>&error=identity_disabled`). The portal's passthrough context
  answers `403 identity_disabled`. Device and JSON callers keep `404 not_found` and
  `registration_closed`, unchanged.
- **Invariant for S-19's holder rule.** No device of an Identity-off product carries
  `devices.subject`. Turning Identity off clears every binding of the product (it never releases
  a seat), and Core refuses to write a binding while the toggle is off. LX-09's resolver can then
  trust `devices.subject` without reading the toggle.
- **Developer surfaces show pairwise ids only.** The admin licence view gains `ownerSubject` and
  the device views gain `subject`, both `ps_…` or `null`. A guard test proves no account id
  reaches any developer-facing response and that two products see two subjects for one account.
- **Order:** this plan → `errors.json` → Worker → transcript → Node, React, Python, Swift, Kotlin,
  Godot and the four UI kits.

## 2. Contract

**`WIRE-CONTRACT-V4.md`.** PX-W17 writes **§12.7 "A product with Identity off"**. If I-09 has not
yet opened §12, PX-W17 opens it with §12.1 (I-04's matrix) and §12.7. The section states five
rules:

1. Device and JSON routes under `/<p>/identity/*` answer `404 not_found`.
2. `POST /<p>/devices/register` keeps the single `registration_closed` body. This is the
   existing anti-reconnaissance rule (OpenAPI `register` description), so the JSON API never
   distinguishes "Identity off".
3. A **navigation** (`GET`/`HEAD` with `Sec-Fetch-Mode: navigate`, or an `Accept` header that
   lists `text/html`) to one of the paths in `IDENTITY_NAVIGATION_ENTRIES` answers
   `303 Location: <origin>/signin?product=<slug>&error=identity_disabled` with
   `Cache-Control: no-store`.
4. The portal's passthrough context answers the nested body
   `403 {"error":{"code":"identity_disabled"}}`.
5. Licences still attach to accounts (Activate License, Discover, verified email).

This reveals nothing new: discovery already publishes `identity: {enabled:false}` for any
existing product. An unknown product slug keeps today's 404.

**`IDENTITY_NAVIGATION_ENTRIES`** (exported from `core/identityGate.ts`): `authorize`,
`auth/start`, `auth/device` and `auth/device/verify`. I-21 appends `oauth/authorize` when the
issuer lands. This 303 is Core code that runs **before** dispatch, so the rule "a disabled
service's code never runs" still holds.

**`shared-protocol`.** `PolarisErrorCode` (`src/core.ts`) gains `identity_disabled`, and the
constant `IDENTITY_DISABLED_ERROR_PARAM = "identity_disabled"` goes in
`@polaris-key/protocol/identity`. I-09 creates that subpath; whichever package lands first
creates it and owns the `test/exports.test.ts` row. **`shared-jws` and `client-core` do not
change.** No signed shape moves, and `PolarisError.code` already accepts unknown strings.

**OpenAPI and rule 10.** The narrative of the four navigation entries gains the 303. The admin
schemas gain `ownerSubject` and `subject` (§6). `routeCoverage` gains no rows, because the paths
already exist or are I-08's.

**Clients and workers already deployed.**

- **Old SDKs** read discovery and never call Identity on an Identity-off product. If Identity is
  turned off mid-session, they get the same `404` they get today. Node and Python already map that
  to `service-unavailable`, and React maps it to `service-disabled`.
- **Old portal and card builds** show the generic not-found page instead of the card. That is
  wrong copy but loses no state.
- **An old Worker** behind a new SDK answers 404 everywhere, which is handled the same way.
- **Existing installs** keep their tokens, refresh, grace and documents.

## 3. Catalog and manifests

`shared-catalog` and `shared-manifest` **do not change**: no rule 9 entry, no schema change and no
mutation-table row. I-04 §3 already ships `identity_block_without_service` (a warning). The toggle
remains `services:` in `.pkey/product`, persisted to `core.services` (S-18).

## 4. Corpus, transcripts and parity

- **Signed corpus:** none. `pnpm gen:corpus -- --check` stays green with no change to any
  generator, constant or mirror. Subjects are never signed (I-04 §6.2, S-16 D9 read as a content
  rule).
- **Transcript `identity-disabled.json`** (PX-W17, scenario in
  `packages/worker/test/transcripts/scenarios/identity.ts`). The Swift and Godot mirrors are
  written by `pnpm gen:transcripts`. Steps:
  1. Discovery returns `identity: {enabled:false}`.
  2. `POST auth/device/start` returns `404 not_found`.
  3. `GET identity/subject` with a bearer token returns `404 not_found`.
  4. A navigation to `GET auth/device` returns the 303 with `error=identity_disabled`.
  5. The same path with `Accept: application/json` returns `404`.
  6. Key activation of a licence that has an `account_id` returns 200 with no `keyEntries`.
- **`errors.json`:** `identity_disabled` with `kind: wire`, HTTP 403, service `identity`. The
  description: "human-facing only: a sign-in through a product whose Identity service is off;
  device and JSON routes answer `not_found`". There is no new client code. SDKs reuse
  `service-unavailable`; React reuses `service-disabled`.
- **Parity row `identity.toggle`** (family `devices`, service `identity`, proof `transcript`
  `identity-disabled.json`, no `allowedNa`). It is added with `planned` entries in all six
  `parity.json` files (`wp: "I-10a"` or `"I-10b"`). The row `ui.kit.account` (I-04 §4) gains the
  snapshot state "Identity off".

## 5. SDKs and UI kits, in order

Each SDK must do four things:

1. Replay `identity-disabled.json`.
2. Pass `parity:check` and `gen:constants -- --check` (`identity_disabled` lands in every
   `constants.generated` file).
3. When discovery says Identity is off, fail every identity entry point (`signIn`, device code,
   `attach`, `subject`, `signOut`, `openAccount`, redirect) fast, with no network call. The error
   is `service-unavailable`, or `service-disabled` in React.
4. Map a mid-session `404` from an identity route to the same code, keeping the device token and
   licence state.

| #   | SDK and UI kit                                                    | WP    | Notes                                                                                                        |
| --- | ----------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| 1   | **Node** `packages/sdk-node`, over `client-core`                  | I-10a | Reference. Already gates on discovery (`identity/client.ts`); add the transcript and the mid-session mapping |
| 2   | **React** `packages/sdk-react`, plus the activation component     | I-10a | `service-disabled`. The component hides "Sign in", attach and account screens; snapshot                      |
| 3   | **Python** `sdks/python`                                          | I-10a | Extends `test_capabilities.py` / `test_supports.py`                                                          |
| 4   | **Swift** `sdks/swift` plus **`PolarisKeyUI`**                    | I-10b | Records current behaviour first (I-04 §2.7)                                                                  |
| 5   | **Kotlin** `sdks/kotlin` plus the **Kotlin activation component** | I-10b | Same                                                                                                         |
| 6   | **Godot** `sdks/godot` plus **`addons/polaris_key/ui`**           | I-10b | Same. `sdks/godot/tools/run_tests.sh`                                                                        |

No typed N/A applies: every runtime can observe a disabled service.

## 6. Worker

- **Gate (`core/identityGate.ts`).**
  - `identityEnabled(db, product)` reads `parseServices(products.services_json)`. It is the one
    place outside the registry that reads the toggle. LX-13 and LX-15 use it to create grants
    licence-held on Identity-off products (S-19 §7.3.1). I-08 and I-11 use it for the
    passthrough context and `/signin`.
  - `identityNavigationRedirect(req, product)` handles the 303 and is wired into `dispatch.ts`
    before `dispatchService` for slug `identity`.
- **Transition hook (`core/servicesTransitions.ts`).**
  - `applyServiceTransitions(env, db, product, after, actor)` runs after every write of
    `services_json`: `setServices` from `core/servicesAdmin.ts` (PATCH and revert) and from
    `services/release/resync.ts`. ST-05's generic settings write must call it too.
  - When `after.identity.enabled` is false, it calls
    `clearDeviceSubjects(db, env, {kind:"product", product}, "identity_disabled")`. It runs on
    every such write, idempotently, so stragglers heal at the next resync. It also writes the
    audit row `services.identity_disabled {cleared}`.
  - `ClearScope` gains `{kind:"product"}` and `ClearReason` gains `"identity_disabled"`
    (`core/subjectHooks.ts`). A clear for this reason **never releases a seat**, whatever
    `bound_by` says. Devices keep their anchor licence and token, and only the binding and its KV
    mirror go.
  - `account_product_grants` rows stay, so re-enabling Identity does not ask people for consent
    again. Nobody is re-bound until they sign in again.
- **Bind guard.** `setDeviceSubject` (`core/accountSubjects.ts`) and the `subject` branch of
  `bindDevice` (`core/devices.ts`) refuse (throw) when `identityEnabled` is false. The module
  comment "nothing here reads the product's Identity toggle" is reworded to name this one guard.
- **Dry run.** `PATCH /manage/api/products/<slug>/services` accepts `?dryRun=1`. It answers
  `{changes, signedInDevicesToClear}` with no write, so the console can confirm with the count
  ("N signed-in devices will be signed out; installs and licences keep working"). For products on
  `entitlementModel: combined` it adds "they lose account-held entitlements at next refresh".
  The admin route is narrative-only (rule 10).
- **Developer surfaces.**
  - License's admin licence detail and list gain `ownerSubject`, which is
    `subjectFor(licenses.account_id, product)` or `null`.
  - Core's `GET …/devices` and `GET …/devices/<id>` (`admin/handlers/devices.ts`) gain `subject`
    (`devices.subject`, or `null`).
  - Pairwise subjects stay platform-wide, as I-04 §2.1 says. A **product user** (grants, sign-in
    columns, Connected products) exists only while Identity is on. I-12 builds the Users page on
    these members.
- **Tables:** no migration and no `TABLE_OWNERS` change. The generated docs pages `docs gen:check`
  and `gen:services -- --check` stay unchanged. U-04 owns `sync` `requires`.
- **Tests (`test/identityPerProduct.test.ts`):**
  - Two products and one account produce two distinct `ps_` subjects, and neither equals the
    account id.
  - Every navigation entry gets the 303, and the same entries with JSON get a 404.
  - Turning Identity off clears every binding, releases no seat, and keeps documents
    byte-identical for a `legacy` product.
  - The bind guard throws.
  - Licence attach still works with Identity off.
  - `test/accountIdBoundary.test.ts`:
    - _Static:_ no non-portal OpenAPI schema has an `accountId` or `account_id` property.
    - _Dynamic:_ with a fixture of two products, every product-scoped admin GET in
      `routeCoverage`, every device route and the subject feed is called, and no body contains
      the account id.
- **THREAT-MODEL.** Item 12 (cross-product correlation) gains the boundary test as its control,
  and a new line records S-19 T1's precondition (Identity-off products never have signed-in
  devices) with the transition hook and bind guard as controls. The 303 is noted as disclosing
  only what discovery already says.

## 7. Rollout

1. Merge `errors.json`, then deploy the Worker. Nothing changes for any product until a services
   write.
2. Operator check:
   `SELECT COUNT(*) FROM devices d JOIN products p ON p.slug = d.product WHERE d.subject IS NOT NULL AND COALESCE(json_extract(p.services_json,'$.identity.enabled'),0) <> 1`.
   The expected answer is 0, because only Identity routes bind today. If it is not 0, a resync of
   each such product heals it.
3. I-08, I-11 and PX-14 consume `identity_disabled` (card).
4. I-10a and I-10b ship §5. No feature flag is needed, because every change is either additive or
   a stricter answer on human pages.

## 8. Open questions for the owner

1. **Refusal shape.** PORTAL.md asks for `identity_disabled` on "every app-sign-in entry". The
   registry contract (I-04 §2.1) and `registration_closed` deliberately keep JSON callers from
   telling "off" apart from "absent". **Recommend:** use `identity_disabled` only where a person
   is looking (the 303 and the portal context), and keep `404 not_found` for device and JSON
   routes.
2. **Turning Identity off with signed-in devices.** **Recommend:** clear every binding (no seat
   release, consent grants kept), after a console confirm that shows the count. Keeping the
   bindings and ignoring them would make LX-09, U-05 and I-12 each read the toggle, and would
   break S-19's "no device is ever signed in" on Identity-off products.
3. **Pairwise derivation.** PORTAL.md G34 says "keyed HMAC of account and product, key per
   deployment, rotation documented". I-05 (done) mints 128 random bits and stores them
   (`account_product_subjects`), with merge aliases. **Recommend:** keep random-and-stored, which
   needs no key rotation and supports D21 aliases, and correct G34's wording.
4. **Cloud Sync and Identity.** PORTAL.md §3.1 says Cloud Sync "depends on the account, NOT on
   Identity". I-04 §0, S-17 and S-19 decision 4 require Identity (principal `devices.subject`).
   **Recommend:** I-04 wins, and the lead corrects PORTAL.md §3.1's table row and G34's last
   clause.
5. **Subjects on Identity-off products.** G34 says "product users created only for Identity
   products". I-04 §2.1 makes subjects platform-wide, because licences attach and U-03 overrides
   and `subject.deleted` need them. **Recommend:** subjects everywhere (`ownerSubject` shown in the
   console for every product), and product users (grants, sign-in data, Connected products) only
   with Identity on.

**Risks.** The navigation sniffing (`Accept` / `Sec-Fetch-Mode`) must never 303 an SDK. The
transcript's JSON step pins this. The overlap with I-08 and I-09 is resolved by "first lands owns
the shared file" (`protocol/identity`, §12).

**Brief changes (lead, after approval):**

- **PX-W17:** narrowed to this plan.
- **I-08:** passthrough context answers `identity_disabled`, and uses `identityEnabled`.
- **I-11:** `/signin` reads `error=identity_disabled`.
- **PX-14:** renders the card from the query parameter and the API code.
- **I-10a and I-10b:** the transcript, the `identity.toggle` row, and the UI-kit "Identity off"
  snapshot.
- **I-12:** builds on `ownerSubject` and `subject`; product users only with Identity on.
- **I-21:** appends `oauth/authorize` to the navigation entries; the ID token `sub` is the
  pairwise subject.
- **LX-09:** relies on the §1 invariant and does not read the toggle.
- **LX-13 and LX-15:** use `identityEnabled` to create licence-held grants.
- **ST-05 and ST-08:** call `applyServiceTransitions`, and use the dry-run count in the confirm.
- **PORTAL.md §3.1 and G34:** wording, per Q3 to Q5.

## 9. Acceptance

```sh
N="mise exec node@22 --"
$N pnpm build && $N pnpm typecheck
$N pnpm gen:corpus -- --check          # unchanged: no corpus impact
$N pnpm gen:transcripts -- --check     # identity-disabled.json + Swift/Godot mirrors
$N pnpm gen:constants -- --check       # identity_disabled in every SDK
$N pnpm gen:services -- --check
$N pnpm parity:check                   # identity.toggle, six parity.json
$N pnpm --filter @polaris-key/shared-protocol test   # exports layout
$N pnpm --filter @polaris-key/worker test -- identity accountIdBoundary routeCoverage boundaries
$N pnpm --filter @polaris-key/worker typecheck:workerd && $N pnpm --filter @polaris-key/worker test:workerd
$N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
$N pnpm test && $N pnpm lint && $N pnpm format
# I-10a/I-10b: sdks/python pytest; swift test; gradle test; sdks/godot/tools/run_tests.sh; UI-kit snapshots
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```
