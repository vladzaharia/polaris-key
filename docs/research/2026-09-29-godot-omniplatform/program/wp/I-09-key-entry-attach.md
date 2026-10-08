# I-09 license_owned refusal, attach and sign-out (consolidated spec)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                        |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-05](I-05-accounts-core.md), [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md), [ST-04](ST-04-settings-resolver.md), [I-27](I-27-plan-identity-consolidation.md)                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-08](I-08-app-passthrough.md), [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md), [I-24a](I-24a-named-user-seats-server.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md), [LX-10](LX-10-anchor-choice.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                         |
| Plan mode   | yes: executes the approved [`plans/I-09.md`](../plans/I-09.md) (approved 2026-10-05), which refines [`plans/I-04.md`](../plans/I-04.md)                                                                                                                                                                                                                                                                       |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); D1 migration; `TABLE_OWNERS`; THREAT-MODEL                                                                                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                     |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-24.md`](../plans/I-24.md):** the candidate hook in the inline anchor rule (§2.4) that I-24a uses for seat holders.
- **[`plans/I-09.md`](../plans/I-09.md):** approved on 2026-10-05 with every recommendation accepted: a signed-in device that already runs on a usable licence keeps its anchor (Q1); attach never re-anchors in I-09 (Q2); I-09 depends on ST-04 (Q3); counting starts at zero with no backfill (Q4); `identity.keyEntryRefusals` is one platform switch, default off (Q5). Table owner `core`; a new `discovery-identity.json` transcript instead of re-recording `discovery-capabilities.json`; `accountPortal` moves here; the attach transcript is seeded until I-08 re-records it; `identity.keyEntryRefusals` is a platform entry.
- **[`plans/PX-W8.md`](../plans/PX-W8.md) and owner:** `key_entry_limit` carries `manageUrl` (not `portalUrl`), built by PX-W8's `core/manageUrl.ts`; `license_owned` keeps `signInUrl`. The portal paths are root paths: `/activate?product=<slug>` and `/signin?product=<slug>`.
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** Q1 split: PX-W9 owns the counter (`core/keyEntries.ts`), the settings rows, I-04 §2.2 step 4, `keyEntries`, the `key_entry_limit` code and the `keyentry-limit.json` and `keyentry-identity-off.json` transcripts. I-09 keeps step 3 (`license_owned`), attach, subject and sign-out, the discovery members and the `identity:` manifest block.

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package (`plans/I-09.md`, the same-named section):

- **`chooseAnchorInline` becomes `rankAnchorCandidates`.** It returns the ordered candidates with
  their seat state, plus `keep`, `create` and `preselected`.
- **`bindSignedInDevice(…, choice)`** binds only to the explicit choice. The auto-issue mint runs
  only when there are no candidates, or on `kind: "create"`.
- **Q1 sets only the preselected row.** Attach is unchanged on the wire.
- I-08 registers `license_choice_required`.
- **Acceptance (additions).**
  - A test that no second auto-issued licence is minted while a usable one exists.
  - A test that `rankAnchorCandidates` lists full licences as `full`, without hiding them.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- `rankAnchorCandidates` marks the device's own candidate `current` and sets `keep` only for a licence outside the candidates; preselection is the current row, else Keep, else the first free row; a higher rank is never preselected over the current licence (`plans/I-04.md` §F.1–§F.2, `plans/I-09.md`).
- **Sign-in licences** (§F.6): `licenseAccess(db, license)` in `core/anchor.ts`, the fact behind the origin "From signing in" and the mixed rule, never a displayed type (owner decision 2026-10-05: no 'Account-wide' label; origin shown as plain words, store named with the key); `access` on `shapeLicenseSummary`; the library seats keep the real limit. **Owner decision (2026-10-05): sign-in licenses stay device-limited**, so `authorizeDevice` does not change and no sign-in-licence THREAT-MODEL row is needed.
- A Replace runs `freeAccountDevice()`'s statements and the guarded seat claim in one batch (§F.3).

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **The product's terms reach the gate through this package** ([PX-W15](PX-W15-email-gate.md)).
  `beginProviderSignIn` (`card/gate.ts`) takes `product: { slug, tenantScopes, terms }`, but no
  front door passes terms yet, so the gate's terms step runs only in tests. This package persists
  `identity.requireTerms` (manifest `identity:` block → `identity_product_settings`). Give it a
  reader that answers a `TermsRequirement` (`{ url, version }`, `accounts/terms.ts`) or `null`, and
  pass it as `product.terms` wherever a product-context sign-in starts from this package's surfaces
  (the `signInUrl` card). I-08 does the same for passthrough. Acceptances live in
  `account_terms_acceptances`, never in `accounts.terms_json`.
- **Call `onAccountEmailVerified` where an address is verified** ([LX-26](LX-26-licence-holders-worker.md)).
  The hook (`core/licenseHolders.ts`) attaches the licences waiting on that address. On `main`,
  every sign-in reaches it through the link sweep (`syncAccountLicenseLinks`, run by `finishSignIn`,
  the portal OIDC callback and device login), `linkIdentity` calls it directly, and the portal API
  also runs the sweep on every request (`handlePortalApi`, `handleMe` and `handleLicenses` in
  `portal/api.ts`). Each verification point this package adds calls the hook directly. Once every
  point outside a sign-in does (add-email, PX-W12; this package's and I-08's), drop the
  per-request sweep from `portal/api.ts`; the per-sign-in sweeps stay. Whichever of I-08 and I-09
  lands second makes the drop.

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **`keyentry-refusals-off.json` moves to PX-W9.** It is a counter transcript. I-09 keeps
  `keyentry-owned.json` and its attach, subject and sign-out transcripts.
- **The refusal switch is already wired.** PX-W9 makes `identity.keyEntryRefusals` an editable platform setting
  (`IDENTITY_KEY_ENTRY_REFUSALS`), read in `core/keyEntries.ts`. I-09 adds its own reader for step 3
  (`license_owned`) and does not register or wire the switch again.
- **§12.2 already exists.** PX-W9 writes WIRE-CONTRACT-V4 §12.2 with step 3 reserved. I-09 inserts `license_owned`
  there, and writes §12.3 onwards.
- **The discovery member.** `keyEntryLimit` calls PX-W9's `keyEntryLimit()`, so the value published is the value
  enforced. ST-04 later replaces that function's body.
- **Step 3 comes before step 4.** Step 4 applies to any licence with no account (floating, or assigned and waiting;
  PX-W9 Q3). An in-account licence meets `license_owned` first.
- **Already registered by PX-W9.** `errors.json` `key_entry_limit`, `enums.json` `key-entry-limit`, and the parity
  rows `identity.keyentry` and `ui.kit.keyentry`. I-09 extends the `identity.keyentry` note with `license_owned`
  and registers only its own codes.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> One consolidated spec. Implements the identity.keyEntry setting in the key shape I-27's plan specifies (claimByKey moves there); I-35 later adds only the manifest block. license_owned semantics unchanged and default off here; LX-39 flips it per product. Attach unchanged. Second in the W-ID train, before I-08; wave 7.

- Title: was "Key-entry refusal `license_owned` with `signInUrl`, attach, subject and sign-out on the device wire (`POST /<p>/identity/attach`), discovery fields and the `identity:` manifest block; the entry counter and `key_entry_limit` with `manageUrl` ride PX-W9; all only behind the product's Identity toggle".
- Depends on: added I-27.

## Goal

Key entry becomes a bounded on-ramp: each licence counts key entries against the product's `keyEntryLimit`; past the limit activation by key returns `key_entry_limit` with a Worker-built `manageUrl`; key entry of an owned licence on a new device returns `license_owned` with `signInUrl`; a signed-in device can attach its floating licence with `POST /<p>/identity/attach`. The limit, both key-entry refusals and device-wire attach are gated by the product's Identity toggle (owner, 2026-10-04: entry limits apply only to products with the Identity service on), and existing installs are never affected.

## Why

The owner decided the legacy key flow becomes a limited on-ramp to accounts ([S-16 owner decisions](../../notes/S-16-identity-service.md)), and on 2026-10-04 limited it to products with the Identity service on: without Identity a key is the app's only activation path, so it is never refused for the limit and the portal offers the account upgrade but never forces it. It is a new refusal on an existing device route, so it is plan mode ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (this package executes it).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (legacy licence-key flow header), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (counting rules and the refusal rows), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 5, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-09, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D20 (accepted), D24 (proposed), and the account/service split that supersedes D26.
- `packages/worker/src/services/license/activation.ts:153`, `packages/worker/src/core/devices.ts`, `conformance/parity/errors.json`, `tools/services.json`.

## Scope

**In:**

- `license_key_entries` and the per-licence counter; the product's `identity.keyEntryLimit` (validator rule from I-04).
- `key_entry_limit` (403) with `manageUrl` = `https://key.plrs.im/activate?product=<slug>`; optional `keyEntries: { used, limit }` in the activation-by-key response.
- `license_owned` (403) with `signInUrl` on key entry for an owned licence on a device not already enrolled on it (D24, accepted by the owner 2026-10-04; re-entry on an already enrolled device and existing installs keep working), checked before any count, only with Identity on; `license_owned` on attach and on the portal's Activate License path for every product (that is the platform claim rule "an owned licence never moves by key", not a key-entry refusal).
- `POST /<p>/identity/attach` with P1-07's show-then-confirm; returns the activation response.
- Discovery fields (`account`, `keyEntryLimit`); the console shows the entry count on the licence.
- The counter, `keyEntryLimit`, both key-entry refusals, `keyEntries` and the attach route only while the product's `identity` toggle is on (owner, 2026-10-04; supersedes D26); with it off, devices behave exactly as today: unlimited key entry, no `keyEntryLimit` in discovery, and key entry on an owned licence still accepted (the key is that app's only activation path). Portal entries for such a product are not counted.

**Out** (and where it belongs instead):

- SDK handling and UI kit screens (→ I-10a, I-10b); the portal's Activate License modal (→ I-11).

## Design notes

- **Anchor choice (S-19 decisions 2 and 3, owner, 2026-10-04).** Sign-in activation binds the device to the anchor chosen by `anchorPolicy: rank-first` ([S-19 §7.5](../../notes/S-19-licensing-model.md#75-anchor-selection-seats-and-re-anchoring) steps 1–3: the account's usable `base` licences with a free seat, highest `tiers.rank`, then no expiry, then latest expiry, then oldest; else auto-issue; else today's `not-entitled`). Ship it inline; [LX-10](LX-10-anchor-choice.md) replaces it with `chooseAnchor`. Until LX-08 adds `tiers.rank`, every tier ranks 0. See the amendment in [`plans/I-04.md`](../plans/I-04.md).
- **Settings as rows (S-18, owner, 2026-10-04).** Identity settings (`identity.keyEntry.limit`, `identity.keyEntryRefusals`, `identity.keyEntry.claimByKey`) are claimable `product_settings` rows registered through [ST-03](ST-03-settings-registry.md) on [ST-01b](ST-01b-resync-claims.md)'s table; create no `identity_product_settings` table ([S-18 §5.5](../../notes/S-18-settings-architecture.md#55-i-04-identity-rollout-plan-and-the-later-identity-layers)).
- **Counting rules (D20, accepted by the owner 2026-10-04).** Count only a successful key activation that enrols a new device, or a portal Activate License submission. Re-entry on an enrolled device, refused attempts, refresh, offline grace, the licence document, store-binding activation and sign-in-based activation never count.
- **Existing installs are never affected** (owner): device tokens, refresh, offline grace and the signed licence document keep working exactly as today.
- Neither refusal is an auth failure: the URLs never carry the key, and a device that already holds a token for the licence never sees either.
- A leaked key can burn entries; that only forces the buyer onto the account path ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 5).

## Steps

1. `errors.json` codes and contract types.
2. Counter, limit and refusals with tests.
3. Attach route with confirm.
4. Discovery, transcripts, OpenAPI.

## Acceptance criteria

- [ ] The entry past the limit is refused with `manageUrl` and no key in it (test); re-entry on an enrolled device is never counted (test).
- [ ] Key entry of an owned licence on a new device is refused with `license_owned` and `signInUrl`; re-entry on an enrolled device still succeeds (tests).
- [ ] With the Identity toggle off, activation behaves exactly as before, including key entry of an owned licence on a new device and entries past what the limit would be (tests against the existing transcripts).
- [ ] Attach refuses an owned licence and an email-bound licence without a matching verified email unless `claimByKey` (tests).
- [ ] Transcripts recorded; `errors.json`, OpenAPI and `routeCoverage` updated; `PROTOCOL_VERSION` unchanged.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- license activation identity attach
mise exec node@22 -- pnpm gen:transcripts -- --check
```

## Hand-off

- I-10a and I-10b surface both refusals in every SDK and UI kit; I-11 builds the Activate License modal on the same counter.
- I-09 drops `pending` on `identity.keyEntry.limit` (manifest `identity:` block plus discovery probe), and moves the `identity.keyEntryRefusals` switch read from A-13's platformSetting onto `resolvePlatformSetting`.

The role agent sets `--set I-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-09 done`.
