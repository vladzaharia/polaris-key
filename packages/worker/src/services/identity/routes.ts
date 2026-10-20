/// <reference types="@cloudflare/workers-types" />

/**
 * Identity's routes, as a table (`core/http/routes.ts`), over the path AFTER `/<product>/identity` (§R1):
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
 *     /identity/authorize                   GET   I-08, begin the app passthrough sign-in
 *     /identity/token                       POST  I-08, redeem the code (form body)
 *     /identity/choice/licenses             POST  I-08b, the pending sign-in grant: the licence view
 *     /identity/choice/devices              POST  I-08b, a full licence's seat-holding devices
 *     /identity/choice/complete             POST  I-08b, the choice; answers the `token` response
 *     /identity/choice/cancel               POST  I-08b, end the grant; nothing is bound
 *     /identity/attach                      POST  add the device's licence to the signed-in
 *                                                 account (I-09; device bearer)
 *     /identity/subject                     GET   the pairwise subject signed in on the device
 *     /identity/signout                     POST  sign the device out of its account
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

import {
  serviceRoutes,
  type ServiceRouteHandler,
} from "../../core/http/routes.js";
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
import {
  handleIdentityAttach,
  handleIdentitySignOut,
  handleIdentitySubject,
} from "./attach.js";
import { handleAuthorize } from "./passthrough/authorize.js";
import { handleToken } from "./passthrough/token.js";
import { readCiJson } from "../../core/ciScope.js";
import { handleChoice } from "./passthrough/choiceRoutes.js";

/** The grant routes' largest body: a grant, a licence id or a choice with a key. */
const CHOICE_BODY_CAP = 4 * 1024;

/**
 * One row per grant route (I-08b, §12.5.1). The grant in the body and the redeeming device id are
 * the credential (`code`: the artefact the flow that issued it hands out), checked by the handler.
 */
const choiceRow = (action: "licenses" | "devices" | "complete" | "cancel") => ({
  path: `choice/${action}`,
  methods: ["POST" as const],
  auth: { kind: "code" as const },
  handler: (async (ctx) => {
    // The table forbids a cap on a non-CI row (`serviceRouteTables`), so the handler reads it.
    const body = await readCiJson(ctx.req, CHOICE_BODY_CAP);
    if (body instanceof Response) return body;
    const { req, env, db, product, now, settings } = ctx;
    return handleChoice(action, {
      req,
      env,
      db,
      product,
      now,
      body,
      ...(settings ? { settings } : {}),
    });
  }) satisfies ServiceRouteHandler,
});

export const IDENTITY_ROUTES = serviceRoutes("identity", [
  {
    path: "session",
    methods: ["GET"],
    auth: { kind: "session" },
    handler: ({ req, env, db, product, now, settings }) =>
      handleBrowserSession(req, env, db, product, now, settings),
  },
  {
    path: "session/license",
    methods: ["POST"],
    auth: { kind: "handler" },
    handler: ({ req, env, db, product, now, settings }) =>
      handleBrowserSessionLicense(req, env, db, product, now, settings),
  },
  // I-08 (WIRE-CONTRACT-V4 §12.4, §12.5): the app passthrough. `authorize` is a navigation that
  // starts the platform sign-in; `token` redeems the code (PKCE) from a form body and answers
  // CORS without credentials. Both handlers keep their own method guard and rate limits.
  {
    path: "authorize",
    methods: ["GET"],
    auth: { kind: "none" },
    handler: ({ req, env, db, product, now, settings, hooks }) =>
      handleAuthorize({
        req,
        env,
        db,
        product,
        now,
        hooks,
        ...(settings ? { settings } : {}),
      }),
  },
  {
    path: "token",
    methods: ["POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now }) =>
      handleToken({ req, env, db, product, now }),
  },
  // I-08b (§12.5.1): the pending sign-in grant's routes.
  choiceRow("licenses"),
  choiceRow("devices"),
  choiceRow("complete"),
  choiceRow("cancel"),
  // I-09 (WIRE-CONTRACT-V4 §12.3): the account on the device wire.
  {
    path: "attach",
    methods: ["POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleIdentityAttach(req, env, db, product, now),
  },
  {
    path: "subject",
    methods: ["GET"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleIdentitySubject(req, env, db, product, now),
  },
  {
    path: "signout",
    methods: ["POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleIdentitySignOut(req, env, db, product, now),
  },
  {
    path: "auth/start",
    methods: ["GET"],
    auth: { kind: "none" },
    handler: ({ req, env, db, product }) =>
      handleAuthStart(req, env, db, product),
  },
  {
    path: "auth/callback",
    methods: ["GET"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now }) =>
      handleAuthCallback(req, env, db, product, now),
  },
  {
    path: "auth/logout",
    methods: ["POST"],
    auth: { kind: "session" },
    handler: ({ req, env, db, product, now }) =>
      handleBrowserLogout(req, env, db, product, now),
  },
  {
    path: "auth/device",
    methods: ["GET", "POST"],
    auth: { kind: "code" },
    handler: ({ req, env, product }) =>
      handleAuthDeviceEntry(req, env, product),
  },
  {
    path: "auth/choose",
    methods: ["GET", "POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now, hooks }) =>
      handleAuthChoose(req, env, db, product, now, hooks),
  },
  {
    path: "auth/device/start",
    methods: ["POST"],
    auth: { kind: "none" },
    handler: ({ req, env, db, product }) =>
      handleAuthDeviceStart(req, env, db, product),
  },
  {
    path: "auth/device/verify",
    methods: ["GET", "POST"],
    auth: { kind: "code" },
    handler: ({ req, env, product }) =>
      handleAuthDeviceVerify(req, env, product),
  },
  {
    path: "auth/device/poll",
    methods: ["POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now, licenseMerge }) =>
      handleAuthDevicePoll(req, env, db, product, now, licenseMerge),
  },
]);
