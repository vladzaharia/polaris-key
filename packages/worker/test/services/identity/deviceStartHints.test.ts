/// <reference types="@cloudflare/workers-types" />
/**
 * UK-42.22.2: the device-code start takes the hints and the licence-choice mode (WIRE-CONTRACT-V5
 * §12.10.1) and the card's request view serves them (§12.7.2).
 *
 *   - the four members are validated as `authorize` validates them: a bad `purpose` or
 *     `licenseChoice`, or a non-string member, is `400 bad_request` and writes nothing; a hint that
 *     does not normalise is dropped;
 *   - they are stored with the flow and the device request record and read back by the view, which
 *     has no `scope`;
 *   - the start's answer does not change, and a start that sends none of them is card mode with
 *     the view it always had.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import { loadProduct, type Product } from "../../../src/core/products.js";
import { serializeServices } from "../../../src/core/services.js";
import { setServices } from "../../../src/core/products/store.js";
import {
  handleAuthDeviceEntry,
  handleAuthDeviceStart,
} from "../../../src/services/identity/oidc.js";
import { handlePortalApi } from "../../portalHarness.js";
import { deviceFlowKey } from "../../../src/services/identity/productOidc/config.js";
import { getArtefact } from "../../../src/core/singleUse.js";

const ORIGIN = "https://key.plrs.im";
const SLUG = "tidewater";

function services(): string {
  return serializeServices({
    services: {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: true },
      sync: { enabled: false },
      commerce: { enabled: false },
      connect: { enabled: false },
    },
  });
}

interface World {
  kv: KvMock;
  db: Db;
  env: Env;
  product: Product;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET name = ? WHERE slug = ?",
    "Tidewater",
    SLUG,
  );
  await setServices(db, SLUG, services(), "manifest", NOW);
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    SLUG,
    "custom",
    "https://id.example",
    "client-tidewater",
    null,
    JSON.stringify([`${ORIGIN}/${SLUG}/identity/auth/callback`]),
    JSON.stringify({}),
  );
  return { kv, db, env, product: (await loadProduct(env, db, SLUG))! };
}

function start(w: World, body: Record<string, unknown>): Promise<Response> {
  return handleAuthDeviceStart(
    new Request(`${ORIGIN}/${SLUG}/identity/auth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "deck-1", ...body }),
    }),
    w.env,
    w.db,
    w.product,
  );
}

/** Open the confirmation page: the handle on the form, and the binder cookie. */
async function confirmationPage(
  w: World,
  userCode: string,
): Promise<{ handle: string; cookie: string }> {
  const res = await handleAuthDeviceEntry(
    new Request(
      `${ORIGIN}/${SLUG}/identity/auth/device?user_code=${userCode}`,
      {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      },
    ),
    w.env,
    w.product,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /data-request="(rq_[A-Za-z0-9_-]{22})"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  return {
    handle: handle!,
    cookie: res.headers.get("set-cookie")!.split(";")[0]!,
  };
}

async function view(
  w: World,
  userCode: string,
): Promise<Record<string, unknown>> {
  const page = await confirmationPage(w, userCode);
  const path = `/api/signin/requests/${page.handle}`;
  const res = await handlePortalApi(
    new Request(`${ORIGIN}${path}`, { headers: { cookie: page.cookie } }),
    w.env,
    w.db,
    path,
    NOW,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const STARTED_KEYS = [
  "status",
  "deviceCode",
  "userCode",
  "verificationUri",
  "verificationUriComplete",
  "expiresIn",
  "interval",
  "pollUrl",
  "deviceName",
];

describe("the device start's hints (§12.10.1)", () => {
  it("serves the four members in the card's view, with no scope", async () => {
    const w = await world();
    const res = await start(w, {
      deviceName: "Den PC",
      loginHint: "Ada@Example.com",
      nameHint: "  Ada\u202e Lovelace ",
      purpose: "attach",
      licenseChoice: "app",
    });
    expect(res.status).toBe(200);
    const started = (await res.json()) as { userCode: string };
    const v = await view(w, started.userCode);
    expect(v).toMatchObject({
      purpose: "attach",
      licenseChoice: "app",
      loginHint: "ada@example.com",
      nameHint: "Ada Lovelace",
      deviceLabel: "Den PC",
    });
    expect(v).not.toHaveProperty("scope");
  });

  it("changes nothing in the start's answer", async () => {
    const w = await world();
    const plain = (await (await start(w, {})).json()) as Record<
      string,
      unknown
    >;
    const hinted = (await (
      await start(w, {
        purpose: "attach",
        licenseChoice: "app",
        loginHint: "a@b.co",
      })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(plain).sort()).toEqual([...STARTED_KEYS].sort());
    expect(Object.keys(hinted).sort()).toEqual([...STARTED_KEYS].sort());
  });

  it("stores them on the device flow record", async () => {
    const w = await world();
    const started = (await (
      await start(w, {
        purpose: "attach",
        licenseChoice: "app",
        nameHint: "Ada",
      })
    ).json()) as { deviceCode: string };
    const raw = await getArtefact(
      w.env,
      await deviceFlowKey(w.env, SLUG, started.deviceCode),
    );
    expect(JSON.parse(raw!).hints).toEqual({
      purpose: "attach",
      licenseChoice: "app",
      loginHint: null,
      nameHint: "Ada",
    });
  });

  it("defaults the members the start left out, as authorize does", async () => {
    const w = await world();
    const started = (await (
      await start(w, { licenseChoice: "app" })
    ).json()) as {
      userCode: string;
    };
    expect(await view(w, started.userCode)).toMatchObject({
      purpose: "signin",
      licenseChoice: "app",
      loginHint: null,
      nameHint: null,
    });
  });

  it("drops a hint that does not normalise, never an error", async () => {
    const w = await world();
    const started = (await (
      await start(w, { loginHint: "not an email", nameHint: " \u200b " })
    ).json()) as { userCode: string };
    expect(await view(w, started.userCode)).toMatchObject({
      purpose: "signin",
      licenseChoice: "card",
      loginHint: null,
      nameHint: null,
    });
  });

  it("a start with none of the members is card mode with the view it always had", async () => {
    const w = await world();
    const started = (await (await start(w, { deviceName: "TV" })).json()) as {
      deviceCode: string;
      userCode: string;
    };
    const v = await view(w, started.userCode);
    for (const k of [
      "purpose",
      "licenseChoice",
      "loginHint",
      "nameHint",
      "scope",
    ])
      expect(v).not.toHaveProperty(k);
    const raw = await getArtefact(
      w.env,
      await deviceFlowKey(w.env, SLUG, started.deviceCode),
    );
    expect(JSON.parse(raw!)).not.toHaveProperty("hints");
  });

  it.each([
    ["an unknown purpose", { purpose: "login" }],
    ["an unknown licenseChoice", { licenseChoice: "both" }],
    ["a non-string purpose", { purpose: 1 }],
    ["a non-string licenseChoice", { licenseChoice: true }],
    ["a non-string loginHint", { loginHint: ["a@b.co"] }],
    ["a non-string nameHint", { nameHint: 7 }],
    ["a null purpose", { purpose: null }],
  ])("%s is 400 bad_request and writes nothing", async (_n, extra) => {
    const w = await world();
    const res = await start(w, extra);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    // Refused before anything is written: no flow, no device record, no user code.
    expect([...w.kv.keys()]).toEqual([]);
  });

  it("ignores scope", async () => {
    const w = await world();
    const res = await start(w, {
      scope: "openid nonsense",
      licenseChoice: "app",
    });
    expect(res.status).toBe(200);
  });
});
