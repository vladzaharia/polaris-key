/** The seven steps of Add to storefronts, in order (STOREFRONTS_FLOW holds their labels). */
export const FLOW_STEPS = [
  "choose",
  "prerequisites",
  "listing",
  "assets",
  "plan",
  "run",
  "submit",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];
