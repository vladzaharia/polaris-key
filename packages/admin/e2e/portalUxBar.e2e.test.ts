import { afterAll, beforeAll, describe, it } from "vitest";
import { reduceTransparency } from "../../ui-qa/src/index.ts";
import {
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { SHIPPED } from "./portalStates.js";
import { staleUxDebt, uxBarChecked } from "./uxBar.js";

/**
 * The UX bar over the BUILT customer site (UK-63; BRAND-TRANSITION B6, B7, B17): the rendered-DOM
 * rules of `@polaris-key/ui-qa`'s `ux-bar.ts` on every shipped §4 state, in both themes, at the
 * wide desktop, a phone (390 × 844), the 640 × 360 small-landscape row (UI-KITS.md §7.1) and with
 * `prefers-reduced-transparency`. The focus-ring walk (each tab stop's ring is its service ring)
 * runs once per state at the desktop. The same in-page lint's other rules, touch targets and the
 * 200 % / 400 % zoom rows are `uiLint.e2e.test.ts`; forced colours and `prefers-contrast: more`
 * are `portalContrast.e2e.test.ts`. Breaches that predate the rules are `UX_BAR_DEBT` in
 * `uxBar.ts`, which only shrinks.
 */

const ROWS = [
  { label: "1920", width: 1920, height: 1080, reduced: false },
  { label: "phone", width: 390, height: 844, reduced: false },
  { label: "landscape-640x360", width: 640, height: 360, reduced: false },
  { label: "reduced-transparency", width: 1920, height: 1080, reduced: true },
] as const;
const THEMES: Theme[] = ["dark", "light"];

let portal: PortalHarness;

beforeAll(async () => {
  portal = await startPortal();
});

afterAll(async () => {
  await portal?.stop();
  const stale = staleUxDebt("portal");
  if (stale.length)
    throw new Error(
      `UX_BAR_DEBT entries that no longer match a finding (delete them): ${stale.join(", ")}`,
    );
});

describe.concurrent("UX bar over the built customer site", () => {
  for (const state of SHIPPED) {
    describe(`§${state.section} ${state.title} (${state.id})`, () => {
      for (const row of ROWS) {
        for (const theme of THEMES) {
          it(`${row.label}, ${theme}`, async ({ expect }) => {
            const o = await portal.open(state.scenario, state.path, {
              theme,
              width: row.width,
              height: row.height,
              routes: state.routes,
              hasTouch: row.label === "phone",
            });
            try {
              if (row.reduced) await reduceTransparency(o.page);
              await state.ready(o.page);
              expect(
                await uxBarChecked(o.page, state.id, {
                  focus: row.label === "1920" && theme === "dark",
                }),
                "UX bar (B6, B7, B17)",
              ).toEqual([]);
            } finally {
              await o.close();
            }
          });
        }
      }
    });
  }
});
