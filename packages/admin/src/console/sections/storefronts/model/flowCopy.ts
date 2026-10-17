/**
 * The words of the Add to storefronts wizard (ST-39): each step's question, its aside, and which
 * steps may be skipped.
 */

/** The step's question (SETUP.md §1.1: what the operator does, never "Step 3"). */
export const TITLE: Record<string, string> = {
  choose: "Choose the storefronts",
  prerequisites: "Check the prerequisites",
  listing: "Check the listing",
  assets: "Accept the assets",
  plan: "Review the plan",
  run: "Run the steps",
  submit: "Submit and release",
};

/** The steps an operator may skip: the listing and the assets can be done in the store's console. */
export const SKIPPABLE: ReadonlySet<string> = new Set(["listing", "assets"]);

export const ASIDE: Record<string, string> = {
  choose:
    "Each store shows what Polaris Key does for it through the store's API, what CI does, and what you do from a link.",
  prerequisites:
    "Checked for each store: the team connection, the product's app, and the write permissions, which only a first write can prove.",
  listing:
    "One listing serves every store. The fit report shows what does not fit a store; nothing is ever cut to fit.",
  assets:
    "CI derives and composes the store art from your masters. Nothing reaches a store until you accept it here.",
  plan: "Every step, in order, with how it is done. The external writes are listed before anything runs.",
  run: "Each step shows what the store answers, read back after the write. You can leave and come back: progress is kept.",
  submit:
    "Submit and release are confirmed by typing the app's name as the store shows it.",
};

/** What the done Storefronts step says was decided: the stores chosen. */
export function decidedStores(
  chosen: readonly { label: string }[],
): string | undefined {
  if (chosen.length === 0) return undefined;
  return chosen.length <= 2
    ? chosen.map((s) => s.label).join(", ")
    : `${chosen.length} storefronts`;
}
