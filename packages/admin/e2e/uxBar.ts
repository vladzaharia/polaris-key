import { appendFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  uxBarFindings,
  withoutUxDebt,
  type UxBarDebt,
} from "../../ui-qa/src/index.ts";

/**
 * The UX bar over the built console and customer site (UK-63; BRAND-TRANSITION B6, B7, B17): the
 * rendered-DOM rules of `@polaris-key/ui-qa`'s `ux-bar.ts`, run by `layout.e2e.test.ts` (console)
 * and `uiLint.e2e.test.ts` (customer site).
 *
 * Breaches that predate the rule are held here, each with the package that clears it. The list
 * only shrinks: a run fails when an entry no longer matches (`staleUxDebt`), so delete the entry
 * in the change that fixes the screen. A new screen never joins it.
 */
export const UX_BAR_DEBT: readonly (UxBarDebt & {
  /** Which e2e suite finds it: `layout.e2e` (console) or `uiLint.e2e` (customer site). */
  surface: "console" | "portal";
})[] = [
  {
    surface: "portal",
    rule: "ux-name-over-art",
    match: /^"In your library" is drawn over art/,
    where: /^discover-added$/,
    owner: "PX-16",
    why: "The just-added Discover tile paints its In your library plate on the cover art (DiscoverTile.tsx). B6 keeps text off customer art: the plate moves below the art or into the tile's caption row.",
  },
];

const used = new Set<number>();

/** The UX-bar findings for a page, less the debt entries that own them. */
export async function uxBarChecked(
  page: Page,
  where: string,
  options: { focus?: boolean } = {},
): Promise<string[]> {
  const found = await uxBarFindings(page, options);
  // `PK_UXBAR_COLLECT=<file>` records every finding (one JSON line each) and fails nothing: how
  // the debt list is drawn up, and how an owner sees what a screen still owes.
  if (process.env.PK_UXBAR_COLLECT) {
    for (const finding of found)
      appendFileSync(
        process.env.PK_UXBAR_COLLECT,
        JSON.stringify({ where, finding }) + "\n",
      );
    return [];
  }
  // `PK_UXBAR_NO_DEBT=1` ignores the debt list: the raw findings, and the negative control that
  // proves the wiring fails on a real breach.
  if (process.env.PK_UXBAR_NO_DEBT) return found;
  return withoutUxDebt(where, found, UX_BAR_DEBT, used);
}

/** Debt entries nothing matched in this run (only meaningful after a full run). */
export function staleUxDebt(surface: "console" | "portal"): string[] {
  if (process.env.PK_UXBAR_NO_DEBT) return [];
  return UX_BAR_DEBT.flatMap((d, i) =>
    d.surface !== surface || used.has(i)
      ? []
      : [`${d.rule} ${d.match} (${d.owner})`],
  );
}
