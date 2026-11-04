import { runPart } from "./parts.js";

// Part 0 of 2 of the portalQuality checks: see parts.ts and portalQualitySuite.ts.
await runPart(
  { suite: "portalQuality", index: 0, count: 2 },
  () => import("./portalQualitySuite.js"),
);
