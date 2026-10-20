/**
 * `GET /manage/api/attention` (UX-12, ST-44) and `GET /manage/api/platform/ready` (UX-67): what
 * needs the operator, composed on the server; broken things only, per visible product.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import { ADMIN_COOKIE, issueSession } from "../src/core/console/session.js";

const PLATFORM_GROUP = "platform-admins";
const DAY = 86_400;

const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

let db: ReturnType<typeof makeTestDb>;

function adminEnv(): Env {
  const e = makeEnv(new KvMock(), []);
  e.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  e.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return e;
}

async function get(
  path: string,
  groups: string[] = [PLATFORM_GROUP],
  method = "GET",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const env = adminEnv();
  const { token } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    env,
    db,
    path,
    { now: NOW },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

interface Item {
  id: string;
  kind: string;
  tone: string;
  lines: string[];
  product: { slug: string };
}

beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, "djdl");
  await seedProduct(db, "acme");
});

describe("GET /manage/api/attention", () => {
  it("is empty for healthy products: integration progress never appears", async () => {
    const res = await get("/api/attention");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ items: [] });
  });

  it("lists a failed resync and an expiring or expired store credential, worst first", async () => {
    await db.run(
      `INSERT INTO product_sync_state (product, source, status, last_checked_at, message)
            VALUES ('acme', 'manual', 'error', ?, 'validation failed: line 14 names switch')`,
      NOW,
    );
    for (const [id, expires] of [
      ["play", NOW + 3 * DAY],
      ["steam", NOW - DAY],
      ["later", NOW + 60 * DAY],
    ] as const)
      await db.run(
        `INSERT INTO outlet_credentials (product, credential_id, kind, enc_value_json, status,
                created_at, created_by, expires_at)
              VALUES ('djdl', ?, ?, '{}', 'active', ?, 'u1', ?)`,
        id,
        id === "play" || id === "later"
          ? "google-service-account"
          : "steam-publisher-key",
        NOW,
        expires,
      );
    const items = (await get("/api/attention")).json.items as Item[];
    expect(items.map((i) => [i.kind, i.tone, i.product.slug])).toEqual([
      ["sync.failed", "danger", "acme"],
      ["credential.expiring", "danger", "djdl"],
      ["credential.expiring", "warning", "djdl"],
    ]);
    expect(items[0]!.lines).toEqual([
      "Resync failed.",
      "The manifest did not validate.",
    ]);
    expect(items[1]!.lines).toEqual([
      `Steam publisher key expired ${day(NOW - DAY)}.`,
    ]);
    expect(items[2]!.lines).toEqual([
      `Google Play key expires ${day(NOW + 3 * DAY)}.`,
    ]);
  });

  it("answers a session with no grant 403", async () => {
    expect((await get("/api/attention", ["nobody"])).status).toBe(403);
  });
});

describe("a failed resync's message", () => {
  it("is never repeated: a token or body in it cannot reach Home", async () => {
    const secret = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";
    await db.run(
      `INSERT INTO product_sync_state (product, source, status, last_checked_at, message)
            VALUES ('acme', 'manual', 'error', ?, ?)`,
      NOW,
      `GitHub 401 Bad credentials: Authorization: token ${secret} {"message":"Bad credentials"}`,
    );
    const res = await get("/api/attention");
    const text = JSON.stringify(res.json);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Authorization");
    expect((res.json.items as Item[])[0]!.lines[1]).toBe(
      "GitHub refused access to the repository.",
    );
  });
});

describe("GET /manage/api/platform/ready", () => {
  it("counts the rows whose fact holds and names the fix for the rest", async () => {
    const res = (await get("/api/platform/ready")).json as {
      rows: { id: string; done: boolean; detail?: string }[];
      done: number;
      total: number;
    };
    expect(res.total).toBe(res.rows.length);
    expect(res.done).toBe(res.rows.filter((r) => r.done).length);
    const jobs = res.rows.find((r) => r.id === "background-jobs")!;
    expect(jobs.done).toBe(false);
    expect(jobs.detail).toBeTruthy();
    expect(res.rows.filter((r) => r.done).every((r) => !r.detail)).toBe(true);
  });

  it("is the platform's: a product member is refused", async () => {
    expect((await get("/api/platform/ready", ["nobody"])).status).toBe(403);
  });
});
