/** Signing-key state machine. */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedProductSecret } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { appendAudit, getProduct, listAudit } from "../src/core/repo.js";

const PLATFORM_GROUP = "platform-admins";
const SLUG = "djdl";

interface World {
  db: Db;
  env: Env;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, SLUG);
  // A proven step-up: the transitions below use `breakGlass`, which is gated on one.
  const { token, session } = await issueSession(
    env,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
      authTime: NOW,
      stepUp: true,
    },
    NOW,
  );
  const call = (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const full = `/api/products/${SLUG}${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      full.split("?")[0]!,
      { now: NOW },
    );
  };
  return { db, env, call };
}

import {
  KEY_TRANSITIONS,
  keyTransitionAllowed,
  stmtsActivateKey,
  type KeyAction,
  type KeyStatus,
} from "../src/keyTransitions.js";

const STATUSES: KeyStatus[] = ["active", "staged", "retired", "revoked"];
const ACTIONS: KeyAction[] = ["activate", "retire", "revoke"];

async function statuses(db: Db): Promise<Record<string, string>> {
  const rows = await db.all<{ kid: string; status: string }>(
    "SELECT kid, status FROM product_keys WHERE product = ?",
    SLUG,
  );
  return Object.fromEntries(rows.map((r) => [r.kid, r.status]));
}

async function stage(w: World): Promise<string> {
  return (
    (await (await w.call("POST", "/keys/prepare")).json()) as { kid: string }
  ).kid;
}

describe("transition table", () => {
  it("permits exactly these (action, from) pairs; revoked and active are never sources", () => {
    const allowed: string[] = [];
    for (const a of ACTIONS)
      for (const s of STATUSES)
        if (keyTransitionAllowed(a, s)) allowed.push(`${a}:${s}`);
    expect(allowed.sort()).toEqual(
      [
        "activate:staged",
        "retire:staged",
        "revoke:staged",
        "revoke:retired",
      ].sort(),
    );
    for (const a of ACTIONS) {
      expect(KEY_TRANSITIONS[a]).not.toContain("revoked");
      expect(KEY_TRANSITIONS[a]).not.toContain("active");
    }
  });

  it("the endpoints agree with the table for every (action, from) pair", async () => {
    for (const action of ACTIONS) {
      for (const from of STATUSES) {
        const w = await world();
        const kid = await stage(w);
        const active = Object.keys(await statuses(w.db)).find(
          (k) => k !== kid,
        )!;
        const target = from === "active" ? active : kid;
        if (from === "retired") await w.call("POST", "/keys/retire", { kid });
        if (from === "revoked") await w.call("POST", "/keys/revoke", { kid });
        const before = await statuses(w.db);
        const res = await w.call("POST", `/keys/${action}`, {
          kid: target,
          breakGlass: true,
        });
        expect(res.status, `${action} from ${from}`).toBe(
          keyTransitionAllowed(action, from) ? 200 : 409,
        );
        if (!keyTransitionAllowed(action, from))
          expect(await statuses(w.db)).toEqual(before);
      }
    }
  });
});

describe("revoked is terminal", () => {
  it("retire/activate/revoke on a revoked kid is 409 and revoked_at is preserved", async () => {
    const w = await world();
    const kid = await stage(w);
    expect((await w.call("POST", "/keys/revoke", { kid })).status).toBe(200);
    const revokedAt = async () =>
      (await w.db.first<{ revoked_at: number | null }>(
        "SELECT revoked_at FROM product_keys WHERE kid = ?",
        kid,
      ))!.revoked_at;
    const at = await revokedAt();
    expect(at).not.toBeNull();
    for (const action of ACTIONS)
      expect(
        (await w.call("POST", `/keys/${action}`, { kid, breakGlass: true }))
          .status,
      ).toBe(409);
    expect((await statuses(w.db))[kid]).toBe("revoked");
    expect(await revokedAt()).toBe(at);
  });
});

describe("activate vs revoke is atomic", () => {
  it("a target revoked after the handler's read leaves the old key active (no zero-active)", async () => {
    const w = await world();
    const kid = await stage(w);
    const before = await statuses(w.db);
    const oldActive = Object.keys(before).find((k) => k !== kid)!;
    // The revoke lands between the activate handler's read and its write.
    expect((await w.call("POST", "/keys/revoke", { kid })).status).toBe(200);
    const changes = await w.db.batchChanges!(stmtsActivateKey(SLUG, kid, NOW));
    expect(changes).toEqual([0, 0]);
    const after = await statuses(w.db);
    expect(after[oldActive]).toBe("active");
    expect(after[kid]).toBe("revoked");
  });

  it("a successful activation leaves exactly one active key", async () => {
    const w = await world();
    const kid = await stage(w);
    expect(
      (await w.call("POST", "/keys/activate", { kid, breakGlass: true }))
        .status,
    ).toBe(200);
    const act = Object.values(await statuses(w.db)).filter(
      (s) => s === "active",
    );
    expect(act).toHaveLength(1);
  });
});
