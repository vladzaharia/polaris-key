/// <reference types="@cloudflare/workers-types" />
// The four Polaris Locker transcripts (LK-04, plans/LK-00.md §5): the same conversations as their
// key.plrs.im twins, recorded with `CUSTOMER_ORIGIN` set, so the unsigned
// URL values (WIRE-CONTRACT-V4 §3 of plans/LK-00.md) name the customer host:
//
//   locker-refusal-links      the seat and key-entry refusals' `manageUrl`
//   locker-discovery-identity discovery's `accountPortal`
//   locker-devicecode         `verificationUri` and `verificationUriComplete`
//   locker-redirect-web       authorize's 303 through the bind hop (`browser` steps)
//
// Every other transcript is recorded in a world that leaves `CUSTOMER_ORIGIN` unset, so none of
// them changes: that is the compatibility proof. The customer host's requests are recorded by
// path only (`ExchangeSpec.origin`); a replayer serves them from its one fake server.

import { expect } from "vitest";
import { dispatchWith } from "../../../src/dispatch.js";
import { PORTAL_CSRF_HEADER } from "../../../src/services/identity/portal/session.js";
import {
  BASE_URL,
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import {
  DEVICE,
  discovery,
  document,
  FINGERPRINT,
  FINGERPRINT_EXPECT,
  syncReport,
  T0,
  trust,
  VERSION,
} from "../client.js";
import {
  enforced,
  pinned,
  PRODUCT,
  productWorld,
  servicesOn,
  setup,
  type Scenario,
} from "../world.js";
import { seedLicenseWithKey } from "../../seed.js";
import { answerTokenExchange, signIdToken } from "../idp.js";
import type { JsonValue } from "../format.js";
import { refusalsOn, setLimit } from "./keyEntry.js";
import {
  identityWorld,
  PLAYER,
  pollSpec,
  promptOf,
  START,
  type Started,
} from "./identity.js";
import {
  authorizePath,
  binderOf,
  codeOfRedirect,
  handleOf,
  token,
  world as redirectWorld,
} from "./redirect.js";
import { WEB_CALLBACK } from "./webSignIn.js";

export const CUSTOMER = "https://polaris.locker";

const IDENTITY_ON = servicesOn("license", "config", "identity");

/** The deploy sets the customer origin (a hard cutover: no switch). The console origin is the
 *  recorder's own host. */
export function lockerSwitch(w: World): void {
  w.env.CONSOLE_ORIGIN = BASE_URL;
  w.env.CUSTOMER_ORIGIN = CUSTOMER;
}

/** A request from the person's browser to `origin`, outside the recording. */
function browserAt(
  w: World,
  origin: string,
  now: number,
  method: "GET" | "POST",
  path: string,
  opts: { form?: Record<string, string>; cookie?: string } = {},
): Promise<Response> {
  return dispatchWith(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        ...(opts.form
          ? {
              "content-type": "application/x-www-form-urlencoded",
              "sec-fetch-site": "same-origin",
            }
          : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      ...(opts.form ? { body: new URLSearchParams(opts.form).toString() } : {}),
    }) as unknown as Request,
    w.env,
    w.db,
    now,
  );
}

// ── locker-refusal-links ────────────────────────────────────────────────────────────────────

const OCCUPANT = "TRANSCRIPTLOCKEROCCUPANT00000001";
const OTHERS = [
  "TRANSCRIPTLOCKEROTHER0000000000A",
  "TRANSCRIPTLOCKEROTHER0000000000B",
];

export const lockerRefusalLinks: Scenario = {
  id: "locker-refusal-links",
  record: () =>
    pinned("locker-refusal-links", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      lockerSwitch(world);
      // Licence A has one seat, held by another device; licence B has none to spare.
      const a = await seedLicenseWithKey(world.db, PRODUCT, {
        id: "lic_locker_a",
        entitlements: { deviceLimit: enforced(1) },
      });
      const b = await seedLicenseWithKey(world.db, PRODUCT, {
        id: "lic_locker_b",
      });
      await setLimit(world, 2);
      await refusalsOn(world);
      const enter = async (key: string, device: string) =>
        expect(
          (
            await setup(world, "POST", `/${PRODUCT}/license/activate`, {
              authorization: `Bearer ${key}`,
              "x-pkey-device": device,
            })
          ).status,
        ).toBe(200);
      await enter(a.key, OCCUPANT);
      for (const d of OTHERS) await enter(b.key, d);

      const r = new TranscriptRecorder({
        id: "locker-refusal-links",
        description:
          "The refusals' portal links with the customer host on (plans/LK-00.md §3): the same conversations as license-device-limit and keyentry-limit, but manageUrl names https://polaris.locker. A licence whose only seat is taken is refused with device_limit and the portal's activate page; a key already entered by two other devices, at a limit of 2, is refused with key_entry_limit and the same page. Nothing signed changes: the refusals, their codes and the client's state are exactly the twins'. A client treats the link as any https URL and never builds one.",
        features: ["license.manage", "identity.keyentry"],
        requires: ["core.store"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      const refused = (s: StepRecorder) =>
        s.send({
          method: "POST",
          path: `/${PRODUCT}/license/activate`,
          bearer: "key",
          body: FINGERPRINT,
          expectBody: FINGERPRINT_EXPECT,
        });
      await r.step(
        {
          action: "activate",
          args: { key: a.key },
          note: "The only seat is taken: device_limit, with the customer host's activate page.",
        },
        async (s) => {
          const res = await refused(s);
          expect(res.status).toBe(403);
          expect(await res.clone().json()).toMatchObject({
            error: "device_limit",
            manageUrl: `${CUSTOMER}/activate?product=${PRODUCT}&next=free-device&for=Linux%20x86_64`,
          });
        },
        {
          result: "device-limit",
          manageUrl: `${CUSTOMER}/activate?product=${PRODUCT}&next=free-device&for=Linux%20x86_64`,
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );
      await r.step(
        {
          action: "activate",
          args: { key: b.key },
          now: T0 + 60,
          note: "Two other devices have entered the key and the limit is 2: key_entry_limit, with the same page.",
        },
        async (s) => {
          const res = await refused(s);
          expect(res.status).toBe(403);
          expect(await res.clone().json()).toMatchObject({
            error: "key_entry_limit",
            keyEntries: { used: 2, limit: 2 },
            manageUrl: `${CUSTOMER}/activate?product=${PRODUCT}`,
          });
        },
        {
          result: "key-entry-limit",
          keyEntries: { used: 2, limit: 2 },
          manageUrl: `${CUSTOMER}/activate?product=${PRODUCT}`,
          licenseStatus: "needs-activation",
          tokenHeld: false,
        },
      );
      return r.transcript();
    }),
};

// ── locker-discovery-identity ───────────────────────────────────────────────────────────────

export const lockerDiscoveryIdentity: Scenario = {
  id: "locker-discovery-identity",
  record: () =>
    pinned("locker-discovery-identity", async (pin) => {
      const world = await productWorld(IDENTITY_ON);
      lockerSwitch(world);
      await world.db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES (?, 'identity.keyEntry.limit', '5', 'manifest', ?, 'resync')`,
        PRODUCT,
        T0,
      );
      const r = new TranscriptRecorder({
        id: "locker-discovery-identity",
        description:
          "Discovery of an Identity product with the customer host on (plans/LK-00.md §3): the same document as discovery-identity, except accountPortal, the one customer URL it carries, names https://polaris.locker. Every other endpoint, the issuer and the signed documents stay on the API host. A client uses accountPortal as any https URL.",
        features: ["core.discover", "identity.account"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      await r.step(
        { action: "discover" },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as {
            services: {
              identity: { endpoints: Record<string, string> } & Record<
                string,
                unknown
              >;
            };
          };
          expect(doc.services.identity).toMatchObject({
            enabled: true,
            account: true,
            keyEntryLimit: 5,
          });
          const e = doc.services.identity.endpoints;
          expect(e.accountPortal?.startsWith(`${CUSTOMER}/`)).toBe(true);
          expect(e.authorize).toBe(`${BASE_URL}/${PRODUCT}/identity/authorize`);
          expect(e.token).toBe(`${BASE_URL}/${PRODUCT}/identity/token`);
        },
        {
          result: "ok",
          services: {
            license: true,
            config: true,
            release: false,
            distribution: false,
            update: false,
            identity: true,
            sync: false,
            commerce: false,
          },
        },
      );
      return r.transcript();
    }),
};

// ── locker-devicecode ───────────────────────────────────────────────────────────────────────

/** The player opens the customer host's entry, which hands the browser to the product's page on
 *  the API host; there they confirm, sign in at the mocked IdP, and the callback runs for real.
 *  Unrecorded, like the twin's. */
async function playerSignsInAtLocker(
  w: World,
  now: number,
  verificationUriComplete: string,
): Promise<void> {
  const complete = new URL(verificationUriComplete);
  expect(complete.origin).toBe(CUSTOMER);
  const userCode = complete.searchParams.get("user_code")!;
  const entry = await browserAt(
    w,
    CUSTOMER,
    now,
    "GET",
    complete.pathname + complete.search,
  );
  expect(entry.status).toBe(302);
  const page = new URL(entry.headers.get("location")!);
  expect(page.origin).toBe(BASE_URL);
  const shown = await browserAt(
    w,
    BASE_URL,
    now,
    "GET",
    page.pathname + page.search,
  );
  expect(shown.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await shown.text())?.[1];
  expect(csrf).toBeTruthy();
  const continued = await browserAt(w, BASE_URL, now, "POST", page.pathname, {
    form: { user_code: userCode, csrf: csrf! },
  });
  expect(continued.status).toBe(303);
  const authorize = new URL(continued.headers.get("location")!);
  const state = authorize.searchParams.get("state")!;
  const nonce = authorize.searchParams.get("nonce")!;
  const binder = (continued.headers.get("set-cookie") ?? "").split(";")[0]!;
  const idToken = await signIdToken(PLAYER, nonce, now);
  const callback = await answerTokenExchange(idToken, () =>
    browserAt(
      w,
      BASE_URL,
      now,
      "GET",
      `/${PRODUCT}/identity/auth/callback?code=idp-code&state=${state}`,
      { cookie: binder },
    ),
  );
  expect(callback.status).toBe(200);
}

export const lockerDevicecode: Scenario = {
  id: "locker-devicecode",
  record: () =>
    pinned("locker-devicecode", async (pin) => {
      const world = await identityWorld();
      lockerSwitch(world);
      const r = new TranscriptRecorder({
        id: "locker-devicecode",
        description:
          "Device-code sign-in with the customer host on (plans/LK-00.md §3, §7.9): the same conversation as devicecode-happy, but verificationUri is https://polaris.locker/device and verificationUriComplete adds ?user_code=. The customer host's entry hands the player to the product's page on the API host, where they confirm and the flow's binder is set by their browser for the IdP's callback; the device code, the poll and the signed token are exactly the twin's. A client shows both URIs as given and never builds one.",
        features: ["identity.devicecode"],
        requires: ["core.store", "core.sync"],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: {
          deviceId: DEVICE,
          version: VERSION,
          services: ["license", "config", "identity"],
        },
      });
      let started!: Started;
      const deviceName = "Living-room PC";
      const begun: Record<string, JsonValue> = {};
      await r.step(
        { action: "beginSignIn", args: { deviceName } },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: START,
            body: { deviceId: DEVICE, deviceName },
            expectBody: {
              json: { deviceId: DEVICE, deviceName },
              match: "exact",
            },
          });
          expect(res.status).toBe(200);
          started = (await res.json()) as Started;
          expect(started.verificationUri).toBe(`${CUSTOMER}/device`);
          expect(started.verificationUriComplete).toBe(
            `${CUSTOMER}/device?user_code=${started.userCode}`,
          );
          Object.assign(begun, { prompt: promptOf(started), tokenHeld: false });
        },
        begun,
      );
      await r.step(
        { action: "pollSignIn", now: T0 + 2, note: "Pending." },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(await res.json()).toEqual({ status: "pending" });
        },
        { result: "pending", tokenHeld: false },
      );
      await playerSignsInAtLocker(
        world,
        T0 + 6,
        started.verificationUriComplete,
      );
      await r.step(
        {
          action: "pollSignIn",
          now: T0 + 7,
          note: "Ready: store the token, then the forced post-acquisition sync.",
        },
        async (s) => {
          const res = await s.send({
            ...pollSpec(started.deviceCode),
            capture: { token: "$.token" },
          });
          const body = (await res.json()) as { status: string; token: string };
          expect(body.status).toBe("ready");
          await trust(s, PRODUCT);
          expect((await document(s, PRODUCT, "license")).status).toBe(200);
          expect((await document(s, PRODUCT, "config")).status).toBe(200);
          expect(
            (await syncReport(s, PRODUCT, { config: {}, entitlements: {} }))
              .status,
          ).toBe(200);
        },
        { result: "ready", tokenHeld: true, licenseStatus: "ok" },
      );
      return r.transcript();
    }),
};

// ── locker-redirect-web ─────────────────────────────────────────────────────────────────────

const STATE = "tidewater-state-0123456789";
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";

export const lockerRedirectWeb: Scenario = {
  id: "locker-redirect-web",
  record: () =>
    pinned("locker-redirect-web", async (pin) => {
      const { w, cookie, csrf, subject } = await redirectWorld();
      lockerSwitch(w);
      const r = new TranscriptRecorder({
        id: "locker-redirect-web",
        description:
          "A web app signs a person in with the customer host on (plans/LK-00.md §3, §7.8): the same conversation as redirect-web-happy, but authorize answers 303 to https://polaris.locker/signin?request=rq_…&bind=<token> and sets no cookie. The customer host redeems the bind token once, sets the request's binder itself and answers 303 to /signin?request=rq_…; the card's Continue then runs on the customer host. Issuer, authorize and token stay on the API host, so the SDK's own request is the twin's token exchange. The bind URL carries no state, challenge or redirect URI, and a second visit to it is refused.",
        features: ["identity.redirect.web"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      let handle = "";
      let bindPath = "";
      let binder = "";
      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "The app sends the browser to authorize on the API host: a 303 to the customer host's bind hop, with no cookie.",
          args: {
            state: STATE,
            redirectUri: WEB_CALLBACK,
            codeVerifier: VERIFIER,
          },
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            path: authorizePath(),
            metadata: false,
          });
          expect(res.status).toBe(303);
          expect(res.headers.get("set-cookie")).toBeNull();
          const loc = new URL(res.headers.get("location")!);
          expect(loc.origin).toBe(CUSTOMER);
          expect(loc.pathname).toBe("/signin");
          handle = handleOf(res);
          bindPath = loc.pathname + loc.search;
          for (const secret of [STATE, WEB_CALLBACK])
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
          expect(res.headers.get("location")).toBe(`/signin?request=${handle}`);
          binder = binderOf(res);
        },
        { navigated: "card" },
      );
      await r.step(
        {
          action: "browser",
          note: "A second visit to the bind URL is the plain not-found: it was single use.",
        },
        async (s) => {
          const res = await s.send({
            method: "GET",
            origin: CUSTOMER,
            path: bindPath,
            metadata: false,
          });
          expect(res.status).toBe(404);
        },
        { navigated: "refused" },
      );
      await r.step(
        {
          action: "browser",
          note: "Continue to the app, on the customer host: the session, the CSRF header and the binder; the answer carries the code.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            origin: CUSTOMER,
            path: `/api/signin/requests/${handle}/continue`,
            metadata: false,
            headers: {
              cookie: `${cookie}; ${binder}`,
              [PORTAL_CSRF_HEADER]: csrf,
            },
            body: {},
            expectBody: { json: {}, match: "exact" },
          });
          expect(res.status).toBe(200);
          redirect = ((await res.json()) as { redirect: string }).redirect;
          expect(redirect.startsWith(`${WEB_CALLBACK}?code=`)).toBe(true);
        },
        { navigated: "app" },
      );
      const code = codeOfRedirect(redirect);
      await r.step(
        {
          action: "redirectComplete",
          note: "The SDK redeems the code at the API host's token endpoint, exactly as in the twin.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await token(s, code, VERIFIER);
          expect(res.status).toBe(200);
        },
        {
          result: "ok",
          scope: "profile email",
          licenseId: null,
          subject,
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const LOCKER_SCENARIOS: Scenario[] = [
  lockerRefusalLinks,
  lockerDiscoveryIdentity,
  lockerDevicecode,
  lockerRedirectWeb,
];
