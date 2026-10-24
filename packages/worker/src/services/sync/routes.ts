/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Sync's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/sync`.
 *
 * U-05.12 adds the pull, `GET /<p>/sync` (path `""`). Every route takes the device bearer and is
 * unsigned; `auth: device` is declared here and enforced in the handler (`handlers/common.ts`).
 * U-05.13 adds the push, `POST /<p>/sync/ops`. The file routes are U-10's. A path no row matches is `null`
 * (Core's not-found).
 */

import { serviceRoutes } from "../../core/http/routes.js";
import { handlePull } from "./handlers/pull.js";
import { handlePush } from "./handlers/push.js";

export const SYNC_ROUTES = serviceRoutes("sync", [
  {
    path: "",
    methods: ["GET"],
    auth: { kind: "device" },
    // U-05.12: the device bearer is never ambient, so a listed origin reaches only what that
    // page's own device token already can.
    cors: true,
    handler: (ctx) => handlePull(ctx),
  },
  // U-05.13: the push. The 256 KiB cap (`SYNC_MAX_PUSH_BYTES`) is applied in the handler, not as
  // a `bodyCap` here: the row cap belongs to CI rows (`serviceRouteTables`) and its reader answers
  // `400`, where the contract says `413 body_too_large`. The body is read only after the bearer,
  // the principal, the pause and the trust check.
  {
    path: "ops",
    methods: ["POST"],
    auth: { kind: "device" },
    cors: true, // U-05.13, as the pull
    handler: (ctx) => handlePush(ctx),
  },
]);
