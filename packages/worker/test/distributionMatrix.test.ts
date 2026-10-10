/**
 * P2b-06 — the console's distribution matrix (`services/distribution/matrix.ts`):
 * `GET /manage/api/products/<slug>/distribution/matrix`, releases × outlets with availability,
 * submission and rollout per cell, and the rollout verbs each cell allows. Driven through the
 * real admin API against the download page's Diceroll world (`downloadWorld.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProduct } from "../src/core/products.js";
import { SERVICES } from "../src/mount.js";
import { availabilityFor } from "../src/services/distribution/availability.js";
import type {
  Matrix,
  MatrixCell,
} from "../src/services/distribution/matrix.js";
import { NOW } from "./seed.js";
import { CONSOLE, SLUG, setup, type World } from "./downloadWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

async function admin(
  w: World,
  method: string,
  path: string,
  body?: unknown,
  opts: { session?: boolean } = {},
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution${path}`;
  const pathOnly = full.split("?")[0]!;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        ...(opts.session === false
          ? {}
          : {
              cookie: `${ADMIN_COOKIE}=${token}`,
              [CSRF_HEADER]: session.csrf,
            }),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    w.env,
    w.db,
    pathOnly,
    { now: NOW },
  );
}

async function matrix(w: World, query = ""): Promise<Matrix> {
  const res = await admin(w, "GET", `/matrix${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Matrix;
}

function cell(m: Matrix, releaseId: string, outletId: string): MatrixCell {
  const c = m.cells.find(
    (x) => x.releaseId === releaseId && x.outletId === outletId,
  );
  if (!c) throw new Error(`no cell ${releaseId} × ${outletId}`);
  return c;
}

async function mirrored(w: World): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_rollouts
       (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt, state,
        mirrored, source, started_at, updated_at, updated_by)
     VALUES (?, 'app', 'play', 'stable', 'app@1.2.0', 2000, ?, 'active', 1, 'play', ?, ?, 'play')`,
    SLUG,
    "0".repeat(32),
    NOW,
    NOW,
  );
}

describe("distribution matrix", () => {
  it("rows are the deliverable's newest releases, columns its live outlets", async () => {
    const w = await setup();
    const m = await matrix(w);
    expect(m.deliverableId).toBe("app");
    expect(m.releases.map((r) => [r.version, r.yanked])).toEqual([
      ["1.2.0", false],
      ["1.2.0-beta.1", false],
      ["1.1.1", true],
      ["1.1.0", false],
      ["1.0.0", false],
    ]);
    expect(m.outlets.map((o) => o.outletId).sort()).toEqual(
      [
        "altstore",
        "altstore-pal",
        "app-store",
        "direct",
        "fdroid-repo",
        "ms-store",
        "obtainium",
        "play",
        "steam",
        "testflight",
      ].sort(),
    );
    expect(m.cells).toHaveLength(m.releases.length * m.outlets.length);
    expect(m.states.rollout).toEqual([
      "active",
      "paused",
      "halted",
      "complete",
    ]);
    expect(m).not.toHaveProperty("effect");
    expect(
      (await matrix(w, "?limit=2")).releases.map((r) => r.version),
    ).toEqual(["1.2.0", "1.2.0-beta.1"]);
  });

  it("each cell shows availability, submission and rollout", async () => {
    const w = await setup();
    await w.db.run(
      `INSERT INTO dist_submissions
         (product, release_id, outlet_id, state, submitted_at, reviewed_at, detail_json, source, updated_at)
       VALUES (?, 'app@1.2.0', 'app-store', 'in-review', ?, NULL, NULL, 'ci', ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const m = await matrix(w);
    // Derived on a self-hosted outlet; a halt does not change what is live, it holds it.
    const alt = cell(m, "app@1.2.0", "altstore");
    expect(alt.availability).toBe("live");
    expect(alt.records.every((r) => r.derived)).toBe(true);
    expect(alt.rollouts.map((r) => [r.state, r.controls])).toEqual([
      ["halted", ["resume"]],
    ]);
    expect(
      cell(m, "app@1.2.0", "direct").rollouts.map((r) => [
        r.state,
        r.rolloutBp,
        r.controls,
      ]),
    ).toEqual([["paused", 2500, ["resume", "halt"]]]);
    // Reported on a store outlet; nothing derived there.
    expect(cell(m, "app@1.1.0", "app-store").availability).toBe("live");
    expect(cell(m, "app@1.1.0", "ms-store").availability).toBeNull();
    const sub = cell(m, "app@1.2.0", "app-store").submission;
    expect(sub).toMatchObject({ state: "in-review", source: "ci" });
    // A yanked release derives nothing; its stored report stays visible.
    expect(cell(m, "app@1.1.1", "direct").availability).toBeNull();
    expect(cell(m, "app@1.1.1", "steam").availability).toBe("live");
  });

  it("agrees with availability.ts cell by cell", async () => {
    const w = await setup();
    const m = await matrix(w);
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const hooks = buildHooks(SERVICES, product.services, {
      env: w.env,
      db: w.db,
      product,
      now: NOW,
    });
    for (const r of m.releases) {
      const expected = await availabilityFor(
        { db: w.db, product: SLUG, hooks },
        r.releaseId,
      );
      const got = m.cells
        .filter((c) => c.releaseId === r.releaseId)
        .flatMap((c) => c.records);
      const key = (x: {
        outletId: string;
        buildId: string;
        state: string;
        derived: boolean;
      }) => `${x.outletId}|${x.buildId}|${x.state}|${x.derived}`;
      expect(got.map(key).sort(), r.version).toEqual(expected.map(key).sort());
    }
  });

  it("a mirrored rollout shows its source and allows no direct control", async () => {
    const w = await setup();
    await mirrored(w);
    const m = await matrix(w);
    const [roll] = cell(m, "app@1.2.0", "play").rollouts;
    expect(roll).toMatchObject({
      mirrored: true,
      source: "play",
      controls: [],
    });
    // And the route the control would call refuses it.
    const res = await admin(w, "POST", "/rollouts/play/stable/pause", {
      releaseId: "app@1.2.0",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "rollout_mirrored" });
  });

  it("each control is P2b-04's admin rollout route, and the matrix follows it", async () => {
    const w = await setup();
    const steps: Array<[string, string, string]> = [
      ["direct", "resume", "active"],
      ["direct", "pause", "paused"],
      ["direct", "halt", "halted"],
      ["direct", "resume", "active"],
      ["direct", "complete", "complete"],
      ["altstore", "resume", "active"],
    ];
    for (const [outlet, verb, state] of steps) {
      const before = await matrix(w);
      const [roll] = cell(before, "app@1.2.0", outlet).rollouts;
      expect(roll!.controls, `${outlet} ${verb}`).toContain(verb);
      const res = await admin(w, "POST", `/rollouts/${outlet}/stable/${verb}`, {
        deliverable: "app",
        releaseId: "app@1.2.0",
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const after = await matrix(w);
      expect(cell(after, "app@1.2.0", outlet).rollouts[0]!.state).toBe(state);
    }
    expect(
      cell(await matrix(w), "app@1.2.0", "direct").rollouts[0]!.controls,
    ).toEqual([]);
  });

  it("refuses a bad limit, an unknown deliverable, and a request without a session", async () => {
    const w = await setup();
    expect((await admin(w, "GET", "/matrix?limit=0")).status).toBe(422);
    expect((await admin(w, "GET", "/matrix?limit=abc")).status).toBe(422);
    expect((await admin(w, "GET", "/matrix?deliverable=nope")).status).toBe(
      404,
    );
    expect((await admin(w, "POST", "/matrix", {})).status).toBe(405);
    expect(
      (await admin(w, "GET", "/matrix", undefined, { session: false })).status,
    ).toBe(401);
    // An over-large limit is clamped, not refused.
    expect((await matrix(w, "?limit=500")).limit).toBe(50);
  });
});
