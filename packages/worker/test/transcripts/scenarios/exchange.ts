/// <reference types="@cloudflare/workers-types" />
// The native-token exchange (I-13, WIRE-CONTRACT-V5 §12.11.2, §12.11.3): an app that holds a
// Google or Apple ID token from the platform trades it for a device token, with no browser.
//
//   discovery-identity-exchange  discovery names the nonce route and the declared kinds
//   exchange-silent              nonce, then the grant: a linked person with consent gets a token
//   exchange-confirm             no consent yet: `confirm`, then `choice/complete` takes it
//   exchange-choose              consent stands but a licence choice is due: `choose`, then create
//   exchange-no-link             a valid token with no link: interstitial_required + linkHandle
//   exchange-errors              every verifier failure and a replayed nonce: one invalid_grant
//   exchange-disabled            Identity off: the nonce route does not exist (404)
//   exchange-gate-off            the launch gate off: no discovery members, so the client sends
//                                nothing (exchange is unavailable)
//   exchange-gate-off-stale      discovery fetched while the gate was on, then it goes off: the
//                                nonce 404s (unavailable) and the grant is unsupported_grant_type
//
// The SDK's call is `exchange` (one call: the nonce, the platform's token for that nonce, the
// grant). The provider token is the platform's, so a step carries it in `args.subjectToken` and
// the replaying client's provider stub hands it back for the nonce the Worker issued. The
// provider is a fixture key (`../providers.ts`); the nonce, the grant and the link handle are
// pinned by the seeded random stream.

import { expect } from "vitest";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, discovery, T0, VERSION } from "../client.js";
import type { JsonValue } from "../format.js";
import { pinned, PRODUCT, productWorld, servicesOn } from "../world.js";
import type { Scenario } from "../world.js";
import {
  appleToken,
  fixtureDeviceKeys,
  googleToken,
  PRODUCT_AUDIENCES,
  withProviders,
} from "../providers.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { loadProductPublic } from "../../../src/core/products.js";
import { askedScopeHash } from "../../../src/services/identity/passthrough/routes.js";
import { seedLicenseWithKey } from "../../seed.js";
import { holdLicense } from "./account.js";
import type { ServiceSlug } from "../../../src/core/services.js";
import {
  EXCHANGE_SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "@polaris-key/protocol/identity";

type Json = Record<string, JsonValue>;

export const KEY_LABEL = "transcript-device-key-1";
const GOOGLE_SUB = "g-sub-1";
const APPLE_SUB = "a-sub-1";
const FEATURES = ["identity.exchange"];

export async function exchangeWorld(
  on: ServiceSlug[] = ["config", "identity"],
): Promise<World> {
  const w = await productWorld(servicesOn(...on));
  w.env.PORTAL_SESSION_SECRET = "transcript-portal-session-secret";
  const set = (key: string, value: unknown) =>
    w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, ?, ?, 'manifest', ?, 'resync')`,
      PRODUCT,
      key,
      JSON.stringify(value),
      T0,
    );
  await set(
    "identity.platformSignIn.google.serverClientId",
    PRODUCT_AUDIENCES.googleServer,
  );
  await set("identity.platformSignIn.google.clientIds", [
    PRODUCT_AUDIENCES.googleAndroid,
  ]);
  await set(
    "identity.platformSignIn.apple.teamId",
    PRODUCT_AUDIENCES.appleTeam,
  );
  await set("identity.platformSignIn.apple.bundleIds", [
    PRODUCT_AUDIENCES.appleBundle,
  ]);
  return w;
}

/** A person whose Google identity is already linked to their account, with or without the
 *  consent they gave this app on an earlier sign-in (L-1). */
async function linkedGoogle(w: World, consented: boolean): Promise<string> {
  const r = await signIn(
    w.db,
    {
      issuerKey: "https://accounts.google.com",
      tenantScope: "",
      subject: GOOGLE_SUB,
      kind: "google",
      email: "ada@example.com",
      emailVerified: true,
    },
    T0,
    { unfenced: true, product: { slug: PRODUCT, tenantScopes: [""] } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  if (!consented) return r.account.id;
  const pub = (await loadProductPublic(w.db, PRODUCT))!;
  await w.db.run(
    `INSERT INTO account_product_grants
       (account_id, product, claims_json, granted_at, modified_at, scope_hash)
     VALUES (?, ?, '["profile","email"]', ?, ?, ?)`,
    r.account.id,
    PRODUCT,
    T0,
    T0,
    await askedScopeHash(pub),
  );
  return r.account.id;
}

export function recorder(
  w: World,
  pin: Pin,
  id: string,
  description: string,
  services: string[],
  features: string[] = FEATURES,
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features,
    requires: ["core.store"],
    product: PRODUCT,
    now: T0,
    world: w,
    pinned: pin,
    initial: { deviceId: DEVICE, version: VERSION, services },
  });
}

const NONCE = `/${PRODUCT}/identity/nonce`;
const TOKEN = `/${PRODUCT}/identity/token`;

interface Attempt {
  /** The nonce answer (always present). */
  nonce: Response;
  /** The grant answer; absent when the nonce was refused. */
  grant?: Response;
  json: Record<string, unknown>;
  token?: string;
}

/**
 * One `exchange` call as an SDK makes it: `POST …/nonce` with the device's keys, the token the
 * platform returns for that nonce, then `POST …/token` with the RFC 8693 grant and the
 * `exchange` proof. `preset` replays a nonce the client already holds (no nonce request).
 */
async function exchangeCall(
  s: StepRecorder,
  args: Json,
  mint: (nonce: string) => Promise<string>,
  preset?: string,
): Promise<Attempt> {
  const keys = fixtureDeviceKeys(KEY_LABEL);
  let nonce = preset;
  let nonceRes = new Response(null, { status: 200 });
  if (nonce === undefined) {
    const body = { signKey: keys.signKey, agreeKey: keys.agreeKey };
    nonceRes = await s.send({
      method: "POST",
      path: NONCE,
      body,
      expectBody: { json: body, match: "exact" },
    });
    if (nonceRes.status !== 200)
      return { nonce: nonceRes, json: await jsonOf(nonceRes) };
    nonce = ((await nonceRes.json()) as { nonce: string }).nonce;
  } else {
    args.nonce = nonce;
  }
  const token = await mint(nonce);
  args.subjectToken = token;
  const form = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    client_id: PRODUCT,
    subject_token: token,
    subject_token_type: EXCHANGE_SUBJECT_TOKEN_TYPE,
    nonce,
    device_key: keys.signKey,
    proof: keys.proof({
      purpose: "exchange",
      product: PRODUCT,
      deviceId: DEVICE,
      value: `${nonce}.${keys.signKey}`,
      token,
    }),
  };
  const grant = await withProviders(() =>
    s.send({
      method: "POST",
      path: TOKEN,
      form,
      expectBody: {
        json: form,
        match: "exact",
        allowedKeys: [...Object.keys(form), "license_choice", "device_name"],
      },
    }),
  );
  return { nonce: nonceRes, grant, json: await jsonOf(grant), token };
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.clone().text();
  return text.startsWith("{") ? (JSON.parse(text) as never) : {};
}

const exchangeArgs = (kind: "google" | "apple"): Json => ({
  kind,
  keyLabel: KEY_LABEL,
});

const google =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    googleToken(nonce, GOOGLE_SUB, over);
export const apple =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    appleToken(nonce, APPLE_SUB, over);

/** The code of a refusal body: `{"error":"x"}` or `{"error":{"code":"x"}}`. */
function codeOf(body: Record<string, unknown>): string {
  const e = body.error;
  return typeof e === "string"
    ? e
    : ((e as { code?: string } | undefined)?.code ?? "");
}

/** `choice/complete` as the SDK sends it after `confirm` or `choose`. */
function complete(s: StepRecorder, body: Json): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/${PRODUCT}/identity/choice/complete`,
    body,
    expectBody: { json: body, match: "exact" },
  });
}

// ── discovery ─────────────────────────────────────────────────────────────────────────────────

type Recorder = ReturnType<typeof recorder>;
type Pin = Parameters<Parameters<typeof pinned>[1]>[0];

/** The identity fragment of discovery, read through a recorded discover step. */
async function identityFragment(
  s: StepRecorder,
): Promise<{ exchange: unknown; nonce: unknown }> {
  const res = await discovery(s, PRODUCT);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as {
    services: {
      identity: { exchange?: unknown; endpoints: Record<string, unknown> };
    };
  };
  const { exchange, endpoints } = doc.services.identity;
  return { exchange, nonce: endpoints.nonce };
}

/** One recorded `exchange` call; `check` asserts the Worker's answers as an ordinary test. */
export function exchangeStep(
  r: Recorder,
  o: {
    kind?: "google" | "apple";
    note?: string;
    mint?: (nonce: string) => Promise<string>;
    preset?: string;
  },
  check: (a: Attempt) => void | Promise<void>,
  expectation: Json,
): Promise<void> {
  const args = exchangeArgs(o.kind ?? "google");
  return r.step(
    { action: "exchange", ...(o.note ? { note: o.note } : {}), args },
    async (s) => {
      const a = await exchangeCall(
        s,
        args,
        o.mint ?? (o.kind === "apple" ? apple() : google()),
        o.preset,
      );
      await check(a);
    },
    expectation,
  );
}

const OK_TOKEN: Json = {
  result: "ok",
  tokenHeld: true,
  scope: "profile email",
  issuedTokenType: "urn:polaris-key:token-type:device",
  licenseId: null,
};

// ── discovery ─────────────────────────────────────────────────────────────────────────────────

export const discoveryIdentityExchange: Scenario = {
  id: "discovery-identity-exchange",
  record: () =>
    pinned("discovery-identity-exchange", async (pin) => {
      const w = await exchangeWorld();
      const kinds = {
        kinds: ["google", "apple"],
        google: { serverClientId: PRODUCT_AUDIENCES.googleServer },
      };
      const r = recorder(
        w,
        pin,
        "discovery-identity-exchange",
        "Discovery of a product that declares Google and Apple platform sign-in (I-13, WIRE-CONTRACT-V5 §12.11.6). The identity fragment carries exchange {kinds, google.serverClientId} and the nonce endpoint beside the regular sign-in ones; the Apple bundle ids and team id are never published. An SDK uses the exchange rung only when both are present. A product that declares no kind keeps the fragment of discovery-identity.json, and one whose launch gate is off names neither (exchange-gate-off.json; a client with an older discovery: exchange-gate-off-stale.json).",
        ["config", "identity"],
        ["core.discover", "identity.exchange"],
      );
      await r.step(
        { action: "discover" },
        async (s) => {
          const f = await identityFragment(s);
          expect(f.exchange).toEqual(kinds);
          expect(f.nonce).toBe(`https://key.plrs.im${NONCE}`);
        },
        {
          result: "ok",
          services: services({ config: true, identity: true }),
          exchange: kinds,
          nonceEndpoint: true,
        },
      );
      return r.transcript();
    }),
};

const SERVICES = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
  "commerce",
  "connect",
] as const;

/** The `services` map a discover step expects: every slug, on or off. */
function services(on: Partial<Record<(typeof SERVICES)[number], true>>): Json {
  return Object.fromEntries(SERVICES.map((k) => [k, on[k] === true]));
}

// ── the grant ─────────────────────────────────────────────────────────────────────────────────

export const exchangeSilent: Scenario = {
  id: "exchange-silent",
  record: () =>
    pinned("exchange-silent", async (pin) => {
      const w = await exchangeWorld();
      await linkedGoogle(w, true);
      const r = recorder(
        w,
        pin,
        "exchange-silent",
        "Platform sign-in with nothing to ask (WIRE-CONTRACT-V5 §12.11.2, §12.11.3). exchange() posts the device's signing and agreement keys to the nonce route and gets a one-use nonce (300 s). The platform signs it into a Google ID token (aud the product's server client, azp its Android client). The grant is a form: grant_type token-exchange, client_id, subject_token, its type, the nonce, device_key and the pkey-proof/1 exchange proof over the product, device, nonce.key and the token's hash. The person's Google identity is linked and they have already consented to this app, so the answer is a device token (issued_token_type urn:polaris-key:token-type:device) and the SDK holds it. Nothing is created: the lookup is by link only.",
        ["config", "identity"],
      );
      await exchangeStep(
        r,
        {},
        (a) => {
          expect(a.grant!.status).toBe(200);
          expect(a.json.issued_token_type).toBe(
            "urn:polaris-key:token-type:device",
          );
          expect(typeof a.json.access_token).toBe("string");
        },
        OK_TOKEN,
      );
      return r.transcript();
    }),
};

export const exchangeConfirm: Scenario = {
  id: "exchange-confirm",
  record: () =>
    pinned("exchange-confirm", async (pin) => {
      const w = await exchangeWorld();
      await linkedGoogle(w, false);
      const r = recorder(
        w,
        pin,
        "exchange-confirm",
        "A linked person who has not consented to this app yet (WIRE-CONTRACT-V5 §12.11.3 rules 1 and 2, L-1). The grant answers status confirm instead of a token: a pending sign-in grant (300 s, bound to the device) and the consent view (who is asking, who the person signs in as, the items, firstTime). Nothing is bound or written. The SDK shows the consent, then completes with choice/complete {grant, consent {claims}}; the answer is the device token with the scope the person kept. consent is required on this grant.",
        ["config", "identity"],
      );
      let pending = "";
      // Filled by the drive: the consent view is only known once the Worker has answered.
      const view: Json = { result: "confirm" };
      await exchangeStep(
        r,
        {},
        (a) => {
          expect(a.grant!.status).toBe(200);
          expect(a.json.status).toBe("confirm");
          expect(a.json.access_token).toBeUndefined();
          pending = a.json.grant as string;
          const consent = a.json.consent as Record<string, unknown>;
          expect(consent.firstTime).toBe(true);
          Object.assign(view, {
            firstTime: consent.firstTime,
            changed: consent.changed,
            as: consent.as,
          } as Json);
        },
        view,
      );
      await r.step(
        {
          action: "choiceComplete",
          note: "choice.complete(grant, {consent}): the person kept both claims.",
          args: { grant: pending },
        },
        async (s) => {
          const res = await complete(s, {
            grant: pending,
            consent: { claims: ["profile", "email"] },
          });
          expect(res.status).toBe(200);
        },
        {
          result: "ok",
          tokenHeld: true,
          scope: "profile email",
          licenseId: null,
        },
      );
      return r.transcript();
    }),
};

export const exchangeChoose: Scenario = {
  id: "exchange-choose",
  record: () =>
    pinned("exchange-choose", async (pin) => {
      const w = await exchangeWorld(["config", "identity", "license"]);
      const accountId = await linkedGoogle(w, true);
      for (const id of ["lic_djdl_pro", "lic_djdl_lite"]) {
        await seedLicenseWithKey(w.db, PRODUCT, { id });
        await w.db.run(
          "UPDATE licenses SET email = NULL, device_limit = 3 WHERE product = ? AND id = ?",
          PRODUCT,
          id,
        );
        await holdLicense(w, id, accountId);
      }
      const r = recorder(
        w,
        pin,
        "exchange-choose",
        "A linked, consenting person whose account holds two licences (WIRE-CONTRACT-V5 §12.11.3, §12.5.1). The grant answers status choose with a pending grant and the licence view, and no token: the device is not bound yet. The SDK completes with choice/complete {grant, choice {kind: license, licenseId}} and holds the device token on that licence.",
        ["license", "config", "identity"],
      );
      let pending = "";
      await exchangeStep(
        r,
        {},
        (a) => {
          expect(a.grant!.status).toBe(200);
          expect(a.json.status).toBe("choose");
          expect(a.json.access_token).toBeUndefined();
          pending = a.json.grant as string;
        },
        { result: "choose" },
      );
      const done: Json = {};
      await r.step(
        {
          action: "choiceComplete",
          note: "choice.complete(grant, license).",
          args: { grant: pending },
        },
        async (s) => {
          const res = await complete(s, {
            grant: pending,
            choice: { kind: "license", licenseId: "lic_djdl_pro" },
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            license: { id: string } | null;
          };
          expect(body.license).not.toBeNull();
          Object.assign(done, {
            result: "ok",
            tokenHeld: true,
            scope: "profile email",
            licenseId: body.license!.id,
          });
        },
        done,
      );
      return r.transcript();
    }),
};

export const exchangeNoLink: Scenario = {
  id: "exchange-no-link",
  record: () =>
    pinned("exchange-no-link", async (pin) => {
      const w = await exchangeWorld();
      const r = recorder(
        w,
        pin,
        "exchange-no-link",
        "A valid Apple identity token that no account links (WIRE-CONTRACT-V5 §12.11.3 rule 4). Nothing is created and nothing is bound; an address in the token joins nothing. The answer is 403 interstitial_required with reason no_link, the sign-in card's url, and a linkHandle (lh_ and 43 characters, 600 s) for the link offer, so the app does not ask Apple for a second token. The SDK reports needs-sign-in carrying the handle.",
        ["config", "identity"],
      );
      const seen: Json = { result: "interstitial-required" };
      await exchangeStep(
        r,
        { kind: "apple" },
        (a) => {
          expect(a.grant!.status).toBe(403);
          expect(a.json.error).toBe("interstitial_required");
          expect(a.json.reason).toBe("no_link");
          expect(String(a.json.linkHandle)).toMatch(/^lh_[A-Za-z0-9_-]{43}$/);
          Object.assign(seen, {
            reason: a.json.reason as string,
            url: a.json.url as string,
            linkHandle: a.json.linkHandle as string,
            expiresIn: a.json.expiresIn as number,
            tokenHeld: false,
          });
        },
        seen,
      );
      return r.transcript();
    }),
};

export const exchangeErrors: Scenario = {
  id: "exchange-errors",
  record: () =>
    pinned("exchange-errors", async (pin) => {
      const w = await exchangeWorld();
      await linkedGoogle(w, true);
      const r = recorder(
        w,
        pin,
        "exchange-errors",
        "Every verifier failure is the same refusal (WIRE-CONTRACT-V5 §12.11.3). A token for another audience, one whose authorised party is foreign, one signed for another nonce, an expired one and a nonce the Worker already spent all answer 400 invalid_grant with the same bytes, so a caller learns nothing about which check failed. Each refusal leaves the client holding no token; the SDK reports sign-in-failed and the host may retry with a fresh nonce.",
        ["config", "identity"],
      );
      const bodies: string[] = [];
      const refused = (note: string, o: Parameters<typeof exchangeStep>[1]) =>
        exchangeStep(
          r,
          { ...o, note },
          (a) => {
            expect(a.grant!.status).toBe(400);
            expect(codeOf(a.json)).toBe("invalid_grant");
            bodies.push(JSON.stringify(a.json));
          },
          { result: "refused", code: "invalid_grant", tokenHeld: false },
        );
      await refused("A token for another audience.", {
        mint: google({ aud: "evil" }),
      });
      await refused("A foreign authorised party.", {
        mint: google({ azp: "evil" }),
      });
      await refused("A token signed for another nonce.", {
        mint: google({ nonce: "another-nonce" }),
      });
      await refused("An expired token.", {
        mint: google({ iat: T0 - 7200, exp: T0 - 3600 }),
      });
      // The nonce a success spends cannot be used again.
      let spent = "";
      await exchangeStep(
        r,
        {
          note: "A good exchange spends its nonce.",
          mint: async (n) => {
            spent = n;
            return google()(n);
          },
        },
        (a) => expect(a.grant!.status).toBe(200),
        OK_TOKEN,
      );
      await refused("The same nonce again.", { preset: spent });
      for (const b of bodies) expect(b).toBe(bodies[0]);
      return r.transcript();
    }),
};

export const exchangeDisabled: Scenario = {
  id: "exchange-disabled",
  record: () =>
    pinned("exchange-disabled", async (pin) => {
      const w = await exchangeWorld(["config"]);
      const r = recorder(
        w,
        pin,
        "exchange-disabled",
        "A product whose Identity service is off (WIRE-CONTRACT-V5 §12.11, WIRE-CONTRACT-V4 §12.8). The client still believes Identity is on (a discovery from before the toggle moved), so exchange() posts the keys to the nonce route and the Worker answers not_found: the route does not exist for this product. The SDK reports the rung unavailable, holds no token and sends no grant.",
        ["config", "identity"],
      );
      await exchangeStep(
        r,
        {},
        (a) => {
          expect(a.nonce.status).toBe(404);
          expect(a.json).toEqual({ error: { code: "not_found" } });
        },
        { result: "unavailable", tokenHeld: false },
      );
      return r.transcript();
    }),
};

const GATE_OFF = (w: World) => {
  (w.env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_EXCHANGE =
    "off";
};

export const exchangeGateOff: Scenario = {
  id: "exchange-gate-off",
  record: () =>
    pinned("exchange-gate-off", async (pin) => {
      const w = await exchangeWorld();
      await linkedGoogle(w, true);
      GATE_OFF(w);
      const r = recorder(
        w,
        pin,
        "exchange-gate-off",
        "A Worker whose platform sign-in launch gate is off (LG-1, launch.identityExchange). Discovery names neither the exchange member nor the nonce endpoint, so a client sends nothing to the nonce or token routes (WIRE-CONTRACT-V5 §12.11.6): exchange() reports unavailable, holds no token and makes no request, and the SDK starts at the regular sign-in. A client that fetched discovery before the gate went off is exchange-gate-off-stale.json.",
        ["config", "identity"],
      );
      await r.step(
        { action: "discover" },
        async (s) => {
          const f = await identityFragment(s);
          expect(f.exchange).toBeUndefined();
          expect(f.nonce).toBeUndefined();
        },
        {
          result: "ok",
          services: services({ config: true, identity: true }),
          exchange: null,
          nonceEndpoint: false,
        },
      );
      await r.step(
        {
          action: "exchange",
          note: "Discovery has no exchange member: the client sends nothing.",
          args: exchangeArgs("google"),
        },
        async () => {},
        { result: "unavailable", tokenHeld: false },
      );
      return r.transcript();
    }),
};

export const exchangeGateOffStale: Scenario = {
  id: "exchange-gate-off-stale",
  record: () =>
    pinned("exchange-gate-off-stale", async (pin) => {
      const w = await exchangeWorld();
      await linkedGoogle(w, true);
      const r = recorder(
        w,
        pin,
        "exchange-gate-off-stale",
        "A client whose discovery is from before the platform sign-in launch gate went off (LG-1, launch.identityExchange), so it still names the exchange member and the nonce endpoint. The nonce route now answers 404 not_found, which the client reads as unavailable. A nonce it fetched before the rollback, sent to the token route, gets 400 unsupported_grant_type, which the client reads as a refusal. Either way it holds no token and stores nothing.",
        ["config", "identity"],
      );
      await r.step(
        { action: "discover" },
        async (s) => {
          const f = await identityFragment(s);
          expect(f.exchange).toBeDefined();
          expect(f.nonce).toBeDefined();
        },
        {
          result: "ok",
          services: services({ config: true, identity: true }),
          exchange: {
            kinds: ["google", "apple"],
            google: { serverClientId: PRODUCT_AUDIENCES.googleServer },
          },
          nonceEndpoint: true,
        },
      );
      // The nonce the client fetched on the live gate, before the rollback.
      const early = await presetNonce(w, fixtureDeviceKeys(KEY_LABEL));
      GATE_OFF(w);
      await exchangeStep(
        r,
        { note: "The nonce route is gone: unavailable." },
        (a) => {
          expect(a.nonce.status).toBe(404);
          expect(codeOf(a.json)).toBe("not_found");
        },
        { result: "unavailable", tokenHeld: false },
      );
      await exchangeStep(
        r,
        {
          note: "A nonce fetched before the gate went off: the grant is unsupported, a refusal.",
          preset: early,
        },
        (a) => {
          expect(a.grant!.status).toBe(400);
          expect(a.json.error).toBe("unsupported_grant_type");
        },
        { result: "refused", code: "unsupported_grant_type", tokenHeld: false },
      );
      return r.transcript();
    }),
};

/** A nonce issued while the gate is on, before the scenario's recording starts. */
async function presetNonce(
  w: World,
  keys: ReturnType<typeof fixtureDeviceKeys>,
): Promise<string> {
  const res = await dispatchWith(
    new Request(`https://key.plrs.im${NONCE}`, {
      method: "POST",
      headers: {
        "x-pkey-device": DEVICE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ signKey: keys.signKey, agreeKey: keys.agreeKey }),
    }) as unknown as Request,
    w.env,
    w.db,
    T0,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { nonce: string }).nonce;
}

export const EXCHANGE_SCENARIOS: Scenario[] = [
  discoveryIdentityExchange,
  exchangeSilent,
  exchangeConfirm,
  exchangeChoose,
  exchangeNoLink,
  exchangeErrors,
  exchangeDisabled,
  exchangeGateOff,
  exchangeGateOffStale,
];
