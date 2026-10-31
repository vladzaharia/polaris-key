/// <reference types="@cloudflare/workers-types" />
// LG-1: the launch gates (`launch.*`). Each v0.10.0 feature is off until its gate is on: off gives
// the absent behaviour, on gives the current one, and an unreadable settings table gives off.

import { describe, expect, it } from "vitest";
import { TOKEN_EXCHANGE_GRANT_TYPE } from "@polaris-key/protocol/identity";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { dispatchWith } from "../../src/dispatch.js";
import { loadProduct } from "../../src/core/products.js";
import { setServices } from "../../src/core/products/store.js";
import { SERVICE_SLUGS, serializeServices } from "../../src/core/services.js";
import { launchGateOn } from "../../src/core/settings/platformRead.js";
import { connectService } from "../../src/services/connect/index.js";
import { handleToken } from "../../src/services/identity/passthrough/token.js";
import { handleExchangeNonce } from "../../src/services/identity/passthrough/nonce.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";

const P = "djdl";
type Gate =
  | "LAUNCH_IDENTITY_EXCHANGE"
  | "LAUNCH_CONNECT"
  | "LAUNCH_SYNC_E2E"
  | "LAUNCH_SYNC_FILES"
  | "LAUNCH_RELAY";

interface W {
  db: Db;
  env: Env;
}

async function world(): Promise<W> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [P]);
  await seedProduct(db, P);
  const live = new Set(["license", "config", "identity", "sync", "connect"]);
  const services = Object.fromEntries(
    SERVICE_SLUGS.map((slug) => [slug, { enabled: live.has(slug) }]),
  );
  await setServices(
    db,
    P,
    serializeServices({ services } as never),
    "manifest",
    NOW,
  );
  return { db, env };
}

/** The deploy value of a gate: absent (the default, off), or a string. */
function setGate(w: W, gate: Gate, value: string | undefined): void {
  const env = w.env as unknown as Record<string, unknown>;
  if (value === undefined) delete env[gate];
  else env[gate] = value;
}

/** A Db whose `platform_settings` cannot be read (every other read passes through). */
function unreadable(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "all")
        return (sql: string, ...params: never[]) => {
          if (/platform_settings/.test(sql))
            return Promise.reject(new Error("platform_settings unreadable"));
          return target.all(sql, ...params);
        };
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function get(w: W, path: string, db: Db = w.db): Promise<number> {
  const res = await dispatchWith(
    new Request(`https://key.plrs.im/${P}${path}`),
    w.env,
    db,
    NOW,
  );
  return res.status;
}

async function tokenGrant(
  w: W,
  db: Db = w.db,
): Promise<{ status: number; error: string | undefined }> {
  const product = (await loadProduct(w.env, db, P))!;
  const res = await handleToken({
    req: new Request(`https://key.plrs.im/${P}/identity/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT_TYPE }),
    }),
    env: w.env,
    db,
    product,
    now: NOW,
  });
  const body = (await res.json()) as { error?: string };
  return { status: res.status, error: body.error };
}

async function nonce(w: W, db: Db = w.db): Promise<number> {
  const product = (await loadProduct(w.env, db, P))!;
  const res = await handleExchangeNonce(
    new Request(`https://key.plrs.im/${P}/identity/nonce`, {
      method: "POST",
      headers: { "x-pkey-device": "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH" },
      body: "{}",
    }),
    w.env,
    db,
    product,
    NOW,
  );
  return res.status;
}

async function fragment(w: W, db: Db = w.db): Promise<Record<string, unknown>> {
  const product = (await loadProduct(w.env, db, P))!;
  return connectService.discoveryFragment({
    product,
    env: w.env,
    db,
    base: `https://key.plrs.im/${P}`,
    hooks: {} as never,
    portalOn: false,
  });
}

describe("launch.identityExchange", () => {
  it("off: the grant is unsupported and the nonce route is absent", async () => {
    const w = await world();
    setGate(w, "LAUNCH_IDENTITY_EXCHANGE", undefined);
    expect(await tokenGrant(w)).toEqual({
      status: 400,
      error: "unsupported_grant_type",
    });
    expect(await nonce(w)).toBe(404);
  });

  it("on: the grant is handled and the nonce route answers", async () => {
    const w = await world();
    const r = await tokenGrant(w);
    expect(r.error).not.toBe("unsupported_grant_type");
    expect(await nonce(w)).not.toBe(404);
  });

  it("an unreadable settings table reads off", async () => {
    const w = await world();
    const bad = unreadable(w.db);
    expect((await tokenGrant(w, bad)).error).toBe("unsupported_grant_type");
    expect(await nonce(w, bad)).toBe(404);
  });
});

describe("launch.connect", () => {
  it("off: both routes are 404 and discovery reports the service off", async () => {
    const w = await world();
    setGate(w, "LAUNCH_CONNECT", undefined);
    expect(await get(w, "/connect/identity")).toBe(404);
    expect(await get(w, "/connect/devices")).toBe(404);
    expect(await fragment(w)).toEqual({ enabled: false });
  });

  it("on: the routes exist (they ask for a device token) and discovery names them", async () => {
    const w = await world();
    expect(await get(w, "/connect/identity")).toBe(401);
    expect(await get(w, "/connect/devices")).toBe(401);
    const f = await fragment(w);
    expect(f.enabled).toBe(true);
    expect(f.endpoints).toEqual({
      identity: `https://key.plrs.im/${P}/connect/identity`,
      devices: `https://key.plrs.im/${P}/connect/devices`,
      ticket: null,
    });
  });

  it("an unreadable settings table reads off", async () => {
    const w = await world();
    const bad = unreadable(w.db);
    expect(await get(w, "/connect/identity", bad)).toBe(404);
    expect(await fragment(w, bad)).toEqual({ enabled: false });
  });
});

describe("launch.syncE2e", () => {
  it("off: the key ring routes are 404", async () => {
    const w = await world();
    setGate(w, "LAUNCH_SYNC_E2E", undefined);
    expect(await get(w, "/devices/keyring")).toBe(404);
    expect(await get(w, "/devices/keyring/wraps/abc")).toBe(404);
  });

  it("on: the routes exist (they ask for a device token)", async () => {
    const w = await world();
    expect(await get(w, "/devices/keyring")).toBe(401);
  });

  it("an unreadable settings table reads off", async () => {
    const w = await world();
    expect(await get(w, "/devices/keyring", unreadable(w.db))).toBe(404);
  });
});

describe("launch gates, as settings", () => {
  const gates = [
    ["launch.identityExchange", "LAUNCH_IDENTITY_EXCHANGE"],
    ["launch.connect", "LAUNCH_CONNECT"],
    ["launch.syncE2e", "LAUNCH_SYNC_E2E"],
    ["launch.syncFiles", "LAUNCH_SYNC_FILES"],
    ["launch.relay", "LAUNCH_RELAY"],
  ] as const;

  it("default off with no deploy value, on with one, off under a hard-off deploy value", async () => {
    for (const [key, v] of gates) {
      const w = await world();
      setGate(w, v, undefined);
      expect(await launchGateOn(w.env, w.db, key), key).toBe(false);
      setGate(w, v, "runtime");
      expect(await launchGateOn(w.env, w.db, key), key).toBe(false);
      setGate(w, v, "on");
      expect(await launchGateOn(w.env, w.db, key), key).toBe(true);
      setGate(w, v, "off");
      expect(await launchGateOn(w.env, w.db, key), key).toBe(false);
      // An unreadable store is off even where the deploy says on.
      setGate(w, v, "on");
      expect(await launchGateOn(w.env, unreadable(w.db), key), key).toBe(false);
    }
  });

  it("a runtime deploy value lets a stored value turn the gate on", async () => {
    const w = await world();
    setGate(w, "LAUNCH_RELAY", "runtime");
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('LAUNCH_RELAY', '"on"', 1, ?, 'test')`,
      NOW,
    );
    expect(await launchGateOn(w.env, w.db, "launch.relay")).toBe(true);
  });
});
