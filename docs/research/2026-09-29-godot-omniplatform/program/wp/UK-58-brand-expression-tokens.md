# UK-58 Brand expression tokens: action-neutral role, display scale, weights 400/500/600

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md)                                     |
| Size        | 0.4–1 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                      |
| Unblocks    | [ST-48](ST-48-console-shell-v2.md), [DOC-02a](DOC-02a-shared-components.md), [DOC-02b](DOC-02b-chrome.md) |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no (no wire change)                                                                                       |
| Gates       | drift-gate, golden-images                                                                                 |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Goal

`@polaris-key/brand` generates the `action-neutral` token role (dark: action #f6f8ff on label #060912; light: action #060912 on label #ffffff), the display scale and display tracking tokens (only at 40 px and above, at most -0.02em in product), the 400/500/600 weight reconciliation, the accent display-fill decision for the light-theme tile, and the `./marketing.css` export, all with contrast tests.

## Why

The primary action becomes neutral ink in the console, portal and hosted sign-in (B2), and weights 400/500/600 apply on every surface (B7). The token layer must say so once, so area packages adopt roles and not hex values.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B2, B3, B7, B11.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- `action-neutral` role in the token source; `pnpm gen:brand` writes it to CSS, tokens.json, Swift and Godot outputs. UI kits keep the host or product accent as their primary; the polaris-key preset primary is the product accent (B2, DL13).
- Display scale and tracking tokens in `marketing.css`; marketing may use the site values, product uses at most -0.02em (B7, B11). CJK sample at tracking 0.
- Weights 400/500/600 reconciled in BRAND (700 only for the wordmark).
- Contrast tests for the action roles in both themes.

**Out** (and where it belongs instead):

- Console and portal adoption of the action roles (→ ST-48, PX packages).
- The font-weight sweep (→ ST-50).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B2, B3, B7, B11 (program/BRAND-TRANSITION.md); section changes brand-02, brand-14, brand-15, brand-17, brand-23. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

## Screen acceptance (brand transition, 2026-10-09)

Done when the Themes row holds. This package draws no screens of its own, so the other rows do not apply (EXPERIENCE.md §7.3).

- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1).

## Acceptance criteria

- [ ] `gen:brand` and `--check` pass; contrast tests cover the action roles.
- [ ] The preview has an 'Expression' page with display type in both themes and a CJK sample at tracking 0.
- [ ] Unblocks DOC-02a and DOC-02b (docs landing) and the website's token import.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set UK-58 in-review` when it hands off; after review the lead adds the last commit `--set UK-58 done`.
