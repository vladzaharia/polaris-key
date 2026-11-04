import { runPart } from "./parts.js";

// Part 6 of the console layout lint: see layoutParts.ts and layoutSuite.ts.
await runPart(
  { suite: "layout", index: 6, count: 8 },
  () => import("./layoutSuite.js"),
);
