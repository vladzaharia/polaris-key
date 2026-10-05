# PX-W9 plan: key-entry counting (G21)

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

**Effect on this plan.** Q3 is overridden: `key_entry_limit` carries `manageUrl` (corrected in
place). The PX-W8 builder emits it. PX-W9 gains the dependencies ST-01b and ST-03. It executes this
plan rather than I-04's (`planRef` removed). The precondition branch `wp/S-18-S-19-decisions` has
merged (`248fef64`). On Q2, the SDK may add the key as a `#key=` fragment (PX-W8 Q2), and PX-17's
field is empty only without one.

> **Approved by the owner (2026-10-05)**; see "Owner decisions (2026-10-05)" above. As first written: PX-W9's brief
> says it "executes the approved `plans/I-04.md`". This plan does not reopen I-04. It reconciles
> PORTAL.md G21 with I-04 §2.2 and with the S-18 and S-19 owner decisions, and it fixes the split
> with I-09, which the brief left to "whichever lands first". The questions are in §8.

| Field        | Value                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief        | [`wp/PX-W9-key-entry-counting.md`](../wp/PX-W9-key-entry-counting.md); [PORTAL.md](../../../../design/PORTAL.md) §3.1, §4.5–4.6, §4.19, §10.2 G21; [`plans/I-04.md`](I-04.md) §2.2, §4, §7; notes S-16, S-17, S-18, S-19                                                                                 |
| Implementer  | **PX-W9** (`pkey-implementer`) executes §2–§6. **I-09** keeps the rest of I-04 §2.2–2.3 (§8 Q1). The SDKs follow in **I-10a** and **I-10b**; PX-W8 adds the deep-link member                                                                                                                             |
| Wire change  | Inside wire v4. **`PROTOCOL_VERSION` stays 4** and `corpusVersion` does not change. There is no new `typ`, claim or signed shape. Changes: one refusal code (`key_entry_limit`) and one unsigned response member (`keyEntries`), both already named by I-04. Everything is additive and feature-detected |
| Corpus       | **None.** The signed corpus is untouched. The evidence is two HTTP transcripts, a parity row and tests                                                                                                                                                                                                   |
| Precondition | The S-18 and S-19 decisions sit on the unmerged branch `wp/S-18-S-19-decisions` (`3a367634`). The lead merges that branch before PX-W9 starts. PX-W9 also gains the dependencies **ST-01b** and **ST-03**, the same ones that branch gives I-09                                                          |
| Line refs    | `main` at `8c28e023`. After a rebase, re-locate each reference by its quoted text                                                                                                                                                                                                                        |

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that sign-in shows a **Choose a licence for this device** step and
can replace a device inline. The full text is in [`plans/I-04.md`](I-04.md), "Owner decision
(2026-10-05): licence choice at sign-in". **Effect on this plan:** none on the wire or on the
counter. These rules are added to §12.2's list of things that never count:

- choosing a licence at sign-in;
- **Keep the licence this device uses**;
- **Create a new free licence**;
- replacing a device from the card.

A licence added through the card's KeyStep counts once, as a `portal` submission (D20), exactly as
today. `keyEntries` is never shown in the chooser, because it belongs to the key, not to the seat.

## 0. Owner decisions encoded (binding)

- **S-16 / I-04.** The decisions that apply here:
  - **D20**: a key entry counts only when it enrols a new device or is a portal Activate License
    submission.
  - **Q5**: a race at the last free entry may go slightly over the limit.
  - **Q7**: the limit defaults to 10, ranges from 1 to 100, and has no "unlimited" value while
    Identity is on.
  - **Identity toggle**: counting, the limit and the refusal exist only while the product's
    Identity toggle is on.
  - **Refusal switch**: the platform switch `identity.keyEntryRefusals` stays off until the SDKs
    ship. Counting runs whatever the switch says.
  - **Existing installs** are never affected.
  - **No key in URLs**: neither refusal URL carries the key.
- **S-17.** Key entry never sets `devices.subject`. Cloud Sync's principal is unaffected.
- **S-18.** The limit is a claimable `product_settings` row, `identity.keyEntry.limit`:
  - `allowUnset: false`;
  - a platform `max` policy bound;
  - `wire: ["discovery", "refusal"]`;
  - `visibleWhen` Identity.

  `identity.keyEntryRefusals` is a platform registry switch. No `identity_product_settings`
  table is created. The resolver call that enforces the limit is the same call that publishes it
  (`resolveSetting()`).

- **S-19 (model OC).** A **licence is the access contract**, and the counter belongs to it:
  - It counts per licence, never per key, per grant or per account.
  - **Grants** (store, comp, trial, bundle, redeem, OIDC) never count.
  - The **holder is the account signed in on the device** (`entitlementHolder: device`):
    - Sign-in, attach, Discover and anchor-chosen bindings are not key entries.
    - A key-entry device runs on the entered key's licence and sees only that licence's slice.
  - **Legacy mode is byte-identical.** With `entitlementModel: legacy`, no licence document byte
    changes because of counting. `keyEntries` lives only in unsigned HTTP bodies.

## 1. Summary

- **One Core counter.** `license_key_entries` is an insert-only row per counted entry. It is
  written only through `core/keyEntries.ts` and read as `{used, limit}`. It counts on three
  surfaces: `app` (`POST /<p>/license/activate`), `browser` (`POST /<p>/identity/session/license`)
  and `portal` (`POST /api/claim/license-key`).
- **Device wire (I-04's names, unchanged).**
  - On success, a key activation answers `"keyEntries": {"used": n, "limit": n}`.
  - Past the limit it answers `403 {"error":"key_entry_limit","manageUrl":…,"keyEntries":{…}}`,
    only while `identity.keyEntryRefusals` is on.
  - A product with Identity off sees no change.
- **Portal responses (narrative-only).**
  - The `/api/activate/preview` placeholder `entries: null` (left by PX-W5) becomes
    `keyEntries: {used, limit} | null`.
  - The claim answer carries `keyEntries`.
  - A new signed-out, read-only `POST /api/key/preview` feeds PORTAL §4.6's meter and its
    skippable/forced choice (§8 Q4).
  - The portal never refuses a signed-in claim for the limit (§4.19: a warning, not a block).
- **Order:** this plan → migration and Core counter → call sites → `errors.json` and transcripts →
  I-10a (Node, React, Python) and I-10b (Swift, Godot, Kotlin) with the four UI kits.

## 2. Contract

- **`WIRE-CONTRACT-V4.md` §12.2 "Key entry"** is written by PX-W9 exactly as I-04 §2.2 has it,
  steps 2, 4 and 5. If I-09 has not opened §12 yet, PX-W9 opens it with only §12.2, and I-09 adds
  §12.1 and §12.3. The §12.2 text records three rules:
  - an **enrolled** device never counts;
  - **refused or failed attempts never count**;
  - **refresh, offline grace, documents, `license/enroll`, store binding and sign-in activation
    never count**.
- **`shared-protocol`.** PX-W9 creates the subpath `@polaris-key/protocol/identity` if I-09 has
  not:
  - files: `src/identity.ts`, the `package.json` `exports` entry, and the layout pinned in
    `test/exports.test.ts`;
  - types: `KeyEntries {used: number; limit: number}` and `KeyEntryLimitBody`;
  - constants: `KEY_ENTRY_LIMIT_DEFAULT = 10`, `KEY_ENTRY_LIMIT_MIN = 1` and
    `KEY_ENTRY_LIMIT_MAX = 100`, which the settings registry and I-09's manifest rule import;
  - `PolarisErrorCode` (`src/core.ts`) gains `key_entry_limit`.
- **`shared-jws`, `client-core`:** no change. No signed shape moves, `PolarisError.code` already
  accepts unknown strings, and an unknown response member passes through.
- **Body shape.** The refusal uses the **flat** body that `license/activate` already emits, as
  `device_limit` does (`core/errors.ts`). `manageUrl` is built from the Worker's own origin and
  never carries the key. Its target is the PORTAL §3.3 route `/activate?product=<slug>` (§8 Q2).
- **Deployed clients:**
  - Old SDKs ignore `keyEntries`. They meet the refusal only after an operator turns the switch
    on, which happens after I-10a and I-10b ship.
  - An old Node SDK maps an unknown 403 to `device-limit` (`sdk-node/src/license/endpoints.ts:76-91`).
    The copy is wrong, but no state is lost.
  - New SDKs on an old Worker never see `keyEntries` and show no meter.

## 3. Catalog, manifests and settings

- `shared-catalog`: no change.
- `shared-manifest`: no change in PX-W9. The `identity:` block and
  `invalid_identity_key_entry_limit` stay with I-09, which owns the whole block's rule 9 table.
- **Settings (ST-03 registry):** PX-W9 registers two entries.
  - `identity.keyEntry.limit`: product scope, claimable, integer 1–100, default 10,
    `manifest.path: identity.keyEntryLimit`, `policyBound: "max"`, `widensWhen: "higher"`.
  - `identity.keyEntryRefusals`: platform scope, switch, default off, L1 both ways.

  Until I-09's validator accepts the manifest path, the effective value is the console or platform
  value, or the default of 10. Gate: ST-04's discovery-vs-enforcement test, and
  `gen:settings -- --check` if ST-06 has landed.

## 4. Corpus, transcripts and parity

**No signed-corpus change.** `pnpm gen:corpus -- --check` stays green with no generator, constant
or mirror edit. The transcripts are recorded by `pnpm gen:transcripts` from
`packages/worker/test/transcripts/scenarios/license.ts`, and that command also writes the Swift and
Godot mirrors. These two files move from I-09 to PX-W9 (I-04 §4):

| File                         | Steps                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `keyentry-limit.json`        | Limit 2, refusals on. A → `{1,2}`; A again → `{1,2}` (enrolled); B → `{2,2}`; C → `key_entry_limit` + `manageUrl`; A again → 200 |
| `keyentry-identity-off.json` | Identity off. No `keyEntries`. Activations past the "limit" succeed                                                              |

- The existing refresh, token and offline-grace transcripts stay byte-identical. That is the
  "installs unaffected" proof.
- `errors.json` (`kind: wire`) gains `key_entry_limit`: 403, service `license`, WP PX-W9.
- PX-W9 adds the parity row `identity.keyentry` (`conformance/parity/features.json`; proof:
  transcript) with `planned` entries in all six `parity.json`. The entries point at
  `wp: "I-10a"` (Node, React, Python) or `wp: "I-10b"` (Swift, Godot, Kotlin). I-09 later extends
  the same row with `license_owned`.

## 5. SDKs and UI kits, in order

Each SDK replays §4's transcripts and passes `parity:check` and `gen:constants -- --check`. None
treats the refusal as an auth failure: no wipe, no retry. The client code is `key-entry-limit`
(I-04 §4).

1. **Node** (`packages/sdk-node` over `client-core`), **I-10a**:
   - `activate` returns `keyEntries`;
   - the outcome is `key-entry-limit {manageUrl, keyEntries}`.
2. **React** (`packages/sdk-react`; `client-core` unchanged), **I-10a**: the hook result, plus
   the activation component's "N activations left" meter and its refusal screen with QR.
3. **Python** (`sdks/python`), **I-10a**: `key_entries`.
4. **Swift** (`sdks/swift`) with **`PolarisKeyUI`**, **I-10b**.
5. **Godot** (`sdks/godot`) with **`addons/polaris_key/ui`**, **I-10b**: `key_entries` as a
   `Dictionary`.
6. **Kotlin** (`sdks/kotlin`) with the **Compose activation component**, **I-10b**.

- **UI kits:** the parity row `ui.kit.account` (I-04) covers the React, SwiftUI, Compose and Godot
  kits. Node and Python have the typed N/A `allowedNa: headless`.
- **PX-W8** separately threads its deep-link member through the same six SDKs.

## 6. Worker

- **Migration.** `00NN_license_key_entries.sql` takes the next free number at the final gate
  (main's highest is `0071`). It is expand-only and reversible:
  - columns: `product`, `license_id`, `id` (`ke_…`),
    `surface CHECK (surface IN ('app','browser','portal'))`, `device_id NULL` (NULL for portal),
    `created_at`;
  - `PRIMARY KEY (product, license_id, id)`, whose prefix serves the count;
  - the same `ON DELETE CASCADE` to `licenses` that `devices` uses.

  It needs no backfill: every licence starts at 0 used, and devices enrolled before the
  migration are never counted retroactively. `TABLE_OWNERS` gains
  `license_key_entries: license` in `packages/docs/scripts/gen-reference.mjs` and the Worker's
  boundaries table, in the same commit.

- **Core** `core/keyEntries.ts` (rule 6: Identity's portal never imports License):
  - `keyEntryState(db, product, license)` returns `{used, limit}`, or `null` when Identity is off;
  - `recordKeyEntry(db, {product, licenseId, surface, deviceId, now})`.

  `recordKeyEntry` runs in the **same `db.batch`** as the device-row write in `authorizeDevice`,
  which makes the count exactly-once per success. The limit check is a read before that batch, so
  a race can overshoot by the number of racing requests (Q5).

- **Call sites:**
  - `services/license/activation.ts` (`activateWithKey`): steps 2, 4 and 5;
  - `services/identity/browserSession.ts` (session/license): the same steps;
  - `services/identity/portal/selfService.ts`: - the preview replaces `entries: null` with `keyEntries`; - the claim records a `portal` entry after `attachLicense` returns `ok`, but not on
    `already_yours` or on any refusal; - the new `handleKeyPreview` is signed out, read-only and never counts. It costs an IP rate
    bucket with the same limit as `portalClaimKey` and returns `{product, keyEntries, upgrade:
"skippable"|"forced"}`, never terms or ownership;
  - `admin/lib/shape.ts`: the licence record gains `keyEntries` (the console count I-09 named);
  - `packages/admin/src/portal/api.ts`: `PortalKeyPreview.keyEntries` (type only; the UI belongs
    to PX-12 and PX-17).

  A licence that is already owned shows no meter in the Library, because owned licences refuse
  key entry on new devices (D24).

- **Rule 10:**
  - `packages/worker/openapi/polaris-key.v3.yaml` gains `keyEntries` on the activation response
    and the `key_entry_limit` 403 on both device routes;
  - the portal routes go on `packages/docs/src/content/docs/services/identity/portal.md`;
  - the `routeCoverage` `portalApi` set gains `key/preview`.
- **THREAT-MODEL:** I-04's item 5 gains a row for the signed-out preview (enumeration). It needs
  the whole 128-bit key, as the PX-W5 preview does, and charges an IP bucket.

## 7. Rollout

1. Merge `wp/S-18-S-19-decisions`, then ST-01b and ST-03.
2. Ship the PX-W9 migration and Worker:
   - counting goes live on Identity products;
   - `keyEntries` appears in responses;
   - refusals stay off (the switch);
   - devices see only an extra member.
3. I-09 adds `license_owned`, attach and the discovery `keyEntryLimit`.
4. I-10a and I-10b ship and the SDKs are released.
5. An operator turns on `identity.keyEntryRefusals`, after the I-19 docs have warned developers.

**Rollback:** the old Worker ignores the table and old portal builds ignore the member. Discovery's
300 s cache can advertise a stale limit, but the refusal carries the live value (S-18 §7.1 risk 7).

## 8. Open questions for the owner

1. **Q1 Split with I-09.** **Recommend:**
   - PX-W9 owns the counter, the settings rows, I-04 §2.2 step 4, `keyEntries` everywhere, the
     `key_entry_limit` code, the two transcripts and the portal surfaces;
   - I-09 keeps step 3 (`license_owned`), attach, subject and sign-out, the discovery members and
     the `identity:` manifest block.
2. **Q2 Deep link carries the key?** PORTAL §3.4 says `/activate?key=<key>&product=`, but I-04
   (approved) says no URL carries the key. **Recommend I-04:**
   - `manageUrl` (was `portalUrl`; see Q3) = `<origin>/activate?product=<slug>`. This corrects I-04's `/portal/activate`:
     portal routes are root paths (`dispatch.ts` → `handlePortal`). I-09's `signInUrl` becomes
     `/signin?product=` in the same way;
   - PX-17's modal opens with the §4.18 notice and an empty field, unless the SDK added the key as
     a `#key=` fragment (PX-W8 Q2, accepted 2026-10-05), which never reaches a server.
3. **Q3 Member name.** PX-W8 and G15b call it `manageUrl`; I-04 uses `portalUrl` on
   `key_entry_limit`. The recommendation here was to keep `portalUrl` on `key_entry_limit` and
   put `manageUrl` on `device_limit` only. **Overridden by the owner (2026-10-05):** PX-W8 Q1
   wins, so both refusals carry `manageUrl` and `license_owned` keeps `signInUrl`. The text of this
   plan uses `manageUrl` throughout.
4. **Q4 Signed-out key use (§4.5–4.6).** **Recommend** a read-only preview that never counts. The
   entry counts once, when the claim is submitted after sign-in (D20: a portal _submission_). So:
   - "Skip" counts nothing;
   - the copy "This was entry 3" becomes "This will be entry 3";
   - no ticket is needed to stop a double count.
5. **Q5 Portal names.** G21 uses `entriesLimit`, `entriesUsed` and `entriesLeft`. **Recommend**
   I-04's `keyEntries {used, limit}` on every surface, with "left" computed in the UI. The lead
   amends PORTAL.md G21.
6. **Q6 Which keys count.** **Recommend:**
   - every licence key counts, including S-19 `kind: addon` keys claimed in the portal, against the
     same per-licence limit;
   - LX-25 redeem codes and every other grant never count;
   - a portal claim past the limit still writes its row (for audit), and the UI caps the display
     at `limit`.

**Risks.**

- PX-W9 now waits on ST-01b and ST-03.
- The `db.batch` coupling touches `authorizeDevice`, which is the hot path. The regression suite
  covers it.

**Brief changes (the lead makes these after approval):**

- **PX-W9**: add the dependencies ST-01b and ST-03, set `planRef: PX-W9`, and write the scope
  per Q1.
- **I-09**: narrow it per Q1.
- **PX-W8**: per Q3.
- **PX-12**: the preview route and the copy (Q4).
- **PX-17**: no key in the link (Q2).
- **I-10a, I-10b**: `keyEntries` on success, and the transcript owners.
- **LX-09**: its byte-identity snapshot includes a counted key-entry device.
- **PORTAL.md**: G15, G21, §3.4 and §4.6.

## 9. Acceptance

```sh
N="mise exec node@22 --"
$N pnpm build && $N pnpm typecheck
$N pnpm gen:corpus -- --check          # unchanged: no corpus impact
$N pnpm gen:transcripts -- --check     # two new files, Swift and Godot mirrors; refresh/grace unchanged
$N pnpm gen:constants -- --check && $N pnpm parity:check
$N pnpm --filter @polaris-key/shared-protocol test   # exports layout
$N pnpm --filter @polaris-key/worker test -- keyEntries portal   # concurrency: rows == successes under N parallel activations; never on refused/enrolled
$N pnpm --filter @polaris-key/worker test            # routeCoverage (rule 10), boundaries (rule 6), migration, document bytes unchanged with counting on
$N pnpm --filter @polaris-key/worker typecheck:workerd && $N pnpm --filter @polaris-key/worker test:workerd
$N pnpm --filter @polaris-key/docs gen:check && $N pnpm --filter @polaris-key/docs check:links
$N pnpm test && $N pnpm lint && $N pnpm format
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
```
