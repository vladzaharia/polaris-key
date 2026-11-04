import { runPart } from "./parts.js";

// Part 1 of 2 of the portalUxBar checks: see parts.ts and portalUxBarSuite.ts.
await runPart(
  { suite: "portalUxBar", index: 1, count: 2 },
  () => import("./portalUxBarSuite.js"),
);
