/**
 * A-18j — the storefront flow's admin API (`services/distribution/storefronts/`), through the real
 * admin dispatcher:
 *
 *   - the view is built from DECLARATIONS: a storefront adapter registered here (a test store with
 *     a runtime of its own) appears with its capability strip, its deep-link, CI and PR steps, the
 *     `api` steps its runtime binds and none it does not; `unsupported` operations are on the strip
 *     and never in the plan;
 *   - a deep-linked step's state is one ledger row: pending from the first check, done from the
 *     verifier's read or the operator's assertion, audited, replayed afterwards;
 *   - a runtime's step needs an Idempotency-Key, and submit is typed with the store-reported name;
 *   - "Push listing" exists only where the runtime performs it, and "stage only" only where the
 *     store has it;
 *   - Apple: the dropped A-17f wizard as the App Store adapter's plan, on A-17b's and A-17c's
 *     routes; read-only with the reason when the team connection is missing; the app record
 *     verified by the bundle-id lookup and then assigned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorefrontAdapter } from "../src/core/storefront/adapter.js";
import type { FlowRuntime } from "../src/services/distribution/storefronts/runtime.js";

// ── a store registered only in this test ────────────────────────────────────────────────────

const calls = vi.hoisted(() => ({
  runs: [] as { op: string; input: unknown; typed: boolean; key: string }[],
  pushes: [] as { stageOnly: boolean }[],
  verified: { value: false },
  followUp: {
    value: null as null | { link: string; count: number; text: string },
  },
}));

const TEST_STORE = {
  id: "test-store",
  label: "Test Store",
  outletKinds: ["web"],
  credential: null,
  gate: null,
  never: { delete: [], users: [], signingKeys: [], payments: [], ciTokens: [] },
  ci: null,
  listing: { fields: {}, images: {} },
  confirmation: { phrase: "app-name", label: "Test Store" },
  audit: { action: "test", projection: {} },
  capabilities: {
    rate: { kind: "none" },
    limits: {},
    ops: {
      connect: { mode: "api", plane: "worker", rules: [] },
      listApps: { mode: "api", plane: "worker", rules: [] },
      identifiers: {
        mode: "unsupported",
        reason: "the store has no identifiers",
      },
      createApp: {
        mode: "deep-link",
        link: "app-store.identifiers",
        verify: { read: "/apps", every: 10, until: 900 },
      },
      readListing: { mode: "unsupported", reason: "no listing read" },
      writeListingText: {
        mode: "api",
        plane: "worker",
        rules: ["PUT /listing"],
      },
      writeListingAssets: {
        mode: "api",
        plane: "worker",
        rules: ["POST /images"],
      },
      category: {
        mode: "ci",
        plane: "ci",
        tool: "butler",
        commands: ["push"],
      },
      contentRating: { mode: "pr", plane: "pr", repo: "acme/store-meta" },
      privacyDeclarations: {
        mode: "deep-link",
        link: "app-store.agreements",
        verify: "operator-assertion",
      },
      pricing: { mode: "unsupported", reason: "free only" },
      iap: { mode: "unsupported", reason: "none" },
      testers: { mode: "unsupported", reason: "none" },
      uploadBuild: { mode: "unsupported", reason: "CI only" },
      notificationsUrl: { mode: "unsupported", reason: "none" },
      submit: { mode: "api", plane: "worker", rules: ["POST /submit"] },
      release: { mode: "unsupported", reason: "automatic" },
      rollout: { mode: "unsupported", reason: "none" },
      status: { mode: "api", plane: "worker", rules: [] },
    },
  },
} as unknown as StorefrontAdapter;

const TEST_RUNTIME: FlowRuntime = {
  id: "test-store",
  async bind(c, op) {
    const path = `/manage/api/products/${c.product}/distribution/storefronts/test-store/steps/${op}`;
    if (op === "writeListingText" || op === "submit")
      return {
        state: calls.runs.some((r) => r.op === op) ? "done" : "todo",
        run: {
          method: "POST",
          path,
          body: {},
          fields: [],
          confirm: op === "submit" ? "typed" : "plain",
          verb: op,
          consequences: [],
        },
      };
    return null;
  },
  async verify() {
    return calls.verified.value
      ? { satisfied: true, resultIds: { appId: "app-1" }, detail: "Test Game" }
      : { satisfied: false };
  },
  async appName() {
    return "Test Game";
  },
  async runStep(_c, op, input, opts) {
    calls.runs.push({
      op,
      input,
      typed: opts.typedConfirmation,
      key: opts.idempotencyKey,
    });
    return {
      ok: true,
      outcome: "written",
      opId: "op-1",
      resultIds: {},
      after: { state: "written" },
      ...(calls.followUp.value ? { followUp: calls.followUp.value } : {}),
    };
  },
  pushListing: {
    stageOnly: true,
    async run(_c, opts) {
      calls.pushes.push({ stageOnly: opts.stageOnly });
      return {
        ok: true,
        outcome: "written",
        opId: "op-2",
        resultIds: {},
        after: null,
        ...(calls.followUp.value ? { followUp: calls.followUp.value } : {}),
      };
    },
  },
};

vi.mock(
  "../src/services/distribution/storefronts/index.js",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("../src/services/distribution/storefronts/index.js")
      >();
    return {
      ...real,
      flowStores: () => [
        ...real.flowStores(),
        { adapter: TEST_STORE, runtime: TEST_RUNTIME },
      ],
    };
  },
);

import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import { ascP8 } from "./ascWorld.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { setPlatformPin } from "../src/core/platformCredentials.js";
import { listStoreOperations } from "../src/core/storefront/ledger.js";

let db: Db;
let env: Env;
const SLUG = "acme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** App Store Connect, as far as the bundle-id lookup goes. */
const apple = {
  apps: [] as { id: string; name: string; bundleId: string }[],
  requests: [] as string[],
};
const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : String(input));
  if (url.hostname !== "api.appstoreconnect.apple.com")
    return new Response("unexpected host", { status: 599 });
  apple.requests.push(`${url.pathname}?${url.searchParams}`);
  if (url.pathname === "/v1/apps") {
    const want = url.searchParams.get("filter[bundleId]");
    return new Response(
      JSON.stringify({
        data: apple.apps
          .filter((a) => a.bundleId === want)
          .map((a) => ({
            type: "apps",
            id: a.id,
            attributes: {
              name: a.name,
              bundleId: a.bundleId,
              sku: "S",
              primaryLocale: "en-US",
            },
          })),
        links: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("{}", { status: 404 });
};

async function admin(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Loose }> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution/storefronts${path}`;
  const saved = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    const res = await handleAdmin(
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
      full,
      { now: NOW },
    );
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.fetch = saved;
  }
}

async function auditRows(): Promise<{ action: string; summary: string }[]> {
  return db.all(
    "SELECT action, summary FROM audit WHERE product = ? AND action LIKE 'distribution.storefronts.%' ORDER BY at, rowid",
    SLUG,
  );
}

const store = (v: Loose, id: string) =>
  v.stores.find((s: Loose) => s.id === id);

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
  calls.runs.length = 0;
  calls.pushes.length = 0;
  calls.verified.value = false;
  calls.followUp.value = null;
  apple.apps.length = 0;
  apple.requests.length = 0;
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the view is built from declarations", () => {
  it("a store registered in a test appears with no store code: strip, plan and prerequisites", async () => {
    const r = await admin("GET", "");
    expect(r.status).toBe(200);
    const t = store(r.json, "test-store");
    expect(t.label).toBe("Test Store");
    expect(t.connection.state).toBe("keyless");
    expect(t.readOnly).toBeNull();
    // Every declared operation is on the strip, unsupported ones with their reason.
    expect(t.capabilities.map((c: Loose) => c.op)).toContain("pricing");
    expect(
      t.capabilities.find((c: Loose) => c.op === "pricing").support,
    ).toEqual({ mode: "unsupported", reason: "free only" });
    // The plan: deep links, CI and PR from the declaration; api steps only where bound.
    expect(t.steps.map((s: Loose) => [s.id, s.mode])).toEqual([
      ["createApp", "deep-link"],
      ["writeListingText", "api"],
      ["category", "ci"],
      ["contentRating", "pr"],
      ["privacyDeclarations", "deep-link"],
      ["submit", "api"],
    ]);
    const submit = t.steps.find((s: Loose) => s.id === "submit");
    expect(submit.typed).toBe(true);
    expect(submit.writes).toEqual(["POST /submit"]);
    const ci = t.steps.find((s: Loose) => s.id === "category");
    expect(ci.ci).toEqual({ tool: "butler", commands: ["push"] });
    expect(ci.writes).toEqual(["butler push"]);
    const link = t.steps.find((s: Loose) => s.id === "createApp");
    expect(link.link).toMatchObject({
      url: "https://developer.apple.com/account/resources/identifiers/list",
      verify: "read",
      every: 10,
      until: 900,
      missing: [],
    });
    expect(t.pushListing).toEqual({ stageOnly: true });
    // Keyless: no connection, app or permission prerequisites.
    expect(t.prerequisites).toEqual([]);
  });

  it("the App Store without a team connection: read-only with the reason; the wizard's steps from A-17b and A-17c", async () => {
    const r = await admin("GET", "");
    const a = store(r.json, "app-store");
    expect(a.connection.state).toBe("not-configured");
    expect(a.readOnly).toMatch(/no team connection/);
    expect(a.listingStore).toBe("app-store");
    expect(a.prerequisites.map((p: Loose) => [p.id, p.state])).toEqual([
      ["connection", "unmet"],
      ["app", "unmet"],
      ["permissions", "unknown"],
    ]);
    expect(a.steps.map((s: Loose) => s.id)).toEqual([
      "identifiers",
      "createApp",
      "notificationsUrl",
      "category",
      "privacyDeclarations",
      "writeListingAssets",
      "pricing",
      "iap",
      "testers",
      "submit",
      "release",
    ]);
    const ids = a.steps.find((s: Loose) => s.id === "identifiers");
    expect(ids.run.path).toBe(
      "/manage/api/platform/store-connections/app-store/bundle-ids",
    );
    expect(ids.writes).toEqual([
      "POST /v1/bundleIds",
      "POST /v1/bundleIdCapabilities",
    ]);
    // Submit and release stay on the App Store page's typed Distribute flow.
    const submit = a.steps.find((s: Loose) => s.id === "submit");
    expect(submit.handoff).toEqual({
      page: "app-store",
      label: "Open the Distribute flow",
    });
    expect(submit.typed).toBe(false);
    // Every request a step names is on the console API.
    for (const s of a.steps)
      for (const req of [s.run, s.assert, s.next].filter(Boolean))
        expect(req.path.startsWith("/manage/api/")).toBe(true);
    // Listing text has no binding until A-18m: it is not shown, and there is no listing push.
    expect(a.steps.some((s: Loose) => s.id === "writeListingText")).toBe(false);
    expect(a.pushListing).toBeNull();
  });

  it("the copy card is filled from the listing model", async () => {
    await db.run(
      `INSERT INTO dist_listings (product, default_locale, name, source, created_at, modified_at, modified_by)
       VALUES (?, 'de-DE', 'Acme Dice', 'admin', ?, ?, 'u1')`,
      SLUG,
      NOW,
      NOW,
    );
    const r = await admin("GET", "");
    expect(r.json.listing).toMatchObject({
      name: "Acme Dice",
      defaultLocale: "de-DE",
    });
    const step = store(r.json, "app-store").steps.find(
      (s: Loose) => s.id === "createApp",
    );
    expect(step.copy).toEqual([
      { label: "Name", value: "Acme Dice" },
      { label: "Primary language", value: "de-DE" },
      { label: "SKU", value: SLUG },
    ]);
    expect(step.blockedBy).toBe("Register the bundle ID first.");
  });
});

describe("a deep-linked step's state", () => {
  it("the verifier read: pending from the first check, done once the store shows it, then replayed", async () => {
    const first = await admin("POST", "/test-store/steps/createApp/check", {
      poll: true,
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ state: "pending", satisfied: false });
    let rows = await listStoreOperations(db, {
      scope: "product",
      product: SLUG,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      store: "test-store",
      op: "flow.create_app",
      plane: "deep-link",
      state: "pending",
    });
    let v = await admin("GET", "");
    expect(
      store(v.json, "test-store").steps.find((s: Loose) => s.id === "createApp")
        .state,
    ).toBe("pending");

    calls.verified.value = true;
    const done = await admin("POST", "/test-store/steps/createApp/check", {});
    expect(done.json).toMatchObject({
      state: "done",
      resultIds: { appId: "app-1" },
    });
    rows = await listStoreOperations(db, { scope: "product", product: SLUG });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("done");
    expect(await auditRows()).toEqual([
      {
        action: "distribution.storefronts.verify",
        summary: "Test Store shows the app record done",
      },
    ]);
    // Replayed: no second audit row, no second verify.
    calls.verified.value = false;
    const again = await admin("POST", "/test-store/steps/createApp/check", {});
    expect(again.json.state).toBe("done");
    expect(await auditRows()).toHaveLength(1);
    v = await admin("GET", "");
    expect(
      store(v.json, "test-store").steps.find((s: Loose) => s.id === "createApp")
        .state,
    ).toBe("done");
  });

  it("an operator assertion only where the declaration says so", async () => {
    const refused = await admin("POST", "/test-store/steps/createApp/check", {
      assert: true,
    });
    expect(refused.status).toBe(422);
    expect(refused.json.reason).toBe("verified_by_read");
    const notRead = await admin(
      "POST",
      "/test-store/steps/privacyDeclarations/check",
      {},
    );
    expect(notRead.status).toBe(422);
    expect(notRead.json.reason).toBe("not_verifiable");
    const ok = await admin(
      "POST",
      "/test-store/steps/privacyDeclarations/check",
      { assert: true },
    );
    expect(ok.json).toMatchObject({ state: "done" });
    expect(await auditRows()).toEqual([
      {
        action: "distribution.storefronts.assert",
        summary:
          "Marked privacy declarations done in Test Store (operator assertion)",
      },
    ]);
  });

  it("refuses a step that is not deep-linked, an unknown step and an unknown store", async () => {
    expect(
      (await admin("POST", "/test-store/steps/submit/check", {})).status,
    ).toBe(404);
    expect(
      (await admin("POST", "/test-store/steps/nope/check", {})).status,
    ).toBe(404);
    expect(
      (await admin("POST", "/nope/steps/createApp/check", {})).status,
    ).toBe(404);
    expect(
      (await admin("GET", "/test-store/steps/createApp/check")).status,
    ).toBe(405);
  });
});

describe("a runtime's own steps", () => {
  const KEY = { "idempotency-key": "11111111-2222-3333-4444-555555555555" };

  it("needs an Idempotency-Key", async () => {
    const r = await admin("POST", "/test-store/steps/writeListingText", {});
    expect(r.status).toBe(428);
    expect(calls.runs).toEqual([]);
  });

  it("runs a plain step with the operator's input", async () => {
    const r = await admin(
      "POST",
      "/test-store/steps/writeListingText",
      { input: { locale: "en-US" } },
      KEY,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, outcome: "written" });
    expect(calls.runs).toEqual([
      {
        op: "writeListingText",
        input: { locale: "en-US" },
        typed: false,
        key: KEY["idempotency-key"],
      },
    ]);
  });

  it("submit is typed with the store-reported app name: missing and wrong refuse, nothing runs", async () => {
    const none = await admin("POST", "/test-store/steps/submit", {}, KEY);
    expect(none.status).toBe(422);
    expect(none.json.reason).toBe("confirmation_required");
    const wrong = await admin(
      "POST",
      "/test-store/steps/submit",
      { confirm: "test game" },
      KEY,
    );
    expect(wrong.json.reason).toBe("confirmation_mismatch");
    expect(calls.runs).toEqual([]);
    const ok = await admin(
      "POST",
      "/test-store/steps/submit",
      { confirm: " Test Game " },
      KEY,
    );
    expect(ok.status).toBe(200);
    expect(calls.runs[0]).toMatchObject({ op: "submit", typed: true });
  });

  it("an api step nothing binds, or a store with no runtime step, is not runnable", async () => {
    expect(
      (await admin("POST", "/test-store/steps/writeListingAssets", {}, KEY))
        .status,
    ).toBe(404);
    expect(
      (await admin("POST", "/app-store/steps/identifiers", {}, KEY)).status,
    ).toBe(404);
  });
});

describe("Push listing", () => {
  const KEY = { "idempotency-key": "11111111-2222-3333-4444-666666666666" };

  it("runs where the runtime performs it, staged only where the store can stage", async () => {
    const r = await admin(
      "POST",
      "/test-store/push-listing",
      { stageOnly: true },
      KEY,
    );
    expect(r.status).toBe(200);
    expect(calls.pushes).toEqual([{ stageOnly: true }]);
    const apple = await admin("POST", "/app-store/push-listing", {}, KEY);
    expect(apple.status).toBe(404);
    expect(apple.json.reason).toBe("unsupported");
    const bad = await admin(
      "POST",
      "/test-store/push-listing",
      { stageOnly: "yes" },
      KEY,
    );
    expect(bad.status).toBe(422);
  });

  it("a follow-up's deep link is rendered from the product's facts, with the count", async () => {
    calls.followUp.value = {
      link: "google-play.main-store-listing",
      count: 3,
      text: "3 older images stay.",
    };
    const push = await admin("POST", "/test-store/push-listing", {}, KEY);
    expect(push.status).toBe(200);
    // The product has no Console ids: the link names what it lacks instead of a broken URL.
    expect(push.json.followUp).toEqual({
      count: 3,
      text: "3 older images stay.",
      url: null,
      missing: ["developerId", "appId"],
    });
    calls.followUp.value = {
      link: "google-play.integrity",
      count: 1,
      text: "1 older image stays.",
    };
    const step = await admin(
      "POST",
      "/test-store/steps/writeListingText",
      {},
      { "idempotency-key": "11111111-2222-3333-4444-999999999999" },
    );
    expect(step.json.followUp).toEqual({
      count: 1,
      text: "1 older image stays.",
      url: "https://play.google.com/console/developers/app/protect-with-play",
      missing: [],
    });
    calls.followUp.value = null;
    const none = await admin(
      "POST",
      "/test-store/steps/writeListingText",
      {},
      { "idempotency-key": "11111111-2222-3333-4444-aaaaaaaaaaaa" },
    );
    expect(none.json).not.toHaveProperty("followUp");
  });

  it("always stages a push where the store stages: stageOnly false is refused, absent stages", async () => {
    const KEY2 = { "idempotency-key": "11111111-2222-3333-4444-777777777777" };
    const unstaged = await admin(
      "POST",
      "/test-store/push-listing",
      { stageOnly: false },
      KEY2,
    );
    expect(unstaged.status).toBe(422);
    expect(calls.pushes).toEqual([]);
    const plain = await admin("POST", "/test-store/push-listing", {}, KEY2);
    expect(plain.status).toBe(200);
    expect(calls.pushes).toEqual([{ stageOnly: true }]);
  });
});

describe("the App Store: the New-app wizard as the adapter's plan", () => {
  async function connect(): Promise<void> {
    (env as unknown as Record<string, unknown>).PLATFORM_ASC_API_KEY =
      JSON.stringify({
        keyId: "TEAMKEY123",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: ascP8(),
      });
  }

  it("prefills the bundle ID from the outlet and finds the app record by it, then offers the assignment", async () => {
    await connect();
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES (?, 'ios', 'app-store', ?, ?, ?)`,
      SLUG,
      JSON.stringify({ bundleId: "gg.acme.dice" }),
      NOW,
      NOW,
    );
    let v = await admin("GET", "");
    let a = store(v.json, "app-store");
    expect(a.connection.state).toBe("connected");
    expect(a.readOnly).toBeNull();
    expect(a.outlets).toEqual(["ios"]);
    const ids = a.steps.find((s: Loose) => s.id === "identifiers");
    expect(
      ids.run.fields.find((f: Loose) => f.name === "identifier").value,
    ).toBe("gg.acme.dice");

    // Not created yet: the check leaves the step pending (it survives a closed tab).
    const miss = await admin("POST", "/app-store/steps/createApp/check", {});
    expect(miss.json).toMatchObject({ state: "pending", satisfied: false });
    expect(apple.requests[0]).toContain("filter%5BbundleId%5D=gg.acme.dice");

    apple.apps.push({
      id: "6000000001",
      name: "Acme Dice",
      bundleId: "gg.acme.dice",
    });
    const hit = await admin("POST", "/app-store/steps/createApp/check", {});
    expect(hit.json).toMatchObject({
      state: "done",
      resultIds: { appId: "6000000001" },
    });
    v = await admin("GET", "");
    a = store(v.json, "app-store");
    const create = a.steps.find((s: Loose) => s.id === "createApp");
    // Found but not assigned: the step waits on A-16's assignment, which it offers.
    expect(create.state).toBe("pending");
    expect(create.next).toMatchObject({
      method: "PUT",
      path: "/manage/api/platform/store-connections/app-store/apps/6000000001/product",
      body: { product: SLUG },
    });

    await setPlatformPin(db, {
      id: "app-store.api-key",
      product: SLUG,
      pin: "6000000001",
      actor: "u1",
      now: NOW,
    });
    v = await admin("GET", "");
    a = store(v.json, "app-store");
    expect(a.app).toEqual({ id: "6000000001", name: null });
    expect(a.prerequisites.find((p: Loose) => p.id === "app").state).toBe(
      "met",
    );
    expect(a.steps.find((s: Loose) => s.id === "createApp")).toMatchObject({
      state: "done",
      next: null,
    });
    // Deep links that need the app id now render.
    const info = a.steps.find((s: Loose) => s.id === "category");
    expect(info.link.url).toBe(
      "https://appstoreconnect.apple.com/apps/6000000001/distribution/info",
    );
    expect(info.assert).toMatchObject({
      path: `/manage/api/products/${SLUG}/distribution/connectors/asc/setup/checklist`,
      body: { item: "app_information", done: true },
    });
    expect(info.blockedBy).toBeNull();
  });

  it("an Apple step recorded on A-17c's checklist is not asserted through the generic route", async () => {
    await connect();
    const r = await admin("POST", "/app-store/steps/category/check", {
      assert: true,
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("use_step_request");
  });
});
