import { runPart } from "./parts.js";

// Part 1 of 3 of the portalResolutions checks: see parts.ts and portalResolutionsSuite.ts.
await runPart(
  { suite: "portalResolutions", index: 1, count: 3 },
  () => import("./portalResolutionsSuite.js"),
);
