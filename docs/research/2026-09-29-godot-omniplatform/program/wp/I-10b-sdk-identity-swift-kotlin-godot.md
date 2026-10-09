# I-10b SDK identity v2 and key-entry outcome: Swift, Kotlin, Godot (absorbs PX-W9b, UK-44)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                                                                                                                                                                                                                   |
| Size        | 1.4–1.95 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on  | [I-04](I-04-account-contract-plan.md), [I-08](I-08-app-passthrough.md), [I-09](I-09-key-entry-attach.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md)                                                                                                                                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-13](I-13-exchange-endpoint.md), [I-15](I-15-native-redirect.md), [I-19](I-19-identity-docs.md), [I-20](I-20-layer-2-plan.md), [I-24b](I-24b-named-user-seats-sdks.md), [U-07](U-07-sdk-settings-swift-kotlin.md), [U-21](U-21-sdk-settings-godot.md), [LX-39](LX-39-licences-in-account-need-sign-in-product.md), [UK-43](UK-43-activation-holders-native.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                                                     |
| Plan mode   | yes: executes the approved [`plans/I-04.md`](../plans/I-04.md) (no separate plan)                                                                                                                                                                                                                                                                                                                        |
| Gates       | plan mode; all six SDKs (`parity:check`); `errors.json` (rule 3), transcripts (rule 1), `gen:constants -- --check`; UI kit screenshots; CI: macOS; CI: Android                                                                                                                                                                                                                                           |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                |

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
  `devicecode-replace.json`, `devicecode-choice-required.json` and `devicecode-autoissue.json` in
  Godot, Swift and Kotlin.
- **Polling.** Keep polling `pending` until `expires_in`.
- **After `ready`,** show the bound tier from the licence document.
- **Constants.** `gen:constants` adds `license_choice_required`.
- **Kit naming.** In `PolarisKeyUI`, the Compose `ui` module and `addons/polaris_key/ui`, the
  device-limit screen is **Replace a device**; its confirm is "Replace <device>?" with
  `signin.replace.consequence` and **Replace and continue** (SIGN-IN.md §3.7, `plans/I-04.md`
  §F.7). **Replace a device** opens
  `manageUrl` (a QR on TV and console). There is no in-app device list until I-13.

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Kit and SDK copy to `signin.*` (US "license"); "{n} key entries left" (SIGN-IN.md D-25).
- Native LicenseChoice on I-13's `choose` (SwiftUI `LicenseChoiceModel`, Compose `rememberLicenseChoiceState`, Godot `PKeyLicenseChoiceController`); Godot's P1-07 "Is this you?" attach confirm stays and shows only after **Keep** (D-10); StatusScreen **signed-out**; "Signed in · <Tier> license" after `ready`.
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

- **Headless primitives** (I-04 §G.9) in Swift, Godot and Kotlin, with I-10a's names: `choice.licenses`, `choice.devices`, `choice.complete` (incl. `{kind: "key"}`), `choice.cancel`, and the `choose` answer of `redirect/token`. Feature-detect the `choice*` endpoints; without them run card mode. Replay the §G.8 transcripts through the Swift and Godot mirrors; parity row `identity.choice`.
- `PolarisKeyUI`, the Kotlin component and the Godot `ui` follow UK-07/UK-09/UK-11's one form; the Godot P1-07 attach stays offered only after **Keep**.

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **PX-W9b does the key-entry outcome.** PX-W9 Q1 moves it out of this package. PX-W9b ships, in Swift, Godot
  and Kotlin:
  - `keyEntries` on success and the `key-entry-limit` result;
  - the PolarisKeyUI, Godot and Compose entries line and refusal screen (**Add it in Polaris Key**, a QR code
    without the key on tvOS, joypad-only Godot and Android TV).

  This package gains the dependency PX-W9b.

- **What stays here.**
  - `license-owned`, attach, `subject`, `signOut`, `openAccount` and device-code passthrough.
  - The refusal screen's primary **Sign in**, added onto PX-W9b's screen.
- **Transcripts.** The `keyentry-*` transcripts are replayed by PX-W9b, not here.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track K, Corpus lane (wire trains, serial)](../../../2026-10-07-dx-consolidation/tracks.md#k-corpus-lane-wire-trains-serial)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> As I-10a for Swift, Kotlin and Godot (Godot first). Screens come from the rebuilt kits (UK-07, UK-09, UK-11); this ships SDK primitives and native presentation-core states only.

- Title: was "SDK identity v2 for layer 1 in Swift, Kotlin and Godot (Godot first) plus `PolarisKeyUI`, the Kotlin activation component and the Godot UI: the same calls and refusals as I-10a, device-code passthrough with QR".
- Depends on: added SP-35; removed PX-W9b.
- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.
- Absorbs PX-W9b: Same six-SDK activation surface as identity v2 (C-47): one pass instead of two.
- Absorbs UK-44: Hints are an argument of the same signIn.start call I-10a/b introduce.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: §5.
- [`plans/SP-35.md`](../plans/SP-35.md) §12: the `identity.signIn` and `subject` rows from I-27's plan; `beginSignIn`, `pollSignIn`, `waitForSignIn` and `signInWithBrowser` are removed, not aliased. It implements Kotlin `signOut`.
- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: the D3 mapping into the sign-in session vocabulary, and the `account` family appended to `ui-matrix.json`.

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- `identity.subject()` survives a restart and is null for key-only devices; confirm-and-attach in every kit; `Ready` carries the identity (Kotlin); typed sign-in errors (Swift); an `identity` event kind; `KIND_KEY_ENTRY_LIMIT` (Godot).

## Goal

Swift, Kotlin and Godot (Godot first) handle layer 1 identity with the same calls and refusals as I-10a, using device-code passthrough with a QR code; `PolarisKeyUI`, the Kotlin activation component and Godot's `addons/polaris_key/ui` show the refusals and the "add to your Library" prompt.

## Why

The game program needs Godot first, and this half is the estimate most likely to slip ([S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut)).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode); [`plans/I-04.md`](../plans/I-04.md) (this package executes it).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (the header block, including the 2026-10-04 account/service split), [S-16 §5.2](../../notes/S-16-identity-service.md#52-developer-facing-surface) (SDK API table), [S-16 §5.3](../../notes/S-16-identity-service.md#53-wire-impact), [S-16 §7.1](../../notes/S-16-identity-service.md#71-effort-and-the-minimum-viable-cut), [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-10b.
- `sdks/godot/addons/polaris_key/`, `sdks/swift/Sources/PolarisKeyUI/PolarisLoginView.swift:107-125`, `sdks/kotlin/`.

## Scope

**In:**

- In Godot, then Swift and Kotlin: refusal handling, device-code passthrough with QR and P1-07 confirm-and-attach, `attach`, `subject`, `signOut` (Cloud Sync flush when on), `openAccount`.
- UI kits: refusal screens, QR, "N activations left", "add to your Library".
- Transcript replayers and parity rows.

**Out** (and where it belongs instead):

- Node, React, Python (→ I-10a); `exchange` and platform sign-in helpers (→ I-13, I-14); native redirect (→ I-15).

## Design notes

- Godot's existing device-code QR is the base; Swift's `PolarisLoginView(onSignIn:)` stops defaulting to a no-op.
- Same refusal rules and copy as I-10a.
- **Identity on vs off (owner, 2026-10-04).** The SDK Identity feature (sign-in, `attach`, `subject`, `signOut`) is the per-product Identity service and runs only when discovery says the product's Identity toggle is on. With it off the SDK shows no sign-in at all: `activate(key)` behaves exactly as today (no limit, no `license_owned`), and the UI kit's only account surface is a skippable "Add to your Polaris Key Library" link to the portal, never a forced step. `openAccount()` still works, because the account is platform-level.
- Cloud Sync needs sign-in (owner, 2026-10-04, final answers): this package's sign-in is how an SDK device gets its Cloud Sync principal (`devices.subject`); a key-activated device has none.

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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Steps

1. Godot SDK and UI.
2. Swift and `PolarisKeyUI`; Kotlin and its component.
3. Replayers, parity rows, screenshots.

## Acceptance criteria

- [ ] Each SDK replays the I-08 and I-09 transcripts (tests).
- [ ] With the product's Identity toggle off, no SDK or UI kit shows sign-in, and key activation is unchanged (test per SDK against the existing transcripts).
- [ ] Neither refusal clears stored licence state (test per SDK).
- [ ] UI kit screenshots for both refusals in all three kits.
- [ ] `parity.json` manifests updated for all three SDKs; macOS and Android CI green.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
```

## Hand-off

- U-07 and U-21 build user settings on these calls; I-13 and I-14 add native sign-in.

The role agent sets `--set I-10b in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-10b done`.
