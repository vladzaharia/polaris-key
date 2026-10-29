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
 *     /identity/auth/device/approve         GET   the explicit approval after sign-in (I-37)
 *                                           POST  Sign in on {device}, or Deny
 *     /identity/auth/device/verify          GET   retired (I-37): the start-again page (by device code;
 *                                                 kept for flows started before `/device`)
 *                                           POST  confirm it
 *     /identity/auth/device/poll            POST  poll a confirmed device flow
 *     /identity/auth/choose                 GET   the legacy sign-in's licence chooser (I-26)
 *                                           POST  record a step of it, or the choice
 *     /identity/authorize                   GET   I-08, begin the app passthrough sign-in
 *     /identity/token                       POST  I-08, redeem the code (form body)
 *     /identity/nonce                       POST  I-13.2, the native exchange's nonce (keys in the body)
 *     /identity/link                        GET   I-43.2, the link offer (device bearer)
 *                                           POST  I-43.2, add a Google or Apple identity (device bearer)
 *     /identity/nearby/start                POST  I-40.4, a signed-out device asks a nearby one to approve
 *     /identity/nearby/approve              POST  I-40.5, the signed-in device decides (device bearer)
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
  handleAuthDeviceApprove,
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
import { handleExchangeNonce } from "./passthrough/nonce.js";
import { handleNearbyStart } from "./passthrough/nearbyStart.js";
import { handleNearbyApprove } from "./passthrough/nearbyApprove.js";
import { handleLink } from "./passthrough/link.js";
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
  cors: true as const,
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
    cors: true,
    methods: ["POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now, settings }) =>
      handleToken({
        req,
        env,
        db,
        product,
        now,
        ...(settings ? { settings } : {}),
      }),
  },
  // I-13.2 (§12.11.2): the native exchange's nonce; the keys in the body are bound, not trusted.
  {
    path: "nonce",
    cors: true,
    methods: ["POST"],
    auth: { kind: "none" },
    handler: ({ req, env, db, product, now }) =>
      handleExchangeNonce(req, env, db, product, now),
  },
  // I-43.2 (§12.11.4): the link offer. The handler answers 404 with `launch.identityExchange` off.
  {
    path: "link",
    cors: true,
    methods: ["GET", "POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleLink(req, env, db, product, now),
  },
  // I-40.4 (§12.11.5): a signed-out device asks a nearby signed-in one to approve its sign-in.
  // The handler answers 404 with Identity, `identity.nearby` or `launch.identityNearby` off.
  {
    path: "nearby/start",
    cors: true,
    methods: ["POST"],
    auth: { kind: "none" },
    handler: ({ req, env, db, product, now }) =>
      handleNearbyStart(req, env, db, product, now),
  },
  // I-40.5 (§12.11.5): the signed-in device approves or denies. Same gates as `start`.
  {
    path: "nearby/approve",
    cors: true,
    methods: ["POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleNearbyApprove(req, env, db, product, now),
  },
  // I-08b (§12.5.1): the pending sign-in grant's routes.
  choiceRow("licenses"),
  choiceRow("devices"),
  choiceRow("complete"),
  choiceRow("cancel"),
  // I-09 (WIRE-CONTRACT-V4 §12.3): the account on the device wire.
  {
    path: "attach",
    cors: true,
    methods: ["POST"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleIdentityAttach(req, env, db, product, now),
  },
  {
    path: "subject",
    cors: true,
    methods: ["GET"],
    auth: { kind: "device" },
    handler: ({ req, env, db, product, now }) =>
      handleIdentitySubject(req, env, db, product, now),
  },
  {
    path: "signout",
    cors: true,
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
    handler: ({ req, env, db, product, hooks }) =>
      handleAuthDeviceEntry(req, env, product, { db, hooks }),
  },
  {
    path: "auth/choose",
    methods: ["GET", "POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now, hooks }) =>
      handleAuthChoose(req, env, db, product, now, hooks),
  },
  {
    path: "auth/device/approve",
    methods: ["GET", "POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now, hooks }) =>
      handleAuthDeviceApprove(req, env, db, product, now, hooks),
  },
  {
    path: "auth/device/start",
    cors: true,
    methods: ["POST"],
    auth: { kind: "none" },
    handler: ({ req, env, db, product }) =>
      handleAuthDeviceStart(req, env, db, product),
  },
  {
    path: "auth/device/verify",
    methods: ["GET", "POST"],
    auth: { kind: "code" },
    handler: ({ req }) => handleAuthDeviceVerify(req),
  },
  {
    path: "auth/device/poll",
    cors: true,
    methods: ["POST"],
    auth: { kind: "code" },
    handler: ({ req, env, db, product, now }) =>
      handleAuthDevicePoll(req, env, db, product, now),
  },
]);
