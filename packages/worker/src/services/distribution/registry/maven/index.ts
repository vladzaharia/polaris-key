/**
 * The Maven feed (F-07, plans/F-01.md §6.8): `maven-metadata.xml` and its checksum sidecars,
 * rendered on write (`render.ts`), and the repository layout's two routes (`routes.ts`).
 */

import type { RegistryRenderer } from "../materialise.js";
import { renderMaven } from "./render.js";
import { mavenRoutes } from "./routes.js";

export const MAVEN_RENDERER: RegistryRenderer = {
  ecosystem: "maven",
  render: (pkg) => renderMaven(pkg),
  routes: mavenRoutes(() => MAVEN_RENDERER),
};
