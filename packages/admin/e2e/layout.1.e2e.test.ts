import { runPart } from "./parts.js";

// Part 1 of the console layout lint: see layoutParts.ts and layoutSuite.ts.
await runPart(
  { suite: "layout", index: 1, count: 8 },
  () => import("./layoutSuite.js"),
);
