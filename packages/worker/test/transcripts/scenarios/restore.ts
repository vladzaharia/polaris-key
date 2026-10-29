/// <reference types="@cloudflare/workers-types" />
// Silent restore (I-49, WIRE-CONTRACT-V5 §12.11.8): a new device of a person who was signed in
// redeems the restore key its platform backup carried, once, and is signed in with no click.
//
//   discovery-identity-restore  discovery names `restore: true` and the `restore` endpoint
//   restore-happy               redeem on a new device, enrol (201), check (current), re-enrol (201)
//   restore-confirm             consent not given yet: `confirm` with `as` {null, null}, then
//                               `choice/complete`
//   restore-errors              every refusal is one byte-identical `invalid_grant`: wrong
//                               secret, unknown id, bad proof, another product's key (not consumed),
//                               an agreement key another device holds, an enrolling device that is
//                               no longer signed in, a replay; `account_required` on enrol; and
//                               the per-account `429`
//   restore-signout             sign-out deletes the device's key; its old secret is refused
//   restore-gate-off            the launch gate off: the grant is `unsupported_grant_type`, enrol
//                               `404`, `DELETE` still `204`, discovery names nothing
//
// The recorded client is the NEW device (`TRANSCRIPTDEVICE…`): it holds the restore key its
// backup carried (`args.restoreId`, `args.restoreSecret`, written into the transcript by the
// scenario and read by a replayer's backup stub), sends the form of §12.11.8 and, once signed in,
// enrols a key of its own. The device that enrolled the first key is setup and not recorded.
//
// The steps are `restoreRedeem`, `restoreEnroll` and `restoreDelete` (format.ts); the sign-out
// and the licence choice reuse `signOut` and `choiceComplete`.

import { expect } from "vitest";
import type { JsonValue } from "../format.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  registered,
  servicesOn,
} from "../world.js";
import { DEVICE, discovery, T0, VERSION } from "../client.js";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import type { Scenario } from "../world.js";
import { fixtureDeviceKeys } from "../providers.js";
import { seedAccount } from "./account.js";
import {
  codeOf,
  confirmed,
  jsonOf,
  keptBothClaims,
  services,
} from "./exchange.js";
import { seedProduct } from "../../seed.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { loadProductPublic } from "../../../src/core/products.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { rateLimitOk } from "../../../src/core/rateLimit.js";
import { askedScopeHash } from "../../../src/services/identity/passthrough/routes.js";
import { mintRestoreKey } from "../../../src/services/identity/restore/store.js";
import { RESTORE_ACCOUNT_RATE } from "../../../src/services/identity/passthrough/restore.js";
import { RESTORE_GRANT_TYPE } from "@polaris-key/protocol/identity";

type Json = Record<string, JsonValue>;

const FEATURES = ["identity.restore"];
const KEY_LABEL = "transcript-restore-key-1";
/** The keys of the one step whose agreement key another device holds. */
const TAKEN_LABEL = "transcript-restore-key-2";
const RESTORE = `/${PRODUCT}/identity/restore`;

/** The devices that enrolled keys before the recording starts: 32 base64url characters each. */
const dev = (name: string): string => name.padEnd(31, "0") + "1";
const OLD = dev("TRANSCRIPTOLDDEVICE");
const OLD2 = dev("TRANSCRIPTOLDDEVICETWO");
const OLD3 = dev("TRANSCRIPTOLDDEVICE3");
const OLD4 = dev("TRANSCRIPTOLDDEVICE4");
const HOLDER = dev("TRANSCRIPTKEYHOLDER");
const OTHER = "other";

/** Enrolled a day before the recording starts, so a key is current and live. */
const ENROLLED = T0 - 86_400;
const DAY = 86_400;

interface Ada {
  id: string;
  subject: string;
}

export async function restoreWorld(
  o: { consented?: boolean } = {},
): Promise<{ w: World; ada: Ada }> {
  const w = await productWorld(servicesOn("config", "identity"));
  w.env.PORTAL_SESSION_SECRET = "transcript-portal-session-secret";
  // Mail is not part of the wire contract, but the restore refuses an account no notice can reach.
  (w.env as unknown as { EMAIL: unknown }).EMAIL = {
    send: async () => {},
  };
  const ada = await seedAccount(w, "ada@example.com");
  if (o.consented !== false) {
    const pub = (await loadProductPublic(w.db, PRODUCT))!;
    await w.db.run(
      `INSERT INTO account_product_grants
         (account_id, product, claims_json, granted_at, modified_at, scope_hash)
       VALUES (?, ?, '["profile","email"]', ?, ?, ?)`,
      ada.id,
      PRODUCT,
      T0,
      T0,
      await askedScopeHash(pub),
    );
  }
  return { w, ada };
}

/** Setup: the client's device registers (the open policy of a product with Config alone), then Identity goes on. */
async function registeredDevice(w: World): Promise<string> {
  await setServices(
    w.db,
    PRODUCT,
    serializeServices({ services: servicesOn("config") }),
    "manifest",
    T0,
  );
  const token = await registered(w);
  await setServices(
    w.db,
    PRODUCT,
    serializeServices({ services: servicesOn("config", "identity") }),
    "manifest",
    T0,
  );
  return token;
}

/** Setup: the client's device holds a token and is signed in as Ada. */
async function signedInDevice(w: World, ada: Ada): Promise<string> {
  const token = await registeredDevice(w);
  expect(
    await setDeviceSubject(w.env, w.db, PRODUCT, DEVICE, ada.subject),
  ).toBe(true);
  return token;
}

/** Setup: a device row that is authorized and signed in as `subject`. */
async function boundDevice(
  w: World,
  deviceId: string,
  subject: string,
  product = PRODUCT,
): Promise<void> {
  await w.db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
     VALUES (?, ?, '', 'authorized', ?, ?, ?)
     ON CONFLICT (product, device_id) DO NOTHING`,
    product,
    deviceId,
    ENROLLED,
    ENROLLED,
    subject,
  );
}

/** Setup: `deviceId` is signed in as Ada and enrolled a key a day ago. */
async function enrolledKey(
  w: World,
  ada: Ada,
  deviceId: string,
  product = PRODUCT,
): Promise<{ restoreId: string; secret: string }> {
  await boundDevice(w, deviceId, ada.subject, product);
  const key = await mintRestoreKey(w.env, w.db, {
    product,
    deviceId,
    subject: ada.subject,
    boundSubject: ada.subject,
    now: ENROLLED,
  });
  if (!key) throw new Error("setup: restore key");
  return key;
}

function recorder(
  w: World,
  pin: Parameters<Parameters<typeof pinned>[1]>[0],
  id: string,
  description: string,
  o: { token?: string; services?: string[]; features?: string[] } = {},
): TranscriptRecorder {
  return new TranscriptRecorder({
    id,
    description,
    features: o.features ?? FEATURES,
    requires: ["core.store"],
    product: PRODUCT,
    now: T0,
    world: w,
    pinned: pin,
    initial: {
      deviceId: DEVICE,
      version: VERSION,
      services: o.services ?? ["config", "identity"],
      ...(o.token ? { token: o.token } : {}),
    },
  });
}

// ── the client's moves ────────────────────────────────────────────────────────────────────────

interface RedeemOptions {
  note?: string;
  /** The key the backup carried. */
  key: { restoreId: string; secret: string };
  /** The product the grant is addressed to; absent means the transcript's own. */
  product?: string;
  /** The value the proof covers instead of `<restore_id>.<device_key>` (a proof that is not the key's). */
  proofValue?: string;
  now?: number;
  /** The device keys' label; absent means this scenario's. */
  keyLabel?: string;
  capture?: boolean;
}

interface Redeemed {
  res: Response;
  json: Record<string, unknown>;
  text: string;
}

function redeemArgs(o: RedeemOptions): Json {
  return {
    keyLabel: o.keyLabel ?? KEY_LABEL,
    restoreId: o.key.restoreId,
    restoreSecret: o.key.secret,
    ...(o.product ? { product: o.product } : {}),
    ...(o.proofValue ? { proofValue: o.proofValue } : {}),
  };
}

/** One `restoreRedeem`: the form of §12.11.8 at `token`, the proof over `<id>.<device_key>`. */
async function redeemCall(
  s: StepRecorder,
  o: RedeemOptions,
): Promise<Redeemed> {
  const keys = fixtureDeviceKeys(o.keyLabel ?? KEY_LABEL);
  const product = o.product ?? PRODUCT;
  const form = {
    grant_type: RESTORE_GRANT_TYPE,
    client_id: product,
    restore_id: o.key.restoreId,
    restore_secret: o.key.secret,
    device_key: keys.signKey,
    agree_key: keys.agreeKey,
    proof: keys.proof({
      purpose: "restore",
      product,
      deviceId: DEVICE,
      value: o.proofValue ?? `${o.key.restoreId}.${keys.signKey}`,
      token: o.key.secret,
    }),
  };
  const res = await s.send({
    method: "POST",
    path: `/${product}/identity/token`,
    form,
    expectBody: {
      json: form,
      match: "exact",
      allowedKeys: [...Object.keys(form), "license_choice", "device_name"],
    },
    ...(o.capture ? { capture: { token: "$.access_token" } } : {}),
  });
  return { res, json: await jsonOf(res), text: await res.clone().text() };
}

function redeem(
  r: TranscriptRecorder,
  o: RedeemOptions,
  check: (a: Redeemed) => void | Promise<void>,
  expectation: Json,
): Promise<void> {
  return r.step(
    {
      action: "restoreRedeem",
      ...(o.note ? { note: o.note } : {}),
      ...(o.now !== undefined ? { now: o.now } : {}),
      args: redeemArgs(o),
    },
    async (s) => {
      await check(await redeemCall(s, o));
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

const refusedGrant = (code: string, status = 400): Json => ({
  result: "refused",
  status,
  code,
  tokenHeld: false,
});

/** `POST /<p>/identity/restore {restoreId?}` with the device's token. */
async function enrolCall(
  s: StepRecorder,
  restoreId?: string,
): Promise<Response> {
  const body: Json = restoreId === undefined ? {} : { restoreId };
  return s.send({
    method: "POST",
    path: RESTORE,
    bearer: "token",
    body,
    expectBody: { json: body, match: "exact" },
  });
}

function enrol(
  r: TranscriptRecorder,
  o: { note?: string; now?: number; restoreId?: string },
  check: (res: Response, json: Record<string, unknown>) => void | Promise<void>,
  expectation: Json,
): Promise<void> {
  return r.step(
    {
      action: "restoreEnroll",
      ...(o.note ? { note: o.note } : {}),
      ...(o.now !== undefined ? { now: o.now } : {}),
      args: o.restoreId === undefined ? {} : { restoreId: o.restoreId },
    },
    async (s) => {
      const res = await enrolCall(s, o.restoreId);
      await check(res, await jsonOf(res));
    },
    expectation,
  );
}

/** `restoreEnroll` by a device that holds a token but is not signed in: 403 `account_required`. */
function enrolRefused(
  r: TranscriptRecorder,
  now: number,
  note: string,
): Promise<void> {
  return enrol(
    r,
    { now, note },
    (res, json) => {
      expect(res.status).toBe(403);
      expect(codeOf(json)).toBe("account_required");
    },
    { result: "refused", status: 403, code: "account_required" },
  );
}

// ── discovery ─────────────────────────────────────────────────────────────────────────────────

async function identityFragment(
  s: StepRecorder,
): Promise<{ restore: unknown; endpoint: unknown }> {
  const res = await discovery(s, PRODUCT);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as {
    services: {
      identity: { restore?: unknown; endpoints: Record<string, unknown> };
    };
  };
  const { restore, endpoints } = doc.services.identity;
  return { restore, endpoint: endpoints.restore };
}

const discoverStep = (
  r: TranscriptRecorder,
  offered: boolean,
  note?: string,
): Promise<void> =>
  r.step(
    { action: "discover", ...(note ? { note } : {}) },
    async (s) => {
      const f = await identityFragment(s);
      if (offered) {
        expect(f.restore).toBe(true);
        expect(f.endpoint).toBe(`https://key.plrs.im${RESTORE}`);
      } else {
        expect(f.restore).toBeUndefined();
        expect(f.endpoint).toBeUndefined();
      }
    },
    {
      result: "ok",
      services: services({ config: true, identity: true }),
      restore: offered,
      restoreEndpoint: offered,
    },
  );

export const discoveryIdentityRestore: Scenario = {
  id: "discovery-identity-restore",
  record: () =>
    pinned("discovery-identity-restore", async (pin) => {
      const { w } = await restoreWorld();
      const r = recorder(
        w,
        pin,
        "discovery-identity-restore",
        "Discovery of a product whose silent restore is served (I-49, WIRE-CONTRACT-V5 §12.11.6, §12.11.8). The identity fragment carries restore: true and the restore endpoint beside the sign-in ones, only while Identity, the product's identity.restore setting (on unless the developer switched it off) and the platform launch gate launch.identityRestore all allow it. A client tries the restore grant, and enrols a key, only when the member is present, and never builds the URL. A product with the gate off names neither (restore-gate-off.json).",
        { features: ["core.discover", ...FEATURES] },
      );
      await discoverStep(r, true);
      return r.transcript();
    }),
};

// ── the grant ─────────────────────────────────────────────────────────────────────────────────

export const restoreHappy: Scenario = {
  id: "restore-happy",
  record: () =>
    pinned("restore-happy", async (pin) => {
      const { w, ada } = await restoreWorld();
      const key = await enrolledKey(w, ada, OLD);
      const r = recorder(
        w,
        pin,
        "restore-happy",
        "A new device of a person who was signed in, with the restore key its platform backup carried (I-49, WIRE-CONTRACT-V5 §12.11.8). Discovery names restore. The device posts the restore grant as a form: grant_type urn:polaris-key:grant-type:restore, client_id, restore_id, restore_secret, its device_key and agree_key, and the pkey-proof/1 restore proof (value <restore_id>.<device_key>, the sixth line the SHA-256 of the secret). The person has already consented to this app, so the answer is a device token and the SDK holds it: no click. The key is used up. The device then enrols a key of its own, POST restore {} answering 201 {restoreId, secret}, which the client writes into the backup; a check with that id answers 200 current; and past 90 days the same call answers 201 with a new key that replaces it.",
      );
      await discoverStep(r, true);
      await redeem(
        r,
        { key, capture: true, note: "The backup's key, once: a device token." },
        (a) => {
          expect(a.res.status).toBe(200);
          expect(a.json.issued_token_type).toBe(
            "urn:polaris-key:token-type:device",
          );
          expect(typeof a.json.access_token).toBe("string");
        },
        OK_TOKEN,
      );
      // The expectations are filled in once the Worker has answered; the recorder keeps the reference.
      const enrolledExpect: Json = { result: "enrolled" };
      const rotatedExpect: Json = { result: "enrolled" };
      let enrolled = { restoreId: "" };
      await r.step(
        {
          action: "restoreEnroll",
          now: T0 + 60,
          note: "Signed in: enrol a key of its own. The secret comes once, in the 201.",
          args: {},
        },
        async (s) => {
          const res = await enrolCall(s);
          expect(res.status).toBe(201);
          const j = (await res.json()) as { restoreId: string; secret: string };
          expect(res.headers.get("cache-control")).toBe("no-store");
          enrolled = j;
          enrolledExpect.restoreId = j.restoreId;
          enrolledExpect.secret = j.secret;
        },
        enrolledExpect,
      );
      await r.step(
        {
          action: "restoreEnroll",
          now: T0 + DAY + 60,
          note: "A day later, a check with the held id: this device's live key, 200 current.",
          args: { restoreId: enrolled.restoreId },
        },
        async (s) => {
          const res = await enrolCall(s, enrolled.restoreId);
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ status: "current" });
        },
        { result: "current" },
      );
      await r.step(
        {
          action: "restoreEnroll",
          now: T0 + 91 * DAY,
          note: "Past 90 days the key is no longer current: a new key replaces it (201).",
          args: { restoreId: enrolled.restoreId },
        },
        async (s) => {
          const res = await enrolCall(s, enrolled.restoreId);
          expect(res.status).toBe(201);
          const j = (await res.json()) as { restoreId: string; secret: string };
          expect(j.restoreId).not.toBe(enrolled.restoreId);
          rotatedExpect.restoreId = j.restoreId;
          rotatedExpect.secret = j.secret;
        },
        rotatedExpect,
      );
      return r.transcript();
    }),
};

export const restoreConfirm: Scenario = {
  id: "restore-confirm",
  record: () =>
    pinned("restore-confirm", async (pin) => {
      const { w, ada } = await restoreWorld({ consented: false });
      const key = await enrolledKey(w, ada, OLD);
      const r = recorder(
        w,
        pin,
        "restore-confirm",
        "A restore for a person who has not consented to this app yet (WIRE-CONTRACT-V5 §12.11.8, §12.11.3 rule 1). The grant answers status confirm instead of a token: a pending sign-in grant (300 s, bound to the device) and the consent view, whose as is {provider: null, email: null} because a restore proves a key, not a provider token. The key is used up and nothing is bound. The SDK shows the consent, then completes with choice/complete {grant, consent {claims}}; the answer is the device token with the scope the person kept.",
      );
      let pending = "";
      const view: Json = { result: "confirm" };
      await redeem(
        r,
        { key },
        (a) => {
          expect(a.res.status).toBe(200);
          pending = confirmed(a.json, view);
          expect((a.json.consent as { as: unknown }).as).toEqual({
            provider: null,
            email: null,
          });
        },
        view,
      );
      await keptBothClaims(r, pending);
      return r.transcript();
    }),
};

// ── the refusals ──────────────────────────────────────────────────────────────────────────────

export const restoreErrors: Scenario = {
  id: "restore-errors",
  record: () =>
    pinned("restore-errors", async (pin) => {
      const { w, ada } = await restoreWorld();
      // The product that gets another product's key.
      await seedProduct(w.db, OTHER);
      await setServices(
        w.db,
        OTHER,
        serializeServices({ services: servicesOn("config", "identity") }),
        "manifest",
        T0,
      );
      const good = await enrolledKey(w, ada, OLD);
      const agreeTaken = await enrolledKey(w, ada, OLD2);
      const unbound = await enrolledKey(w, ada, OLD3);
      const capped = await enrolledKey(w, ada, OLD4);
      // Another device of the product already holds the agreement key this client will send.
      const taken = fixtureDeviceKeys(TAKEN_LABEL);
      await upsertDeviceKeys(
        w.db,
        PRODUCT,
        HOLDER,
        {
          signKey: fixtureDeviceKeys("transcript-restore-holder").signKey,
          agreeKey: taken.agreeKey,
        },
        ENROLLED,
      );
      const r = recorder(
        w,
        pin,
        "restore-errors",
        "Every way a restore is refused (WIRE-CONTRACT-V5 §12.11.8). The grant answers the SAME 400 invalid_grant, byte for byte, whichever check failed: a wrong secret, an id nobody issued, a proof that is not the key's, a key of another product presented with that product's name (the key is NOT used up), an agreement key another device of the product holds, a key whose enrolling device is no longer signed in, and a key already used. A device that holds a token but is not signed in cannot enrol: 403 account_required. The key that was refused for another product's sake still works afterwards. Past a person's 5 restores a day the answer is 429 rate_limited with retryAfter 86400, and the key it was presented with is used up. No refusal names the check that failed; the client falls to the next rung.",
      );
      const bodies: string[] = [];
      const invalid = (a: Redeemed) => {
        expect(a.res.status).toBe(400);
        expect(codeOf(a.json)).toBe("invalid_grant");
        bodies.push(a.text);
      };
      const refused = (
        note: string,
        o: Omit<RedeemOptions, "note" | "now">,
        n: number,
      ) =>
        redeem(r, { ...o, note, now: T0 + n * 120 }, invalid, {
          ...refusedGrant("invalid_grant"),
        });

      await refused(
        "A wrong secret of the right shape.",
        { key: { restoreId: good.restoreId, secret: `rs_${"A".repeat(43)}` } },
        1,
      );
      await refused(
        "An id nobody issued.",
        { key: { restoreId: `rk_${"A".repeat(22)}`, secret: good.secret } },
        2,
      );
      await refused(
        "A proof that covers something other than <restore_id>.<device_key>.",
        { key: good, proofValue: `${good.restoreId}.${"A".repeat(43)}` },
        3,
      );
      await refused(
        "The right key and secret, presented to another product: refused, and not used up.",
        { key: good, product: OTHER },
        4,
      );
      await refused(
        "An agreement key another device of the product holds.",
        { key: agreeTaken, keyLabel: TAKEN_LABEL },
        5,
      );
      // The enrolling device was cleared by a deletion no revocation hook saw.
      await w.db.run(
        "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
        PRODUCT,
        OLD3,
      );
      await refused(
        "The device that enrolled the key is no longer signed in.",
        { key: unbound },
        6,
      );
      await redeem(
        r,
        {
          key: good,
          capture: true,
          now: T0 + 7 * 120,
          note: "The key that other product refused was not used up: it signs the device in.",
        },
        (a) => expect(a.res.status).toBe(200),
        OK_TOKEN,
      );
      await refused("The same key again: used.", { key: good }, 8);
      // The person signs out on the device by a deletion no hook saw: it keeps its token.
      await w.db.run(
        "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      );
      await enrolRefused(
        r,
        T0 + 8 * 120 + 60,
        "The device holds a token but is not signed in: no account to enrol for.",
      );
      // The person has now redeemed 2 keys today (the agreement-key refusal counted: the key was
      // proven and used up first). Three more fill the 5-a-day cap.
      for (let i = 0; i < 3; i += 1)
        expect(
          await rateLimitOk(
            w.env,
            PRODUCT,
            { ...RESTORE_ACCOUNT_RATE, id: ada.id },
            T0 + 9 * 120,
          ),
        ).toBe(true);
      await redeem(
        r,
        {
          key: capped,
          now: T0 + 9 * 120,
          note: "The person's sixth restore of the day.",
        },
        (a) => {
          expect(a.res.status).toBe(429);
          expect(codeOf(a.json)).toBe("rate_limited");
          expect(a.json.retryAfter).toBe(86_400);
        },
        { ...refusedGrant("rate_limited", 429), retryAfter: 86_400 },
      );
      for (const b of bodies) expect(b).toBe(bodies[0]);
      return r.transcript();
    }),
};

// ── sign-out ──────────────────────────────────────────────────────────────────────────────────

export const restoreSignout: Scenario = {
  id: "restore-signout",
  record: () =>
    pinned("restore-signout", async (pin) => {
      const { w, ada } = await restoreWorld();
      // Another device of the person (B) holds a key under the same subject; the client is A.
      const b = await enrolledKey(w, ada, OLD);
      const token = await signedInDevice(w, ada);
      const r = recorder(
        w,
        pin,
        "restore-signout",
        "Sign-out and the restore key (WIRE-CONTRACT-V5 §12.3 rule 5, §12.11.8). Device A is signed in and its backup item is shared with the person's device B, so the item holds B's key id. A's check with B's id is not current for A (a key of another device never is): a new key is minted (201) and replaces A's own. A signs out; the Worker deletes A's key in the same request, so A's secret is refused afterwards (400 invalid_grant), and a signed-out device cannot enrol (403 account_required). B's key is B's own and is not touched.",
        { token },
      );
      const firstExpect: Json = { result: "enrolled" };
      let mine = { restoreId: "", secret: "" };
      await r.step(
        {
          action: "restoreEnroll",
          note: "The item holds B's id: not this device's key, so a new key (201).",
          args: { restoreId: b.restoreId },
        },
        async (s) => {
          const res = await enrolCall(s, b.restoreId);
          expect(res.status).toBe(201);
          mine = (await res.json()) as typeof mine;
          expect(mine.restoreId).not.toBe(b.restoreId);
          firstExpect.restoreId = mine.restoreId;
          firstExpect.secret = mine.secret;
        },
        firstExpect,
      );
      await r.step(
        {
          action: "restoreEnroll",
          now: T0 + 60,
          note: "The item now holds A's id: 200 current.",
          args: { restoreId: mine.restoreId },
        },
        async (s) => {
          const res = await enrolCall(s, mine.restoreId);
          expect(res.status).toBe(200);
        },
        { result: "current" },
      );
      await r.step(
        {
          action: "signOut",
          now: T0 + 120,
          note: "A signs out. The Worker deletes A's restore key before it answers.",
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/identity/signout`,
            bearer: "token",
          });
          expect(res.status).toBe(200);
        },
        { released: false, tokenHeld: true },
      );
      await redeem(
        r,
        {
          key: mine,
          now: T0 + 240,
          note: "A's old secret, after the sign-out: refused. The key is gone.",
        },
        (a) => {
          expect(a.res.status).toBe(400);
          expect(codeOf(a.json)).toBe("invalid_grant");
        },
        refusedGrant("invalid_grant"),
      );
      await enrolRefused(
        r,
        T0 + 300,
        "A is no longer signed in: nothing to enrol for.",
      );
      return r.transcript();
    }),
};

// ── gate off ──────────────────────────────────────────────────────────────────────────────────

const GATE_OFF = (w: World) => {
  (w.env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_RESTORE = "off";
};

export const restoreGateOff: Scenario = {
  id: "restore-gate-off",
  record: () =>
    pinned("restore-gate-off", async (pin) => {
      const { w, ada } = await restoreWorld();
      const key = await enrolledKey(w, ada, OLD);
      const token = await signedInDevice(w, ada);
      const r = recorder(
        w,
        pin,
        "restore-gate-off",
        "Silent restore with the platform launch gate off (LG-1, launch.identityRestore; WIRE-CONTRACT-V5 §12.11.8 Gates). A client whose discovery is from before the gate went off still names restore. The grant now answers 400 unsupported_grant_type before anything is read, so the key is not used up; enrolling answers 404 not_found, which the client reads as unavailable; DELETE restore still answers 204, because a revocation is never gated. A client that fetches discovery afterwards finds no restore member and sends nothing.",
        { token },
      );
      await discoverStep(r, true, "Discovery from before the gate went off.");
      GATE_OFF(w);
      await redeem(
        r,
        { key, note: "The grant is unsupported: a refusal, nothing consumed." },
        (a) => {
          expect(a.res.status).toBe(400);
          expect(a.json.error).toBe("unsupported_grant_type");
        },
        refusedGrant("unsupported_grant_type"),
      );
      await enrol(
        r,
        { now: T0 + 60, note: "Enrolling is gone: unavailable." },
        (res, json) => {
          expect(res.status).toBe(404);
          expect(codeOf(json)).toBe("not_found");
        },
        { result: "unavailable" },
      );
      await r.step(
        {
          action: "restoreDelete",
          now: T0 + 120,
          note: "A revocation is never gated: 204.",
        },
        async (s) => {
          const res = await s.send({
            method: "DELETE",
            path: RESTORE,
            bearer: "token",
          });
          expect(res.status).toBe(204);
        },
        { result: "ok" },
      );
      await r.step(
        { action: "discover", now: T0 + 180, note: "Discovery afterwards." },
        async (s) => {
          const f = await identityFragment(s);
          expect(f.restore).toBeUndefined();
          expect(f.endpoint).toBeUndefined();
        },
        {
          result: "ok",
          services: services({ config: true, identity: true }),
          restore: false,
          restoreEndpoint: false,
        },
      );
      await r.step(
        {
          action: "restoreRedeem",
          now: T0 + 240,
          note: "Discovery names no restore: the client sends nothing.",
          args: redeemArgs({ key }),
        },
        async () => {},
        { result: "unavailable", tokenHeld: false },
      );
      return r.transcript();
    }),
};

export const RESTORE_SCENARIOS: Scenario[] = [
  discoveryIdentityRestore,
  restoreHappy,
  restoreConfirm,
  restoreErrors,
  restoreSignout,
  restoreGateOff,
];
