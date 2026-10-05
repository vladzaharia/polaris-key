# PX-W13 plan: passthrough request metadata (G28)

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

**Effect on this plan.** Q4 is amended in place: `reserved_display_name` ships in warn mode behind
the platform switch `identity.reservedDisplayNames` (default `warn`). PX-W13 flips it to `error`
after the S-19 decision-15 window. PX-W13 gains the dependency LX-05 for the validator warning
path. §7's device-page switch targets the root path `/signin?request=rq_…` (corrected in place).
Q3 is accepted, so PX-W13 ships the §5 SDK and UI-kit label work itself.

> **Approved by the owner (2026-10-05)**; see "Owner decisions (2026-10-05)" above. As first written: The brief
> says PX-W13 "executes the approved `plans/I-04.md` (no separate plan)", but I-04 names G28 only
> in the dependency table: it fixes no client record, request handle, `deviceLabel` rule or consent
> shape. This plan fills that gap within I-04's frame (wire v4, additive, feature-detected), and
> I-04's decisions stay binding. "Open questions for the owner" (§8) lists the choices the research
> left open, each with a recommendation.

| Field        | Value                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief        | [`wp/PX-W13-passthrough-metadata.md`](../wp/PX-W13-passthrough-metadata.md); [`docs/design/PORTAL.md`](../../../../design/PORTAL.md) §4.7–4.9, §10.2 G28; [I-04](I-04.md); [S-16](../../notes/S-16-identity-service.md), [S-17](../../notes/S-17-user-data-sync.md), [S-18](../../notes/S-18-settings-architecture.md), [S-19](../../notes/S-19-licensing-model.md) |
| Implementers | **PX-W13** executes everything below, including the SDK and UI-kit label work in §5 (§8 Q3). **I-08** then builds Continue, callback binding and `authorize` on §2.2–2.3. **PX-14** renders the result. **I-13** and **I-15** are constrained by §2.5                                                                                                               |
| Wire change  | Inside wire v4. **`PROTOCOL_VERSION` stays 4**, `corpusVersion` stays 2. No new `typ`, claim or signed shape. Adds one normalisation rule for a device label that SDKs already send as `deviceName`, an echo member, browser-only portal routes and two manifest rules. No new `errors.json` codes                                                                  |
| Corpus       | **One new unsigned file**, `conformance/corpus/v2/device-label.json` (`deviceLabelVersion: 1`), with its Swift and Godot mirrors. `cases.json` and the other matrices are unchanged                                                                                                                                                                                 |
| Line refs    | `main` at `248fef64`. Re-locate by quoted text after a rebase                                                                                                                                                                                                                                                                                                       |

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that sign-in asks the person which licence to bind, with an inline
**Replace a device**. The full text and the card API are in [`plans/I-04.md`](I-04.md), "Owner
decision (2026-10-05): licence choice at sign-in", §C. **Effect on this plan:**

- **§2.3, the licence item.** `items[kind=license].anchor` is the licence the person chose,
  passed as `GET …/consent?choice=<licenseId|keep|create>`. It is no longer Core's dry-run anchor.
  Without `choice`, `anchor` is `null` and the card shows the chooser first. `more` and its
  `legacy`/`combined` rule are unchanged.
- **§2.2, the route family.** The family gains `GET /api/signin/requests/:handle/licenses` and
  `…/licenses/:licenseId/devices`. They use the same binder cookie, account session and
  `no-store` rules. I-08 implements them, because they need I-09's ranking and the portal's
  device-removal operation. Q5 holds: a new choice of licence does not re-ask consent.
- **No change** to the device label, the handle, `deviceName`, the corpus file or the manifest
  rules.

## 0. Owner decisions encoded (binding)

- **PORTAL.md (approved 2026-10-04).** App branding is data only, inside a fixed frame. Names are
  checked against a reserved list at registration. The origin shown is the registered one, never a
  query parameter. The card reads the request through an opaque `request` handle (G28).
- **S-16 / I-04.** D17: credentials only on the card. D19: name and email only with consent. D22:
  "Continue to <App>" on the first sign-in to each app, and always on device code. The global
  account id never leaves the Worker. Passthrough exists only with the product's Identity toggle on.
- **S-17.** Cloud Sync appears in the consent list only when the product has the service on. It
  `requires: [config, identity]`.
- **S-18.** Model C: a console edit claims a manifest field. That makes `listing.name` and
  `listing.developerName` writable from two paths, so §3's rules run on both. Platform-wide lists
  are rows in the platform slice of the settings registry (ST-03). The system product
  `polaris-key` is manifest-authoritative.
- **S-19 (decisions 1–4).** A licence is an access contract, and grants are reasons for
  entitlements. The holder of account-wide entitlements is the account signed in on the device
  (`entitlementHolder: device`). Each device has one anchor licence, chosen `rank-first`.
  `licensing.entitlementModel: legacy` reproduces today's documents byte for byte. The consent
  data in §2.3 follows these rules and changes no document.

## 1. Summary

- **One device label rule, one name on the wire.** The SDKs keep sending the existing optional
  `deviceName` member on `POST /<p>/identity/auth/device/start`. Under a pinned rule (corpus
  `device-label.json`), each SDK now fills it with a platform default when the host passes none.
  The Worker applies the same rule and echoes the stored value as `deviceName` in the start
  response.
- **The client record.** A server-side, per-product view (`appName`, `developerName`, proxied
  `iconUrl`, `kind`, registered `origins`, `services`) is built from data the Worker already holds.
  No table is added.
- **The request handle.** `rq_…` is a 10-minute, browser-bound handle in the artefact KV. The new
  card reads presentation only through `GET /api/signin/requests/:handle`. Display query
  parameters are ignored.
- **Consent data.** `GET /api/signin/requests/:handle/consent` returns what the app will get under
  S-19's rules. `account_product_grants` gains `scope_hash`, so I-08's Continue can tell when to
  ask again.
- **Reserved display names.** Two new rule-9 rules, `reserved_display_name` and
  `invalid_display_text`, run in the manifest validator and on console claims, with a
  defence-in-depth re-check at render time. `reserved_display_name` warns first and is enforced later (§8 Q4, amended
  2026-10-05).
- **Order:** this plan → corpus file → contract text → Worker → transcripts → SDKs in this order:
  Node, React (typed N/A), Python, Swift, Godot, Kotlin. The UI kits follow with their SDKs.

## 2. Contract

**Where.** PX-W13 adds **§12.7 "Passthrough request metadata"** to
`docs/security/WIRE-CONTRACT-V4.md`. If I-09 has not opened §12 yet, PX-W13 creates the heading
and leaves §12.1–12.6 to I-08 and I-09. It also adds a §8 registry row for `REQUEST_HANDLE_PATTERN`
and a §5.2-style note that `deviceName` is display data that no server decision reads.

**`shared-protocol`.** PX-W13 adds to `@polaris-key/protocol/identity`. It creates the subpath
(`src/identity.ts`, `exports`, `test/exports.test.ts`) if I-09 has not: whichever package lands
first creates it.

- Constants: `DEVICE_LABEL_MAX_CODEPOINTS = 64`, `DISPLAY_TEXT_STRIP` (the code-point ranges of
  §2.1), `REQUEST_HANDLE_PATTERN = ^rq_[A-Za-z0-9_-]{22}$`, `REQUEST_HANDLE_TTL_SECONDS = 600`
  (equal to `FLOW_TTL_SECONDS`, `oidc.ts:93`).
- Types: `ClientKind = "web" | "native" | "device"`, `ClientRecord`, `SignInRequestView`,
  `AppConsentView`, `ConsentItem`, and `DeviceStartResponse` (with `deviceName`).
- `gen:constants` carries the constants into every SDK.

**`client-core`** gains `normalizeDeviceLabel(raw): string | null` (`src/deviceLabel.ts`, exported
from the index). It is the reference implementation of §2.1. **`shared-jws` does not change.**

### 2.1 The device label (§12.7.1)

The wire name stays **`deviceName`** (§8 Q1). Five SDKs already send it, and `devicecode-happy.json`
pins it. `deviceLabel` is the name of the stored, rendered value. Normalisation, which the SDK
applies before sending and the Worker applies on receipt:

1. Map U+0009–000D, U+0085, U+00A0, U+2028, U+2029 and U+3000 to U+0020.
2. Delete U+0000–001F, U+007F–009F, U+061C, U+200B–200F, U+202A–202E, U+2060–2064, U+2066–2069
   and U+FEFF. This removes bidi overrides and zero-width characters.
3. Collapse runs of U+0020 to one, then trim.
4. Keep at most 64 code points. Code points, not UTF-16 units: Godot strings are UTF-32 and the
   runners compare code points.
5. If the result is empty, the label is absent: omit the member, and the Worker stores `NULL`.

There is no NFC step, because Godot has no normaliser. The Worker never rejects a label, it only
normalises it (today it slices to 120 at `oidc.ts:1064`). The start response gains
`"deviceName": <stored label> | null`, so a UI kit shows exactly what the card will show.

**SDK default** when the host passes nothing. Hosts can override it with `deviceName` in configure
or per call, and opt out with `""`.

| SDK    | Default                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `os.hostname()` with a trailing `.local`, `.lan` or `.home` removed                                                                |
| Python | `platform.node()`, same rule                                                                                                       |
| Swift  | macOS: `Host.current().localizedName`. iOS, iPadOS, tvOS, visionOS: `UIDevice.current.name` (generic since iOS 16; no entitlement) |
| Kotlin | Android: `Settings.Global.DEVICE_NAME`, else `Build.MODEL`. JVM: `InetAddress.getLocalHost().hostName`, same rule as Node          |
| Godot  | the existing `default_device_name()` (`identity.gd:195`): model, else OS name                                                      |
| React  | none (web runtime: the card shows the origin, not a device). Typed N/A                                                             |

### 2.2 Client record and request handle (§12.7.2, browser-facing)

- **`clientRecordFor(product, kind, now)`** (Identity, `services/identity/passthrough/client.ts`):
  - `appName`, `developerName` and `iconUrl` come from `presentationFor`
    (`portal/library.ts`, same-origin `/media/<p>/icon`);
  - `origins` is the product's `web.origins`;
  - `services` is `{license, cloudSync}` from the product's service toggles;
  - a render-time re-check of §3's rules replaces a failing `appName` with the product slug and
    sets `nameVerified: false` (PX-14 renders the neutral frame).
- **Handle.** `createSignInRequest(env, {product, kind, deviceLabel?, userCode?, origin?,
flowRef})` writes `signin-req:<sha256(handle)>` to the artefact KV with a 600 s TTL. The handle
  is `rq_` plus 16 random bytes in base64url. The record is bound to the browser that created it:
  a random binder goes into `__Host-pk_req` (HttpOnly, Secure, SameSite=Lax, Path=/) and its hash
  into the record. Another browser gets `404 not_found`. I-08's R1-07 callback binding reuses the
  binder instead of minting a second one.
- **Created by:** the device-code user-code confirmation (`renderDeviceConfirmation`, `oidc.ts`).
  That legacy page also switches to the stored, normalised label. I-08's `authorize` and the I-13
  and I-15 entries also create handles. PX-W13 adds no public creation route.
- **`GET /api/signin/requests/:handle`** (portal, same-origin, `no-store`, binder cookie
  required) → `SignInRequestView {request, client: ClientRecord, deviceLabel|null,
userCode|null, expiresAt}`. A handle that is unknown, expired, unbound or for an Identity-off
  product gets `404 not_found` (nested `PolarisErrorBody`). The card and `capabilities?product=`
  read **no** display query parameter: `appName`, `name`, `icon`, `developer`, `origin` and
  `device` are ignored.

### 2.3 Consent data (§12.7.3)

**`GET /api/signin/requests/:handle/consent`** requires the account session and the binder, and
returns `AppConsentView`:

- `person {displayName, email, avatarUrl}`, from the account. It is shown to the person only.
- `items[]`:
  - `{kind:"license", anchor:{name, tierName, term, seat:{position, limit}} | null, more: n}`.
    `anchor` is Core's dry-run anchor choice: I-09's inline `rank-first` steps, LX-10's
    `chooseAnchor` once it lands. It writes nothing.
    `more` is 0 under `entitlementModel: legacy`. Under `combined` it counts the other licences
    and grants the signed-in account holds **for this product**: never names, never other products
    (S-19 §7.3.1, holder = the device's signed-in account). The model is read through ST-04's
    resolver once LX-06 lands, and is `legacy` before then.
  - `{kind:"cloudSync"}` only when the product has Cloud Sync on.
  - `{kind:"profile", claims:["name","picture","email"]}`.
- `scopeHash`: SHA-256 of the canonical JSON `{claims, services, v:1}`.
- `firstTime` and `changed`: compared with `account_product_grants.scope_hash`.

A licence-only change does not re-ask (§8 Q5). The copy PX-14 renders ("While you're signed in on
<device>, <App> uses your licences for it here") is fixed by PX-14, not by the wire. With no
licence, `anchor: null` and the line reads from auto-issue or `not-entitled` exactly as I-04's
amendment says.

### 2.4 Clients and workers already deployed

- **Old SDKs** keep sending `deviceName` only when the host passes one. The Worker normalises it
  and the card shows "Unnamed device" otherwise, as today. They ignore the echo.
- **New SDKs on an old Worker.** The old Worker accepts `deviceName` and slices it to 120, which is
  a no-op for a normalised label. The absent echo is read as "unknown", and the UI kit shows its
  local label.
- `license/activate` and `register` are unchanged unless §8 Q2 says yes. No document, token,
  refresh or grace behaviour changes. `legacy` products' documents stay byte-identical.

### 2.5 Pre-decided for later plans

- **I-13** exchange and **I-15** native redirect: the request carries `deviceName` under §2.1,
  and the entry creates a `native` handle.
- **I-15** must offer a pushed-request step (RFC 9126 style, `POST /<p>/identity/request` →
  `{request, authorizeUrl}`), because a label in an `authorize` query string would be a display
  query parameter.
- **I-21**: OAuth clients, if added, extend `ClientRecord`. They do not replace it.

## 3. Catalog and manifests

`shared-catalog` does not change. `shared-manifest` exports
`checkDisplayName(text) → null | "reserved" | "invalid"` and `RESERVED_DISPLAY_TERMS`. The Worker's
`core/storefront/listingModel.ts` claim path and ST-04's `writeSetting()` validator hook call the
same function (S-18 model C).

| Code                    | Applies to                                                                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Schema  |
| ----------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `invalid_display_text`  | `.pkey/product` `product.name`; `.pkey/distribution` `listing.name`, `listing.developerName` | No code point of §2.1 step 2; no leading or trailing space                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | rejects |
| `reserved_display_name` | same fields                                                                                  | After NFKC, case folding, the confusable map (`0→o`, `1→l`, `rn→m`, `vv→w`, Cyrillic and Greek look-alikes) and removing non-alphanumerics, the name contains a reserved term on word boundaries. Terms: `polaris`, `polaris key`, `plrs`, `apple`, `app store`, `google`, `google play`, `steam`, `valve`, `epic games`, `microsoft`, `xbox`, `playstation`, `nintendo`, `itch io`. The system product is exempt. Warns while the platform switch `identity.reservedDisplayNames` is `warn` (the default) and rejects when it is `error` (§8 Q4, amended 2026-10-05) | accepts |

Each rule gets a row in `test/schema-parity.test.ts` (rule 9) and a pattern in
`schemas/v1/product.schema.json` and `distribution.schema.json` (the first rule only). PX-W13
rebundles `actions/publish/dist` (`bundle:action -- --check`) and updates the
`authoring-pkey-manifests` skill. Before merging, the implementer runs the validator over
`products/*` and records the result in the brief.

## 4. Corpus, transcripts and parity

**Corpus.** `tools/sign-corpus.ts` gains a `DEVICE_LABEL_CASES` section. It writes
`device-label.json`, about 20 rows of `{id, description, raw, expect}`, to every
`CORPUS_TARGETS` path (`conformance/corpus/v2/`, the Swift `Resources/v2/`,
`sdks/godot/tests/corpus/v2/`). Rows cover:

- each step-2 range;
- RLO spoofing (`"Living room TV‮gnp.exe"`);
- tabs and newlines;
- 64 and 65 code points, including an astral emoji at the boundary;
- all-whitespace → `null`;
- an ordinary ASCII label.

The file is append-only with `deviceLabelVersion: 1`, and a changed rule bumps the version.
`corpusVersion` stays 2, and the header comment's file count goes from nine to ten. Every runner
asserts `normalizeDeviceLabel` against every row: `conformance/runners/node`, Python, Swift, Godot
and Kotlin `gradle test`. The Worker test reads the same file.

**Transcripts** (`packages/worker/test/transcripts/scenarios/identity.ts`, `pnpm gen:transcripts`,
which also writes the Swift and Godot mirrors):

| File                      | Change                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devicecode-happy.json`   | re-recorded: start response `deviceName`                                                                                                                |
| `devicecode-label.json`   | new: `beginSignIn` with a raw label carrying an RLO, a tab and 70 code points → exact-match body with the normalised label → echo equals it             |
| `devicecode-default.json` | new: `beginSignIn()` with no argument and transcript `initial.deviceName: "Transcript Device"` (the replayer's host-default override) → body carries it |

`initial.deviceName` is an additive transcript member (`transcriptVersion` stays 1). Each replayer
feeds it to the SDK's default-label hook. If §8 Q2 is yes, `activate-enroll-deactivate.json`,
`register-open.json` and `register-reregister-401.json` are re-recorded with the member.

**Parity** (`conformance/parity/features.json`, all six `parity.json`). New row
`identity.devicelabel` (family `devices`, service `identity`, proof `corpus` + `transcript`):

- `allowedNa` `runtime` for React, with the reason "web runtime; the card shows the registered
  origin";
- the entry is `planned` with `wp: "PX-W13"`, then `done` as each SDK lands.

`ui.kit` keeps its row. Its snapshots gain the label line (§5).

## 5. SDKs and UI kits, in order

Each SDK passes the corpus rows, replays §4's transcripts, and passes `parity:check` and
`gen:constants -- --check`.

1. **Node** (`packages/sdk-node`, over `client-core`): this is the reference.
   - `configure({deviceName})` and the §2.1 default;
   - `beginSignIn()` uses it;
   - `SignInPrompt.deviceName` comes from the echo.
2. **React** (`packages/sdk-react`): `parity.json` N/A only. The activation component is unchanged.
3. **Python** (`sdks/python`): `configure(device_name=…)`; `begin_sign_in` default.
4. **Swift** (`sdks/swift`) and **`PolarisKeyUI`**: the sign-in view shows "The sign-in page will
   show '<label>'" under the code. Snapshot.
5. **Godot** (`sdks/godot`) and **`addons/polaris_key/ui`**:
   - `PolarisKey.configure` gains `device_name`;
   - `PKeySignInDialog.device_name` defaults to it;
   - the dialog shows the echoed label.
6. **Kotlin** (`sdks/kotlin`) and its **`ui`** module: `PolarisKeyConfig.deviceName`;
   `signInActions()` default; `PolarisSignIn` label line.

## 6. Worker

- **Routes (rule 10).** The two `GET /api/signin/requests/:handle[/consent]` routes go into
  `openapi/polaris-key.v3.yaml` under tag `portal`, as for PX-W1, and into `routeCoverage`.
  `device/start`'s response schema gains `deviceName`.
- **Migration** (number at the final gate; main's highest is `0071`):
  `ALTER TABLE account_product_grants ADD COLUMN scope_hash TEXT`. It is expand-only and
  reversible. `TABLE_OWNERS` is unchanged (identity). I-08 writes the column on Continue.
- **No new table.** Request records live in the artefact KV, like device-flow records.
- **Generated pages.** `docs gen:check`, and `check:links` for the contract section.
- **THREAT-MODEL**, new section "Passthrough request metadata (PX-W13)":
  - spoofed app names: the reserved terms, the confusable skeleton, the render-time re-check and
    the system exemption;
  - label injection: §2.1 and the card's "reported by the device" frame;
  - the request handle: 128 bits, browser-bound, 10 minutes, holding nothing beyond the user
    code;
  - display-parameter spoofing: ignored, with a test.
    It links S-16 §5.4 items 13 and 14.

## 7. Rollout

1. Contract, corpus and `shared-protocol`. Old SDKs see nothing.
2. Deploy the Worker: normalisation, echo, handles and consent API. The legacy device page shows the
   normalised label, and nothing else changes for users.
3. The SDKs release in §5's order. Labels appear on the existing page at once.
4. PX-14 switches the device-code page to `303 /signin?request=rq_…` and renders
   `ClientRecord`. I-08 writes `scope_hash` on Continue.

The two manifest rules apply at the next resync. A product whose current name fails
`invalid_display_text` fails resync with the rule's message. `reserved_display_name` only warns
until the lead flips `identity.reservedDisplayNames` to `error` (§8 Q4, as amended 2026-10-05). The render-time re-check covers values written before the
rule existed. No feature flag is needed: everything is additive or unused until PX-14.

## 8. Risks and open questions

**Risks.**

- The confusable map is heuristic. The render-time re-check and the operator approval of Q4 bound
  it.
- OS device names are personal data. They are shown only to the person and stored on
  `devices.label`, where they are already shown to the licence owner and the console.
- PX-W13 and I-08 both touch the device-code page. PX-W13 should land first and own the handle and
  the binder (brief rule: "whichever lands first owns the shared code").

### Open questions for the owner

1. **Q1 Wire name: keep `deviceName` or rename to `deviceLabel`.** Five SDKs and a transcript
   already send `deviceName`, and a rename needs a dual-read window. **Recommend keeping
   `deviceName` on the wire** and using "device label" for the stored and rendered value.
2. **Q2 Send the label on `license/activate` and `register` too.** That would seed
   `devices.label` only when it is `NULL` and never overwrite a portal rename (PX-W5), so the
   Library and the console show "Living room TV" instead of "Unnamed device" with no host work.
   It costs three re-recorded transcripts and a check that both routes ignore unknown members on
   the deployed Worker. **Recommend yes, in PX-W13.**
3. **Q3 Who ships the SDK side.** I-10a and I-10b are large and not started. **Recommend that
   PX-W13 ships §5 itself**, which is one helper and one default per SDK, so its acceptance ("every
   SDK sends the label") holds without waiting. I-10a and I-10b inherit it.
4. **Q4 Reserved-name policy.** Word-boundary match on the list in §3 blocks a third party's
   "Steam Deck Companion".
   - The recommendation was a hard error from day one, with an operator-only, audited product
     setting `identity.displayNameApproved` (S-18 `policyBound`, ST-03) that clears one product.
   - The platform can add terms through a platform-slice list `identity.reservedDisplayTerms`;
     the code list is the floor.
   - **Amended by the owner (2026-10-05): warn first, then enforce, not a hard error from day
     one.** This follows the LX-05 and LX-05b pattern for reserved entitlement names (S-19 §7.4,
     decision 15). PX-W13 ships `reserved_display_name` behind a platform registry switch
     `identity.reservedDisplayNames` (`warn` | `error`, default `warn`, L1 both ways). In `warn`,
     the manifest validator reports a warning and resync, link and the console claim succeed. The
     console's product page shows the warning and the operator's `identity.displayNameApproved`
     action, and the render-time re-check still applies the neutral frame. PX-W13 reuses LX-05's
     validator warning path, so it depends on LX-05. Enforcement is part of PX-W13: the same code
     answers a hard error when the switch reads `error`. The lead flips it once the S-19 decision
     15 window has passed (two minor releases or 60 days after PX-W13 ships, whichever is later)
     and the warning list is empty or approved. `invalid_display_text` stays a hard error from
     day one, because it rejects control and bidi code points, not names.
5. **Q5 What re-asks consent.** **Recommend** a change in the claims or services set (Cloud Sync
   turned on, a new profile claim), not a new anchor licence or new grants. Licences already
   follow the signed-in account under S-19 decision 4, and the item says so.
6. **Q6 Naming collision.** `account_product_grants` (consent, I-05, shipped) and S-19's grants
   (entitlement reasons) share a word. **Recommend keeping the table name** and using "app consent"
   in every new type, route, doc and glossary entry (`AppConsentView`, `scopeHash`). Rename the
   table in LX-16's contract-phase migration.

**Brief changes** (lead, after approval):

- **PX-W13:** this plan replaces "no separate plan", and it ships §5 if Q3 is approved.
- **I-08:** reuses the handle and binder; writes `scope_hash`; Continue reads `AppConsentView`.
- **PX-14:** reads `SignInRequestView` and `AppConsentView`; `nameVerified: false` frame; the
  device page switch.
- **I-10a, I-10b:** inherit the label helper.
- **I-13, I-15:** §2.5, including the pushed-request step.
- **LX-16:** table rename (Q6).
- **ST-03:** three settings (Q4 as amended: `identity.displayNameApproved`,
  `identity.reservedDisplayTerms` and the `identity.reservedDisplayNames` switch).
- **PX-W5:** rename wins over the seeded label.

## 9. Acceptance

```sh
N="mise exec node@22 --"
$N pnpm build && $N pnpm typecheck
$N pnpm gen:corpus -- --check          # device-label.json and its Swift and Godot mirrors
$N pnpm gen:transcripts -- --check     # §4 files and mirrors
$N pnpm gen:constants -- --check       # label and handle constants in every SDK
$N pnpm parity:check                   # identity.devicelabel in six parity.json
$N pnpm --filter @polaris-key/shared-manifest test   # rule 9 rows for both codes
$N pnpm --filter @polaris-key/shared-protocol test   # exports layout
$N pnpm --filter @polaris-key/client-core test       # normalizeDeviceLabel vs corpus
$N pnpm --filter @polaris-key/worker test            # routeCoverage, display-param test, reserved-name test, binder test
$N pnpm --filter @polaris-key/worker typecheck:workerd && $N pnpm --filter @polaris-key/worker test:workerd
$N pnpm --filter @polaris-key/cli bundle:action -- --check
$N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
$N pnpm test && $N pnpm lint && $N pnpm format
# SDKs: sdks/python pytest; swift test; sdks/godot/tools/run_tests.sh; gradle test; UI-kit snapshots
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```
