/// <reference types="@cloudflare/workers-types" />
// The native redirect sign-in (I-15; WIRE-CONTRACT-V5 §12.4, §12.12; plans/I-15.md §2, §6): what a
// native app's SDK and the person's browser exchange with the Worker. The app pushes its request
// at `request`, opens `authorize?request_uri=` in the system browser, the person presses Continue
// on the card, and the app redeems the code at `token` from the device that pushed it.
//
//   redirect-native-loopback     a loopback redirect: the code returns with the handle (`request=`)
//   redirect-native-scheme       a registered scheme with a return URI: the card names the class
//   redirect-native-choose-app   license_choice=app on a pushed request: token answers `choose`
//   redirect-native-errors       every refusal: an unregistered scheme, `localhost`, a native
//                                authorize with no pushed request, a used `request_uri`, a code
//                                redeemed from another device, an expired `request_uri`
//   locker-redirect-native       the loopback flow with the customer host on: the bind hop, the
//                                card and the return page are on `polaris.locker`
//
// `browser` steps are the requests the SDK never makes (the push is the SDK's own and is recorded
// in the same step as the browser's, since no native SDK replays it yet); the SDK's redemption is
// `redirectComplete`. The handle, request URI and code are pinned by the seeded random stream, so
// the recorded value is the replayed one. The native rows stay `planned` (identity.redirect.native)
// until I-15b, so no SDK replays these.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import type { JsonValue } from "../format.js";
import { pinned, PRODUCT, type Scenario } from "../world.js";
import { PORTAL_CSRF_HEADER } from "../../../src/services/identity/portal/session.js";
import { ownedLicense } from "./choice.js";
import { CUSTOMER, lockerSwitch } from "./locker.js";
import { binderOf, handleOf, press, world } from "./redirect.js";

const FEATURES = ["identity.redirect.native"];
const STATE = "tidewater-state-0123456789";
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const LOOP = "http://127.0.0.1:49152/pkey/callback";
const SCHEME = "com.tidewater.studio:/pkey/callback";
const OTHER = "OTHER0DEVICE00000000000000000001";
const REQUEST = `/${PRODUCT}/identity/request`;
const TOKEN = `/${PRODUCT}/identity/token`;

type Who = Awaited<ReturnType<typeof world>>;
type Json = Record<string, JsonValue>;

/** The product registers a scheme and a claimed path, beside the web origin `world()` set. */
async function nativeWorld(): Promise<Who> {
  const who = await world();
  for (const [key, value] of [
    ["identity.nativeRedirect.schemes", ["com.tidewater.studio"]],
    ["identity.nativeRedirect.claimedPaths", ["/open"]],
  ] as const)
    await who.w.db.run(
      `INSERT OR REPLACE INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, ?, ?, 'manifest', ?, 'resync')`,
      PRODUCT,
      key,
      JSON.stringify(value),
      T0,
    );
  return who;
}

function recorder(
  w: World,
  pin: Parameters<Parameters<typeof pinned>[1]>[0],
  id: string,
  description: string,
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features: FEATURES,
    requires: [],
    product: PRODUCT,
    now: T0,
    world: w,
    pinned: pin,
    initial: { deviceId: DEVICE, version: VERSION },
  });
}

/** The fields `request` takes; `over` replaces or (null) drops one. */
function pushForm(
  over: Record<string, string | null> = {},
): Record<string, string> {
  const form: Record<string, string> = {
    response_type: "code",
    client_id: PRODUCT,
    redirect_uri: LOOP,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    device_name: "Ada's Mac",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete form[k];
    else form[k] = v;
  }
  return form;
}

/** `POST /<p>/identity/request` as the SDK sends it: a form, the device id and the metadata. */
function push(
  s: StepRecorder,
  form: Record<string, string>,
  extra: { origin?: string } = {},
): Promise<Response> {
  return s.send({
    ...extra,
    method: "POST",
    path: REQUEST,
    form,
    expectBody: { json: form, match: "exact" },
  });
}

/** Push a request and read its `request_uri`. */
async function pushed(
  s: StepRecorder,
  over: Record<string, string | null> = {},
): Promise<string> {
  const res = await push(s, pushForm(over));
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    request_uri: string;
    expires_in: number;
  };
  expect(body.expires_in).toBe(600);
  return body.request_uri;
}

const authorizeUri = (uri: string): string =>
  `/${PRODUCT}/identity/authorize?${new URLSearchParams({
    client_id: PRODUCT,
    request_uri: uri,
  })}`;

/** `POST /<p>/identity/token` as the native SDK sends it: the form, the pushing device's headers. */
function redeem(
  s: StepRecorder,
  code: string,
  redirectUri: string,
  extra: { assertDevice?: string } = {},
): Promise<Response> {
  const form = {
    grant_type: "authorization_code",
    client_id: PRODUCT,
    code,
    code_verifier: VERIFIER,
    redirect_uri: redirectUri,
  };
  return s.send({
    method: "POST",
    path: TOKEN,
    form,
    ...(extra.assertDevice
      ? {
          metadata: false,
          assertHeaders: { "x-pkey-device": extra.assertDevice },
        }
      : {}),
    expectBody: {
      json: form,
      match: "exact",
      allowedKeys: [...Object.keys(form), "device_name"],
    },
  });
}

const codeOf = (redirect: string): string =>
  new URL(redirect).searchParams.get("code")!;

/** Push, open `authorize`, press Continue: the redirect the card answers. */
async function signInTo(
  r: TranscriptRecorder,
  who: Who,
  over: Record<string, string | null>,
  note: string,
  body?: Json,
): Promise<{ redirect: string; handle: string }> {
  let binder = "";
  let handle = "";
  let redirect = "";
  await r.step(
    {
      action: "browser",
      note: `${note} The app pushes its request and opens authorize with the request_uri; the Worker answers a 303 to the card and the binder cookie.`,
      args: { state: STATE, redirectUri: over.redirect_uri ?? LOOP },
    },
    async (s) => {
      const uri = await pushed(s, over);
      const res = await s.send({
        method: "GET",
        path: authorizeUri(uri),
        metadata: false,
      });
      expect(res.status).toBe(303);
      binder = binderOf(res);
      handle = handleOf(res);
      expect(res.headers.get("location")).not.toContain(STATE);
    },
    { navigated: "card" },
  );
  await r.step(
    {
      action: "browser",
      note: "Continue to the app: the session, the CSRF header and the binder; the answer carries the code.",
    },
    async (s) => {
      const res = await press(s, who, binder, handle, "continue", body);
      expect(res.status).toBe(200);
      redirect = ((await res.json()) as { redirect: string }).redirect;
    },
    { navigated: "app" },
  );
  return { redirect, handle };
}

const OK = (who: Who, licenseId: string | null = null) => ({
  result: "ok",
  scope: "profile email",
  licenseId,
  subject: who.subject,
  tokenHeld: true,
});

export const redirectNativeLoopback: Scenario = {
  id: "redirect-native-loopback",
  record: () =>
    pinned("redirect-native-loopback", async (pin) => {
      const who = await nativeWorld();
      const r = recorder(
        who.w,
        pin,
        "redirect-native-loopback",
        "A desktop app signs a person in on a loopback redirect (I-15, WIRE-CONTRACT-V5 §12.12). The app pushes its request at request (a form: the authorize parameters, a loopback redirect_uri on an OS-assigned port, the device label) and gets a request_uri good for 600 s. The browser opens authorize with it and is sent to the card; the person presses Continue, which answers a redirect to the loopback carrying code, state and the card's handle (request=), so the app can open the return page. The app redeems the code at token, from the device that pushed it, with its PKCE verifier and the same redirect URI. The same code again is invalid_grant.",
      );
      const { redirect, handle } = await signInTo(
        r,
        who,
        {},
        "A loopback redirect.",
      );
      expect(redirect.startsWith(`${LOOP}?code=`)).toBe(true);
      const to = new URL(redirect);
      expect(to.searchParams.get("state")).toBe(STATE);
      expect(to.searchParams.get("request")).toBe(handle);
      await r.step(
        {
          action: "browser",
          note: "The loopback listener answers 303 to the return page on the Worker, which shows the person they can go back to the app.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: `/signin/return?request=${handle}`,
            metadata: false,
          });
          expect(res.status).toBe(200);
          expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        },
        { navigated: "page" },
      );
      const code = codeOf(redirect);
      await r.step(
        {
          action: "redirectComplete",
          note: "The app redeems the code. State is checked by the app before this request.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await redeem(s, code, LOOP);
          expect(res.status).toBe(200);
          const body = (await res.json()) as Record<string, unknown>;
          expect(body.token_type).toBe("Bearer");
        },
        OK(who),
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "A replayed code is refused: it was single use.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await redeem(s, code, LOOP);
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "invalid_grant" });
        },
        { result: "invalid-grant", code: "invalid_grant" },
      );
      return r.transcript();
    }),
};

export const redirectNativeScheme: Scenario = {
  id: "redirect-native-scheme",
  record: () =>
    pinned("redirect-native-scheme", async (pin) => {
      const who = await nativeWorld();
      const r = recorder(
        who.w,
        pin,
        "redirect-native-scheme",
        "A mobile or desktop app signs a person in on a registered custom scheme (I-15, WIRE-CONTRACT-V5 §12.12). The push names the scheme's redirect_uri and a return_uri (a registered scheme too). The card's request view names the class (redirect: scheme), the return URI, the device label and a native client; it carries neither state nor challenge. Continue answers a redirect to the scheme carrying code and state and no handle (the system browser session hands the callback straight to the app). The app redeems the code at token from the pushing device.",
      );
      let binder = "";
      let handle = "";
      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "The push and authorize; the card reads its request.",
          args: { state: STATE, redirectUri: SCHEME },
        },
        async (s) => {
          const uri = await pushed(s, {
            redirect_uri: SCHEME,
            return_uri: SCHEME,
          });
          const res = await s.send({
            method: "GET",
            path: authorizeUri(uri),
            metadata: false,
          });
          expect(res.status).toBe(303);
          binder = binderOf(res);
          handle = handleOf(res);
          const view = await s.send({
            method: "GET",
            path: `/api/signin/requests/${handle}`,
            metadata: false,
            headers: { cookie: binder },
          });
          expect(view.status).toBe(200);
          const body = (await view.json()) as Record<string, unknown>;
          expect(body.redirect).toBe("scheme");
          expect(body.returnUri).toBe(SCHEME);
          expect(body.deviceLabel).toBe("Ada's Mac");
          expect((body.client as { kind: string }).kind).toBe("native");
        },
        { navigated: "card" },
      );
      await r.step(
        { action: "browser", note: "Continue to the app." },
        async (s) => {
          const res = await press(s, who, binder, handle, "continue");
          expect(res.status).toBe(200);
          redirect = ((await res.json()) as { redirect: string }).redirect;
          expect(redirect.startsWith(`${SCHEME}?code=`)).toBe(true);
          expect(new URL(redirect).searchParams.has("request")).toBe(false);
        },
        { navigated: "app" },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The app redeems the code with the scheme as its redirect URI.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await redeem(s, codeOf(redirect), SCHEME);
          expect(res.status).toBe(200);
        },
        OK(who),
      );
      return r.transcript();
    }),
};

export const redirectNativeChooseApp: Scenario = {
  id: "redirect-native-choose-app",
  record: () =>
    pinned("redirect-native-choose-app", async (pin) => {
      const who = await nativeWorld();
      await ownedLicense(who.w, who, "lic_djdl_pro", 3);
      await ownedLicense(who.w, who, "lic_djdl_lite", 3);
      const r = recorder(
        who.w,
        pin,
        "redirect-native-choose-app",
        "The licence is chosen in the app on a native sign-in (I-15, I-04 §G). The push carries license_choice=app, so Continue needs no choice. The app redeems the code and, because a choice is due, token answers status choose with a pending grant (300 s) and the licence view instead of a device token. The grant is the same one the web flow hands out.",
      );
      const { redirect } = await signInTo(
        r,
        who,
        { license_choice: "app" },
        "App mode: the card has no licence step.",
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The exchange answers a grant, not a token: no device is bound yet.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await redeem(s, codeOf(redirect), LOOP);
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            status: string;
            grant: string;
            expiresIn: number;
          };
          expect(body.status).toBe("choose");
          expect(body.expiresIn).toBe(300);
          expect(body.grant).not.toBe("");
        },
        { result: "choose" },
      );
      return r.transcript();
    }),
};

export const redirectNativeErrors: Scenario = {
  id: "redirect-native-errors",
  record: () =>
    pinned("redirect-native-errors", async (pin) => {
      const who = await nativeWorld();
      const r = recorder(
        who.w,
        pin,
        "redirect-native-errors",
        "Every refusal of the native sign-in (I-15, WIRE-CONTRACT-V5 §12.4, §12.12). request refuses a scheme the product did not register and localhost with redirect_uri_mismatch (a flat error, never a redirect). authorize refuses a native redirect_uri sent directly, with no pushed request, on the card-less error page. A request_uri the card has taken (Continue) is the invalid_request_uri page. A code redeemed from another device than the one that pushed is invalid_grant and spends the code. A request_uri past its 600 s is the same page.",
      );
      const refused = (
        note: string,
        over: Record<string, string | null>,
        error: string,
      ) =>
        r.step(
          { action: "browser", note, args: { redirectUri: LOOP } },
          async (s) => {
            const res = await push(s, pushForm(over));
            expect(res.status).toBe(400);
            expect(res.headers.get("location")).toBeNull();
            expect(await res.json()).toMatchObject({ error });
          },
          { navigated: "page", error },
        );
      await refused(
        "An unregistered scheme.",
        { redirect_uri: "com.other.app:/pkey/callback" },
        "redirect_uri_mismatch",
      );
      await refused(
        "localhost is not a loopback literal.",
        { redirect_uri: "http://localhost:49152/pkey/callback" },
        "redirect_uri_mismatch",
      );
      await r.step(
        {
          action: "browser",
          note: "A native redirect_uri straight on authorize: a page, never a redirect.",
          args: { redirectUri: LOOP },
        },
        async (s) => {
          const q = new URLSearchParams({
            response_type: "code",
            client_id: PRODUCT,
            redirect_uri: LOOP,
            state: STATE,
            code_challenge: CHALLENGE,
            code_challenge_method: "S256",
          });
          const res = await s.send({
            method: "GET",
            path: `/${PRODUCT}/identity/authorize?${q}`,
            metadata: false,
          });
          expect(res.status).toBe(400);
          expect(res.headers.get("location")).toBeNull();
        },
        { navigated: "page", error: "redirect_uri_mismatch" },
      );

      // A request the card takes, then reuse and a code from another device.
      let usedUri = "";
      let binder = "";
      let handle = "";
      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "A valid push, authorize and Continue.",
          args: { redirectUri: LOOP },
        },
        async (s) => {
          usedUri = await pushed(s);
          const res = await s.send({
            method: "GET",
            path: authorizeUri(usedUri),
            metadata: false,
          });
          binder = binderOf(res);
          handle = handleOf(res);
          const done = await press(s, who, binder, handle, "continue");
          redirect = ((await done.json()) as { redirect: string }).redirect;
        },
        { navigated: "app" },
      );
      await r.step(
        {
          action: "browser",
          note: "The taken request_uri again: the invalid_request_uri page.",
          args: { redirectUri: LOOP },
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: authorizeUri(usedUri),
            metadata: false,
          });
          expect(res.status).toBe(400);
          expect(res.headers.get("location")).toBeNull();
          expect(await res.text()).toContain("sign-in link has expired");
        },
        { navigated: "page" },
      );
      await r.step(
        {
          action: "browser",
          note: "Another device presents the code: invalid_grant, and the code is spent.",
          args: { redirectUri: LOOP },
        },
        async (s) => {
          const res = await redeem(s, codeOf(redirect), LOOP, {
            assertDevice: OTHER,
          });
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "invalid_grant" });
        },
        { result: "invalid-grant", code: "invalid_grant" },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The pushing device cannot redeem it afterwards.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await redeem(s, codeOf(redirect), LOOP);
          expect(res.status).toBe(400);
        },
        { result: "invalid-grant", code: "invalid_grant" },
      );

      // Expiry.
      let staleUri = "";
      await r.step(
        {
          action: "browser",
          note: "A second push, left unopened.",
          args: { redirectUri: LOOP },
        },
        async (s) => {
          staleUri = await pushed(s, { state: `${STATE}-2` });
        },
        { navigated: "page" },
      );
      await r.step(
        {
          action: "browser",
          now: T0 + 601,
          note: "Past 600 s the request_uri is gone: the same page.",
          args: { redirectUri: LOOP },
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: authorizeUri(staleUri),
            metadata: false,
          });
          expect(res.status).toBe(400);
          expect(await res.text()).toContain("sign-in link has expired");
        },
        { navigated: "page" },
      );
      return r.transcript();
    }),
};

export const lockerRedirectNative: Scenario = {
  id: "locker-redirect-native",
  record: () =>
    pinned("locker-redirect-native", async (pin) => {
      const who = await nativeWorld();
      lockerSwitch(who.w);
      const r = recorder(
        who.w,
        pin,
        "locker-redirect-native",
        "The native sign-in with the customer host on (plans/LK-00.md §3, I-15 §6): the same conversation as redirect-native-loopback, but authorize with the request_uri answers 303 to https://polaris.locker/signin?request=rq_…&bind=<token> and sets no cookie. The customer host redeems the bind token once, sets the binder and answers 303 to /signin?request=rq_…; Continue and the return page run on the customer host. The push, authorize and token stay on the API host, so the app's own requests are the twin's.",
      );
      let handle = "";
      let bindPath = "";
      let binder = "";
      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "The push and authorize on the API host: a 303 to the customer host's bind hop, with no cookie.",
          args: { state: STATE, redirectUri: LOOP },
        },
        async (s) => {
          const uri = await pushed(s);
          const res = await s.send({
            method: "GET",
            path: authorizeUri(uri),
            metadata: false,
          });
          expect(res.status).toBe(303);
          expect(res.headers.get("set-cookie")).toBeNull();
          const loc = new URL(res.headers.get("location")!);
          expect(loc.origin).toBe(CUSTOMER);
          handle = handleOf(res);
          bindPath = loc.pathname + loc.search;
          for (const secret of [STATE, LOOP, uri])
            expect(res.headers.get("location")).not.toContain(secret);
        },
        { navigated: "bind" },
      );
      await r.step(
        {
          action: "browser",
          note: "The customer host redeems the token, sets the binder and sends the browser to the card.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            origin: CUSTOMER,
            path: bindPath,
            metadata: false,
          });
          expect(res.status).toBe(303);
          binder = binderOf(res);
        },
        { navigated: "card" },
      );
      await r.step(
        {
          action: "browser",
          note: "Continue to the app, on the customer host.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            origin: CUSTOMER,
            path: `/api/signin/requests/${handle}/continue`,
            metadata: false,
            headers: {
              cookie: `${who.cookie}; ${binder}`,
              [PORTAL_CSRF_HEADER]: who.csrf,
            },
            body: {},
            expectBody: { json: {}, match: "exact" },
          });
          expect(res.status).toBe(200);
          redirect = ((await res.json()) as { redirect: string }).redirect;
          expect(redirect.startsWith(`${LOOP}?code=`)).toBe(true);
        },
        { navigated: "app" },
      );
      await r.step(
        {
          action: "browser",
          note: "The return page, on the customer host.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            origin: CUSTOMER,
            path: `/signin/return?request=${handle}`,
            metadata: false,
          });
          expect(res.status).toBe(200);
          expect(res.headers.get("referrer-policy")).toBe("no-referrer");
        },
        { navigated: "page" },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The app redeems the code at the API host's token endpoint, exactly as in the twin.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await redeem(s, codeOf(redirect), LOOP);
          expect(res.status).toBe(200);
        },
        OK(who),
      );
      return r.transcript();
    }),
};

export const REDIRECT_NATIVE_SCENARIOS: Scenario[] = [
  redirectNativeLoopback,
  redirectNativeScheme,
  redirectNativeChooseApp,
  redirectNativeErrors,
  lockerRedirectNative,
];
