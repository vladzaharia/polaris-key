/**
 * ST-14: the Customer portal settings. Three settings rows (`portal.enabled`, `portal.keyReissue`,
 * `identity.keyEntry.claimByKey`) and one branding store, written through the one admin route
 * (`PATCH …/identity/portal`), readable with Identity off, and read by the Locker.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  setPortalToggles,
} from "../../seed.js";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { listAudit } from "../../../src/core/audit.js";
import { SETTINGS } from "../../../src/mount.js";
import {
  CLAIM_BY_KEY_SETTING_KEY,
  PORTAL_ENABLED_SETTING,
  PORTAL_KEY_REISSUE_SETTING,
  readPortalToggles,
} from "../../../src/core/portalToggles.js";
import {
  PORTAL_BRANDING_SCHEMA,
  PORTAL_BRANDING_FIELDS,
  parsePortalBranding,
  publicBranding,
} from "../../../src/services/identity/portal/branding.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../../../src/services/identity/portal/repo.js";
import { PORTAL_COOKIE } from "../../../src/services/identity/portal/session.js";
import { handlePortalApi } from "../../portalHarness.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";

const SLUG = "djdl";
const PATH = `/api/products/${SLUG}/identity/portal`;
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

async function fixture(identityOn = false) {
  const db = makeTestDb();
  const env: Env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET services_json = ? WHERE slug = ?",
    JSON.stringify({
      license: { enabled: true },
      identity: { enabled: identityOn },
    }),
    SLUG,
  );
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const call = (method: string, body?: unknown) =>
    handleAdmin(
      new Request(`https://key.plrs.im/manage${PATH}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db as Db,
      PATH,
      { now: NOW },
    );
  return {
    db,
    env,
    get: () => call("GET"),
    patch: (body: unknown) => call("PATCH", body),
  };
}

async function locker(env: Env, db: Db, path: string) {
  const account = await getOrCreateAccountByEmail(db, "mara@x.studio", NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    account,
    get: (p: string) =>
      handlePortalApi(
        new Request(`https://key.plrs.im${p}`, {
          headers: { cookie: `${PORTAL_COOKIE}=${token}` },
        }),
        env,
        db,
        p,
        NOW,
      ),
    session,
    path,
  };
}

describe("the three settings", () => {
  it("are registered at product scope, row-backed, with the defaults the readers use", () => {
    for (const [key, def] of [
      [PORTAL_ENABLED_SETTING, true],
      [PORTAL_KEY_REISSUE_SETTING, false],
      [CLAIM_BY_KEY_SETTING_KEY, false],
    ] as const) {
      const entry = SETTINGS.get(key, "product");
      expect(entry, key).toBeDefined();
      expect(entry!.storage.kind).toBe("scalar");
      expect(entry!.defaultValue).toBe(def);
      expect(entry!.visibleWhen).toMatchObject({ offBehaviour: "visible" });
    }
  });

  it("never register the toggles I-29 retired", () => {
    for (const key of [
      "portal.oidcEnabled",
      "portal.oidc_enabled",
      "portal.magicEnabled",
      "portal.magic_enabled",
      "portal.licenseKeyClaimEnabled",
      "portal.license_key_claim_enabled",
      "portal.autoLinkEnabled",
      "portal.auto_link_enabled",
    ])
      expect(SETTINGS.get(key, "product"), key).toBeUndefined();
    expect(
      SETTINGS.entries
        .filter((e) => e.key.startsWith("portal."))
        .map((e) => e.key)
        .sort(),
    ).toEqual(["portal.enabled", "portal.keyReissue"]);
  });
});

describe("PATCH …/identity/portal writes the rows", () => {
  it("works with Identity off, and the Locker follows the rows", async () => {
    const { db, env, patch, get } = await fixture(false);
    expect(await readPortalToggles(db, SLUG)).toEqual({
      portalEnabled: true,
      keyReissueEnabled: false,
      claimByKey: false,
    });
    const res = await patch({
      portalEnabled: false,
      keyReissueEnabled: true,
      claimByKey: true,
    });
    expect(res.status).toBe(200);
    expect(await readPortalToggles(db, SLUG)).toEqual({
      portalEnabled: false,
      keyReissueEnabled: true,
      claimByKey: true,
    });
    const rows = await db.all<{
      key: string;
      value_json: string;
      source: string;
    }>(
      "SELECT key, value_json, source FROM product_settings WHERE product = ? ORDER BY key",
      SLUG,
    );
    expect(
      rows.filter(
        (r) => r.key.startsWith("portal.") || r.key.endsWith("claimByKey"),
      ),
    ).toEqual([
      {
        key: "identity.keyEntry.claimByKey",
        value_json: "true",
        source: "console",
      },
      { key: "portal.enabled", value_json: "false", source: "console" },
      { key: "portal.keyReissue", value_json: "true", source: "console" },
    ]);
    // The old table is not written by the switches any more.
    expect(
      await db.first(
        "SELECT 1 FROM portal_product_settings WHERE product = ? AND (portal_enabled = 0 OR claim_by_key = 1)",
        SLUG,
      ),
    ).toBeNull();
    // One structured audit row per changed setting.
    const keys = (await listAudit(db, SLUG, { limit: 20 }))
      .map((r) => (r as { setting_key?: string | null }).setting_key)
      .filter((k): k is string => typeof k === "string")
      .sort();
    expect(keys).toEqual([
      "identity.keyEntry.claimByKey",
      "portal.enabled",
      "portal.keyReissue",
    ]);
    // The Locker obeys the row: the product's page is gone.
    const l = await locker(env, db, "");
    const lic = await seedLicenseWithKey(db, SLUG);
    await linkLicense(db, l.account.id, SLUG, lic.licenseId, "admin", NOW);
    expect((await l.get(`/api/licenses/${SLUG}/${lic.licenseId}`)).status).toBe(
      404,
    );
    // And the console reads the same values back.
    const view = (await (await get()).json()) as {
      settings: Record<string, unknown>;
    };
    expect(view.settings).toMatchObject({
      portalEnabled: false,
      keyReissueEnabled: true,
      claimByKey: true,
    });
  });

  it("writes nothing for a switch that already holds the value", async () => {
    const { db, patch } = await fixture(false);
    expect(
      (await patch({ portalEnabled: true, claimByKey: false })).status,
    ).toBe(200);
    expect(
      await db.all("SELECT key FROM product_settings WHERE product = ?", SLUG),
    ).toEqual([]);
  });

  it("offers a new key only while keyReissue is on", async () => {
    const { db, env, patch } = await fixture(false);
    const l = await locker(env, db, "");
    const lic = await seedLicenseWithKey(db, SLUG);
    await linkLicense(db, l.account.id, SLUG, lic.licenseId, "admin", NOW);
    const canGetNewKey = async () =>
      (
        (await (
          await l.get(`/api/licenses/${SLUG}/${lic.licenseId}`)
        ).json()) as {
          canGetNewKey: boolean;
        }
      ).canGetNewKey;
    expect(await canGetNewKey()).toBe(false);
    await patch({ keyReissueEnabled: true });
    expect(await canGetNewKey()).toBe(true);
  });
});

describe("branding: one store", () => {
  it("is edited through the route, validated, and read by the Locker from that store", async () => {
    const { db, env, patch } = await fixture(false);
    const l = await locker(env, db, "");
    const lic = await seedLicenseWithKey(db, SLUG);
    await linkLicense(db, l.account.id, SLUG, lic.licenseId, "admin", NOW);
    const branding = async () =>
      (
        (await (
          await l.get(`/api/licenses/${SLUG}/${lic.licenseId}`)
        ).json()) as { productBranding: unknown }
      ).productBranding;
    expect(await branding()).toBeNull();

    const ok = await patch({
      branding: {
        developerName: " Fennick Studio ",
        tintColor: "#3a7bd5",
        supportUrl: "https://fennick.example/help",
        website: "",
      },
    });
    expect(ok.status).toBe(200);
    expect(await branding()).toEqual({
      developerName: "Fennick Studio",
      tintColor: "#3a7bd5",
      supportUrl: "https://fennick.example/help",
    });
    const rows = (await listAudit(db, SLUG, { limit: 10 })).map(
      (r) => r.action,
    );
    expect(rows).toContain("portal.settings.update");
  });

  it("refuses an invalid value and names the field, writing nothing", async () => {
    const { db, patch } = await fixture(false);
    const res = await patch({
      branding: { tintColor: "blue", website: "http://x.example", extra: "x" },
    });
    expect(res.status).toBe(422);
    const body = JSON.stringify(await res.json());
    for (const f of [
      "branding.tintColor",
      "branding.website",
      "branding.extra",
    ])
      expect(body).toContain(f);
    expect(
      await db.first(
        "SELECT branding_json FROM portal_product_settings WHERE product = ?",
        SLUG,
      ),
    ).toBeNull();
  });

  it("keeps the sign-in header name, which the editor neither shows nor clears", async () => {
    const { db, patch, get } = await fixture(false);
    await db.run(
      `INSERT INTO portal_product_settings (product, branding_json, created_at, modified_at)
       VALUES (?, '{"passthroughName":"Fennick Sign-in"}', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    expect(
      ((await (await get()).json()) as { settings: { branding: unknown } })
        .settings.branding,
    ).toBeNull();
    await patch({ branding: { developerName: "Fennick" } });
    expect(
      JSON.parse(
        (await db.first<{ branding_json: string }>(
          "SELECT branding_json FROM portal_product_settings WHERE product = ?",
          SLUG,
        ))!.branding_json,
      ),
    ).toEqual({ developerName: "Fennick", passthroughName: "Fennick Sign-in" });
    await patch({ branding: null });
    expect(
      JSON.parse(
        (await db.first<{ branding_json: string }>(
          "SELECT branding_json FROM portal_product_settings WHERE product = ?",
          SLUG,
        ))!.branding_json,
      ),
    ).toEqual({ passthroughName: "Fennick Sign-in" });
  });
});

describe("the branding schema", () => {
  it("lists the fields the validator accepts", () => {
    expect(Object.keys(PORTAL_BRANDING_SCHEMA.properties)).toEqual([
      ...PORTAL_BRANDING_FIELDS,
    ]);
    expect(PORTAL_BRANDING_SCHEMA.additionalProperties).toBe(false);
  });

  it("accepts the documented shapes and refuses the rest", () => {
    expect(parsePortalBranding(null)).toEqual({ ok: true, branding: {} });
    expect(parsePortalBranding({ tintColor: "#A1b2C3" }).ok).toBe(true);
    for (const bad of [
      [],
      "x",
      { developerName: "x".repeat(61) },
      { developerName: "<b>" },
      { tintColor: "#abc" },
      { tintColorDark: "red" },
      { website: "ftp://x.example" },
      { supportUrl: "https://" + "a".repeat(300) },
      { supportEmail: "nobody" },
      { passthroughName: "x" },
      { developerName: 5 },
    ])
      expect(parsePortalBranding(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("strips the sign-in header name from what the Locker and the editor see", () => {
    expect(publicBranding('{"passthroughName":"x"}')).toBeNull();
    expect(
      publicBranding('{"developerName":"A","passthroughName":"x"}'),
    ).toEqual({
      developerName: "A",
    });
    expect(publicBranding("not json")).toBeNull();
  });
});

describe("setPortalToggles (the fixture)", () => {
  it("is what readPortalToggles reads", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await setPortalToggles(db, SLUG, { portalEnabled: false });
    expect((await readPortalToggles(db, SLUG)).portalEnabled).toBe(false);
    // An expired break-glass claim is no row.
    await db.run(
      "UPDATE product_settings SET expires_at = ? WHERE product = ?",
      NOW - 1,
      SLUG,
    );
    expect((await readPortalToggles(db, SLUG, NOW)).portalEnabled).toBe(true);
  });
});
