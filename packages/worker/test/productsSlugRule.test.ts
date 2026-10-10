/**
 * P0-14: one product slug rule. Manual create (`POST /manage/api/products`) applies the same
 * `@polaris-key/manifest` shape and reservations as the manifest validator, link-repo and the
 * slug check, and refuses with the same reasons (`invalid_slug`, `reserved_slug`).
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCT_ROUTE_ACTIONS,
  PRODUCT_SLUG_MAX,
  SYSTEM_PRODUCT_SLUG,
} from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { checkSlug } from "../src/services/release/linkRepo.js";
import { getProduct } from "../src/core/repo.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  return env;
}

async function create(env: Env, db: Db, slug: string): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "a@x.io", groups: ["admins"] },
    NOW,
  );
  const req = new Request("https://key.plrs.im/manage/api/products", {
    method: "POST",
    headers: {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ slug, name: "X" }),
  }) as unknown as Request;
  return handleAdmin(req, env, db, "/api/products", { now: NOW + 60 });
}

async function expectRefused(
  slug: string,
  message: string,
  reason: string,
): Promise<void> {
  const db = makeTestDb();
  const res = await create(envFor(), db, slug);
  expect(res.status, slug).toBe(422);
  expect(await res.json(), slug).toMatchObject({
    error: { message, reason, fields: ["slug"] },
  });
  expect(await getProduct(db, slug)).toBeNull();
}

describe("manual create applies the one product slug rule (P0-14)", () => {
  it("refuses a leading-hyphen slug as invalid_slug", async () => {
    await expectRefused("-acme", "invalid slug", "invalid_slug");
  });

  it("refuses a 65-character slug as invalid_slug", async () => {
    await expectRefused(
      "a".repeat(PRODUCT_SLUG_MAX + 1),
      "invalid slug",
      "invalid_slug",
    );
  });

  it("refuses each admin route action as reserved_slug", async () => {
    for (const slug of PRODUCT_ROUTE_ACTIONS)
      await expectRefused(slug, "reserved slug", "reserved_slug");
  });

  it("refuses router paths and the system product as reserved_slug", async () => {
    for (const slug of ["docs", "media", SYSTEM_PRODUCT_SLUG])
      await expectRefused(slug, "reserved slug", "reserved_slug");
  });

  it("refuses exactly what the slug check calls invalid or reserved", async () => {
    const db = makeTestDb();
    for (const slug of [
      "-acme",
      "a".repeat(65),
      "Acme",
      ...PRODUCT_ROUTE_ACTIONS,
      SYSTEM_PRODUCT_SLUG,
    ]) {
      const verdict = await checkSlug(db, slug);
      const res = await create(envFor(), db, slug);
      expect(verdict.status, slug).not.toBe("available");
      expect(res.status, slug).toBe(422);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason, slug).toBe(
        verdict.status === "reserved" ? "reserved_slug" : "invalid_slug",
      );
    }
  });

  it("takes a 64-character slug", async () => {
    const db = makeTestDb();
    const slug = "a".repeat(PRODUCT_SLUG_MAX);
    expect((await checkSlug(db, slug)).status).toBe("available");
    const res = await create(envFor(), db, slug);
    expect(res.status).toBeLessThan(300);
    expect(await getProduct(db, slug)).not.toBeNull();
  });
});
