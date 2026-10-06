# PX-W9 Key-entry counting (G21): WIRE-CONTRACT §12.2, the per-licence limit setting and the refusal switch, an atomic counter for app, browser and portal entries, `keyEntries` everywhere, the `key_entry_limit` refusal with `manageUrl` (errors, copy, three transcripts), portal previews and responses; the SDKs follow in PX-W9b

| Field       | Value                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                                                                                                                                                                                                                              |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                                                                                                                                               |
| Depends on  | [I-04](I-04-account-contract-plan.md), [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md)                                                                                                                                                                                                                        |
| Unblocks    | [PX-W9b](PX-W9b-key-entry-sdks.md), [PX-12](PX-12-login-card-v2.md)                                                                                                                                                                                                                                                                  |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                |
| Plan mode   | yes: executes §2–§4 and §6 of the approved [`plans/PX-W9.md`](../plans/PX-W9.md) (revision 2, approved by the lead under the owner's delegation on 2026-10-06; revision 1 approved by the owner on 2026-10-05). §5 (the SDKs) is [PX-W9b](PX-W9b-key-entry-sdks.md)                                                                  |
| Gates       | plan mode; D1 migration (the lead numbers it) with `TABLE_OWNERS`; `gen:constants`, `gen:transcripts`, `gen:settings` and `gen:platform-inventory` (`-- --check`), `parity:check`, `bundle:action -- --check`; rule 6; rule 10 (OpenAPI and `routeCoverage`); THREAT-MODEL; `docs gen:check`; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                                                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                            |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/PX-W8.md`](../plans/PX-W8.md):** the wire part (the `manageUrl` member and its builder) is settled in PX-W8.
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** revision 1 was approved on 2026-10-05 with every recommendation accepted except Q3, which the owner overrode: `key_entry_limit` carries `manageUrl`, not `portalUrl`. Scope per Q1 (the counter, the settings rows, I-04 §2.2 step 4, `keyEntries`, the `key_entry_limit` code, the transcripts and the portal surfaces). Dependencies ST-01b and ST-03 added. PX-W9 executes its own plan, not I-04's. The portal uses `keyEntries {used, limit}` on every surface (Q5); every licence key counts, including `addon` keys, and grants never do (Q6).

## Changed by plan PX-W9 revision 2 (2026-10-06)

Revision 2 was approved by the lead under the owner's delegation, with every recommendation
accepted. It wins over revision 1 and over the text below where they differ.

- **Q1.** The SDK half (client-core, the six SDKs and the four UI kits) is the new package
  [PX-W9b](PX-W9b-key-entry-sdks.md). This package changes no hand-written SDK code. It does commit
  the SDK files that `gen:constants` and `gen:transcripts` regenerate.
- **Q2.** The limit comes from `keyEntryLimit()` in `core/keyEntries.ts`, which reads the
  `product_settings` row and defaults to 10. There is no dependency on ST-04, and the product entry
  stays `pending: {wp: "ST-04"}`.
- **Q3.** Count every successful entry, whatever the holder. The limit applies to any licence with
  no account (floating, or assigned and waiting). Registry descriptions say "a licence that is in
  no account".
- **Q4.** The signed-out preview answers `upgrade: "forced"` only at the limit **and** with
  `identity.keyEntryRefusals` on.
- **Q5.** The signed-out preview follows SIGN-IN.md §3.9.
  - It shows the tier name, the term and a generic `license_owned` verdict.
  - It never shows an email, masked email, licence id or device list.
- **Q6.** The signed corpus is untouched. PX-W9b's client-core table pins the client rule.
- **Q7.** No per-licence override, no reset and no console UI here. The console row is LX-30's.
- **Corrections recorded in the plan.**
  - The commit point is the seat claim (`claimDeviceSeat`), because `bindDevice` writes with no
    batch.
  - ST-03 already registered both settings and keeps the bounds in
    `core/settings/platform.ts`.
  - Activation kinds go into `enums.json`.
  - The table owner is `core`.
  - `keyentry-refusals-off.json` moves here from I-09.

## Corrections found while implementing (2026-10-06)

The code is the fact; these are where it disagreed with the plan, and what was done.

- **The switch's store name is `KEYENTRY_REFUSALS`**, not `IDENTITY_KEY_ENTRY_REFUSALS`. The AT-2
  deny-list refuses a platform setting whose name holds a `KEY` token (`core/settings/rules.ts`)
  or a `_KEY` (`test/platformSettings.test.ts`). The registry key stays
  `identity.keyEntryRefusals`.
- **The entry guard reads the row before the claim.** The plan's guard ("the device row now holds
  the claimed seat") counts twice when two calls from one device race: both compute the same
  ordinal, the second seat upsert is a no-op, and its guard still sees the seat. The entry
  `INSERT` therefore runs first in `claimDeviceSeat`'s batch (the new `withClaim` option),
  guarded on "not yet enrolled on this licence". A lost ordinal race still rolls both back. A
  mutation check confirmed the race test fails without the guard.
- **Step 4 refuses only a usable licence.** A disabled or expired licence keeps its `401` from
  `authorizeDevice`, so `key_entry_limit` never invites someone to add a dead licence to an
  account. The signed-out preview's `upgrade` is `forced` exactly when step 4 would refuse.
- **The core copy reads correctly without `{product}`** (review B1). Node's and Python's copy
  readers cannot pass a product name and drop an unfilled placeholder, so `key_entry_limit` is
  "This key has no entries left. Add it to your account and sign in instead." in all eight packs.
  The kit key `signin.key.noEntries`, which names the product (SIGN-IN.md §5.2), stays in the kit
  catalog for PX-W9b's kits; it no longer duplicates the core text, which `pnpm gen:brand`
  refuses.
- **SDK test fixtures changed, no SDK source except one table.** Tests in React, Swift, Godot and
  Node used `key_entry_limit` as their example of an unknown code. They now use a code no catalog
  has, and assert that `key_entry_limit` reads its own sentence. Godot's activation-table size pin
  moved from 13 to 14. React's hand-written French table gained `key_entry_limit`, because its
  test requires French copy for every registered wire code.
- **`ui.kit.keyentry` is N/A `headless` in Node and Python**, the state PX-W9b keeps. It is
  `planned` (`wp: "PX-W9b"`) in the four kits, and `identity.keyentry` is `planned` in all six.
- **`keyentry-limit.json` presupposes `license.deactivate`** (`requires`): "this device removed"
  is the client's own deactivation, so the refused step holds no token.
- **The claim answers `keyEntries` on `already_yours` too** (no entry is recorded).
- **The migration is `0100_license_key_entries.sql`** (numbered by the lead on 2026-10-06; it
  was `00XX_…` while in progress), and `LATEST_MIGRATION` names it.

## Goal

On a product with Identity on, every licence counts its key entries:

- an app activation by key that enrols a new device (`app`);
- a browser key session (`browser`);
- a portal claim (`portal`).

Each entry is counted exactly once, in the same batch as the seat claim. Responses carry
`keyEntries {used, limit}`. With the refusal switch on, a new device past the product's limit gets
`key_entry_limit` with PX-W8's `manageUrl`. The portal reports the count on its previews and
claims. Existing installs are never affected.

## Why

Key entries turn anonymous keys into accounts ([PORTAL.md §4.6](../../../../design/PORTAL.md#46-key-entry-the-account-upgrade-skippable-then-forced), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G21). The owner approved the design on 2026-10-04. PX-12's card and PX-W9b's SDKs both build on the members this package puts on the wire.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [`plans/PX-W9.md`](../plans/PX-W9.md): the decisions, then §0–§4, §6, §7 and §9.
- [PORTAL.md §4.6](../../../../design/PORTAL.md#46-key-entry-the-account-upgrade-skippable-then-forced), [PORTAL.md §3.1](../../../../design/PORTAL.md#31-model), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close); [SIGN-IN.md](../../../../design/SIGN-IN.md) §3.9 and §4.5.
- `docs/security/WIRE-CONTRACT-V4.md` §5.3 and §12; `plans/I-04.md` §2.2; `plans/I-09.md` §2.1.
- In the Worker:
  - `core/authz.ts` (`authorizeDevice`) and `repo.ts` (`claimDeviceSeat`);
  - `core/manageUrl.ts`;
  - `services/license/activation.ts` and `services/identity/browserSession.ts`;
  - `services/identity/portal/selfService.ts` and `portal/api.ts`;
  - `core/settings/platform.ts`, `services/identity/settings.ts` and `core/platformSettings.ts`.

## Scope

**In:**

- **Contract.**
  - WIRE-CONTRACT-V4 §12.2 "Key entry" [C] and the `key_entry_limit` row of §5.3.
  - `shared-protocol`: `PolarisErrorCode` gains `key_entry_limit`, and `identity.ts` gains
    `KeyEntries`, `KeyEntrySurface`, `KeyEntryLimitBody`, `KeyPreview` and `KeyUpgrade`.
- **Errors and copy.**
  - `errors.json` gains `key_entry_limit` (403, service `license`).
  - `enums.json` `activationResult` gains `key-entry-limit`.
  - `codes.key_entry_limit` and `activation["key-entry-limit"]` go into the eight core copy packs
    (`en`, `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-Hans`).
  - Regenerate every SDK's constants and copy modules.
- **Settings.**
  - The product entry `identity.keyEntry.limit` gets a reader and `pending: {wp: "ST-04"}`.
  - The platform switch `identity.keyEntryRefusals` becomes an editable platform setting
    (`IDENTITY_KEY_ENTRY_REFUSALS`, with an `Env` member).
- **Worker.**
  - The migration `00XX_license_key_entries.sql`, with `LATEST_MIGRATION`, `TABLE_OWNERS.core` and
    the `core/licenseDelete.ts` cleanup.
  - `core/keyEntries.ts` and the `keyEntry` option on `authorizeDevice`.
  - The call sites: activate, `session/license`, the activate preview, and the claim (a `portal`
    entry).
  - The new signed-out `POST /api/key/preview`.
  - The refusal is logged with the other licence refusals, as `key_entry_limit`.
  - The console licence record gains `keyEntries`, and the portal client types are added.
- **Evidence.**
  - Three transcripts (`keyentry-limit.json`, `keyentry-refusals-off.json` and
    `keyentry-identity-off.json`) with their Swift and Godot mirrors.
  - The parity rows `identity.keyentry` and `ui.kit.keyentry`, `planned` (`wp: "PX-W9b"`) in all
    six `parity.json`.
- **Docs.** OpenAPI and `routeCoverage` (rule 10), the licence and identity docs pages, the
  glossary (**key entry**, **key-entry limit**) and a THREAT-MODEL section.

**Out** (and where it belongs instead):

- client-core, the six SDKs and the four UI kits (→ PX-W9b).
- `license_owned`, attach, the discovery `keyEntryLimit` and the `identity:` manifest block (→ I-09).
- The card's meter and forced upgrade (→ PX-12), and the console's "Key entries" row (→ LX-30).
- Console writes to the limit and `resolveSetting()` (→ ST-04).

## Design notes

- **Identity on only.** Key-entry limits apply only to products with Identity on. Without Identity
  nothing is counted and no member is sent (§3.1 table).
- **Never counted:**
  - an enrolled device;
  - refused or failed attempts;
  - token, refresh, offline grace and documents;
  - `license/enroll`, store binding and sign-in activation;
  - choosing a licence and Replace;
  - an `already_yours` claim.
- **Overshoot.** A race at the last free entry may go slightly over the limit (I-04 Q5). A
  portal claim past the limit still writes its row.
- **The refusal switch.** `identity.keyEntryRefusals` stays off until PX-W9b, I-08, I-10a and
  I-10b have shipped. Counting runs whatever it says.
- **Dependency ids.** PORTAL.md §10.3 and §11 were written against the first revision of phase I.
  The graph maps them onto the re-cut S-16 ids (see README §8, phase PX):
  - portal I-06 → I-05 (accounts, links, pairwise subjects);
  - I-05 and I-20 (Google, Apple) and I-12's web Steam → I-06;
  - I-08 (email login) → I-07;
  - I-14 (passkeys) → I-16;
  - I-13 (native redirect) → I-15;
  - I-15 (sessions) → I-07;
  - I-16 (per-product issuer) → I-08 for layer 1 (I-21 later);
  - S-17 → U-05.

## Steps

1. Re-read the plan, and check its line references against the current code. Record any
   correction here.
2. Contract, errors and copy first (`gen:constants`). Then the migration and `core/keyEntries.ts`,
   the call sites, the portal routes, the settings wiring, the transcripts and parity rows, and the
   docs. Use small commits prefixed `PX-W9:`. Name the migration `00XX_…` and say so in the report.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W9 in-review`.

## Acceptance criteria

- [x] **Concurrency test.**
  - N parallel activations of new devices write exactly as many rows as there are successes.
  - N parallel activations from one device write one row.
  - A refused or failed attempt, or an enrolled re-entry, writes none.
- [x] Installs are unaffected. Every existing transcript is byte-identical, there are regression
      tests on refresh and offline grace, and document bytes are unchanged with counting on.
- [x] The three `keyentry-*` transcripts and their mirrors are recorded, and `gen:transcripts -- --check` is green.
- [x] Identity off: no `keyEntries` and no refusal. Switch off: counted past the limit, never refused.
- [x] The signed-out preview never counts, and never returns an email, licence id or device.
- [x] The migration and the `TABLE_OWNERS` entry land together.
- [x] `gen:constants`, `gen:settings`, `gen:platform-inventory` and `parity:check` are green, and the
      `routeCoverage` and `boundaries` tests pass.
- [x] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm gen:transcripts -- --check && mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm gen:settings -- --check && mise exec node@22 -- pnpm gen:platform-inventory -- --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- keyEntries portal routeCoverage boundaries
```

## Hand-off

- PX-W9b reads the members in client-core, the six SDKs and the four UI kits.
- PX-12 renders the card's meter and forced upgrade from `POST /api/key/preview`.
- I-09 inserts `license_owned` as step 3 of §12.2.
- ST-04 replaces `keyEntryLimit()`.
- **Follow-up (review N4, the I-04 Q5 class):** switching licences can count twice. A device
  enrolled on licence A that enters licence B's key moves to B (one entry on B); entering A's key
  again is then a new enrolment on A and counts on A a second time. Accepted for now, as with the
  overshoot at the last entry; I-09 or LX-10 may treat a device's return to a licence it held as
  not new.

The role agent sets `--set PX-W9 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W9 done`.
