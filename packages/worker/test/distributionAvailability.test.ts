/**
 * P2b-03 — availability, submissions and the key inventory (`services/distribution/
 * availability.ts`) through its three doors: the CI report route (`POST /<p>/distribution/report`,
 * `pkeyci_` + `distribution:report`), the `delivery` hook (with derived availability for
 * self-hosted outlets), and the console's admin API (read-only availability and submissions, the
 * operator-owned key inventory).
 *
 * The `pkeyci_` lookup (`lookupCiToken` in `core/publisher.ts`) is mocked, as in the P2b-04 rollout suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      { product: string; subject: string; scopes: readonly string[] }
    >(),
);
vi.mock("../src/core/publisher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/publisher.js")>()),
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { makeTestDb } from "./helpers.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { buildHooks, type Delivery } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { loadProduct } from "../src/core/products.js";
import {
  AVAILABILITY_STATES,
  MAX_KEY_OBSERVATIONS,
  SUBMISSION_STATES,
} from "../src/services/distribution/availability.js";
import {
  auditRows,
  call,
  CONSOLE,
  enableServices,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";

const REPORTER = "pkeyci_reporter";
const ROLLER = "pkeyci_roller";
const OTHER_PRODUCT = "pkeyci_other";
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

// The dispatcher reads the wall clock; pin it to the fixture's NOW so timestamps are exact.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  tokens.clear();
  // The default publishing grant (P2-02) includes `distribution:report`.
  tokens.set(REPORTER, {
    product: SLUG,
    subject: "repo:acme/djdl:environment:release",
    scopes: ["release:publish", "release:promote", "distribution:report"],
  });
  tokens.set(ROLLER, {
    product: SLUG,
    subject: "static:tok_1",
    scopes: ["distribution:rollout"],
  });
  tokens.set(OTHER_PRODUCT, {
    product: "other",
    subject: "static:tok_3",
    scopes: ["distribution:report"],
  });
});

interface World {
  env: Env;
  db: Db;
  gh: ReturnType<typeof github>;
}

async function addOutlet(
  w: World,
  id: string,
  kind: string,
  identity: Record<string, unknown> = {},
  removed = false,
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_outlets
       (product, outlet_id, kind, identity_json, removed_at, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    removed ? NOW : null,
    NOW,
    NOW,
  );
}

async function setup(): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  const w = { env, db, gh };
  // A self-hosted outlet, two stores, and one the manifest stopped declaring.
  await addOutlet(w, "direct", "direct");
  await addOutlet(w, "app-store", "app-store", { appleId: "123" });
  await addOutlet(w, "play", "play", { packageName: "gg.acme.djdl" });
  await addOutlet(w, "itch", "itch", {}, true);
  return w;
}

function report(
  w: World,
  body: unknown,
  token: string | null = REPORTER,
): Promise<Response> {
  return call(
    w.env,
    w.db,
    w.gh.fetchImpl,
    `${CONSOLE}/${SLUG}/distribution/report`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function admin(
  w: World,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const [pathname, query] = path.split("?") as [string, string?];
  const full = `/api/products/${SLUG}/distribution${pathname}`;
  return handleAdmin(
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
}

async function delivery(w: World): Promise<Delivery | null> {
  const product = (await loadProduct(w.env, w.db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env: w.env,
    db: w.db,
    product,
    now: NOW,
  }).delivery();
}

async function count(w: World, table: string): Promise<number> {
  const row = await w.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE product = ?`,
    SLUG,
  );
  return row!.n;
}

const AVAIL = {
  type: "availability",
  releaseId: "v1.1.0",
  outlet: "app-store",
  buildId: "cli-arm64",
  state: "in-review",
};

describe("CI report route: authentication and scope", () => {
  it("refuses a missing, unknown or other product's token with 401 and writes nothing", async () => {
    const w = await setup();
    for (const token of [null, "ghs_not_ci", "pkeyci_unknown", OTHER_PRODUCT]) {
      const res = await report(w, AVAIL, token);
      expect(res.status, String(token)).toBe(401);
    }
    expect(await count(w, "dist_availability")).toBe(0);
  });

  it("needs distribution:report: a rollout-only token is refused 403 and writes nothing", async () => {
    const w = await setup();
    const res = await report(w, AVAIL, ROLLER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "missing_scope",
      scope: "distribution:report",
    });
    expect(await count(w, "dist_availability")).toBe(0);
    expect(await auditRows(w.db)).toEqual([]);
  });

  it("is the registry not-found with Distribution off, and the hook is null", async () => {
    const w = await setup();
    // Release on, Distribution and Update off (Update requires Distribution).
    await w.db.run(
      `UPDATE products SET services_json = json_set(services_json,
         '$.services.distribution.enabled', json('false'),
         '$.services.update.enabled', json('false'))
        WHERE slug = ?`,
      SLUG,
    );
    const res = await report(w, AVAIL);
    expect(res.status).toBe(404);
    expect(await count(w, "dist_availability")).toBe(0);
    expect(await delivery(w)).toBeNull();
    // And with everything back on it answers.
    await enableServices(w.db, true);
    expect((await report(w, AVAIL)).status).toBe(200);
  });

  it("answers only POST", async () => {
    const w = await setup();
    const res = await call(
      w.env,
      w.db,
      w.gh.fetchImpl,
      `${CONSOLE}/${SLUG}/distribution/report`,
      { headers: { authorization: `Bearer ${REPORTER}` } },
    );
    expect(res.status).toBe(404);
  });
});

describe("CI report route: availability", () => {
  it("records availability for (release, build, outlet), audited as the CI subject", async () => {
    const w = await setup();
    const res = await report(w, {
      ...AVAIL,
      platformRef: { ascBuildId: "abc-123" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      ok: true,
      type: "availability",
      availability: {
        deliverableId: "app",
        releaseId: "v1.1.0",
        buildId: "cli-arm64",
        outletId: "app-store",
        transport: "pkey-cdn",
        state: "in-review",
        since: NOW,
        platformRef: { ascBuildId: "abc-123" },
        source: "ci",
        derived: false,
      },
    });
    const audit = await auditRows(w.db);
    expect(audit).toEqual([
      {
        action: "distribution.availability.report",
        actor_sub: "ci:repo:acme/djdl:environment:release",
        target_id: "v1.1.0/cli-arm64:app-store",
      },
    ]);
  });

  it("resolves {deliverable, version} and defaults the build to the whole release", async () => {
    const w = await setup();
    const res = await report(w, {
      type: "availability",
      version: "1.0.0",
      outlet: "play",
      state: "processing",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      availability: { releaseId: "v1.0.0", buildId: "", state: "processing" },
    });
  });

  const refusals: Array<[string, Record<string, unknown>, number, string]> = [
    ["undeclared outlet", { outlet: "steam" }, 404, "unknown_outlet"],
    ["removed outlet", { outlet: "itch" }, 404, "unknown_outlet"],
    ["unknown release", { releaseId: "v9.9.9" }, 404, "unknown_release"],
    [
      "unknown version",
      { releaseId: undefined, version: "9.9.9" },
      404,
      "unknown_release",
    ],
    ["unknown build", { buildId: "windows-x64" }, 404, "unknown_build"],
    ["unknown state", { state: "shipped" }, 422, "invalid_state"],
    ["missing state", { state: undefined }, 422, "invalid_state"],
    ["unknown type", { type: "rumour" }, 422, "invalid_body"],
    ["releaseId and version", { version: "1.1.0" }, 422, "invalid_body"],
    [
      "neither releaseId nor version",
      { releaseId: undefined },
      422,
      "invalid_body",
    ],
    ["future since", { since: NOW + 3600 }, 422, "invalid_body"],
    ["fractional since", { since: 1.5 }, 422, "invalid_body"],
    ["platformRef not an object", { platformRef: [1] }, 422, "invalid_body"],
    ["missing outlet", { outlet: undefined }, 422, "invalid_body"],
  ];
  for (const [name, over, status, reason] of refusals) {
    it(`refuses ${name} (${status} ${reason}) and writes nothing`, async () => {
      const w = await setup();
      const res = await report(w, { ...AVAIL, ...over });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ reason });
      expect(await count(w, "dist_availability")).toBe(0);
      expect(await auditRows(w.db)).toEqual([]);
    });
  }

  it("refuses a body that is not a JSON object", async () => {
    const w = await setup();
    const res = await report(w, [AVAIL]);
    expect(res.status).toBe(400);
    expect(await count(w, "dist_availability")).toBe(0);
  });

  it("keeps the current state when a report moves it backwards, and audits every change", async () => {
    const w = await setup();
    await report(w, { ...AVAIL, state: "approved", since: NOW - 100 });
    const res = await report(w, { ...AVAIL, state: "rejected" });
    expect(await res.json()).toMatchObject({
      availability: { state: "rejected", since: NOW },
    });
    // An identical report changes nothing and is not audited again.
    await report(w, { ...AVAIL, state: "rejected" });
    const audit = await auditRows(w.db);
    expect(audit.map((a) => a.action)).toEqual([
      "distribution.availability.report",
      "distribution.availability.report",
    ]);
    const summaries = await w.db.all<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = ? ORDER BY rowid",
      SLUG,
    );
    expect(summaries[1]!.summary).toMatch(/approved → rejected/);
    expect(await count(w, "dist_availability")).toBe(1);
  });

  it("keeps since while the state is unchanged, and platformRef unless the report replaces it", async () => {
    const w = await setup();
    await report(w, {
      ...AVAIL,
      state: "processing",
      since: NOW - 50,
      platformRef: { ascBuildId: "x" },
    });
    const res = await report(w, { ...AVAIL, state: "processing" });
    expect(await res.json()).toMatchObject({
      availability: { since: NOW - 50, platformRef: { ascBuildId: "x" } },
    });
    const cleared = await report(w, {
      ...AVAIL,
      state: "processing",
      platformRef: null,
    });
    expect(await cleared.json()).toMatchObject({
      availability: { platformRef: null },
    });
  });
});

describe("CI report route: submissions", () => {
  it("records the lifecycle with submittedAt and reviewedAt", async () => {
    const w = await setup();
    const sub = {
      type: "submission",
      releaseId: "v1.1.0",
      outlet: "app-store",
    };
    let res = await report(w, {
      ...sub,
      state: "submitted",
      since: NOW - 200,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      submission: {
        releaseId: "v1.1.0",
        outletId: "app-store",
        state: "submitted",
        submittedAt: NOW - 200,
        reviewedAt: null,
        source: "ci",
      },
    });
    await report(w, { ...sub, state: "in-review" });
    res = await report(w, {
      ...sub,
      state: "rejected",
      detail: { reason: "Guideline 2.1" },
    });
    expect(await res.json()).toMatchObject({
      submission: {
        state: "rejected",
        submittedAt: NOW - 200,
        reviewedAt: NOW,
        detail: { reason: "Guideline 2.1" },
      },
    });
    expect((await auditRows(w.db)).map((a) => [a.action, a.target_id])).toEqual(
      [
        ["distribution.submission.report", "v1.1.0:app-store"],
        ["distribution.submission.report", "v1.1.0:app-store"],
        ["distribution.submission.report", "v1.1.0:app-store"],
      ],
    );
  });

  it("refuses a submission with an availability state, a buildId or a platformRef", async () => {
    const w = await setup();
    const sub = { type: "submission", releaseId: "v1.1.0", outlet: "play" };
    for (const [over, reason] of [
      [{ state: "live" }, "invalid_state"],
      [{ state: "submitted", buildId: "cli-arm64" }, "invalid_body"],
      [{ state: "submitted", platformRef: { a: 1 } }, "invalid_body"],
    ] as const) {
      const res = await report(w, { ...sub, ...over });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ reason });
    }
    expect(await count(w, "dist_submissions")).toBe(0);
  });

  it("the vocabularies are the brief's", () => {
    expect(AVAILABILITY_STATES).toEqual([
      "pending",
      "processing",
      "in-review",
      "approved",
      "live",
      "rejected",
      "removed",
    ]);
    expect(SUBMISSION_STATES).toEqual([
      "prepared",
      "submitted",
      "in-review",
      "approved",
      "rejected",
      "pending-developer-release",
      "released",
      "cancelled",
    ]);
  });
});

describe("delivery hook: availability, derived and reported", () => {
  it("a pkey-cdn self-hosted outlet shows live with no row; a store outlet shows nothing until reported", async () => {
    const w = await setup();
    const d = (await delivery(w))!;
    const before = await d.availability("v1.1.0");
    expect(before).toEqual([
      expect.objectContaining({
        deliverableId: "app",
        releaseId: "v1.1.0",
        buildId: "cli-arm64",
        outletId: "direct",
        transport: "pkey-cdn",
        state: "live",
        source: "derived",
        derived: true,
      }),
    ]);
    expect(await count(w, "dist_availability")).toBe(0);

    await report(w, { ...AVAIL, state: "live" });
    const after = await (await delivery(w))!.availability("v1.1.0");
    expect(after.map((r) => [r.outletId, r.state, r.derived])).toEqual([
      ["app-store", "live", false],
      ["direct", "live", true],
    ]);
  });

  it("a stored row wins over the derived record (per build, and per release)", async () => {
    const w = await setup();
    await report(w, {
      ...AVAIL,
      outlet: "direct",
      state: "removed",
    });
    let rows = await (await delivery(w))!.availability("v1.1.0");
    expect(rows.map((r) => [r.outletId, r.buildId, r.state])).toEqual([
      ["direct", "cli-arm64", "removed"],
    ]);
    await w.db.run("DELETE FROM dist_availability");
    await report(w, {
      type: "availability",
      releaseId: "v1.1.0",
      outlet: "direct",
      state: "pending",
    });
    rows = await (await delivery(w))!.availability("v1.1.0");
    expect(rows.map((r) => [r.outletId, r.buildId, r.state])).toEqual([
      ["direct", "", "pending"],
    ]);
  });

  it("derives nothing for a yanked release, a build the outlet does not carry, or a non-CDN transport", async () => {
    const w = await setup();
    await w.db.run(
      "INSERT INTO release_yanks (product, release_id, reason, at, by) VALUES (?, 'v1.0.0', 'broken', ?, 'admin:u1')",
      SLUG,
      NOW,
    );
    expect(await (await delivery(w))!.availability("v1.0.0")).toEqual([]);

    // A direct outlet offering only Windows does not carry the macOS build.
    await w.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND outlet_id = 'direct'",
      JSON.stringify({ platforms: ["windows"] }),
      SLUG,
    );
    expect(await (await delivery(w))!.availability("v1.1.0")).toEqual([]);

    // An outlet naming its artifact carries that build only.
    await addOutlet(w, "obtainium", "obtainium", { artifact: "cli-arm64" });
    await addOutlet(w, "altstore", "altstore", { artifact: "ios" });
    let rows = await (await delivery(w))!.availability("v1.1.0");
    expect(rows.map((r) => r.outletId)).toEqual(["obtainium"]);

    // A self-hosted outlet whose transport is not ours derives nothing.
    await w.db.run(
      `INSERT INTO dist_transports (product, deliverable_id, outlet_id, transport)
       VALUES (?, 'app', 'obtainium', 'apple-ba')`,
      SLUG,
    );
    rows = await (await delivery(w))!.availability("v1.1.0");
    expect(rows).toEqual([]);
  });

  it("a removed outlet and an unknown release answer nothing through the hook", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_availability
         (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
       VALUES (?, 'v1.1.0', '', 'itch', 'pkey-cdn', 'live', ?, 'ci', ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const d = (await delivery(w))!;
    expect((await d.availability("v1.1.0")).map((r) => r.outletId)).toEqual([
      "direct",
    ]);
    expect(await d.availability("v9.9.9")).toEqual([]);
  });

  it("a stored state outside the vocabulary never reads as live", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_availability
         (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
       VALUES (?, 'v1.1.0', '', 'play', 'pkey-cdn', 'LIVE!', ?, 'ci', ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const rows = await (await delivery(w))!.availability("v1.1.0");
    expect(rows.find((r) => r.outletId === "play")?.state).toBe("pending");
  });

  it("submissions(releaseId) answers the release's live-outlet records", async () => {
    const w = await setup();
    await report(w, {
      type: "submission",
      releaseId: "v1.1.0",
      outlet: "play",
      state: "approved",
    });
    const subs = await (await delivery(w))!.submissions("v1.1.0");
    expect(subs).toEqual([
      expect.objectContaining({
        deliverableId: "app",
        outletId: "play",
        state: "approved",
        reviewedAt: NOW,
      }),
    ]);
    expect(await (await delivery(w))!.submissions("v1.0.0")).toEqual([]);
  });
});

describe("the key inventory", () => {
  const keyReport = (over: Record<string, unknown> = {}) => ({
    type: "key",
    purpose: "android-app-signing",
    sha256: FP_A,
    ...over,
  });

  it("a CI key report that differs from the inventory is flagged and does not change it", async () => {
    const w = await setup();
    const put = await admin(w, "PUT", "/keys", {
      purpose: "android-app-signing",
      sha256: FP_A,
      outlet: "play",
      notes: "Play app signing key",
    });
    expect(put.status).toBe(200);
    const before = await w.db.all(
      "SELECT * FROM dist_keys WHERE product = ? AND source = 'admin'",
      SLUG,
    );

    const res = await report(w, keyReport({ sha256: FP_B, outlet: "play" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      key: { match: false, flagged: true, sha256: FP_B },
    });
    // The entry is byte-for-byte the same.
    expect(
      await w.db.all(
        "SELECT * FROM dist_keys WHERE product = ? AND source = 'admin'",
        SLUG,
      ),
    ).toEqual(before);
    // The hook returns the inventory only, flagged; the observation is not an entry.
    const keys = await (await delivery(w))!.keys();
    expect(keys).toEqual([
      expect.objectContaining({
        purpose: "android-app-signing",
        sha256: FP_A,
        outletId: "play",
        notes: "Play app signing key",
        flagged: true,
        observed: null,
      }),
    ]);
    // The console shows the observation.
    const view = (await (await admin(w, "GET", "/keys")).json()) as Record<
      string,
      any
    >;
    expect(view.observations).toEqual([
      expect.objectContaining({
        purpose: "android-app-signing",
        sha256: FP_B,
        outletId: "play",
        observed: expect.objectContaining({
          by: "ci:repo:acme/djdl:environment:release",
        }),
      }),
    ]);
    expect((await auditRows(w.db)).map((a) => a.action)).toEqual([
      "distribution.key.upsert",
      "distribution.key.mismatch",
    ]);
  });

  it("a matching CI report records the observation on the entry and nothing else", async () => {
    const w = await setup();
    await admin(w, "PUT", "/keys", {
      purpose: "android-app-signing",
      sha256: FP_A,
      registered: true,
    });
    const res = await report(w, keyReport());
    expect(await res.json()).toMatchObject({
      key: { match: true, flagged: false },
    });
    const [k] = await (await delivery(w))!.keys({
      purpose: "android-app-signing",
    });
    expect(k).toMatchObject({
      registered: true,
      registeredAt: NOW,
      flagged: false,
      observed: { at: NOW, by: "ci:repo:acme/djdl:environment:release" },
    });
    expect(await (await delivery(w))!.keys({ purpose: "release" })).toEqual([]);
  });

  it("a CI report with no inventory at all is an observation, never an entry", async () => {
    const w = await setup();
    await report(w, keyReport({ purpose: "fdroid-repo" }));
    expect(await (await delivery(w))!.keys()).toEqual([]);
    expect(
      ((await (await admin(w, "GET", "/keys")).json()) as Record<string, any>)
        .observations,
    ).toHaveLength(1);
  });

  it("refuses an unknown purpose, a malformed fingerprint and an undeclared outlet, writing nothing", async () => {
    const w = await setup();
    for (const [over, status, reason] of [
      [{ purpose: "gpg" }, 422, "unknown_purpose"],
      [{ sha256: FP_A.toUpperCase() }, 422, "invalid_fingerprint"],
      [{ sha256: "aa:bb" }, 422, "invalid_fingerprint"],
      [{ outlet: "steam" }, 404, "unknown_outlet"],
      [{ releaseId: "v1.1.0" }, 422, "invalid_body"],
    ] as const) {
      const res = await report(w, keyReport(over));
      expect(res.status, JSON.stringify(over)).toBe(status);
      expect(await res.json()).toMatchObject({ reason });
    }
    expect(await count(w, "dist_keys")).toBe(0);
  });

  it("operator changes are audited: add, register, adopt an observation, dismiss, delete", async () => {
    const w = await setup();
    await report(w, keyReport({ sha256: FP_B }));
    // Adopt the observation.
    let res = await admin(w, "PUT", "/keys", {
      purpose: "android-app-signing",
      sha256: FP_B,
      notes: "rotated upload key",
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as Record<string, any>).observations,
    ).toHaveLength(0);
    // Register it.
    res = await admin(w, "PUT", "/keys", {
      purpose: "android-app-signing",
      sha256: FP_B,
      registered: true,
    });
    expect(((await res.json()) as Record<string, any>).key).toMatchObject({
      registered: true,
      notes: "rotated upload key",
    });
    // A second observation, dismissed.
    await report(w, keyReport({ sha256: FP_A }));
    res = await admin(w, "DELETE", `/keys/android-app-signing/${FP_A}`);
    expect(res.status).toBe(200);
    // Delete the entry.
    res = await admin(w, "DELETE", `/keys/android-app-signing/${FP_B}`);
    expect(res.status).toBe(200);
    expect(
      (await admin(w, "DELETE", `/keys/android-app-signing/${FP_B}`)).status,
    ).toBe(404);
    expect(await count(w, "dist_keys")).toBe(0);
    const audit = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE product = ? ORDER BY rowid",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toEqual([
      "distribution.key.mismatch",
      "distribution.key.upsert",
      "distribution.key.upsert",
      "distribution.key.mismatch",
      "distribution.key.dismiss",
      "distribution.key.delete",
    ]);
    expect(audit[1]!.summary).toMatch(/Adopted/);
    expect(audit[2]!.summary).toMatch(/registered for Android developer/);
  });

  it("caps unreviewed observations; a known fingerprint is still recorded past the cap", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_KEY_OBSERVATIONS; i++)
      await w.db.run(
        `INSERT INTO dist_keys
           (product, purpose, fingerprint_sha256, source, created_at, modified_at)
         VALUES (?, 'release', ?, 'ci', ?, ?)`,
        SLUG,
        i.toString(16).padStart(64, "0"),
        NOW,
        NOW,
      );
    const res = await report(w, keyReport({ sha256: FP_B }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "too_many_observations" });
    expect(await count(w, "dist_keys")).toBe(MAX_KEY_OBSERVATIONS);
    // An existing observation is refreshed, not counted again.
    const again = await report(
      w,
      keyReport({ purpose: "release", sha256: "0".repeat(64) }),
    );
    expect(again.status).toBe(200);
  });

  it("the console refuses a malformed entry", async () => {
    const w = await setup();
    for (const body of [
      { purpose: "gpg", sha256: FP_A },
      { purpose: "release", sha256: "nope" },
      { purpose: "release", sha256: FP_A, outlet: "steam" },
      { purpose: "release", sha256: FP_A, registered: "yes" },
      { purpose: "release", sha256: FP_A, notes: "x".repeat(501) },
    ]) {
      const res = await admin(w, "PUT", "/keys", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await count(w, "dist_keys")).toBe(0);
    expect(await auditRows(w.db)).toEqual([]);
  });
});

describe("admin API: availability and submissions (read-only)", () => {
  it("GET availability?release= lists every outlet's record, derived and removed included", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_availability
         (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
       VALUES (?, 'v1.1.0', '', 'itch', 'pkey-cdn', 'live', ?, 'ci', ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const res = await admin(w, "GET", "/availability?release=v1.1.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.releaseId).toBe("v1.1.0");
    expect(body.states).toEqual(AVAILABILITY_STATES);
    expect(
      body.availability.map((r: Record<string, unknown>) => [
        r.outletId,
        r.derived,
        r.outletRemoved,
      ]),
    ).toEqual([
      ["direct", true, false],
      ["itch", false, true],
    ]);
    expect((await admin(w, "GET", "/availability")).status).toBe(422);
    expect((await admin(w, "GET", "/availability?release=v9.9.9")).status).toBe(
      404,
    );
    expect(
      (await admin(w, "PUT", "/availability?release=v1.1.0", {})).status,
    ).toBe(405);
  });

  it("GET submissions lists every release's submissions, narrowed by ?release=", async () => {
    const w = await setup();
    for (const releaseId of ["v1.0.0", "v1.1.0"])
      await report(w, {
        type: "submission",
        releaseId,
        outlet: "app-store",
        state: "submitted",
      });
    let body = (await (await admin(w, "GET", "/submissions")).json()) as Record<
      string,
      any
    >;
    expect(body.states).toEqual(SUBMISSION_STATES);
    expect(body.submissions).toHaveLength(2);
    body = (await (
      await admin(w, "GET", "/submissions?release=v1.0.0")
    ).json()) as Record<string, any>;
    expect(
      body.submissions.map((s: Record<string, unknown>) => s.releaseId),
    ).toEqual(["v1.0.0"]);
  });
});
