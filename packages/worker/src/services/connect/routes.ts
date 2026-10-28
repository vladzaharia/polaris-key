/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Connect's routes, as a table (`core/http/routes.ts`), over the path AFTER
 * `/<product>/connect`. CC-06.1 serves the identity and devices routes; the relay routes follow
 * in CC-07.3. Both take the device bearer (`auth: device`, enforced in the handler) and are
 * unsigned JSON. Both are readable from a listed `web.origins` page (`cors: true`), as Cloud Sync's:
 * the bearer is never ambient, and a web app joins the roster through the relay.
 * A path no row matches is `null` (Core's not-found).
 */

import { serviceRoutes } from "../../core/http/routes.js";
import { handleDevices, handleIdentity } from "./identity.js";

export const CONNECT_ROUTES = serviceRoutes("connect", [
  {
    path: "identity",
    methods: ["GET"],
    auth: { kind: "device" },
    cors: true,
    handler: (ctx) => handleIdentity(ctx),
  },
  {
    path: "devices",
    methods: ["GET"],
    auth: { kind: "device" },
    cors: true,
    handler: (ctx) => handleDevices(ctx),
  },
]);
