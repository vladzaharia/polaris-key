import { runPart } from "./parts.js";

// Part 2 of 3 of the portalResolutions checks: see parts.ts and portalResolutionsSuite.ts.
await runPart(
  { suite: "portalResolutions", index: 2, count: 3 },
  () => import("./portalResolutionsSuite.js"),
);
