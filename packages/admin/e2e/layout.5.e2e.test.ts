import { runPart } from "./parts.js";

// Part 5 of the console layout lint: see layoutParts.ts and layoutSuite.ts.
await runPart(
  { suite: "layout", index: 5, count: 8 },
  () => import("./layoutSuite.js"),
);
