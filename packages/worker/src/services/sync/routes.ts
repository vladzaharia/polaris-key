/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Sync's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/sync`.
 *
 * U-05.12 adds the pull, `GET /<p>/sync` (path `""`). Every route takes the device bearer and is
 * unsigned; `auth: device` is declared here and enforced in the handler (`handlers/common.ts`).
 * The push (`ops`) is U-05.13's and the file routes U-10's. A path no row matches is `null`
 * (Core's not-found).
 */

import { serviceRoutes } from "../../core/http/routes.js";
import { handlePull } from "./handlers/pull.js";

export const SYNC_ROUTES = serviceRoutes("sync", [
  {
    path: "",
    methods: ["GET"],
    auth: { kind: "device" },
    handler: (ctx) => handlePull(ctx),
  },
]);
