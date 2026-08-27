/**
 * `POST /manage/api/products/<slug>/bundles` — the offline activation bundle MINT
 * (WIRE-CONTRACT-V3 §7, spec §7.2, plan §R4).
 *
 * ── WHY THE ASSERTIONS RUN THROUGH `inspectBundle` ──────────────────────────────────────────
 *
 * A bundle is only correct if the four SDKs accept it, and `@polaris-key/client-core`'s `inspectBundle`
 * IS the walk they all run (§7's numbered steps, pinned byte-for-byte by the corpus's
 * `bundleCases`). So this suite never hand-parses what the endpoint emits: it verifies the
 * artifact the way an air-gapped machine would, against the product's PINNED key, and reads the
 * inner documents out of the result. A shape check written here instead would pass a weaker test
 * than the one that actually matters, and would keep passing on the day the server started
 * emitting something no client could import.
 *
 * `inspectBundle` rather than `verifyBundle` for the same reason the module offers both: when a
 * refusal happens, the STEP that refused is the diagnosis.
 *
 * ── WHAT THIS SUITE OWNS AND WHAT IT DOES NOT ───────────────────────────────────────────────
 *
 * Owns: the endpoint's semantics — which documents ride inside under which enablement, the
 * grace arithmetic, the import window, the refusals, and the audit row. The session, CSRF,
 * rate-limit and platform-admin gates run in `admin/api.ts` before any of this and are
 * `admin.test.ts`'s; the two cases at the bottom assert only that this route is INSIDE them,
 * which is the thing a new route can get wrong by being registered in the wrong place.
 */

import { describe, expect, it } from "vitest";
import { inspectBundle } from "@polaris-key/client-core";
import type { ManagedEntry } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit, setServices } from "../src/repo.js";
import { setLicenseStatus } from "../src/admin/repo.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { BUNDLE_IMPORT_WINDOW_SECONDS } from "../src/core/bundles.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";
const PATH = `/api/products/${SLUG}/bundles`;

/** The trust set a real client PINS: the product's kid → its published Ed25519 public key. */
const PINNED = { [TEST_KID]: TEST_PUB };

/** A well-formed device id — 32 base64url chars, the shape §6 states and the endpoint enforces.
 *  This is what an operator copies out of the app's offline-activation screen. */
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

const DAY = 86_400;

const CONFIG_ONLY: ServicesMap = {
  license: { enabled: false },
  config: { enabled: true },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

const LICENSE_ONLY: ServicesMap = {
  license: { enabled: true },
  config: { enabled: false },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

const NEITHER: ServicesMap = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
};

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function session(
  env: Env,
  groups: string[] = [PLATFORM_GROUP],
): Promise<{ cookie: string; csrf: string }> {
  const { token, session: s } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: s.csrf };
}

function mkReq(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
}

const dispatch = (req: Request, env: Env, db: Db, path: string) =>
  handleAdmin(req, env, db, path, { now: NOW });

interface World {
  db: Db;
  env: Env;
  auth: { cookie: string; csrf: string };
  licenseId: string;
}

async function fixture(
  opts: {
    services?: ServicesMap;
    config?: Record<string, ManagedEntry>;
    entitlements?: Record<string, ManagedEntry>;
    /** Attach a tier carrying admin policy, so `injectAdminPolicy` has something to stamp. */
    tier?: { channels?: string[]; deviceLimit?: number };
  } = {},
): Promise<World> {
  const db = makeTestDb();
  const env = adminEnv();
  // The REAL djdl catalog, so config values survive the pre-sign prune exactly as they do on
  // `GET /<p>/config/document`. A bundle minted against an empty catalog would carry an empty
  // `config` map and prove nothing about the merge.
  await seedProduct(db, SLUG, { catalog: DJDL_CATALOG });
  if (opts.services) {
    await setServices(
      db,
      SLUG,
      serializeServices({ services: opts.services }),
      "manifest",
      NOW,
    );
  }
  if (opts.tier) await seedTier(db, SLUG, "pro", opts.tier);
  const { licenseId } = await seedLicenseWithKey(db, SLUG, {
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.entitlements ? { entitlements: opts.entitlements } : {}),
    ...(opts.tier ? { tierId: "pro" } : {}),
  });
  const auth = await session(env);
  return { db, env, auth, licenseId };
}

/** POST a mint request with the session's credentials. */
function mint(world: World, body: Record<string, unknown>): Promise<Response> {
  return dispatch(
    mkReq("POST", PATH, {
      cookie: world.auth.cookie,
      csrf: world.auth.csrf,
      body,
    }),
    world.env,
    world.db,
    PATH,
  );
}

/** Mint, expect a 200, and run §7's import walk over the result the way a client would. */
async function mintAndInspect(
  world: World,
  body: Record<string, unknown>,
  opts: { deviceId?: string; now?: number } = {},
): Promise<{
  bundleId: string;
  jws: string;
  inspection: Awaited<ReturnType<typeof inspectBundle>>;
}> {
  const res = await mint(world, body);
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { bundleId: string; bundle: string };
  const inspection = await inspectBundle(payload.bundle, {
    pinned: PINNED,
    product: SLUG,
    deviceId: opts.deviceId ?? DEVICE,
    now: opts.now ?? NOW,
  });
  return { bundleId: payload.bundleId, jws: payload.bundle, inspection };
}

const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
  state: "enforced",
  value,
  updatedAt: NOW,
});

describe("bundle mint — the artifact a client actually imports", () => {
  it("mints a license + config bundle that inspects ok against the pinned key", async () => {
    const world = await fixture();
    const { bundleId, inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 90,
      licenseId: world.licenseId,
    });

    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    // The id the response reports IS the id inside the signed payload — the audit anchor an
    // operator correlates a support ticket with, so the two must not be able to disagree.
    expect(inspection.bundle.bundleId).toBe(bundleId);
    expect(Object.keys(inspection.bundle.docs).sort()).toEqual([
      "config",
      "license",
    ]);
    // Step 3 built an effective trust set from the manifest the bundle carries, which is what
    // lets an air-gapped machine verify the inner documents with no network at all.
    expect(inspection.bundle.effectiveTrust[TEST_KID]).toBe(TEST_PUB);
  });

  it("issues a ULID bundleId — unique per mint, and ordered by mint time", async () => {
    // §7 specifies a ULID and makes it the audit anchor. Both halves matter: an operator holding
    // only this string has to be able to find the row, and rows have to sort by when they were
    // minted. A random opaque id would satisfy uniqueness and lose the ordering.
    const world = await fixture();
    const first = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    const second = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    // 26 characters of Crockford base32 (no I, L, O or U — the digits they are confused with).
    expect(first.bundleId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second.bundleId).not.toBe(first.bundleId);
    // Same `now`, so the 48-bit timestamp prefix is identical and only the random tail differs.
    expect(second.bundleId.slice(0, 10)).toBe(first.bundleId.slice(0, 10));
  });

  it("binds both inner documents to the requested device and product", async () => {
    const world = await fixture();
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    for (const doc of [
      inspection.bundle.docs.license!.doc,
      inspection.bundle.docs.config!.doc,
    ]) {
      expect(doc.iss).toBe("key.plrs.im");
      expect(doc.aud).toBe(SLUG);
      expect(doc.deviceId).toBe(DEVICE);
    }
    expect(inspection.bundle.docs.license!.doc.licenseId).toBe(world.licenseId);
  });

  it("stamps graceUntil from graceDays and leaves expiresAt at the ordinary one hour", async () => {
    // The §7 relationship the whole design turns on: inner documents are verified on the RELOAD
    // profile, where `expiresAt` is EXPECTED to be in the past and `graceUntil` is the bound
    // that matters. Stretching `expiresAt` instead would mint a document that passes the
    // network profile for a year.
    const world = await fixture();
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 200,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    for (const doc of [
      inspection.bundle.docs.license!.doc,
      inspection.bundle.docs.config!.doc,
    ]) {
      expect(doc.issuedAt).toBe(NOW);
      expect(doc.expiresAt).toBe(NOW + 3600);
      expect(doc.graceUntil).toBe(NOW + 200 * DAY);
    }
  });

  it("mints at the 365-day ceiling, which the client's verifier accepts inclusively", async () => {
    const world = await fixture();
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 365,
      licenseId: world.licenseId,
    });
    // §3.3's ceiling is inclusive and applied at VERIFY time as well as at mint, so a bundle
    // sitting exactly on it must still import. `ok: true` here is the assertion.
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.bundle.docs.license!.doc.graceUntil).toBe(
      NOW + 365 * DAY,
    );
  });

  it("gives the bundle itself a 30-day import window, independent of the grace", async () => {
    const world = await fixture();
    const { jws } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 365,
      licenseId: world.licenseId,
    });

    // One second inside the window still imports…
    const inside = await inspectBundle(jws, {
      pinned: PINNED,
      product: SLUG,
      deviceId: DEVICE,
      now: NOW + BUNDLE_IMPORT_WINDOW_SECONDS,
    });
    expect(inside.ok).toBe(true);

    // …and past it the bundle is refused at STEP 2, on network-path freshness, even though the
    // documents inside it have 365 days of grace left. The two windows mean different things:
    // one bounds how long the file is useful, the other how long the install it creates runs.
    const outside = await inspectBundle(jws, {
      pinned: PINNED,
      product: SLUG,
      deviceId: DEVICE,
      // +301 clears CLOCK_SKEW_SECONDS (300), which the verifier allows on top of expiresAt.
      now: NOW + BUNDLE_IMPORT_WINDOW_SECONDS + 301,
    });
    expect(outside).toEqual({ ok: false, reason: "bundle-claims-rejected" });
  });

  it("carries the merged config payload, not an empty map", async () => {
    const world = await fixture({
      config: { "ui.theme": enforced("dark") },
    });
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    // Proof the mint reuses the DOCUMENT ASSEMBLY path rather than re-deriving one: the licence
    // override is only visible through `resolveMergedPayload` + the catalog prune.
    expect(inspection.bundle.docs.config!.doc.config["ui.theme"]).toMatchObject(
      { state: "enforced", value: "dark" },
    );
  });

  it("carries the same entitlements /license/document would have served", async () => {
    const world = await fixture({
      entitlements: { "feature.pro": enforced(true) },
      tier: { channels: ["beta"], deviceLimit: 3 },
    });
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    const doc = inspection.bundle.docs.license!.doc;
    expect(doc.entitlements["feature.pro"]).toMatchObject({ value: true });
    // `injectAdminPolicy` stamps the server-side policy on top of the stored layers, and D-20
    // makes `entitlements` the ONLY carrier of grant data. These three are what prove the shared
    // `resolveEntitlements` ran rather than a bare read of `overrides_json` — an air-gapped
    // install must be entitled to exactly what the same install online would be.
    expect(doc.entitlements["license.tier"]).toMatchObject({ value: "pro" });
    expect(doc.entitlements["channels"]).toMatchObject({ value: ["beta"] });
    expect(doc.entitlements["deviceLimit"]).toMatchObject({ value: 3 });
    // The signed greeting block rides along too, so an air-gapped app can render a personalised
    // welcome with no network.
    expect(doc.profile).toMatchObject({ email: "ada@example.com" });
  });

  it("does NOT create a device row — the machine may never touch the network", async () => {
    const world = await fixture();
    await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    const row = await world.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE,
    );
    // A seat holder nothing can ever reconcile, deactivate or hear from again would be worse
    // than no row at all.
    expect(row?.n).toBe(0);
  });
});

describe("bundle mint — enablement decides what rides inside", () => {
  it("forces includeConfig off when the Config service is disabled", async () => {
    // `includeConfig` defaults to TRUE, and the request below asks for it explicitly, but a
    // product that does not run Config has no config document to give. Honouring enablement
    // rather than refusing is deliberate: the console offers the checkbox from a product view
    // that may be a moment stale, and an operator who wanted a bundle should get one.
    const world = await fixture({ services: LICENSE_ONLY });
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      includeConfig: true,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(Object.keys(inspection.bundle.docs)).toEqual(["license"]);
  });

  it("omits the config document when the operator asks it to", async () => {
    const world = await fixture();
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      includeConfig: false,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(Object.keys(inspection.bundle.docs)).toEqual(["license"]);
  });
});

describe("bundle mint — a config-only product (D-08)", () => {
  it("mints a licence-LESS bundle that inspects ok", async () => {
    const world = await fixture({ services: CONFIG_ONLY });
    // No `licenseId` is sent, and none is required: there is no License service to grant one.
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 45,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(Object.keys(inspection.bundle.docs)).toEqual(["config"]);
    expect(inspection.bundle.docs.license).toBeUndefined();
    expect(inspection.bundle.docs.config!.doc.graceUntil).toBe(NOW + 45 * DAY);
  });

  it("ignores a licenseId it has no service to honour", async () => {
    // Not an error: the console offers the field from a product view that may be a moment
    // stale, and refusing would be a worse outcome than honouring the enablement.
    const world = await fixture({ services: CONFIG_ONLY });
    const { inspection } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 10,
      licenseId: world.licenseId,
    });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.bundle.docs.license).toBeUndefined();
  });
});

describe("bundle mint — refusals", () => {
  it("refuses a product with neither service: the bundle would carry no documents", async () => {
    const world = await fixture({ services: NEITHER });
    const res = await mint(world, { deviceId: DEVICE, graceDays: 30 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("refuses includeConfig:false on a licence-less product for the same reason", async () => {
    // Same vacuous outcome by a different route — §7 refuses an empty `docs` at import, so
    // minting one would produce a file whose only possible result is an error on a machine
    // with no way to report it.
    const world = await fixture({ services: CONFIG_ONLY });
    const res = await mint(world, {
      deviceId: DEVICE,
      graceDays: 30,
      includeConfig: false,
    });
    expect(res.status).toBe(400);
  });

  it("refuses graceDays past the 365-day ceiling", async () => {
    const world = await fixture();
    const res = await mint(world, {
      deviceId: DEVICE,
      graceDays: 366,
      licenseId: world.licenseId,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "bad_request",
      fields: ["graceDays"],
    });
  });

  it("refuses a graceDays of zero, a negative, or a fraction", async () => {
    const world = await fixture();
    for (const graceDays of [0, -1, 1.5]) {
      const res = await mint(world, {
        deviceId: DEVICE,
        graceDays,
        licenseId: world.licenseId,
      });
      expect(res.status, `graceDays ${graceDays}`).toBe(400);
    }
  });

  it("refuses a malformed device id rather than minting an unimportable bundle", async () => {
    const world = await fixture();
    for (const deviceId of [
      "too-short",
      `${DEVICE}X`, // 33 chars
      "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHH+", // outside the base64url alphabet
      "",
      42,
    ]) {
      const res = await mint(world, {
        deviceId,
        graceDays: 30,
        licenseId: world.licenseId,
      });
      expect(res.status, `deviceId ${String(deviceId)}`).toBe(400);
      expect(await res.json()).toMatchObject({ fields: ["deviceId"] });
    }
  });

  it("requires licenseId when the License service is enabled", async () => {
    const world = await fixture();
    const res = await mint(world, { deviceId: DEVICE, graceDays: 30 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "bad_request",
      fields: ["licenseId"],
    });
  });

  it("refuses an unknown or a disabled licence", async () => {
    const world = await fixture();

    const unknown = await mint(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: "lic_does_not_exist",
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ fields: ["licenseId"] });

    // A dead licence collapses into the SAME refusal as an unknown one: both mean "no grant can
    // be minted for this id", and the distinction only matters to an enumerator.
    await setLicenseStatus(
      world.db,
      SLUG,
      world.licenseId,
      "disabled",
      "test",
      NOW,
    );
    const disabled = await mint(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    expect(disabled.status).toBe(400);
  });

  it("refuses a non-boolean includeConfig instead of coercing it", async () => {
    const world = await fixture();
    const res = await mint(world, {
      deviceId: DEVICE,
      graceDays: 30,
      includeConfig: "yes",
      licenseId: world.licenseId,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ fields: ["includeConfig"] });
  });

  it("refuses a GET on the mint route rather than falling through to a 404", async () => {
    const world = await fixture();
    const res = await dispatch(
      mkReq("GET", PATH, { cookie: world.auth.cookie }),
      world.env,
      world.db,
      PATH,
    );
    expect(res.status).toBe(405);
  });

  it("404s an unknown sub-path under bundles", async () => {
    const world = await fixture();
    const path = `${PATH}/nope`;
    const res = await dispatch(
      mkReq("POST", path, {
        cookie: world.auth.cookie,
        csrf: world.auth.csrf,
        body: { deviceId: DEVICE, graceDays: 30 },
      }),
      world.env,
      world.db,
      path,
    );
    expect(res.status).toBe(404);
  });
});

describe("bundle mint — a bundle is bound to ONE device", () => {
  it("is refused by a machine it was not minted for", async () => {
    const world = await fixture();
    const { jws } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    const elsewhere = await inspectBundle(jws, {
      pinned: PINNED,
      product: SLUG,
      deviceId: "ZZZZYYYYXXXXWWWWVVVVUUUUTTTTSSSS",
      now: NOW,
    });
    // Step 2, not step 4: the BUNDLE's own addressing is wrong, and the corpus pins which step
    // refuses for each vector.
    expect(elsewhere).toEqual({ ok: false, reason: "bundle-claims-rejected" });
  });

  it("is refused by a client pinning a different key set", async () => {
    const world = await fixture();
    const { jws } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 30,
      licenseId: world.licenseId,
    });
    const foreign = await inspectBundle(jws, {
      pinned: { "some-other-kid": TEST_PUB },
      product: SLUG,
      deviceId: DEVICE,
      now: NOW,
    });
    expect(foreign).toEqual({ ok: false, reason: "bundle-jws-rejected" });
  });
});

describe("bundle mint — audit", () => {
  it("writes a bundle.minted row against the verified actor, targeting the licence", async () => {
    const world = await fixture();
    const { bundleId } = await mintAndInspect(world, {
      deviceId: DEVICE,
      graceDays: 120,
      licenseId: world.licenseId,
    });
    const rows = await listAudit(world.db, SLUG, { limit: 10 });
    const row = rows.find((r) => r.action === "bundle.minted");
    expect(row).toBeTruthy();
    expect(row?.actor_sub).toBe("u1");
    expect(row?.target_kind).toBe("license");
    expect(row?.target_id).toBe(world.licenseId);
    // The audit anchor: the summary has to name the bundle, the device and the window, because
    // the artifact itself is not stored anywhere and this row is all an operator will have.
    expect(row?.summary).toContain(bundleId);
    expect(row?.summary).toContain(DEVICE);
    expect(row?.summary).toContain("120-day grace");
  });

  it("targets the DEVICE when there is no licence to point at", async () => {
    const world = await fixture({ services: CONFIG_ONLY });
    await mintAndInspect(world, { deviceId: DEVICE, graceDays: 30 });
    const rows = await listAudit(world.db, SLUG, { limit: 10 });
    const row = rows.find((r) => r.action === "bundle.minted");
    expect(row?.target_kind).toBe("device");
    expect(row?.target_id).toBe(DEVICE);
  });

  it("writes NOTHING on a refused mint", async () => {
    const world = await fixture();
    await mint(world, { deviceId: "bad", graceDays: 30 });
    const rows = await listAudit(world.db, SLUG, { limit: 10 });
    expect(rows.filter((r) => r.action === "bundle.minted")).toEqual([]);
  });
});

describe("bundle mint — the gates it sits behind", () => {
  it("refuses a mutation with no CSRF token", async () => {
    const world = await fixture();
    const res = await dispatch(
      mkReq("POST", PATH, {
        cookie: world.auth.cookie,
        body: { deviceId: DEVICE, graceDays: 30, licenseId: world.licenseId },
      }),
      world.env,
      world.db,
      PATH,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: "csrf" });
  });

  it("refuses a mutation whose CSRF token belongs to another session", async () => {
    const world = await fixture();
    const other = await session(world.env);
    const res = await dispatch(
      mkReq("POST", PATH, {
        cookie: world.auth.cookie,
        csrf: `${other.csrf}-tampered`,
        body: { deviceId: DEVICE, graceDays: 30, licenseId: world.licenseId },
      }),
      world.env,
      world.db,
      PATH,
    );
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const world = await fixture();
    const res = await dispatch(
      mkReq("POST", PATH, {
        body: { deviceId: DEVICE, graceDays: 30, licenseId: world.licenseId },
      }),
      world.env,
      world.db,
      PATH,
    );
    expect(res.status).toBe(401);
  });

  it("refuses a session that is not a platform admin", async () => {
    const world = await fixture();
    const outsider = await session(world.env, ["some-other-group"]);
    const res = await dispatch(
      mkReq("POST", PATH, {
        cookie: outsider.cookie,
        csrf: outsider.csrf,
        body: { deviceId: DEVICE, graceDays: 30, licenseId: world.licenseId },
      }),
      world.env,
      world.db,
      PATH,
    );
    expect(res.status).toBe(403);
    // Nothing was signed on the way to that refusal.
    const rows = await listAudit(world.db, SLUG, { limit: 10 });
    expect(rows.filter((r) => r.action === "bundle.minted")).toEqual([]);
  });
});
