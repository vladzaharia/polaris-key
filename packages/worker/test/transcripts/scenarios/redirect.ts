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
//   redirect-web-key-return  LK-SKIP (WIRE-CONTRACT-V5 §12.4.2): authorize with `key_return=allow`,
//                            the card's key route, and the SDK redeeming the key code at token:
//                            an activation, never a sign-in; the same code again is invalid_grant.
//   redirect-web-key-return-limit  the same on a full licence: `device_limit` at token spends the
//                            code, a fresh card press gets a fresh code, and once a seat is free
//                            that code activates.
//   redirect-web-key-return-refusals  the two refusals the card's own route also makes, answered at
//                            token because the licence changed between the press and the redeem:
//                            `license_owned` (the licence joined an account) and `key_entry_limit`
//                            (another device took the last entry). Each spends its code.
//
// `browser` steps are the requests the SDK never makes; they are recorded so a replayer's fake
// server can serve the whole conversation (format.ts). The SDK's own request is the `token` form.
// The verifier, state and redirect URI are pinned in `args` so the replayed request is the one
// recorded.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  TranscriptRecorder,
  type ExchangeSpec,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import type { JsonValue } from "../format.js";
import {
  enforced,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  servicesOn,
  setup,
  type Scenario,
} from "../world.js";
import { seedLicenseWithKey } from "../../seed.js";
import { holdLicense, seedAccount } from "./account.js";
import { otherDeviceEnters, refusalsOn, setLimit } from "./keyEntry.js";
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
  extra: Pick<ExchangeSpec, "bearer" | "capture"> = {},
): Promise<Response> {
  const form = {
    grant_type: "authorization_code",
    client_id: PRODUCT,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
  };
  return s.send({
    ...extra,
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

// ── LK-SKIP: "Continue without an account" ──────────────────────────────────────────────────

const KEY_RETURN_FEATURES = ["identity.keyreturn"];
const KEY_RETURN_REQUIRES = ["identity.redirect.web"];

/** The launch gate is a platform setting; the transcript Worker runs with it on. */
function keyReturnOn(w: World): void {
  (w.env as unknown as Record<string, string>)["LAUNCH_IDENTITY_RETURNKEY"] =
    "on";
}

/** The browser's `authorize` with the opt-in, then the request view the card reads. */
async function startKeyReturn(
  r: TranscriptRecorder,
  note: string,
): Promise<{ binder: string; handle: string }> {
  const out = { binder: "", handle: "" };
  await r.step(
    {
      action: "browser",
      note,
      args: {
        state: STATE,
        redirectUri: CALLBACK,
        codeVerifier: VERIFIER,
        keyReturn: true,
      },
    },
    async (s) => {
      const res = await navigate(s, authorizePath({ key_return: "allow" }));
      expect(res.status).toBe(303);
      out.binder = binderOf(res);
      out.handle = handleOf(res);
    },
    { navigated: "card" },
  );
  return out;
}

/** The card's view of the request, the key preview, and the key route: the redirect it answers. */
async function pressKey(
  r: TranscriptRecorder,
  card: { binder: string; handle: string },
  key: string,
  note: string,
): Promise<string> {
  let redirect = "";
  await r.step(
    { action: "browser", note },
    async (s) => {
      const view = await s.send({
        method: "GET",
        path: `/api/signin/requests/${card.handle}`,
        metadata: false,
        headers: { cookie: card.binder },
      });
      expect(view.status).toBe(200);
      expect(((await view.json()) as { keyReturn?: boolean }).keyReturn).toBe(
        true,
      );
      const body = { key };
      const preview = await s.send({
        method: "POST",
        path: "/api/key/preview",
        metadata: false,
        body,
        expectBody: { json: body, match: "exact" as const },
      });
      expect(preview.status).toBe(200);
      const done = await s.send({
        method: "POST",
        path: `/api/signin/requests/${card.handle}/key`,
        metadata: false,
        headers: { cookie: card.binder },
        body,
        expectBody: { json: body, match: "exact" as const },
      });
      expect(done.status).toBe(200);
      redirect = ((await done.json()) as { redirect: string }).redirect;
      expect(redirect.startsWith(`${CALLBACK}?code=`)).toBe(true);
      expect(redirect).not.toContain(key);
    },
    { navigated: "app" },
  );
  return redirect;
}

/** The SDK redeems `code` and is refused with `invalid_grant`. */
async function refusedGrant(s: StepRecorder, code: string): Promise<void> {
  const res = await token(s, code, VERIFIER);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_grant" });
}

/** What the SDK reports for a key activation. */
const activated = (licenseId: string, used: number) => ({
  result: "activated",
  scope: "",
  licenseId,
  subject: null,
  keyEntries: { used, limit: 10 },
  tokenHeld: true,
});

const keyReturnArgs = (callbackUrl: string) => ({
  callbackUrl,
  codeVerifier: VERIFIER,
  state: STATE,
  keyReturn: true,
});

export const redirectWebKeyReturn: Scenario = {
  id: "redirect-web-key-return",
  record: () =>
    pinned("redirect-web-key-return", async (pin) => {
      const { w } = await world();
      keyReturnOn(w);
      const { key, licenseId } = await seedLicense(w);
      const r = new TranscriptRecorder({
        id: "redirect-web-key-return",
        description:
          "Continue without an account (LK-SKIP, WIRE-CONTRACT-V5 §12.4.2). A web app opts in with key_return=allow on authorize. The card reads the request (keyReturn true), previews the key and posts it to the card's key route, which answers the redirect with a code, state and the issuer: the key travels in that body only. The SDK checks state and iss and redeems the code at token with a form body and its PKCE verifier. The answer is a key activation, never a sign-in: via key, an empty scope, the licence, the key-entry count and a null subject. The device holds the licence by key, with no account. The same code again is invalid_grant.",
        features: KEY_RETURN_FEATURES,
        requires: KEY_RETURN_REQUIRES,
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      const card = await startKeyReturn(
        r,
        "The app sends the person's browser to authorize with key_return=allow; the Worker answers with a 303 to the card and the request's binder cookie.",
      );
      const redirect = await pressKey(
        r,
        card,
        key,
        "Continue without an account: the card reads the request, previews the key and posts it; the answer carries the code and no key.",
      );
      const code = codeOfRedirect(redirect);
      await r.step(
        {
          action: "redirectComplete",
          note: "The SDK redeems the code. State and iss are checked by the SDK before this request.",
          args: keyReturnArgs(redirect),
        },
        async (s) => {
          const res = await token(s, code, VERIFIER);
          const body = (await res.json()) as Record<string, unknown>;
          expect(res.status).toBe(200);
          // The ordinary answer's seven members, plus `via` and `keyEntries`.
          expect(Object.keys(body)).toHaveLength(9);
          expect(body).toMatchObject({
            via: "key",
            scope: "",
            subject: null,
            license: { id: licenseId },
            keyEntries: { used: 1, limit: 10 },
          });
          expect(JSON.stringify(body)).not.toContain(key);
        },
        activated(licenseId, 1),
      );
      expect(new URL(redirect).searchParams.get("iss")).toBe(ISSUER);
      await r.step(
        {
          action: "redirectComplete",
          note: "A replayed code is refused: it was single use.",
          args: keyReturnArgs(redirect),
        },
        (s) => refusedGrant(s, code),
        { result: "invalid-grant", code: "invalid_grant" },
      );
      return r.transcript();
    }),
};

/** The device that holds the licence's only seat in `redirect-web-key-return-limit`. */
const OCCUPANT = "TRANSCRIPTOCCUPANT00000000000001";

export const redirectWebKeyReturnLimit: Scenario = {
  id: "redirect-web-key-return-limit",
  record: () =>
    pinned("redirect-web-key-return-limit", async (pin) => {
      const { w } = await world();
      keyReturnOn(w);
      const { key, licenseId } = await seedLicenseWithKey(w.db, PRODUCT, {
        entitlements: { deviceLimit: enforced(1) },
      });
      // Another device takes the only seat, outside the recording.
      const seat = await setup(w, "POST", `/${PRODUCT}/license/activate`, {
        authorization: `Bearer ${key}`,
        "x-pkey-device": OCCUPANT,
      });
      expect(seat.status).toBe(200);
      const occupant = ((await seat.json()) as { token: string }).token;

      const r = new TranscriptRecorder({
        id: "redirect-web-key-return-limit",
        description:
          "Continue without an account on a full licence (LK-SKIP, WIRE-CONTRACT-V5 §12.4.2 item 5). The card's key route issues a code without checking seats, because the device is unknown until token. Redeeming it answers 403 device_limit with the limit, the count and the manage link, and takes no seat. The code is consumed before the bind, so redeeming it again is invalid_grant and the person presses Continue without an account again for a fresh code. Once the other device has left, that code activates the device with keyEntries.",
        features: KEY_RETURN_FEATURES,
        requires: KEY_RETURN_REQUIRES,
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      const first = await startKeyReturn(
        r,
        "The app sends the person's browser to authorize with key_return=allow.",
      );
      const redirect = await pressKey(
        r,
        first,
        key,
        "Continue without an account: the route does not check seats, so it answers a code.",
      );
      const code = codeOfRedirect(redirect);
      await r.step(
        {
          action: "redirectComplete",
          note: "token binds the device and meets the licence's only seat: device_limit, flat, with the limit, the count and the manage link.",
          args: keyReturnArgs(redirect),
        },
        async (s) => {
          const res = await token(s, code, VERIFIER);
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({
            error: "device_limit",
            limit: 1,
            deviceCount: 1,
          });
        },
        {
          result: "device-limit",
          limit: 1,
          deviceCount: 1,
          manageUrl: `https://key.plrs.im/activate?product=${PRODUCT}&next=free-device&for=Linux%20x86_64`,
          tokenHeld: false,
        },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The refusal spent the code: it cannot be redeemed again.",
          args: keyReturnArgs(redirect),
        },
        (s) => refusedGrant(s, code),
        { result: "invalid-grant", code: "invalid_grant" },
      );

      // The other device leaves, outside the recording.
      const freed = await setup(w, "POST", `/${PRODUCT}/license/deauthorize`, {
        authorization: `Bearer ${occupant}`,
        "x-pkey-device": OCCUPANT,
      });
      expect(freed.status).toBe(200);

      const retry = await startKeyReturn(
        r,
        "The retry starts from a fresh card press: a new authorize.",
      );
      const again = await pressKey(
        r,
        retry,
        key,
        "Continue without an account again: a fresh code.",
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "With a seat free the fresh code activates the device.",
          args: keyReturnArgs(again),
        },
        async (s) => {
          const res = await token(s, codeOfRedirect(again), VERIFIER);
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({
            via: "key",
            keyEntries: { used: 2, limit: 10 },
          });
        },
        activated(licenseId, 2),
      );
      return r.transcript();
    }),
};

export const redirectWebKeyReturnRefusals: Scenario = {
  id: "redirect-web-key-return-refusals",
  record: () =>
    pinned("redirect-web-key-return-refusals", async (pin) => {
      const { w } = await world();
      keyReturnOn(w);
      await refusalsOn(w);
      await setLimit(w, 1);
      const owned = await seedLicense(w);
      const full = await seedLicenseWithKey(w.db, PRODUCT, {
        id: `lic_${PRODUCT}_2`,
      });

      const r = new TranscriptRecorder({
        id: "redirect-web-key-return-refusals",
        description:
          "Continue without an account when the licence changes after the card's press (LK-SKIP, WIRE-CONTRACT-V5 §12.4.2 items 3.6, 3.7 and 5), with key-entry refusals on and a limit of 1. The card issues a code, then the licence joins an account: token repeats the ownership check and answers a flat 403 license_owned with signInUrl, takes no seat and counts nothing. For a second licence another device enters the key after the press, so the limit is reached: token answers 403 key_entry_limit with keyEntries and manageUrl. Each refusal spends its code, so the person presses the card again for a fresh one. Neither is an auth failure: the client keeps its state.",
        features: KEY_RETURN_FEATURES,
        requires: KEY_RETURN_REQUIRES,
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });

      const first = await startKeyReturn(
        r,
        "The app sends the person's browser to authorize with key_return=allow.",
      );
      const ownedRedirect = await pressKey(
        r,
        first,
        owned.key,
        "Continue without an account: the licence is not in an account yet, so the card answers a code.",
      );
      // The licence joins an account after the press, outside the recording.
      const holder = await seedAccount(w, "holder@example.com");
      await holdLicense(w, owned.licenseId, holder.id);
      await r.step(
        {
          action: "redirectComplete",
          note: "token repeats the ownership check: a licence in an account is license_owned, flat, with the sign-in link. Nothing is counted.",
          args: keyReturnArgs(ownedRedirect),
        },
        async (s) => {
          const res = await token(s, codeOfRedirect(ownedRedirect), VERIFIER);
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: "license_owned" });
        },
        {
          result: "license-owned",
          code: "license_owned",
          signInUrl: `https://key.plrs.im/signin?product=${PRODUCT}`,
          tokenHeld: false,
        },
      );

      const second = await startKeyReturn(
        r,
        "A second press on another licence: a new authorize.",
      );
      const limitRedirect = await pressKey(
        r,
        second,
        full.key,
        "Continue without an account: no entry is counted yet, so the card answers a code.",
      );
      // Another device enters the key after the press, outside the recording.
      await otherDeviceEnters(w, full.key);
      await r.step(
        {
          action: "redirectComplete",
          note: "token meets the limit another device just reached: key_entry_limit, flat, with the count and the manage link. No seat is taken.",
          args: keyReturnArgs(limitRedirect),
        },
        async (s) => {
          const res = await token(s, codeOfRedirect(limitRedirect), VERIFIER);
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({
            error: "key_entry_limit",
            keyEntries: { used: 1, limit: 1 },
          });
        },
        {
          result: "key-entry-limit",
          code: "key_entry_limit",
          keyEntries: { used: 1, limit: 1 },
          manageUrl: `https://key.plrs.im/activate?product=${PRODUCT}`,
          tokenHeld: false,
        },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The refusal spent the code: it cannot be redeemed again.",
          args: keyReturnArgs(limitRedirect),
        },
        (s) => refusedGrant(s, codeOfRedirect(limitRedirect)),
        { result: "invalid-grant", code: "invalid_grant" },
      );
      return r.transcript();
    }),
};
