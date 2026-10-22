/// <reference types="@cloudflare/workers-types" />
// The licence choice at sign-in (I-08b; WIRE-CONTRACT-V4 §12.4.1, §12.5.1; plans/I-04.md §C, §G):
// what a web app's SDK and the person's browser exchange with the Worker when the account holds
// licences, the choice is made on the card or in the app, a device is replaced, or a key is typed.
//
//   redirect-web-choose      the card lists two licences; Continue without a choice is refused;
//                            the person picks one; the SDK redeems the code and is on that licence.
//   redirect-web-choose-app  license_choice=app: the card has no choice step; token answers
//                            `choose` with a grant; the SDK reads the licences and completes.
//   choice-replace-app       a full licence: the SDK lists its devices, completes with
//                            replaceDeviceId and is on the licence; the old device is signed out.
//   choice-key-app           the no-licence state: the SDK enters a key; the answer carries
//                            `keyEntries` (exactly one app key entry).
//   choice-grant-errors      every refusal of the grant routes.
//
// `browser` steps are the requests the SDK never makes. The SDK's calls are `redirectComplete`
// (its `result` is "choose" when the exchange answers a grant) and `choiceLicenses`,
// `choiceDevices`, `choiceComplete` and `choiceCancel` (`choice.*`, plans/I-04.md §G.9). The
// grant is pinned by the seeded random stream, so the recorded value is the replayed one.

import { expect } from "vitest";
import {
  TranscriptRecorder,
  type StepRecorder,
  type World,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import type { JsonValue } from "../format.js";
import { activated, pinned, PRODUCT, setup, type Scenario } from "../world.js";
import { seedLicenseWithKey } from "../../seed.js";
import { holdLicense } from "./account.js";
import { KEY_ENTRY_LIMIT_DEFAULT } from "../../../src/core/settings/platform.js";
import {
  authorizePath,
  binderOf,
  codeOfRedirect,
  handleOf,
  navigate,
  press,
  token,
  world,
} from "./redirect.js";

const CALLBACK = "https://app.example/auth/callback";
const STATE = "tidewater-state-0123456789";
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";
const OTHER = "OTHER0DEVICE00000000000000000001";

type Who = Awaited<ReturnType<typeof world>>;
type Json = Record<string, JsonValue>;

/** A licence for the account (limit seats), with its key; no email, so no sweep claims it. */
async function ownedLicense(
  w: World,
  who: Who,
  id: string,
  limit: number,
): Promise<{ licenseId: string; key: string }> {
  const seeded = await seedLicenseWithKey(w.db, PRODUCT, { id });
  await w.db.run(
    "UPDATE licenses SET email = NULL, device_limit = ? WHERE product = ? AND id = ?",
    limit,
    PRODUCT,
    id,
  );
  await holdLicense(w, id, who.accountId);
  return seeded;
}

/** Setup: another device takes a seat on the licence with its key. */
async function occupy(w: World, key: string, device = OTHER): Promise<void> {
  const res = await setup(w, "POST", `/${PRODUCT}/license/activate`, {
    authorization: `Bearer ${key}`,
    "x-pkey-device": device,
  });
  if (res.status !== 200) throw new Error(`setup occupy: ${res.status}`);
}

function cardGet(
  s: StepRecorder,
  who: Who,
  binder: string,
  path: string,
): Promise<Response> {
  return s.send({
    method: "GET",
    path,
    metadata: false,
    headers: { cookie: `${who.cookie}; ${binder}` },
  });
}

/** `POST /<p>/identity/choice/<action>`: JSON, the grant in the body, the device headers. */
function choicePost(
  s: StepRecorder,
  action: string,
  body: Json,
): Promise<Response> {
  return s.send({
    method: "POST",
    path: `/${PRODUCT}/identity/choice/${action}`,
    body,
    expectBody: { json: body, match: "exact" },
  });
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
    features: ["identity.choice"],
    requires: [],
    product: PRODUCT,
    now: T0,
    world: w,
    pinned: pin,
    initial: { deviceId: DEVICE, version: VERSION },
  });
}

/** authorize (card or app mode) and Continue, as the browser; returns the redirect. */
async function browserTo(
  r: TranscriptRecorder,
  who: Who,
  over: Record<string, string | null>,
  body: Json | undefined,
  note: string,
  expectStatus = 200,
): Promise<string> {
  let binder = "";
  let handle = "";
  let redirect = "";
  await r.step(
    {
      action: "browser",
      note: `${note} The browser goes to authorize and then presses Continue.`,
      args: { state: STATE, redirectUri: CALLBACK, codeVerifier: VERIFIER },
    },
    async (s) => {
      const res = await navigate(s, authorizePath(over));
      expect(res.status).toBe(303);
      binder = binderOf(res);
      handle = handleOf(res);
      const done = await press(s, who, binder, handle, "continue", body);
      expect(done.status).toBe(expectStatus);
      if (expectStatus === 200)
        redirect = ((await done.json()) as { redirect: string }).redirect;
    },
    { navigated: "app" },
  );
  return redirect;
}

/** The SDK redeems the code in app mode and is handed a grant. */
async function exchange(
  r: TranscriptRecorder,
  redirect: string,
  note: string,
): Promise<{ grant: string; choices: Json }> {
  const code = codeOfRedirect(redirect);
  let pending = { grant: "", choices: {} as Json };
  await r.step(
    {
      action: "redirectComplete",
      note,
      args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
    },
    async (s) => {
      const res = await token(s, code, VERIFIER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        grant: string;
        expiresIn: number;
        choices: Json;
      };
      expect(body.status).toBe("choose");
      expect(body.expiresIn).toBe(300);
      pending = { grant: body.grant, choices: body.choices };
    },
    { result: "choose" },
  );
  return pending;
}

export const redirectWebChoose: Scenario = {
  id: "redirect-web-choose",
  record: () =>
    pinned("redirect-web-choose", async (pin) => {
      const who = await world();
      const { w } = who;
      await ownedLicense(w, who, "lic_djdl_pro", 3);
      const team = await ownedLicense(w, who, "lic_djdl_team", 1);
      await occupy(w, team.key);
      const r = recorder(
        w,
        pin,
        "redirect-web-choose",
        "The licence is chosen on the card (I-08b, WIRE-CONTRACT-V4 §12.4.1; plans/I-04.md §C). The account holds a Pro licence with a free seat and a Team licence whose only seat is taken. The card lists both (`licenses`), and Continue without a choice is refused with license_choice_required and consumes nothing. The person picks Pro; the code carries the choice; the SDK redeems it at token and the device is bound to Pro, seat-checked.",
      );
      let binder = "";
      let handle = "";
      await r.step(
        {
          action: "browser",
          note: "The card's reads and a Continue with no choice: the list, then 409.",
          args: { state: STATE, redirectUri: CALLBACK, codeVerifier: VERIFIER },
        },
        async (s) => {
          const res = await navigate(s, authorizePath());
          binder = binderOf(res);
          handle = handleOf(res);
          const list = await cardGet(
            s,
            who,
            binder,
            `/api/signin/requests/${handle}/licenses`,
          );
          expect(list.status).toBe(200);
          const view = (await list.json()) as {
            state: string;
            choices: { id: string; state: string }[];
          };
          expect(view.state).toBe("choose");
          expect(view.choices.map((c) => [c.id, c.state]).sort()).toEqual([
            ["lic_djdl_pro", "free"],
            ["lic_djdl_team", "full"],
          ]);
          const none = await press(s, who, binder, handle, "continue");
          expect(none.status).toBe(409);
          expect(await none.json()).toEqual({
            error: "license_choice_required",
          });
        },
        { navigated: "card" },
      );
      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "Continue with the Pro licence chosen.",
        },
        async (s) => {
          const done = await press(s, who, binder, handle, "continue", {
            choice: { kind: "license", licenseId: "lic_djdl_pro" },
          });
          expect(done.status).toBe(200);
          redirect = ((await done.json()) as { redirect: string }).redirect;
        },
        { navigated: "app" },
      );
      await r.step(
        {
          action: "redirectComplete",
          note: "The SDK redeems the code; the device is on the chosen licence.",
          args: { callbackUrl: redirect, codeVerifier: VERIFIER, state: STATE },
        },
        async (s) => {
          const res = await token(s, codeOfRedirect(redirect), VERIFIER);
          expect(res.status).toBe(200);
          expect(
            ((await res.json()) as { license: { id: string } }).license.id,
          ).toBe("lic_djdl_pro");
        },
        {
          result: "ok",
          scope: "profile email",
          licenseId: "lic_djdl_pro",
          subject: who.subject,
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const redirectWebChooseApp: Scenario = {
  id: "redirect-web-choose-app",
  record: () =>
    pinned("redirect-web-choose-app", async (pin) => {
      const who = await world();
      const { w } = who;
      await ownedLicense(w, who, "lic_djdl_pro", 3);
      await ownedLicense(w, who, "lic_djdl_lite", 3);
      const r = recorder(
        w,
        pin,
        "redirect-web-choose-app",
        "The licence is chosen in the app (I-08b, WIRE-CONTRACT-V4 §12.5.1; plans/I-04.md §G). authorize carries license_choice=app, so Continue needs no choice and the code carries none. The SDK redeems it and, because a choice is due, token answers status choose with a pending sign-in grant (300 s) and the licence view instead of a device token. The SDK reads the licences again with the grant and completes with its pick; choice/complete answers the same shape token does.",
      );
      const redirect = await browserTo(
        r,
        who,
        { license_choice: "app" },
        undefined,
        "App mode: the card has no licence step.",
      );
      const pending = await exchange(
        r,
        redirect,
        "The exchange answers a grant, not a token: no device is bound yet.",
      );
      await r.step(
        {
          action: "choiceLicenses",
          note: "choice.licenses(grant): a fresh view of the account's licences.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "licenses", { grant: pending.grant });
          expect(res.status).toBe(200);
        },
        {
          result: "ok",
          state: "choose",
          licenses: ["lic_djdl_lite", "lic_djdl_pro"],
        },
      );
      await r.step(
        {
          action: "choiceComplete",
          note: "choice.complete(grant, license): the same members as token's answer.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "complete", {
            grant: pending.grant,
            choice: { kind: "license", licenseId: "lic_djdl_pro" },
          });
          expect(res.status).toBe(200);
        },
        {
          result: "ok",
          licenseId: "lic_djdl_pro",
          subject: who.subject,
          tokenHeld: true,
        },
      );
      return r.transcript();
    }),
};

export const choiceReplaceApp: Scenario = {
  id: "choice-replace-app",
  record: () =>
    pinned("choice-replace-app", async (pin) => {
      const who = await world();
      const { w } = who;
      const team = await ownedLicense(w, who, "lic_djdl_team", 1);
      await occupy(w, team.key);
      const r = recorder(
        w,
        pin,
        "choice-replace-app",
        "Replace a device in the app (I-08b, WIRE-CONTRACT-V4 §12.5.1; plans/I-04.md §B, §F.3, §G). The only licence is full: its single seat is held by another device. The SDK reads the licence (state full, Replace offered), lists the seat-holding devices with the grant, and completes with replaceDeviceId. The old device is deauthorized and this one takes its place in one batch; the answer is token's shape on the licence.",
      );
      const redirect = await browserTo(
        r,
        who,
        { license_choice: "app" },
        undefined,
        "App mode.",
      );
      const pending = await exchange(
        r,
        redirect,
        "The exchange answers a grant.",
      );
      await r.step(
        {
          action: "choiceLicenses",
          note: "The only row is full and offers Replace.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "licenses", { grant: pending.grant });
          const view = (await res.json()) as {
            choices: { state: string; replace: { allowed: boolean } }[];
          };
          expect(view.choices[0]!.state).toBe("full");
          expect(view.choices[0]!.replace.allowed).toBe(true);
        },
        { result: "ok", state: "choose", licenses: ["lic_djdl_team"] },
      );
      await r.step(
        {
          action: "choiceDevices",
          note: "choice.devices(grant, licenseId): the seat-holding devices.",
          args: { grant: pending.grant, licenseId: "lic_djdl_team" },
        },
        async (s) => {
          const res = await choicePost(s, "devices", {
            grant: pending.grant,
            licenseId: "lic_djdl_team",
          });
          expect(res.status).toBe(200);
        },
        { result: "ok", devices: [OTHER] },
      );
      await r.step(
        {
          action: "choiceComplete",
          note: "Replace and continue.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "complete", {
            grant: pending.grant,
            choice: {
              kind: "license",
              licenseId: "lic_djdl_team",
              replaceDeviceId: OTHER,
            },
          });
          expect(res.status).toBe(200);
        },
        {
          result: "ok",
          licenseId: "lic_djdl_team",
          subject: who.subject,
          tokenHeld: true,
        },
      );
      const old = await w.db.first<{ status: string }>(
        "SELECT status FROM devices WHERE product = ? AND device_id = ?",
        PRODUCT,
        OTHER,
      );
      expect(old?.status).toBe("deauthorized");
      return r.transcript();
    }),
};

export const choiceKeyApp: Scenario = {
  id: "choice-key-app",
  record: () =>
    pinned("choice-key-app", async (pin) => {
      const who = await world();
      const { w } = who;
      const seeded = await seedLicenseWithKey(w.db, PRODUCT, {
        id: "lic_djdl_keyed",
      });
      await w.db.run(
        "UPDATE licenses SET email = NULL WHERE product = ? AND id = ?",
        PRODUCT,
        "lic_djdl_keyed",
      );
      const r = recorder(
        w,
        pin,
        "choice-key-app",
        "A key entered in the app's sign-in form (I-08b, WIRE-CONTRACT-V4 §12.5.1; plans/I-04.md §G.5). The account holds nothing and the product grants nothing, so the exchange answers a grant with state none and a getLicense member that accepts keys. The SDK completes with a key: PX-W9's app key entry, counted once with the seat claim, then the account is signed in on the device. The answer is token's shape plus keyEntries.",
      );
      const redirect = await browserTo(
        r,
        who,
        { license_choice: "app" },
        undefined,
        "App mode.",
      );
      const pending = await exchange(
        r,
        redirect,
        "The exchange answers a grant (state none).",
      );
      expect((pending.choices as { state: string }).state).toBe("none");
      let used = 0;
      let limit = 0;
      await r.step(
        {
          action: "choiceComplete",
          note: "choice.complete(grant, {kind: key}).",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "complete", {
            grant: pending.grant,
            choice: { kind: "key", key: seeded.key },
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            keyEntries: { used: number; limit: number };
          };
          used = body.keyEntries.used;
          limit = body.keyEntries.limit;
        },
        {
          result: "ok",
          licenseId: "lic_djdl_keyed",
          subject: who.subject,
          tokenHeld: true,
          keyEntries: { used: 1, limit: KEY_ENTRY_LIMIT_DEFAULT },
        },
      );
      expect({ used, limit }).toEqual({
        used: 1,
        limit: KEY_ENTRY_LIMIT_DEFAULT,
      });
      return r.transcript();
    }),
};

export const choiceGrantErrors: Scenario = {
  id: "choice-grant-errors",
  record: () =>
    pinned("choice-grant-errors", async (pin) => {
      const who = await world();
      const { w } = who;
      await ownedLicense(w, who, "lic_djdl_pro", 3);
      const r = recorder(
        w,
        pin,
        "choice-grant-errors",
        "Every refusal of the grant routes (I-08b, WIRE-CONTRACT-V4 §12.5.1; plans/I-04.md §G.5, §G.6). A licence outside the grant's view is 404 not_found; complete with no choice is 409 license_choice_required and keeps the grant; a second complete after success is 400 invalid_grant; a grant past its 300 s is 400 invalid_grant. Errors are the nested Polaris body. The grant's other-device and 31st-read refusals are worker tests (an SDK has one device id).",
      );
      const redirect = await browserTo(
        r,
        who,
        { license_choice: "app" },
        undefined,
        "App mode.",
      );
      const pending = await exchange(
        r,
        redirect,
        "The exchange answers a grant.",
      );
      await r.step(
        {
          action: "choiceDevices",
          note: "A licence the grant's view does not list: one 404, whatever the id is.",
          args: { grant: pending.grant, licenseId: "lic_not_here" },
        },
        async (s) => {
          const res = await choicePost(s, "devices", {
            grant: pending.grant,
            licenseId: "lic_not_here",
          });
          expect(res.status).toBe(404);
        },
        { result: "refused", code: "not_found" },
      );
      await r.step(
        {
          action: "choiceComplete",
          note: "No choice at all: the grant stays open.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "complete", { grant: pending.grant });
          expect(res.status).toBe(409);
        },
        { result: "refused", code: "license_choice_required" },
      );
      await r.step(
        {
          action: "choiceComplete",
          note: "The choice, accepted.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "complete", {
            grant: pending.grant,
            choice: { kind: "license", licenseId: "lic_djdl_pro" },
          });
          expect(res.status).toBe(200);
        },
        {
          result: "ok",
          licenseId: "lic_djdl_pro",
          subject: who.subject,
          tokenHeld: true,
        },
      );
      await r.step(
        {
          action: "choiceComplete",
          note: "A second complete: the grant was consumed.",
          args: { grant: pending.grant },
        },
        async (s) => {
          const res = await choicePost(s, "complete", {
            grant: pending.grant,
            choice: { kind: "license", licenseId: "lic_djdl_pro" },
          });
          expect(res.status).toBe(400);
        },
        { result: "refused", code: "invalid_grant" },
      );
      // A second sign-in whose grant lapses.
      const again = await browserTo(
        r,
        who,
        { license_choice: "app" },
        undefined,
        "A second sign-in.",
      );
      const second = await exchange(r, again, "A new grant.");
      await r.step(
        {
          action: "choiceLicenses",
          note: "301 seconds later the grant is gone.",
          now: T0 + 301,
          args: { grant: second.grant },
        },
        async (s) => {
          const res = await choicePost(s, "licenses", { grant: second.grant });
          expect(res.status).toBe(400);
        },
        { result: "refused", code: "invalid_grant" },
      );
      await r.step(
        {
          action: "choiceCancel",
          note: "choice.cancel on a lapsed grant is the same refusal.",
          now: T0 + 301,
          args: { grant: second.grant },
        },
        async (s) => {
          const res = await choicePost(s, "cancel", { grant: second.grant });
          expect(res.status).toBe(400);
        },
        { result: "refused", code: "invalid_grant" },
      );
      return r.transcript();
    }),
};

export const CHOICE_SCENARIOS: Scenario[] = [
  redirectWebChoose,
  redirectWebChooseApp,
  choiceReplaceApp,
  choiceKeyApp,
  choiceGrantErrors,
];

void activated;
