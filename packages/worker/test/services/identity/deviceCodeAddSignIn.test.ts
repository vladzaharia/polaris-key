/// <reference types="@cloudflare/workers-types" />
// UK-42.19 and UK-42.22: the web kits' in-page "Add your name and email" runs on the device-code
// channel (`startPageSignIn`). This drives it against the real Worker for a device holding a
// FLOATING key licence: key activation, device start with the hints and the app's licence choice,
// the person signs in, the poll, then the kit's attach.
//
//   - app mode (`licenseChoice: "app"`, WIRE-CONTRACT-V5 §12.10.1) with an account to settle for:
//     the poll answers `choose` with a grant, the device keeps its licence with its own token, and
//     attach joins that same licence to the account (`attached: "claimed"`);
//   - card mode (`licenseChoice: "card"`), and app mode with no account to settle for (a custom
//     IdP): today's path, where the device's seat is on a licence the identity cannot take over,
//     so the poll answers the generic `error` and creates nothing (W-STRAY).

import { describe, expect, it } from "vitest";
import { DEVICE, T0 } from "../../transcripts/client.js";
import { TranscriptRecorder } from "../../transcripts/recorder.js";
import { pinned, PRODUCT } from "../../transcripts/world.js";
import { activateAndSync } from "../../transcripts/scenarios/keyEntry.js";
import { seedLicense } from "../../transcripts/world.js";
import { accountForSubject } from "../../../src/core/accounts/accountSubjects.js";
import { attach } from "../../transcripts/scenarios/account.js";
import {
  identityWorld,
  platformIdentityWorld,
  PLAYER,
  playerSignsIn,
  pollSpec,
  START,
  type Started,
} from "../../transcripts/scenarios/identity.js";

/** What `startPageSignIn` sends: the hints, purpose and the app's licence choice. */
const HINTED_START = {
  deviceId: DEVICE,
  loginHint: "ada@example.com",
  nameHint: "Ada",
  purpose: "attach",
  licenseChoice: "app",
};
const CARD_START = { ...HINTED_START, licenseChoice: "card" };

/** The person, as the platform IdP vouches for them: a verified address that is NOT the licence's
 *  buyer's, so the portal's link sweep does not join the key licence to the new account. */
const ADA = { ...PLAYER, email_verified: true };

const CHOICE = `/${PRODUCT}/identity/choice`;

describe("device-code Add to account over a floating key licence", () => {
  for (const [name, kind, start] of [
    ["card mode", "platform", CARD_START],
    ["app mode with no account to settle for", "custom", HINTED_START],
  ] as const) {
    it(`${name}: does not keep the device on its key licence`, async () => {
      await pinned("uk-42-19-device-add", async (pin) => {
        const w = await (kind === "platform"
          ? platformIdentityWorld()
          : identityWorld());
        const { key, licenseId } = await seedLicense(w);
        const r = new TranscriptRecorder({
          id: "uk-42-19-device-add",
          description: "UK-42.19 probe; never written.",
          features: ["identity.devicecode"],
          requires: ["license.activate"],
          product: PRODUCT,
          now: T0,
          world: w,
          pinned: pin,
          initial: { deviceId: DEVICE, version: "1.0.0" },
        });

        await r.step(
          { action: "activate", args: { key } },
          (s) => activateAndSync(s, { used: 1, limit: 10 }),
          {},
        );
        const floating = await w.db.first<{
          account_id: string | null;
          sub: string | null;
        }>(
          "SELECT account_id, sub FROM licenses WHERE product = ? AND id = ?",
          PRODUCT,
          licenseId,
        );
        expect(floating?.account_id ?? null).toBeNull();

        let started!: Started;
        await r.step(
          { action: "beginSignIn" },
          async (s) => {
            const res = await s.send({
              method: "POST",
              path: START,
              body: start,
              expectBody: { json: start, match: "exact" },
            });
            expect(res.status).toBe(200);
            started = (await res.json()) as Started;
          },
          {},
        );
        await playerSignsIn(
          w,
          T0 + 6,
          started.verificationUriComplete,
          "approve",
          ADA,
        );

        let status = "";
        await r.step(
          { action: "pollSignIn", now: T0 + 7 },
          async (s) => {
            const res = await s.send(pollSpec(started.deviceCode));
            const body = (await res.json()) as { status: string };
            status = body.status;
          },
          {},
        );
        // The device's seat is on the key's licence, which the sign-in cannot take over: the
        // poll answers the generic `error` and creates nothing.
        expect(status).toBe("error");

        const licences = await w.db.all<{
          id: string;
          sub: string | null;
          account_id: string | null;
        }>(
          "SELECT id, sub, account_id FROM licenses WHERE product = ? ORDER BY id",
          PRODUCT,
        );
        // Exactly one licence: no stray licence was created for the identity.
        expect(licences).toHaveLength(1);
        expect(licences.some((l) => l.sub === PLAYER.sub)).toBe(false);
        // The key's licence stays floating: nothing attached it, nothing set a subject.
        const kept = licences.find((l) => l.id === licenseId)!;
        expect(kept.account_id ?? null).toBeNull();
        // The device never moved: its one seat is still on the key's licence.
        const seats = await w.db.all<{ license_id: string }>(
          "SELECT license_id FROM devices WHERE product = ? AND device_id = ?",
          PRODUCT,
          DEVICE,
        );
        expect(seats).toEqual([{ license_id: licenseId }]);
      });
    });
  }

  it("app mode: choose, keep with the device's token, then attach joins the same licence", async () => {
    await pinned("uk-42-22-device-add", async (pin) => {
      const w = await platformIdentityWorld();
      const { key, licenseId } = await seedLicense(w);
      const r = new TranscriptRecorder({
        id: "uk-42-22-device-add",
        description: "UK-42.22 probe; never written.",
        features: ["identity.devicecode"],
        requires: ["license.activate"],
        product: PRODUCT,
        now: T0,
        world: w,
        pinned: pin,
        initial: { deviceId: DEVICE, version: "1.0.0" },
      });

      await r.step(
        { action: "activate", args: { key } },
        (s) => activateAndSync(s, { used: 1, limit: 10 }),
        {},
      );

      let started!: Started;
      await r.step(
        { action: "beginSignIn" },
        async (s) => {
          const res = await s.send({
            method: "POST",
            path: START,
            body: HINTED_START,
            expectBody: { json: HINTED_START, match: "exact" },
          });
          expect(res.status).toBe(200);
          started = (await res.json()) as Started;
        },
        {},
      );
      await playerSignsIn(
        w,
        T0 + 6,
        started.verificationUriComplete,
        "approve",
        ADA,
      );

      let grant = "";
      let subject = "";
      let accountId = "";
      await r.step(
        { action: "pollSignIn", now: T0 + 7 },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            status: string;
            grant: string;
            expiresIn: number;
            choices: { state: string; keep: boolean };
          };
          expect(body.status).toBe("choose");
          expect(body.grant).toMatch(/^sg_[A-Za-z0-9_-]{43}$/);
          expect(body.expiresIn).toBe(300);
          // The device runs on a licence the account does not hold: keep is offered.
          expect(body.choices.state).toBe("choose");
          expect(body.choices.keep).toBe(true);
          grant = body.grant;
        },
        {},
      );
      // The flow was spent when the grant was issued.
      await r.step(
        { action: "pollSignIn", now: T0 + 9 },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          expect(await res.json()).toEqual({ status: "timeout" });
        },
        {},
      );

      // A device-code grant lists no devices and cannot Replace (§12.5.1 rule 5).
      await r.step(
        { action: "choiceDevices", args: { grant } },
        async (s) => {
          const body = { grant, licenseId };
          const res = await s.send({
            method: "POST",
            path: `${CHOICE}/devices`,
            body,
            expectBody: { json: body, match: "exact" },
          });
          expect(res.status).toBe(404);
        },
        {},
      );
      await r.step(
        { action: "choiceComplete", args: { grant } },
        async (s) => {
          const body = {
            grant,
            choice: { kind: "license", licenseId, replaceDeviceId: "other" },
          };
          const res = await s.send({
            method: "POST",
            path: `${CHOICE}/complete`,
            body,
            expectBody: { json: body, match: "exact" },
          });
          expect(res.status).toBe(409);
          expect(
            ((await res.json()) as { error: { code: string } }).error.code,
          ).toBe("license_choice_required");
        },
        {},
      );
      // Keep needs the device's own token: without it the choice is still owed, grant open.
      await r.step(
        { action: "choiceComplete", args: { grant } },
        async (s) => {
          const body = { grant, choice: { kind: "keep" } };
          const res = await s.send({
            method: "POST",
            path: `${CHOICE}/complete`,
            body,
            expectBody: { json: body, match: "exact" },
          });
          expect(res.status).toBe(409);
        },
        {},
      );
      await r.step(
        { action: "choiceComplete", args: { grant } },
        async (s) => {
          const body = { grant, choice: { kind: "keep" } };
          const res = await s.send({
            method: "POST",
            path: `${CHOICE}/complete`,
            bearer: "token",
            body,
            expectBody: { json: body, match: "exact" },
            capture: { token: "$.access_token" },
          });
          expect(res.status).toBe(200);
          const out = (await res.json()) as {
            license: { id: string };
            subject: string;
          };
          // The same licence the device activated, now signed in to the account.
          expect(out.license.id).toBe(licenseId);
          subject = out.subject;
        },
        {},
      );
      // The buyer's address is verified on the account after the choice (as the person does on the
      // portal), so the licence is joined by attach and not by the link sweep before it.
      accountId = (await accountForSubject(w.db, PRODUCT, subject))!;
      expect(accountId).toBeTruthy();
      await w.db.run(
        "UPDATE accounts SET primary_email = ?, primary_email_verified_at = ? WHERE id = ?",
        "ada@example.com",
        T0,
        accountId,
      );

      // Attach joins that licence to the account.
      await r.step(
        { action: "attach", args: { confirm: true } },
        async (s) => {
          const res = await attach(s, true, true);
          expect(res.status).toBe(200);
          expect(((await res.json()) as { attached: string }).attached).toBe(
            "claimed",
          );
        },
        {},
      );
      const owner = await w.db.first<{ account_id: string | null }>(
        "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
        PRODUCT,
        licenseId,
      );
      expect(owner?.account_id).toBe(accountId);
      // No stray licence was minted for the identity along the way.
      const n = await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM licenses WHERE product = ?",
        PRODUCT,
      );
      expect(n?.n).toBe(1);
    });
  });
});
