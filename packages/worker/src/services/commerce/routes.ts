/// <reference types="@cloudflare/workers-types" />

/**
 * Commerce's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/commerce`.
 *
 * `binding` and `claim` are the device routes. The two store hooks are canonical at
 * `/<p>/distribution/hooks/{app-store,play-rtdn}` (`core/stores/hooks.ts`): the router matches
 * them, hands them to this service as `hooks/<hook>` and sets `ctx.storeHook`. A request for
 * `/<p>/commerce/hooks/*` has no flag and is the registry's not-found, so a hook row accepts only a
 * flagged request. Every row is `null` (Core's not-found) unless License is on and a grant writer
 * is present (`commerceAvailable`), whatever the method, before any credential is read.
 */

import {
  serviceRoutes,
  type ServiceRouteDecl,
} from "../../core/http/routes.js";
import { STORE_HOOK } from "../../core/stores/hooks.js";
import {
  commerceAvailable,
  handleAppStoreHook,
  handleBinding,
  handleClaim,
  handlePlayHook,
} from "./bridge.js";

function hookRow(
  hook: string,
  handler: ServiceRouteDecl["handler"],
): ServiceRouteDecl {
  return {
    path: `hooks/${hook}`,
    doc: `/{product}/distribution/hooks/${hook}`,
    methods: ["POST"],
    auth: { kind: "signature" },
    other: "none",
    accept: (ctx) => commerceAvailable(ctx) && ctx.storeHook === true,
    handler,
  };
}

export const COMMERCE_ROUTES = serviceRoutes("commerce", [
  {
    path: "binding",
    methods: ["GET"],
    auth: { kind: "device" },
    other: "none",
    accept: commerceAvailable,
    handler: (ctx) => handleBinding(ctx),
  },
  {
    path: "claim",
    methods: ["POST"],
    auth: { kind: "device" },
    other: "none",
    accept: commerceAvailable,
    handler: (ctx) => handleClaim(ctx),
  },
  hookRow(STORE_HOOK.app_store, (ctx) => handleAppStoreHook(ctx)),
  hookRow(STORE_HOOK.play, (ctx) => handlePlayHook(ctx)),
]);
