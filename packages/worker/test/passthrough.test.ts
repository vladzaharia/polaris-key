/**
 * PX-W13 — passthrough request metadata (WIRE-CONTRACT-V4 §12.7; plans/PX-W13.md §2, §6; G28).
 *
 *   - `/device/start` normalises the device label and echoes it (§12.7.1);
 *   - the device-code confirmation page creates a browser-bound request handle (§12.7.2);
 *   - `GET /api/signin/requests/:handle` answers the client record, the label and the user code,
 *     and ignores every display query parameter;
 *   - `GET /api/signin/requests/:handle/consent` answers app consent with `scopeHash`, `firstTime`
 *     and `changed` (§12.7.3);
 *   - activation and registration seed `devices.label` from `deviceName` only while it is NULL.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import {
  loadProduct,
  loadProductPublic,
  type Product,
} from "../src/core/products.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import {
  handleAuthDeviceEntry,
  handleAuthDeviceStart,
} from "../src/services/identity/oidc.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { REQUEST_BINDER_COOKIE } from "../src/services/identity/passthrough/request.js";
import { consentScope } from "../src/services/identity/passthrough/routes.js";
import { handlePortalApi } from "./portalHarness.js";
import { dispatchWith } from "../src/dispatch.js";
import { SETTINGS } from "../src/mount.js";
import { resolveProductSetting } from "../src/core/settings/resolve.js";
import { COMBINED_ENTITLEMENT_MODEL_SINCE } from "../src/services/license/licensingSettings.js";
import {
  entitlementModelFor,
  licenseConsentItem,
  resolvedEntitlementModel,
} from "../src/services/identity/passthrough/anchor.js";

const ORIGIN = "https://key.plrs.im";
/** A well-formed device id (32 base64url characters, as `devices/register` requires). */
const TEST_DEVICE = "A".repeat(32);
const SLUG = "tidewater";

function services(over: Partial<ServicesMap> = {}): string {
  return serializeServices({
    services: {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: true },
      sync: { enabled: false },
      ...over,
    },
  });
}

interface World {
  db: Db;
  env: Env;
  product: Product;
}

async function world(name = "Tidewater"): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, SLUG);
  await db.run("UPDATE products SET name = ? WHERE slug = ?", name, SLUG);
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
  return { db, env, product: (await loadProduct(env, db, SLUG))! };
}

async function start(
  w: World,
  deviceName?: unknown,
): Promise<{ userCode: string; deviceName: string | null }> {
  const res = await handleAuthDeviceStart(
    new Request(`${ORIGIN}/${SLUG}/identity/auth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "deck-1", deviceName }),
    }),
    w.env,
    w.db,
    w.product,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { userCode: string; deviceName: string | null };
}

/** Open the confirmation page: the handle on the form, and the binder cookie if one was set. */
async function confirmationPage(
  w: World,
  userCode: string,
  cookie?: string,
): Promise<{ handle: string; binderCookie: string | null; html: string }> {
  const res = await handleAuthDeviceEntry(
    new Request(
      `${ORIGIN}/${SLUG}/identity/auth/device?user_code=${userCode}`,
      {
        headers: {
          "cf-connecting-ip": "203.0.113.9",
          ...(cookie ? { cookie } : {}),
        },
      },
    ),
    w.env,
    w.product,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /data-request="(rq_[A-Za-z0-9_-]{22})"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  const set = res.headers.get("set-cookie");
  return {
    handle: handle!,
    binderCookie: set ? set.split(";")[0]! : null,
    html,
  };
}

/** A JSON body, loosely typed for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: Response): Promise<any> => res.json();

function api(
  w: World,
  path: string,
  cookie?: string,
  method = "GET",
): Promise<Response> {
  return handlePortalApi(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: cookie ? { cookie } : {},
    }),
    w.env,
    w.db,
    path.split("?")[0]!,
    NOW,
  );
}

async function portalCookie(w: World): Promise<{ cookie: string; id: string }> {
  const account = await getOrCreateAccountByEmail(w.db, "ada@example.com", NOW);
  // I-07: a row-backed session, as a sign-in opens one (a bare signed cookie is refused).
  const { token } = await issuePortalSessionRow(
    w.env,
    w.db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, id: account.id };
}

describe("the device label on /device/start (§12.7.1)", () => {
  it("is normalised and echoed", async () => {
    const w = await world();
    const begun = await start(w, "  Living room TV\u202egnp.exe\t");
    expect(begun.deviceName).toBe("Living room TVgnp.exe");
  });

  it("echoes null when nothing is left, and never rejects", async () => {
    const w = await world();
    expect((await start(w, " \u200b ")).deviceName).toBeNull();
    expect((await start(w)).deviceName).toBeNull();
    expect((await start(w, 42)).deviceName).toBeNull();
  });

  it("the legacy page shows the stored label", async () => {
    const w = await world();
    const { userCode } = await start(w, "Den\u202aPC");
    const { html } = await confirmationPage(w, userCode);
    expect(html).toContain("DenPC");
    expect(html).not.toContain("\u202a");
  });
});

describe("GET /api/signin/requests/:handle (§12.7.2)", () => {
  it("answers the client record, the label and the user code to the binding browser", async () => {
    const w = await world();
    const { userCode } = await start(w, "Living room TV");
    const page = await confirmationPage(w, userCode);
    expect(page.binderCookie).toMatch(
      new RegExp(`^${REQUEST_BINDER_COOKIE}=[A-Za-z0-9_-]{43}$`),
    );
    const res = await api(
      w,
      `/api/signin/requests/${page.handle}`,
      page.binderCookie!,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      request: page.handle,
      client: {
        product: SLUG,
        kind: "device",
        appName: "Tidewater",
        developerName: null,
        iconUrl: null,
        origins: [],
        services: { license: true, cloudSync: false },
        nameVerified: true,
      },
      deviceLabel: "Living room TV",
      userCode,
      // The page runs on the real clock; the handle lives for the flow's ten minutes.
      expiresAt: expect.any(Number),
    });
  });

  it("the binder cookie is __Host-, HttpOnly, Secure and SameSite=Lax", async () => {
    const w = await world();
    const { userCode } = await start(w, "TV");
    const res = await handleAuthDeviceEntry(
      new Request(
        `${ORIGIN}/${SLUG}/identity/auth/device?user_code=${userCode}`,
      ),
      w.env,
      w.product,
    );
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/^__Host-pk_req=/);
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
      expect(set).toContain(attr);
  });

  it("ignores every display query parameter", async () => {
    const w = await world();
    const { userCode } = await start(w, "Living room TV");
    const page = await confirmationPage(w, userCode);
    const plain = await body(
      await api(w, `/api/signin/requests/${page.handle}`, page.binderCookie!),
    );
    const spoof = new URLSearchParams({
      appName: "Steam",
      name: "Google Play",
      icon: "https://evil.example/icon.png",
      developer: "Valve",
      origin: "https://evil.example",
      device: "Your bank",
    });
    const spoofed = await api(
      w,
      `/api/signin/requests/${page.handle}?${spoof}`,
      page.binderCookie!,
    );
    expect(spoofed.status).toBe(200);
    const spoofedBody = await body(spoofed);
    expect(spoofedBody).toEqual(plain);
    expect(JSON.stringify(spoofedBody)).not.toMatch(
      /Steam|Google|evil|Valve|bank/,
    );
    // The capabilities route reads no display parameter either.
    const caps = await api(w, `/api/capabilities?product=${SLUG}&${spoof}`);
    expect(JSON.stringify(await caps.json())).not.toMatch(/Steam|Google|evil/);
  });

  it("one browser keeps one binder for all its handles", async () => {
    const w = await world();
    const a = await start(w, "A");
    const first = await confirmationPage(w, a.userCode);
    const b = await start(w, "B");
    const second = await confirmationPage(w, b.userCode, first.binderCookie!);
    expect(second.binderCookie).toBeNull();
    const res = await api(
      w,
      `/api/signin/requests/${second.handle}`,
      first.binderCookie!,
    );
    expect(res.status).toBe(200);
    expect((await body(res)).deviceLabel).toBe("B");
  });

  it("404 for another browser, no binder, an unknown or malformed handle", async () => {
    const w = await world();
    const { userCode } = await start(w, "TV");
    const page = await confirmationPage(w, userCode);
    const other = await confirmationPage(w, (await start(w, "X")).userCode);
    const unknown = `rq_${"B".repeat(22)}`;
    const answers = [
      await api(w, `/api/signin/requests/${page.handle}`, other.binderCookie!),
      await api(w, `/api/signin/requests/${page.handle}`),
      await api(w, `/api/signin/requests/${unknown}`, page.binderCookie!),
      await api(w, `/api/signin/requests/not-a-handle`, page.binderCookie!),
      await api(
        w,
        `/api/signin/requests/${page.handle}`,
        `${page.binderCookie}; ${page.binderCookie!.replace(/=.*/, "=" + "C".repeat(43))}`,
      ),
    ];
    const bodies = [];
    for (const res of answers) {
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("404 once the product's Identity toggle is off", async () => {
    const w = await world();
    const { userCode } = await start(w, "TV");
    const page = await confirmationPage(w, userCode);
    await setServices(
      w.db,
      SLUG,
      services({ identity: { enabled: false } }),
      "admin",
      NOW,
    );
    const res = await api(
      w,
      `/api/signin/requests/${page.handle}`,
      page.binderCookie!,
    );
    expect(res.status).toBe(404);
  });

  it("only GET", async () => {
    const w = await world();
    const { userCode } = await start(w, "TV");
    const page = await confirmationPage(w, userCode);
    const res = await api(
      w,
      `/api/signin/requests/${page.handle}`,
      page.binderCookie!,
      "DELETE",
    );
    expect(res.status).toBe(405);
  });

  it("a reserved app name renders as the slug, unverified (render-time re-check)", async () => {
    const w = await world("Steam Companion");
    const { userCode } = await start(w, "TV");
    const page = await confirmationPage(w, userCode);
    const view = await body(
      await api(w, `/api/signin/requests/${page.handle}`, page.binderCookie!),
    );
    expect(view.client.appName).toBe(SLUG);
    expect(view.client.nameVerified).toBe(false);
  });
});

describe("GET /api/signin/requests/:handle/consent (§12.7.3)", () => {
  it("needs the portal session and the binder", async () => {
    const w = await world();
    const page = await confirmationPage(w, (await start(w, "TV")).userCode);
    const s = await portalCookie(w);
    expect(
      (
        await api(
          w,
          `/api/signin/requests/${page.handle}/consent`,
          page.binderCookie!,
        )
      ).status,
    ).toBe(401);
    expect(
      (await api(w, `/api/signin/requests/${page.handle}/consent`, s.cookie))
        .status,
    ).toBe(404);
  });

  it("first time, then recorded, then changed", async () => {
    const w = await world();
    const page = await confirmationPage(w, (await start(w, "TV")).userCode);
    const s = await portalCookie(w);
    const cookie = `${s.cookie}; ${page.binderCookie}`;
    const path = `/api/signin/requests/${page.handle}/consent`;

    const first = await body(await api(w, path, cookie));
    const scope = await consentScope(["name", "picture", "email"], ["license"]);
    expect(first).toEqual({
      request: page.handle,
      person: {
        displayName: "ada@example.com",
        email: "ada@example.com",
        avatarUrl: null,
      },
      items: [
        { kind: "license", anchor: null, more: 0 },
        { kind: "profile", claims: ["name", "picture", "email"] },
      ],
      scopeHash: scope,
      firstTime: true,
      changed: false,
    });
    expect(scope).toMatch(/^[0-9a-f]{64}$/);

    await w.db.run(
      "INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at, scope_hash) VALUES (?,?,?,?,?,?)",
      s.id,
      SLUG,
      null,
      NOW,
      NOW,
      scope,
    );
    const again = await body(await api(w, path, cookie));
    expect([again.firstTime, again.changed]).toEqual([false, false]);

    await w.db.run(
      "UPDATE account_product_grants SET scope_hash = ? WHERE account_id = ?",
      "0".repeat(64),
      s.id,
    );
    const changed = await body(await api(w, path, cookie));
    expect([changed.firstTime, changed.changed]).toEqual([false, true]);
  });

  it("a consent recorded before scopes (NULL) asks once more", async () => {
    const w = await world();
    const page = await confirmationPage(w, (await start(w, "TV")).userCode);
    const s = await portalCookie(w);
    await w.db.run(
      "INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at) VALUES (?,?,?,?,?)",
      s.id,
      SLUG,
      null,
      NOW,
      NOW,
    );
    const view = await body(
      await api(
        w,
        `/api/signin/requests/${page.handle}/consent`,
        `${s.cookie}; ${page.binderCookie}`,
      ),
    );
    expect([view.firstTime, view.changed]).toEqual([false, true]);
  });

  it("the scope hash ignores order and changes with the services", async () => {
    const a = await consentScope(["email", "name"], ["license"]);
    expect(await consentScope(["name", "email"], ["license"])).toBe(a);
    expect(
      await consentScope(["email", "name"], ["license", "cloudSync"]),
    ).not.toBe(a);
  });
});

describe("the label on activation and registration (§8 Q2)", () => {
  async function activate(
    w: World,
    key: string,
    body: unknown,
    device = TEST_DEVICE,
  ): Promise<Response> {
    return dispatchWith(
      new Request(`${ORIGIN}/${SLUG}/license/activate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "x-pkey-device": device,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      w.env,
      w.db,
      NOW,
    );
  }

  const labelOf = async (w: World, device = TEST_DEVICE) =>
    (
      await w.db.first<{ label: string | null }>(
        "SELECT label FROM devices WHERE product = ? AND device_id = ?",
        SLUG,
        device,
      )
    )?.label;

  it("seeds the label, normalised, only while the row has none", async () => {
    const w = await world();
    const { key } = await seedLicenseWithKey(w.db, SLUG);
    expect(
      (await activate(w, key, { deviceName: " Den\u202e PC " })).status,
    ).toBe(200);
    expect(await labelOf(w)).toBe("Den PC");
    expect((await activate(w, key, { deviceName: "Other" })).status).toBe(200);
    expect(await labelOf(w)).toBe("Den PC");
  });

  it("a rename wins over what the device reports", async () => {
    const w = await world();
    const { key } = await seedLicenseWithKey(w.db, SLUG);
    await activate(w, key, {});
    expect(await labelOf(w)).toBeNull();
    await w.db.run(
      "UPDATE devices SET label = 'Kitchen' WHERE product = ? AND device_id = ?",
      SLUG,
      TEST_DEVICE,
    );
    await activate(w, key, { deviceName: "Den PC" });
    expect(await labelOf(w)).toBe("Kitchen");
  });

  it("registration seeds it too", async () => {
    const w = await world();
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: false },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
          sync: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const res = await dispatchWith(
      new Request(`${ORIGIN}/${SLUG}/devices/register`, {
        method: "POST",
        headers: {
          "x-pkey-device": TEST_DEVICE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceName: "Studio\tMac" }),
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(await labelOf(w)).toBe("Studio Mac");
  });
});

describe("the consent view's entitlement model (decision D1 on LX-06)", () => {
  it("reads legacy for a product registered after the cut-over until LX-09 ships", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["fresh"]);
    await seedProduct(db, "fresh");
    await db.run(
      "UPDATE products SET created_at = ? WHERE slug = 'fresh'",
      COMBINED_ENTITLEMENT_MODEL_SINCE + 3600,
    );
    const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    for (const id of ["lic_a", "lic_b"])
      await db.run(
        `INSERT INTO licenses (product, id, status, activated_at, modified_at, account_id)
         VALUES ('fresh', ?, 'active', ?, ?, ?)`,
        id,
        NOW,
        NOW,
        account.id,
      );
    const product = (await loadProductPublic(db, "fresh"))!;
    const ctx = { env, db, registry: SETTINGS };
    // The resolver already answers `combined` for it (registered past the cut-over)…
    expect(
      (await resolveProductSetting(ctx, "fresh", "licensing.entitlementModel"))
        ?.value,
    ).toBe("combined");
    expect(await resolvedEntitlementModel(ctx, product)).toBe("combined");
    // …and the licence line still reads `legacy`, counting no other licence, until LX-09.
    expect(await entitlementModelFor(ctx, product)).toBe("legacy");
    const item = await licenseConsentItem(db, account.id, product, NOW, {
      env,
      registry: SETTINGS,
    });
    expect(item.anchor).not.toBeNull();
    expect(item.more).toBe(0);
  });
});
