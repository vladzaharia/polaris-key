/**
 * A-16 — the platform's team-level App Store connection: the App Store Connect team API key, the
 * team In-App Purchase key and the Apple Team ID, held once for the platform.
 *
 *   - **Auth.** Every route is platform-admin only: a signed-in non-admin gets 403 everywhere.
 *   - **Never a secret out.** Responses carry presence and metadata (key id, issuer id, source),
 *     never a `.p8`, whichever source holds it.
 *   - **Precedence.** A console credential beats the Worker secret (`PLATFORM_ASC_API_KEY`); an
 *     invalid secret counts as absent; clearing the console credential hands back to the secret.
 *   - **The listing.** Every app the team key sees, from a fake App Store Connect, with versions,
 *     review state, TestFlight versions and the phased release; cached; bearer-only; one host.
 *   - **Assignment.** From the list, refused while another product holds the app (platform pin or
 *     own credential pin); sets the App Store Connect and the In-App Purchase pins; re-pins a key
 *     the product holds of its own through the audited path; release frees the app.
 *   - **The fallback, and the pin as the boundary.** A product with no key of its own uses the
 *     team key ONLY for the app assigned to it: no pin → inert, nothing sent, nothing opened; a
 *     manifest naming another app → inert; another product's app → never, at every layer (setup,
 *     token, open). A product's own key always wins and never falls through.
 *   - **In-App Purchase fallback** (commerce): the same matrix on the App Store Server API path.
 *   - **Team ID**, the KEK sweep, product deletion, and the platform audit seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  openPlatformCredential,
  platformPin,
  putPlatformCredential,
  setPlatformPin,
} from "../src/core/platformCredentials.js";
import {
  platformAscToken,
  platformAppStoreServerToken,
} from "../src/core/outletTokens.js";
import { platformAppleTeamId } from "../src/core/platformStoreSettings.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import { appendPlatformEvent } from "../src/core/platformEvents.js";
import { deleteProduct } from "../src/admin/repo.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { resolveAscSetup } from "../src/services/distribution/connectors/asc/setup.js";
import { seedProduct } from "./seed.js";
import {
  APPLE_ID,
  ascP8,
  ascWorld,
  audits,
  putCredential,
  NOW,
  SLUG,
  type AscWorld,
} from "./ascWorld.js";
import { CONSOLE } from "./releaseRoutesFixture.js";
import { BUNDLE_ID } from "./commerceFake.js";
import {
  bindingOf,
  commerceWorld,
  grants,
  route,
  type CommerceWorld,
} from "./commerceWorld.js";
import { TEST_KEK } from "./seed.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER = "other";
const OTHER_APP = "5555555555";
const ISSUER = "69a6de7f-0000-47e3-e053-5b8c7c11a4d1";

const ascKey = (keyId = "TEAMKEY123") => ({
  keyId,
  issuerId: ISSUER,
  p8: ascP8(),
});

/** A world whose product has NO key of its own; `secret` sets `PLATFORM_ASC_API_KEY`. */
async function teamWorld(
  opts: { secret?: boolean; apiKey?: boolean } = {},
): Promise<AscWorld> {
  const w = await ascWorld({ apiKey: opts.apiKey ?? false });
  if (opts.secret !== false)
    (w.env as Record<string, unknown>).PLATFORM_ASC_API_KEY = JSON.stringify(
      ascKey("SECRETKEY1"),
    );
  await seedProduct(w.db, OTHER);
  // A second app the team key sees, for the listing and the cross-product cases.
  w.fake.put({
    type: "apps",
    id: OTHER_APP,
    attributes: { name: "Other Game", bundleId: "gg.acme.other", sku: "OTHER" },
  });
  return w;
}

/** The platform API as a platform admin (or, with `groups`, as anyone), fakes as the fetch. */
async function platform(
  w: { env: Env; db: Db; fetchImpl?: AscWorld["fetchImpl"] },
  method: string,
  path: string,
  body?: unknown,
  groups: string[] = ["platform-admins"],
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const [bare, query] = path.split("?");
  const full = `/api/platform/store-connections${bare}`;
  const saved = globalThis.fetch;
  if (w.fetchImpl) globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    return await handleAdmin(
      new Request(`${CONSOLE}/manage${full}${query ? `?${query}` : ""}`, {
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
  } finally {
    globalThis.fetch = saved;
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const poll = (w: AscWorld) => {
  const saved = globalThis.fetch;
  globalThis.fetch = w.fetchImpl as typeof fetch;
  return runConnectorPolls(w.env, w.db, NOW).finally(() => {
    globalThis.fetch = saved;
  });
};

async function useRows(db: Db, product = SLUG) {
  return (await audits(db)).filter(
    (a) =>
      (a.action === "platform_credential.use" ||
        a.action === "outlet_credential.use") &&
      product === SLUG,
  );
}

async function appStore(w: { env: Env; db: Db }) {
  const res = await platform(w, "GET", "");
  expect(res.status).toBe(200);
  const body = (await json(res)) as {
    stores: Array<Record<string, unknown> & { store: string }>;
  };
  return body.stores.find((s) => s.store === "app-store")! as unknown as {
    configured: boolean;
    credentials: Array<{
      id: string;
      configured: boolean;
      source: string | null;
      meta: Record<string, string> | null;
      secret: { name: string; present: boolean; valid: boolean };
      console: { present: boolean };
    }>;
    settings: Array<{
      key: string;
      value: string | null;
      source: string | null;
    }>;
    assignments: Array<{ product: string; pins: Record<string, string> }>;
  };
}

// ── auth ─────────────────────────────────────────────────────────────────────────────────────

describe("platform store connections: platform admins only", () => {
  it("answers 403 to a signed-in non-admin on every route, and changes nothing", async () => {
    const w = await teamWorld();
    const calls: Array<[string, string, unknown?]> = [
      ["GET", ""],
      ["PUT", "/app-store", { value: ascKey() }],
      ["DELETE", "/app-store"],
      [
        "PUT",
        "/app-store/credentials/in-app-purchase-key",
        { value: ascKey() },
      ],
      ["PUT", "/app-store/settings/teamId", { value: "48H7CLBV8Y" }],
      ["GET", "/app-store/apps"],
      ["PUT", `/app-store/apps/${APPLE_ID}/product`, { product: SLUG }],
      ["DELETE", `/app-store/apps/${APPLE_ID}/product`],
    ];
    for (const [method, path, body] of calls) {
      const res = await platform(w, method, path, body, ["some-other-group"]);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(w.fake.requests).toEqual([]);
    expect(await w.db.first("SELECT * FROM platform_credentials")).toBeNull();
    expect(
      await w.db.first("SELECT * FROM platform_credential_pins"),
    ).toBeNull();
  });
});

// ── sources, precedence, never a secret ─────────────────────────────────────────────────────

describe("platform store connections: sources and precedence", () => {
  it("the Worker secret alone configures it; the console credential wins; clearing hands back", async () => {
    const w = await teamWorld();
    let s = await appStore(w);
    expect(s.credentials[0]).toMatchObject({
      id: "app-store.api-key",
      configured: true,
      source: "secret",
      meta: { keyId: "SECRETKEY1", issuerId: ISSUER },
      secret: { name: "PLATFORM_ASC_API_KEY", present: true, valid: true },
      console: { present: false },
    });

    const put = await platform(w, "PUT", "/app-store", { value: ascKey() });
    expect(put.status).toBe(200);
    const putBody = await json(put);
    expect(putBody).toEqual({
      ok: true,
      id: "app-store.api-key",
      source: "console",
      meta: { keyId: "TEAMKEY123", issuerId: ISSUER },
    });
    s = await appStore(w);
    expect(s.credentials[0]).toMatchObject({
      source: "console",
      meta: { keyId: "TEAMKEY123" },
    });

    const del = await platform(w, "DELETE", "/app-store");
    expect(await json(del)).toMatchObject({
      configured: true,
      source: "secret",
    });
    expect((await platform(w, "DELETE", "/app-store")).status).toBe(404);
  });

  it("an invalid Worker secret counts as absent; a bad console value is refused with the field", async () => {
    const w = await teamWorld({ secret: false });
    (w.env as Record<string, unknown>).PLATFORM_ASC_API_KEY = '{"keyId":"X"}';
    const s = await appStore(w);
    expect(s.configured).toBe(false);
    expect(s.credentials[0]!.secret).toEqual({
      name: "PLATFORM_ASC_API_KEY",
      present: true,
      valid: false,
    });
    const bad = await platform(w, "PUT", "/app-store", {
      value: { keyId: "ABC", issuerId: ISSUER, p8: "not a key" },
    });
    expect(bad.status).toBe(422);
    const badBody = await json(bad);
    expect(badBody).toMatchObject({ fields: ["value.p8"] });
    expect(JSON.stringify(badBody)).not.toContain("not a key");
  });

  it("no response ever carries a private key, from either source", async () => {
    const w = await teamWorld();
    const key = ascKey();
    const bodies: string[] = [];
    bodies.push(await (await platform(w, "GET", "")).text());
    bodies.push(
      await (await platform(w, "PUT", "/app-store", { value: key })).text(),
    );
    bodies.push(
      await (
        await platform(w, "PUT", "/app-store/credentials/in-app-purchase-key", {
          value: JSON.stringify(ascKey("IAPKEY1234")),
        })
      ).text(),
    );
    bodies.push(await (await platform(w, "GET", "")).text());
    bodies.push(await (await platform(w, "GET", "/app-store/apps")).text());
    for (const b of bodies) {
      expect(b).not.toContain("PRIVATE KEY");
      expect(b).not.toContain(key.p8.split("\n")[1]!);
      expect(b).not.toContain('"p8"');
    }
    // …and the console row is sealed under the platform slot, not stored in clear.
    const row = await w.db.first<{ enc_value_json: string; meta_json: string }>(
      "SELECT enc_value_json, meta_json FROM platform_credentials WHERE credential_id = 'app-store.api-key'",
    );
    expect(row!.enc_value_json).not.toContain("PRIVATE KEY");
    expect(JSON.parse(row!.meta_json)).toEqual({
      keyId: "TEAMKEY123",
      issuerId: ISSUER,
    });
  });
});

// ── the listing ──────────────────────────────────────────────────────────────────────────────

describe("platform store connections: the App Store apps listing", () => {
  it("lists every app the team key sees with versions, review state, TestFlight and the phased release", async () => {
    const w = await teamWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    const res = await platform(w, "GET", "/app-store/apps");
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      source: string;
      cached: boolean;
      apps: Array<{
        appId: string;
        name: string;
        identifiers: Record<string, string>;
        pins: Record<string, string>;
        assignedProduct: string | null;
        status: {
          appStore: {
            versions: Array<{ versionString: string; state: string }>;
            phasedRelease: { state: string } | null;
          };
          testflight: { versions: Array<{ version: string }> };
        };
      }>;
    };
    expect(body.source).toBe("secret");
    expect(body.cached).toBe(false);
    expect(body.apps.map((a) => a.appId).sort()).toEqual(
      [APPLE_ID, OTHER_APP].sort(),
    );
    const djdl = body.apps.find((a) => a.appId === APPLE_ID)!;
    expect(djdl.identifiers.bundleId).toBe("gg.acme.djdl");
    expect(djdl.pins).toEqual({
      "app-store.in-app-purchase-key": "gg.acme.djdl",
    });
    expect(djdl.assignedProduct).toBeNull();
    expect(djdl.status.appStore.versions[0]).toMatchObject({
      versionString: expect.any(String),
      state: "READY_FOR_DISTRIBUTION",
    });
    expect(djdl.status.appStore.phasedRelease).toMatchObject({
      state: expect.any(String),
    });
    expect(djdl.status.testflight.versions.length).toBeGreaterThan(0);

    // Bearer-only requests to the one host; the list asked for its relationships in one call.
    expect(w.fake.foreignHost).toEqual([]);
    expect(w.fake.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/apps",
      query: expect.objectContaining({
        include: "appStoreVersions,preReleaseVersions",
      }),
    });
    for (const r of w.fake.requests)
      expect(r.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(w.fake.writes()).toEqual([]);

    // Cached: a second read sends nothing; refresh=1 reads again.
    const n = w.fake.requests.length;
    const again = (await json(await platform(w, "GET", "/app-store/apps"))) as {
      cached: boolean;
    };
    expect(again.cached).toBe(true);
    expect(w.fake.requests.length).toBe(n);
    await platform(w, "GET", "/app-store/apps?refresh=1");
    expect(w.fake.requests.length).toBeGreaterThan(n);

    // The team-wide open is in the platform trail, on behalf of the admin, not in a product's.
    expect(
      (await audits(w.db)).filter(
        (a) => a.action === "platform_credential.use",
      ),
    ).toEqual([]);
    expect(
      await w.db.all(
        "SELECT action, actor_sub, target_id FROM platform_audit WHERE action = 'platform_credential.use'",
      ),
    ).toEqual([
      {
        action: "platform_credential.use",
        actor_sub: "u1",
        target_id: "app-store.api-key",
      },
    ]);
  });

  it("refuses the listing without a usable team key (409), and relays an Apple refusal as 502 with no body", async () => {
    const w = await teamWorld({ secret: false });
    const res = await platform(w, "GET", "/app-store/apps");
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "not_configured" });
    expect(w.fake.requests).toEqual([]);

    const w2 = await teamWorld();
    w2.fake.fail429(10);
    const refused = await platform(w2, "GET", "/app-store/apps");
    expect(refused.status).toBe(502);
    expect(await json(refused)).toMatchObject({
      code: "store_unavailable",
      status: 429,
    });
  });

  it("never follows a redirect with the bearer token", async () => {
    const w = await teamWorld();
    const redirecting = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/steal" },
      });
    const res = await platform(
      { ...w, fetchImpl: redirecting },
      "GET",
      "/app-store/apps",
    );
    expect(res.status).toBe(502);
  });
});

// ── assignment ───────────────────────────────────────────────────────────────────────────────

describe("platform store connections: assigning an app to a product", () => {
  it("sets the App Store Connect and In-App Purchase pins, audited in the product's trail", async () => {
    const w = await teamWorld();
    const res = await platform(
      w,
      "PUT",
      `/app-store/apps/${APPLE_ID}/product`,
      {
        product: SLUG,
      },
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      appId: APPLE_ID,
      product: SLUG,
      pins: [
        { credential: "app-store.api-key", pin: APPLE_ID, changed: true },
        {
          credential: "app-store.in-app-purchase-key",
          pin: "gg.acme.djdl",
          changed: true,
        },
      ],
      ownCredentialsRepinned: [],
    });
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBe(APPLE_ID);
    expect(await platformPin(w.db, "app-store.in-app-purchase-key", SLUG)).toBe(
      "gg.acme.djdl",
    );
    const pinRows = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.pin",
    );
    expect(pinRows).toHaveLength(2);
    expect(pinRows[0]).toMatchObject({ actor_sub: "u1" });

    const listed = (await json(
      await platform(w, "GET", "/app-store/apps"),
    )) as {
      apps: Array<{
        appId: string;
        assignedProduct: string | null;
        assignedVia: string | null;
      }>;
    };
    expect(listed.apps.find((a) => a.appId === APPLE_ID)).toMatchObject({
      assignedProduct: SLUG,
      assignedVia: "platform",
    });
    expect((await appStore(w)).assignments).toEqual([
      {
        product: SLUG,
        pins: {
          "app-store.api-key": APPLE_ID,
          "app-store.in-app-purchase-key": "gg.acme.djdl",
        },
      },
    ]);
  });

  it("refuses an app another product holds — by platform pin or by its own key's pin — until released", async () => {
    const w = await teamWorld();
    expect(
      (
        await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
          product: SLUG,
        })
      ).status,
    ).toBe(200);
    const taken = await platform(
      w,
      "PUT",
      `/app-store/apps/${APPLE_ID}/product`,
      {
        product: OTHER,
      },
    );
    expect(taken.status).toBe(409);
    expect(await json(taken)).toMatchObject({
      code: "app_assigned_elsewhere",
      product: SLUG,
    });

    // Another product's OWN key pinned to an app also blocks assigning it.
    await w.db.run(
      `INSERT INTO outlet_credentials (product, credential_id, kind, outlet_id, enc_value_json, meta_json, status, created_at, created_by)
       VALUES (?, 'own', 'asc-api-key', NULL, '{}', ?, 'active', ?, 'x')`,
      OTHER,
      JSON.stringify({ keyId: "K", issuerId: ISSUER, appleId: OTHER_APP }),
      NOW,
    );
    const owned = await platform(
      w,
      "PUT",
      `/app-store/apps/${OTHER_APP}/product`,
      {
        product: SLUG,
      },
    );
    expect(owned.status).toBe(409);
    expect(await json(owned)).toMatchObject({ product: OTHER });

    // Release frees the app; then the other product may take it.
    const rel = await platform(
      w,
      "DELETE",
      `/app-store/apps/${APPLE_ID}/product`,
    );
    expect(rel.status).toBe(200);
    expect(await json(rel)).toMatchObject({ product: SLUG });
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBeNull();
    expect(
      (
        await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
          product: OTHER,
        })
      ).status,
    ).toBe(200);
  });

  it("refuses an app the team key cannot see (404), a malformed id (404) and an unknown product (422)", async () => {
    const w = await teamWorld();
    expect(
      (
        await platform(w, "PUT", "/app-store/apps/7777777777/product", {
          product: SLUG,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await platform(w, "PUT", "/app-store/apps/not-an-id/product", {
          product: SLUG,
        })
      ).status,
    ).toBe(404);
    const bad = await platform(
      w,
      "PUT",
      `/app-store/apps/${APPLE_ID}/product`,
      {
        product: "nope",
      },
    );
    expect(bad.status).toBe(422);
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBeNull();
  });

  it("re-pins a key the product holds of its own through the audited pin path", async () => {
    const w = await teamWorld();
    await putCredential(
      w,
      "asc",
      "asc-api-key",
      ascKey("OWNKEY1234"),
      OTHER_APP,
    );
    const res = await platform(
      w,
      "PUT",
      `/app-store/apps/${APPLE_ID}/product`,
      {
        product: SLUG,
      },
    );
    expect(await json(res)).toMatchObject({ ownCredentialsRepinned: ["asc"] });
    const rows = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.pin" && a.target_id === "asc",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain(APPLE_ID);
  });

  it("refuses to re-pin a product's own key from another App Store account, writing nothing", async () => {
    const w = await teamWorld();
    await putCredential(
      w,
      "asc",
      "asc-api-key",
      {
        ...ascKey("OWNKEY1234"),
        issuerId: "11111111-2222-3333-4444-555555555555",
      },
      OTHER_APP,
    );
    const res = await platform(
      w,
      "PUT",
      `/app-store/apps/${APPLE_ID}/product`,
      {
        product: SLUG,
      },
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      code: "own_credential_other_account",
      credentials: ["asc"],
    });
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBeNull();
    expect(
      (await audits(w.db)).filter((a) => a.action === "outlet_credential.pin"),
    ).toEqual([]);
  });

  it("writes the assignment as one batch: a failing batch leaves no pin and no audit row", async () => {
    const w = await teamWorld();
    await putCredential(
      w,
      "asc",
      "asc-api-key",
      ascKey("OWNKEY1234"),
      OTHER_APP,
    );
    const failing = {
      ...w,
      db: {
        ...w.db,
        all: w.db.all.bind(w.db),
        first: w.db.first.bind(w.db),
        run: w.db.run.bind(w.db),
        runChanges: w.db.runChanges.bind(w.db),
        batch: async () => {
          throw new Error("UNIQUE constraint failed: platform_credential_pins");
        },
      },
    };
    const res = await platform(
      failing,
      "PUT",
      `/app-store/apps/${APPLE_ID}/product`,
      {
        product: SLUG,
      },
    );
    expect(res.status).toBe(409);
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBeNull();
    const own = await w.db.first<{ meta_json: string }>(
      "SELECT meta_json FROM outlet_credentials WHERE product = ? AND credential_id = 'asc'",
      SLUG,
    );
    expect(JSON.parse(own!.meta_json).appleId).toBe(OTHER_APP);
    expect(
      (await audits(w.db)).filter((a) => a.action === "outlet_credential.pin"),
    ).toEqual([]);
  });

  it("a product's own key cannot be pinned to an app the platform serves to another product", async () => {
    const w = await teamWorld();
    await platform(w, "PUT", `/app-store/apps/${OTHER_APP}/product`, {
      product: OTHER,
    });
    await putCredential(
      w,
      "asc",
      "asc-api-key",
      ascKey("OWNKEY1234"),
      APPLE_ID,
    );
    const { token, session } = await issueSession(
      w.env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const full = `/api/products/${SLUG}/outlet-credentials/asc`;
    const res = await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method: "PUT",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "asc-api-key", pin: OTHER_APP }),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      code: "app_assigned_elsewhere",
      product: OTHER,
    });
  });
});

// ── the fallback and the pin ─────────────────────────────────────────────────────────────────

describe("platform store connections: a product's connector falls back to the team key", () => {
  it("with the app assigned: configured on the team key, polled with its token, the open audited in the product's trail", async () => {
    const w = await teamWorld();
    // Pinned directly (the HTTP assignment would mint — and memoise — a team token first).
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: APPLE_ID,
      actor: "x",
      now: NOW,
    });
    const { setup } = await resolveAscSetup(w.env, w.db, SLUG);
    expect(setup?.credential).toEqual({ source: "platform", origin: "secret" });
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.length).toBeGreaterThan(0);
    expect(w.fake.requests[0]!.path).toBe(
      `/v1/apps/${APPLE_ID}/reviewSubmissions`,
    );
    const opens = (await audits(w.db)).filter(
      (a) => a.action === "platform_credential.use",
    );
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      actor_sub: "system:distribution",
      target_id: "app-store.api-key",
    });
    expect(opens[0]!.summary).toMatch(/^asc:poll: opened \(secret\)/);
  });

  it("with no pin: inert even though the team key exists — nothing sent, nothing opened, every control refused", async () => {
    const w = await teamWorld();
    const { inert } = await resolveAscSetup(w.env, w.db, SLUG);
    expect(inert).toMatchObject({
      reason: "pin_missing",
      credentialSource: "platform",
      manifestAppleId: APPLE_ID,
    });
    await poll(w);
    expect(w.fake.requests).toEqual([]);
    expect(await useRows(w.db)).toEqual([]);
    const { token, session } = await issueSession(
      w.env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const full = `/api/products/${SLUG}/distribution/connectors/asc/release`;
    const res = await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ releaseId: "v1.1.0" }),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ reason: "credential_pin_missing" });
    expect(w.fake.requests).toEqual([]);
  });

  it("a manifest naming another app than the one assigned: inert (pin_mismatch)", async () => {
    const w = await teamWorld();
    await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
      product: SLUG,
    });
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ?",
      JSON.stringify({ appleId: OTHER_APP, bundleId: "gg.acme.other" }),
      SLUG,
    );
    w.fake.requests.length = 0;
    expect((await resolveAscSetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "pin_mismatch",
      pinnedAppleId: APPLE_ID,
      manifestAppleId: OTHER_APP,
      credentialSource: "platform",
    });
    await poll(w);
    expect(w.fake.requests).toEqual([]);
  });

  it("a product can never act on another product's app: setup, token and open all refuse", async () => {
    const w = await teamWorld();
    // OTHER holds OTHER_APP; djdl's manifest names OTHER_APP and djdl has no pin.
    await platform(w, "PUT", `/app-store/apps/${OTHER_APP}/product`, {
      product: OTHER,
    });
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ?",
      JSON.stringify({ appleId: OTHER_APP, bundleId: "gg.acme.other" }),
      SLUG,
    );
    expect((await resolveAscSetup(w.env, w.db, SLUG)).inert?.reason).toBe(
      "pin_missing",
    );
    // Even asked directly, the token and the open refuse djdl for OTHER's app…
    expect(
      await platformAscToken(
        w.env,
        w.db,
        { product: SLUG, pin: OTHER_APP },
        "asc:poll",
        NOW,
      ),
    ).toBeNull();
    expect(
      await openPlatformCredential(
        w.env,
        w.db,
        "app-store.api-key",
        "asc:poll",
        { product: SLUG, pin: OTHER_APP },
        NOW,
      ),
    ).toBeNull();
    const refused = (await audits(w.db)).filter(
      (a) => a.action === "platform_credential.use",
    );
    expect(refused.at(-1)!.summary).toContain("not pinned");
    // …the pin cannot be taken over (the table refuses a second product on one app)…
    const steal = await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: OTHER_APP,
      actor: "x",
      now: NOW,
    });
    expect(steal).toMatchObject({ ok: false, status: 409, holder: OTHER });
    await expect(
      w.db.run(
        "INSERT INTO platform_credential_pins (credential_id, product, pin, pinned_at, pinned_by) VALUES ('app-store.api-key', ?, ?, 0, 'x')",
        SLUG,
        OTHER_APP,
      ),
    ).rejects.toThrow(/UNIQUE/);
    // …and nothing was sent to Apple for djdl.
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.filter((r) => r.path.includes(OTHER_APP))).toEqual(
      [],
    );
  });

  it("a product's own key wins over the team key, and an unpinned own key never falls through", async () => {
    const w = await teamWorld({ apiKey: true });
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: APPLE_ID,
      actor: "x",
      now: NOW,
    });
    expect(
      (await resolveAscSetup(w.env, w.db, SLUG)).setup?.credential,
    ).toEqual({
      source: "product",
      credentialId: "asc",
    });
    await poll(w);
    const actions = (await audits(w.db)).map((a) => a.action);
    expect(actions).toContain("outlet_credential.use");
    expect(actions).not.toContain("platform_credential.use");

    // Unpin the own key: inert on the product's own key, not a silent switch to the team key.
    await w.db.run(
      "UPDATE outlet_credentials SET meta_json = ? WHERE product = ? AND credential_id = 'asc'",
      JSON.stringify({ keyId: "ABC123DEFG", issuerId: ISSUER }),
      SLUG,
    );
    expect((await resolveAscSetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "pin_missing",
      credentialSource: "product",
      apiKeyCredential: "asc",
    });
  });

  it("an own key bound to other outlets is inert on its own terms, never a fall-through", async () => {
    const w = await teamWorld();
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: APPLE_ID,
      actor: "x",
      now: NOW,
    });
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "asc-elsewhere",
      kind: "asc-api-key",
      outletId: "some-other-outlet",
      value: ascKey("OWNKEY1234"),
      pin: APPLE_ID,
      expiresAt: null,
      actor: "x",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect((await resolveAscSetup(w.env, w.db, SLUG)).inert).toMatchObject({
      reason: "no_api_key",
      credentialSource: "product",
    });
    await poll(w);
    expect(w.fake.requests).toEqual([]);
  });

  it("re-assigning to an app with no bundle id releases the old In-App Purchase pin", async () => {
    const w = await teamWorld();
    w.fake.put({
      type: "apps",
      id: "6666666666",
      attributes: { name: "No Bundle", sku: "NB" },
    });
    await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
      product: SLUG,
    });
    const res = await platform(w, "PUT", "/app-store/apps/6666666666/product", {
      product: SLUG,
    });
    expect(await json(res)).toMatchObject({
      released: [
        { credential: "app-store.in-app-purchase-key", pin: "gg.acme.djdl" },
      ],
    });
    expect(
      await platformPin(w.db, "app-store.in-app-purchase-key", SLUG),
    ).toBeNull();
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBe(
      "6666666666",
    );
  });

  it("a console team key wins over the secret for the connector too, and deleting the product frees its app", async () => {
    const w = await teamWorld();
    await putPlatformCredential(w.env, w.db, {
      id: "app-store.api-key",
      value: ascKey(),
      actor: "x",
      now: NOW,
    });
    await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
      product: SLUG,
    });
    expect(
      (await resolveAscSetup(w.env, w.db, SLUG)).setup?.credential,
    ).toEqual({
      source: "platform",
      origin: "console",
    });
    await deleteProduct(w.db, SLUG, NOW);
    expect(await platformPin(w.db, "app-store.api-key", SLUG)).toBeNull();
    expect(
      (
        await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
          product: OTHER,
        })
      ).status,
    ).toBe(200);
  });
});

// ── In-App Purchase key (commerce) ──────────────────────────────────────────────────────────

describe("platform store connections: the commerce bridge falls back to the team In-App Purchase key", () => {
  let cw: CommerceWorld | null = null;
  afterEach(() => {
    cw?.close();
    cw = null;
  });

  async function iapWorld(opts: { pin?: string | null } = {}) {
    cw = await commerceWorld({ credentials: false });
    (cw.env as Record<string, unknown>).PLATFORM_APP_STORE_SERVER_KEY =
      JSON.stringify(ascKey("IAPTEAM123"));
    if (opts.pin !== null)
      await setPlatformPin(cw.db, {
        id: "app-store.in-app-purchase-key",
        product: SLUG,
        pin: opts.pin ?? BUNDLE_ID,
        actor: "x",
        now: NOW,
      });
    return cw;
  }

  async function claimApple(w: CommerceWorld) {
    const binding = await bindingOf(w, w.tokenA);
    const tx = { transactionId: "2000000111", appAccountToken: binding };
    w.fakes.apple.transactions.set(tx.transactionId, tx);
    const jws = await w.fakes.apple.signTransaction(tx, NOW - 60);
    return route(w, "POST", "/distribution/commerce/claim", {
      token: w.tokenA,
      body: { store: "app-store", signedTransaction: jws },
    });
  }

  it("with the bundle id assigned: the claim is confirmed with a team-key token, audited in the product's trail", async () => {
    const w = await iapWorld();
    const res = await claimApple(w);
    expect(res.status).toBe(200);
    expect(await grants(w, w.licenseA)).toHaveLength(1);
    expect(w.fakes.apple.requests[0]!.authorization).toMatch(/^Bearer /);
    const opens = await w.db.all<{ summary: string; target_id: string }>(
      "SELECT summary, target_id FROM audit WHERE product = ? AND action = 'platform_credential.use'",
      SLUG,
    );
    expect(opens).toEqual([
      {
        target_id: "app-store.in-app-purchase-key",
        summary: expect.stringMatching(/opened \(secret\)/),
      },
    ]);
  });

  it("with no pin, or a pin naming another bundle: the store is not set up and nothing is sent", async () => {
    for (const pin of [null, "gg.acme.other"]) {
      const w = await iapWorld({ pin });
      const res = await claimApple(w);
      expect(res.status, String(pin)).toBe(404);
      expect(w.fakes.apple.requests).toEqual([]);
      expect(
        await platformAppStoreServerToken(
          w.env,
          w.db,
          SLUG,
          BUNDLE_ID,
          "commerce:test",
          NOW,
        ),
      ).toBeNull();
      w.close();
      cw = null;
    }
  });

  it("a product's own In-App Purchase key wins over the team key", async () => {
    const w = await iapWorld();
    await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "iap",
      kind: "app-store-server-key",
      outletId: null,
      value: ascKey("IAPOWN1234"),
      pin: BUNDLE_ID,
      expiresAt: null,
      actor: "x",
      now: NOW,
    });
    expect((await claimApple(w)).status).toBe(200);
    const actions = (
      await w.db.all<{ action: string }>(
        "SELECT action FROM audit WHERE product = ? AND action LIKE '%credential.use'",
        SLUG,
      )
    ).map((a) => a.action);
    expect(actions).toEqual(["outlet_credential.use"]);
  });
});

// ── team id, KEK, the audit seam ────────────────────────────────────────────────────────────

describe("platform store connections: the Apple Team ID", () => {
  it("comes from PLATFORM_APPLE_TEAM_ID, a console value wins, a bad value is refused, clearing hands back", async () => {
    const w = await teamWorld();
    (w.env as Record<string, unknown>).PLATFORM_APPLE_TEAM_ID = "48H7CLBV8Y";
    expect(await platformAppleTeamId(w.env, w.db)).toBe("48H7CLBV8Y");
    expect(
      (await appStore(w)).settings.find((s) => s.key === "teamId"),
    ).toMatchObject({ value: "48H7CLBV8Y", source: "env" });

    expect(
      (
        await platform(w, "PUT", "/app-store/settings/teamId", {
          value: "lowercase!",
        })
      ).status,
    ).toBe(422);
    const set = await platform(w, "PUT", "/app-store/settings/teamId", {
      value: "ABCDE12345",
    });
    expect(await json(set)).toMatchObject({ value: "ABCDE12345" });
    expect(await platformAppleTeamId(w.env, w.db)).toBe("ABCDE12345");
    await platform(w, "DELETE", "/app-store/settings/teamId");
    expect(await platformAppleTeamId(w.env, w.db)).toBe("48H7CLBV8Y");
    expect(
      (await platform(w, "PUT", "/app-store/settings/nope", { value: "x" }))
        .status,
    ).toBe(404);
  });
});

describe("platform store connections: custody", () => {
  it("the KEK re-seal sweep counts and re-seals the console team keys under the same AAD", async () => {
    const w = await teamWorld({ secret: false });
    await putPlatformCredential(w.env, w.db, {
      id: "app-store.api-key",
      value: ascKey(),
      actor: "x",
      now: NOW,
    });
    const KEK_NEW = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    const base = { ...(w.env as Record<string, unknown>) };
    delete base.PLATFORM_KEK;
    const env = Object.assign(base, {
      PLATFORM_KEK_KEYS: JSON.stringify({ default: TEST_KEK, k2: KEK_NEW }),
      PLATFORM_KEK_ACTIVE: "k2",
    }) as Env;
    const kek = async (method: string, body?: unknown) =>
      json(
        await handleAdmin(
          await (async () => {
            // A proven step-up: POST /kek is in the step-up table.
            const { token, session } = await issueSession(
              env,
              {
                sub: "u1",
                name: "Ada",
                email: "ada@x.io",
                groups: ["platform-admins"],
                authTime: NOW,
                stepUp: true,
              },
              NOW,
            );
            return new Request(`${CONSOLE}/manage/api/products/kek`, {
              method,
              headers: {
                cookie: `${ADMIN_COOKIE}=${token}`,
                [CSRF_HEADER]: session.csrf,
                "content-type": "application/json",
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            });
          })(),
          env,
          w.db,
          "/api/products/kek",
          { now: NOW },
        ),
      );
    expect(await kek("GET")).toMatchObject({
      counts: { platformCredentials: { default: 1 } },
    });
    expect(await kek("POST", { limit: 200 })).toMatchObject({
      failed: 0,
      remaining: 0,
      counts: { platformCredentials: { k2: 1 } },
    });
    const retired = Object.assign({}, env, {
      PLATFORM_KEK_KEYS: JSON.stringify({ k2: KEK_NEW }),
    }) as Env;
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: APPLE_ID,
      actor: "x",
      now: NOW,
    });
    expect(
      await openPlatformCredential(
        retired,
        w.db,
        "app-store.api-key",
        "asc:test",
        { product: SLUG, pin: APPLE_ID },
        NOW,
      ),
    ).toMatchObject({ source: "console", value: { keyId: "TEAMKEY123" } });
  });

  it("every platform write is a platform_audit row with the session's actor and metadata only", async () => {
    const w = await teamWorld();
    await platform(w, "PUT", "/app-store", { value: ascKey() });
    await platform(w, "PUT", "/app-store/settings/teamId", {
      value: "48H7CLBV8Y",
    });
    await platform(w, "PUT", `/app-store/apps/${APPLE_ID}/product`, {
      product: SLUG,
    });
    await platform(w, "DELETE", `/app-store/apps/${APPLE_ID}/product`);
    await platform(w, "DELETE", "/app-store");
    const rows = await w.db.all<{
      action: string;
      actor_sub: string;
      target_id: string;
      before_json: string | null;
      after_json: string | null;
    }>(
      "SELECT action, actor_sub, target_id, before_json, after_json FROM platform_audit ORDER BY rowid",
    );
    expect(rows.map((r) => r.action)).toEqual([
      "platform_credential.set",
      "platform_store_setting.set",
      "platform_credential.use", // the listing the assignment checks against
      "store_connection.assign",
      "store_connection.unassign",
      "platform_credential.delete",
    ]);
    expect(rows.every((r) => r.actor_sub === "u1")).toBe(true);
    expect(JSON.parse(rows[0]!.after_json!)).toEqual({
      keyId: "TEAMKEY123",
      issuerId: ISSUER,
    });
    for (const r of rows) {
      expect(String(r.after_json)).not.toContain("PRIVATE");
      expect(String(r.before_json)).not.toContain("PRIVATE");
    }
    // A direct append lands in the same table.
    await appendPlatformEvent(w.db, {
      actor: { sub: "u2", name: null, email: null },
      at: NOW,
      action: "test.event",
      target: null,
      summary: "x",
    });
    expect(
      await w.db.first(
        "SELECT action FROM platform_audit WHERE actor_sub = 'u2'",
      ),
    ).toEqual({ action: "test.event" });
  });
});
