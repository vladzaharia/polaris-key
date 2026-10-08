/**
 * Shared world for the commerce bridge suites (P6-01): the djdl product with License, Release and
 * Distribution on, two licences (A and B) each with an activated device, a device with no licence,
 * the three store credentials stored and pinned as an operator would (`putOutletCredential`), the
 * commerce settings and store-product map set through the real admin API, and the fake stores
 * (`commerceFake.ts`) as the global fetch. The App Store root is the generated test root
 * (`setAppleRootsForTesting`), restored by `close()`.
 */

import { generateKeyPairSync } from "node:crypto";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { dispatchWith } from "../src/dispatch.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import { loadProduct } from "../src/core/products.js";
import { registerDeviceBinding } from "../src/core/devices.js";
import { setAppleRootsForTesting } from "../src/services/distribution/commerce/apple.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { makeTestDb } from "./helpers.js";
import {
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import { NOW, seedLicenseWithKey } from "./seed.js";
import {
  AppleFake,
  APPLE_PRODUCT,
  BUNDLE_ID,
  GoogleFake,
  PLAY_PACKAGE,
  PLAY_SKU,
  PUSH_ACCOUNT,
  PUSH_AUDIENCE,
  STEAM_APP,
  STEAM_DLC,
  STEAM_KEY,
  SteamFake,
  fakeFetch,
  type CommerceFakes,
} from "./commerceFake.js";

export const FLAG = "extras.diceSkins";

/** The catalog a mapping is checked against: FLAG and `extras.other` as `flag`s, and one `config`
 *  key that is not one. */
export const COMMERCE_CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: FLAG,
      kind: "flag",
      category: "Extras",
      label: "Dice skins",
      description: "",
      schema: { type: "boolean" },
    },
    {
      key: "extras.other",
      kind: "flag",
      category: "Extras",
      label: "Other extras",
      description: "",
      schema: { type: "boolean" },
    },
    {
      key: "extras.theme",
      kind: "config",
      category: "Extras",
      label: "Theme",
      description: "",
      schema: { type: "string" },
    },
  ],
};

export interface CommerceWorld {
  env: Env;
  db: Db;
  fakes: CommerceFakes;
  /** Device tokens: licence A, licence B, and a device with no licence. */
  tokenA: string;
  tokenB: string;
  tokenNone: string;
  licenseA: string;
  licenseB: string;
  now: number;
  close(): void;
}

function p8(): string {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}

function rsa(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}

export async function withFetch<T>(
  w: CommerceWorld,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = fakeFetch(w.fakes, () => w.now) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

/** A product request through the real router, at the world's clock, with the fakes as fetch. */
export function route(
  w: CommerceWorld,
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return withFetch(w, () =>
    dispatchWith(
      new Request(`${CONSOLE}/${SLUG}${path}`, {
        method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      w.env,
      w.db,
      w.now,
    ),
  );
}

/** The console API as a platform admin. */
export async function admin(
  w: Pick<CommerceWorld, "env" | "db">,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    w.env,
    w.db,
    full,
    { now: NOW },
  );
}

async function activate(
  env: Env,
  db: Db,
  key: string,
  device: string,
): Promise<string> {
  const res = await dispatchWith(
    new Request(`${CONSOLE}/${SLUG}/license/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-pkey-device": device },
    }),
    env,
    db,
    NOW,
  );
  if (res.status !== 200)
    throw new Error(`activate: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

export const SETTINGS = {
  appStore: { bundleId: BUNDLE_ID, appAppleId: 1234567890 },
  play: {
    packageName: PLAY_PACKAGE,
    pushAudience: PUSH_AUDIENCE,
    pushServiceAccount: PUSH_ACCOUNT,
  },
  steam: { appId: STEAM_APP },
};

export async function commerceWorld(
  opts: {
    settings?: Record<string, unknown>;
    credentials?: boolean;
    products?: boolean;
  } = {},
): Promise<CommerceWorld> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  await db.run(
    "UPDATE product_schema SET catalog_json = ? WHERE product = ? AND active = 1",
    JSON.stringify(COMMERCE_CATALOG),
    SLUG,
  );
  const env = envFor();
  const a = await seedLicenseWithKey(db, SLUG, { id: "lic_a" });
  const b = await seedLicenseWithKey(db, SLUG, { id: "lic_b" });
  const tokenA = await activate(env, db, a.key, "dev-a");
  const tokenB = await activate(env, db, b.key, "dev-b");
  const product = (await loadProduct(env, db, SLUG))!;
  const none = await registerDeviceBinding(env, db, product, "dev-none", NOW, {
    existing: null,
    presented: null,
    metadata: {
      userAgent: null,
      platform: null,
      arch: null,
      appVersion: null,
      sdkName: null,
      sdkVersion: null,
    },
  });

  if (opts.credentials !== false) {
    const put = async (
      id: string,
      kind: never,
      value: unknown,
      pin: string,
    ) => {
      const r = await putOutletCredential(env, db, {
        product: SLUG,
        credentialId: id,
        kind,
        outletId: null,
        value,
        pin,
        expiresAt: null,
        actor: "admin-1",
        now: NOW,
      });
      if (!r.ok) throw new Error(r.message);
    };
    await put(
      "iap",
      "app-store-server-key" as never,
      {
        keyId: "IAPKEY1234",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: p8(),
      },
      BUNDLE_ID,
    );
    await put(
      "play",
      "google-service-account" as never,
      {
        type: "service_account",
        client_email: "pkey@acme-djdl.iam.gserviceaccount.com",
        private_key: rsa(),
        token_uri: "https://oauth2.googleapis.com/token",
      },
      PLAY_PACKAGE,
    );
    await put(
      "steam",
      "steam-publisher-key" as never,
      { key: STEAM_KEY },
      STEAM_APP,
    );
  }

  const fakes: CommerceFakes = {
    apple: await AppleFake.create(NOW),
    google: await GoogleFake.create(),
    steam: new SteamFake(),
    foreign: [],
  };
  setAppleRootsForTesting([fakes.apple.chain.root]);
  const w: CommerceWorld = {
    env,
    db,
    fakes,
    tokenA,
    tokenB,
    tokenNone: none.token,
    licenseA: a.licenseId,
    licenseB: b.licenseId,
    now: NOW,
    close: () => setAppleRootsForTesting(null),
  };

  const s = await admin(
    w,
    "PUT",
    "/commerce/settings",
    opts.settings ?? SETTINGS,
  );
  if (s.status !== 200)
    throw new Error(`settings: ${s.status} ${await s.text()}`);
  if (opts.products !== false)
    for (const [store, productId] of [
      ["app-store", APPLE_PRODUCT],
      ["play", PLAY_SKU],
      ["steam", STEAM_DLC],
    ] as const) {
      const r = await admin(w, "PUT", "/commerce/products", {
        store,
        productId,
        flag: FLAG,
      });
      if (r.status !== 200)
        throw new Error(`product: ${r.status} ${await r.text()}`);
    }
  return w;
}

/** The binding of a device's licence (through the route). */
export async function bindingOf(
  w: CommerceWorld,
  token: string,
): Promise<string> {
  const res = await route(w, "GET", "/distribution/commerce/binding", {
    token,
  });
  if (res.status !== 200) throw new Error(`binding: ${res.status}`);
  return ((await res.json()) as { bindingId: string }).bindingId;
}

/** Active grants of a licence, by flag. */
export async function grants(
  w: CommerceWorld,
  licenseId: string,
): Promise<string[]> {
  const rows = await w.db.all<{ flag: string; store: string }>(
    "SELECT flag, store FROM license_store_grants WHERE product = ? AND license_id = ? AND state = 'active' ORDER BY store",
    SLUG,
    licenseId,
  );
  return rows.map((r) => `${r.store}:${r.flag}`);
}

/** The licence document's entitlements for a device (decoded, not verified — the licensing
 *  suites verify the envelope). */
export async function entitlements(
  w: CommerceWorld,
  token: string,
): Promise<Record<string, { value: unknown; state: string }>> {
  const res = await route(w, "GET", "/license/document", {
    token,
    headers: { "x-pkey-version": "1.0.0" },
  });
  if (res.status !== 200)
    throw new Error(`document: ${res.status} ${await res.text()}`);
  const jws = await res.text();
  const payload = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(jws.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      ),
    ),
  ) as { entitlements: Record<string, { value: unknown; state: string }> };
  return payload.entitlements;
}

/** One connector-cron tick through the real `scheduled.ts` entry. */
export function tick(w: CommerceWorld, now: number) {
  return withFetch(w, () => runConnectorPolls(w.env, w.db, now));
}
