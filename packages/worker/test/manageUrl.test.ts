// PX-W8 (G15b; WIRE-CONTRACT-V4 §5.3): the refusal link on `device_limit`. The builder's
// three forms, the portal switch, the `for` label's sanitising, and the three routes that
// emit it (activate, enroll, session/license).
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  buildManageUrl,
  manageForLabel,
  portalOriginOf,
} from "../src/core/licensing/manageUrl.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleBrowserSessionLicense } from "../src/services/identity/browserSession.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const LIMIT_ONE = {
  entitlements: {
    deviceLimit: { state: "enforced" as const, value: 1, updatedAt: NOW },
  },
};

function activateReq(
  key: string,
  device: string,
  extra: Record<string, string> = {},
) {
  return mkReq("POST", {
    authorization: `Bearer ${key}`,
    "x-pkey-device": device,
    ...extra,
  });
}

async function setPortal(db: SqliteDb, enabled: boolean): Promise<void> {
  await db.run(
    `INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at)
     VALUES ('djdl', ?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET portal_enabled = excluded.portal_enabled`,
    enabled ? 1 : 0,
    NOW,
    NOW,
  );
}

describe("manageForLabel", () => {
  const label = (headers: Record<string, string>) =>
    manageForLabel(mkReq("POST", headers));

  it("names the canonical platform and arch", () => {
    expect(label({ "x-pkey-platform": "darwin", "x-pkey-arch": "arm64" })).toBe(
      "macOS arm64",
    );
    expect(label({ "x-pkey-platform": "linux", "x-pkey-arch": "x64" })).toBe(
      "Linux x86_64",
    );
    expect(label({ "x-pkey-arch": "arm64" })).toBe("arm64");
  });

  it("is absent with no metadata", () => {
    expect(label({})).toBeNull();
    expect(label({ "x-pkey-platform": "<>&\"'" })).toBeNull();
  });

  it("strips hostile characters and caps the length", () => {
    const hostile = label({
      "x-pkey-platform": `my<script>host&id=1#frag${"x".repeat(200)}`,
      "x-pkey-arch": "a\tb%0A",
    });
    expect(hostile).not.toMatch(/[<>&#=%\t]/);
    expect(hostile!.length).toBeLessThanOrEqual(64);
  });
});

describe("portalOriginOf", () => {
  const env = (origin?: string) =>
    ({ CONSOLE_ORIGIN: origin }) as unknown as Env;
  const req = new Request("https://key.plrs.im/djdl/license/activate");

  it("prefers a usable CONSOLE_ORIGIN, else the request's origin", () => {
    expect(portalOriginOf(env("https://portal.example/x"), req)).toBe(
      "https://portal.example",
    );
    expect(portalOriginOf(env(), req)).toBe("https://key.plrs.im");
    expect(portalOriginOf(env("http://portal.example"), req)).toBe(
      "https://key.plrs.im",
    );
    expect(portalOriginOf(env("http://localhost:8787"), req)).toBe(
      "http://localhost:8787",
    );
    expect(portalOriginOf(env("not a url"), req)).toBe("https://key.plrs.im");
  });
});

describe("buildManageUrl", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
  });
  const req = mkReq("POST", {
    "x-pkey-platform": "macos",
    "x-pkey-arch": "arm64",
  });

  it("an attached licence opens the free-device flow", async () => {
    expect(
      await buildManageUrl(
        env,
        db,
        req,
        { slug: "djdl" },
        {
          kind: "device_limit",
          license: { id: "lic_1", account_id: "acct_x" },
        },
      ),
    ).toBe(
      "https://key.plrs.im/#/p/djdl/free-device?license=lic_1&for=macOS%20arm64",
    );
  });

  it("a floating licence opens activate, then free-device", async () => {
    expect(
      await buildManageUrl(
        env,
        db,
        req,
        { slug: "djdl" },
        {
          kind: "device_limit",
          license: { id: "lic_1", account_id: null },
        },
      ),
    ).toBe(
      "https://key.plrs.im/activate?product=djdl&next=free-device&for=macOS%20arm64",
    );
  });

  it("the key-entry refusal opens activate", async () => {
    expect(
      await buildManageUrl(
        env,
        db,
        req,
        { slug: "djdl" },
        {
          kind: "key_entry_limit",
        },
      ),
    ).toBe("https://key.plrs.im/activate?product=djdl");
  });

  it("never carries the account id, and drops `for` with no metadata", async () => {
    const url = await buildManageUrl(
      env,
      db,
      mkReq("POST", {}),
      { slug: "djdl" },
      {
        kind: "device_limit",
        license: { id: "lic_1", account_id: "acct_secret" },
      },
    );
    expect(url).toBe("https://key.plrs.im/#/p/djdl/free-device?license=lic_1");
    expect(url).not.toContain("acct_secret");
  });

  it("is omitted while the portal is off", async () => {
    await setPortal(db, false);
    expect(
      await buildManageUrl(
        env,
        db,
        req,
        { slug: "djdl" },
        {
          kind: "device_limit",
          license: { id: "lic_1" },
        },
      ),
    ).toBeUndefined();
    await setPortal(db, true);
    expect(
      await buildManageUrl(
        env,
        db,
        req,
        { slug: "djdl" },
        {
          kind: "device_limit",
          license: { id: "lic_1" },
        },
      ),
    ).toBeDefined();
  });
});

describe("device_limit carries manageUrl", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("on activate, floating then attached, and not with the portal off", async () => {
    const { key, licenseId } = await seedLicenseWithKey(db, "djdl", LIMIT_ONE);
    expect(
      (await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW))
        .status,
    ).toBe(200);
    const meta = { "x-pkey-platform": "linux", "x-pkey-arch": "x86_64" };

    const floating = await handleActivate(
      activateReq(key, "dev-2", meta),
      env,
      db,
      product,
      NOW,
    );
    expect(floating.status).toBe(403);
    expect(await floating.json()).toEqual({
      error: "device_limit",
      message: "device limit reached",
      limit: 1,
      deviceCount: 1,
      manageUrl:
        "https://key.plrs.im/activate?product=djdl&next=free-device&for=Linux%20x86_64",
    });

    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = 'djdl' AND id = ?",
      "acct_1",
      licenseId,
    );
    const attached = await handleActivate(
      activateReq(key, "dev-2", meta),
      env,
      db,
      product,
      NOW,
    );
    expect(((await attached.json()) as { manageUrl?: string }).manageUrl).toBe(
      `https://key.plrs.im/#/p/djdl/free-device?license=${licenseId}&for=Linux%20x86_64`,
    );

    await setPortal(db, false);
    const off = await handleActivate(
      activateReq(key, "dev-2"),
      env,
      db,
      product,
      NOW,
    );
    const offBody = (await off.json()) as Record<string, unknown>;
    expect(offBody.error).toBe("device_limit");
    expect("manageUrl" in offBody).toBe(false);
  });

  it("is absent on every other refusal", async () => {
    const res = await handleActivate(
      activateReq("pkey_djdl_nope", "dev-1"),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
    expect("manageUrl" in ((await res.json()) as object)).toBe(false);
  });

  it("on session/license (the browser key entry)", async () => {
    const { key } = await seedLicenseWithKey(db, "djdl", LIMIT_ONE);
    expect(
      (await handleActivate(activateReq(key, "dev-1"), env, db, product, NOW))
        .status,
    ).toBe(200);
    const res = await handleBrowserSessionLicense(
      new Request("https://key.plrs.im/djdl/identity/session/license", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "device_limit",
      limit: 1,
      deviceCount: 1,
      manageUrl: "https://key.plrs.im/activate?product=djdl&next=free-device",
    });
  });
});
