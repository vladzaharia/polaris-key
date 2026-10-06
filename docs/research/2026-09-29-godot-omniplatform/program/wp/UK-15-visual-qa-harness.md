# UK-15 Visual QA harness and modernity lint: `pnpm ui:lint` (§7.3 rules, string lint, orphan check, RTL-safe rule), `pnpm ui:report`, per-kit lint equivalents, CI lanes

| Field       | Value                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                      |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                                                                                                                                                                            |
| Depends on  | [UK-01](UK-01-brand-kit-tokens.md), [UK-02a](UK-02a-kit-copy-catalog.md)                                                                                                                                                                                                                          |
| Unblocks    | [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [UK-13](UK-13-python-terminal.md), [UK-14](UK-14-node-terminal.md), [UK-16](UK-16-ui-docs-scaffold.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                                                |
| Gates       | CI wiring per kit lane; `pnpm ui:lint` and `pnpm ui:report` added to the documented gate for the JS kits                                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                         |

## Goal

Every kit can prove it meets §1.5: one command lints a kit's DOM or view tree against §7.3, a report lays every kit's baselines side by side per fixture state, and the per-kit lint equivalents run in their lanes.

## Why

§1.5's rules are only real if a check enforces them (§7.3). Kits need the lint before they finish, so it lands before them. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §7 (all of it), §1.5, §4.7 (string lint)
- `docs/design/ui-kits/render.cjs` and the mockup boards (the lint's first target)
- `.github/workflows/ci.yml`

## Scope

**In:**

- `pnpm ui:lint`: the §7.3 rule set for web kits (borders, focus, type, shape and material, behaviour, RTL-safe logical properties), runnable on any page or component test.
- The string lint (visible strings per state vs catalog keys, across kits and mockup boards, allowing documented platform variants) and the orphan-line check over baselines.
- Per-kit equivalents as test helpers: SwiftUI, Compose (`BrandRulesTest` pattern), Godot (every engine control icon themed), Qt.
- `pnpm ui:report`: the side-by-side report per fixture state from whichever kits have baselines.
- The React/elements cross-renderer pixel diff harness (activated when both kits exist).
- The §7.4 designer review checklist.

**Out** (and where it belongs instead):

- Each kit's baselines (→ each kit).

## Design notes

- The lint must pass on the committed mockups first; a rule the mockups break is a bug in one of them (§7.4).

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] `pnpm ui:lint` passes on the mockup boards and fails on a seeded violation for each rule.
- [ ] The string lint fails on a seeded copy drift between two boards.
- [ ] The RTL-safe rule fails on a seeded `margin-left` in kit CSS.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm ui:lint
mise exec node@22 -- pnpm ui:report
```

## Hand-off

Every kit adds `ui:lint` (or its per-kit equivalent) to its acceptance; the report grows as kits land.

The role agent sets `--set UK-15 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-15 done`.

## Corrections from implementation (2026-10-05)

The code is the fact. Where the brief and the repository disagreed, this is what was built:

- **Rule profiles.** Most mockup boards draw native kits (iOS glass, Mica, Adwaita, the Godot
  panel) in HTML with the platform's literal colours, and their controls take their states from
  the platform rather than from CSS. Those boards use a `native` profile that leaves
  `colour-literal` and `interactive-states` to the native kit's own lane. The `web` board runs the
  full set.
- **Chrome and allowances live in config** (`packages/ui-qa/src/boards.ts`), each with its reason,
  so the boards stay clean markup.
- **String lint debt.** About 200 strings on the boards drift from `packages/brand/kit-copy/en.json`
  or are missing from it. Reconciling all copy is outside this package, so it lands with a
  shrink-only ledger (`rules/strings.debt.json`): any new drift fails, and so does a stale entry.
- **Per-kit source rules ratchet.** Today's SwiftUI (`.buttonBorderShape(.roundedRectangle)`) and
  Compose (`Icons.Filled`, `OutlinedTextField`, `AlertDialog`, the stock spinner) hits are recorded
  in `rules/kit-debt.json` for UK-07 and UK-09. The branded Godot theme leaves 91 engine icons
  stock: suite `ui_lint` reports this as INFO, and UK-11 makes it a check.
- **Mockup fixes.** The lint broke on the committed boards, which counts as a bug in the boards
  (§7.4). It found physical left/right properties, colour literals in the web kit CSS, missing
  `:focus-visible` and `:disabled` styles on `.k-btn`, unstyled selectable rows, 11 px text,
  fractional px sizes, glass on glass, an orphaned Windows hero and 32 px touch targets on the
  phone settings. These were fixed in the boards, and only the shots that visibly changed were
  re-rendered.
