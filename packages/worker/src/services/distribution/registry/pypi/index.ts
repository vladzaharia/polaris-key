/**
 * The PyPI feed (F-05, plans/F-01.md §6.8): its renderer and its routes. `registry/index.ts`
 * registers it in `RENDERERS`; everything PyPI-specific stays in this directory.
 */

import type { RegistryRenderer } from "../materialise.js";
import { renderPypi } from "./render.js";
import { PYPI_ROUTES } from "./routes.js";

export const PYPI_RENDERER: RegistryRenderer = {
  ecosystem: "pypi",
  render: (pkg) => renderPypi(pkg),
  routes: PYPI_ROUTES,
};
