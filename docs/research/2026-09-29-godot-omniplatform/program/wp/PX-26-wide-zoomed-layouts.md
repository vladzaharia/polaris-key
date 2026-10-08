# PX-26 Wide and zoomed layouts: content max widths, 1920 px and 200% zoom in the console and portal quality bar

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                           |
| Size        | 0.2–0.4 engineer-weeks                                                                               |
| Depends on  | [PX-20](PX-20-quality-bar.md)                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                               |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no                                                                                                   |
| Gates       | `portal-e2e`, `console-csp-parity`, `ci`; visual baselines re-recorded with the reason in the commit |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Owner direction (2026-10-08)

- **Content max widths.** Wide windows use the width with side-by-side panels and cap the line length; content never stretches edge to edge.
- **Wide and zoomed checks.** The console and portal e2e, visual and layout-lint checks add the wide desktop (1920 px) and 200% zoom rows of [UI-KITS.md](../../../../design/UI-KITS.md) §7.1 to 1440 and 390 px, in both themes.

## Goal

No console or portal screen stretches edge to edge or breaks at 1920 px or at 200% zoom, and CI proves it. Done when every acceptance criterion holds and the green gate passes.

## Why

PX-20's quality bar checks 1440 and 390 px only. The owner asked on 2026-10-08 that every screen use wide windows well and stay usable at 200% zoom. A follow-up to a front-end PX package takes the next free number (README §8), so this is PX-26 rather than a suffix of PX-20.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`; `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- `wp/PX-20-quality-bar.md` (how the suite is built: `packages/admin/e2e/portalStates.ts`, `portalQuality.e2e.test.ts`, the Playwright image and `e2e:baselines`).
- [PORTAL.md §8](../../../../design/PORTAL.md#8-responsive-rules); `docs/design/BRAND.md` §7.6 (console density and layout); `packages/ui-qa` (`pnpm ui:lint`).

## Scope

**In:**

- A content max width for every console and portal page layout, with side-by-side panels where the width allows; documented in BRAND.md §7.6.
- The 1920 px and 200% zoom variants in the console and portal e2e and visual suites, both themes; the horizontal-scroll assertion at both.
- The same two sizes in `pnpm ui:lint --html` for the built console and portal pages.

**Out** (and where it belongs instead):

- The kits' size matrix (→ each UK package, against UI-KITS.md §7.1); the docs site (→ DOC-02b).

## Steps

1. Measure today's pages at 1920 px and 200% zoom; list what stretches or breaks.
2. Add the max widths and layouts; add the variants; re-record baselines with the reason; hand off for code and UX review.

## Acceptance criteria

- [ ] Every §4 state renders at 1920 px and at 200% zoom in both themes, with no horizontal scroll (e2e).
- [ ] No content column exceeds the documented max width at 1920 px (test).
- [ ] `pnpm ui:lint --html` passes on the built pages at both sizes.
- [ ] `pkey-ux-reviewer` passes the wide and zoomed screens in a real browser.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
mise exec node@22 -- pnpm ui:lint
```

## Hand-off

The role agent sets `--set PX-26 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-26 done`.
