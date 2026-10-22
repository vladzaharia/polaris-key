import { requirement } from "@polaris-key/server/next";
import { polaris } from "./lib/polaris";

// A coarse gate in front of a path. The first matching rule decides; other paths pass.
export const middleware = polaris.middleware([
  { path: "/api/team", require: [requirement.tier("pro", "team")] },
]);
export const config = { matcher: "/api/team" };
