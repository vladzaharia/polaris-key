// @pkey-feature identity.devicecode
// SDK parity pass §3.12: the attach opt-in (P1-07), signInWithBrowser (device code opened in the
// system browser), ready carrying the identity, identity.current() and identity.signOut().

import { describe, expect, it } from "vitest";
import { json, seededClient, signedLicense } from "./parityFixtures.js";

const START = {
  deviceCode: "dc_secret",
  userCode: "WDJB-MJHT",
  verificationUri: "https://key.plrs.im/djdl/identity/auth/device",
  verificationUriComplete:
    "https://key.plrs.im/djdl/identity/auth/device?user_code=WDJB-MJHT",
  expiresIn: 600,
  interval: 1,
};

describe("device-code conveniences (§3.12)", () => {
  it("signInWithBrowser opens the complete URI, runs the attach opt-in, and stores the identity", async () => {
    const license = await signedLicense({ pro: true });
    const polls: { body: Record<string, unknown>; auth: string | null }[] = [];
    const { client } = await seededClient({
      token: "pkeyt_anon",
      extra: { expectedServices: ["license", "config", "identity"] as never },
      routes: {
        "POST /djdl/identity/auth/device/start": () => json(START),
        "POST /djdl/identity/auth/device/poll": (req) => {
          const body = JSON.parse(req.body!);
          polls.push({ body, auth: req.headers.get("authorization") });
          if (body.attachLicense === undefined)
            return json({
              status: "confirm",
              identity: { name: "Ada", email: "ada@example.com", sub: "x" },
              attachable: true,
            });
          return json({
            status: "ready",
            token: "pkeyt_signed",
            schemaVersion: 3,
            identity: { name: "Ada", email: "ada@example.com" },
            attached: "claimed",
          });
        },
        "GET /djdl/license/document": () => new Response(license),
        "GET /djdl/config/document": () => new Response("", { status: 404 }),
        "POST /djdl/devices/report": () => json({}),
        "POST /djdl/license/deauthorize": () => json({}),
      },
    });
    const opened: string[] = [];
    const shownTo: string[] = [];
    const r = await client.identity.signInWithBrowser({
      openUrl: (u) => (opened.push(u), true),
      onPrompt: (p) => shownTo.push(p.userCode),
      confirm: async (identity, attachable) => {
        expect(identity).toEqual({ name: "Ada", email: "ada@example.com" });
        return attachable;
      },
    });
    expect(opened).toEqual([START.verificationUriComplete]);
    expect(shownTo).toEqual(["WDJB-MJHT"]);
    expect(r).toEqual({
      status: "ready",
      identity: { name: "Ada", email: "ada@example.com" },
      attached: "claimed",
    });
    expect(polls[0]).toEqual({
      body: {
        deviceCode: "dc_secret",
        deviceId: expect.any(String),
        confirmIdentity: true,
      },
      auth: "Bearer pkeyt_anon",
    });
    expect(polls[1]!.body.attachLicense).toBe(true);
    expect(await client.identity.current()).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
    });

    await client.identity.signOut();
    expect(await client.identity.current()).toBeNull();
    expect(client.status().status).toBe("needs-activation");
  });

  it("an ordinary poll sends no opt-in and no bearer", async () => {
    const bodies: string[] = [];
    const auths: (string | null)[] = [];
    const { client } = await seededClient({
      token: "pkeyt_anon",
      extra: { expectedServices: ["license", "config", "identity"] as never },
      routes: {
        "POST /djdl/identity/auth/device/start": () => json(START),
        "POST /djdl/identity/auth/device/poll": (req) => {
          bodies.push(req.body!);
          auths.push(req.headers.get("authorization"));
          return json({ status: "pending" });
        },
      },
    });
    const p = await client.identity.beginSignIn();
    expect(await client.identity.pollSignIn(p)).toEqual({ status: "pending" });
    expect(Object.keys(JSON.parse(bodies[0]!)).sort()).toEqual([
      "deviceCode",
      "deviceId",
    ]);
    expect(auths).toEqual([null]);
  });
});
