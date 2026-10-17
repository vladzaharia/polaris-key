/// <reference types="@cloudflare/workers-types" />
// The app passthrough on an OAuth-shaped authorize and token (I-08; WIRE-CONTRACT-V4 §12.4, §12.5,
// plans/I-08.md §4): what a web app's SDK and the person's browser exchange with the Worker.
//
//   redirect-web-happy       authorize (the browser) -> the card's Continue (the browser) -> the
//                            SDK redeems the code at token (a form body) and gets the browser
//                            device token; the same code again is invalid_grant.
//   redirect-web-errors      every authorize refusal (a card page for client_id and redirect_uri,
//                            a redirect for the rest), then token's refusals.
//   identity-request-hints   login_hint, name_hint and purpose carried to the card (PX-W18).
//
// `browser` steps are the requests the SDK never makes; they are recorded so a replayer's fake
// server can serve the whole conversation (format.ts). The SDK's own request is the `token` form.
// The verifier, state and redirect URI are pinned in `args` so the replayed request is the one
// recorded.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import type { JsonValue } from "../format.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  servicesOn,
  type Scenario,
} from "../world.js";
import { seedAccount } from "./account.js";
import { PORTAL_CSRF_HEADER } from "../../../src/services/identity/portal/session.js";
import { portalSession, registerWebApp, WEB_CALLBACK } from "./webSignIn.js";

const FEATURES = ["identity.redirect.web"];
const CALLBACK = WEB_CALLBACK;
const STATE = "tidewater-state-0123456789";
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const ISSUER = `https://key.plrs.im/${PRODUCT}/identity`;

const IDENTITY_ON = servicesOn("license", "config", "identity");

/** The product registers its web origin and callback path; an account signs in. */
export async function world(): Promise<{
  w: World;
  cookie: string;
  csrf: string;
  accountId: string;
  subject: string;
}> {
  const w = await productWorld(IDENTITY_ON);
  await registerWebApp(w);
  const ada = await seedAccount(w, "ada@example.com");
  const session = await portalSession(w, {
    id: ada.id,
    email: "ada@example.com",
  });
  return {
    w,
    cookie: session.cookie,
    csrf: session.csrf,
    accountId: ada.id,
    subject: ada.subject,
  };
}

export function authorizePath(
  over: Record<string, string | null> = {},
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: PRODUCT,
    redirect_uri: CALLBACK,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "profile email",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  return `/${PRODUCT}/identity/authorize?${q}`;
}

/** The browser navigates to authorize. */
export function navigate(s: StepRecorder, path: string): Promise<Response> {
  return s.send({ method: "GET", path, metadata: false });
}

/** The binder cookie a 303 from authorize set. */
export function binderOf(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

export function handleOf(res: Response): string {
  return new URL(res.headers.get("location")!).searchParams.get("request")!;
}

/** The card's Continue or Cancel: the portal session, its CSRF header and the binder. */
export function press(
  s: StepRecorder,
  who: { cookie: string; csrf: string },
  binder: string,
  handle: string,
  verb: "continue" | "cancel",
  body?: Record<string, JsonValue>,
): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/api/signin/requests/${handle}/${verb}`,
    metadata: false,
    headers: {
      cookie: `${who.cookie}; ${binder}`,
      [PORTAL_CSRF_HEADER]: who.csrf,
    },
    ...(body
      ? { body, expectBody: { json: body, match: "exact" as const } }
      : {}),
  });
}

/** `POST /<p>/identity/token` as the SDK sends it: a form, the device id and the metadata. */
export function token(
  s: StepRecorder,
  code: string,
  verifier: string,
): Promise<Response> {
  const form = {
    grant_type: "authorization_code",
    client_id: PRODUCT,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
  };
  return s.send({
    method: "POST",
    path: `/${PRODUCT}/identity/token`,
    form,
    expectBody: {
      json: form,
      match: "exact",
      allowedKeys: [...Object.keys(form), "device_name"],
    },
  });
}

export const codeOfRedirect = (redirect: string): string =>
  new URL(redirect).searchParams.get("code")!;

export const redirectWebHappy: Scenario = {
  id: "redirect-web-happy",
  record: () =>
    pinned("redirect-web-happy", async (pin) => {
      const { w, cookie, csrf, subject: adaSubject } = await world();
      const r = new TranscriptRecorder({
        id: "redirect-web-happy",
        description:
          "A web app signs a person in through authorize and token (I-08, WIRE-CONTRACT-V4 §12.4, §12.5). The browser navigates to authorize (response_type, client_id, redirect_uri, state, an S256 challenge, scope) and is sent to the card; the person presses Continue, which answers the redirect carrying code, state and the issuer (RFC 9207); the SDK checks state and iss and redeems the code at token with a form body and its PKCE verifier. The answer is the browser device token (access_token), the granted scope, the device, a null licence on a licence-less device and the pairwise subject: never a token in a URL. The same code again is invalid_grant.",
        features: FEATURES,
        requires: [],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      let binder = "";
      let handle = "";
      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "The app sends the person's browser to authorize; the Worker answers with a 303 to the card and the request's binder cookie.",
          args: { state: STATE, redirectUri: CALLBACK, codeVerifier: VERIFIER },
        },
        async (s) => {
          const res = await navigate(s, authorizePath());
          expect(res.status).toBe(303);
          binder = binderOf(res);
          handle = handleOf(res);
        },
        { navigated: "card" },
      );
      await r.step(
        {
          action: "browser",
          note: "Continue to the app: the session, the CSRF header and the binder; the answer carries the code.",
        },
        async (s) => {
          const res = await press(
            s,
            { cookie, csrf },
            binder,
            handle,
            "continue",
          );
          expect(res.status).toBe(200);
          redirect = ((await res.json()) as { redirect: string }).redirect;
          expect(redirect.startsWith(`${CALLBACK}?code=`)).toBe(true);
        },
        { navigated: "app" },
      );
      const code = codeOfRedirect(redirect);
      let subject = "";
      await r.step(
        {
          action: "redirectComplete",
          note: "The SDK redeems the code. State and iss are checked by the SDK before this request.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await token(s, code, VERIFIER);
          expect(res.status).toBe(200);
          const body = (await res.json()) as Record<string, unknown>;
          expect(Object.keys(body).sort()).toEqual(
            [
              "access_token",
              "device",
              "license",
              "schemaVersion",
              "scope",
              "subject",
              "token_type",
            ].sort(),
          );
          subject = body.subject as string;
        },
        {
          result: "ok",
          scope: "profile email",
          licenseId: null,
          subject: adaSubject,
          tokenHeld: true,
        },
      );
      expect(subject).toMatch(/^ps_/);
      expect(new URL(redirect).searchParams.get("iss")).toBe(ISSUER);
      await r.step(
        {
          action: "redirectComplete",
          note: "A replayed code is refused: it was single use.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await token(s, code, VERIFIER);
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "invalid_grant" });
        },
        { result: "invalid-grant", code: "invalid_grant" },
      );
      return r.transcript();
    }),
};

export const redirectWebErrors: Scenario = {
  id: "redirect-web-errors",
  record: () =>
    pinned("redirect-web-errors", async (pin) => {
      const { w, cookie, csrf } = await world();
      const r = new TranscriptRecorder({
        id: "redirect-web-errors",
        description:
          "Every refusal of authorize and token (I-08, WIRE-CONTRACT-V4 §12.4, §12.5). A wrong client_id or an unlisted redirect URI renders a card page and never a redirect. Plain PKCE, an openid scope and a missing state redirect to the registered URI with error, state (when sent) and the issuer. At token a verifier that is not the code's ends the code: invalid_grant, and the right verifier no longer works. Cancel on the card redirects with access_denied. The Worker refuses a JSON body, a repeated parameter and other grants as well (worker tests); an SDK cannot be made to send them.",
        features: FEATURES,
        requires: [],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      const refused = (
        note: string,
        path: string,
        status: number,
        expectNav: Record<string, string>,
        check?: (res: Response) => void,
      ) =>
        r.step(
          { action: "browser", note, args: { redirectUri: CALLBACK } },
          async (s) => {
            const res = await navigate(s, path);
            expect(res.status).toBe(status);
            if (status !== 302 && status !== 303)
              expect(res.headers.get("location")).toBeNull();
            check?.(res);
          },
          expectNav,
        );
      await refused(
        "A client_id that is not the product: the card renders invalid_client and nothing redirects.",
        authorizePath({ client_id: "other" }),
        401,
        { navigated: "page", error: "invalid_client" },
      );
      await refused(
        "A redirect URI the product did not register: the card renders redirect_uri_mismatch and nothing redirects.",
        authorizePath({ redirect_uri: "https://evil.example/auth/callback" }),
        400,
        { navigated: "page", error: "redirect_uri_mismatch" },
      );
      await refused(
        "Plain PKCE is refused: a redirect to the registered URI with invalid_request, the state and the issuer.",
        authorizePath({ code_challenge_method: "plain" }),
        302,
        { navigated: "app", error: "invalid_request" },
        (res) => {
          const to = new URL(res.headers.get("location")!);
          expect(to.searchParams.get("iss")).toBe(ISSUER);
          expect(to.searchParams.get("state")).toBe(STATE);
        },
      );
      await refused(
        "openid is invalid_scope until the product speaks OIDC (I-21).",
        authorizePath({ scope: "openid profile" }),
        302,
        { navigated: "app", error: "invalid_scope" },
      );

      // A real request, for Cancel and the token refusals.
      let binder = "";
      let handle = "";
      await r.step(
        { action: "browser", note: "A valid authorize, to cancel.", args: {} },
        async (s) => {
          const res = await navigate(s, authorizePath());
          binder = binderOf(res);
          handle = handleOf(res);
        },
        { navigated: "card" },
      );
      await r.step(
        {
          action: "browser",
          note: "Cancel: the redirect carries access_denied, the state and the issuer, and no code.",
        },
        async (s) => {
          const res = await press(
            s,
            { cookie, csrf },
            binder,
            handle,
            "cancel",
          );
          expect(res.status).toBe(200);
          const to = new URL(
            ((await res.json()) as { redirect: string }).redirect,
          );
          expect(to.searchParams.get("error")).toBe("access_denied");
          expect(to.searchParams.has("code")).toBe(false);
        },
        { navigated: "app", error: "access_denied" },
      );
      let redirect = "";
      await r.step(
        { action: "browser", note: "A second request, continued.", args: {} },
        async (s) => {
          const res = await navigate(s, authorizePath());
          binder = binderOf(res);
          handle = handleOf(res);
          const done = await press(
            s,
            { cookie, csrf },
            binder,
            handle,
            "continue",
          );
          redirect = ((await done.json()) as { redirect: string }).redirect;
        },
        { navigated: "app" },
      );
      const code = codeOfRedirect(redirect);
      const WRONG = "a-different-verifier-0123456789-abcdefghijklmnopqrstuv";
      await r.step(
        {
          action: "redirectComplete",
          note: "A verifier that is not the one the challenge came from: invalid_grant, and the code is gone.",
          args: { callbackUrl: redirect, codeVerifier: WRONG, state: STATE },
        },
        async (s) => {
          const res = await token(s, code, WRONG);
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "invalid_grant" });
        },
        { result: "invalid-grant", code: "invalid_grant" },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The right verifier no longer works: a mismatch ended the code.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await token(s, code, VERIFIER);
          expect(res.status).toBe(400);
        },
        { result: "invalid-grant", code: "invalid_grant" },
      );
      return r.transcript();
    }),
};

export const identityRequestHints: Scenario = {
  id: "identity-request-hints",
  record: () =>
    pinned("identity-request-hints", async (pin) => {
      const { w } = await world();
      const r = new TranscriptRecorder({
        id: "identity-request-hints",
        description:
          "Hints on authorize (I-08, WIRE-CONTRACT-V4 §12.4; absorbs PX-W18). login_hint, name_hint and purpose ride on the authorize request and reach the card through the request view, which carries them beside the scope and the licence-choice mode. A hint prefills the card and verifies nothing; a login_hint that is not an email is dropped.",
        features: ["identity.signin.hints"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      let binder = "";
      let handle = "";
      await r.step(
        {
          action: "browser",
          note: "authorize with the hints.",
          args: {
            loginHint: "Ada@Example.com",
            nameHint: "Ada",
            purpose: "attach",
          },
        },
        async (s) => {
          const res = await navigate(
            s,
            authorizePath({
              login_hint: "Ada@Example.com",
              name_hint: "Ada",
              purpose: "attach",
            }),
          );
          expect(res.status).toBe(303);
          binder = binderOf(res);
          handle = handleOf(res);
        },
        { navigated: "card" },
      );
      await r.step(
        {
          action: "browser",
          note: "The card reads the request: the hints, normalised, and nothing verified.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: `/api/signin/requests/${handle}`,
            metadata: false,
            headers: { cookie: binder },
          });
          expect(res.status).toBe(200);
          const view = (await res.json()) as Record<string, unknown>;
          expect(view).toMatchObject({
            purpose: "attach",
            loginHint: "ada@example.com",
            nameHint: "Ada",
          });
        },
        { navigated: "card", loginHint: "ada@example.com", purpose: "attach" },
      );
      await r.step(
        {
          action: "browser",
          note: "A login_hint that is not an email is dropped, never an error.",
          args: { loginHint: "not an email" },
        },
        async (s) => {
          const res = await navigate(
            s,
            authorizePath({ login_hint: "not an email" }),
          );
          expect(res.status).toBe(303);
          const view = await s.send({
            method: "GET",
            path: `/api/signin/requests/${handleOf(res)}`,
            metadata: false,
            headers: { cookie: binderOf(res) },
          });
          expect(
            ((await view.json()) as { loginHint: unknown }).loginHint,
          ).toBeNull();
        },
        { navigated: "card", loginHint: null },
      );
      return r.transcript();
    }),
};
