/**
 * Add to storefronts: where the operator left off, kept per product in this browser (SETUP.md
 * §1.10), and which plan phases the Run step covers.
 */

import { FLOW_STEPS, type FlowStep } from "./flowSteps.js";

export const PHASES_RUN = new Set(["setup", "listing", "assets", "store"]);

const cursorKey = (slug: string): string => `pk.storefronts.flow.${slug}`;

export function readCursor(
  slug: string,
): { step: FlowStep; stores: string } | null {
  try {
    const v = JSON.parse(
      window.localStorage.getItem(cursorKey(slug)) ?? "null",
    );
    if (
      v &&
      FLOW_STEPS.includes(v.step) &&
      typeof v.stores === "string" &&
      v.stores
    )
      return v;
  } catch {
    /* no storage, or not ours */
  }
  return null;
}

export function writeCursor(
  slug: string,
  step: FlowStep,
  stores: string,
): void {
  try {
    window.localStorage.setItem(
      cursorKey(slug),
      JSON.stringify({ step, stores }),
    );
  } catch {
    /* private mode: the URL still holds the place */
  }
}
