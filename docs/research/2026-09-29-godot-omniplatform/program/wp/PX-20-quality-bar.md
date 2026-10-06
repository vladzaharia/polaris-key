# PX-20 Portal quality bar: Playwright e2e over all §4 states in both themes at 1440 and 390 px, axe on every state, CSP browser test, visual baseline, horizontal-scroll assertion

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                                           |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                               |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                                                                                       |
| Unblocks    | none                                                                                                                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                   |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components; runs in CI |
| Human input | none                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                            |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- E2E covers every LicenseChoice state of SIGN-IN.md §6.2's conformance list (incl. sign-in and mixed) in both themes at 1440 and 390; axe and keyboard checks per §3.14 (no radio on full and blocked rows, Replace reachable by Tab, focus to the h1, one code input).

## Goal

CI runs Playwright over every §4 state in both themes at 1440 and 390 px with axe on every state, a CSP browser test, a visual baseline and the horizontal-scroll assertion; the suite grows with each PX front-end package and is complete when the last one lands.

## Why

The quality bar is rolling ([PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17)); §9 item 10 calls it "PX-15", a leftover from an earlier numbering: it is this package. PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §8](../../../../design/PORTAL.md#8-responsive-rules), [PORTAL.md §9](../../../../design/PORTAL.md#9-accessibility), [PORTAL.md Appendix A](../../../../design/PORTAL.md#appendix-a--mockup-inventory)
- `packages/admin/e2e/csp.e2e.test.ts`
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- Playwright states, axe, CSP test, visual baseline, horizontal-scroll assertion; CI wiring.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- **Rolling:** start once PX-01 lands; each PX front-end package adds its states here. Mark it done only after every other PX front-end package is done.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-20:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-20 in-review`.

## Acceptance criteria

- [ ] The suite runs in CI and covers every §4 state that has shipped, in both themes at both widths.
- [ ] Zero CSP violations and zero axe violations.
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

none.

The role agent sets `--set PX-20 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-20 done`.
