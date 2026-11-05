import { runPart } from "./parts.js";

// Part 0 of the console layout lint: see layoutParts.ts and layoutSuite.ts.
await runPart(
  { suite: "layout", index: 0, count: 8 },
  () => import("./layoutSuite.js"),
);
