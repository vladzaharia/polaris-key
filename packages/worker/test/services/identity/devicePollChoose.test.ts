/// <reference types="@cloudflare/workers-types" />
// UK-42.22.3b: the device-code poll in app mode (WIRE-CONTRACT-V5 §12.10.1).
//
//   - a device flow that asked `licenseChoice: "app"`, for an account to settle for, answers
//     `choose` when a choice is due and spends the flow; the grant is `via: "device"`, so it
//     lists no devices, cannot Replace, and its view has `replace: null`;
//   - with the policy granting a first licence and nothing else due, the poll mints it (as
//     Continue does) and answers `ready`; it never mints through `activateFromIdentity`;
//   - a store failure while issuing the grant is the transient 503 and the flow is kept;
//   - card mode (and app mode with no account) is today's poll.

import { describe, expect, it, vi } from "vitest";

const grantFault = vi.hoisted(() => ({ fail: false }));
vi.mock("../../../src/services/identity/passthrough/grant.js", async (orig) => {
  const real =
    await orig<
      typeof import("../../../src/services/identity/passthrough/grant.js")
    >();
  return {
    ...real,
    issueGrant: (...a: Parameters<typeof real.issueGrant>) => {
      if (grantFault.fail) throw new Error("store down");
      return real.issueGrant(...a);
    },
  };
});

import { upsertDevice } from "../../../src/core/devices/store.js";
import { type World } from "../../transcripts/recorder.js";
import { DEVICE, T0 } from "../../transcripts/client.js";
import { pinned, PRODUCT } from "../../transcripts/world.js";
import {
  CHOICE,
  noGrantWorld,
  pollDevice,
  signedIn as shared,
} from "../../transcripts/appMode.js";
import {
  identityWorld,
  platformIdentityWorld,
  PLAYER,
  postJson,
  type Started,
} from "../../transcripts/scenarios/identity.js";

const call = postJson;

const signedIn = async (
  w: World,
  extra?: Record<string, unknown>,
): Promise<Started> => (await shared(w, extra)).started;

/** A platform product whose policy grants this person nothing, signed in and approved. */
async function signedInNoGrant(): Promise<{ w: World; started: Started }> {
  const w = await noGrantWorld();
  return { w, started: await signedIn(w) };
}

const poll = pollDevice;

const licenceCount = async (w: World): Promise<number> =>
  (
    await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM licenses WHERE product = ?",
      PRODUCT,
    )
  )?.n ?? 0;

describe("the device-code poll in app mode (§12.10.1)", () => {
  it("mints the policy's first licence, binds the device and answers ready", () =>
    pinned("uk-42-22-poll", async () => {
      const w = await platformIdentityWorld();
      const started = await signedIn(w);
      const res = await poll(w, started, T0 + 5);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        token: string;
        identity: { email?: string };
      };
      expect(body.status).toBe("ready");
      expect(body.token.startsWith("pkeyt_")).toBe(true);
      // One licence, the account's (not the identity's `sub`-keyed one), and the device is on it.
      const lic = await w.db.all<{
        id: string;
        sub: string | null;
        account_id: string | null;
      }>("SELECT id, sub, account_id FROM licenses WHERE product = ?", PRODUCT);
      expect(lic).toHaveLength(1);
      expect(lic[0]!.account_id).toBeTruthy();
      expect(lic[0]!.sub).toBeNull();
      const seat = await w.db.first<{ license_id: string; subject: string }>(
        "SELECT license_id, subject FROM devices WHERE product = ? AND device_id = ?",
        PRODUCT,
        DEVICE,
      );
      expect(seat?.license_id).toBe(lic[0]!.id);
      expect(seat?.subject).toBeTruthy();
      // The flow is spent.
      expect(await (await poll(w, started, T0 + 8)).json()).toEqual({
        status: "timeout",
      });
    }));

  it("answers choose when no licence is granted (the no-licence state), and spends the flow", () =>
    pinned("uk-42-22-poll", async () => {
      const { w, started } = await signedInNoGrant();
      const res = await poll(w, started, T0 + 5);
      const body = (await res.json()) as {
        status: string;
        grant: string;
        expiresIn: number;
        choices: { state: string; getLicense: { keyEntry: boolean } | null };
      };
      expect(body.status).toBe("choose");
      expect(body.grant).toMatch(/^sg_[A-Za-z0-9_-]{43}$/);
      expect(body.expiresIn).toBe(300);
      expect(body.choices.state).toBe("none");
      expect(body.choices.getLicense?.keyEntry).toBe(true);
      // Nothing was minted or bound by the poll.
      expect(await licenceCount(w)).toBe(0);
      expect(await (await poll(w, started, T0 + 8)).json()).toEqual({
        status: "timeout",
      });
      // The grant answers its device, and no other.
      const other = await call(
        w,
        T0 + 9,
        `${CHOICE}/licenses`,
        { grant: body.grant },
        { "x-pkey-device": "another-device" },
      );
      expect(other.status).toBe(400);
      const mine = await call(
        w,
        T0 + 9,
        `${CHOICE}/licenses`,
        { grant: body.grant },
        { "x-pkey-device": DEVICE },
      );
      expect(mine.status).toBe(200);
      // `create` is offered by the policy only; here nothing is, and `devices` is never listed.
      const devices = await call(
        w,
        T0 + 10,
        `${CHOICE}/devices`,
        { grant: body.grant, licenseId: "lic_x" },
        { "x-pkey-device": DEVICE },
      );
      expect(devices.status).toBe(404);
    }));

  it("withholds Replace from the view of a device-code grant", () =>
    pinned("uk-42-22-poll", async () => {
      const w = await platformIdentityWorld();
      const started = await signedIn(w);
      // The account holds a FULL licence of its own (a seat limit of one, taken by another device),
      // so the view would offer Replace on a card or a same-device grant.
      const account = await w.db.first<{ account_id: string }>(
        "SELECT account_id FROM account_links WHERE kind = 'oidc' AND subject = ?",
        PLAYER.sub,
      );
      expect(account).toBeTruthy();
      await w.db.run(
        `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at,
         expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
         modified_by, modified_at, account_id)
       VALUES (?, 'lic_full', 'active', NULL, 'Full', NULL, NULL, NULL, ?, NULL, NULL, '{}', NULL, NULL, NULL, NULL, ?, ?)`,
        PRODUCT,
        T0,
        T0,
        account!.account_id,
      );
      await w.db.run(
        "UPDATE products SET default_device_limit = 1 WHERE slug = ?",
        PRODUCT,
      );
      await upsertDevice(w.db, {
        product: PRODUCT,
        device_id: "other-device",
        customer_id: null,
        license_id: "lic_full",
        status: "authorized",
        first_seen: T0,
        last_seen: T0,
        ua: null,
        label: "Other PC",
        overrides_json: null,
        reported_json: null,
        token_hash: null,
      });
      await w.db.run(
        "UPDATE devices SET seat_no = 1 WHERE product = ? AND device_id = 'other-device'",
        PRODUCT,
      );
      const res = await poll(w, started, T0 + 5);
      const body = (await res.json()) as {
        status: string;
        grant: string;
        choices: { choices: { id: string; replace: unknown }[] };
      };
      expect(body.status).toBe("choose");
      const full = body.choices.choices.find((c) => c.id === "lic_full") as
        | { state: string }
        | undefined;
      expect(full?.state).toBe("full");
      for (const c of body.choices.choices) expect(c.replace).toBeNull();
      const view = await call(
        w,
        T0 + 6,
        `${CHOICE}/licenses`,
        { grant: body.grant },
        { "x-pkey-device": DEVICE },
      );
      const again = (await view.json()) as {
        choices: { replace: unknown }[];
      };
      for (const c of again.choices) expect(c.replace).toBeNull();
    }));

  it("a store failure while issuing the grant is the transient 503, and the flow is kept", () =>
    pinned("uk-42-22-poll", async () => {
      const { w, started } = await signedInNoGrant();
      grantFault.fail = true;
      try {
        const failed = await poll(w, started, T0 + 5);
        expect(failed.status).toBe(503);
        expect(failed.headers.get("retry-after")).toBeTruthy();
        expect(await failed.json()).toEqual({
          error: "unavailable",
          message: "try again",
        });
      } finally {
        grantFault.fail = false;
      }
      // The first poll at or after Retry-After attempts it again and now gets the grant.
      const retried = await poll(w, started, T0 + 12);
      expect(((await retried.json()) as { status: string }).status).toBe(
        "choose",
      );
    }));

  it("app mode with no account to settle for (a custom IdP) is card mode", () =>
    pinned("uk-42-22-poll", async () => {
      const w = await identityWorld();
      const started = await signedIn(w);
      const res = await poll(w, started, T0 + 5);
      const body = (await res.json()) as { status: string; token?: string };
      // Today's poll: the identity's own licence, minted by the activation.
      expect(body.status).toBe("ready");
      expect(body.token?.startsWith("pkeyt_")).toBe(true);
      const lic = await w.db.all<{ sub: string | null }>(
        "SELECT sub FROM licenses WHERE product = ?",
        PRODUCT,
      );
      expect(lic).toEqual([{ sub: PLAYER.sub }]);
    }));

  it("card mode in a platform product never answers choose", () =>
    pinned("uk-42-22-poll", async () => {
      const w = await platformIdentityWorld();
      const started = await signedIn(w, { licenseChoice: "card" });
      const body = (await (await poll(w, started, T0 + 5)).json()) as {
        status: string;
      };
      expect(body.status).toBe("ready");
    }));
});
