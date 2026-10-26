// I-42.2: `identity.platformSignIn` and `identity.nearby` as settings rows. The manifest seeds them
// on link and resync (omit-clears, a console claim kept), the Apple bundle ids in force union in
// the App Store and TestFlight outlets, and the platform's own login-card clients are refused as a
// product's audience, in a console write and at resync.

import { describe, expect, it } from "vitest";
import { parseManifest, type ParsedManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { ROOT_PRINCIPAL } from "../../rbacFixtures.js";
import { SETTINGS } from "../../../src/mount.js";
import { writeSetting } from "../../../src/core/settings/write.js";
import { identityHookStatements } from "../../../src/services/identity/ingest.js";
import {
  outletAppleBundleIds,
  readPlatformSignIn,
  reservedAudienceIn,
} from "../../../src/services/identity/platformSignIn.js";

const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });
const WEB = "1234-web.apps.googleusercontent.com";
const AND = "1234-and.apps.googleusercontent.com";
const PLATFORM_GOOGLE = "9999-locker.apps.googleusercontent.com";
const DECLARED = {
  platformSignIn: {
    google: { serverClientId: WEB, clientIds: [AND] },
    apple: { teamId: "ABCDE12345", bundleIds: ["com.acme.mac"] },
  },
  nearby: false,
};
const OUTLETS = {
  outlets: {
    "app-store": { appleId: "1", bundleId: "com.acme.ios" },
    testflight: { appleId: "1", bundleId: "com.acme.ios.beta" },
  },
};

function parsed(identity: unknown, distribution?: unknown): ParsedManifest {
  const res = parseManifest({
    product: JSON.stringify({
      slug: "acme",
      name: "Acme",
      modules: { license: { enabled: true }, identity: { enabled: true } },
      web: { origins: ["https://app.acme.example"] },
      ...(identity === undefined ? {} : { identity }),
    }),
    schema: SCHEMA,
    ...(distribution === undefined
      ? {}
      : { distribution: JSON.stringify(distribution) }),
  });
  if (!res.ok) throw new Error(res.errors.join("; "));
  return res.manifest;
}

const ingest = (
  db: ReturnType<typeof makeTestDb>,
  m: ParsedManifest,
  at = NOW,
) =>
  db.batch(
    identityHookStatements({
      manifest: m,
      slug: "acme",
      now: at,
      enabled: true,
    }),
  );

describe("platform sign-in settings rows (I-42.2)", () => {
  it("seeds the rows from the manifest and omit-clears them", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await ingest(db, parsed(DECLARED));
    const ps = await readPlatformSignIn(db, { slug: "acme", created_at: NOW });
    expect(ps).toMatchObject({
      google: { serverClientId: WEB, clientIds: [AND] },
      apple: { teamId: "ABCDE12345", bundleIds: ["com.acme.mac"] },
      nearby: false,
    });
    await ingest(db, parsed(undefined), NOW + 1);
    expect(
      await readPlatformSignIn(db, { slug: "acme", created_at: NOW }),
    ).toMatchObject({
      google: { serverClientId: null, clientIds: [] },
      apple: { teamId: null, bundleIds: [] },
      nearby: true,
    });
  });

  it("unions the App Store and TestFlight bundle ids, declared first", async () => {
    const m = parsed(DECLARED, OUTLETS);
    expect(outletAppleBundleIds(m.distribution)).toEqual([
      "com.acme.ios",
      "com.acme.ios.beta",
    ]);
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await ingest(db, m);
    await db.run(
      "INSERT INTO product_manifest_snapshot (product, applied_sha, applied_at, origin, files_sha256, manifest_json) VALUES ('acme', NULL, ?, 'resync', 'x', ?)",
      NOW,
      JSON.stringify(m),
    );
    const ps = await readPlatformSignIn(db, { slug: "acme", created_at: NOW });
    expect(ps.apple.bundleIds).toEqual([
      "com.acme.mac",
      "com.acme.ios",
      "com.acme.ios.beta",
    ]);
    expect(ps.apple.outletBundleIds).toEqual([
      "com.acme.ios",
      "com.acme.ios.beta",
    ]);
  });
});

describe("the platform's own clients are reserved audiences", () => {
  const env = {
    SIGNIN_GOOGLE_CLIENT_ID: PLATFORM_GOOGLE,
    SIGNIN_APPLE_SERVICES_ID: "im.plrs.locker.login",
  };

  it("names a reserved Google client or Apple services id in a manifest, outlets included", () => {
    expect(reservedAudienceIn(parsed(DECLARED), env)).toBeNull();
    const google = parsed({
      platformSignIn: { google: { serverClientId: PLATFORM_GOOGLE } },
    });
    expect(reservedAudienceIn(google, env)).toBe(PLATFORM_GOOGLE);
    const apple = parsed(
      { platformSignIn: { apple: { teamId: "ABCDE12345" } } },
      {
        outlets: {
          "app-store": { appleId: "1", bundleId: "im.plrs.locker.login" },
        },
      },
    );
    expect(reservedAudienceIn(apple, env)).toBe("im.plrs.locker.login");
  });

  it("refuses a console write of one, and takes another", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const ctx = { env, db, registry: SETTINGS };
    const opts = {
      actor: { sub: "u1", name: "Una", email: "una@example.test" },
      origin: "console" as const,
      principal: ROOT_PRINCIPAL,
      now: NOW,
      product: "acme",
    };
    const refused = await writeSetting(
      ctx,
      {
        key: "identity.platformSignIn.google.clientIds",
        value: [PLATFORM_GOOGLE.toUpperCase().replace("APPS.", "apps.")],
        expectedVersion: 0,
        reason: "try",
      },
      opts,
    );
    expect(refused).toMatchObject({
      ok: false,
      status: 422,
      reason: "invalid_value",
    });
    const ok = await writeSetting(
      ctx,
      {
        key: "identity.platformSignIn.google.serverClientId",
        value: WEB,
        expectedVersion: 0,
        reason: "own client",
      },
      { ...opts, confirm: undefined },
    );
    expect(ok).toMatchObject({ ok: true });
  });
});
