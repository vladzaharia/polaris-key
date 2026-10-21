import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { LINT_SCRIPT, lintPage } from "../../ui-qa/src/index.ts";
import {
  startPortal,
  type PortalHarness,
  type Theme,
} from "./portalHarness.js";
import { SHIPPED } from "./portalStates.js";

/**
 * The ui-qa board for the customer site (P0-36; UI-KITS.md §7.3). `pnpm ui:lint` lints the mockup
 * boards; this lints the built Polaris Locker screens the same way: every state in `SHIPPED`
 * (portalStates.ts), dark and light at 1440 px, through ui-qa's in-page modernity lint.
 *
 * Only the rules about what a person sees apply (`RULES`). The rest check how the UI kits are
 * written (literal colours, physical edges, `:active` states, ring spread, border widths): the
 * site is built on its own Tailwind layer and the stylesheet's utilities trip them by design, so
 * they stay out of this board; the kits' own boards and source lints keep them.
 *
 * Findings that predate the board are in `portalBoard.debt.json`, per state and theme, and the
 * ledger only shrinks: the test fails on a finding it does not hold (new debt) and on a recorded
 * one that has gone (stale debt). Re-record after clearing some with
 *
 *   PKEY_RECORD_PORTAL_BOARD=1 pnpm --filter @polaris-key/admin test:e2e portalBoard
 *
 * which only removes entries; it never adds one (a missing ledger is created once, to start).
 */

/** The rules that read the rendered screen: type size, separators, dismissals, art, weight. */
const RULES = new Set([
  "text-size-floor",
  "tier-separator",
  "x-beside-cancel",
  "empty-placeholder",
  "font-weight-700",
  "font-family",
]);

const LEDGER = new URL("./portalBoard.debt.json", import.meta.url);
const THEMES: Theme[] = ["dark", "light"];
const debt: Record<string, string[]> = existsSync(LEDGER)
  ? (JSON.parse(readFileSync(LEDGER, "utf8")) as Record<string, string[]>)
  : {};
const found: Record<string, string[]> = {};

/**
 * Radix numbers its overlay ids from React's `useId` counter (`#radix-_r_n_`), which moves whenever
 * a screen above gains or loses a component. The ledger names the finding by its place in the
 * markup, so the number is not part of the name.
 */
const norm = (f: string): string => f.replace(/#radix-[^.\s]*/g, "#radix-*");

let portal: PortalHarness;
beforeAll(async () => {
  portal = await startPortal();
});
afterAll(async () => {
  await portal?.stop();
  if (process.env.PKEY_RECORD_PORTAL_BOARD === "1") {
    const next: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(found)) {
      const kept = existsSync(LEDGER)
        ? list.filter((f) => debt[key]?.some((d) => norm(d) === norm(f)))
        : list;
      if (kept.length) next[key] = kept;
    }
    writeFileSync(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
  }
});

describe.concurrent("every shipped state passes the ui-qa lint", () => {
  for (const state of SHIPPED) {
    for (const theme of THEMES) {
      it(`${state.id}, ${theme}`, { retry: 2 }, async ({ expect }) => {
        const o = await portal.open(state.scenario, state.path, {
          theme,
          width: 1440,
          height: 900,
          routes: state.routes,
        });
        try {
          await state.ready(o.page);
          // The Worker's CSP refuses an injected script tag: hand the lint to the page over CDP.
          const cdp = await o.page.context().newCDPSession(o.page);
          await cdp.send("Runtime.evaluate", { expression: LINT_SCRIPT });
          const { violations } = await lintPage(o.page, { scope: "body" });
          const key = `${state.id}/${theme}`;
          const list = [
            ...new Set(
              violations
                .filter((v) => RULES.has(v.rule))
                .map((v) => `${v.rule}: ${v.target} ${v.detail}`),
            ),
          ].sort();
          found[key] = list;
          if (process.env.PKEY_RECORD_PORTAL_BOARD === "1") return;
          const known = (debt[key] ?? []).map(norm);
          const seen = list.map(norm);
          expect
            .soft(
              seen.filter((f) => !known.includes(f)),
              "new findings",
            )
            .toEqual([]);
          expect
            .soft(
              known.filter((f) => !seen.includes(f)),
              "recorded findings that have gone: shrink the ledger",
            )
            .toEqual([]);
        } finally {
          await o.close();
        }
      });
    }
  }
});
