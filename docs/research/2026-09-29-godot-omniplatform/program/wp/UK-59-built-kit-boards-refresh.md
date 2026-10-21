# UK-59 Refresh the built kits' boards from the reviewed builds

| Field       | Value                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md)                                                                                                                                                                                            |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                             |
| Depends on  | [UK-47](UK-47-react-kit-and-gate-fixes-before-uk-05.md), [UK-49](UK-49-swiftui-kit-and-swift-sdk-0-8-x-correctness.md), [UK-50](UK-50-godot-drop-in-fixes-ahead-of-uk-11.md), [UK-51](UK-51-terminal-drop-in-contract.md), [UK-56](UK-56-kit-mockups-refresh.md) |
| Unblocks    | none                                                                                                                                                                                                                                                             |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                               |
| Plan mode   | no (no wire change)                                                                                                                                                                                                                                              |
| Gates       | ui-snapshots, modernity-lint                                                                                                                                                                                                                                     |
| Human input | none                                                                                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                        |

## Plan follow-through (2026-10-09)

Approved [`plans/UK-51.md`](../plans/UK-51.md) (2026-10-09) bears on this package: draw the pipe/non-TTY quadrant on `terminal.html` from UK-51's `gate` rows (four quadrants per refused status; refusals are ▲, never ✗) and refresh the terminal boards.

## Goal

The boards of the platforms that already have a built kit (web, ios, apple iPad, android, godot, terminal) are redrawn from the reviewed builds and agree with UI-KITS.md, DL1-DL18 and the catalog copy. Each frame says whether it is 'Built today' or a 'UK-11 target'.

## Why

UK-56 redraws only the boards of platforms with no built kit. The brand guide reprinted the stale built-kit boards, and the kits' own builders and reviewers compare against them, so the boards must be right first.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B10, B14.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Web: no QR on sign-in; the identity pane per DL1; catalog copy; shape rows 844x390, 640x360, 1180x820, 1920x1080.
- iOS: inline one-form activation and sign-in (sheet only as a labelled alternative); live activity relabelled to a content pack; neutral boot indicator. apple.html iPad from the built SwiftUI renders.
- Android: states, settings and tablet list-detail, expired state with the product icon, phone landscape, small landscape and tablet portrait for gate, sign-in and device limit; add `sdk.compose-activate` and `sdk.compose-sign-in` mockups.
- Godot: two labelled tiers per frame ('Built today' and 'UK-11 target'); QR only on pad-only screens and offline request codes; host-owns-pause note; DL7 loading.
- Terminal: sign-in title 'Sign in with a code'; refusals use ▲ with the fix, exit codes per UK-51 (refused gate 4, status 1); 40- and 32-column frames; a fifth 'pipe' quadrant; no accent line under title bars.
- No tinted strokes, rims or glows on any board (B6).

**Out** (and where it belongs instead):

- Kit code (→ the UK-04..UK-12, UK-47..UK-51 builders).
- Boards of platforms without a built kit (→ UK-56).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B10, B14 (program/BRAND-TRANSITION.md); section changes sdk-a-05, sdk-b-04, sdk-c-01 (merged). No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 1 mockup item(s):** `kitboard:terminal:pipe-quadrant`.
- `sdk-a-09`: Remove welcome.lede and part.qr.scanInstead from kit-copy/en.json and the 8 locale packs, then regenerate kitCopy (UK-02a is done).
- `B14.7`: UK-41 requires an evidence ledger: a matrix cell is complete only with runtime evidence or a documented N/A.
- `kitboard:terminal:pipe-quadrant`: Draw a pipe/non-TTY quadrant on terminal.html (UK-59) and cover it in UK-51's contract rows.

## Acceptance criteria

- [x] `render.cjs` renders every board in both themes; `pnpm ui:lint` passes with no new exception.
- [ ] A mockup-mode `pkey-ux-reviewer` rates each board good or better.
- [x] Board captions say which tier each frame is. (`tier-caption` rule in `packages/ui-qa`, run by `pnpm ui:lint`.)
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set UK-59 in-review` when it hands off; after review the lead adds the last commit `--set UK-59 done`.

## Progress and continuation (2026-10-17)

Slice 1 done (UK-59 builder; the boards in docs/design/ui-kits are hand-authored HTML, not built
from `_src`; `pnpm gen design-mockups` covers only console-product-card and the sign-in prototype):

- terminal.html: revoked status is a ▲ block with exit 1 (golden status-screen-revoked); boot, status
  and network-failure frames follow the Node goldens (no invented `exit N` footers); offline request
  draws the QR under the code as the kit does (not beside it); the fallbacks strip is the gate
  refusal in five quadrants incl. the pipe quadrant (Python scene gate-needs-activation); three new
  shots from UK-46: host-mounted help, stderr refusal with exit 4, inline gate flow.
- web.html: publishableKey example replaced by `config={polarisKey}` (SETUP D18); QR removed from
  the sign-in hand-off at 1440 and 390 (D-67); captions say Built today.
- ios.html: the Live Activity is a content-pack download (catalog "Downloading content").
- ui-qa: strings.allow.json gains terminal fixture entries; strings.debt.json shrank by 38.

Left for a continuation (not started): web shape rows 844x390, 640x360, 1180x820, 1920x1080 and the
identity pane (DL1); iOS inline one-form activation and neutral boot indicator; apple.html iPad
from the built SwiftUI renders; Android states/settings/tablet list-detail, expired with product
icon, extra window shapes, sdk.compose-activate and sdk.compose-sign-in mockups; Godot two tiers per
frame, QR only on pad-only and offline, host-owns-pause note, DL7 loading; terminal 40/32-column
gate and refusal frames; "Built today" / "UK-11 target" captions on the remaining frames.

## Progress and continuation (2026-10-19, slice 2)

The boards under docs/design/ui-kits are hand-authored HTML with no `_src`; `pnpm gen design-mockups`
does not cover them. Slice 2 edited web.html, then re-rendered with render.cjs under heavy.sh.

- web.html adopts the built-kit changes from the UK-04/05 re-review (ux-review-2): the code step with
  "Code expires in m:ss" and a separate "Waiting for you to sign in…" status (1440 and 390); the device
  limit frame in catalog copy with the button naming the device and the consequence line; new frames for
  a mixed license choice with a row-level Replace, the 12-device replace list (scrolls inside the card,
  rows size to content, actions docked), the inline replace confirm, the refused key as one danger callout
  with the Back chevron, and the web update prompt ("An update is available", "You have 2.4.1",
  "Download 2.5.0 ↗", Later). Each caption says Built today.
- ui-qa: strings.allow.json gains the 12-device fixtures; strings.debt.json shrank (stale entries gone).

Still left: web shape rows 844x390, 640x360, 1180x820, 1920x1080 and the identity pane (DL1); iOS inline
one-form activation and neutral boot indicator; apple.html iPad from the built SwiftUI renders; Android
frames and the two compose mockups; Godot two tiers per frame; terminal 40/32-column frames; Built
today / UK-11 target captions on the remaining boards.

## Progress and continuation (2026-10-20, slice 3)

Done (Built today unless noted; renders in docs/design/ui-kits/shots):

- web.html: gate and sign-in code view in two panes at 1440 (identity panel holds the icon only, DL1); new shape rows 844x390, 640x360, 1180x820, 820x1180 (one column) and 1920x1080 for the gate, plus the code view at 844x390 and 1920x1080 (shapes follow elements/src/element.ts measure()); the refused key shows the catalog's core.activation.license-disabled title and message. A new catalog key (activate.keyRefused) was tried and reverted: a kit-copy state key needs a ui-matrix row, which is an all-kit corpus change owned by the kit builders.
- terminal.html: gate refusal (exit 4) and revoked status (exit 1) at 40 and 32 columns, from the Node kit's narrow renders; strings.allow.json gains one entry for the wrapped fragments.
- android.html: the Compose kit's own snapshots at phone landscape, small landscape, foldable and tablet for gate, sign-in, device limit and expired (the build shows no product icon on expired yet).
- godot.html: two real renders of the Godot kit (gate, settings) as Built today; every drawn frame captioned UK-11 target; host-owns-pause note; the boot bar is a 2 px shimmer (DL7).
- ios.html: inline one-form activation (the sheet is the labelled alternative); neutral boot shimmer; lede from the catalog (string debt shrank).

Left: apple.html iPad from built SwiftUI renders (needs a simulator or Xcode; the committed Swift snapshots are phone-size only); Android states/settings and tablet portrait, compose mockups sdk.compose-activate and sdk.compose-sign-in; Godot built tier for the other nine frames (tools/ui_screenshots.gd stalled after gate and settings under load); iOS and Android frames drawn before this slice still lack a tier caption; the MOCKUP-mode UX review; ui:report.

## Progress and continuation (2026-10-21, terminal + Godot slice)

- terminal.html: every frame captioned Built today; a new `--json` frame captured by running the Node gate and status verbs (exit 4 and 1). NO_COLOR, ascii and the pipe quadrant were already drawn.
- godot.html: nine frames re-tiered against real renders of the built kit (tools/ui_screenshots.gd, brand look, dark and light; raw captures in shots/godot-built/): gate, settings, sign-in, device limit, update toast, update, boot, status, error each show a Built today render beside the UK-11 target. Activate and the 1280 x 800 gate stay target only.
- The built kit disagrees with the targets: sign-in title is "Sign in" at polaris.locker/device; boot draws a part-filled bar, not the DL7 shimmer; status is the gate's Signed out form; the device-limit and error frames have no copy for the cached license.

## Progress and continuation (2026-10-21, slice 5: captions and close-out)

- Every frame on all ten boards now ends its caption with `Built today` or `UK-11 target` (one trailing parenthetical is allowed). Web: the 14 frames that lacked a tier (gate 390, activate, device limit, update downloading, embedded settings, theming, state sheet, components, layers, motion, forced-colors, native preset) say Built today. iOS: the sign-in sheet, StoreKit paywall and Live Activity captions reordered to end in their tier (Paywall and Live Activity are UK-11 targets). iPad: Built today. Android: the expired shapes frame no longer carries both tiers; it ends Built today. Godot and terminal already complied. visionOS, tvOS, watchOS, macOS (desktop), Linux, Qt and Windows have no committed render of a built kit, so all their frames are `UK-11 target`; UK-56 owns those boards.
- New rule `tier-caption` (`packages/ui-qa/src/browser/lint.js`, `rules.ts`, seeded case in `e2e/rules.e2e.test.ts`): any `figure` that holds a `[data-shot]` must have a caption ending in a tier. It runs inside `pnpm ui:lint` on every board, JS-generated captions included.
- Open, not board edits: the MOCKUP-mode `pkey-ux-reviewer` rating and `pnpm ui:report` (lead's review lane); the full green gate (lead).

## Kit gaps for UK-11

Updated after KF-native and KF-web landed (UK-59 close, 2026-10-21): every former "Fix in flight"
line is resolved below, fixed (with its commit) or still a gap (with what remains).

- Godot: the boot bar is part-filled; DL7 wants the 2 px shimmer (owner: Godot kit).
- Godot: status shows the gate's Signed out form with no Renew action; the target has a status screen (owner: Godot kit).
- Godot: the error and device-limit frames have no copy for the cached license ("play continues on the cached license") (owner: Godot kit).
- Godot: sign-in title is "Sign in", the target says "Sign in with a code" (the URL is already polaris.locker/device) (owner: Godot kit).
- Godot: no activate dialog (the key form sits on the gate) and no 1280 x 800 render in tools/ui_screenshots.gd (owner: Godot kit).
- Godot: no product icon and name (DL5) on every built frame, the gate included; KF-native changed only a focus-ring comment there, so it stands (owner: Godot kit).
- Compose: the product header (icon and name) now leads the sign-in form (6e6866800); the other Compose screens (expired, boot, error, device limit) still carry no product header (DL5) (owner: Compose kit).
- Kotlin: the welcome lede is the catalog's `welcome.lede` (PolarisCopy.kt reads it, 050f40049); no longer a gap.
- Kotlin: no Compose snapshots for tablet portrait, nor a product icon on expired (DL3) (owner: Compose kit).
- Kotlin: the sign-in code view still prints `key.plrs.im/activate` (android-compose-sign-in re-rendered 2026-10-21); it must be `polaris.locker/device`. KF-native (6e6866800) fixed the code view's sentence, header and buttons, not the address, which comes from the verification URI the preview supplies (owner: Compose kit).
- Kotlin: boot still draws a stock spinner, not the DL7 shimmer (boot-progress snapshot; KF-native did not touch it) (owner: Compose kit).
- Kotlin: fixed in 6e6866800: the error screen reads the catalog's "Couldn't check your license" copy for `sync-failed`; the raw code appears only for an unknown code.
- Swift: boot still draws a spinner, not the DL7 shimmer; KF-native did not touch it (owner: SwiftUI kit).
- Swift on iPad: fixed in 09df6e2d1 (the actions stay with the content); the iPad frames on the boards are re-rendered from it.
- Swift: no landscape split Welcome render on iPad (the headless simulator cannot rotate), and no ActivityKit surface or StoreKit paywall in the kit (owner: SwiftUI kit).
- Terminals: fixed in a8d1f65ac: the fixture device-management link is `polaris.locker/#/p/tidewater/devices` in both kits and the goldens; the boards print it.
- Apple and desktop: no built renders of visionOS, tvOS, watchOS or macOS (owner: SwiftUI kit).

Removed: "Node and Python word the device-limit sentence differently". They did not: both goldens
say "Replace a device in your browser, then try again here."; the board frame was the stale part
(it carried an older sentence) and now matches both.

Removed: "the Node terminal prints key.plrs.im/device". The Node golden `sign-in-handoff-code` prints
`polaris.locker/device`.

## Progress and continuation (2026-10-21, fix/uk59-boards)

Fixes after the failed MOCKUP-mode review (kits-final/ux-review.md, UK-59). The boards in
docs/design/ui-kits are hand-authored HTML with no `_src`, so they were edited in place;
`pnpm gen design-mockups` does not cover them.

- Built today frames now match the builds: web gate (catalog lede, "Start a free trial", no footer), web activate and device limit at 1440 in two panes, iOS gate lede and three links, the sign-in sheet in the build's order with the persistent header and catalog footnote, device limit as Replace with the inline consequence. The iOS states frame is captioned UK-11 target (shimmer), with status and error redrawn in catalog copy.
- Device-code address is polaris.locker/device on web and Android; the Android hand-off has Open browser as the primary and no QR.
- Copy: Android, Godot and iOS drift fixed to catalog (lede, Replace, license expired, can't connect, dates); fixtures went to strings.allow.json with reasons. Debt 177 entries to 45 (169 on the six boards to 45: web 13, terminal 31, apple 1).
- Boards: title and section headings, frames wider than the window scroll inside their figure (no page sideways scroll at 1600 px), terminal fallbacks 3 + 2 centred, terminal device-limit captions say Python golden.

## UK-59 close (2026-10-21, fix/uk59-close)

- terminal.html: the device-limit frame (80 and 60 columns) matches the Node and Python goldens (one sentence, `polaris.locker/#/p/tidewater/devices`); both captions say Node and Python goldens.
- apple.html: the seven iPad states under shots/ipad-built (14 JPEGs) re-rendered from the current kit on the iPad Pro 13-inch simulator (examples/ui/swiftui run.sh, 960 px JPEGs): the actions sit with the content.
- Compose frames reference the Roborazzi snapshots in place, so the re-render picks up KF-native's PNGs (sign-in header and buttons, error copy). Web frames already carry polaris.locker/device; the React baselines changed in ways the hand-drawn web frames never showed.
- strings.debt.json 45 to 39: the six terminal device-limit and narrow entries (old sentence and `key.plrs.im/portal`) are gone; the fixture link went to strings.allow.json.
