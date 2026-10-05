/**
 * A-17b — team provisioning on App Store Connect (notes/S-14 §5.1, §5.2, §7, §8.1; A-17h's live
 * results). Apple is a scripted fake that answers as A-17h measured: a bundle id create is 201 and
 * a duplicate 409 `ENTITY_ERROR.ATTRIBUTE.INVALID`; capability creation is idempotent with ids
 * `<bundleId>_<TYPE>`; there is no `APP_ATTEST` type (409 `ENTITY_ERROR.ATTRIBUTE.TYPE`). No live
 * call is made.
 *
 *   - **Auth and configuration.** Platform admins only; no team key → 409 `not_configured`;
 *     nothing is sent either way.
 *   - **Bundle ids.** Find by identifier (exact, though Apple's filter is not), list, register;
 *     a duplicate (found first, or answered 409 by Apple) is `existing`; one platform-trail row
 *     per write with Apple's before/after; replay, key reuse and a missing key.
 *   - **Capabilities.** The wizard's list (App Attest as entitlement-only), read-before-write by
 *     the deterministic id, only missing types sent; App Attest and types outside the wizard
 *     refused before anything is sent; an ambiguous 5xx resumes without a second create; the
 *     shared-bundle typed confirmation.
 *   - **App lookup**, the background budget, **signing expiry** (read only, never content), the
 *     team ledger listing and the shared budget slot.
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
import { setPlatformPin } from "../src/core/platformCredentials.js";
import { TEAM_RATE_KEY } from "../src/core/storefront/budget.js";
import type { AscResource } from "../src/core/asc/client.js";
import { CONSOLE } from "./releaseRoutesFixture.js";
import { makeTestDb } from "./helpers.js";
import { envFor } from "./releaseRoutesFixture.js";
import { ascP8 } from "./ascWorld.js";
import { NOW, seedProduct } from "./seed.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const ASC = "https://api.appstoreconnect.apple.com";
const SLUG = "djdl";
const OTHER = "other";
const KEY = "0f8e2d3c-1111-4222-8333-944455556666";
const KEY2 = "1a2b3c4d-5555-4666-8777-988899990000";

interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

/** App Store Connect's provisioning endpoints, as A-17h measured them. */
class TeamFake {
  readonly requests: Req[] = [];
  readonly foreignHost: string[] = [];
  bundleIds: AscResource[] = [];
  capabilities: AscResource[] = [];
  apps: AscResource[] = [];
  certificates: AscResource[] = [];
  profiles: AscResource[] = [];
  rate = { limit: 3600, remaining: 3000 };
  /** The next POST creates, then answers this status (an ambiguous outcome). */
  failAfterCreate: number | null = null;
  /** `filter[identifier]` misses this many times (Apple's list lag, S-14 §5.5). */
  filterLag = 0;
  private next = 1;

  writes(): Req[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== ASC) {
      this.foreignHost.push(input);
      return new Response("refused", { status: 599 });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    this.rate.remaining--;
    const r = this.route(method, url, body);
    let status = r.status;
    let payload = r.body;
    if (method === "POST" && this.failAfterCreate !== null && status < 300) {
      status = this.failAfterCreate;
      payload = {
        errors: [{ status: String(status), code: "UNEXPECTED_ERROR" }],
      };
      this.failAfterCreate = null;
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        "content-type": "application/json",
        "X-Rate-Limit": `user-hour-lim:${this.rate.limit};user-hour-rem:${this.rate.remaining};`,
      },
    });
  };

  private route(
    method: string,
    url: URL,
    body: unknown,
  ): { status: number; body: unknown } {
    const p = url.pathname.split("/").filter(Boolean);
    const q = url.searchParams;
    const list = (data: AscResource[], included: AscResource[] = []) => ({
      status: 200,
      body: { data, included, links: { self: url.toString() } },
    });
    const notFound = {
      status: 404,
      body: { errors: [{ status: "404", code: "NOT_FOUND" }] },
    };
    const data =
      (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    const attrs = (data.attributes ?? {}) as Record<string, unknown>;

    if (method === "GET" && p[1] === "bundleIds" && p.length === 2) {
      const f = q.get("filter[identifier]");
      if (f !== null && this.filterLag > 0) {
        this.filterLag--;
        return list([]);
      }
      // Apple's identifier filter is not an exact match: answer prefix matches too.
      return list(
        this.bundleIds.filter(
          (b) => f === null || String(b.attributes?.identifier).startsWith(f),
        ),
      );
    }
    if (method === "GET" && p[1] === "bundleIds" && p.length === 3) {
      const b = this.bundleIds.find((x) => x.id === p[2]);
      return b ? { status: 200, body: { data: b } } : notFound;
    }
    if (
      method === "GET" &&
      p[1] === "bundleIds" &&
      p[3] === "bundleIdCapabilities"
    ) {
      if (!this.bundleIds.some((x) => x.id === p[2])) return notFound;
      return list(this.capabilities.filter((c) => c.id.startsWith(`${p[2]}_`)));
    }
    if (method === "POST" && p[1] === "bundleIds") {
      if (
        this.bundleIds.some(
          (b) => b.attributes?.identifier === attrs.identifier,
        )
      )
        return {
          status: 409,
          body: {
            errors: [
              {
                status: "409",
                code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
                detail: "An attribute value is not available",
              },
            ],
          },
        };
      const created: AscResource = {
        type: "bundleIds",
        id: `BND${this.next++}XYZ`,
        attributes: { ...attrs, seedId: "TEAM123456" },
      };
      this.bundleIds.push(created);
      return { status: 201, body: { data: created } };
    }
    if (method === "POST" && p[1] === "bundleIdCapabilities") {
      const type = String(attrs.capabilityType);
      if (!/^[A-Z_]+$/.test(type) || type === "APP_ATTEST")
        return {
          status: 409,
          body: {
            errors: [{ status: "409", code: "ENTITY_ERROR.ATTRIBUTE.TYPE" }],
          },
        };
      const rel = (
        data.relationships as Record<string, { data: { id: string } }>
      ).bundleId!.data.id;
      const id = `${rel}_${type}`;
      const existing = this.capabilities.find((c) => c.id === id);
      const created: AscResource = existing ?? {
        type: "bundleIdCapabilities",
        id,
        attributes: { capabilityType: type, settings: null },
      };
      if (!existing) this.capabilities.push(created);
      return { status: 201, body: { data: created } };
    }
    if (method === "GET" && p[1] === "apps" && p.length === 2) {
      const f = q.get("filter[bundleId]");
      return list(
        this.apps.filter(
          (a) => f === null || String(a.attributes?.bundleId).startsWith(f),
        ),
      );
    }
    if (method === "GET" && p[1] === "certificates")
      return list(this.certificates);
    if (method === "GET" && p[1] === "profiles") {
      const included = this.bundleIds.filter((b) =>
        this.profiles.some(
          (pr) =>
            (pr.relationships?.bundleId?.data as { id: string } | undefined)
              ?.id === b.id,
        ),
      );
      return list(
        this.profiles,
        q.get("include") === "bundleId" ? included : [],
      );
    }
    return notFound;
  }
}

interface World {
  env: Env;
  db: Db;
  fake: TeamFake;
}

async function world(opts: { key?: boolean } = {}): Promise<World> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  await seedProduct(db, OTHER);
  const env = envFor();
  if (opts.key !== false)
    (env as unknown as Record<string, unknown>).PLATFORM_ASC_API_KEY =
      JSON.stringify({
        keyId: "TEAMKEY123",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: ascP8(),
      });
  const fake = new TeamFake();
  fake.bundleIds.push({
    type: "bundleIds",
    id: "HPA5436NK7",
    attributes: {
      identifier: "gg.acme.other",
      name: "gg acme other",
      platform: "IOS",
      seedId: "TEAM123456",
    },
  });
  fake.capabilities.push({
    type: "bundleIdCapabilities",
    id: "HPA5436NK7_IN_APP_PURCHASE",
    attributes: { capabilityType: "IN_APP_PURCHASE" },
  });
  fake.capabilities.push({
    type: "bundleIdCapabilities",
    id: "HPA5436NK7_MUSIC_KIT",
    attributes: { capabilityType: "MUSIC_KIT" },
  });
  fake.apps.push({
    type: "apps",
    id: "5555555555",
    attributes: {
      name: "Other Game",
      bundleId: "gg.acme.other",
      sku: "OTHER",
      primaryLocale: "en-US",
    },
  });
  return { env, db, fake };
}

async function api(
  w: World,
  method: string,
  path: string,
  body?: unknown,
  opts: { groups?: string[]; key?: string | null } = {},
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: opts.groups ?? ["platform-admins"],
    },
    NOW,
  );
  const [bare, query] = path.split("?");
  const full = `/api/platform/store-connections/app-store${bare}`;
  const saved = globalThis.fetch;
  globalThis.fetch = w.fake.fetchImpl as typeof fetch;
  const key = opts.key === undefined ? KEY : opts.key;
  try {
    return await handleAdmin(
      new Request(`${CONSOLE}/manage${full}${query ? `?${query}` : ""}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
          ...(key !== null && method !== "GET"
            ? { "idempotency-key": key }
            : {}),
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

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function platformTrail(db: Db) {
  return db.all<{
    action: string;
    actor_sub: string;
    target_id: string | null;
    summary: string;
    before_json: string | null;
    after_json: string | null;
  }>(
    "SELECT action, actor_sub, target_id, summary, before_json, after_json FROM platform_audit WHERE action LIKE 'platform.asc.%' ORDER BY rowid",
  );
}

async function ledger(db: Db) {
  return db.all<{ op: string; natural_key: string; state: string }>(
    "SELECT op, natural_key, state FROM store_operations ORDER BY rowid",
  );
}

// ── auth and configuration ───────────────────────────────────────────────────────────────────

describe("A-17b: who may provision", () => {
  it("answers 403 to a signed-in non-admin on every route and sends nothing", async () => {
    const w = await world();
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/capability-types"],
      ["GET", "/bundle-ids"],
      ["GET", "/bundle-ids?identifier=gg.acme.other"],
      ["POST", "/bundle-ids", { identifier: "gg.acme.new", platform: "IOS" }],
      ["GET", "/bundle-ids/HPA5436NK7/capabilities"],
      [
        "POST",
        "/bundle-ids/HPA5436NK7/capabilities",
        { types: ["PUSH_NOTIFICATIONS"] },
      ],
      ["GET", "/apps/lookup?bundleId=gg.acme.other"],
      ["GET", "/signing"],
      ["GET", "/operations"],
    ];
    for (const [m, p, b] of calls) {
      const res = await api(w, m, p, b, { groups: ["staff"] });
      expect(res.status, `${m} ${p}`).toBe(403);
    }
    expect(w.fake.requests).toEqual([]);
    expect(await ledger(w.db)).toEqual([]);
  });

  it("answers 409 not_configured without a team key, and sends nothing", async () => {
    const w = await world({ key: false });
    for (const [m, p, b] of [
      ["GET", "/bundle-ids"],
      ["POST", "/bundle-ids", { identifier: "gg.acme.new", platform: "IOS" }],
      ["GET", "/apps/lookup?bundleId=gg.acme.other"],
      ["GET", "/signing"],
    ] as Array<[string, string, unknown?]>) {
      const res = await api(w, m, p, b);
      expect(res.status, `${m} ${p}`).toBe(409);
      expect((await json(res)).code).toBe("not_configured");
    }
    expect(w.fake.requests).toEqual([]);
  });

  it("lists the wizard's capability types without calling Apple: App Attest is entitlement-only", async () => {
    const w = await world();
    const res = await api(w, "GET", "/capability-types");
    expect(res.status).toBe(200);
    const body = await json(res);
    const types = body.capabilities as Array<{
      type: string;
      kind: string;
      note: string | null;
    }>;
    expect(types.map((t) => t.type)).toEqual([
      "IN_APP_PURCHASE",
      "PUSH_NOTIFICATIONS",
      "APPLE_ID_AUTH",
      "GAME_CENTER",
      "ASSOCIATED_DOMAINS",
      "APP_GROUPS",
      "ICLOUD",
      "APP_ATTEST",
    ]);
    expect(types.find((t) => t.type === "APP_ATTEST")).toMatchObject({
      kind: "entitlement",
      note: "entitlement in the export preset; no portal step",
    });
    expect(w.fake.requests).toEqual([]);
  });
});

// ── bundle ids ───────────────────────────────────────────────────────────────────────────────

describe("A-17b: bundle ids", () => {
  it("finds a bundle id by its exact identifier, with its capabilities, app and holder", async () => {
    const w = await world();
    w.fake.bundleIds.push({
      type: "bundleIds",
      id: "LONGER0001",
      attributes: { identifier: "gg.acme.other.extra", platform: "IOS" },
    });
    await setPlatformPin(w.db, {
      id: "app-store.api-key",
      product: OTHER,
      pin: "5555555555",
      actor: "u1",
      now: NOW,
    });
    const res = await api(w, "GET", "/bundle-ids?identifier=gg.acme.other");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      found: true,
      bundleId: {
        id: "HPA5436NK7",
        identifier: "gg.acme.other",
        platform: "IOS",
      },
      app: {
        appId: "5555555555",
        name: "Other Game",
        bundleId: "gg.acme.other",
      },
      assignedProduct: OTHER,
      other: ["MUSIC_KIT"],
    });
    const iap = body.capabilities as Array<{
      type: string;
      enabled: boolean | null;
    }>;
    expect(iap.find((c) => c.type === "IN_APP_PURCHASE")?.enabled).toBe(true);
    expect(iap.find((c) => c.type === "PUSH_NOTIFICATIONS")?.enabled).toBe(
      false,
    );
    expect(iap.find((c) => c.type === "APP_ATTEST")?.enabled).toBeNull();
    expect(w.fake.writes()).toEqual([]);
    // Bearer-only, one host.
    expect(w.fake.foreignHost).toEqual([]);
    expect(
      w.fake.requests.every((r) => /^Bearer /.test(r.authorization ?? "")),
    ).toBe(true);
  });

  it("answers found: false for an unknown identifier, and refuses a malformed one", async () => {
    const w = await world();
    const res = await api(w, "GET", "/bundle-ids?identifier=gg.acme.none");
    expect(await json(res)).toMatchObject({
      found: false,
      bundleId: null,
      app: null,
      assignedProduct: null,
    });
    const bad = await api(w, "GET", "/bundle-ids?identifier=gg.acme.*");
    expect(bad.status).toBe(422);
  });

  it("lists the team's bundle ids", async () => {
    const w = await world();
    const res = await api(w, "GET", "/bundle-ids");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      bundleIds: [{ id: "HPA5436NK7", identifier: "gg.acme.other" }],
      truncated: false,
    });
  });

  it("registers a bundle id through the gate: one POST, Apple's re-read, one platform-trail row", async () => {
    const w = await world();
    const res = await api(w, "POST", "/bundle-ids", {
      identifier: "gg.acme.djdl",
      platform: "IOS",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      ok: true,
      outcome: "written",
      resultIds: { bundleId: "BND1XYZ" },
      after: {
        type: "bundleIds",
        id: "BND1XYZ",
        attributes: { identifier: "gg.acme.djdl", platform: "IOS" },
      },
    });
    expect(w.fake.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/v1/bundleIds",
        body: {
          data: {
            type: "bundleIds",
            attributes: {
              identifier: "gg.acme.djdl",
              name: "gg acme djdl",
              platform: "IOS",
            },
          },
        },
      }),
    ]);
    const trail = await platformTrail(w.db);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "platform.asc.bundle_id.register",
      actor_sub: "u1",
      target_id: "BND1XYZ",
    });
    // Nothing existed before: Apple's pre-read found no bundle id.
    expect(JSON.parse(trail[0]!.before_json ?? "null")).toBeNull();
    expect(JSON.parse(trail[0]!.after_json!)).toMatchObject({
      attributes: { identifier: "gg.acme.djdl" },
    });
    expect(await ledger(w.db)).toEqual([
      { op: "bundle_id.register", natural_key: "gg.acme.djdl", state: "done" },
    ]);
    // The team key's budget is kept in its one platform-wide slot.
    const rate = JSON.parse((await w.env.HOT.get(TEAM_RATE_KEY))!);
    expect(rate).toMatchObject({ limit: 3600 });
  });

  it("replays a done key without calling Apple, and refuses the key for another body", async () => {
    const w = await world();
    const body = { identifier: "gg.acme.djdl", platform: "IOS" };
    await api(w, "POST", "/bundle-ids", body);
    const sent = w.fake.requests.length;
    const again = await api(w, "POST", "/bundle-ids", body);
    expect(await json(again)).toMatchObject({
      outcome: "replayed",
      resultIds: { bundleId: "BND1XYZ" },
    });
    expect(w.fake.requests.length).toBe(sent);
    // The same key (and natural key) with another body is a reused key: refused, nothing sent.
    const other = await api(w, "POST", "/bundle-ids", {
      identifier: "gg.acme.djdl",
      platform: "UNIVERSAL",
    });
    expect(other.status).toBe(409);
    expect((await json(other)).code).toBe("idempotency_conflict");
    expect(w.fake.writes()).toHaveLength(1);
  });

  it("treats an identifier that already exists as existing: found first, nothing sent", async () => {
    const w = await world();
    const res = await api(w, "POST", "/bundle-ids", {
      identifier: "gg.acme.other",
      platform: "IOS",
    });
    expect(await json(res)).toMatchObject({
      outcome: "existing",
      resultIds: { bundleId: "HPA5436NK7" },
    });
    expect(w.fake.writes()).toEqual([]);
    expect(await platformTrail(w.db)).toEqual([]);
  });

  it("treats Apple's duplicate answer (409 ENTITY_ERROR.ATTRIBUTE.INVALID) as existing after a re-read", async () => {
    const w = await world();
    w.fake.filterLag = 1; // the pre-read misses the id Apple already has
    const res = await api(w, "POST", "/bundle-ids", {
      identifier: "gg.acme.other",
      platform: "IOS",
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      outcome: "existing",
      resultIds: { bundleId: "HPA5436NK7" },
    });
    expect(w.fake.writes()).toHaveLength(1);
    expect(await ledger(w.db)).toEqual([
      { op: "bundle_id.register", natural_key: "gg.acme.other", state: "done" },
    ]);
  });

  it("refuses a write without an Idempotency-Key, and malformed input, before anything is sent", async () => {
    const w = await world();
    const none = await api(
      w,
      "POST",
      "/bundle-ids",
      { identifier: "gg.acme.djdl", platform: "IOS" },
      { key: null },
    );
    expect(none.status).toBe(428);
    expect((await json(none)).code).toBe("idempotency_key_required");
    for (const body of [
      { identifier: "gg.acme.*", platform: "IOS" },
      { identifier: "djdl", platform: "IOS" },
      { identifier: "gg.acme.djdl", platform: "TV_OS" },
      { identifier: "gg.acme.djdl", platform: "IOS", name: "Bad & name" },
    ]) {
      const res = await api(w, "POST", "/bundle-ids", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(w.fake.requests).toEqual([]);
    expect(await ledger(w.db)).toEqual([]);
  });
});

// ── capabilities ─────────────────────────────────────────────────────────────────────────────

describe("A-17b: capabilities", () => {
  it("lists a bundle id's capabilities against the wizard's list; 404 for an unknown id", async () => {
    const w = await world();
    const res = await api(w, "GET", "/bundle-ids/HPA5436NK7/capabilities");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.bundleId).toMatchObject({ identifier: "gg.acme.other" });
    expect(body.other).toEqual(["MUSIC_KIT"]);
    const missing = await api(w, "GET", "/bundle-ids/NOPE000000/capabilities");
    expect(missing.status).toBe(404);
  });

  it("enables only the missing types, by the deterministic id, one platform-trail row each", async () => {
    const w = await world();
    const res = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
      types: ["IN_APP_PURCHASE", "PUSH_NOTIFICATIONS", "GAME_CENTER"],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.results).toEqual([
      expect.objectContaining({
        type: "IN_APP_PURCHASE",
        outcome: "existing",
        resultIds: { capabilityId: "HPA5436NK7_IN_APP_PURCHASE" },
      }),
      expect.objectContaining({
        type: "PUSH_NOTIFICATIONS",
        outcome: "written",
        resultIds: { capabilityId: "HPA5436NK7_PUSH_NOTIFICATIONS" },
      }),
      expect.objectContaining({
        type: "GAME_CENTER",
        outcome: "written",
        resultIds: { capabilityId: "HPA5436NK7_GAME_CENTER" },
      }),
    ]);
    expect(
      w.fake
        .writes()
        .map((r) => (r.body as any).data.attributes.capabilityType),
    ).toEqual(["PUSH_NOTIFICATIONS", "GAME_CENTER"]);
    expect(w.fake.writes()[0]!.body).toEqual({
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: "HPA5436NK7" } },
        },
      },
    });
    expect((await platformTrail(w.db)).map((r) => r.action)).toEqual([
      "platform.asc.capability.enable",
      "platform.asc.capability.enable",
    ]);
    const caps = body.capabilities as Array<{
      type: string;
      enabled: boolean | null;
    }>;
    expect(caps.filter((c) => c.enabled === true).map((c) => c.type)).toEqual([
      "IN_APP_PURCHASE",
      "PUSH_NOTIFICATIONS",
      "GAME_CENTER",
    ]);
  });

  it("refuses App Attest (an entitlement, not a capability) and types outside the wizard, sending nothing", async () => {
    const w = await world();
    const attest = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
      types: ["APP_ATTEST"],
    });
    expect(attest.status).toBe(422);
    expect(await json(attest)).toMatchObject({
      code: "entitlement_only",
      message: expect.stringContaining(
        "entitlement in the export preset; no portal step",
      ),
    });
    for (const types of [
      ["DATA_PROTECTION"],
      ["MUSIC_KIT"],
      [],
      "PUSH_NOTIFICATIONS",
    ]) {
      const res = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
        types,
      });
      expect(res.status, JSON.stringify(types)).toBe(422);
    }
    expect(w.fake.requests).toEqual([]);
  });

  it("resumes an ambiguous create (5xx after Apple created it) without a second POST", async () => {
    const w = await world();
    w.fake.failAfterCreate = 500;
    const first = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
      types: ["PUSH_NOTIFICATIONS"],
    });
    expect(first.status).toBe(502);
    expect(await json(first)).toMatchObject({
      code: "store_unavailable",
      appleStatus: 500,
      type: "PUSH_NOTIFICATIONS",
    });
    expect((await ledger(w.db))[0]).toMatchObject({ state: "ambiguous" });
    const again = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
      types: ["PUSH_NOTIFICATIONS"],
    });
    expect(await json(again)).toMatchObject({
      results: [expect.objectContaining({ outcome: "existing" })],
    });
    expect(w.fake.writes()).toHaveLength(1);
    expect((await ledger(w.db))[0]).toMatchObject({ state: "done" });
  });

  describe("a bundle id another product's app uses: typed confirmation", () => {
    async function held() {
      const w = await world();
      await setPlatformPin(w.db, {
        id: "app-store.api-key",
        product: OTHER,
        pin: "5555555555",
        actor: "u1",
        now: NOW,
      });
      return w;
    }

    it("refuses without confirm, naming the holder, and sends nothing", async () => {
      const w = await held();
      const res = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
        types: ["PUSH_NOTIFICATIONS"],
        product: SLUG,
      });
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({
        code: "confirmation_required",
        holder: OTHER,
        appName: "Other Game",
      });
      // Also without any product named.
      const anon = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
        types: ["PUSH_NOTIFICATIONS"],
      });
      expect((await json(anon)).code).toBe("confirmation_required");
      const wrong = await api(
        w,
        "POST",
        "/bundle-ids/HPA5436NK7/capabilities",
        {
          types: ["PUSH_NOTIFICATIONS"],
          product: SLUG,
          confirm: "other game",
        },
      );
      expect((await json(wrong)).code).toBe("confirmation_mismatch");
      expect(w.fake.writes()).toEqual([]);
    });

    it("proceeds with the app's name typed, or for the holding product itself", async () => {
      const w = await held();
      const typed = await api(
        w,
        "POST",
        "/bundle-ids/HPA5436NK7/capabilities",
        {
          types: ["PUSH_NOTIFICATIONS"],
          product: SLUG,
          confirm: "Other Game",
        },
      );
      expect(typed.status).toBe(200);
      const own = await api(
        w,
        "POST",
        "/bundle-ids/HPA5436NK7/capabilities",
        { types: ["GAME_CENTER"], product: OTHER },
        { key: KEY2 },
      );
      expect(own.status).toBe(200);
      expect(w.fake.writes()).toHaveLength(2);
    });

    it("needs no confirmation when nothing would change", async () => {
      const w = await held();
      const res = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
        types: ["IN_APP_PURCHASE"],
        product: SLUG,
      });
      expect(res.status).toBe(200);
      expect(w.fake.writes()).toEqual([]);
    });

    it("counts the In-App Purchase key's bundle-id pin as holding the bundle id", async () => {
      const w = await world();
      w.fake.apps = [];
      await setPlatformPin(w.db, {
        id: "app-store.in-app-purchase-key",
        product: OTHER,
        pin: "gg.acme.other",
        actor: "u1",
        now: NOW,
      });
      const res = await api(w, "POST", "/bundle-ids/HPA5436NK7/capabilities", {
        types: ["PUSH_NOTIFICATIONS"],
        product: SLUG,
      });
      expect(await json(res)).toMatchObject({
        code: "confirmation_required",
        holder: OTHER,
        appName: null,
      });
      const typed = await api(
        w,
        "POST",
        "/bundle-ids/HPA5436NK7/capabilities",
        {
          types: ["PUSH_NOTIFICATIONS"],
          product: SLUG,
          confirm: "gg.acme.other",
        },
      );
      expect(typed.status).toBe(200);
    });
  });
});

// ── app lookup ───────────────────────────────────────────────────────────────────────────────

describe("A-17b: app lookup by bundle id", () => {
  it("finds the app with exactly that bundle id, or answers found: false", async () => {
    const w = await world();
    w.fake.apps.push({
      type: "apps",
      id: "6666666666",
      attributes: { name: "Longer", bundleId: "gg.acme.other.extra" },
    });
    const hit = await api(w, "GET", "/apps/lookup?bundleId=gg.acme.other");
    expect(await json(hit)).toMatchObject({
      found: true,
      app: { appId: "5555555555", name: "Other Game", sku: "OTHER" },
      assignedProduct: null,
    });
    const miss = await api(w, "GET", "/apps/lookup?bundleId=gg.acme.djdl");
    expect(await json(miss)).toMatchObject({ found: false, app: null });
    const bad = await api(w, "GET", "/apps/lookup?bundleId=nope");
    expect(bad.status).toBe(422);
    expect(w.fake.requests.every((r) => r.method === "GET")).toBe(true);
    expect(w.fake.requests[0]!.query["filter[bundleId]"]).toBe("gg.acme.other");
  });

  it("pauses the wizard's background polling when the team budget is low; an operator check still runs", async () => {
    const w = await world();
    await w.env.HOT.put(
      TEAM_RATE_KEY,
      JSON.stringify({ limit: 3600, remaining: 500, at: NOW }),
    );
    const polled = await api(
      w,
      "GET",
      "/apps/lookup?bundleId=gg.acme.other&poll=1",
    );
    expect(polled.status).toBe(429);
    expect((await json(polled)).code).toBe("asc_budget_low");
    expect(w.fake.requests).toEqual([]);
    const pressed = await api(w, "GET", "/apps/lookup?bundleId=gg.acme.other");
    expect(pressed.status).toBe(200);
    expect(w.fake.requests).toHaveLength(1);
  });
});

// ── signing expiry, ledger ───────────────────────────────────────────────────────────────────

describe("A-17b: signing expiry (read only)", () => {
  it("lists certificates and profiles with their expiry, never their content", async () => {
    const w = await world();
    const day = 86400 * 1000;
    const iso = (days: number) =>
      new Date(NOW * 1000 + days * day).toISOString();
    w.fake.certificates = [
      {
        type: "certificates",
        id: "CERT1",
        attributes: {
          name: "Apple Distribution",
          displayName: "Apple Distribution: Acme",
          certificateType: "DISTRIBUTION",
          platform: null,
          expirationDate: iso(10),
          certificateContent: "MIIB-SECRET-CONTENT",
          serialNumber: "SERIAL-123",
        },
      },
      {
        type: "certificates",
        id: "CERT2",
        attributes: {
          name: "Developer ID",
          certificateType: "DEVELOPER_ID_APPLICATION_G2",
          expirationDate: iso(400),
        },
      },
    ];
    w.fake.profiles = [
      {
        type: "profiles",
        id: "PROF1",
        attributes: {
          name: "Other AppStore",
          profileType: "IOS_APP_STORE",
          profileState: "ACTIVE",
          platform: "IOS",
          expirationDate: iso(-2),
          profileContent: "PROFILE-SECRET-CONTENT",
        },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: "HPA5436NK7" } },
        },
      },
    ];
    const res = await api(w, "GET", "/signing");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET-CONTENT");
    expect(text).not.toContain("SERIAL-123");
    const body = JSON.parse(text) as Record<string, any>;
    expect(body).toMatchObject({ warningDays: 30, expiring: 1, expired: 1 });
    expect(body.certificates).toEqual([
      expect.objectContaining({
        id: "CERT1",
        name: "Apple Distribution: Acme",
        type: "DISTRIBUTION",
        daysLeft: 10,
        expiry: "expiring",
      }),
      expect.objectContaining({ id: "CERT2", expiry: "ok" }),
    ]);
    expect(body.profiles).toEqual([
      expect.objectContaining({
        id: "PROF1",
        state: "ACTIVE",
        bundleId: "gg.acme.other",
        expiry: "expired",
      }),
    ]);
    // Only reads, and the field lists never ask for content.
    expect(w.fake.writes()).toEqual([]);
    for (const r of w.fake.requests) {
      expect(JSON.stringify(r.query)).not.toMatch(/Content|serialNumber/);
    }
  });
});

describe("A-17b: the team ledger", () => {
  it("lists the team scope's operations, newest first", async () => {
    const w = await world();
    await api(w, "POST", "/bundle-ids", {
      identifier: "gg.acme.djdl",
      platform: "IOS",
    });
    const res = await api(w, "GET", "/operations");
    expect(res.status).toBe(200);
    expect((await json(res)).operations).toEqual([
      expect.objectContaining({
        op: "bundle_id.register",
        naturalKey: "gg.acme.djdl",
        state: "done",
        resultIds: { bundleId: "BND1XYZ" },
        actor: "u1",
      }),
    ]);
  });
});
