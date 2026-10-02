/**
 * P6-03 — the Sentry alert webhook (`POST /<p>/distribution/hooks/sentry`,
 * `services/distribution/sentry.ts`) and the console's candidate decisions.
 *
 * A Sentry alert never halts anything: it opens a halt candidate that a platform admin confirms
 * (which halts, audited as that admin) or dismisses. The client secret is a placeholder; it is
 * stored as a `sentry-integration` outlet credential through the Core admin handler, exactly as
 * an operator would.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  parseSentryRelease,
  sentrySignature,
  tagValue,
} from "../src/services/distribution/sentry.js";
import {
  auditRows,
  call,
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";

/** A placeholder — never a real Sentry client secret. */
const CLIENT_SECRET = "sentry-test-client-secret-0000";

interface World {
  env: Env;
  db: Db;
  gh: ReturnType<typeof github>;
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
  return handleAdmin(
    new Request(`${CONSOLE}/manage${path}`, {
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
    path,
    { now: NOW },
  );
}

const dist = (path: string) => `/api/products/${SLUG}/distribution${path}`;

async function setup(opts: { credential?: boolean } = {}): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  for (const [id, kind] of [
    ["direct", "direct"],
    ["itch", "itch"],
    ["play", "play"],
  ] as const)
    await db.run(
      `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
      SLUG,
      id,
      kind,
      NOW,
      NOW,
    );
  const w = { env, db, gh };
  if (opts.credential !== false) {
    const res = await admin(
      w,
      "PUT",
      `/api/products/${SLUG}/outlet-credentials/sentry`,
      { kind: "sentry-integration", value: { clientSecret: CLIENT_SECRET } },
    );
    expect(res.status).toBe(200);
  }
  for (const outlet of ["direct", "itch"]) {
    const res = await admin(w, "POST", dist(`/rollouts/${outlet}/stable`), {
      releaseId: "v1.1.0",
      bp: 2000,
    });
    expect(res.status).toBe(200);
  }
  return w;
}

function alert(over: Record<string, unknown> = {}, tags?: unknown) {
  return {
    action: "triggered",
    installation: { uuid: "00000000-0000-0000-0000-000000000001" },
    data: {
      triggered_rule: "Crash spike",
      event: {
        event_id: "9b1f0c3e5d2a4c8e9f7a6b5c4d3e2f10",
        issue_id: "4200001",
        release: "app@1.1.0",
        environment: "stable",
        message: "user alice@example.com crashed",
        user: { email: "alice@example.com" },
        tags: tags ?? [
          ["environment", "stable"],
          ["pkey.outlet", "direct"],
        ],
        ...over,
      },
    },
  };
}

async function deliver(
  w: World,
  body: unknown,
  opts: { secret?: string; signature?: string | null; resource?: string } = {},
): Promise<Response> {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const signature =
    opts.signature === undefined
      ? await sentrySignature(opts.secret ?? CLIENT_SECRET, raw)
      : opts.signature;
  return call(
    w.env,
    w.db,
    w.gh.fetchImpl,
    `${CONSOLE}/${SLUG}/distribution/hooks/sentry`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sentry-hook-resource": opts.resource ?? "event_alert",
        "sentry-hook-timestamp": String(NOW),
        ...(signature !== null ? { "sentry-hook-signature": signature } : {}),
      },
      body: raw,
    },
  );
}

async function candidates(w: World) {
  return w.db.all<{
    object_id: string;
    outlet_id: string;
    state: string;
    detail_json: string;
  }>(
    `SELECT object_id, outlet_id, state, detail_json FROM dist_connector_objects
      WHERE product = ? AND connector = 'sentry' AND object_type = 'halt-candidate'
      ORDER BY outlet_id`,
    SLUG,
  );
}

async function rolloutState(w: World, outlet: string) {
  return await w.db.first<{ state: string; source: string }>(
    `SELECT state, source FROM dist_rollouts WHERE product = ? AND outlet_id = ? AND channel = 'stable'`,
    SLUG,
    outlet,
  );
}

describe("mapping helpers", () => {
  it("parses <deliverable>@<version>[+<build>]", () => {
    expect(parseSentryRelease("app@1.4.0+12")).toEqual({
      deliverable: "app",
      version: "1.4.0",
      build: "12",
    });
    expect(parseSentryRelease("levels.a@2.0.0")).toEqual({
      deliverable: "levels.a",
      version: "2.0.0",
      build: null,
    });
    for (const bad of ["1.4.0", "@1.4.0", "App@1.0", "app@", "app@+3", 7, null])
      expect(parseSentryRelease(bad), String(bad)).toBeNull();
  });

  it("reads a tag from either of Sentry's tag shapes", () => {
    expect(tagValue([["pkey.outlet", "itch"]], "pkey.outlet")).toBe("itch");
    expect(
      tagValue([{ key: "pkey.outlet", value: "steam" }], "pkey.outlet"),
    ).toBe("steam");
    expect(tagValue({ "pkey.outlet": "x" }, "pkey.outlet")).toBeNull();
  });
});

describe("POST /<p>/distribution/hooks/sentry", () => {
  it("is the service not-found shape without a sentry-integration credential", async () => {
    const w = await setup({ credential: false });
    const res = await deliver(w, alert());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });

  it("refuses a missing or malformed signature before opening the credential", async () => {
    const w = await setup();
    for (const signature of [null, "nothex", "a".repeat(63)]) {
      const res = await deliver(w, alert(), { signature });
      expect(res.status, String(signature)).toBe(401);
    }
    const opens = (await auditRows(w.db)).filter(
      (r) => r.action === "outlet_credential.use",
    );
    expect(opens).toEqual([]);
    expect(await candidates(w)).toEqual([]);
  });

  it("refuses a bad signature (wrong secret) with 401 and opens no candidate", async () => {
    const w = await setup();
    const res = await deliver(w, alert(), { secret: "not-the-secret" });
    expect(res.status).toBe(401);
    expect(await candidates(w)).toEqual([]);
  });

  it("opens one candidate for a valid alert on a known release, and halts nothing", async () => {
    const w = await setup();
    const res = await deliver(w, alert());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, candidates: 1 });
    const open = await candidates(w);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ outlet_id: "direct", state: "open" });
    const detail = JSON.parse(open[0]!.detail_json) as Record<string, unknown>;
    expect(detail).toMatchObject({
      alerts: 1,
      rule: "Crash spike",
      issueId: "4200001",
    });
    // No crash payload is kept on the candidate.
    expect(open[0]!.detail_json).not.toContain("alice");
    expect(await rolloutState(w, "direct")).toMatchObject({ state: "active" });
    const actions = (await auditRows(w.db)).map((r) => r.action);
    expect(
      actions.filter((a) => a === "distribution.sentry.candidate"),
    ).toHaveLength(1);
    expect(actions).not.toContain("distribution.rollout.halt");
  });

  it("answers a redelivery as a duplicate; another alert bumps the open candidate", async () => {
    const w = await setup();
    const body = alert();
    await deliver(w, body);
    const again = await deliver(w, body);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    const second = await deliver(w, alert({ event_id: "another-event" }));
    expect(await second.json()).toEqual({ ok: true, candidates: 0 });
    const open = await candidates(w);
    expect(open).toHaveLength(1);
    expect(JSON.parse(open[0]!.detail_json)).toMatchObject({ alerts: 2 });
  });

  it("without a pkey.outlet tag, every self-hosted rollout of the release is a candidate; a mirrored one never is", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_rollouts (product, deliverable_id, outlet_id, channel, release_id, rollout_bp,
         rollout_salt, state, mirrored, source, started_at, updated_at, updated_by)
       VALUES (?, 'app', 'play', 'stable', 'v1.1.0', 2000, 'aa', 'active', 1, 'play', ?, ?, 'connector:play')`,
      SLUG,
      NOW,
      NOW,
    );
    const res = await deliver(w, alert({}, [["environment", "stable"]]));
    expect(await res.json()).toEqual({ ok: true, candidates: 2 });
    expect((await candidates(w)).map((c) => c.outlet_id)).toEqual([
      "direct",
      "itch",
    ]);
  });

  it("stores an alert it cannot map as unresolved, and other resources as ignored (204)", async () => {
    const w = await setup();
    for (const over of [
      { release: "app@9.9.9" },
      { release: "not-a-release" },
      { environment: "nightly" },
    ]) {
      const res = await deliver(w, alert(over));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, candidates: 0 });
    }
    const issue = await deliver(
      w,
      { action: "created", data: { issue: { id: "1" } } },
      { resource: "issue" },
    );
    expect(issue.status).toBe(204);
    const resolved = await deliver(w, { ...alert(), action: "resolved" });
    expect(resolved.status).toBe(204);
    expect(await candidates(w)).toEqual([]);
    const outcomes = await w.db.all<{ outcome: string }>(
      "SELECT outcome FROM dist_connector_events WHERE product = ? AND connector = 'sentry' ORDER BY rowid",
      SLUG,
    );
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "unresolved",
      "unresolved",
      "unresolved",
      "ignored",
      "ignored",
    ]);
  });

  it("refuses a body that is not a JSON object", async () => {
    const w = await setup();
    const res = await deliver(w, ["not", "an", "object"]);
    expect(res.status).toBe(400);
  });
});

describe("confirming and dismissing a candidate", () => {
  it("confirming halts the rollout as the admin, once", async () => {
    const w = await setup();
    await deliver(w, alert());
    const [cand] = await candidates(w);
    const res = await admin(
      w,
      "POST",
      dist(`/update-health/candidates/${cand!.object_id}/confirm`),
      {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      candidate: { state: "confirmed", terminal: true },
    });
    expect(await rolloutState(w, "direct")).toEqual({
      state: "halted",
      source: "admin",
    });
    expect(await rolloutState(w, "itch")).toMatchObject({ state: "active" });
    const audits = (await auditRows(w.db)).filter((r) =>
      [
        "distribution.rollout.halt",
        "distribution.sentry.candidate.confirm",
      ].includes(r.action),
    );
    expect(audits.map((a) => [a.action, a.actor_sub])).toEqual([
      ["distribution.rollout.halt", "u1"],
      ["distribution.sentry.candidate.confirm", "u1"],
    ]);
    const again = await admin(
      w,
      "POST",
      dist(`/update-health/candidates/${cand!.object_id}/confirm`),
      {},
    );
    expect(again.status).toBe(409);
    // A closed candidate is not reopened by a later alert.
    await deliver(w, alert({ event_id: "later" }));
    expect((await candidates(w))[0]).toMatchObject({ state: "confirmed" });
  });

  it("dismissing closes it without halting", async () => {
    const w = await setup();
    await deliver(w, alert());
    const [cand] = await candidates(w);
    const res = await admin(
      w,
      "POST",
      dist(`/update-health/candidates/${cand!.object_id}/dismiss`),
      {},
    );
    expect(res.status).toBe(200);
    expect(await rolloutState(w, "direct")).toMatchObject({ state: "active" });
    expect((await candidates(w))[0]).toMatchObject({ state: "dismissed" });
  });

  it("answers 404 for an unknown candidate", async () => {
    const w = await setup();
    const res = await admin(
      w,
      "POST",
      dist("/update-health/candidates/cand_nope/confirm"),
      {},
    );
    expect(res.status).toBe(404);
  });

  it("shows the hook's setup and its candidates in the console view", async () => {
    const w = await setup();
    await deliver(w, alert());
    const body = (await (
      await admin(w, "GET", dist("/update-health"))
    ).json()) as {
      sentry: {
        configured: boolean;
        candidates: Array<{ state: string; outletId: string }>;
      };
    };
    expect(body.sentry.configured).toBe(true);
    expect(body.sentry.candidates).toMatchObject([
      { state: "open", outletId: "direct" },
    ]);
  });
});
