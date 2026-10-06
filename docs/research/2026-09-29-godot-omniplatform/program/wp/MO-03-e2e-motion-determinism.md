# MO-03 E2E determinism and the motion smoke suite: every e2e context runs with reduced motion; a new `e2e/motion.e2e.test.ts` asserts token durations, exits, View Transitions, the list budget and zero CSP violations with motion on

| Field       | Value                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | MO: Motion system (notes/S-23) (wave 1: foundation)                                                                                                                                                                        |
| Size        | 0.3–0.5 engineer-weeks                                                                                                                                                                                                     |
| Depends on  | [MO-02](MO-02-motion-layer.md)                                                                                                                                                                                             |
| Unblocks    | [MO-04](MO-04-console-navigation-motion.md), [MO-05](MO-05-portal-navigation-motion.md), [MO-06](MO-06-portal-device-activation-motion.md), [MO-07](MO-07-portal-library-motion.md), [MO-09](MO-09-console-data-motion.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                         |
| Plan mode   | no                                                                                                                                                                                                                         |
| Gates       | `pnpm --filter @polaris-key/admin test:e2e` (all suites, including the new one) with zero CSP violations; the layout lint at zero                                                                                          |
| Human input | none                                                                                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                  |

## Goal

Screenshots, the layout lint and every existing e2e assertion see final states regardless of motion, and one suite proves the motion itself works under the Worker's CSP.

## Why

Once MO-04 onwards add View Transitions and exits, a screenshot or a layout probe could catch a frame mid-animation. Running the suites with `reducedMotion: "reduce"` makes every change an instant swap (D3), so they stay deterministic; the smoke suite keeps the motion honest (notes/S-23 §6.8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [notes/S-23-motion-system.md](../../notes/S-23-motion-system.md): the decisions D1–D10, §5 (tokens), §6 (patterns and rules), §10 (this package's row).
- The reference implementation: [`prototype/motion/motion.css`](../../prototype/motion/motion.css) and [`motion.js`](../../prototype/motion/motion.js); the flows in [`portal.html`](../../prototype/motion/portal.html) and [`console.html`](../../prototype/motion/console.html); the strips in [`shots/`](../../prototype/motion/shots/).
- `packages/admin/e2e/*.e2e.test.ts` (each `browser.newContext` call), `e2e/layoutProbe.ts`, `e2e/csp.e2e.test.ts`.
- [`prototype/motion/tools/strips.mjs`](../../prototype/motion/tools/strips.mjs) for the CDP `Animation.setPlaybackRate` technique.

## Scope

**In:**

- `reducedMotion: "reduce"` on every context in `layout`, `portal`, `portalMedia`, `core`, `csp`, `config`, `distribution` and `kit` e2e suites.
- `e2e/motion.e2e.test.ts` (new), motion on (`no-preference`), both themes, against the built SPA under the Worker CSP: a Dialog's enter and exit run with durations equal to the resolved tokens and the node leaves the DOM after the exit; a console route change sets `html[data-vt]` and its transition finishes; a portal route change likewise (once MO-05 lands, the test is extended there); a list mutation names at most 30 rows; zero `securitypolicyviolation` events; and the same interactions with `reducedMotion: "reduce"` start no transition and leave `document.getAnimations()` empty.

**Out** (and where it belongs instead):

- Pattern coverage beyond the foundation (each area package extends the smoke suite).
- Frame-time budgets (→ MO-13).

## Design notes

- Read durations through `getComputedStyle(document.documentElement).getPropertyValue('--pk-duration-…')` and compare to `animation.effect.getTiming().duration`.
- `wp/PX-20-portal-quality-bar`, `wp/PX-16-discover-page` and `integ/identity-store-1` edit `portal.e2e.test.ts` and `portalFixtures.ts`: the change here is one context option per call; rebase rather than wait.

## Files it touches

`packages/admin/e2e/{layout,portal,portalMedia,core,csp,config,distribution,kit}.e2e.test.ts` (context options only), new `e2e/motion.e2e.test.ts`. In flight: `wp/PX-20`, `wp/PX-16`, `integ/identity-store-1` (portal e2e).

## Steps

1. Add the option to every context.
2. Write the smoke suite against today's overlays (MO-02's exits) and one console route.
3. Run every e2e suite twice to show stability.

## Corrections (as built, 2026-10-05)

- **The portal suites already ran reduced.** `portal.e2e.test.ts` and `portalQuality.e2e.test.ts`
  open every page through `e2e/portalHarness.ts`, which set `reducedMotion: "reduce"` before this
  package. The harness gains a `reducedMotion` option (default `"reduce"`) so the motion suite can
  turn motion on; `portal.e2e.test.ts` itself is untouched.
- **Every context, not only the listed suites.** `license.e2e.test.ts` and
  `storeCheck.e2e.test.ts` open contexts too and get the same option. `kit.e2e.test.ts` keeps its
  explicit `no-preference` cases and defaults to `reduce`.
- **No route calls `viewTransition()` yet.** MO-02 shipped the layer without consumers (MO-04 wires
  the console router, MO-05 the portal's), so the route and list checks bundle the layer's real
  source (`src/ui/motion/viewTransition.ts`, with Vite) and drive it inside the page against the
  built `motion.css`, over the DevTools protocol. MO-04 and MO-05 replace the injected call with a
  real navigation. A portal route check is included now, on the same terms.
- **The phone navigation drawer is an `animate-pk-in` dialog**, so it exits through `pk-exit` on
  `base`, not the `.pk-drawer` pattern.
- **Reduced motion did not collapse bare Tailwind transitions.** A `transition-colors` with no
  duration utility (17 sites, the sidebar links among them) ran Tailwind's 150 ms default even
  under `prefers-reduced-motion`; the smoke suite caught it on a route change. `src/motion.css`
  gains a section 0 that points `--default-transition-duration` and
  `--default-transition-timing-function` at `micro` and `standard`.
- **From the MO-02 review:** the motion lint also bans numbered `duration-NNN` and `delay-NNN`
  utilities, and the smoke suite closes the Cmd-K palette, the product switcher, the phone
  navigation (console) and the JumpPalette (portal) for real and checks `getAnimations()`.

## Acceptance criteria

- [x] Every e2e context in the listed suites sets `reducedMotion: "reduce"`.
- [x] `e2e/motion.e2e.test.ts` passes and fails if `motion.css` is not loaded (shown by a temporary revert in the PR description).
- [x] Two consecutive full e2e runs pass with identical layout-lint output.
- [x] The green gate passes (AGENTS.md), including `pnpm --filter @polaris-key/worker test adminCspParity` after the admin build and `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

Area packages add their pattern to `e2e/motion.e2e.test.ts` and rely on the other suites being motion-free. The role agent sets `--set MO-03 in-review` when it hands off. After review, the lead adds the last commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set MO-03 done`.
