/// <reference types="@cloudflare/workers-types" />

/**
 * Identity's own sub-router, over the path segments AFTER `/<product>/identity` (§R1):
 *
 *     /identity/session                     GET   the browser session's fused document
 *     /identity/session/license             POST  licence key → session cookie
 *     /identity/auth/start                  GET   begin PKCE, 302 to the IdP
 *     /identity/auth/callback               GET   exchange the code, mint/locate the licence
 *     /identity/auth/logout                 POST  drop the session + deauthorize its device
 *     /identity/auth/device                 GET   the RFC 8628 user-code page (entry form, or the
 *                                                 confirmation page for `?user_code=`)
 *                                           POST  look a typed code up, or confirm it (CSRF)
 *     /identity/auth/device/start           POST  begin a device-code flow
 *     /identity/auth/device/verify          GET   render the confirmation page (by device code;
 *                                                 kept for flows started before `/device`)
 *                                           POST  confirm it
 *     /identity/auth/device/poll            POST  poll a confirmed device flow
 *     /identity/auth/choose                 GET   the legacy sign-in's licence chooser (I-26)
 *                                           POST  record a step of it, or the choice
 *
 * There are no aliases. The pre-namespace spellings (`/<p>/session`, `/<p>/auth/…`) are deleted
 * outright, unlike the four permanent aliases D-07 keeps for Release/Update: those exist because
 * a `SUFeedURL` or a published `curl … | sh` line is compiled into artefacts nobody can recall.
 * Nothing ships an identity URL that way — SDKs read them from `/.well-known/polaris.json`, and
 * the browser flows are entered from a page the deployment serves. The one pinned path is an
 * operator's IdP redirect-URI registration, which is per-product configuration, not a shipped
 * binary (see `oidc.ts`'s `beginAuthFlow`).
 *
 * `/auth/login` is gone with them: it was a second spelling of `/auth/start` and §R1 removes it.
 * So is `/auth/poll`, which put both halves of a `state` + device-id poll in a query string and
 * had nothing left to redeem (no flow it could complete is started any more); a device polls
 * `/auth/device/poll` with its device code.
 *
 * Returning `null` for an unmatched segment is the registry contract (`core/registry.ts`): only
 * Core decides what "no route here" means, which is what makes a disabled service, an
 * unregistered slug and a bad path indistinguishable from outside.
 */

import type { ServiceContext } from "../../core/registry.js";
import {
  handleAuthCallback,
  handleAuthChoose,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
  handleAuthStart,
} from "./oidc.js";
import {
  handleBrowserLogout,
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "./browserSession.js";

export async function handleIdentityRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest, now, settings } = ctx;

  if (rest.length === 1) {
    if (rest[0] === "session")
      return handleBrowserSession(req, env, db, product, now, settings);
    return null;
  }

  if (rest.length === 2) {
    if (rest[0] === "session" && rest[1] === "license")
      return handleBrowserSessionLicense(req, env, db, product, now, settings);
    if (rest[0] !== "auth") return null;
    switch (rest[1]) {
      case "start":
        return handleAuthStart(req, env, db, product);
      case "callback":
        return handleAuthCallback(req, env, db, product, now);
      case "logout":
        return handleBrowserLogout(req, env, db, product);
      case "device":
        return handleAuthDeviceEntry(req, env, product);
      case "choose":
        return handleAuthChoose(req, env, db, product, now, ctx.hooks);
      default:
        return null;
    }
  }

  if (rest.length === 3 && rest[0] === "auth" && rest[1] === "device") {
    switch (rest[2]) {
      case "start":
        return handleAuthDeviceStart(req, env, db, product);
      case "verify":
        return handleAuthDeviceVerify(req, env, product);
      case "poll":
        return handleAuthDevicePoll(
          req,
          env,
          db,
          product,
          now,
          ctx.licenseMerge,
        );
      default:
        return null;
    }
  }

  return null;
}
