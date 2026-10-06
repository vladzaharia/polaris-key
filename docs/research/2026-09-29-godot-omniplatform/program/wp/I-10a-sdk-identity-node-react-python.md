# I-10a SDK identity v2 for layer 1 in Node, React and Python plus the React activation component: key-entry refusals with deep link and QR, passthrough sign-in (device code; web redirect in React), attach, `subject`, `signOut`, `openAccount`

| Field       | Value                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                 |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                   |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md)                                                                                                                                               |
| Unblocks    | [I-13](I-13-exchange-endpoint.md), [I-15](I-15-native-redirect.md), [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [I-24b](I-24b-named-user-seats-sdks.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                   |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                                                      |
| Gates       | plan mode; all six SDKs (`parity:check`); `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; UI kit screenshots                                                                                                                 |
| Human input | none                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                              |

## Amendments from approved plans (2026-10-05)

The owner approved the plans below on 2026-10-05. These amendments win over the text of this brief where they differ.

- **[`plans/I-09.md`](../plans/I-09.md):** the §4 transcript and parity rows, the §5 SDK table, and the Kotlin `ui` path.
- **[`plans/PX-W8.md`](../plans/PX-W8.md):** the `key-entry-limit` outcome reads `manageUrl` through client-core's `readManageUrl` (not `portalUrl`), and the key-entry screen reuses PX-W8's **Replace a device** component (`ui.kit.account`).
- **[`plans/PX-W9.md`](../plans/PX-W9.md):** `keyEntries` on every successful key activation; the `keyentry-*` transcripts are owned by PX-W9.
- **[`plans/PX-W13.md`](../plans/PX-W13.md):** inherit PX-W13's device-label helper (`deviceName`), which PX-W13 ships in every SDK.
- **[`plans/PX-W17.md`](../plans/PX-W17.md):** replay the `identity.toggle` transcript, add the `identity.toggle` parity row and the UI-kit "Identity off" snapshot.

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package:

- **No new SDK call.** Replay the device steps of `devicecode-choose.json`,
  `devicecode-replace.json`, `devicecode-choice-required.json` and `devicecode-autoissue.json`.
  React also replays `redirect-web-choose.json`.
- **Polling.** Keep polling `pending` until `expires_in`, because choosing on the card can take a
  while.
- **After `ready`,** show the bound tier from the licence document ("Signed in · Standard
  license").
- **Constants.** `gen:constants` adds `license_choice_required`, and no SDK branches on it.
- **React kit naming.** The device-limit screen is **Replace a device**; its confirm is
  "Replace <device>?" with `signin.replace.consequence` and **Replace and continue** (SIGN-IN.md
  §3.7, `plans/I-04.md` §F.7). **Replace a device** opens `manageUrl`, where "Free up a device"
  used to lead. There is no in-app device list until I-13.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit and SDK copy to `signin.*` (US "license"; `signin.key.owned` replaces "This licence belongs…"); "{n} key entries left", never "activations" (SIGN-IN.md D-01, D-25).
- Native LicenseChoice on I-13's `choose` (React: `useLicenseChoice`), with the row anatomy of SIGN-IN.md §3.6; StatusScreen **signed-out** state and the sign-out confirm of §4.9; "Signed in · <Tier> license" after `ready`.
- Replay `devicecode-sign-in.json` (I-04 §F.6) with no SDK change.

## Goal

Node, React and Python handle layer 1 identity end to end: `activate(key)` surfaces `key_entry_limit` (deep link and QR) and `license_owned` (offer sign-in) without wiping state; device-code passthrough lands on the card; React web apps sign in by the web redirect and exchange the code; `attach`, `subject`, `signOut` and `openAccount` exist; and React's activation component shows the refusals and the "add to your Library" prompt.

## Why

S-16 re-estimated the SDK work and split it by toolchain so the two halves run in parallel ([S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut)). This half carries React's web redirect, which S-17's web Cloud Sync needs.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (this package executes it).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (the header block, including the 2026-10-04 account/service split), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK API table), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact) (notes on the refusals), [S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-10a; [S-16 §9](../../notes/S-16-identity-service.md#9-risks-and-open-questions) open question on React's `identity.oidc` parity row.
- `packages/sdk-node/src/identity/client.ts`, `packages/sdk-react/src/`, `sdks/python/src/polaris_key/`, `conformance/parity/`.

## Scope

**In:**

- In Node, React and Python: refusal handling, device-code passthrough with P1-07 confirm-and-attach, `identity.attach()`, `identity.subject()`, `signOut()` (runs Cloud Sync's flush-before-sign-out when that service is on, then clears the binding), `openAccount()` deep link.
- React: `identity.signIn({redirect})` with PKCE against I-08's authorize and code exchange; the activation component's refusal screens, QR and "N activations left" with "add to your Library".
- Node and Python: loopback redirect is I-15's; device code here.
- Transcript replayers and parity rows; close React's `identity.oidc` parity gap.

**Out** (and where it belongs instead):

- Swift, Kotlin and Godot (→ I-10b); `exchange` (→ I-13); native redirect (→ I-15).
- `link`, `unlink`, `deleteAccount`: account actions live only in the portal ([S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface)).

## Design notes

- Never retry or treat `key_entry_limit` or `license_owned` as revocation; never wipe stored state.
- **Identity on vs off (owner, 2026-10-04).** The SDK Identity feature (sign-in, `attach`, `subject`, `signOut`) is the per-product Identity service and runs only when discovery says the product's Identity toggle is on. With it off the SDK shows no sign-in at all: `activate(key)` behaves exactly as today (no limit, no `license_owned`), and the UI kit's only account surface is a skippable "Add to your Polaris Key Library" link to the portal, never a forced step. `openAccount()` still works, because the account is platform-level.
- Cloud Sync needs sign-in (owner, 2026-10-04, final answers): this package's sign-in is how an SDK device gets its Cloud Sync principal (`devices.subject`); a key-activated device has none.
- System browser only, never an embedded web view ([S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) item 13).
- Copy for `license_owned`: "This licence belongs to a Polaris Key account. Sign in to use it on this device."

## Steps

1. Shared types from `gen:constants`.
2. Node, then Python, then React; React web redirect last.
3. Replayers, parity rows, screenshots.

## Acceptance criteria

- [ ] Each SDK replays the I-08 and I-09 transcripts (tests).
- [ ] With the product's Identity toggle off, no SDK or UI kit shows sign-in, and key activation is unchanged (test per SDK against the existing transcripts).
- [ ] Neither refusal clears stored licence state (test per SDK).
- [ ] React completes a web redirect sign-in against the exchange transcript (test).
- [ ] UI component screenshots for both refusals.
- [ ] `parity.json` manifests updated for all three SDKs.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm --filter @polaris-key/sdk-node test
mise exec node@22 -- pnpm --filter @polaris-key/sdk-react test
```

## Hand-off

- U-06 and U-20 build user settings on these sign-in calls; U-20 uses React's browser device token.
- I-13 and I-15 add `exchange` and `signIn({redirect})` on top.

The role agent sets `--set I-10a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-10a done`.
