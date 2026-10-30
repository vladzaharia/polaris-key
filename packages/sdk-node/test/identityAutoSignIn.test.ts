// @pkey-feature identity.autosignin
// `identity.autoSignIn()` (I-47.2): rung 1 counts only a token a sign-in produced, the explicit
// sign-out flag survives a restart and fails closed, and `nearby.available()` is a pure read of
// discovery plus the runtime. Node answers `signedIn`, `needsSignIn` and `unavailable` only.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nearbyAvailable } from "../src/identity/autoSignIn.js";
import { CoreContext } from "../src/core/context.js";
import {
  FixedStore,
  json,
  seededClient,
  type Handler,
} from "./parityFixtures.js";

const SUBJECT = "ps_QQMMVm-ciTWvmWEIfhAVgQ";
const BASE = "https://k.test/djdl";
const extra = { expectedServices: ["license", "config", "identity"] as never };

const ENDPOINTS = {
  authDeviceStart: `${BASE}/identity/auth/device/start`,
  authDevicePoll: `${BASE}/identity/auth/device/poll`,
  subject: `${BASE}/identity/subject`,
  signout: `${BASE}/identity/signout`,
  attach: `${BASE}/identity/attach`,
};

const discovery =
  (fragment: Record<string, unknown> | null): Handler =>
  () =>
    json({
      product: "djdl",
      services: {
        identity:
          fragment === null
            ? { enabled: false }
            : { enabled: true, configured: true, ...fragment },
      },
    });

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    "GET /djdl/.well-known/polaris.json": discovery({ endpoints: ENDPOINTS }),
    "POST /djdl/identity/auth/device/start": () =>
      json({
        deviceCode: "dc_secret",
        userCode: "WDJB-MJHT",
        verificationUri: `${BASE}/identity/auth/device`,
        verificationUriComplete: `${BASE}/identity/auth/device?user_code=WDJB-MJHT`,
        expiresIn: 600,
        interval: 1,
      }),
    "POST /djdl/identity/auth/device/poll": () =>
      json({ status: "ready", token: "pkeyt_signed", schemaVersion: 3 }),
    "GET /djdl/identity/subject": () => json({ subject: SUBJECT }),
    "POST /djdl/identity/signout": () => json({ released: false }),
    "POST /djdl/identity/attach": () =>
      json({ token: "pkeyt_rotated", subject: SUBJECT }),
    "GET /djdl/license/document": () => new Response("", { status: 404 }),
    "GET /djdl/config/document": () => new Response("", { status: 404 }),
    "POST /djdl/devices/report": () => json({}),
    ...over,
  };
}

type Client = Awaited<ReturnType<typeof seededClient>>["client"];

async function signIn(client: Client): Promise<void> {
  const s = await client.identity.signIn.start({ channel: "device-code" });
  const o = await s.wait({ once: true });
  expect(o.kind).toBe("signedIn");
}

/** A restart: a new client on the same store and state directory. */
async function restart(dir: string, store: FixedStore, over = routes()) {
  return seededClient({
    token: null,
    routes: over,
    extra: {
      ...extra,
      store,
      stateDir: dir,
      dataDir: dir,
      cacheDir: dir,
      configDir: dir,
    },
  });
}

const stateOf = (c: Client): string =>
  (c.identity as unknown as { ctx: { dirs: { state: string } } }).ctx.dirs
    .state;

describe("autoSignIn(): rung 1", () => {
  it("a token that no sign-in produced is not a sign-in", async () => {
    const { client, seen } = await seededClient({
      token: "pkeyt_key",
      extra,
      routes: routes(),
    });
    expect(await client.identity.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "no_credential",
    });
    // The ladder is local: it sent nothing.
    expect(seen).toEqual([]);
  });

  it("a device-code sign-in is rung 1, offline, and a restart keeps it", async () => {
    const { client, store, seen, dir } = await seededClient({
      token: null,
      extra,
      routes: routes(),
    });
    await signIn(client);
    const sent = seen.length;
    const r = await client.identity.autoSignIn();
    expect(r).toMatchObject({ kind: "signedIn", via: "stored" });
    expect(seen.length).toBe(sent);

    const again = await restart(dir, store);
    expect(await again.client.identity.autoSignIn()).toMatchObject({
      kind: "signedIn",
      via: "stored",
    });
    again.client.close();
    client.close();
  });

  it("any other token replaces the mark: a key activation is not a sign-in", async () => {
    const { client, dir, store } = await seededClient({
      token: null,
      extra,
      routes: routes(),
    });
    await signIn(client);
    const tokens = (
      client as unknown as {
        tokens: { set(t: string, s: string): Promise<void> };
      }
    ).tokens;
    await tokens.set("pkeyt_key", "activate");
    expect(await client.identity.autoSignIn()).toMatchObject({
      kind: "needsSignIn",
    });
    // The mark is gone from disk as well.
    const again = await restart(dir, store);
    expect(await again.client.identity.autoSignIn()).toMatchObject({
      kind: "needsSignIn",
      reason: "no_credential",
    });
    again.client.close();
    client.close();
  });

  it("a re-acquire and an attach keep the mark; a deactivation drops it", async () => {
    const { client, store, dir } = await seededClient({
      token: null,
      extra,
      routes: routes(),
    });
    await signIn(client);
    const tokens = (
      client as unknown as {
        tokens: {
          set(t: string, s: string): Promise<void>;
          clear(): Promise<void>;
        };
      }
    ).tokens;
    await tokens.set("pkeyt_next", "reacquire");
    expect((await client.identity.autoSignIn()).kind).toBe("signedIn");
    expect(await client.identity.attach({ confirm: true })).toMatchObject({
      status: "ok",
    });
    expect(await store.getToken()).toBe("pkeyt_rotated");
    expect((await client.identity.autoSignIn()).kind).toBe("signedIn");
    await tokens.clear();
    expect(await client.identity.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "no_credential",
    });
    const again = await restart(dir, store);
    expect((await again.client.identity.autoSignIn()).kind).toBe("needsSignIn");
    again.client.close();
    client.close();
  });
});

describe("autoSignIn(): the explicit sign-out flag", () => {
  it("is set by signOut() even when the token stays, survives a restart, and the next sign-in clears it", async () => {
    const { client, store, dir } = await seededClient({
      token: null,
      extra,
      routes: routes(),
    });
    await signIn(client);
    expect(await client.identity.signOut()).toEqual({ released: false });
    // released: false keeps the token, and the token is not a sign-in any more.
    expect(await store.getToken()).toBe("pkeyt_signed");
    expect(await client.identity.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "signed_out",
    });

    const again = await restart(dir, store);
    expect(await again.client.identity.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "signed_out",
    });
    await signIn(again.client);
    expect(await again.client.identity.autoSignIn()).toMatchObject({
      kind: "signedIn",
    });
    const third = await restart(dir, store);
    expect((await third.client.identity.autoSignIn()).kind).toBe("signedIn");
    third.client.close();
    again.client.close();
    client.close();
  });

  it("is not set by a sign-out the Worker refused", async () => {
    const { client } = await seededClient({
      token: null,
      extra,
      routes: routes({
        "POST /djdl/identity/signout": () => json({ error: "boom" }, 500),
      }),
    });
    await signIn(client);
    await expect(client.identity.signOut()).rejects.toBeTruthy();
    expect((await client.identity.autoSignIn()).kind).toBe("signedIn");
    client.close();
  });

  it("is set by a sign-out on a device with no token", async () => {
    const { client } = await seededClient({
      token: null,
      extra,
      routes: routes(),
    });
    await client.identity.signOut();
    expect(await client.identity.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "signed_out",
    });
    client.close();
  });

  it("fails closed: a state file that does not read counts as signed out", async () => {
    const { client, store, dir } = await seededClient({
      token: null,
      extra,
      routes: routes(),
    });
    await signIn(client);
    writeFileSync(join(stateOf(client), "sign-in.json"), "{ not json");
    // The mark is read at load: a restart finds garbage.
    const again = await restart(dir, store);
    expect(await again.client.identity.autoSignIn()).toEqual({
      kind: "needsSignIn",
      reason: "signed_out",
    });
    again.client.close();
    client.close();
  });
});

describe("autoSignIn(): unavailable", () => {
  it("answers unavailable{product} while Identity is off, and never throws", async () => {
    const { client, seen } = await seededClient({ token: "pkeyt_a" });
    expect(await client.identity.autoSignIn()).toEqual({
      kind: "unavailable",
      code: "product",
    });
    expect(seen).toEqual([]);
  });
});

describe("nearby.available()", () => {
  const full = {
    nearby: true,
    endpoints: {
      nearbyStart: `${BASE}/identity/nearby/start`,
      nearbyApprove: `${BASE}/identity/nearby/approve`,
      nearbyPoll: `${BASE}/identity/nearby/poll`,
    },
  };

  async function availability(
    fragment: Record<string, unknown> | null,
    o: { runtime?: boolean } = {},
  ): Promise<{ requester: boolean; approver: boolean }> {
    const { client } = await seededClient({
      token: null,
      extra,
      routes: { "GET /djdl/.well-known/polaris.json": discovery(fragment) },
    });
    const ctx = (client.identity as unknown as { ctx: CoreContext }).ctx;
    const load = async () => {
      await client.discover();
      return (client as unknown as { discoveryDoc: never }).discoveryDoc;
    };
    const deps = {
      ctx,
      discovery: load,
      runtime: async () => o.runtime ?? true,
    };
    const out = {
      requester: await nearbyAvailable(deps, { role: "requester" }),
      approver: await nearbyAvailable(deps, { role: "approver" }),
    };
    client.close();
    return out;
  }

  it("is true for a role whose endpoints discovery names", async () => {
    expect(await availability(full)).toEqual({
      requester: true,
      approver: true,
    });
    expect(
      await availability({
        nearby: true,
        endpoints: { nearbyApprove: full.endpoints.nearbyApprove },
      }),
    ).toEqual({ requester: false, approver: true });
    expect(
      await availability({
        nearby: true,
        endpoints: {
          nearbyStart: full.endpoints.nearbyStart,
          nearbyPoll: full.endpoints.nearbyPoll,
        },
      }),
    ).toEqual({ requester: true, approver: false });
  });

  it("is false without the member, with Identity off, or on a runtime that cannot do mDNS", async () => {
    expect(await availability({ endpoints: full.endpoints })).toEqual({
      requester: false,
      approver: false,
    });
    expect(await availability(null)).toEqual({
      requester: false,
      approver: false,
    });
    expect(await availability(full, { runtime: false })).toEqual({
      requester: false,
      approver: false,
    });
  });

  it("the client's own call reads discovery and never throws", async () => {
    const { client } = await seededClient({
      token: null,
      extra,
      routes: {
        "GET /djdl/.well-known/polaris.json": discovery({
          endpoints: ENDPOINTS,
        }),
      },
    });
    expect(await client.identity.nearby.available({ role: "approver" })).toBe(
      false,
    );
    expect(
      await client.identity.nearby.available({ role: "bogus" as never }),
    ).toBe(false);
  });
});
