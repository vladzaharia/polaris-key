/// <reference types="@cloudflare/workers-types" />
// SYNC-MINSDK (D-39b): the key ring routes refuse an SDK build below its minimum with
// version_blocked. Fake values only.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../../seed.js";
import { adminCall } from "../../consoleAdminCall.js";
import { newKeys } from "../../deviceKeyFixtures.js";
import { dispatchWith } from "../../../src/dispatch.js";
import { loadProduct } from "../../../src/core/products.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { setDeviceSubject } from "../../../src/core/accounts/accountSubjects.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import { handleActivate } from "../../../src/services/license/activation.js";
import { upsertDeviceKeys } from "../../../src/core/devices/keys.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";
import { belowMinimum } from "../../../src/core/keyring/minSdk.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

const P = "djdl";
const OP_GROUP = "platform-admins";
const D1 = "dev-ring-1";
const D2 = "dev-ring-2";

interface World {
  db: Db;
  env: Env;
  key: string;
  tokens: Record<string, string>;
  subject: string;
}

async function enable(db: Db, sync: boolean): Promise<void> {
  const on = (enabled: boolean) => ({ enabled });
  await setServices(
    db,
    P,
    serializeServices({
      services: {
        license: on(true),
        config: on(true),
        release: on(false),
        distribution: on(false),
        update: on(false),
        identity: on(true),
        sync: on(sync),
        commerce: on(false),
        connect: on(false),
      },
    }),
    "manifest",
    NOW,
  );
}

/** Sign the email in and bind its pairwise subject to the device. */
async function bindSubject(w: World, id: string, email: string) {
  const who = { issuerKey: "email", subject: email, kind: "email" } as const;
  const r = await signIn(w.db, who, NOW, {
    unfenced: true,
    product: { slug: P },
  });
  if (r.status !== "signed_in") throw new Error(`sign-in ${r.status}`);
  const subject = r.subject!;
  expect(await setDeviceSubject(w.env, w.db, P, id, subject)).toBe(true);
  return subject;
}

async function addDevice(w: World, id: string, email: string | null) {
  const product = (await loadProduct(w.env, w.db, P))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${w.key}`, "x-pkey-device": id }),
    w.env,
    w.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  w.tokens[id] = ((await res.json()) as { token: string }).token;
  if (email) w.subject = await bindSubject(w, id, email);
  const k = await newKeys();
  await upsertDeviceKeys(w.db, P, id, k, NOW);
}

async function world(sync = true): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  await seedProduct(db, P);
  await enable(db, sync);
  const { key } = await seedLicenseWithKey(db, P);
  const w: World = { db, env, key, tokens: {}, subject: "" };
  await addDevice(w, D1, "ada@example.com");
  await addDevice(w, D2, "ada@example.com");
  return w;
}

const MIN_KEY = (sdk: string) => `cloudSync.minSdk.${sdk}`;

/** Set a minimum the way an operator does: the console's platform settings route. */
async function setMin(
  w: World | { db: Db; env: Env },
  sdk: string,
  value: string,
): Promise<void> {
  const { db, env } = w;
  env.ADMIN_SESSION_SECRET = "min-sdk-secret";
  env.PLATFORM_ADMIN_GROUP = OP_GROUP;
  const row = await db.first<{ version: number }>(
    "SELECT version FROM platform_settings WHERE key = ?",
    MIN_KEY(sdk),
  );
  const res = await adminCall(
    env,
    db,
    `/api/platform/settings/${MIN_KEY(sdk)}`,
    {
      method: "PATCH",
      body: { value, expectedVersion: row?.version ?? 0 },
    },
  );
  expect(res.status).toBe(200);
  // The activations before this write already read the settings; drop that snapshot.
  invalidatePlatformSettings(env, db);
}

const ROUTES: [string, string][] = [
  ["GET", ""],
  ["POST", ""],
  ["PUT", `/wraps/${D2}`],
  ["DELETE", `/wraps/${D1}`],
  ["GET", "/recovery"],
  ["PUT", "/recovery"],
  ["POST", "/adopt"],
  ["POST", "/reset"],
];

async function call(
  w: World,
  method: string,
  path: string,
  sdk?: [string, string],
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${w.tokens[D1]}`,
  };
  if (sdk) {
    headers["x-pkey-sdk"] = sdk[0];
    headers["x-pkey-sdk-version"] = sdk[1];
  }
  const res = await dispatchWith(
    new Request(`https://key.plrs.im/${P}/devices/keyring${path}`, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    }),
    w.env,
    w.db,
    NOW,
  );
  const text = await res.text();
  return {
    status: res.status,
    body: text.startsWith("{") ? JSON.parse(text) : text,
  };
}

const BLOCKED = { error: { code: "version_blocked" } };

describe("the key ring minimum SDK build (D-39b)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await setMin(w, "swift", "0.10.0");
  });

  it("a key-ring read from an SDK below its minimum answers version_blocked", async () => {
    const r = await call(w, "GET", "", ["swift", "0.9.4"]);
    expect(r.status).toBe(403);
    expect(r.body).toEqual(BLOCKED);
    const ok = await call(w, "GET", "", ["swift", "0.10.0"]);
    expect(ok.status).toBe(200);
  });

  it("every devices/keyring route applies the minimum", async () => {
    for (const [method, path] of ROUTES) {
      const r = await call(w, method, path, ["swift", "0.9.0"]);
      expect([method, path, r.status, r.body]).toEqual([
        method,
        path,
        403,
        BLOCKED,
      ]);
    }
  });

  it("a placeholder or headerless build passes", async () => {
    for (const v of ["0.0.0", "0.1.0", "0.2.0", "0.1.0-main.7"]) {
      expect((await call(w, "GET", "", ["swift", v])).status).toBe(200);
    }
    expect((await call(w, "GET", "")).status).toBe(200);
    expect((await call(w, "GET", "", ["swift", "not-a-version"])).status).toBe(
      200,
    );
    // An SDK with no minimum, and the legacy spelling of one with a minimum.
    expect((await call(w, "GET", "", ["kotlin", "0.3.0"])).status).toBe(200);
    expect(
      (await call(w, "GET", "", ["PolarisKeySwift", "0.9.0"])).status,
    ).toBe(403);
  });

  it("an unset minimum gates nothing", async () => {
    const fresh = await world();
    for (const [method, path] of ROUTES) {
      const r = await call(fresh, method, path, ["swift", "0.3.0"]);
      expect(r.body).not.toEqual(BLOCKED);
    }
  });

  it("a server-mode product keeps the 404", async () => {
    const off = await world(false);
    await setMin(off, "swift", "0.10.0");
    expect((await call(off, "GET", "", ["swift", "0.9.0"])).status).toBe(404);
  });

  it("each SDK has its own minimum", async () => {
    await setMin(w, "kotlin", "1.2.0");
    expect((await call(w, "GET", "", ["kotlin", "1.1.9"])).status).toBe(403);
    expect((await call(w, "GET", "", ["kotlin", "1.2.0"])).status).toBe(200);
    expect((await call(w, "GET", "", ["godot", "0.0.1"])).status).toBe(200);
  });
});

describe("belowMinimum", () => {
  it("compares stamped versions by major.minor.patch, pre-releases by their base", () => {
    expect(belowMinimum("0.9.9", "0.10.0")).toBe(true);
    expect(belowMinimum("0.10.0", "0.10.0")).toBe(false);
    expect(belowMinimum("1.0.0", "0.10.0")).toBe(false);
    expect(belowMinimum("0.10.0-main.3", "0.10.0")).toBe(false);
    expect(belowMinimum("0.9.0-main.3", "0.10.0")).toBe(true);
    expect(belowMinimum("0.10.0+build5", "0.10.0")).toBe(false);
    expect(belowMinimum("0.2.0", "0.10.0")).toBe(false);
    expect(belowMinimum("0.0.0", "1.0.0")).toBe(false);
    expect(belowMinimum("junk", "0.10.0")).toBe(false);
    expect(belowMinimum("0.9.0", "junk")).toBe(false);
  });
});
