/// <reference types="@cloudflare/workers-types" />

/**
 * Cloud Connect's routes, as a table (`core/http/routes.ts`), over the path AFTER
 * `/<product>/connect`. CC-06.1 serves the identity and devices routes and CC-07.3 the relay
 * ticket and upgrade. The first three take the device bearer (`auth: device`, enforced in the
 * handler) and are unsigned JSON; the upgrade takes the single-use ticket in the subprotocol
 * (`auth: code`). The device routes are readable from a listed `web.origins` page (`cors: true`), as Cloud Sync's:
 * the bearer is never ambient, and a web app joins the roster through the relay.
 * A path no row matches is `null` (Core's not-found).
 */

import { serviceRoutes } from "../../core/http/routes.js";
import { handleDevices, handleIdentity } from "./identity.js";
import { handleRelayTicket, handleRelayUpgrade } from "./relay/handlers.js";

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
  {
    // The bearer buys a ticket; a browser WebSocket cannot send `Authorization` (plans C11).
    path: "relay/ticket",
    methods: ["POST"],
    auth: { kind: "device" },
    cors: true,
    handler: (ctx) => handleRelayTicket(ctx),
  },
  {
    // A WebSocket upgrade: CORS does not apply to it, the single-use ticket is the credential.
    path: "relay",
    methods: ["GET"],
    auth: { kind: "code" },
    handler: (ctx) => handleRelayUpgrade(ctx),
  },
]);
