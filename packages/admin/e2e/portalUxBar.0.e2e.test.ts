import { runPart } from "./parts.js";

// Part 0 of 2 of the portalUxBar checks: see parts.ts and portalUxBarSuite.ts.
await runPart(
  { suite: "portalUxBar", index: 0, count: 2 },
  () => import("./portalUxBarSuite.js"),
);
