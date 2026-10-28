/// <reference types="@cloudflare/workers-types" />
// The link offer (I-43.2, WIRE-CONTRACT-V5 §12.11.4): after the regular sign-in an app offers to
// add the person's Google or Apple identity to the account, so the next launch signs in silently.
//
//   link-offer   a handle from a token exchange that found no link, a redirect sign-in (the
//                same-device sign-in that earns the step-up), `GET link`, then `POST link` with the
//                handle: first with the step-up gone stale, then with a fresh sign-in.
//   link-errors  `step_up_required`, `link_conflict`, the handle's `not_found` and `invalid_grant`.
//
// The device already holds its keys (an earlier sign-in or exchange registered them), so setup
// writes them. The Apple token is the platform's, so the handle comes from the recorded `exchange`
// step; the browser's half of the redirect sign-in is recorded as `browser` steps. The link steps
// are `linkOffer` and `link` (format.ts).

import { expect } from "vitest";
import { TranscriptRecorder, type StepRecorder } from "../recorder.js";
import { T0 } from "../client.js";
import type { JsonValue } from "../format.js";
import { pinned, PRODUCT, type Scenario } from "../world.js";
import { fixtureDeviceKeys } from "../providers.js";
import { DEVICE } from "../client.js";
import { seedAccount } from "./account.js";
import { portalSession, registerWebApp, WEB_CALLBACK } from "./webSignIn.js";
import {
  authorizePath,
  binderOf,
  codeOfRedirect,
  handleOf,
  navigate,
  press,
  token,
} from "./redirect.js";
import {
  apple,
  exchangeStep,
  exchangeWorld,
  KEY_LABEL,
  recorder,
} from "./exchange.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import type { World } from "../recorder.js";

type Json = Record<string, JsonValue>;

const FEATURES = ["identity.link"];
const LINK = `/${PRODUCT}/identity/link`;
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";
const STATE = "tidewater-state-0123456789";
const APPLE_SUB = "a-sub-1";
const TEAM = "ABCDE12345";
/** A handle that names nothing: well formed, never issued. */
const UNKNOWN_HANDLE = `lh_${"A".repeat(43)}`;
/** Later than the 300 s step-up of the sign-in at T0, earlier than the handle's 600 s. */
const LATER = T0 + 400;

async function linkWorld(): Promise<{
  w: World;
  who: { cookie: string; csrf: string };
}> {
  const w = await exchangeWorld(["config", "identity"]);
  await registerWebApp(w);
  const ada = await seedAccount(w, "ada@example.com");
  const who = await portalSession(w, { id: ada.id, email: "ada@example.com" });
  return { w, who };
}

type Rec = TranscriptRecorder;

/** The device registers its keys once it is signed in (the exchange or the SDK's first call). */
async function holdKeys(w: World): Promise<void> {
  const keys = fixtureDeviceKeys(KEY_LABEL);
  await upsertDeviceKeys(
    w.db,
    PRODUCT,
    DEVICE,
    { signKey: keys.signKey, agreeKey: keys.agreeKey },
    T0,
  );
}

/** The exchange step that finds no link for the Apple identity and answers a handle. */
async function handleStep(r: Rec): Promise<string> {
  let handle = "";
  await exchangeStep(
    r,
    {
      kind: "apple",
      mint: apple(),
      note: "No account links this Apple identity: the answer carries the link handle.",
    },
    (a) => {
      expect(a.grant!.status).toBe(403);
      handle = a.json.linkHandle as string;
    },
    { result: "interstitial-required" },
  );
  return handle;
}

/** The redirect sign-in as the browser and the SDK make it: authorize, Continue, token. The
 *  token response binds `{token}` for the link steps that follow. */
async function signInSteps(
  r: Rec,
  who: { cookie: string; csrf: string },
  o: { now?: number; bearer?: boolean } = {},
): Promise<void> {
  const now = o.now;
  const at = now === undefined ? {} : { now };
  let binder = "";
  let handle = "";
  let redirect = "";
  await r.step(
    {
      action: "browser",
      note: "The app sends the person's browser to authorize.",
      args: { state: STATE, redirectUri: WEB_CALLBACK, codeVerifier: VERIFIER },
      ...at,
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
      note: "Continue to the app: the sign-in on this device is the step-up.",
      ...at,
    },
    async (s) => {
      const res = await press(s, who, binder, handle, "continue");
      expect(res.status).toBe(200);
      redirect = ((await res.json()) as { redirect: string }).redirect;
    },
    { navigated: "app" },
  );
  const args: Json = { callbackUrl: "", codeVerifier: VERIFIER, state: STATE };
  await r.step(
    {
      action: "redirectComplete",
      note: "The SDK redeems the code; the device token it holds is the bearer of the link calls.",
      args,
      ...at,
    },
    async (s) => {
      args.callbackUrl = redirect;
      const res = await token(s, codeOfRedirect(redirect), VERIFIER, {
        ...(o.bearer ? { bearer: "token" as const } : {}),
        capture: { token: "$.access_token" },
      });
      expect(res.status).toBe(200);
    },
    { result: "ok", scope: "profile email", tokenHeld: true },
  );
}

function newRecorder(
  w: World,
  pin: Parameters<typeof recorder>[1],
  id: string,
  description: string,
): Rec {
  return recorder(w, pin, id, description, ["config", "identity"], FEATURES);
}

/** `GET link`: the kinds the person could add. */
async function offerStep(
  r: Rec,
  note: string,
  now: number | undefined,
  want: { kind: string; reach: null }[],
): Promise<void> {
  await r.step(
    { action: "linkOffer", note, ...(now === undefined ? {} : { now }) },
    async (s) => {
      const res = await s.send({ method: "GET", path: LINK, bearer: "token" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ offer: want });
    },
    { result: "ok", offer: want as unknown as JsonValue },
  );
}

/** `POST link` with the handle. `proofOver` signs another value (a proof that is not the
 *  handle's). `check` asserts the Worker's answer as an ordinary test. */
async function linkStep(
  r: Rec,
  o: {
    note: string;
    handle: string;
    proofOver?: string;
    now?: number;
  },
  status: number,
  expectation: Json,
): Promise<void> {
  const keys = fixtureDeviceKeys(KEY_LABEL);
  const args: Json = {
    linkHandle: o.handle,
    keyLabel: KEY_LABEL,
    ...(o.proofOver ? { proofValue: o.proofOver } : {}),
  };
  const body = {
    linkHandle: o.handle,
    proof: keys.proof({
      purpose: "link",
      product: PRODUCT,
      deviceId: DEVICE,
      value: o.proofOver ?? o.handle,
      token: null,
    }),
  };
  await r.step(
    {
      action: "link",
      note: o.note,
      args,
      ...(o.now === undefined ? {} : { now: o.now }),
    },
    async (s: StepRecorder) => {
      const res = await s.send({
        method: "POST",
        path: LINK,
        bearer: "token",
        body,
        expectBody: { json: body, match: "exact" },
      });
      expect(res.status).toBe(status);
    },
    expectation,
  );
}

const LINKED_APPLE: Json = {
  result: "ok",
  linked: { kind: "apple", reach: "developer" },
};
const refusal = (code: string, status: number): Json => ({
  result: "refused",
  status,
  code,
});

export const linkOffer: Scenario = {
  id: "link-offer",
  record: () =>
    pinned("link-offer", async (pin) => {
      const { w, who } = await linkWorld();
      const r = newRecorder(
        w,
        pin,
        "link-offer",
        "The link offer after a redirect sign-in (I-43.2, WIRE-CONTRACT-V5 §12.11.4). A token exchange found no link for the person's Apple identity and answered a link handle. The person then signs in on this device through the browser (authorize, Continue, token): that same-device sign-in leaves a step-up that lasts 300 s. GET link, with the device token, names the kinds the person could add (reach null until a link is made). A POST link carrying the handle and a pkey-proof/1 link proof by the device's key, sent after the step-up went stale, is 401 step_up_required and leaves the handle where it is. After a fresh sign-in the same POST answers linked {kind, reach}: an Apple link is scoped to the developer's team. The link spends the step-up, so the offer is empty afterwards.",
      );
      const handle = await handleStep(r);
      await signInSteps(r, who);
      await holdKeys(w);
      await offerStep(r, "The offer names both kinds.", undefined, [
        { kind: "google", reach: null },
        { kind: "apple", reach: null },
      ]);
      await linkStep(
        r,
        {
          note: "The step-up went stale: nothing is spent and the handle stays.",
          handle,
          now: LATER,
        },
        401,
        refusal("step_up_required", 401),
      );
      await signInSteps(r, who, { now: LATER + 10, bearer: true });
      await linkStep(
        r,
        { note: "A fresh sign-in: the link is made.", handle, now: LATER + 10 },
        200,
        LINKED_APPLE,
      );
      await offerStep(
        r,
        "The link spent the step-up: the offer is empty.",
        LATER + 10,
        [],
      );
      return r.transcript();
    }),
};

export const linkErrors: Scenario = {
  id: "link-errors",
  record: () =>
    pinned("link-errors", async (pin) => {
      const { w, who } = await linkWorld();
      const r = newRecorder(
        w,
        pin,
        "link-errors",
        "The refusals of POST link (I-43.2, WIRE-CONTRACT-V5 §12.11.4), after a fresh sign-in. A handle nobody issued is 404 not_found and spends nothing. A proof that does not cover the handle is 400 invalid_grant, the one refusal of every proof, key and binding check, and leaves the handle. The right request, for an Apple identity another account now holds, is 409 link_conflict: nothing moves, and the step-up and the handle are spent. The same request again is 401 step_up_required.",
      );
      const handle = await handleStep(r);
      await signInSteps(r, who);
      await holdKeys(w);
      await linkStep(
        r,
        { note: "A handle nobody issued.", handle: UNKNOWN_HANDLE },
        404,
        refusal("not_found", 404),
      );
      await linkStep(
        r,
        {
          note: "A proof over another value.",
          handle,
          proofOver: UNKNOWN_HANDLE,
        },
        400,
        refusal("invalid_grant", 400),
      );
      // Another account links the same Apple identity before the person's request lands.
      const other = await signIn(
        w.db,
        {
          issuerKey: "https://appleid.apple.com",
          tenantScope: `apple-team:${TEAM}`,
          subject: APPLE_SUB,
          kind: "apple",
          email: "grace@example.com",
          emailVerified: false,
        },
        T0,
        {
          unfenced: true,
          product: { slug: PRODUCT, tenantScopes: [`apple-team:${TEAM}`] },
        },
      );
      expect(other.status).toBe("signed_in");
      await linkStep(
        r,
        { note: "The identity belongs to another account.", handle },
        409,
        refusal("link_conflict", 409),
      );
      await linkStep(
        r,
        { note: "The step-up is spent.", handle },
        401,
        refusal("step_up_required", 401),
      );
      return r.transcript();
    }),
};

export const LINK_SCENARIOS: Scenario[] = [linkOffer, linkErrors];
