/**
 * The Swift package registry feed (F-06, plans/F-01.md §5.3 and §6.8; SwiftPM `Registry.md`,
 * SE-0292): one `RegistryRenderer`, its documents (`render.ts`) and its read routes
 * (`routes.ts`). `registry/index.ts` adds it to `RENDERERS`.
 */

import type { RegistryRenderer } from "../materialise.js";
import { renderSwift } from "./render.js";
import { SWIFT_ROUTES } from "./routes.js";

export const SWIFT_RENDERER: RegistryRenderer = {
  ecosystem: "swift",
  render: renderSwift,
  routes: SWIFT_ROUTES,
};
