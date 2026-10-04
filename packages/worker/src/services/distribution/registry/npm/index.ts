/**
 * The npm feed (F-04, plans/F-01.md §6.8): its renderer and its routes. `registry/index.ts`
 * lists it in `RENDERERS`, and `mount.ts` spreads its routes into `REGISTRY_ROUTES`.
 */

import type { RegistryRenderer } from "../materialise.js";
import { renderNpm } from "./render.js";
import { npmRoutes } from "./routes.js";

export const NPM_RENDERER: RegistryRenderer = {
  ecosystem: "npm",
  render: renderNpm,
  routes: npmRoutes(() => NPM_RENDERER),
};
