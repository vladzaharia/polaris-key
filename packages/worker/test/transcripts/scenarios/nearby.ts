/// <reference types="@cloudflare/workers-types" />
// Nearby approval (I-40, WIRE-CONTRACT-V5 §12.11.5, §12.11.6): a device with no way to sign in (D,
// the transcript's own device) is approved by a signed-in device nearby (M). Three calls, each with
// a `pkey-proof/1` proof: D's `start`, M's `approve`, D's `poll` (format.ts, "nearbyStart").
//
//   nearby-happy     start, a poll too early and one inside the 3 s interval, M approves (one
//                    free licence: bound with no tap), D's poll answers the token, once
//   nearby-choose    two free licences: approve answers `choose` and writes nothing, then M picks
//   nearby-denied    M denies; D's poll answers access_denied
//   nearby-errors    every refusal: not_nearby, the one invalid_grant, mismatched keys, a bad
//                    choice, an unknown request, and the timeout of a lapsed one
//   nearby-disabled  the product's `identity.nearby` off: discovery names nothing, so nothing is sent
//   nearby-gate-off  the launch gate goes off after discovery: the three routes are 404
//
// M is a device of the account that signed in earlier and registered its keys; setup writes both.
// Every key is a fixture derived from a label (`../providers.ts`), so the recorded bodies pin the
// proofs byte for byte. The clock steps: the Worker's poll slot is 3 seconds (Q13: the recorder
// also names each request's client network, which a replayer does not send).

import { expect } from "vitest";
import type { StepRecorder, World } from "../recorder.js";
import { discovery, T0 } from "../client.js";
import type { JsonValue } from "../format.js";
import { PRODUCT, servicesOn, productWorld, setup } from "../world.js";
import type { Scenario } from "../world.js";
import { fixtureDeviceKeys } from "../providers.js";
import { seedLicenseWithKey } from "../../seed.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { recorder } from "./exchange.js";
import { pinned } from "../world.js";

type Json = Record<string, JsonValue>;

const FEATURES = ["identity.nearby"];
const D_LABEL = "transcript-nearby-d-1";
const M_LABEL = "transcript-nearby-m-1";
const OTHER_LABEL = "transcript-nearby-other-1";
/** M, the signed-in device nearby: a well-formed device id, not the transcript's own. */
const M_ID = "TRANSCRIPTAPPROVER00000000000001";
const NET = "198.51.100.7";
const ELSEWHERE = "203.0.113.9";
const PATH = `/${PRODUCT}/identity/nearby`;
const D_NAME = "Living-room console";
const INTERVAL = 3;
const TTL = 300;

interface NearbyWorld {
  w: World;
  mToken: string;
}

/** The product with Identity on, an account whose M holds keys and a token, and `free` licences
 *  of the account that still have a seat. */
async function nearbyWorld(
  free: number,
  on: Parameters<typeof servicesOn> = ["license", "config", "identity"],
): Promise<NearbyWorld> {
  const w = await productWorld(servicesOn(...on));
  w.env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  w.env.EMAIL = {
    send: async () => ({ messageId: "m" }),
  } as unknown as typeof w.env.EMAIL;
  const { key } = await seedLicenseWithKey(w.db, PRODUCT);
  const res = await setup(
    w,
    "POST",
    `/${PRODUCT}/license/activate`,
    { authorization: `Bearer ${key}`, "x-pkey-device": M_ID },
    T0,
  );
  expect(res.status).toBe(200);
  const mToken = ((await res.json()) as { token: string }).token;
  const r = await signIn(
    w.db,
    {
      emailVerified: true,
      email: "ada@example.com",
      kind: "email",
      subject: "ada@example.com",
      issuerKey: "email",
    },
    T0,
    { product: { slug: PRODUCT }, unfenced: true },
  );
  if (r.status !== "signed_in") throw new Error("setup sign-in");
  expect(await setDeviceSubject(w.env, w.db, PRODUCT, M_ID, r.subject!)).toBe(
    true,
  );
  const m = fixtureDeviceKeys(M_LABEL);
  await upsertDeviceKeys(
    w.db,
    PRODUCT,
    M_ID,
    { signKey: m.signKey, agreeKey: m.agreeKey },
    T0,
  );
  for (let i = 0; i < free; i++) {
    const id = `lic_nearby_${i}`;
    await seedLicenseWithKey(w.db, PRODUCT, { id });
    await w.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      r.account.id,
      PRODUCT,
      id,
    );
  }
  return { w, mToken };
}

/** The identity fragment's nearby members, read through a recorded discover step. */
async function discoverStep(
  s: StepRecorder,
  nearby: boolean,
): Promise<{ nearby: unknown; nearbyEndpoints: boolean }> {
  const res = await discovery(s, PRODUCT);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as {
    services: {
      identity: { nearby?: unknown; endpoints: Record<string, unknown> };
    };
  };
  const { nearby: flag, endpoints } = doc.services.identity;
  const named = ["nearbyStart", "nearbyApprove", "nearbyPoll"].map(
    (k) => endpoints[k] !== undefined,
  );
  expect(named.every((x) => x === nearby)).toBe(true);
  expect(flag).toBe(nearby ? true : undefined);
  return { nearby: flag, nearbyEndpoints: nearby };
}

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
const servicesExpect = (on: readonly string[]): Json =>
  Object.fromEntries(SERVICES.map((k) => [k, on.includes(k)]));

const refused = (status: number, code: string): Json => ({
  result: "refused",
  status,
  code,
});

type Rec = ReturnType<typeof recorder>;

function newRecorder(
  nw: NearbyWorld,
  pin: Parameters<typeof recorder>[1],
  id: string,
  description: string,
): Rec {
  return recorder(nw.w, pin, id, description, [], FEATURES);
}

/** A recorded discover step: the identity fragment names nearby approval, or does not. */
async function discoverNearby(
  r: Rec,
  nearby: boolean,
  note?: string,
): Promise<void> {
  await r.step(
    { action: "discover", ...(note ? { note } : {}) },
    async (s) => {
      await discoverStep(s, nearby);
    },
    {
      result: "ok",
      services: servicesExpect(["license", "config", "identity"]),
      nearby: nearby ? true : null,
      nearbyEndpoints: nearby,
    },
  );
}

/** One recorded call: the body is sent as is and asserted exactly; `expectation` maps the answer. */
async function call(
  r: Rec,
  o: {
    action: "nearbyStart" | "nearbyApprove" | "nearbyPoll";
    route: "start" | "approve" | "poll";
    note: string;
    args: Json;
    now?: number;
    body: Json;
    status: number;
    ip?: string;
    actor?: { deviceId: string; token: string };
    capture?: Record<string, string>;
  },
  expectation: (answer: Json) => Json,
): Promise<Json> {
  const exp: Json = {};
  let answer: Json = {};
  await r.step(
    {
      action: o.action,
      note: o.note,
      args: o.args,
      ...(o.now === undefined ? {} : { now: o.now }),
    },
    async (s) => {
      const res = await s.send({
        method: "POST",
        path: `${PATH}/${o.route}`,
        clientIp: o.ip ?? NET,
        ...(o.actor ? { actor: o.actor } : {}),
        body: o.body,
        expectBody: { json: o.body, match: "exact" },
        ...(o.capture ? { capture: o.capture } : {}),
      });
      expect(res.status).toBe(o.status);
      answer = (await res.json().catch(() => ({}))) as Json;
      Object.assign(exp, expectation(answer));
    },
    exp,
  );
  return answer;
}

/** D's `start`. Returns the handle the Worker answered ("" when refused). */
async function startStep(
  r: Rec,
  o: {
    note: string;
    now?: number;
    /** Sign the proof with these keys instead of D's. */
    proofLabel?: string;
  },
  status: number,
  expectation: (handle: string) => Json,
): Promise<string> {
  const d = fixtureDeviceKeys(D_LABEL);
  const body = {
    signKey: d.signKey,
    agreeKey: d.agreeKey,
    deviceName: D_NAME,
    proof: fixtureDeviceKeys(o.proofLabel ?? D_LABEL).proof({
      purpose: "nearby-start",
      product: PRODUCT,
      deviceId: r.bindings.deviceId!,
      value: `${d.signKey}.${d.agreeKey}`,
      token: null,
    }),
  };
  const a = await call(
    r,
    {
      action: "nearbyStart",
      route: "start",
      note: o.note,
      args: {
        keyLabel: D_LABEL,
        deviceName: D_NAME,
        ...(o.proofLabel ? { proofKeyLabel: o.proofLabel } : {}),
      },
      ...(o.now === undefined ? {} : { now: o.now }),
      body,
      status,
      ...(status === 201 ? { capture: { request: "$.request" } } : {}),
    },
    (x) => expectation((x.request as string | undefined) ?? ""),
  );
  return (a.request as string | undefined) ?? "";
}

interface ApproveOpts {
  note: string;
  request: string;
  now?: number;
  decision?: "approve" | "deny";
  choice?: Json;
  ip?: string;
  /** Sign with these keys instead of M's. */
  proofLabel?: string;
  /** Sign this value instead of the handle. */
  proofValue?: string;
  /** Send this label's agreement key instead of D's. */
  agreeLabel?: string;
  mToken: string;
}

/** M's `approve`. */
async function approveStep(
  r: Rec,
  o: ApproveOpts,
  status: number,
  expectation: (answer: Json) => Json,
): Promise<void> {
  const d = fixtureDeviceKeys(D_LABEL);
  const body = {
    request: o.request,
    deviceId: r.bindings.deviceId!,
    signKey: d.signKey,
    agreeKey: fixtureDeviceKeys(o.agreeLabel ?? D_LABEL).agreeKey,
    decision: o.decision ?? "approve",
    ...(o.choice ? { choice: o.choice } : {}),
    proof: fixtureDeviceKeys(o.proofLabel ?? M_LABEL).proof({
      purpose: "nearby-approve",
      product: PRODUCT,
      deviceId: M_ID,
      value: o.proofValue ?? o.request,
      token: null,
    }),
  };
  await call(
    r,
    {
      action: "nearbyApprove",
      route: "approve",
      note: o.note,
      args: {
        approverDeviceId: M_ID,
        approverToken: o.mToken,
        approverKeyLabel: M_LABEL,
        keyLabel: D_LABEL,
        decision: o.decision ?? "approve",
        request: o.request,
        ...(o.choice ? { choice: o.choice } : {}),
        ...(o.proofLabel ? { proofKeyLabel: o.proofLabel } : {}),
        ...(o.proofValue ? { proofValue: o.proofValue } : {}),
        ...(o.agreeLabel ? { agreeKeyLabel: o.agreeLabel } : {}),
      },
      ...(o.now === undefined ? {} : { now: o.now }),
      body,
      status,
      ...(o.ip ? { ip: o.ip } : {}),
      actor: { deviceId: M_ID, token: o.mToken },
    },
    expectation,
  );
}

/** D's `poll`. */
async function pollStep(
  r: Rec,
  o: { note: string; request: string; now: number; proofLabel?: string },
  status: number,
  expectation: (answer: Json) => Json,
  capture = false,
): Promise<void> {
  const body = {
    request: o.request,
    proof: fixtureDeviceKeys(o.proofLabel ?? D_LABEL).proof({
      purpose: "nearby-poll",
      product: PRODUCT,
      deviceId: r.bindings.deviceId!,
      value: o.request,
      token: null,
    }),
  };
  await call(
    r,
    {
      action: "nearbyPoll",
      route: "poll",
      note: o.note,
      args: {
        keyLabel: D_LABEL,
        request: o.request,
        ...(o.proofLabel ? { proofKeyLabel: o.proofLabel } : {}),
      },
      now: o.now,
      body,
      status,
      ...(capture ? { capture: { token: "$.access_token" } } : {}),
    },
    expectation,
  );
}

const STARTED = (handle: string): Json => {
  expect(handle).toMatch(/^nr_[A-Za-z0-9_-]{22}$/);
  return { result: "ok", expiresIn: TTL, interval: INTERVAL };
};

const READY = (a: Json): Json => {
  expect(typeof a.access_token).toBe("string");
  return {
    result: "ready",
    tokenHeld: true,
    scope: a.scope as string,
  };
};

// ── the conversations ─────────────────────────────────────────────────────────────────────────

export const nearbyHappy: Scenario = {
  id: "nearby-happy",
  record: () =>
    pinned("nearby-happy", async (pin) => {
      const nw = await nearbyWorld(1);
      const r = newRecorder(
        nw,
        pin,
        "nearby-happy",
        "Nearby approval, the quiet case (WIRE-CONTRACT-V5 §12.11.5). D, a device with no way to sign in, posts its signing and agreement keys with a pkey-proof/1 nearby-start proof and gets a request handle (nr_…, 300 s) and the poll interval (3 s). Its first poll is pending; a second inside the interval is 429 slow_down. M, a signed-in device of the account on the same network, posts approve with the handle, D's two keys and a nearby-approve proof by its own registered key: the account has exactly one licence with a free seat, so it is bound with no further tap and the answer names D's label. D's next poll, after the interval, answers the device token once (D never held a grant). Poll proofs are by the key D sent on start.",
      );
      await discoverNearby(r, true, "Discovery names nearby approval.");
      const h = await startStep(
        r,
        { note: "D asks to be approved.", now: T0 },
        201,
        STARTED,
      );
      await pollStep(
        r,
        { note: "Nobody has decided yet.", request: h, now: T0 + 1 },
        200,
        () => ({ result: "pending" }),
      );
      await pollStep(
        r,
        { note: "Inside the interval.", request: h, now: T0 + 2 },
        429,
        (a) => {
          expect(a).toEqual({ status: "slow_down", interval: INTERVAL });
          return { result: "slow-down", interval: INTERVAL };
        },
      );
      await approveStep(
        r,
        {
          note: "M approves: the only free licence is bound.",
          request: h,
          now: T0 + 5,
          mToken: nw.mToken,
        },
        200,
        (a) => {
          expect(a.status).toBe("approved");
          return {
            result: "approved",
            deviceLabel: a.deviceLabel as string,
          };
        },
      );
      await pollStep(
        r,
        { note: "D collects its token.", request: h, now: T0 + 8 },
        200,
        READY,
        true,
      );
      await pollStep(
        r,
        { note: "The token is handed over once.", request: h, now: T0 + 12 },
        200,
        (a) => {
          expect(a).toEqual({ status: "timeout" });
          return { result: "timeout" };
        },
      );
      return r.transcript();
    }),
};

export const nearbyChoose: Scenario = {
  id: "nearby-choose",
  record: () =>
    pinned("nearby-choose", async (pin) => {
      const nw = await nearbyWorld(2);
      const r = newRecorder(
        nw,
        pin,
        "nearby-choose",
        "Nearby approval when a licence choice is due (WIRE-CONTRACT-V5 §12.11.5 rules 6 and 7). The account has two licences with a free seat, so the first approve answers 200 choose with the candidates and writes nothing: D's poll stays pending and the request stays open. M approves again with choice {kind:license, licenseId}, which binds that licence, and D's poll answers the token.",
      );
      const h = await startStep(
        r,
        { note: "D asks to be approved.", now: T0 },
        201,
        STARTED,
      );
      let licenseId = "";
      await approveStep(
        r,
        {
          note: "Two licences have a free seat: M is asked to choose.",
          request: h,
          now: T0 + 1,
          mToken: nw.mToken,
        },
        200,
        (a) => {
          expect(a.status).toBe("choose");
          const view = a.choices as unknown as { choices: { id: string }[] };
          expect(view.choices.length).toBe(2);
          licenseId = view.choices[0]!.id;
          return { result: "choose", choices: a.choices as JsonValue };
        },
      );
      await pollStep(
        r,
        { note: "Nothing was written.", request: h, now: T0 + 2 },
        200,
        () => ({ result: "pending" }),
      );
      await approveStep(
        r,
        {
          note: "M picks a licence.",
          request: h,
          now: T0 + 3,
          choice: { kind: "license", licenseId },
          mToken: nw.mToken,
        },
        200,
        (a) => {
          expect(a.status).toBe("approved");
          return { result: "approved", deviceLabel: a.deviceLabel as string };
        },
      );
      await pollStep(
        r,
        { note: "D collects its token.", request: h, now: T0 + 6 },
        200,
        READY,
        true,
      );
      return r.transcript();
    }),
};

export const nearbyDenied: Scenario = {
  id: "nearby-denied",
  record: () =>
    pinned("nearby-denied", async (pin) => {
      const nw = await nearbyWorld(1);
      const r = newRecorder(
        nw,
        pin,
        "nearby-denied",
        "Nearby approval that M refuses (WIRE-CONTRACT-V5 §12.11.5 rule 6). M posts decision deny and gets 204 with no body. The denial is final for the request: D's poll answers {status:error, reason:access_denied}, as the device code does (§12.10), and a later approve of the same request is 404 not_found.",
      );
      const h = await startStep(
        r,
        { note: "D asks to be approved.", now: T0 },
        201,
        STARTED,
      );
      await approveStep(
        r,
        {
          note: "M refuses.",
          request: h,
          now: T0 + 1,
          decision: "deny",
          mToken: nw.mToken,
        },
        204,
        () => ({ result: "denied" }),
      );
      await pollStep(
        r,
        { note: "D is told.", request: h, now: T0 + 4 },
        200,
        (a) => {
          expect(a).toEqual({ status: "error", reason: "access_denied" });
          return { result: "error", reason: "access_denied" };
        },
      );
      await approveStep(
        r,
        {
          note: "The decision is final.",
          request: h,
          now: T0 + 5,
          mToken: nw.mToken,
        },
        404,
        () => refused(404, "not_found"),
      );
      return r.transcript();
    }),
};

export const nearbyErrors: Scenario = {
  id: "nearby-errors",
  record: () =>
    pinned("nearby-errors", async (pin) => {
      const nw = await nearbyWorld(1);
      const r = newRecorder(
        nw,
        pin,
        "nearby-errors",
        "The refusals of the nearby routes (WIRE-CONTRACT-V5 §12.11.5). A start whose proof is by another key is 400 invalid_grant, the one body of every proof failure. On a live request: an approve from another client network is 403 not_nearby and leaves it open; a proof that does not cover the handle or is by another key is 400 invalid_grant; an agreement key that is not D's is 404 not_found, the unknown-request answer, and counts against the request; a choice of another kind is 400 bad_request; a handle nobody started is 404. D's poll with another key's proof is 400 invalid_grant, a poll for an unknown handle is {status:timeout}, and so is a poll after the 300 s the request is held.",
      );
      await startStep(
        r,
        { note: "A proof by another key.", now: T0, proofLabel: OTHER_LABEL },
        400,
        () => refused(400, "invalid_grant"),
      );
      const h = await startStep(
        r,
        { note: "D asks to be approved.", now: T0 + 1 },
        201,
        STARTED,
      );
      const base = { request: h, mToken: nw.mToken };
      await approveStep(
        r,
        {
          ...base,
          note: "M is not on D's network.",
          now: T0 + 2,
          ip: ELSEWHERE,
        },
        403,
        () => refused(403, "not_nearby"),
      );
      await approveStep(
        r,
        {
          ...base,
          note: "A proof by a key that is not M's.",
          now: T0 + 3,
          proofLabel: OTHER_LABEL,
        },
        400,
        () => refused(400, "invalid_grant"),
      );
      await approveStep(
        r,
        {
          ...base,
          note: "A proof over another value.",
          now: T0 + 4,
          proofValue: "nr_BBBBBBBBBBBBBBBBBBBBBB",
        },
        400,
        () => refused(400, "invalid_grant"),
      );
      await approveStep(
        r,
        {
          ...base,
          note: "Keys that are not the ones D started with.",
          now: T0 + 5,
          agreeLabel: OTHER_LABEL,
        },
        404,
        () => refused(404, "not_found"),
      );
      await approveStep(
        r,
        {
          ...base,
          note: "Replace is not offered.",
          now: T0 + 6,
          choice: { kind: "replace" },
        },
        400,
        () => refused(400, "bad_request"),
      );
      const unknown = "nr_CCCCCCCCCCCCCCCCCCCCCC";
      await approveStep(
        r,
        {
          note: "A handle nobody started.",
          request: unknown,
          now: T0 + 7,
          mToken: nw.mToken,
        },
        404,
        () => refused(404, "not_found"),
      );
      await pollStep(
        r,
        {
          note: "A poll proof by another key.",
          request: h,
          now: T0 + 8,
          proofLabel: OTHER_LABEL,
        },
        400,
        () => refused(400, "invalid_grant"),
      );
      await pollStep(
        r,
        { note: "A handle nobody started.", request: unknown, now: T0 + 9 },
        200,
        () => ({ result: "timeout" }),
      );
      await pollStep(
        r,
        { note: "The request lapsed.", request: h, now: T0 + TTL + 5 },
        200,
        () => ({ result: "timeout" }),
      );
      return r.transcript();
    }),
};

/** The `unavailable` step: the last discovery names no nearby member, so the client sends nothing. */
async function unavailable(
  r: Rec,
  action: "nearbyStart" | "nearbyPoll",
  note: string,
): Promise<void> {
  await r.step(
    { action, note, args: { keyLabel: D_LABEL, deviceName: D_NAME } },
    async () => {},
    { result: "unavailable" },
  );
}

export const nearbyDisabled: Scenario = {
  id: "nearby-disabled",
  record: () =>
    pinned("nearby-disabled", async (pin) => {
      const nw = await nearbyWorld(1);
      await nw.w.db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES (?, 'identity.nearby', 'false', 'manifest', ?, 'resync')`,
        PRODUCT,
        T0,
      );
      const r = newRecorder(
        nw,
        pin,
        "nearby-disabled",
        "A product that switched nearby approval off (identity.nearby, WIRE-CONTRACT-V5 §12.11.5 rule 13). Discovery names neither the nearby member nor the three endpoints, so a client sends nothing: the request is unavailable and the app starts at the regular sign-in.",
      );
      await discoverNearby(r, false, undefined);
      await unavailable(
        r,
        "nearbyStart",
        "No nearby member in discovery: the client sends nothing.",
      );
      return r.transcript();
    }),
};

export const nearbyGateOff: Scenario = {
  id: "nearby-gate-off",
  record: () =>
    pinned("nearby-gate-off", async (pin) => {
      const nw = await nearbyWorld(1);
      const r = newRecorder(
        nw,
        pin,
        "nearby-gate-off",
        "The launch gate going off (launch.identityNearby, WIRE-CONTRACT-V5 §12.11.5 rule 13, §12.11.6). A client fetches discovery while the gate is on, so it names nearby approval. The gate then goes off: start and approve are 404 not_found, which the client reads as unavailable, and a fresh discovery names nothing, so the next request is not sent.",
      );
      await discoverNearby(r, true, "Gate on: the members are named.");
      (nw.w.env as unknown as Record<string, unknown>).LAUNCH_IDENTITY_NEARBY =
        "off";
      const d = fixtureDeviceKeys(D_LABEL);
      const startBody = {
        signKey: d.signKey,
        agreeKey: d.agreeKey,
        deviceName: D_NAME,
        proof: d.proof({
          purpose: "nearby-start",
          product: PRODUCT,
          deviceId: r.bindings.deviceId!,
          value: `${d.signKey}.${d.agreeKey}`,
          token: null,
        }),
      };
      await r.step(
        {
          action: "nearbyStart",
          note: "Gate off after discovery: 404, the client reads unavailable.",
          args: { keyLabel: D_LABEL, deviceName: D_NAME },
        },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: `${PATH}/start`,
            clientIp: NET,
            body: startBody,
            expectBody: { json: startBody, match: "exact" },
          });
          expect(res.status).toBe(404);
        },
        { result: "unavailable" },
      );
      await approveStep(
        r,
        {
          note: "M's approve is 404 too.",
          request: "nr_DDDDDDDDDDDDDDDDDDDDDD",
          mToken: nw.mToken,
        },
        404,
        () => ({ result: "unavailable" }),
      );
      await discoverNearby(r, false, "A fresh discovery names nothing.");
      await unavailable(
        r,
        "nearbyPoll",
        "No nearby member in discovery: the client sends nothing.",
      );
      return r.transcript();
    }),
};

export const NEARBY_SCENARIOS: Scenario[] = [
  nearbyHappy,
  nearbyChoose,
  nearbyDenied,
  nearbyErrors,
  nearbyDisabled,
  nearbyGateOff,
];
