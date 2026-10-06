# UI kit design review checklist

The checklist for [UI-KITS.md §7.4](../UI-KITS.md#74-design-review): each must kit's first full
baseline set is reviewed against the mockups in this folder before release, by a designer or by the
lead with the role agents. Paste this list into the kit's PR, tick each line, and write a note under
any line that needed a fix or an exception.

The owner's bar is that every kit looks made in 2026, and that it is scrutinised heavily. The lint
catches what a machine can see. This list is for what it cannot.

## Before the review

- [ ] `pnpm ui:lint` is clean, or the kit's lane runs its own equivalent and is clean:
      `node packages/ui-qa/bin/kit-lint.mjs --kit=<kit>`, plus the Godot `ui_lint` suite or the Qt
      `lint_widget_tree` helper. The kit cleared its own entries in
      `packages/ui-qa/rules/kit-debt.json`.
- [ ] `pnpm ui:report` shows the kit's baselines in both themes beside the mockups for every state
      it renders, and lists no component state the kit owns as unrendered.
- [ ] For React and the elements kit: the cross-renderer diff in the report is active and every pair
      matches.

## The product is the hero (§1.2)

- [ ] The product's name, icon and accent lead every gate step. No Polaris Key mark appears on a
      kit screen, and Powered-by is off by default (§1.6).
- [ ] With no product accent set, the accent comes from the icon. With no icon, the primary is Ink,
      never Polaris violet.
- [ ] Product art sits behind the glass, never through it: no bright, clipped shape under a panel
      edge.

## Nothing dated (§1.5)

- [ ] Fields are filled, with no boxed or outlined fields. Focus is one 2 px outline with no glow,
      and it shows on keyboard focus only.
- [ ] Hairlines only. A selection is shown once: a tint plus one indicator, never border plus tint
      plus radio.
- [ ] Every wait has the right indicator: a countdown ring for a known end, a shimmer or skeleton
      otherwise, and a ring only inside a busy button. There are no stock spinners and no system
      alerts.
- [ ] Spacing sits on the 4 px grid. Card padding and control heights match the platform row of
      §1.5 rule 5: no mobile sizes on desktop, and no cramped Godot panels at 720p.
- [ ] Weights are 400, 500 and 600, with no all-caps buttons, no 4 px cards and no coloured glow.
      There is one switch design.
- [ ] Every state is visible only when it applies: hover, pressed, disabled at 42 %, busy with its
      label kept, and selected. A locked setting shows its value as text with a lock.
- [ ] Motion follows §4.8: functional, tokenised and never looping. Reduced motion swaps instantly.
- [ ] Status is icon plus word, for issues only. A full license reads as a neutral limit, not an
      error.
- [ ] Buttons: one primary per region, consistent widths and the platform's order, with one
      dismissal per surface.
- [ ] Copy: sentence case (title case on macOS buttons, menus and window titles), every string from
      the catalog, and no orphan last word.
- [ ] Mono only for keys, codes and hashes. Keys never truncate at the end.

## Platform fit (§1.4)

- [ ] It looks native to the platform and is clearly Polaris Key: Liquid Glass on the 26 releases
      with the designed 18-era fallback, M3 Expressive on Android, Mica and Fluent on Windows,
      Adwaita on GNOME, and the brand theme on every Godot control.
- [ ] The `native` preset looks like the platform's own UI and keeps the kit's structure.
- [ ] The layout is RTL-safe in code (logical properties, leading and trailing). No RTL baselines are
      required yet (owner decision, 2026-10-05).

## Accessibility (§4.4)

- [ ] Contrast passes in both themes, including `forced-colors` on the web.
- [ ] The platform's audits pass on the same renders: axe, `AccessibilityTest`,
      `performAccessibilityAudit`, and the Godot focus chain.
- [ ] Large type (AX3, 200 % font) reflows without clipping or overlap.

## Sign-off

- Reviewer:
- Date:
- Mockup boards compared:
- Exceptions agreed, each with its reason:
