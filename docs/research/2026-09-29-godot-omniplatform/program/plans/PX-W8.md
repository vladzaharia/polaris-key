# PX-W8 plan: `manageUrl` on the seat and key-entry refusals

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

**Effect on this plan.** Q1 is accepted, so `manageUrl` is the one name on both refusals. On the
key in the activate link, Q2 here governs. The Worker emits no key, the SDK may add `#key=<key>`,
and PX-17 opens with an empty field only when no fragment is present (this reconciles PX-W9 Q2).
Q5 amends the LX-18 and I-08 briefs. PX-10 is done, so its `next=` handling is carried by PX-17.

**Sign-in alignment (2026-10-05; `docs/design/SIGN-IN.md` §3.7, `plans/I-04.md` §F).** Q5's
sign-in seat refusal is no longer the main path: the card's LicenseChoiceStep and its inline
**Replace a device** handle a full licence, and LX-18's `device_limit` + `manageUrl` covers only
the bind-time race on surfaces without the card. The link's `for=` carries the PX-W13 device label
when it is known (else the platform string). The kit button that opens `manageUrl` is **Replace a
device**; the portal quick action it lands near is **Free a device** ("Free up a device" is
retired, SIGN-IN.md D-49). No wire change.

> **Approved by the owner (2026-10-05)**; see "Owner decisions (2026-10-05)" above. As first written: It executes
> and narrows the approved [`plans/I-04.md`](I-04.md) for one member. It reopens none of I-04's
> answers, apart from the rename in Q1, which needs the owner's yes. The owner decisions of S-16
> (via I-04 §0), S-17, S-18 and S-19 are taken as given (§0). The open questions are at the end,
> each with a recommendation.

| Field       | Value                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief       | [`wp/PX-W8-manage-url.md`](../wp/PX-W8-manage-url.md); [PORTAL.md](../../../../design/PORTAL.md) §3.3, §3.4, §4.18, §4.25 and §10.2 G15b; I-04 §2.2 and §2.7                                                                                                |
| Implementer | **PX-W8** does the whole `device_limit` path in all six SDKs and the four UI kits, plus the shared helper. **I-09** emits `manageUrl` on `key_entry_limit`. **I-10a** and **I-10b** surface it on the key-entry outcome. **PX-17** reads the activate link. |
| Wire change | Inside wire v4. **`PROTOCOL_VERSION` stays 4** and `corpusVersion` does not change. This adds one optional member to two unsigned refusal bodies. There is no new `typ`, claim, signed shape, header or error code. Old clients ignore the member.          |
| Corpus      | **No signed-corpus change.** The evidence is one new transcript, one re-recorded transcript (I-09's), two parity rows and the UI-kit snapshots (§4).                                                                                                        |
| Line refs   | `main` at `248fef64`. After a rebase, find each place again by its quoted text.                                                                                                                                                                             |

## 0. Owner decisions encoded (binding)

- **I-04 (approved 2026-10-04).**
  - The refusals stay flat bodies on the routes that emit them flat today.
  - Neither link is an auth failure. An SDK never wipes state or retries on one.
  - URLs are built by the Worker and never carry the key.
  - Key-entry refusals exist only with Identity on, and never fire on an enrolled device.
  - `license_owned` keeps `signInUrl`.
- **S-19 (model OC).**
  - Seats live on the device's **anchor licence**, so `device_limit` and its link always name the anchor.
  - The holder is **the account signed in on the device**. The link carries no account id, no subject and no holder hint. The portal session decides what the person can manage.
  - **`legacy` mode stays byte-identical** for signed documents. `manageUrl` sits outside every document, so it ships for `legacy` and `combined` products alike, and no document byte changes.
  - The sign-in refusal `not_entitled` with `reason: device_limit` belongs to LX-18 (Q5).
- **S-18.**
  - PX-W8 adds **no setting**. The link is emitted only while the product's portal is on: today `portal_product_settings.portal_enabled`, and the S-18 row `portal.enabled` read through `resolveSetting()` once ST-14 lands.
  - If the portal is off, the member is omitted, matching PORTAL §4.19 "manages this license elsewhere".
- **S-17.** No Cloud Sync interaction.
- **S-16.** The global account id never leaves the Worker (I-04 §6.2).

## 1. Summary

- **`device_limit` (403) gains `manageUrl`** on `POST /<p>/license/activate`, `POST /<p>/license/enroll` and `POST /<p>/identity/session/license`. All three emit it through `authorizationError` (`services/license/activation.ts:47`) or `browserSession.ts:137`. It applies to every product, Identity on or off.
- **`key_entry_limit` (403) carries the same member under the same name.** I-04's `portalUrl` is renamed to `manageUrl` before I-09 ships (Q1).
- **Two targets, both existing portal routes.**
  - A licence attached to an account gets `#/p/<slug>/free-device`. PX-10 already ships it in `FreeDevicePage.tsx`.
  - A floating licence, and every `key_entry_limit`, gets `/activate?product=<slug>`. The SDK adds the key as a fragment (Q2, Q3).
- **One client-core helper** reads and validates the member and adds the app's `return=`. Node, React, Python, Swift, Godot and Kotlin expose it, and the four UI kits show **Replace a device** (a button, or a QR on a TV or console).
- The order is: this plan → Worker and transcript → client-core → the six SDKs and four UI kits. I-09 and I-10a/I-10b reuse the builder and the helper.

## 2. Contract

**WIRE-CONTRACT-V4.** Add §12.7 "Refusal links" next to I-04's §12, or a standalone §5.3 if PX-W8 lands before I-09 opens §12:

- `manageUrl` is an absolute `https` URL of at most 2048 characters, on the portal origin. The origin is `consoleOriginOf(env)` (`services/distribution/page/index.ts:106`), or the request's origin when that is unset.
- **`device_limit`, licence attached** (`licenses.account_id` set): `<portal>/#/p/<slug>/free-device?license=<licenseId>&for=<label>`.
- **`device_limit`, floating licence:** `<portal>/activate?product=<slug>&next=free-device&for=<label>`.
- **`key_entry_limit`:** `<portal>/activate?product=<slug>`.
- **`for`** is a coarse label built from the §5.2 metadata headers (platform and arch, for example `macOS arm64`). It is at most 64 characters, matching PORTAL's `forLabel`. It is never a hostname, device id or IP, and it is omitted when there is no metadata.
- **The only parameters a client may add:**
  - `return=<app URL>`, added to the query inside the fragment when the fragment holds a route, otherwise to the URL's query. The portal accepts it only against the product's declared return targets (`model/returnUrl.ts:39`, PX-10).
  - `#key=<key>` on an `/activate` link (Q2). The fragment never reaches a server, a log or the Worker's response.
- **Error-body members:** `limit` and `deviceCount` are unchanged, plus `manageUrl`. The flat shape is kept (I-04 §2 "Error bodies").
- **Not an auth failure.** A client never opens the link without a user action.

**`packages/worker/openapi/polaris-key.v3.yaml`:** add the member and examples to the three `device_limit` responses (`:1096`, `:6247`, `:6497`) and to I-09's `key_entry_limit` schema.

**`shared-protocol`:**

- `src/license.ts` gains `DeviceLimitBody { error: "device_limit"; message?: string; limit: number; deviceCount: number; manageUrl?: string }`.
- `src/identity.ts` (I-09's subpath) types `KeyEntryLimitBody.manageUrl`. If I-09 lands first, it already uses the new name.
- Constants: `MANAGE_URL_MAX_LENGTH = 2048`, `MANAGE_FOR_MAX_LENGTH = 64`.

**`client-core`:**

- New `src/manage.ts`, exported from `index.ts`:
  - `readManageUrl(body: unknown): string | undefined` reads the top-level or nested member. It keeps it only if it parses as a URL, uses `https:` (or `http:` to `localhost`/`127.0.0.1`), has no userinfo and is within the length limit. Otherwise it returns `undefined`.
  - `withManageReturn(url, returnUrl)` and `withManageKey(url, key)` apply the fragment rule above.
- Pure functions with no signing, no I/O and no change to `PolarisError`.

**`shared-jws`:** no change.

**Clients and workers already deployed.**

- Every SDK's 403 parser reads named members from a dictionary or a lenient decoder:
  - Node: `endpoints.ts:76-91`.
  - Kotlin: `LicenseEndpoints.kt:117-125`.
  - Swift: `Endpoints.swift:119`.
  - Python and Godot: dicts.
- So old apps ignore `manageUrl` and keep showing "device limit reached". Step 1 of the implementation pins this with a unit test in each SDK: a body with an unknown member still yields `device-limit`.
- New SDKs on an old Worker see no member and show today's copy without a link.
- Existing installs, tokens, refresh, grace and documents are untouched.

## 3. Catalog and manifests

No change to `shared-catalog` or `shared-manifest`. The return targets are the product's existing declared origins and schemes, which PX-10 already reads, and `identity.redirectPaths` is I-09's. There is no rule-9 entry and no `bundle:action` rebundle.

## 4. Corpus, transcripts and parity

**Signed corpus:** none. `pnpm gen:corpus -- --check` stays green with no generator, constant or mirror change. That corrects the brief's "corpus".

**Transcripts:** written by `packages/worker/test/transcripts/scenarios/license.ts`. `pnpm gen:transcripts` also writes the Swift and Godot mirrors. There is no `device_limit` transcript today.

| File                        | WP                | Steps                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `license-device-limit.json` | PX-W8             | Limit 1. Device A activates (200). Device B with a floating licence gets `device_limit` with `/activate…next=free-device`. The licence is attached, and B now gets the `free-device?license=` form. With the portal off, B gets no `manageUrl`. `session/license` over the limit gets the browser form. |
| `keyentry-limit.json`       | I-09 (or re-rec.) | As I-04 §4, with `manageUrl` in place of `portalUrl`                                                                                                                                                                                                                                                    |

**`errors.json`:** no new code, because `device_limit` exists. **Parity** (`conformance/parity/features.json`, plus the rows in all six `parity.json`):

- `license.manage`: family `license`, proof `transcript` (`license-device-limit.json`). It covers `manageUrl` on `device-limit`, plus `withManageReturn` and `withManageKey`. It has no N/A, so Node and Python expose the URL headlessly. I-10a and I-10b extend its note to `key-entry-limit`.
- `ui.kit.manage`: family `ui`, proof `snapshot`. It covers the device-limit screen with **Replace a device** (a button, or a QR on TV and console) and "Try again". It has `allowedNa` `headless` for Node and Python. I-04's `ui.kit.account` reuses the same component for the key-entry screen.

## 5. SDKs and UI kits, in order (all PX-W8)

Each SDK replays `license-device-limit.json`, passes `parity:check` and `gen:constants -- --check`, and never treats the link as an auth failure.

1. **client-core** (`packages/client-core`): `manage.ts` and its unit table, covering valid, `javascript:`, userinfo, overlong, nested and absent links, and fragment and query return.
2. **Node** (`packages/sdk-node`): `ActivationResult` `device-limit` gains `manageUrl?`, read with `readManageUrl` (`license/endpoints.ts`). The helpers are re-exported. The CLI prints the link (`cli/commands.ts`).
3. **React** (`packages/sdk-react`):
   - `browserAdapter.ts` (`session/license`) and `desktop/bridge.ts` forward the member, and `useLicense` state exposes it.
   - `LicenseGate.tsx` and `PolarisLogin.tsx` render **Replace a device**, which opens a new tab with `return` set to `location.href` when the host declares it.
4. **Python** (`sdks/python`): `ActivationResult.manage_url`, plus `with_manage_return` and `with_manage_key` (`license/endpoints.py`).
5. **Swift** (`sdks/swift`):
   - `.deviceLimit(limit:deviceCount:manageURL:)`. This is source-breaking for exhaustive bindings, which the 0.x line allows with a release note.
   - **PolarisKeyUI** `PolarisLoginView.swift` shows the button on macOS and iOS, and a QR on tvOS.
6. **Godot** (`sdks/godot`):
   - `PKeyActivationResult.manage_url` and the helpers in `core/`.
   - **`addons/polaris_key/ui`**: `activation_controller.gd` shows the button, or the existing device-code QR widget when a joypad is the only input, plus new copy in `pkey_ui_copy.gd`.
7. **Kotlin** (`sdks/kotlin`):
   - `DeviceLimit(limit, deviceCount, manageUrl: String? = null)`, which stays source-compatible.
   - **Kotlin UI** (Compose, `ui/`): the button, a QR on Android TV, and a new string in `strings.xml`.

The order is the parity order, not a dependency. Godot may go first. The per-language names above are fixed. Docs: each SDK's licensing guide in `packages/docs` gets "When every seat is taken". The error-codes page is unchanged.

## 6. Worker

- **Builder:** `core/manageUrl.ts`, with `buildManageUrl(env, req, product, {kind, licenseId?, owned})`. It lives in Core so Identity (I-09) and License share it (rule 6, `boundaries.test.ts`).
- **Call sites:**
  - `authorizationError` gains a context argument (product, request, licence), used by `activation.ts:147` and `enroll.ts:247`.
  - `browserSession.ts:137` gets the same.
- **Unchanged:** `oidc.ts:944`, which throws on any authz error today, until LX-18 (Q5).
- **Unit tests:** owned and floating licences, portal off, no metadata, and a hostile `X-PKey-Platform` (encoded, truncated).
- **Rule 10:** the routes are unchanged and the OpenAPI responses gain the member, so run `routeCoverage` and `docs gen:check`.
- **Nothing else:** no migration, no table and no `TABLE_OWNERS` change.

## 7. Rollout

1. Deploy the Worker. The change is additive with no flag, because old SDKs ignore the member.
2. Release client-core, then the SDKs in any order, through the normal automatic publish. Each SDK's release notes name the new field, plus the Swift case change.
3. Deploy I-09 with `manageUrl` on `key_entry_limit`, behind I-04's `identity.keyEntryRefusals` switch (default off).
4. **Rollback:** reverting the Worker removes the member, and new SDKs fall back to today's copy.

## 8. Risks

- Including a licence id in the free-device URL reveals nothing new: it is in the signed document, and the portal checks ownership.
- The `for` label can be spoofed by the client. It is display text only, sanitised on both ends.
- Under S-19's `onRefresh` re-anchoring (LX-21), a link built at refusal time can name an anchor that later changes. The portal shows the account's licences anyway.

## Open questions for the owner

1. **One member name.** PORTAL says `manageUrl` and I-04 says `portalUrl` on `key_entry_limit`. Nothing has shipped, because I-09 is still to do. **Recommend `manageUrl` on both** refusals, with `license_owned` keeping `signInUrl`. That means amending I-04 §2.2 and §4 and I-09's title and brief.
2. **The key in the activate link.** PORTAL §3.4 shows `/activate?key=…`, while I-04 says the Worker never puts the key in a URL. **Recommend:** the Worker emits no key, and the SDK adds `#key=<key>` as a fragment, which no server or log sees. The SPA shell (`router.ts:131-140`, PX-17) reads `#key=` as well as `?key=`, which printed cards still use.
3. **`device_limit` on a floating licence.** The free-device flow can only free seats of a licence that is in the signed-in account. **Recommend** `/activate?product=…&next=free-device`: the person adds the key (PX-17's modal, platform-wide claim rules), then goes straight to free-device. PX-10 and PX-17 handle `next`.
4. **How the app's return URL travels.** **Recommend** client-side `return=` through `withManageReturn`, validated by the portal against the declared targets (PX-10 already does this). The alternative is an `X-PKey-Return` request header validated by the Worker, which adds a header and CORS surface on every activation.
5. **Sign-in path seat refusals** (`oidc.ts:944`, passthrough sign-in). **Recommend** leaving them out of PX-W8. LX-18's `not_entitled` with `reason: device_limit` should carry `manageUrl` from the same builder, which means amending the LX-18 and I-08 briefs.

**Corrections to the research** (to record in the brief):

- There is no signed-corpus impact.
- I-04's `/portal/activate` and `/portal/signin` do not exist: the portal is served at the root (`router.ts:131-140`), so the paths are `/activate` and `/signin`. This concerns I-09 and I-11.
- PX-10's `FreeDevicePage` already reads `for`, `return` and `license`.
- No `device_limit` transcript exists today.

**Brief changes after approval:**

- I-04: Q1 rename and the correct paths.
- I-09: `manageUrl`, the shared builder, and `/activate` and `/signin`.
- I-10a and I-10b: the `key-entry-limit` outcome uses `readManageUrl`, plus `ui.kit.account` reuse.
- PX-17: `#key=` and `next=`.
- PX-10: `next=` from activate.
- LX-18: `manageUrl` on the sign-in seat refusal.
- PX-W9: the wire part is settled here.

## 9. Acceptance

```sh
N="mise exec node@22 --"
$N pnpm build && $N pnpm typecheck
$N pnpm gen:corpus -- --check          # unchanged: no signed-corpus impact
$N pnpm gen:transcripts -- --check     # license-device-limit.json + Swift/Godot mirrors
$N pnpm gen:constants -- --check       # license.manage, ui.kit.manage in every SDK
$N pnpm parity:check                   # two rows, six parity.json
$N pnpm --filter @polaris-key/client-core test
$N pnpm --filter @polaris-key/shared-protocol test
$N pnpm --filter @polaris-key/worker test            # builder, routeCoverage (rule 10), boundaries (rule 6)
$N pnpm --filter @polaris-key/worker typecheck:workerd && $N pnpm --filter @polaris-key/worker test:workerd
$N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
$N pnpm test && $N pnpm lint && $N pnpm format
# sdks/python pytest; swift test; sdks/godot/tools/run_tests.sh; sdks/kotlin ./gradlew test; UI-kit snapshots
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```
