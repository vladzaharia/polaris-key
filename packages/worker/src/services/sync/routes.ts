/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Sync's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/sync`.
 *
 * None yet: until U-05's device routes ship, `handle` answers none (`null` → Core's not-found) and
 * `surface` is empty. U-05 adds its rows here, and the spec entries and `routeCoverage` follow
 * from them.
 */

import { serviceRoutes } from "../../core/http/routes.js";

export const SYNC_ROUTES = serviceRoutes("sync", []);
