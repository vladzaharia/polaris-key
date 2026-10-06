# S-23 motion prototypes and tools

The clickable prototypes and the measurement tools behind
[`notes/S-23-motion-system.md`](../../notes/S-23-motion-system.md). Nothing here ships: MO-01 moves
the tokens into `packages/brand`, MO-02 moves `motion.css` and `motion.js` into
`packages/admin/src/` (as `motion.css` and `ui/motion/`).

| File                                                          | What it is                                                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motion.css`                                                  | The reference stylesheet: proposed tokens (§1), keyframes, and every named pattern, including the View Transition rules gated by `html[data-vt]`                                 |
| `motion.js`                                                   | The utility layer (about 1.3 KB gzip): `viewTransition`, `presence`, `countTo`, `setMeter`, `highlight`, `celebrateOnce`, `startCountdown`, `reducedMotion`                      |
| `portal.html`, `portal.js`                                    | Customer portal: Library → product (shared element) → Activate (dialog morph, success) → free a device (expand, list exit, meter, count, toast with Undo)                        |
| `console.html`, `console.js`                                  | Console: product overview (skeleton, count-up, meter, first-release moment) → Licenses (facet chips, list) → licence record (tabs) → device drawer → confirm → toast; ⌘K palette |
| `proto.css`, `portal.css`, `console.css`, `h.js`, `shared.js` | Prototype chrome, a DOM builder (no markup strings) and the shared toast and toolbar                                                                                             |
| `tools/serve.mjs`                                             | Serves the repository root with the Worker's console CSP (`style-src 'self'`, `script-src 'self'`) on every HTML page                                                            |
| `tools/csp-probe.mjs`                                         | Which motion mechanisms survive that CSP, and View Transition feature support, in Chromium and WebKit                                                                            |
| `tools/strips.mjs`                                            | Drives both prototypes through every moment, slows animations with the DevTools Animation domain, writes one frame strip per moment to `strips/`                                 |
| `tools/perf.mjs`                                              | rAF frame intervals per moment at CPU throttling 1×, 4× and 6×, with instant-swap baselines; writes `strips/perf.json`                                                           |
| `tools/real-app.ts`                                           | Frame strips of today's portal (the built SPA on the e2e fixtures) for the baseline                                                                                              |
| `shots/`                                                      | The curated strips the note cites (committed). `strips/` is the full, regenerated output (git-ignored)                                                                           |

## Run

Open the prototypes from a local server (the brand tokens and fonts load from
`packages/brand`), for example:

```sh
mise exec node@22 -- node -e 'import("./docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/serve.mjs").then(async (m) => { const { base } = await m.serve(); console.log(base + m.PROTO + "portal.html") })'
```

The toolbar (bottom left) switches the theme (a View Transition cross-fade), turns on reduced
motion (`html[data-motion="reduce"]`) and replays the flow. `?theme=light` and `?motion=reduce`
set them from the URL.

The tools need `pnpm install` and the admin package's Playwright browsers:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin exec playwright install chromium webkit
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/csp-probe.mjs
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/strips.mjs [filter]
mise exec node@22 -- node docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/perf.mjs
mise exec node@22 -- pnpm --filter @polaris-key/admin build
( cd packages/admin && mise exec node@22 -- npx tsx ../../docs/research/2026-09-29-godot-omniplatform/prototype/motion/tools/real-app.ts )
```

Firefox could not be launched by Playwright on the measuring machine (macOS 27 beta), so the probe
covers Chromium and WebKit only; see the note's limits.
