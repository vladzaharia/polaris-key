/// <reference types="@cloudflare/workers-types" />

// `POST /<product>/devices/register` — the keyless device-token mint (WIRE-CONTRACT-V3 §6,
// design spec §2.3), plus the Core surfaces it makes reachable for a product with no License
// service at all (D-08).
//
// The three things worth pinning here fail in three different ways:
//
//   1. THE POLICY MATRIX. `open` mints; the other two refuse with ONE body, so an
//      unauthenticated prober cannot tell `requires-license` from `requires-identity` and map
//      which products run which services.
//   2. THE TOKEN. `pkeyt_` is minted and `pkeyt_` is refused — the latter on shape, so the
//      refusal is a property of the code and not of what happens to be in the token table.
//   3. THE RELAXATION. `/devices`, `/devices/report` and edge-mint accept a registered device
//      when License is off, and are UNCHANGED when License is on. The second half is the one
//      that would silently regress.

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  RETIRED_DEVICE_TOKEN,
  seedLicenseWithKey,
  seedProduct,
  approveEdgeMintRecipe,
  seedProductSecret,
  UNKNOWN_DEVICE_TOKEN,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleRegister } from "../src/core/register.js";
import { SERVICES } from "../src/mount.js";
import {
  handleDevices,
  handleReport,
  NO_LICENSE_ID,
} from "../src/core/devices.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { handleMintToken } from "../src/services/config/mint.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { createBrowserSession } from "../src/services/identity/index.js";
import {
  serializeServices,
  validateServices,
  type ServicesMap,
} from "../src/core/services.js";
import { getDevice, getLicense, setServices } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

/** A well-formed device id: 32 base64url chars, the shape every SDK derives (§6). */
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";

const ES_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgav85fotyJ04AYsKF\nDojZziUJg9TuJamPiszlECztPLuhRANCAATgaZHNpIiLDSEQHY4H4BE5HnA9L8hR\n11WcM/ABvqCnO5CWZyHKWoEnKnKnmQwVibF2w5YwimX7Z1hIqJPHGCTB\n-----END PRIVATE KEY-----";

const SET = {
  /** The suite default: License + Config. Derived policy `requires-license`. */
  licensed: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: false },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
  },
  /** D-08: Config alone. Derived policy `open`. */
  configOnly: {
    license: { enabled: false },
    config: { enabled: true },
    release: { enabled: false },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
  },
  /** Config + Identity, License off. Derived policy `requires-identity`. */
  identity: {
    license: { enabled: false },
    config: { enabled: true },
    release: { enabled: false },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: true },
  },
} satisfies Record<string, ServicesMap>;

interface World {
  db: SqliteDb;
  env: Env;
  product: Product;
}

async function world(
  services: ServicesMap = SET.configOnly,
  registration?: "open" | "requires-identity" | "requires-license",
): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  await setServices(
    db,
    "djdl",
    serializeServices(
      registration === undefined ? { services } : { services, registration },
    ),
    "manifest",
    NOW,
  );
  const product = (await loadProduct(env, db, "djdl"))!;
  return { db, env, product };
}

function registerReq(
  headers: Record<string, string> = { "x-pkey-device": DEVICE },
  body?: unknown,
): Request {
  return mkReq("POST", headers, body);
}

async function register(
  w: World,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; token: string; deviceId: string }> {
  const res = await handleRegister(
    registerReq(headers, body),
    w.env,
    w.db,
    w.product,
    NOW,
    SERVICES,
  );
  const parsed =
    res.status === 200
      ? ((await res.json()) as { token: string; deviceId: string })
      : { token: "", deviceId: "" };
  return { status: res.status, ...parsed };
}

describe("POST /<p>/devices/register — policy matrix", () => {
  it("open: mints a pkeyt_ token bound to the client-supplied device id", async () => {
    const w = await world(SET.configOnly);
    expect(w.product.registration).toBe("open");

    const res = await register(w);
    expect(res.status).toBe(200);
    expect(res.token).toMatch(/^pkeyt_[A-Za-z0-9_-]{43}$/);
    expect(res.deviceId).toBe(DEVICE);

    // The row exists, is authorized, and carries NO licence — that is the whole point.
    const row = await getDevice(w.db, "djdl", DEVICE);
    expect(row?.status).toBe("authorized");
    expect(row?.license_id).toBe(NO_LICENSE_ID);
  });

  it("requires-license: 403 registration_closed, and no row is written", async () => {
    const w = await world(SET.licensed);
    expect(w.product.registration).toBe("requires-license");

    const res = await handleRegister(
      registerReq(),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "registration_closed" },
    });
    expect(await getDevice(w.db, "djdl", DEVICE)).toBeNull();
  });

  it("requires-identity with no session: the SAME 403 body as requires-license", async () => {
    const w = await world(SET.identity);
    expect(w.product.registration).toBe("requires-identity");

    const res = await handleRegister(
      registerReq(),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(403);
    // Byte-identical to the `requires-license` refusal: an anonymous caller learns that it may
    // not register, and nothing about which services this product runs.
    expect(await res.json()).toEqual({
      error: { code: "registration_closed" },
    });
    expect(await getDevice(w.db, "djdl", DEVICE)).toBeNull();
  });

  // ── the requires-identity exchange (P3) ───────────────────────────────────────────────────
  //
  // `requires-identity` is the one policy whose answer Core cannot compute. It asks the Identity
  // descriptor through `ServiceDescriptor.authorizeRegistration`, and what Identity accepts is a
  // live product browser session — the cookie `POST /<p>/identity/session/license` and the OIDC
  // callback both mint.

  /** A browser session for `slug`, as the identity surfaces mint it. Returns the cookie header. */
  async function browserSession(w: World, slug = "djdl"): Promise<string> {
    const { licenseId } = await seedLicenseWithKey(w.db, slug);
    const license = (await getLicense(w.db, slug, licenseId))!;
    const created = await createBrowserSession(
      w.env,
      w.db,
      w.product.slug === slug
        ? w.product
        : (await loadProduct(w.env, w.db, slug))!,
      license,
      NOW,
    );
    if (!created.ok) throw new Error(`session mint failed: ${created.code}`);
    return created.cookie.split(";")[0]!;
  }

  it("requires-identity with a valid browser session: mints the token", async () => {
    const w = await world(SET.identity);
    expect(w.product.registration).toBe("requires-identity");
    const cookie = await browserSession(w);

    const res = await register(w, { "x-pkey-device": DEVICE, cookie });
    expect(res.status).toBe(200);
    expect(res.token).toMatch(/^pkeyt_[A-Za-z0-9_-]{43}$/);
    expect(res.deviceId).toBe(DEVICE);

    // The minted device is the ORDINARY licence-less registration row — the session authorized
    // the mint, it did not lend the new device its licence.
    const row = await getDevice(w.db, "djdl", DEVICE);
    expect(row?.status).toBe("authorized");
    expect(row?.license_id).toBe(NO_LICENSE_ID);
  });

  it("requires-identity refuses a session whose device has been deauthorized", async () => {
    // The cookie alone proves nothing: a KV session record outlives logout and an operator
    // deauthorization, so the credential behind it has to still validate.
    const w = await world(SET.identity);
    const cookie = await browserSession(w);
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ?",
      "djdl",
    );

    const res = await handleRegister(
      registerReq({ "x-pkey-device": DEVICE, cookie }),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(403);
    expect(await getDevice(w.db, "djdl", DEVICE)).toBeNull();
  });

  it("requires-identity refuses another product's session", async () => {
    // Session keys are product-scoped in KV, so a cookie minted for `other` resolves to nothing
    // under `djdl`. Pinned because a cross-tenant hit here would mint a real credential.
    const w = await world(SET.identity);
    const other = makeTestDb();
    await seedProduct(other, "other");
    const otherEnv = w.env; // same KV mock, so a leak would be visible
    const otherProduct = (await loadProduct(otherEnv, other, "other"))!;
    const { licenseId } = await seedLicenseWithKey(other, "other");
    const created = await createBrowserSession(
      otherEnv,
      other,
      otherProduct,
      (await getLicense(other, "other", licenseId))!,
      NOW,
    );
    if (!created.ok) throw new Error("session mint failed");

    const res = await handleRegister(
      registerReq({
        "x-pkey-device": DEVICE,
        cookie: created.cookie.split(";")[0]!,
      }),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(403);
    expect(await getDevice(w.db, "djdl", DEVICE)).toBeNull();
  });

  it("requires-identity with identity DISABLED is an unreachable configuration", async () => {
    // `validateServices` refuses the combination at ingest and in the admin API, so it cannot be
    // written through a supported path…
    expect(
      validateServices(
        { ...SET.configOnly, identity: { enabled: false } },
        "requires-identity",
      ),
    ).toContain("registration_requires_identity");

    // …and if a hand-edited row got there anyway, the exchange fails closed: Identity's code is
    // never consulted for a service this product has turned off, so a live session in KV does
    // not open the door.
    const w = await world(SET.identity, "requires-identity");
    const cookie = await browserSession(w);
    await setServices(
      w.db,
      "djdl",
      serializeServices({
        services: { ...SET.identity, identity: { enabled: false } },
        registration: "requires-identity",
      }),
      "admin",
      NOW,
    );
    const forced = (await loadProduct(w.env, w.db, "djdl"))!;
    expect(forced.registration).toBe("requires-identity");
    expect(forced.services.identity.enabled).toBe(false);

    const res = await handleRegister(
      registerReq({ "x-pkey-device": DEVICE, cookie }),
      w.env,
      w.db,
      forced,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(403);
    expect(await getDevice(w.db, "djdl", DEVICE)).toBeNull();
  });

  it("an explicitly declared policy overrides the derivation in both directions", async () => {
    // A licensed product may deliberately open registration…
    const open = await world(SET.licensed, "open");
    expect((await register(open)).status).toBe(200);

    // …and a config-only product may deliberately close it.
    const closed = await world(SET.configOnly, "requires-license");
    expect((await register(closed)).status).toBe(403);
  });

  it("rejects a non-POST method", async () => {
    const w = await world(SET.configOnly);
    const res = await handleRegister(
      mkReq("GET", { "x-pkey-device": DEVICE }),
      w.env,
      w.db,
      w.product,
      NOW,
      SERVICES,
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /<p>/devices/register — the device id", () => {
  it("requires a well-formed 32-char base64url id", async () => {
    const w = await world(SET.configOnly);
    const bad = [
      undefined,
      "",
      "too-short",
      "A".repeat(31),
      "A".repeat(33),
      "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHH/", // outside the base64url alphabet
      "AAAABBBBCCCCDDDD EEEFFFFGGGGHHHH", // whitespace
      "../../etc/passwd/AAAAAAAAAAAAAAA",
    ];
    for (const id of bad) {
      const res = await handleRegister(
        registerReq(id === undefined ? {} : { "x-pkey-device": id }),
        w.env,
        w.db,
        w.product,
        NOW,
        SERVICES,
      );
      expect(res.status, `device id ${JSON.stringify(id)}`).toBe(400);
    }
  });

  it("re-registering the same id ROTATES the token and keeps first_seen", async () => {
    const w = await world(SET.configOnly);
    const first = await register(w);
    const before = await getDevice(w.db, "djdl", DEVICE);

    const second = await handleRegister(
      registerReq(),
      w.env,
      w.db,
      w.product,
      NOW + 60,
      SERVICES,
    );
    expect(second.status).toBe(200);
    const { token: rotated } = (await second.json()) as { token: string };
    expect(rotated).not.toBe(first.token);

    const after = await getDevice(w.db, "djdl", DEVICE);
    expect(after?.first_seen).toBe(before?.first_seen);
    expect(after?.last_seen).toBe(NOW + 60);
    expect(after?.token_hash).not.toBe(before?.token_hash);

    // The OLD token stops working immediately — rotation is not "two live credentials".
    const stale = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${first.token}` }),
      w.env,
      w.db,
      w.product,
      NOW + 60,
    );
    expect(stale.status).toBe(401);
  });

  it("REFUSES to take over an id already bound to a licence", async () => {
    // Otherwise anyone who knows a licensed device's id could keyless-deauthorize it: the
    // registration write rebinds `license_id`, dropping the device off its seat.
    const w = await world(SET.licensed, "open");
    const { key } = await seedLicenseWithKey(w.db, "djdl");
    const activated = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": DEVICE,
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(activated.status).toBe(200);
    const { token: licensedToken } = (await activated.json()) as {
      token: string;
    };
    const bound = await getDevice(w.db, "djdl", DEVICE);

    const res = await handleRegister(
      registerReq(),
      w.env,
      w.db,
      w.product,
      NOW + 1,
      SERVICES,
    );
    expect(res.status).toBe(403);

    // Nothing moved: same licence, same token hash, and the licensed token still works.
    const after = await getDevice(w.db, "djdl", DEVICE);
    expect(after?.license_id).toBe(bound?.license_id);
    expect(after?.token_hash).toBe(bound?.token_hash);
    const doc = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${licensedToken}` }),
      w.env,
      w.db,
      w.product,
      NOW + 1,
    );
    expect(doc.status).toBe(200);
  });

  it("records the client metadata headers on the device row", async () => {
    const w = await world(SET.configOnly);
    await register(w, {
      "x-pkey-device": DEVICE,
      "x-pkey-platform": "darwin",
      "x-pkey-arch": "arm64",
      "x-pkey-version": "4.5.6",
      "x-pkey-sdk": "polaris-node",
      "x-pkey-sdk-version": "0.9.0",
    });
    const row = await getDevice(w.db, "djdl", DEVICE);
    // WIRE-CONTRACT-V3 §5.2 rule 3: a listed spelling is stored canonical; an unknown SDK name
    // is stored as sent.
    expect(row).toMatchObject({
      platform: "macos",
      arch: "arm64",
      app_version: "4.5.6",
      sdk_name: "polaris-node",
      sdk_version: "0.9.0",
    });
  });

  it("stores canonical values for a pre-§5.2 SDK's spellings on /license/document", async () => {
    const w = await world(SET.licensed, "open");
    const { key } = await seedLicenseWithKey(w.db, "djdl");
    const activated = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": DEVICE,
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };
    const doc = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": DEVICE,
        "x-pkey-platform": "win32",
        "x-pkey-arch": "x64",
        "x-pkey-sdk": "@polaris-key/node",
        "x-pkey-sdk-version": "0.9.0",
      }),
      w.env,
      w.db,
      w.product,
      NOW + 1,
    );
    expect(doc.status).toBe(200);
    expect(await getDevice(w.db, "djdl", DEVICE)).toMatchObject({
      platform: "windows",
      arch: "x86_64",
      sdk_name: "node",
    });
    // An empty header is absent, so the stored value is kept rather than blanked.
    await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-device": DEVICE,
        "x-pkey-platform": "",
      }),
      w.env,
      w.db,
      w.product,
      NOW + 2,
    );
    expect((await getDevice(w.db, "djdl", DEVICE))?.platform).toBe("windows");
  });

  it("treats the fingerprint as optional, and stores one when offered", async () => {
    const w = await world(SET.configOnly);
    // No body at all.
    expect((await register(w)).status).toBe(200);
    expect(
      await w.db.first(
        "SELECT * FROM device_fingerprints WHERE device_id = ?",
        DEVICE,
      ),
    ).toBeNull();

    // A presented fingerprint is recorded, with a SERVER-computed hwid.
    const res = await register(
      w,
      { "x-pkey-device": DEVICE_2 },
      { fingerprint: { components: { machineUuid: "uuid".padEnd(22, "x") } } },
    );
    expect(res.status).toBe(200);
    const fp = await w.db.first<{ hwid: string; status: string }>(
      "SELECT hwid, status FROM device_fingerprints WHERE product = ? AND device_id = ?",
      "djdl",
      DEVICE_2,
    );
    expect(fp?.status).toBe("verified");
    expect(fp?.hwid).toBeTruthy();
  });
});

describe("the registered device token", () => {
  it("fetches a config document for a product with no License service (D-08)", async () => {
    const w = await world(SET.configOnly);
    const { token } = await register(w);

    const res = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");
  });

  it("is refused if it carries the withdrawn plrst_ prefix", async () => {
    // Wire v3 §8: exactly one device-token prefix. The shape gate makes this a fact about the
    // code rather than about which hashes happen to exist.
    const w = await world(SET.configOnly);
    for (const token of [RETIRED_DEVICE_TOKEN, UNKNOWN_DEVICE_TOKEN]) {
      const res = await handleConfigDocument(
        mkReq("GET", { authorization: `Bearer ${token}` }),
        w.env,
        w.db,
        w.product,
        NOW,
      );
      expect(res.status, token).toBe(401);
    }
  });
});

describe("Core surfaces accept a registered device when License is disabled", () => {
  it("GET /devices lists ONLY itself — never the whole unlicensed pool", async () => {
    // Every unlicensed device of a product shares `NO_LICENSE_ID`, so grouping by licence id
    // would hand one caller the product's entire device list. This is the isolation assertion.
    const w = await world(SET.configOnly);
    const mine = await register(w);
    const theirs = await register(w, { "x-pkey-device": DEVICE_2 });
    expect(theirs.status).toBe(200);

    const res = await handleDevices(
      mkReq("GET", { authorization: `Bearer ${mine.token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currentDeviceId: string;
      devices: Array<{ id: string }>;
    };
    expect(body.currentDeviceId).toBe(DEVICE);
    expect(body.devices.map((d) => d.id)).toEqual([DEVICE]);
  });

  it("PATCH renames its own device", async () => {
    const w = await world(SET.configOnly);
    const { token } = await register(w);
    const res = await handleDevices(
      mkReq("PATCH", { authorization: `Bearer ${token}` }, { label: "Studio" }),
      w.env,
      w.db,
      w.product,
      NOW,
      DEVICE,
    );
    expect(res.status).toBe(200);
    expect((await getDevice(w.db, "djdl", DEVICE))?.label).toBe("Studio");
  });

  it("DELETE deauthorizes its own device and kills the token", async () => {
    const w = await world(SET.configOnly);
    const { token } = await register(w);
    const res = await handleDevices(
      mkReq("DELETE", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
      DEVICE,
    );
    expect(res.status).toBe(200);
    expect((await getDevice(w.db, "djdl", DEVICE))?.status).toBe(
      "deauthorized",
    );
    const after = await handleConfigDocument(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(after.status).toBe(401);
  });

  it("cannot manage a sibling device it cannot see", async () => {
    const w = await world(SET.configOnly);
    const mine = await register(w);
    expect((await register(w, { "x-pkey-device": DEVICE_2 })).status).toBe(200);
    const res = await handleDevices(
      mkReq("DELETE", { authorization: `Bearer ${mine.token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
      DEVICE_2,
    );
    expect(res.status).toBe(404);
    expect((await getDevice(w.db, "djdl", DEVICE_2))?.status).toBe(
      "authorized",
    );
  });

  it("POST /devices/report stores its facts", async () => {
    const w = await world(SET.configOnly);
    const { token } = await register(w);
    const res = await handleReport(
      mkReq(
        "POST",
        { authorization: `Bearer ${token}` },
        { os: { name: "macOS", version: "15.2" }, locale: "en-GB" },
      ),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(res.status).toBe(200);
    const facts = await w.db.first<{ os_name: string; locale: string }>(
      "SELECT os_name, locale FROM device_facts WHERE product = ? AND device_id = ?",
      "djdl",
      DEVICE,
    );
    expect(facts).toMatchObject({ os_name: "macOS", locale: "en-GB" });
  });

  it("edge-mint signs for a registered device", async () => {
    const w = await world(SET.configOnly);
    await seedProductSecret(
      w.db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
    await w.db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      "djdl",
      "applemusic",
      "ES256",
      "applemusic_devkey",
      "KID123",
      JSON.stringify({ iss: "TEAMID123" }),
      3600,
      null,
      null,
    );
    const { token } = await register(w);
    const mint = async () =>
      (
        await handleMintToken(
          mkReq("POST", { authorization: `Bearer ${token}` }),
          w.env,
          w.db,
          w.product,
          "applemusic",
          NOW,
        )
      ).status;
    // A config-only product derives OPEN registration, so an approval counts only when it
    // carries the operator's open-registration acknowledgement (P0-12).
    expect(w.product.registration).toBe("open");
    await approveEdgeMintRecipe(w.db, "djdl", "applemusic");
    expect(await mint()).toBe(404);
    await approveEdgeMintRecipe(w.db, "djdl", "applemusic", {
      acknowledgeOpenRegistration: true,
    });
    expect(await mint()).toBe(200);
  });
});

describe("Core surfaces are UNCHANGED when License is enabled", () => {
  /** A licensed product whose licence has since expired. */
  async function expired(): Promise<{ w: World; token: string }> {
    const w = await world(SET.licensed);
    const { key } = await seedLicenseWithKey(w.db, "djdl", {
      expiresAt: NOW + 100,
    });
    const activated = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": DEVICE,
      }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };
    return { w, token };
  }

  it("still 401s /devices for a device whose licence lapsed", async () => {
    const { w, token } = await expired();
    const ok = await handleDevices(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW,
    );
    expect(ok.status).toBe(200);

    const later = await handleDevices(
      mkReq("GET", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      NOW + 1000,
    );
    expect(later.status).toBe(401);
  });

  it("still 401s /devices/report for a device whose licence lapsed", async () => {
    const { w, token } = await expired();
    const res = await handleReport(
      mkReq("POST", { authorization: `Bearer ${token}` }, {}),
      w.env,
      w.db,
      w.product,
      NOW + 1000,
    );
    expect(res.status).toBe(401);
  });

  it("still 401s edge-mint for a device whose licence lapsed", async () => {
    const { w, token } = await expired();
    await seedProductSecret(
      w.db,
      "djdl",
      "applemusic_devkey",
      ES_PEM,
      "edge-mint",
    );
    await w.db.run(
      "INSERT INTO edge_mint_config (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template) VALUES (?,?,?,?,?,?,?,?,?)",
      "djdl",
      "applemusic",
      "ES256",
      "applemusic_devkey",
      "KID123",
      JSON.stringify({ iss: "TEAMID123" }),
      3600,
      null,
      null,
    );
    await approveEdgeMintRecipe(w.db, "djdl", "applemusic");
    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      w.env,
      w.db,
      w.product,
      "applemusic",
      NOW + 1000,
    );
    expect(res.status).toBe(401);
  });
});
