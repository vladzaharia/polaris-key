# I-10a SDK identity v2 for layer 1 in Node, React and Python plus the React activation component: key-entry refusals with deep link and QR, passthrough sign-in (device code; web redirect in React), attach, `subject`, `signOut`, `openAccount`

| Field       | Value                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                        |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                          |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md)                                                                                                      |
| Unblocks    | [I-13](I-13-exchange-endpoint.md), [I-15](I-15-native-redirect.md), [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                          |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                             |
| Gates       | plan mode; all six SDKs (`parity:check`); `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; UI kit screenshots                                                                        |
| Human input | none                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                     |

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
- Cloud Sync does not need the Identity feature: on a product without Identity, a device whose licence is attached to an account reaches Cloud Sync through the licence owner (S-17), and this package adds nothing for that path.
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
