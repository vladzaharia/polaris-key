/**
 * The OCI feed (F-08, plans/F-01.md §6.8): its renderer (`render.ts`, the tag list and the tag
 * pointers) and its pull routes under `/v2/` (`routes.ts`). Publishing is the CLI's: `pkey
 * release publish` reads an OCI image layout and uploads every blob through upload tickets
 * (`packages/cli/src/package/oci.ts`).
 */

import type { RegistryRenderer } from "../materialise.js";
import { renderOci } from "./render.js";
import { OCI_ROUTES } from "./routes.js";

export const OCI_RENDERER: RegistryRenderer = {
  ecosystem: "oci",
  render: (pkg) => renderOci(pkg),
  routes: OCI_ROUTES,
};
