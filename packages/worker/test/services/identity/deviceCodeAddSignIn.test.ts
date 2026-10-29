/// <reference types="@cloudflare/workers-types" />
// UK-42.19: the web kits' in-page "Add your name and email" runs on the device-code channel
// (`startPageSignIn`). This drives what that does against the real Worker for a device holding a
// FLOATING key licence: key activation, device start with the hints and the app's licence choice,
// the person signs in, the poll, then the kit's attach preview. It pins what the device ends up
// with, which is NOT the holders path (`holders-add-to-account`, redirect channel): the device
// start reads only `deviceId` and `deviceName`, the poll never answers `choose`, and the device
// is minted on the signed-in identity's OWN licence.

import { describe, expect, it } from "vitest";
import { DEVICE, T0 } from "../../transcripts/client.js";
import { TranscriptRecorder } from "../../transcripts/recorder.js";
import { pinned, PRODUCT } from "../../transcripts/world.js";
import { activateAndSync } from "../../transcripts/scenarios/keyEntry.js";
import { seedLicense } from "../../transcripts/world.js";
import {
  identityWorld,
  PLAYER,
  playerSignsIn,
  pollSpec,
  START,
  type Started,
} from "../../transcripts/scenarios/identity.js";

const HINTED_START = {
  deviceId: DEVICE,
  loginHint: "ada@example.com",
  nameHint: "Ada",
  purpose: "attach",
  licenseChoice: "app",
};

describe("device-code Add to account over a floating key licence (UK-42.19)", () => {
  it("does not keep the device on its key licence", async () => {
    await pinned("uk-42-19-device-add", async (pin) => {
      const w = await identityWorld();
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
          // What `startPageSignIn` sends: the hints, purpose and the app's licence choice. The
          // start reads only deviceId and deviceName.
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
      await playerSignsIn(w, T0 + 6, started.verificationUriComplete);

      let status = "";
      await r.step(
        { action: "pollSignIn", now: T0 + 7 },
        async (s) => {
          const res = await s.send(pollSpec(started.deviceCode));
          const body = (await res.json()) as { status: string };
          console.log("UK-42.19 poll", res.status, JSON.stringify(body));
          status = body.status;
        },
        {},
      );
      // No grant, no `choose`, no token: the approval mints on the identity's OWN licence, and
      // the device's seat is on the key's licence, so the mint is refused (a generic `error`).
      expect(status).toBe("error");

      const licences = await w.db.all<{
        id: string;
        sub: string | null;
        account_id: string | null;
      }>(
        "SELECT id, sub, account_id FROM licenses WHERE product = ? ORDER BY id",
        PRODUCT,
      );
      // The poll's activation already created a second licence, for the identity.
      expect(licences).toHaveLength(2);
      expect(licences.find((l) => l.id !== licenseId)?.sub).toBe(PLAYER.sub);
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
});
