# I-10a SDK identity v2 and key-entry outcome: Node, React, Python (absorbs PX-W9b, UK-44)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                                                                   |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md)                                                                                                                                                                                                                                                                                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-13](I-13-exchange-endpoint.md), [I-15](I-15-native-redirect.md), [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [I-24b](I-24b-named-user-seats-sdks.md), [U-06](U-06-sdk-settings-node-python.md), [U-20](U-20-sdk-settings-react.md), [SP-40](SP-40-retire-react-cookie-mode-browser.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md), [UK-42](UK-42-activation-holders-web.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                                                                     |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                                                                                                                                                                                                                                                        |
| Gates       | plan mode; all six SDKs (`parity:check`); `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; UI kit screenshots                                                                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- **Headless primitives** (I-04 §G.9) in Node (the reference), React over `client-core` and Python: `choice.licenses(grant)`, `choice.devices(grant, licenseId)`, `choice.complete(grant, choice)` (kinds `license` with an optional `replaceDeviceId`, `keep`, `create`, `key`), `choice.cancel(grant)`, and the `choose` answer of `redirect/token` beside the activation response. React's web redirect sends `license_choice=app` when its form runs inline. Fix the per-language names in the PR.
- Feature-detect the `choice*` discovery endpoints; without them run card mode. Replay `redirect-web-choose-app.json`, `choice-replace-app.json`, `choice-key-app.json`, `choice-grant-errors.json`; parity row `identity.choice`.

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **PX-W9b does the key-entry outcome.** PX-W9 Q1 moves it out of this package. PX-W9b ships, in Node, React
  and Python:
  - `keyEntries` on success and the `key-entry-limit` result;
  - client-core's `readKeyEntries`;
  - React's entries line and refusal screen (**Add it in Polaris Key**, a QR code without the key).

  This package gains the dependency PX-W9b.

- **What stays here.**
  - `license-owned`, attach, `subject`, `signOut`, `openAccount` and passthrough sign-in.
  - The refusal screen's primary **Sign in**, added onto PX-W9b's screen.
- **Transcripts.** The `keyentry-*` transcripts are replayed by PX-W9b, not here. "N activations left" is PX-W9b's
  "{left} key entries left".

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Absorbs PX-W9b (key-entry outcome) and UK-44 (sign-in hints) for Node, React and Python: one six-SDK pass over activation and sign-in. One signIn facade (signIn.start/exchange/choice/subject/signOut) on the OAuth-shaped endpoints, names from SP-35's api.json, deprecated aliases kept for the published SDK deprecation window (P0-24's ledger). Ships layer (c) only; the React activation UI renders in UK-05.

- Title: was "SDK identity v2 for layer 1 in Node, React and Python plus the React activation component: key-entry refusals with deep link and QR, passthrough sign-in (device code; web redirect in React), attach, `subject`, `signOut`, `openAccount`".
- Depends on: added SP-35; removed PX-W9b.
- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.
- Absorbs PX-W9b: Same six-SDK activation surface as identity v2 (C-47): one pass instead of two.
- Absorbs UK-44: Hints are an argument of the same signIn.start call I-10a/b introduce.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: §5.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: the `identity.signIn` and `subject` rows from I-27's plan; `beginSignIn`, `pollSignIn`, `waitForSignIn` and `signInWithBrowser` are removed, not aliased.
- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: the D3 mapping into the sign-in session vocabulary, and the `account` family appended to `ui-matrix.json`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- `identity.subject()` survives a restart and is null for key-only devices; confirm-and-attach in every kit; typed sign-in errors; an `identity` event kind.

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

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

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
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
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
