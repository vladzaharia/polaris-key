/**
 * Every wizard in the console, as data (ST-39). `ui/wizard` renders them; `lintFlow` holds each to
 * SETUP.md §1.1 (`test/wizardKit.test.ts`). A new wizard adds its flow here before its page.
 *
 * `FLOW_EXEMPT` lists the flows that predate the five-step rule, each with the package that splits
 * it. The list only shrinks: a flow back within five steps loses its entry.
 */

import type { FlowDef } from "../../ui/wizard/index.js";

/** Distribution → Storefronts → Add to storefronts (A-18j), moved onto the kit by ST-39. */
export const STOREFRONTS_FLOW: FlowDef = {
  id: "storefronts",
  title: "Add to storefronts",
  steps: [
    { id: "choose", label: "Storefronts", kind: "choice" },
    { id: "prerequisites", label: "Prerequisites", kind: "prereq" },
    { id: "listing", label: "Listing", kind: "custom" },
    { id: "assets", label: "Assets", kind: "custom" },
    { id: "plan", label: "Plan", kind: "confirm" },
    { id: "run", label: "Run", kind: "custom" },
    { id: "submit", label: "Submit and release", kind: "confirm" },
  ],
};

/** Distribution → App Store → Distribute (A-19c): on the kit's `Stepper`, not yet its `Wizard`. */
export const APPSTORE_FLOW: FlowDef = {
  id: "appstore",
  title: "Distribute",
  steps: [
    { id: "build", label: "Build", kind: "custom" },
    { id: "compliance", label: "Export compliance", kind: "form" },
    { id: "notes", label: "Release notes", kind: "form" },
    { id: "testflight", label: "TestFlight", kind: "custom" },
    { id: "version", label: "Version", kind: "custom" },
    { id: "preflight", label: "Preflight", kind: "prereq" },
    { id: "submit", label: "Submit", kind: "confirm" },
  ],
};

/** New product from a GitHub repository (ST-43): the creating is the Check step's action. */
export const NEW_PRODUCT_REPO_FLOW: FlowDef = {
  id: "new-product-repo",
  title: "New product",
  steps: [
    { id: "repo", label: "Repository", kind: "form" },
    { id: "check", label: "Check", kind: "confirm" },
  ],
};

/** New product from scratch (ST-43): the creating is the last step's action. */
export const NEW_PRODUCT_SCRATCH_FLOW: FlowDef = {
  id: "new-product-scratch",
  title: "New product",
  steps: [
    { id: "name", label: "Name it", kind: "form" },
    { id: "purpose", label: "What it's for", kind: "choice" },
  ],
};

export const FLOWS: readonly FlowDef[] = [
  STOREFRONTS_FLOW,
  APPSTORE_FLOW,
  NEW_PRODUCT_REPO_FLOW,
  NEW_PRODUCT_SCRATCH_FLOW,
];

/** Flows longer than five steps today: the most they may have, and who splits them. */
export const FLOW_EXEMPT: Readonly<
  Record<string, { max: number; owner: string }>
> = {
  storefronts: { max: 7, owner: "A-23" },
  appstore: { max: 7, owner: "A-23" },
};
