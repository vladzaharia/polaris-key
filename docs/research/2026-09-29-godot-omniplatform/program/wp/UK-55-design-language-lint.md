# UK-55 Design-language lint: the mechanical rules of UI-KITS.md's design language (spacing scale, three weights, the mark only in Powered-by, neutral refusals, initial focus, catalog strings in native sources, one https opener, no px fonts) in `packages/ui-qa`, with debt ledgers

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (design language v2 (2026-10-08))    |
| Size        | 1.2–1.8 engineer-weeks                                                                                     |
| Depends on  | [UK-15](UK-15-visual-qa-harness.md)                                                                        |
| Unblocks    | none                                                                                                       |
| Role        | `pkey-implementer`                                                                                         |
| Plan mode   | no                                                                                                         |
| Gates       | `pnpm ui:lint`; `node packages/ui-qa/bin/kit-lint.mjs` in every kit lane; a seeded-violation test per rule |
| Human input | none                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL3, DL5, DL6, DL8, DL9, DL11, DL12 and DL14 as lint rules; the matrix and the UX review check the rest.
- **In this kit:** No screens of its own: it encodes the mechanical rules for every kit lane the lint reaches, with today's hits in debt ledgers that only shrink, each owned by the kit's package.
- **Minimum check:** A seeded violation fails each rule in each kit pattern; `pnpm ui:lint` and `kit-lint.mjs` pass on the recorded debt.
- **Acceptance:** the seeded violations fail and the recorded debt passes; there are no screens, so no UX review.

## Goal

The design language's mechanical rules fail CI in every kit lane that can see them. Today's hits sit
in debt ledgers that only shrink, so no kit adds new drift while the packages that own the debt
clear it.

## Why

The [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) has eighteen
rules, and eight of them are mechanical. A rule is real once a check enforces it (§7.3); the rest
rely on the size matrix and the UX review. The kits are rebuilt over months, so the lint lands with
a ledger instead of waiting for them, the way UK-15's source lint did.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md), "Design language (v2, 2026-10-08)" and §7.3; the
  [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md).
- `packages/ui-qa`: `src/rules.ts`, `src/lint.ts`, `src/browser/lint.js`, `src/strings.ts`,
  `src/boards.ts`, `bin/kit-lint.mjs`, `rules/kit-rules.json`, `rules/kit-debt.json`,
  `rules/strings.debt.json`.
- The runtime helpers `sdks/godot/tests/support/ui_lint.gd` and `sdks/python/tests/ui_lint_qt.py`.

## Scope

**In:** eight rules. Each runs in the DOM lint (`pnpm ui:lint`: the web kits and the mockup boards)
and, where a source pattern or a runtime walk can see it, in every kit `kit-rules.json` covers
(SwiftUI, Compose, Godot, Qt, both terminals, and React once UK-47 adds it).

| Rule id             | Rule | DOM (web kits, boards)                                                                                                                                                                | Native kits                                                                                                                                                                                                                                                                       |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spacing-off-scale` | DL3  | a computed margin, padding or gap not on the `--pk-space-*` scale and not a `--pk-kit-*` token (0 and a 1 px hairline allowed)                                                        | a literal in `.padding(` or `spacing:` (SwiftUI), `Modifier.padding`, `Arrangement.spacedBy` or a spacer height (Compose), a `margin_*` or `separation` constant override (Godot), an anchor margin, `spacing:` or a QSS margin or padding (Qt), when it is not a generated token |
| `weights`           | DL12 | a computed `font-weight` other than 400, 500 or 600 (replaces `font-weight-700`, keeping its wordmark allowance)                                                                      | `.bold()` or a `.fontWeight(` other than regular, medium or semibold (SwiftUI); `FontWeight.Bold`, `W700`–`W900`, `Light` or `W100`–`W300` (Compose); a bold face outside the wordmark (Godot); `font.bold`, `Font.Bold` or a QSS `font-weight` (Qt)                              |
| `polaris-mark`      | DL5  | a Polaris mark (the Pinned K or the Star Cut) outside the Powered-by part                                                                                                             | the mark assets or generated mark constants referenced outside the kit's Powered-by component                                                                                                                                                                                     |
| `refusal-styling`   | DL6  | text of a refusal copy key (`deviceLimit.*` and the `core.copy` refusal entries, found through the string lint's key map) drawn in the danger role, or beside an `aria-invalid` field | the Godot and Qt runtime helpers walk the refusal fixture renders; SwiftUI and Compose assert the callout's tone in a kit test on the same fixtures                                                                                                                               |
| `initial-focus`     | DL9  | after a full-window state mounts with keyboard modality, `document.activeElement` is outside the kit root                                                                             | a screen file with no initial focus: `.defaultFocus` or `@FocusState` (SwiftUI), a `FocusRequester` with `requestFocus()` (Compose), `_initial_focus()` (Godot), `focus: true` or `forceActiveFocus()` (Qt); the Godot and Qt helpers also check it at run time                   |
| `catalog-string`    | DL8  | exists (the string lint)                                                                                                                                                              | a string literal in a visible position (`Text("…")`, `Button("…")`, `.text = "…"`, QML `text: "…"`, a terminal write) that is not from the generated catalogs                                                                                                                     |
| `link-validation`   | DL14 | `window.open`, a `location` assignment or a computed `href` outside the kit's one opener                                                                                              | a URL open (`openURL`, `UIApplication.shared.open`, `NSWorkspace.shared.open`, `uriHandler.openUri`, `OS.shell_open`, `QDesktopServices.openUrl`, `webbrowser.open`, `shell.openExternal`, an `open` or `xdg-open` spawn) outside the kit's one validating opener                 |
| `px-font`           | DL11 | a `font-size` in px in kit CSS (rem, a `clamp()` of rem and container units, or a token instead)                                                                                      | `.font(.system(size:))` or `Font.custom(_:size:)` without `relativeTo:` (SwiftUI); a `Density` or `fontScale` override (Compose); `font.pixelSize` or a px size in QSS (Qt); a literal font-size override not scaled through the type tokens (Godot)                              |

- Each kit's one validating opener gets a unit test: it refuses http (loopback aside),
  `javascript:`, `data:` and `file:` links, and a missing link.
- `--record` writes today's hits per rule and file into `kit-debt.json`; board exceptions go into
  `boards.ts` with their reasons, as §7.3 already does. The ledger comment names the package that
  owns each kit's debt.
- A seeded violation per rule and per kit pattern.
- UI-KITS.md §7.3 lists the eight rules, one line each, pointing at their L-rules.

**Out** (and where it belongs instead):

- Clearing the debt (each kit's package: React UK-47 and UK-05; SwiftUI UK-49, UK-07 and UK-08;
  Compose UK-09 and UK-10; Godot UK-50 and UK-11; Qt UK-12; the terminals UK-45 and UK-48).
- The rules no pattern can see (DL1, DL2, DL4's state logic, DL10, DL15 to DL18): the size matrix and the
  UX review check them.
- Kits that do not exist yet: each registers its roots in `kit-rules.json` when it lands.

## Design notes

- `kit-lint.mjs` keeps zero dependencies; each kit lane runs it with plain Node.
- The DOM rules run where the current ones run: the mockup boards in both themes, any page given to
  `--html`, and kit component tests through `lintPage()`.
- `refusal-styling` finds a refusal by its copy key, not by new markup, so no kit needs a contract
  change for the rule to see it.
- A source rule that would flag a generated file skips it, as today (the `GENERATED` banner).

## Steps

1. The DOM half of each rule, with its seeded test and the boards passing or excepted.
2. The source patterns per kit, `--record`, and the ledger owners.
3. The Godot and Qt runtime checks and the SwiftUI and Compose kit tests for `refusal-styling` and
   `initial-focus`.
4. UI-KITS.md §7.3.

## Acceptance criteria

- [ ] Each of the eight rules fails on a seeded violation, in the DOM lint and in each kit pattern
      it has.
- [ ] `pnpm ui:lint` and `node packages/ui-qa/bin/kit-lint.mjs` pass on the branch with the
      recorded debt; a new hit fails, and a count above today's fails until re-recorded.
- [ ] The ledger names the owning package for each kit's debt.
- [ ] UI-KITS.md §7.3 lists the eight rules.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm ui:lint
node packages/ui-qa/bin/kit-lint.mjs
mise exec node@22 -- pnpm --filter @polaris-key/ui-qa test
```

## Hand-off

Each kit's design-language section names the rules its kit must pass; its builder clears that
kit's ledger entries with `--record`. UK-41 checks the must kits' debt once this has landed. The role agent
sets `--set UK-55 in-review` when it hands off. After review, the lead adds the last commit of the
PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-55 done`.
