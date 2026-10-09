# DOC-13 Site code examples type-checked per SDK in this repo

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) |
| Size        | 1–2 engineer-weeks                                                                                   |
| Depends on  | [DOC-02a](DOC-02a-shared-components.md)                                                              |
| Unblocks    | none                                                                                                 |
| Role        | `pkey-sdk-porter`                                                                                    |
| Plan mode   | no (no wire change)                                                                                  |
| Gates       | docs-links, drift-gate                                                                               |
| Human input | The website owner switches examples-data.js to the generated file                                    |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

The 49 code examples and 39 workflow fallbacks of plrs.im live in `examples/site/<language>/<module>.*`, are compiled or type-checked in each SDK's test job, and export `examples.json` in the site's schema.

## Why

Site examples must not drift from the SDKs they show.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B11.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- Move the examples with notes in front matter; compile or type-check them (tsc for React and Node, pyright for Python, swift build, Godot headless parse, Kotlin compile).
- A generator writes `examples.json`; a drift check fails when an API an example uses is removed.
- Marketing labels Cloud Sync 'In development' with synced-settings-only claims until U-05 and U-20 ship; marketing names are page titles only, body copy uses glossary words (B11).

**Out** (and where it belongs instead):

- The website repo's own page code.

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B11 (program/BRAND-TRANSITION.md); section change site-34. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

## Acceptance criteria

- [ ] Every example compiles against the SDK versions on pkg.plrs.im.
- [ ] The generated JSON is byte-identical on regeneration; the docs language switcher reads the same files.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set DOC-13 in-review` when it hands off; after review the lead adds the last commit `--set DOC-13 done`.
