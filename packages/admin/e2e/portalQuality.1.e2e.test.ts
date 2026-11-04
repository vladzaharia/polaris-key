import { runPart } from "./parts.js";

// Part 1 of 2 of the portalQuality checks: see parts.ts and portalQualitySuite.ts.
await runPart(
  { suite: "portalQuality", index: 1, count: 2 },
  () => import("./portalQualitySuite.js"),
);
