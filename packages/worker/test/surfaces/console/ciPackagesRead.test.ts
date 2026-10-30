/**
 * F-33b.2: the console mints a `packages:read` static token for up to 365 days and every other
 * scope set for 90 (D-F1). The Core cap is in `publisher.test.ts`; this is the route's.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "../../seed.js";
import { CONSOLE, envFor } from "../../releaseRoutesFixture.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { ensureSystemProduct } from "../../../src/console/systemProduct.js";

let db: Db;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  await ensureSystemProduct(env, db, "u1", NOW);
  await seedProduct(db, "acme");
});

/** A session without a fresh step-up (the default session has one). */
let stale = false;
beforeEach(() => {
  stale = false;
});

async function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: ["platform-admins"],
      ...(stale ? {} : { authTime: NOW, stepUp: true }),
    },
    NOW,
  );
  return handleAdmin(
    new Request(`${CONSOLE}/manage/api${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    `/api${path}`,
    { now: NOW },
  );
}

const POST = (scopes: string[], expiresInDays: number) =>
  admin("POST", "/products/acme/ci-tokens", { scopes, expiresInDays });

describe("console static CI token TTL (F-33b.2)", () => {
  it("accepts 365 days for packages:read alone and lists lastUsedAt", async () => {
    const res = await POST(["packages:read"], 365);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      expiresAt: NOW + 365 * 86400,
      scopes: ["packages:read"],
    });
    const list = (await (
      await admin("GET", "/products/acme/ci-tokens")
    ).json()) as {
      tokens: { lastUsedAt: number | null }[];
    };
    expect(list.tokens[0]!.lastUsedAt).toBeNull();
    expect((await POST(["packages:read"], 366)).status).toBe(400);
  });

  it("keeps 90 days for every other scope set, a mixed one included", async () => {
    expect((await POST(["release:publish"], 90)).status).toBe(201);
    const over = await POST(["release:publish"], 91);
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ field: "expiresInDays" });
    expect((await POST(["packages:read", "release:promote"], 91)).status).toBe(
      400,
    );
  });
});
