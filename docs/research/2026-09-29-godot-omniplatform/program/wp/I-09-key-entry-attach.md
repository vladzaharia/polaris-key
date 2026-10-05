# I-09 Key-entry refusal `license_owned` with `signInUrl`, attach, subject and sign-out on the device wire (`POST /<p>/identity/attach`), discovery fields and the `identity:` manifest block; the entry counter and `key_entry_limit` with `manageUrl` ride PX-W9; all only behind the product's Identity toggle

| Field       | Value                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                          |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                          |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-05](I-05-accounts-core.md), [ST-01b](ST-01b-resync-claims.md), [ST-03](ST-03-settings-registry.md), [ST-04](ST-04-settings-resolver.md)                               |
| Unblocks    | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md), [I-24a](I-24a-named-user-seats-server.md), [LX-10](LX-10-anchor-choice.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                           |
| Plan mode   | yes: executes the approved [`plans/I-09.md`](../plans/I-09.md) (approved 2026-10-05), which refines [`plans/I-04.md`](../plans/I-04.md)                                                                         |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); D1 migration; `TABLE_OWNERS`; THREAT-MODEL                                            |
| Human input | none                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                       |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-24.md`](../plans/I-24.md):** the candidate hook in the inline anchor rule (§2.4) that I-24a uses for seat holders.
- **[`plans/I-09.md`](../plans/I-09.md):** approved on 2026-10-05 with every recommendation accepted: a signed-in device that already runs on a usable licence keeps its anchor (Q1); attach never re-anchors in I-09 (Q2); I-09 depends on ST-04 (Q3); counting starts at zero with no backfill (Q4); `identity.keyEntryRefusals` is one platform switch, default off (Q5). Table owner `core`; a new `discovery-identity.json` transcript instead of re-recording `discovery-capabilities.json`; `accountPortal` moves here; the attach transcript is seeded until I-08 re-records it; `identity.keyEntryRefusals` is a platform entry.
- **[`plans/PX-W8.md`](../plans/PX-W8.md) and owner:** `key_entry_limit` carries `manageUrl` (not `portalUrl`), built by PX-W8's `core/manageUrl.ts`; `license_owned` keeps `signInUrl`. The portal paths are root paths: `/activate?product=<slug>` and `/signin?product=<slug>`.
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** Q1 split: PX-W9 owns the counter (`core/keyEntries.ts`), the settings rows, I-04 §2.2 step 4, `keyEntries`, the `key_entry_limit` code and the `keyentry-limit.json` and `keyentry-identity-off.json` transcripts. I-09 keeps step 3 (`license_owned`), attach, subject and sign-out, the discovery members and the `identity:` manifest block.

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

The role agent sets `--set I-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-09 done`.
