/// <reference types="@cloudflare/workers-types" />
// Add a key-activated licence to an account (UK-42.11; Polaris Locker, activation without an
// account): what AddToAccount's driver sends. Records today's wire; nothing here is new.
//
//   holders-add-to-account   key activation (the licence is floating), sign-in with
//                            purpose "attach", the hints and license_choice=app, choice/complete
//                            {kind:"keep"} with the device token, then attach (preview, confirm).

import { expect } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  type Scenario,
} from "../world.js";
import { activateAndSync } from "./keyEntry.js";
import { attach, IDENTITY_ON, seedAccount } from "./account.js";
import { portalSession, registerWebApp } from "./webSignIn.js";
import {
  authorizePath,
  binderOf,
  codeOfRedirect,
  handleOf,
  navigate,
  press,
  token,
} from "./redirect.js";

const CALLBACK = "https://app.example/auth/callback";
const STATE = "tidewater-state-0123456789";
const ENTRIES = { used: 1, limit: 10 };
const VERIFIER = "transcript-verifier-0123456789-abcdefghijklmnopqrst";

export const holdersAddToAccount: Scenario = {
  id: "holders-add-to-account",
  record: () =>
    pinned("holders-add-to-account", async (pin) => {
      const w = await productWorld(IDENTITY_ON);
      const { key, licenseId } = await seedLicense(w);
      const ada = await seedAccount(w, "ada@example.com");
      await registerWebApp(w);
      const session = await portalSession(w, {
        id: ada.id,
        email: "ada@example.com",
      });
      const r = new TranscriptRecorder({
        id: "holders-add-to-account",
        description:
          "Add a key-activated licence to an account (UK-42.11, WIRE-CONTRACT-V5 §12.3, §12.4, §12.5.1). The device activates by key and the licence is floating. The person signs in on it: authorize carries the hints (login_hint, name_hint, purpose attach) and license_choice=app, and the SDK redeems the code. The exchange answers a grant (status choose) instead of a token. The SDK completes with choice {kind: keep} and the device token, which keeps this device on its licence, and the answer names the same licence and the account's subject. attach({confirm:false}) previews the licence and writes nothing; attach({confirm:true}) adds it to the signed-in account (attached: claimed) with the same licence id.",
        features: [
          "identity.attach",
          "identity.choice",
          "identity.signin.hints",
        ],
        requires: ["license.activate"],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });

      await r.step(
        {
          action: "activate",
          note: "Key activation: the licence is floating (no account holds it).",
          args: { key },
        },
        (s) => activateAndSync(s, ENTRIES),
        {
          result: "ok",
          tokenHeld: true,
          licenseStatus: "ok",
          keyEntries: ENTRIES,
        },
      );

      // The licence's buyer email, verified on the account, would let the portal's link sweep
      // join it the moment the card is used; the address is verified after the choice instead.
      await w.db.run(
        "UPDATE accounts SET primary_email_verified_at = NULL WHERE id = ?",
        ada.id,
      );
      await w.db.run(
        "UPDATE account_links SET email_verified = 0 WHERE account_id = ?",
        ada.id,
      );

      let redirect = "";
      await r.step(
        {
          action: "browser",
          note: "The browser goes to authorize with the hints, purpose attach and license_choice=app, then presses Continue; the code carries no licence choice.",
          args: {
            state: STATE,
            redirectUri: CALLBACK,
            codeVerifier: VERIFIER,
            loginHint: "ada@example.com",
            nameHint: "Ada",
            purpose: "attach",
          },
        },
        async (s) => {
          const res = await navigate(
            s,
            authorizePath({
              login_hint: "ada@example.com",
              name_hint: "Ada",
              purpose: "attach",
              license_choice: "app",
            }),
          );
          expect(res.status).toBe(303);
          const binder = binderOf(res);
          const handle = handleOf(res);
          const done = await press(s, session, binder, handle, "continue");
          expect(done.status).toBe(200);
          redirect = ((await done.json()) as { redirect: string }).redirect;
        },
        { navigated: "app" },
      );

      let grant = "";
      await r.step(
        {
          action: "redirectComplete",
          args: { callbackUrl: redirect, state: STATE, codeVerifier: VERIFIER },
          note: "The SDK redeems the code (the token form carries no bearer): a grant, no token.",
        },
        async (s) => {
          const res = await token(s, codeOfRedirect(redirect), VERIFIER);
          expect(res.status).toBe(200);
          const body = (await res.json()) as { status: string; grant: string };
          expect(body.status).toBe("choose");
          grant = body.grant;
        },
        { result: "choose" },
      );

      await r.step(
        {
          action: "choiceComplete",
          note: "choice.complete(grant, {kind: keep}) with the device token: the device stays on its licence.",
          args: { grant },
        },
        async (s) => {
          const body = { grant, choice: { kind: "keep" } };
          const res = await s.send({
            method: "POST",
            path: `/${PRODUCT}/identity/choice/complete`,
            bearer: "token",
            body,
            expectBody: { json: body, match: "exact" },
            capture: { token: "$.access_token" },
          });
          expect(res.status).toBe(200);
          expect(
            ((await res.json()) as { license: { id: string } }).license.id,
          ).toBe(licenseId);
        },
        {
          result: "ok",
          licenseId,
          subject: ada.subject,
          tokenHeld: true,
        },
      );
      await w.db.run(
        "UPDATE accounts SET primary_email_verified_at = ? WHERE id = ?",
        T0,
        ada.id,
      );
      await w.db.run(
        "UPDATE account_links SET email_verified = 1 WHERE account_id = ? AND email IS NOT NULL",
        ada.id,
      );

      for (const [confirm, now, note] of [
        [false, T0 + 60, "The preview names the licence and writes nothing."],
        [true, T0 + 120, "Confirmed: the licence joins the signed-in account."],
      ] as const) {
        await r.step(
          { action: "attach", args: { confirm }, now, note },
          async (s) => {
            expect((await attach(s, confirm, confirm)).status).toBe(200);
          },
          confirm
            ? {
                result: "ok",
                attached: "claimed",
                subject: ada.subject,
                tokenHeld: true,
              }
            : {
                result: "confirm",
                license: { id: licenseId, tierId: null, name: "Ada Lovelace" },
                tokenHeld: true,
              },
        );
      }
      const owner = await w.db.first<{ account_id: string }>(
        "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
        PRODUCT,
        licenseId,
      );
      expect(owner?.account_id).toBe(ada.id);
      return r.transcript();
    }),
};

export const HOLDERS_SCENARIOS: Scenario[] = [holdersAddToAccount];
