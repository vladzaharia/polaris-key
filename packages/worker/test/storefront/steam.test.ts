/**
 * A-18g — the Steam storefront adapter (notes/S-15 §4.3, owner decision 5).
 *
 *   - the gate: one write (`SetAppBuildLive` on a NAMED branch), the default branch denied whatever
 *     the confirmation, three reads only, players' and financial data refused for every method;
 *   - the spec pin is the digest of the hand-written operation list;
 *   - the gated client: nothing opened or sent before the gate admits, the key only on the publisher
 *     host, the per-day budget counted, and the FIRST 403 stops every later call;
 *   - the admin surface end to end against a fake Steam: the plan (copy card, checklist, links),
 *     reads, the idempotent named-branch release with its ledger row and audit, the public-branch
 *     deep link, the asset pack download, and checklist ticks that persist and audit;
 *   - nothing but the gate and the client spells `SetAppBuildLive`.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  checkSteamRequest,
  STEAM_COMPILED_GATE,
  STEAM_READS,
  STEAM_SET_LIVE,
  STEAM_SPEC_PIN,
} from "../../src/core/storefront/rules/steam.js";
import { STEAM_WRITE_DENIED } from "../../src/core/storefront/rules/steamDenied.js";
import { admits } from "../../src/core/storefront/gate.js";
import {
  StoreVendorError,
  StoreWriteDenied,
} from "../../src/core/storefront/errors.js";
import {
  parseBetas,
  parseBuilds,
  SteamClient,
  type SteamBudget,
} from "../../src/core/steam/client.js";
import { readRate, storeMeter } from "../../src/core/storefront/budget.js";
import { setPlatformPin } from "../../src/core/platformCredentials.js";
import {
  blobKey,
  putVerified,
  recordObject,
  recordRef,
} from "../../src/core/blobs.js";
import { stmtUpsertAsset } from "../../src/services/distribution/listing/store.js";
import { steamCopyCard } from "../../src/services/distribution/storefronts/steam/copyCard.js";
import { handleAdmin } from "../../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../../src/admin/session.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { CONSOLE, enableServices, envFor } from "../releaseRoutesFixture.js";
import { R2Mock, asR2, installDigestStream } from "../r2Mock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..", "..");

// ── The gate ─────────────────────────────────────────────────────────────────────────────────

const setLive = (betakey: string, more: Record<string, string> = {}) => ({
  appid: "480",
  buildid: "12345",
  betakey,
  ...more,
});

function reason(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof StoreWriteDenied ? e.reason : String(e);
  }
}

describe("the Steam gate", () => {
  it("admits SetAppBuildLive on a named branch, with an optional description", () => {
    expect(
      admits(STEAM_COMPILED_GATE, "POST", STEAM_SET_LIVE, setLive("beta")),
    ).toBe(true);
    expect(
      admits(
        STEAM_COMPILED_GATE,
        "POST",
        STEAM_SET_LIVE,
        setLive("staging", { description: "nightly" }),
      ),
    ).toBe(true);
  });

  it("denies the default branch whatever the confirmation (decision 5)", () => {
    for (const b of ["public", "Public", "PUBLIC", "default"])
      for (const ctx of [
        {},
        { typedConfirmation: true },
        { typedConfirmation: true, initial: true },
      ])
        expect(
          reason(() =>
            checkSteamRequest("POST", STEAM_SET_LIVE, setLive(b), ctx),
          ),
          b,
        ).toBe("value_not_allowed");
  });

  it("refuses steamid (only the default branch needs it), a missing field, and malformed values", () => {
    expect(
      reason(() =>
        checkSteamRequest(
          "POST",
          STEAM_SET_LIVE,
          setLive("beta", { steamid: "76561198000000001" }),
        ),
      ),
    ).toBe("attribute_not_allowed");
    expect(
      reason(() =>
        checkSteamRequest("POST", STEAM_SET_LIVE, {
          appid: "480",
          betakey: "beta",
        }),
      ),
    ).toBe("invalid_body");
    expect(
      reason(() =>
        checkSteamRequest(
          "POST",
          STEAM_SET_LIVE,
          setLive("beta", { buildid: "12x" }),
        ),
      ),
    ).toBe("value_not_allowed");
    expect(
      reason(() => checkSteamRequest("POST", STEAM_SET_LIVE, setLive("../x"))),
    ).toBe("value_not_allowed");
  });

  it("reads only the app list, builds and branches; players' data is personal for every method", () => {
    for (const p of Object.values(STEAM_READS))
      expect(admits(STEAM_COMPILED_GATE, "GET", p)).toBe(true);
    expect(
      reason(() =>
        checkSteamRequest(
          "GET",
          "/ISteamApps/GetAppDepotVersions/v1/",
          undefined,
        ),
      ),
    ).toBe("not_allowed");
    // A write method spelled as a read cannot stand in for the write.
    expect(
      reason(() =>
        checkSteamRequest(
          "GET",
          "/ISteamLeaderboards/DeleteLeaderboard/v1/",
          undefined,
        ),
      ),
    ).toBe("not_allowed");
    for (const m of ["GET", "POST"])
      expect(
        reason(() =>
          checkSteamRequest(
            m,
            "/ISteamUser/GetPlayerSummaries/v2/",
            m === "GET" ? undefined : {},
          ),
        ),
      ).toBe("personal_data");
    expect(
      reason(() =>
        checkSteamRequest("GET", "/x/../ISteamApps/GetAppBetas/v1/", undefined),
      ),
    ).toBe("invalid_path");
    expect(
      reason(() =>
        checkSteamRequest("GET", "/ISteamApps/GetAppBetas/v1", undefined),
      ),
    ).toBe("invalid_path");
  });

  it("is pinned to the digest of the hand-written operation list, which is exactly allow + denied", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(HERE, "..", "fixtures", "steam", "webapi-writes.json"),
        "utf8",
      ),
    ) as {
      source: { sha256: string; version: string };
      operations: { method: string; path: string }[];
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(fixture.operations))
      .digest("hex");
    expect(digest).toBe(STEAM_SPEC_PIN.sha256);
    expect(fixture.source.sha256).toBe(digest);
    expect(fixture.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      `POST ${STEAM_SET_LIVE}`,
      ...Object.values(STEAM_WRITE_DENIED).flat(),
    ]);
  });
});

// ── The client ───────────────────────────────────────────────────────────────────────────────

describe("the gated Steam client", () => {
  function counting(status = 200, body = "{}") {
    const c = { keys: 0, sent: [] as { url: URL; init: RequestInit }[] };
    const client = (budget?: SteamBudget) =>
      new SteamClient({
        key: async () => {
          c.keys++;
          return "SECRETKEY";
        },
        fetchImpl: async (input, init) => {
          c.sent.push({ url: new URL(input), init: init ?? {} });
          return new Response(body, { status });
        },
        ...(budget ? { budget } : {}),
      });
    return { c, client };
  }

  it("opens no key and sends nothing for a refused request", async () => {
    const { c, client } = counting();
    await expect(
      client().request("POST", STEAM_SET_LIVE, setLive("public")),
    ).rejects.toBeInstanceOf(StoreWriteDenied);
    await expect(
      client().request("POST", "/ISteamMicroTxn/RefundTxn/v2/", {}),
    ).rejects.toBeInstanceOf(StoreWriteDenied);
    expect(c.keys).toBe(0);
    expect(c.sent).toEqual([]);
  });

  it("sends the key only to the publisher host: a read's query, a write's form body", async () => {
    const { c, client } = counting();
    await client().request("GET", STEAM_READS.betas, { appid: "480" });
    await client().setBuildLive("480", "12345", "beta");
    expect(c.sent.map((s) => s.url.origin)).toEqual([
      "https://partner.steam-api.com",
      "https://partner.steam-api.com",
    ]);
    expect(c.sent[0]!.url.searchParams.get("key")).toBe("SECRETKEY");
    expect(c.sent[0]!.init.redirect).toBe("manual");
    expect(c.sent[1]!.url.search).toBe("");
    const form = new URLSearchParams(String(c.sent[1]!.init.body));
    expect(Object.fromEntries(form)).toEqual({
      key: "SECRETKEY",
      appid: "480",
      buildid: "12345",
      betakey: "beta",
    });
  });

  it("never puts the key or the URL in an error", async () => {
    const { client } = counting(500, "the body said SECRETKEY");
    const e = await client()
      .request("GET", STEAM_READS.apps)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreVendorError);
    expect(String((e as Error).message)).not.toMatch(
      /SECRETKEY|steam-api\.com/,
    );
  });

  it("counts every call against the day, and the FIRST 403 stops every later call before a key is opened", async () => {
    const env = makeEnv(new KvMock(), []);
    const meter = storeMeter(env, "steam", "", { source: "platform" });
    const budget: SteamBudget = {
      stopped: async () => (await meter.read(NOW))?.stopped === true,
      spend: () => meter.spend(NOW),
      stop: () => meter.stop(NOW),
    };
    const ok = counting();
    await ok.client(budget).request("GET", STEAM_READS.apps);
    expect(
      (await readRate(env, "steam", "", { source: "platform" }, NOW))!
        .remaining,
    ).toBe(99_999);

    const denied = counting(403);
    const e = await denied
      .client(budget)
      .request("GET", STEAM_READS.apps)
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 403 });
    expect(
      (await readRate(env, "steam", "", { source: "platform" }, NOW + 1))!
        .stopped,
    ).toBe(true);

    const after = counting();
    await expect(
      after.client(budget).request("GET", STEAM_READS.apps),
    ).rejects.toMatchObject({
      status: 429,
      code: "budget_stopped",
    });
    expect(after.c.keys).toBe(0);
    expect(after.c.sent).toEqual([]);
    // The stop lifts when the day's window ends.
    expect(
      await readRate(env, "steam", "", { source: "platform" }, NOW + 86_401),
    ).toBeNull();
  });

  it("parses builds and branches, dropping the creator and anything malformed", () => {
    expect(
      parseBuilds({
        response: {
          builds: {
            "100": {
              BuildID: 100,
              Description: "a",
              CreationTime: 5,
              AccountIDCreator: 99,
            },
            "101": { BuildID: 101, Description: "b", CreationTime: 6 },
            bad: { BuildID: "x" },
          },
        },
      }),
    ).toEqual([
      { buildId: "101", description: "b", createdAt: 6 },
      { buildId: "100", description: "a", createdAt: 5 },
    ]);
    expect(
      parseBetas({
        response: {
          betas: {
            public: { BuildID: 101, Description: "live", TimeUpdated: 7 },
            beta: { BuildID: 100, ReqPassword: 1 },
            "../evil": { BuildID: 1 },
          },
        },
      }),
    ).toEqual([
      {
        name: "public",
        buildId: "101",
        description: "live",
        updatedAt: 7,
        locked: false,
      },
      {
        name: "beta",
        buildId: "100",
        description: null,
        updatedAt: null,
        locked: true,
      },
    ]);
  });
});

// ── The copy card (pure) ─────────────────────────────────────────────────────────────────────

describe("the store-page copy card", () => {
  it("pre-fills every Steam field per locale from the model and its overrides, never cut", () => {
    const long = "x".repeat(320);
    const card = steamCopyCard({
      model: {
        app: { defaultLocale: "en-US", name: "Dice" },
        locales: {
          "en-US": {
            shortDescription: long,
            description: "Roll.",
            keywords: ["dice", "party"],
          },
          "de-DE": { name: "Würfel", description: "Würfeln." },
        },
        overrides: [
          {
            store: "steam",
            locale: "de-DE",
            field: "shortDescription",
            value: "Kurz",
          },
        ],
      },
    });
    expect(card.locales.map((l) => l.locale)).toEqual(["en-US", "de-DE"]);
    const en = Object.fromEntries(
      card.locales[0]!.fields.map((f) => [f.field, f]),
    );
    expect(en.name!.value).toBe("Dice");
    expect(en.shortDescription!.value).toBe(long);
    expect(en.shortDescription!.status).toBe("amber");
    expect(en.tags!.value).toEqual(["dice", "party"]);
    const de = Object.fromEntries(
      card.locales[1]!.fields.map((f) => [f.field, f]),
    );
    expect(de.name!.value).toBe("Würfel");
    expect(de.shortDescription!.value).toBe("Kurz");
    expect(card.status).toBe("amber");
  });

  it("is red when Steam's required name is missing", () => {
    const card = steamCopyCard({
      model: { app: { defaultLocale: "en-US" }, locales: {}, overrides: [] },
    });
    expect(card.status).toBe("red");
    expect(
      card.locales[0]!.fields.find((f) => f.field === "name")!.value,
    ).toBeNull();
  });
});

// ── The admin surface against a fake Steam ───────────────────────────────────────────────────

const SLUG = "acme";
const APP = "480";
const KEY = "0123456789ABCDEF0123456789ABCDEF";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type LooseResponse = Omit<Response, "json"> & { json(): Promise<Loose> };

interface FakeSteam {
  betas: Record<string, { BuildID: number; Description?: string }>;
  builds: number[];
  calls: { method: string; path: string; params: Record<string, string> }[];
  status: number | null;
}

let db: Db;
let env: Env;
let fake: FakeSteam;
let r2: R2Mock;

function fakeSteam(): FakeSteam {
  const f: FakeSteam = {
    betas: { public: { BuildID: 100 }, beta: { BuildID: 100 } },
    builds: [100, 101],
    calls: [],
    status: null,
  };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const params =
      init?.method === "POST"
        ? Object.fromEntries(new URLSearchParams(String(init.body)))
        : Object.fromEntries(url.searchParams);
    expect(url.origin).toBe("https://partner.steam-api.com");
    expect(params.key).toBe(KEY);
    delete params.key;
    f.calls.push({ method: init?.method ?? "GET", path: url.pathname, params });
    if (f.status !== null) return new Response("{}", { status: f.status });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    switch (url.pathname) {
      case STEAM_READS.apps:
        return ok({
          applist: {
            apps: {
              app: [{ appid: 480, app_type: "game", app_name: "Spacewar" }],
            },
          },
        });
      case STEAM_READS.betas:
        return ok({ response: { result: 1, betas: f.betas } });
      case STEAM_READS.builds:
        return ok({
          response: {
            builds: Object.fromEntries(
              f.builds.map((b) => [
                String(b),
                { BuildID: b, Description: `build ${b}`, CreationTime: NOW },
              ]),
            ),
          },
        });
      case STEAM_SET_LIVE: {
        const b = f.betas[params.betakey!];
        if (b) b.BuildID = Number(params.buildid);
        return ok({ response: { result: 1 } });
      }
    }
    return new Response("{}", { status: 404 });
  });
  return f;
}

async function admin(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<LooseResponse> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution${path}`;
  return (await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full.split("?")[0]!,
    { now: NOW },
  )) as unknown as LooseResponse;
}

async function audits(): Promise<{ action: string; summary: string }[]> {
  return db.all(
    "SELECT action, summary FROM audit WHERE product = ? ORDER BY at, rowid",
    SLUG,
  );
}

beforeAll(() => installDigestStream());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_STEAM_PUBLISHER_KEY = JSON.stringify({ key: KEY });
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
     VALUES (?, 'steam', 'steam', ?, ?, ?)`,
    SLUG,
    JSON.stringify({ appId: 480, branches: { beta: "beta" } }),
    NOW,
    NOW,
  );
  expect(
    (
      await setPlatformPin(db, {
        id: "steam.publisher-key",
        product: SLUG,
        pin: APP,
        actor: "u1",
        now: NOW,
      })
    ).ok,
  ).toBe(true);
  fake = fakeSteam();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the Steam storefront admin surface", () => {
  it("answers the plan without calling Steam: declaration, app, links, checklist, copy card", async () => {
    await admin("PUT", "/listing", {
      app: { defaultLocale: "en-US", name: "Dice" },
      locales: {
        "en-US": {
          shortDescription: "Roll dice.",
          description: "A dice game.",
        },
      },
    });
    const res = await admin("GET", "/storefronts/steam");
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(fake.calls).toEqual([]);
    expect(v.store).toMatchObject({ id: "steam", label: "Steamworks" });
    expect(v.store.ops).toMatchObject({
      testers: "api",
      release: "deep-link",
      writeListingText: "deep-link",
      uploadBuild: "ci",
      pricing: "unsupported",
    });
    expect(v.setup).toMatchObject({
      appId: APP,
      credentialSource: "platform",
      branches: { beta: "beta" },
    });
    expect(v.links).toEqual({
      newApp: "https://partner.steamgames.com/apps/landing",
      storePage: `https://partner.steamgames.com/admin/game/edit/${APP}`,
      appAdmin: `https://partner.steamgames.com/apps/builds/${APP}`,
    });
    expect(v.checklist.map((c: Loose) => c.item)).toEqual([
      "fee_paid",
      "release_wait",
      "coming_soon",
      "store_review",
      "build_review",
    ]);
    expect(
      v.checklist.every((c: Loose) => c.done === false && c.verified === false),
    ).toBe(true);
    expect(v.copyCard.exists).toBe(true);
    expect(
      v.copyCard.locales[0].fields.find((f: Loose) => f.field === "name").value,
    ).toBe("Dice");
    expect(v.pack).toBeNull();
    expect(JSON.stringify(v)).not.toContain(KEY);
  });

  it("reads the partner app list, builds and branches through the gate", async () => {
    const apps = await (await admin("GET", "/storefronts/steam/apps")).json();
    expect(apps).toMatchObject({ appId: APP, listed: true });
    const b = await (await admin("GET", "/storefronts/steam/builds")).json();
    expect(b.branches.map((x: Loose) => x.name)).toEqual(["public", "beta"]);
    expect(b.builds.map((x: Loose) => x.buildId)).toEqual(["101", "100"]);
    expect(b.declared).toEqual([
      { channel: "beta", branch: "beta", buildId: "100" },
    ]);
    expect(b.public).toEqual({
      buildId: "100",
      link: `https://partner.steamgames.com/apps/builds/${APP}`,
    });
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("sets a build live on a named branch once per intent, confirmed by the branch read", async () => {
    const key = "0f8e2d3c-1111-4222-8333-944455556666";
    const res = await admin(
      "POST",
      "/storefronts/steam/branches/beta/live",
      { buildId: "101" },
      { "idempotency-key": key },
    );
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v).toMatchObject({ outcome: "written", live: true });
    expect(v.branch).toMatchObject({
      type: "betas",
      id: "beta",
      attributes: { buildId: "101" },
    });
    expect(fake.calls.filter((c) => c.method === "POST")).toEqual([
      {
        method: "POST",
        path: STEAM_SET_LIVE,
        params: { appid: APP, buildid: "101", betakey: "beta" },
      },
    ]);
    // The same intent again replays the ledger row; nothing is sent.
    const again = await (
      await admin(
        "POST",
        "/storefronts/steam/branches/beta/live",
        { buildId: "101" },
        { "idempotency-key": key },
      )
    ).json();
    expect(again.outcome).toBe("replayed");
    // A new intent for a build already live: found by the natural key, nothing sent.
    const existing = await (
      await admin(
        "POST",
        "/storefronts/steam/branches/beta/live",
        { buildId: "101" },
        { "idempotency-key": "1f8e2d3c-1111-4222-8333-944455556666" },
      )
    ).json();
    expect(existing.outcome).toBe("existing");
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const row = await db.first<Loose>(
      "SELECT * FROM store_operations WHERE store = 'steam' AND op = 'branch.set_live' AND state = 'done' ORDER BY created_at LIMIT 1",
    );
    expect(row).toMatchObject({
      product: SLUG,
      plane: "worker",
      natural_key: `${APP}/beta/101`,
    });
    expect(JSON.parse(row.after_json)).toMatchObject({
      attributes: { buildId: "101" },
    });
    expect(
      (await audits()).filter(
        (a) => a.action === "distribution.steam.branch.set_live",
      ),
    ).toHaveLength(1);
  });

  it("sends the default branch to App Admin (decision 5): nothing reaches Steam", async () => {
    for (const b of ["public", "Public"]) {
      const res = await admin(
        "POST",
        `/storefronts/steam/branches/${b}/live`,
        { buildId: "101" },
        { "idempotency-key": "2f8e2d3c-1111-4222-8333-944455556666" },
      );
      expect(res.status).toBe(409);
      const v = await res.json();
      expect(v.reason).toBe("public_branch_deep_link");
      expect(v.link).toBe(`https://partner.steamgames.com/apps/builds/${APP}`);
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses without an Idempotency-Key, with a bad body, and for a branch Steam does not have", async () => {
    expect(
      (
        await admin("POST", "/storefronts/steam/branches/beta/live", {
          buildId: "101",
        })
      ).status,
    ).toBe(428);
    const key = { "idempotency-key": "3f8e2d3c-1111-4222-8333-944455556666" };
    expect(
      (
        await admin(
          "POST",
          "/storefronts/steam/branches/beta/live",
          { buildId: "x" },
          key,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await admin(
          "POST",
          "/storefronts/steam/branches/beta/live",
          { buildId: "1", steamid: "1" },
          key,
        )
      ).status,
    ).toBe(422);
    const missing = await admin(
      "POST",
      "/storefronts/steam/branches/nightly/live",
      { buildId: "101" },
      key,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).reason).toBe("unknown_branch");
    expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("stops every Steam call after the first 403 until the day's window ends", async () => {
    fake.status = 403;
    const first = await admin("GET", "/storefronts/steam/builds");
    expect(first.status).toBe(502);
    expect((await first.json()).reason).toBe("steam_stopped");
    const sent = fake.calls.length;
    fake.status = null;
    const second = await admin("GET", "/storefronts/steam/apps");
    expect(second.status).toBe(429);
    expect(fake.calls.length).toBe(sent);
    const plan = await (await admin("GET", "/storefronts/steam")).json();
    expect(plan.budget).toMatchObject({ stopped: true, remaining: 0 });
  });

  it("ticks and unticks checklist items per app, unverified and audited", async () => {
    const res = await admin("PUT", "/storefronts/steam/checklist", {
      item: "fee_paid",
      done: true,
    });
    expect(res.status).toBe(200);
    const list = (await res.json()).checklist as Loose[];
    const fee = list.find((c) => c.item === "fee_paid");
    expect(fee).toMatchObject({
      done: true,
      doneAt: NOW,
      doneBy: "u1",
      verified: false,
    });
    expect(list.find((c) => c.item === "release_wait").notBefore).toBe(
      NOW + 30 * 86_400,
    );
    await admin("PUT", "/storefronts/steam/checklist", {
      item: "coming_soon",
      done: true,
    });
    const plan = await (await admin("GET", "/storefronts/steam")).json();
    expect(
      plan.checklist.filter((c: Loose) => c.done).map((c: Loose) => c.item),
    ).toEqual(["fee_paid", "coming_soon"]);
    expect(
      plan.checklist.find((c: Loose) => c.item === "coming_soon").notBefore,
    ).toBe(NOW + 14 * 86_400);
    await admin("PUT", "/storefronts/steam/checklist", {
      item: "fee_paid",
      done: false,
    });
    const after = await (await admin("GET", "/storefronts/steam")).json();
    expect(after.checklist.find((c: Loose) => c.item === "fee_paid").done).toBe(
      false,
    );
    expect(
      (await audits())
        .filter((a) => a.action.startsWith("distribution.steam.checklist"))
        .map((a) => a.action),
    ).toEqual([
      "distribution.steam.checklist.tick",
      "distribution.steam.checklist.tick",
      "distribution.steam.checklist.untick",
    ]);
    // Another app's ticks are its own.
    await db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ?",
      JSON.stringify({ appId: 481 }),
      SLUG,
    );
    await setPlatformPin(db, {
      id: "steam.publisher-key",
      product: SLUG,
      pin: "481",
      actor: "u1",
      now: NOW,
    });
    const other = await (await admin("GET", "/storefronts/steam")).json();
    expect(other.checklist.filter((c: Loose) => c.done)).toEqual([]);
    expect(
      (
        await admin("PUT", "/storefronts/steam/checklist", {
          item: "nope",
          done: true,
        })
      ).status,
    ).toBe(422);
  });

  it("serves the generated asset pack as a console attachment, and 404s without one", async () => {
    expect((await admin("GET", "/storefronts/steam/pack")).status).toBe(404);
    const bytes = new TextEncoder().encode("PK\u0003\u0004 steam pack");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = blobKey(sha);
    await putVerified(asR2(r2), key, bytes, {
      sha256: sha,
      size: bytes.length,
    });
    await recordObject(
      db,
      {
        storageKey: key,
        sha256: sha,
        size: bytes.length,
        kind: "blob",
        gated: false,
      },
      NOW,
    );
    await recordRef(
      db,
      {
        product: SLUG,
        storageKey: key,
        refKind: "listing-asset",
        refId: "pack:steam@",
      },
      NOW,
    );
    await db.batch([
      stmtUpsertAsset(
        SLUG,
        {
          slot: "pack:steam",
          locale: null,
          blob: key,
          sha256: sha,
          width: null,
          height: null,
          alpha: false,
          derivedFrom: null,
          textAllowed: "free",
        },
        "import",
        NOW,
        "ci",
      ),
    ]);
    const res = await admin("GET", "/storefronts/steam/pack");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${SLUG}-steam-assets.zip"`,
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const plan = await (await admin("GET", "/storefronts/steam")).json();
    expect(plan.pack).toMatchObject({
      sha256: sha,
      download: `/manage/api/products/${SLUG}/distribution/storefronts/steam/pack`,
    });
  });

  it("is inert, and says why, without a Steam outlet or pin", async () => {
    await db.run("DELETE FROM dist_outlets WHERE product = ?", SLUG);
    await db.run(
      "DELETE FROM platform_credential_pins WHERE product = ?",
      SLUG,
    );
    const v = await (await admin("GET", "/storefronts/steam")).json();
    expect(v.setup).toBeNull();
    expect(v.inert.reason).toBe("pin_missing");
    expect(v.links.storePage).toBeNull();
    expect((await admin("GET", "/storefronts/steam/builds")).status).toBe(409);
    expect(fake.calls).toEqual([]);
  });
});

// ── Reach ────────────────────────────────────────────────────────────────────────────────────

describe("nothing reaches SetAppBuildLive around the gated client", () => {
  it("only the gate and the client spell it", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(n)) files.push(p);
      }
    };
    walk(join(WORKER_ROOT, "src"));
    const hits = files
      .filter((f) =>
        /SetAppBuildLive/.test(
          readFileSync(f, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, ""),
        ),
      )
      .map((f) => relative(WORKER_ROOT, f).split(sep).join("/"));
    expect(hits.sort()).toEqual([
      "src/core/steam/client.ts",
      "src/core/storefront/rules/steam.ts",
    ]);
  });
});
