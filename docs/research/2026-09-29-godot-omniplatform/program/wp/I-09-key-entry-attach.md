# I-09 Key-entry limits and attach on the device wire: entry counter, `key_entry_limit` with `portalUrl`, `license_owned` with `signInUrl`, `POST /<p>/identity/attach`, discovery fields; the limits and the key-entry refusal only behind the product's Identity toggle

| Field       | Value                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                               |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                               |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-05](I-05-accounts-core.md)                                                                                                 |
| Unblocks    | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-11](I-11-portal-library.md)                                  |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                    |
| Gates       | plan mode; `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; rule 10 (OpenAPI + `routeCoverage`); D1 migration; `TABLE_OWNERS`; THREAT-MODEL |
| Human input | none                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                            |

## Goal

Key entry becomes a bounded on-ramp: each licence counts key entries against the product's `keyEntryLimit`; past the limit activation by key returns `key_entry_limit` with a Worker-built `portalUrl`; key entry of an owned licence on a new device returns `license_owned` with `signInUrl`; a signed-in device can attach its floating licence with `POST /<p>/identity/attach`. The limit, both key-entry refusals and device-wire attach are gated by the product's Identity toggle (owner, 2026-10-04: entry limits apply only to products with the Identity service on), and existing installs are never affected.

## Why

The owner decided the legacy key flow becomes a limited on-ramp to accounts ([S-16 owner decisions](../../notes/S-16-identity-service.md)), and on 2026-10-04 limited it to products with the Identity service on: without Identity a key is the app's only activation path, so it is never refused for the limit and the portal offers the account upgrade but never forces it. It is a new refusal on an existing device route, so it is plan mode ([S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (this package executes it).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (legacy licence-key flow header), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (counting rules and the refusal rows), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 5, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-09, [S-16 §10](../../notes/S-16-identity-service.md#10-owner-decisions) D20 (accepted), D24 (proposed), and the account/service split that supersedes D26.
- `packages/worker/src/services/license/activation.ts:153`, `packages/worker/src/core/devices.ts`, `conformance/parity/errors.json`, `tools/services.json`.

## Scope

**In:**

- `license_key_entries` and the per-licence counter; the product's `identity.keyEntryLimit` (validator rule from I-04).
- `key_entry_limit` (403) with `portalUrl` = `https://key.plrs.im/portal/activate?product=<slug>`; optional `keyEntries: { used, limit }` in the activation-by-key response.
- `license_owned` (403) with `signInUrl` on key entry for an owned licence on a device not already enrolled on it (D24, proposed default), checked before any count, only with Identity on; `license_owned` on attach and on the portal's Activate License path for every product (that is the platform claim rule "an owned licence never moves by key", not a key-entry refusal).
- `POST /<p>/identity/attach` with P1-07's show-then-confirm; returns the activation response.
- Discovery fields (`account`, `keyEntryLimit`); the console shows the entry count on the licence.
- The counter, `keyEntryLimit`, both key-entry refusals, `keyEntries` and the attach route only while the product's `identity` toggle is on (owner, 2026-10-04; supersedes D26); with it off, devices behave exactly as today: unlimited key entry, no `keyEntryLimit` in discovery, and key entry on an owned licence still accepted (the key is that app's only activation path). Portal entries for such a product are not counted.

**Out** (and where it belongs instead):

- SDK handling and UI kit screens (→ I-10a, I-10b); the portal's Activate License modal (→ I-11).

## Design notes

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

- [ ] The entry past the limit is refused with `portalUrl` and no key in it (test); re-entry on an enrolled device is never counted (test).
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
