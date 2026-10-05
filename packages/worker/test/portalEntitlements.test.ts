/**
 * LX-04 (S-19 G14): the portal's "what this licence grants" agrees with the signed licence
 * document, key by key.
 *
 * Two drifts are pinned here. The portal used to fall back to a catalog flag's `default`, which
 * no document carries (catalog defaults are a `config`-only layer, `core/payload.ts`), so a flag
 * defaulting to `true` showed as granted while the device saw it absent. And it read channels and
 * the version window from the licence row alone, where the document unions tier and licence
 * channels and takes the tighter of tier and licence versions.
 */

import { describe, expect, it } from "vitest";
import { verifyLicenseDoc } from "@polaris-key/client-core";
import type { ConfigEntry } from "@polaris-key/catalog";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import {
  getOrCreateAccountByEmail,
  getPortalLicense,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  grantsFromEntitlements,
  licenseGrants,
} from "../src/services/identity/portal/entitlements.js";

const SLUG = "djdl";

/** djdl's real catalog plus the two shapes djdl does not have: a `userGrant` flag that defaults
 *  to `true` (the G14 case) and a non-boolean grant. */
const FIXTURE_CATALOG = (() => {
  const base = DJDL_CATALOG as { schemaVersion: number; entries: unknown[] };
  return {
    ...base,
    entries: [
      ...base.entries,
      {
        key: "cloudSync",
        kind: "flag",
        category: "Sync",
        label: "Cloud Sync",
        schema: { type: "boolean" },
        default: true,
        userGrant: true,
        grantLabel: "Cloud Sync",
      },
      {
        key: "stemSlots",
        kind: "flag",
        category: "Stems",
        label: "Stem slots",
        schema: { type: "integer", minimum: 0, maximum: 8 },
        default: 2,
        userGrant: true,
        grantLabel: "Stem slots",
      },
      {
        key: "internalBeta",
        kind: "flag",
        category: "Internal",
        label: "Internal beta",
        schema: { type: "boolean" },
        default: false,
      },
    ],
  };
})();

type FlagEntry = { key: string; kind: string; userGrant?: boolean };

describe("portal entitlement view agrees with the licence document (LX-04)", () => {
  it("shows the same value as the document for every catalog flag", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG, { catalog: FIXTURE_CATALOG });
    await seedTier(db, SLUG, "pro", {
      channels: ["beta"],
      minVersion: "1.0.0",
      maxVersion: "3.0.0",
    });
    const { licenseId, key } = await seedLicenseWithKey(db, SLUG, {
      tierId: "pro",
      channels: ["pr"],
      minVersion: "1.2.0",
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
        stemSlots: { state: "enforced", value: 6, updatedAt: NOW },
        internalBeta: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    await linkLicense(db, account.id, SLUG, licenseId, "admin", NOW);

    // The device's view: activate, fetch and verify the signed licence document.
    const product = (await loadProduct(env, db, SLUG))!;
    const act = await handleActivate(
      mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "d1" }),
      env,
      db,
      product,
      NOW,
    );
    expect(act.status).toBe(200);
    const { token } = (await act.json()) as { token: string };
    const res = await handleLicenseDocument(
      mkReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.5.0",
        "x-pkey-channel": "stable",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    const doc = await verifyLicenseDoc(await res.text(), {
      trust: { [TEST_KID]: TEST_PUB },
      expectedAud: SLUG,
      deviceId: "d1",
      now: NOW,
    });
    expect(doc).not.toBeNull();
    const docValue = (k: string): unknown => doc!.entitlements[k]?.value;

    // The portal's view of the same licence.
    const row = (await getPortalLicense(db, account.id, SLUG, licenseId))!;
    const grants = await licenseGrants(db, row, NOW);
    const shown = new Map(grants.entitlements.map((e) => [e.key, e.value]));

    const flags = (FIXTURE_CATALOG.entries as FlagEntry[]).filter(
      (e) => e.kind === "flag",
    );
    expect(flags.length).toBeGreaterThanOrEqual(8);
    for (const flag of flags) {
      const fromDoc = docValue(flag.key);
      if (flag.key === "channels") {
        expect(grants.channels, flag.key).toEqual(fromDoc ?? []);
      } else if (flag.key === "app.minVersion") {
        expect(grants.minVersion, flag.key).toBe(fromDoc ?? null);
      } else if (flag.key === "app.maxVersion") {
        expect(grants.maxVersion, flag.key).toBe(fromDoc ?? null);
      }
      if (flag.userGrant === true) {
        const granted =
          fromDoc !== undefined && fromDoc !== null && fromDoc !== false;
        expect(shown.get(flag.key), flag.key).toEqual(
          granted ? fromDoc : undefined,
        );
      } else {
        // Not `userGrant`: never listed, whatever the document holds.
        expect(shown.has(flag.key), flag.key).toBe(false);
      }
    }

    // The concrete answers, so a regression that breaks both sides the same way still fails.
    expect(shown.has("cloudSync")).toBe(false); // default true, never granted
    expect(shown.get("stemSlots")).toBe(6);
    expect(shown.get("polarisVpn")).toBe(true);
    expect(grants.channels.sort()).toEqual(["beta", "pr"]);
    expect(grants.minVersion).toBe("1.2.0");
    expect(grants.maxVersion).toBe("3.0.0");
    // `channels` is listed once, under djdl's `grantLabel`.
    expect(grants.entitlements.filter((e) => e.key === "channels")).toEqual([
      { key: "channels", label: "Pre-release builds", value: grants.channels },
    ]);
  });

  it("lists nothing for a licence whose document grants nothing", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG, { catalog: FIXTURE_CATALOG });
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    await linkLicense(db, account.id, SLUG, licenseId, "admin", NOW);
    const row = (await getPortalLicense(db, account.id, SLUG, licenseId))!;
    const grants = await licenseGrants(db, row, NOW);
    // djdl's `channels` default (["stable"]) and cloudSync's `true` are catalog defaults only.
    expect(grants).toEqual({
      entitlements: [],
      channels: [],
      minVersion: null,
      maxVersion: null,
    });
  });

  it("labels channels as a generic grant when the catalog does not declare them", () => {
    const flags = new Map<string, ConfigEntry>();
    expect(
      grantsFromEntitlements(
        { channels: { state: "enforced", value: ["beta"], updatedAt: NOW } },
        flags,
      ),
    ).toEqual([
      { key: "channels", label: "Release channels", value: ["beta"] },
    ]);
  });
});
