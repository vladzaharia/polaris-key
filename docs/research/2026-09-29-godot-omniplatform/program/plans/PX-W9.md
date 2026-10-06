# PX-W9 plan: key-entry counting (G21), revision 2

> **Revision 2 (2026-10-06), awaiting the lead's answers to §8.** The owner approved revision 1 on
> 2026-10-05. Its decisions still bind and are restated in §0. This revision re-checks the plan
> against `main` (`148439c4f`), now that PX-W8, PX-17, LX-26, ST-01b, ST-03 and ST-06 have landed.
> It names the whole chain, from the contract through the errors, the copy, the transcripts and
> every SDK, and it proposes splitting the SDK half into a new package, **PX-W9b** (§8 Q1). Line
> references are to `148439c4f`. After a rebase, find each one again by its quoted text.

| Field        | Value                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief        | [`wp/PX-W9-key-entry-counting.md`](../wp/PX-W9-key-entry-counting.md); [PORTAL.md](../../../../design/PORTAL.md) §3.1, §4.6, §4.19, G21; [SIGN-IN.md](../../../../design/SIGN-IN.md) §3.9, §4.5; [`plans/I-04.md`](I-04.md) §2.2; [`plans/PX-W8.md`](PX-W8.md); notes S-24   |
| Implementers | **PX-W9** (`pkey-implementer`) does §2–§4 and §6. **PX-W9b** (`pkey-sdk-porter`, new; `planRef: PX-W9`) does §5. I-09 adds `license_owned` into the same §12.2. I-10a and I-10b add the refusal screen's **Sign in**                                                         |
| Wire change  | Inside wire v4. **`PROTOCOL_VERSION` stays 4**, `DISCOVERY_VERSION` stays 2 and `corpusVersion` stays 2. No new `typ`, claim, header or signed shape. Adds one wire code (`key_entry_limit`), one unsigned member (`keyEntries`), one activation result and one portal route |
| Corpus       | **Signed corpus: none** (§8 Q6). The evidence is three new transcripts with their Swift and Godot mirrors, two parity rows and the Worker tests                                                                                                                              |
| Depends on   | I-04, ST-01b and ST-03 (all done). PX-W8 is done. ST-04 is not needed (§8 Q2)                                                                                                                                                                                                |

## 0. Binding decisions (carried, not reopened)

- **S-16 and I-04.**
  - D20: an entry counts only when it enrols a new device, or when it is a portal submission.
  - Q5: a race at the last free entry may go slightly over the limit.
  - Q7: the default limit is 10, the range is 1–100, and there is no "unlimited" while Identity is on.
  - Counting, the limit and the refusal exist only while the product's Identity toggle is on.
  - The switch `identity.keyEntryRefusals` stays off until the SDKs ship, and counting runs either way.
  - Existing installs are never affected, and no URL carries the key.
- **Revision 1, as approved.**
  - Q1 split: PX-W9 owns the counter, the settings rows, I-04 §2.2 step 4, `keyEntries`, `key_entry_limit`, the key-entry transcripts and the portal surfaces. I-09 owns step 3 (`license_owned`), attach, subject, sign-out, the discovery members and the `identity:` manifest block.
  - Q3, as overridden: `key_entry_limit` carries **`manageUrl`**, built by `core/manageUrl.ts` (`kind: "key_entry_limit"`, already supported).
  - Q4: the signed-out preview never counts.
  - Q5: the member is `keyEntries {used, limit}` on every surface.
  - Q6: every licence key counts, add-on keys included, and grants never count.
- **Licence choice at sign-in (owner, 2026-10-05).** These never count: choosing a licence, **Keep the license this device uses**, **Create a new free license** and **Replace a device**. A KeyStep add counts once, as a `portal` submission. I-08's app-mode `{kind: "key"}` counts once, as `app`.
- **Approved I-09 plan.** The table owner is `core`, and counting starts at 0 with no backfill.

**Corrections to revision 1 found on `main`:**

- `bindDevice` (`core/devices.ts:375`) writes with no batch. The commit point is the seat claim, `claimDeviceSeat` (`repo.ts:1373`) (§6).
- ST-03 already registered both settings, with `pending: {wp: "I-09"}`.
  - The bounds live in `core/settings/platform.ts:34-36`. They do not go into `shared-protocol`.
  - I-09 still moves them into `shared-manifest` for its rule.
- Activation kinds live in `enums.json` `activationResult`, not as `kind: client` codes in `errors.json`.
- The SP pass changed deployed SDKs: they report an unknown 403 as `refused{code}` (`sdk-node/src/license/endpoints.ts:16-21`), not as `device-limit`.
- PX-17 already reads the preview's member (`admin/src/portal/model/key.ts:194` reads `keyEntries ?? entries`).
- `identity-disabled.json` already pins "no `keyEntries`" with Identity off.
- I-09's `keyentry-refusals-off.json` is a counter transcript, so it moves to PX-W9.
- Browser sessions share one device per licence (`browser:<licenseId>`, `browserSession.ts:126`), so the `browser` surface counts at most once per enrolment.

## 1. Summary

- **One Core counter.** `license_key_entries` (insert-only) is written in the **same batch as the seat claim** of a new authorisation. That makes the count exactly-once per enrolled device, plus one row per portal claim.
- **Device wire, Identity on.**
  - Every key-entry success carries `"keyEntries": {"used": n, "limit": n}`: `200` on `license/activate`, `201` on `session/license`.
  - With the switch on, a non-enrolled device at or past the limit gets `403 {"error":"key_entry_limit","manageUrl":…,"keyEntries":…}`.
  - With Identity off, nothing changes.
- **Portal.**
  - `POST /api/activate/preview` swaps `entries: null` for `keyEntries`.
  - The claim answer carries `keyEntries` and records a `portal` entry.
  - A new signed-out, read-only **`POST /api/key/preview`** feeds SIGN-IN §3.9's meter and the skippable or forced body.
- **Chain.** WIRE-CONTRACT §12.2 → `errors.json`, `enums.json` and the eight `copy.*.json` → Worker → transcripts and parity → client-core and the six SDKs with four UI kits (PX-W9b).

## 2. Contract

**`docs/security/WIRE-CONTRACT-V4.md`.**

- PX-W9 writes **§12.2 "Key entry" [C]**, pinned by the three transcripts in §4. The §12 intro is reworded: §12.2 belongs to PX-W9, I-09 inserts step 3, and §12.3–§12.6 stay reserved. §12.2 says:
  1. **Surfaces.** A key entry happens on one of three surfaces, on a product with Identity on:
     - `app`: `POST /<p>/license/activate`;
     - `browser`: `POST /<p>/identity/session/license`;
     - `portal`: `POST /api/claim/license-key`, once the attach commits.
  2. **Enrolled** means a `devices` row for `(product, device_id)` with this `license_id` and `status = 'authorized'`.
  3. **Order on the device routes:**
     1. rate limit, key and licence (unchanged);
     2. enrolled → as today, never refused, never counted;
     3. reserved for I-09;
     4. switch on and `used ≥ limit` → the flat 403 `{error, message, manageUrl?, keyEntries}`;
     5. `authorizeDevice`; a new authorisation that takes a seat records exactly one entry, atomically with the seat.
  4. **Never counted:**
     - refused or failed attempts;
     - enrolled re-entry;
     - token, refresh, offline grace and documents;
     - `license/enroll`, store binding and sign-in activation;
     - choosing a licence and Replace;
     - an `already_yours` claim.
  5. **The member.**
     - `used` is the licence's row count. It may exceed `limit` after races, portal claims or periods with the switch off.
     - `limit` is the product's effective `identity.keyEntry.limit`.
     - A client shows `max(0, limit − used)` left.
     - It is present on every Identity-on key-entry 2xx (enrolled re-entry included) and on `key_entry_limit`, and absent otherwise.
  6. **The limit applies to a licence with no account.** It counts every successful key entry whatever the holder (§8 Q3).
  7. **Not an auth failure.** A client never wipes state or retries.
- The **§5.3** table row `key_entry_limit` changes from "the Identity key-entry routes (I-09)" to those two routes. The link itself (`<portal>/activate?product=<slug>`, omitted while the portal is off) does not change.

**`packages/shared-protocol`.**

- `src/core.ts:273`: `PolarisErrorCode` gains `"key_entry_limit"`.
- `src/identity.ts` gains these types:
  - `KeyEntries {used: number; limit: number}`;
  - `KeyEntrySurface = "app" | "browser" | "portal"`;
  - `KeyEntryLimitBody {error: "key_entry_limit"; message?: string; manageUrl?: string; keyEntries: KeyEntries}`;
  - `KeyPreview` (§6) and `KeyUpgrade = "skippable" | "forced"`.

  The subpath already exists (PX-W17), so the exports layout is unchanged.

- **`shared-jws`:** no change.
- **`client-core`:** it gains `src/keyEntries.ts` in **PX-W9b** (§5). PX-W9 changes no client-core file.

## 3. Errors, copy, catalog, manifests and settings

- **`conformance/parity/errors.json`** gains `{code: "key_entry_limit", kind: "wire", service: "license"}`. Its description: the 403 above, the flat body, `keyEntries`, and `manageUrl` while the portal is on. It is never sent to an enrolled device, it is not an auth failure, and it comes from PX-W9.
- **`enums.json`** `activationResult` gains `key-entry-limit`, after `enroll-disabled`.
- **Copy: eight files.** These are `copy.en.json` and its seven translations (`de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`). Each gains `codes.key_entry_limit` and `activation["key-entry-limit"]`:
  - title: "No key entries left";
  - message: "This key has no entries left in {product}. Add it to your account and {product} signs you in instead."

  This is SIGN-IN `signin.key.noEntries`, using the allowed `{product}` placeholder. `copyVersion` stays 1.

- **Generated (rule 3).** `pnpm gen:constants` regenerates `constants.generated.*` and `copy.generated.*` in all six SDKs, and PX-W9 commits them. Every SDK built from that commit then shows this copy for `refused{key_entry_limit}` (its "a known code arriving bare reads its own copy" rule), before PX-W9b.
- **`shared-catalog`:** no change.
- **`shared-manifest`:** no change, so there is no rule 9 entry. I-09 owns `identity.keyEntryLimit` and `invalid_identity_key_entry_limit`.
- **Settings (ST-03's entries; PX-W9 wires them).**
  - **Product `identity.keyEntry.limit`** (`services/identity/settings.ts`): `readers: ["core/keyEntries.ts"]`, and `pending` becomes `{wp: "ST-04"}`, because console writes need `writeSetting()` (§8 Q2). The description and the platform ceiling's description say "a licence that is in no account" instead of "floating licence" (§8 Q3).
  - **Platform `identity.keyEntryRefusals`** (`core/settings/platform.ts:235`) becomes an A-13 store entry:
    - `aliases` and `storage.storedAs` set to `IDENTITY_KEY_ENTRY_REFUSALS`, and `varName` set to the same name;
    - `readers: ["core/keyEntries.ts"]`, with `pending` removed;
    - `PlatformSettingKey` and `PlatformSettingValues` gain the key;
    - `Env` gains `IDENTITY_KEY_ENTRY_REFUSALS?: string` (`@editable`).

    I-09 adds its own reader later.

## 4. Corpus, transcripts and parity

**Signed corpus: none.** `pnpm gen:corpus -- --check` stays green, with no `tools/sign-corpus.ts`, constant or mirror change.

**Transcripts.**

- A new scenario, `packages/worker/test/transcripts/scenarios/keyEntry.ts`, is registered in `scenarios/index.ts`. It runs on `productWorld(servicesOn("license", "config", "identity"))`.
- The limit and the switch are fixture rows in `product_settings` and `platform_settings`.
- The other device's entries are seeded between steps, as `license-device-limit.json` seeds its seat.
- Each transcript has `features: ["license.activate", "identity.keyentry"]` and `requires: ["core.store"]`.
- The `expect` keys are `result`, `keyEntries`, `manageUrl`, `licenseStatus` and `tokenHeld`.
- `pnpm gen:transcripts` writes the files and the mirrors (`sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/`, `sdks/godot/tests/transcripts/`).

| File                         | Steps                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keyentry-limit.json`        | Limit 2, switch on. Activate → `ok` `{1,2}`; again (enrolled) → `ok` `{1,2}`; a second device's entry seeded and this device removed → `key-entry-limit`, `manageUrl` `…/activate?product=djdl`, `{2,2}`, no token; limit raised to 3 → `ok` `{3,3}` |
| `keyentry-refusals-off.json` | Limit 1, switch off, one entry seeded → `ok` `{2,1}`: counted past the limit, never refused                                                                                                                                                          |
| `keyentry-identity-off.json` | Identity off, limit row 1, one entry seeded → `ok`, `keyEntries: null`                                                                                                                                                                               |

Every existing transcript stays byte-identical. That is the "installs unaffected" proof: no current scenario activates by key on an Identity-on product.

**Parity.** `conformance/parity/features.json` gains two rows, with a `planned` entry (`wp: "PX-W9b"`) in all six `parity.json`:

- **`identity.keyentry`**: family `devices`, proof `transcript`, no N/A. I-09 later extends its note to cover `license_owned`.
- **`ui.kit.keyentry`**: family `ui`, proof `snapshot`. `allowedNa` is `headless` (`runtime`) for Node and Python. It covers the meter line and the refusal screen.

## 5. SDKs and UI kits, in order (PX-W9b)

PX-W9b depends on PX-W9 and PX-W8. Each SDK must:

- replay the three transcripts and flip both rows to `implemented` (the replayers' `@pkey-feature identity.keyentry`);
- pass `parity:check` and `gen:constants -- --check`;
- never wipe state or retry on the refusal, and repeat client-core's table.

**Headless, every SDK:**

- the `ok` result gains `keyEntries`;
- a new outcome `key-entry-limit {code, manageUrl?, keyEntries?}`, read through `readManageUrl` and `readKeyEntries`.

**Kits:**

- **Success line.** "{left} key entries left" (`signin.key.entriesLeftShort`).
- **Refusal screen.** The title and body are the core copy above. It has **Add it in Polaris Key**, which opens `manageUrl` through `withManageKey` and `withManageReturn`, as a button. On a TV or console, or when a joypad is the only input, it shows a QR code without the key (§5.3 rule 5). It also has **Use a different key**.
- **Not in PX-W9b.** The primary **Sign in** belongs to I-10a and I-10b, because it needs I-08.
- **New kit copy.** `keyEntryLimit.manage` and `keyEntryLimit.scan` go into `packages/brand/kit-copy/en.json` and its eight packs (`de`, `es`, `fr`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`), then `pnpm gen:brand`.

| #   | SDK         | Headless files                                                                                                                                                                                                    | UI kit                                                                                                    |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0   | client-core | `src/keyEntries.ts`: `readKeyEntries(body): KeyEntries \| undefined` (top level, else under `error`; safe integers, `used ≥ 0`, `limit ≥ 1`) and `keyEntriesLeft`; table `test/keyEntries.test.ts`                | none                                                                                                      |
| 1   | Node        | `src/license/endpoints.ts` (`ActivationResult`, `KIND_BY_CODE`), re-exports in `src/index.ts`, `src/cli/commands.ts` prints the count left and the link                                                           | N/A `headless`                                                                                            |
| 2   | React       | `src/core/activation.ts` (`classifyActivation`), `src/core/types.ts`, `src/browser/browserAdapter.ts` (the 201 `keyEntries`), `src/desktop/bridge.ts` and `src/desktop/desktopAdapter.ts`, the `useLicense` state | `src/components/PolarisLogin.tsx`                                                                         |
| 3   | Python      | `license/endpoints.py` (`ActivationResult.key_entries`, kind `key-entry-limit`), `core/key_entries.py`, `cli/core.py`                                                                                             | N/A `headless`                                                                                            |
| 4   | Swift       | `PolarisKeyCore/KeyEntries.swift`; `PolarisKeyLicense/Endpoints.swift` `.ok(token:schemaVersion:keyEntries:)` and `.keyEntryLimit(manageURL:keyEntries:)` (source-breaking; 0.x release note, as PX-W8)           | `PolarisKeyUI/PolarisLoginView.swift` (QR on tvOS)                                                        |
| 5   | Godot       | `core/key_entries.gd`; `services/license/activation_result.gd` (`KIND_KEY_ENTRY_LIMIT`, `key_entries` Dictionary), `services/license/endpoints.gd`                                                                | `addons/polaris_key/ui/activation/activation_controller.gd`, `pkey_activation_panel.gd` (QR, joypad only) |
| 6   | Kotlin      | `core/…/KeyEntries.kt`; `license/…/LicenseEndpoints.kt` `Ok(…, keyEntries: KeyEntries? = null)` and `KeyEntryLimit(manageUrl, keyEntries)` (source-compatible); `:conformance` `TranscriptTest`                   | `ui/…/PolarisGate.kt` (QR on Android TV)                                                                  |

The order is the parity order, and Godot may go first. Each SDK's licensing guide gains a section, "When a key has no entries left".

## 6. Worker (PX-W9)

**Migration `00XX_license_key_entries.sql`** (the lead assigns the number).

- Columns: `product TEXT NOT NULL REFERENCES products(slug)`, `license_id`, `id` (`ke_…`), `surface CHECK (surface IN ('app','browser','portal'))`, `device_id NULL` (NULL for `portal`), `created_at`.
- `PRIMARY KEY (product, license_id, id)`. Its prefix serves the count.
- Expand-only, with no backfill. Rollback: `DROP TABLE`.
- Same change:
  - `LATEST_MIGRATION` (`core/deployIdentity.ts:19`);
  - `TABLE_OWNERS.core` in `packages/docs/scripts/gen-reference.mjs`, beside `license_refusals`;
  - `core/licenseDelete.ts` deletes the rows with the licence. An LX-03 merge leaves them on the retired licence.

**Core `core/keyEntries.ts`** (rule 6: License and Identity's portal both call it).

- `keyEntryLimit(db, product)` reads the `product_settings` row (1–100), else 10, capped at `KEY_ENTRY_LIMIT_MAX`. ST-04 later swaps the body for `resolveSetting()`, and I-09's discovery member calls the same function (§8 Q2).
- `keyEntryState(db, product, licenseId)` answers `{used, limit}`, or `null` when Identity is off (`core/identityGate.ts` `identityEnabled`).
- `keyEntryRefusalsOn(env, db)` reads the A-13 switch.
- `stmtRecordKeyEntry(…)`.

**Atomicity.**

- `authorizeDevice` (`core/authz.ts:310`) gains `opts.keyEntry?: {surface: "app" | "browser"}`.
- On `isNewAuthorization` (`:389`), `claimDeviceSeat` runs its seat `INSERT` and a guarded entry `INSERT` in one batch. The guard is `WHERE EXISTS`: the device row now holds the claimed seat ordinal for this licence. A UNIQUE loss rolls both back, and an already-held seat writes no entry.
- Adopting a pre-`seat_no` authorised device is not new, so it is not counted.
- The refusal is logged through UX-15's `logRefusal`, with `RefusalReason` gaining `key_entry_limit`.

**Call sites.**

- `services/license/activation.ts` `activateWithKey`:
  - steps 2 and 4, then `authorizeDevice(…, {keyEntry: {surface: "app"}})`;
  - the refusal goes through `errorResponse(403, "key_entry_limit", …)` and `buildManageUrl(…, {kind: "key_entry_limit"})`;
  - `keyEntries` goes on the 200.
- `services/identity/browserSession.ts`:
  - `handleBrowserSessionLicense` (`:340`) runs the same steps and passes `keyEntry` through `createBrowserSession` (`:104`);
  - the 201 becomes `{ok: true, keyEntries}`;
  - the OIDC caller (`oidc.ts:2049`) never passes `keyEntry`.
- `services/identity/portal/selfService.ts`:
  - the preview (`:280`) answers `keyEntries` in place of `entries: null`;
  - `handleClaimKey` records a `portal` entry after `attachLicense` returns `ok`, never on `already_yours` or a refusal, and answers `keyEntries` (Identity on only).
- **New `handleKeyPreview`**, `POST /api/key/preview`, dispatched beside the card's pre-authentication routes (`portal/api.ts:1307`):
  - signed out and read-only, so it never counts;
  - it charges the IP bucket `portalKeyPreview` (10 per minute);
  - it answers `{product, verdict: "addable" | "license_owned" | "portal_off", license: {tierName, term} | null, keyEntries | null, upgrade}` (§8 Q4, Q5), and `422` / `401` / `429` as the claim does;
  - it never answers an email, a masked email, a licence id, devices or an account.
- **Console:**
  - `admin/lib/shape.ts` adds `keyEntries` to the licence record (`null` with Identity off);
  - `packages/admin/src/portal/api.ts` adds types only (`PortalKeyPreview.keyEntries` and the signed-out preview). No UI changes in this package (PX-12, LX-30).

**Rule 10.** `packages/worker/openapi/polaris-key.v3.yaml` gains:

- a `KeyEntries` component;
- `keyEntries` on `/{product}/license/activate` 200 (`:1019`) and `/{product}/identity/session/license` 201 (`:6640`);
- the `key_entry_limit` 403 on both;
- `keyEntries` on the admin licence GET;
- `/api/key/preview` (tag `portal`), plus its `routeCoverage.test.ts` `PORTAL_KIND_PATHS.portalApi` entry.

**Docs and threat model.**

- Docs: `services/license/activation.md`, `services/identity/index.md` and `services/identity/portal.md`.
- `start/concepts.md`: **key entry** gains the D20 rule and **key-entry limit** is added (rule 4).
- `THREAT-MODEL.md` gains a section, "Key-entry counting and the signed-out key preview (PX-W9)", covering:
  - a key holder burning entries with random device ids (bounded at 30/min/IP, and it hurts only that licence);
  - preview enumeration (the whole 128-bit key, an IP bucket, no personal data);
  - the race overshoot.

## 7. Rollout, and what deployed clients see

1. **PX-W9 deploys.**
   - Counting goes live on Identity products from 0.
   - `keyEntries` appears in the responses, and PX-17's entries notice starts working.
   - Refusals stay off.
2. **PX-W9b releases** the SDKs through the normal publish.
3. **The later packages land.** I-09 adds `license_owned` and the discovery `keyEntryLimit`. ST-04 adds console writes. I-08, I-10a and I-10b add **Sign in**.
4. **An operator turns on `identity.keyEntryRefusals`** after steps 2–3 have shipped and the I-19 docs have warned developers.

**Deployed clients:**

- **Old SDKs** ignore the member, which PX-W8's unknown-member unit tests already pin.
- **With the switch on:**
  - SP-pass builds show `refused{key_entry_limit}` with the catalog copy, or with the fallback that names the code if they were built before PX-W9;
  - pre-SP builds show device-limit copy;
  - none of them wipes state.
- **New SDKs on an old Worker** show no meter and get no refusal.
- **Installs are untouched.** Enrolled devices are never counted or refused, refresh, token, grace and documents do not change, and document bytes are unchanged with counting on, including `legacy` mode.
- **The portal SPA ships with the Worker.**
- **Rollback.** The old Worker ignores the table, and entries made in that window are not counted, which is harmless.

## 8. Open questions (the lead answers under the owner's delegation)

1. **SDK split.** Revision 1 left the SDK half to I-10a and I-10b, which wait on I-08 and I-09. **Recommend** a new **PX-W9b**:
   - role `pkey-sdk-porter`, lane `sdk`, 0.8–1.2 weeks;
   - deps PX-W9 and PX-W8, `planMode: true`, `planRef: PX-W9`;
   - gates `plan-mode`, `all-sdks`, `drift-gate`, `ui-snapshots`, `ci:macos` and `ci:android`;
   - scope: §5.

   I-10a and I-10b then keep `license-owned`, attach and the refusal screen's **Sign in**, and gain the dependency PX-W9b.

2. **The limit before ST-04.** **Recommend** a narrow Core reader, `keyEntryLimit()` over `product_settings`, defaulting to 10. ST-04 swaps its body later. Keep `pending: {wp: "ST-04"}` so the console offers no write it cannot do. This keeps PX-W9 off ST-04. The alternative is to add ST-04 as a dependency.
3. **The holder model (LX-26).** **Recommend:**
   - count every successful entry whatever the holder (revision 1 Q6);
   - apply step 4 to any licence with `account_id IS NULL`, whether floating or assigned and waiting;
   - in-account licences meet I-09's `license_owned` first;
   - registry descriptions say "a licence that is in no account".
4. **When the portal forces the upgrade.** **Recommend** `upgrade: "forced"` only when `used ≥ limit` **and** the switch is on. Otherwise answer `skippable`, because with the switch off the app accepts the key and "From now on … through an account" would be untrue.
5. **What the signed-out preview shows.** Revision 1 said "never terms or ownership". SIGN-IN §3.9 shows the tier, the term and a `license_owned` verdict before sign-in. **Recommend SIGN-IN:**
   - include `tierName`, `term` and the generic `license_owned` verdict, which says only that the key is in an account;
   - never include an email, masked email, licence id or devices;
   - `email_mismatch` stays a signed-in verdict.

   Activation by key already returns more than this to the key holder (S-24 H6).

6. **Pinning the client rule.** **Recommend** client-core's `test/keyEntries.test.ts` table, repeated by every SDK, as PX-W8 did for `readManageUrl`. The corpus stays untouched. The alternative is a corpus matrix, `key-entries.json`, which would bring a generator change, mirrors and every runner.
7. **Per-licence override, reset and the console.** **Recommend** none in PX-W9:
   - no per-licence limit and no reset; operators raise the product limit;
   - the console's "Key entries 3 of 10" row goes to LX-30's record holder line, from `keyEntries`;
   - a reset action stays a later request.

**Risks.**

- The batch change touches `claimDeviceSeat`, which is on the hot path. Mitigations: a concurrency test (N parallel new devices → rows equal successes; N parallel calls from one device → one row) and the refresh and grace regression transcripts.
- The browser surface counts once per licence enrolment (a fact, not a defect).

**Brief changes (the lead makes these after the answers):**

- **PX-W9**:
  - scope as in §2–§4 and §6;
  - Unblocks gains PX-W9b;
  - gates gain `drift-gate`, `rule-10`, `threat-model` and `corpus` (transcripts).
- **New PX-W9b** brief and `workpackages.json` entry (Q1).
- **I-09**:
  - drop `keyentry-refusals-off.json`;
  - read the switch that PX-W9 wired;
  - its discovery member calls `keyEntryLimit()`.
- **I-10a and I-10b**: per Q1.
- **I-08**: `{kind: "key"}` records one `app` entry.
- **PX-12**: the preview body and `upgrade` (Q4, Q5).
- **ST-04**: replaces `keyEntryLimit()` and clears `pending`.
- **LX-30**: Q7.
- **LX-09**: a counted key-entry device in its byte-identity snapshot.
- **I-19**: the switch and the limit.

## 9. Acceptance

```sh
N="mise exec node@22 --"
# PX-W9
$N pnpm build && $N pnpm typecheck
$N pnpm gen:corpus -- --check            # unchanged
$N pnpm gen:transcripts -- --check       # three new files + Swift/Godot mirrors; all others byte-identical
$N pnpm gen:constants -- --check         # errors.json, enums.json, 8 copy packs → six SDKs
$N pnpm gen:settings -- --check && $N pnpm gen:platform-inventory -- --check
$N pnpm parity:check                     # identity.keyentry, ui.kit.keyentry planned ×6
$N pnpm --filter @polaris-key/cli bundle:action -- --check
$N pnpm --filter @polaris-key/worker test -- keyEntries portal routeCoverage boundaries settings platformInventory licenseDelete
$N pnpm --filter @polaris-key/worker typecheck:workerd && $N pnpm --filter @polaris-key/worker test:workerd
$N pnpm --filter @polaris-key/admin build && $N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
$N pnpm test && $N pnpm lint && $N pnpm format
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
# PX-W9b, in addition
$N pnpm --filter @polaris-key/client-core test && $N pnpm gen:brand -- --check && $N pnpm ui:lint && $N pnpm ui:report
( cd sdks/python && .venv/bin/python -m pytest -q ); ( cd sdks/swift && swift test ); sdks/godot/tools/run_tests.sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :core:test :license:test :sdk:test :conformance:test )
```
