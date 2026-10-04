/**
 * A-3 (docs/design/ADMIN.md §7.3): the license and tier PATCH bodies accept `null` to clear a
 * nullable field, so the console's "blank uses the default" is true. An absent field keeps the
 * stored value; `null` stores NULL (the tier or product default applies); a value replaces it.
 * Each clear is an ordinary update and keeps its audit row.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit } from "../src/repo.js";

const SLUG = "djdl";
const PLATFORM_GROUP = "platform-admins";

async function fixture(): Promise<{
  db: Db;
  env: Env;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
}> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  await seedProduct(db, SLUG);
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const call = (method: string, path: string, body?: unknown) => {
    const full = `/api/products/${SLUG}/license/${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, init),
      env,
      db,
      full,
      { now: NOW },
    );
  };
  return { db, env, call };
}

describe("A-3 · license PATCH clears maxOfflineDays", () => {
  it("absent keeps, a number sets, null clears", async () => {
    const { db, call } = await fixture();
    const created = await call("POST", "licenses", {
      name: "Ada",
      email: "ada@x.io",
      maxOfflineDays: 14,
    });
    expect(created.status).toBe(201);
    const { licenseId } = (await created.json()) as { licenseId: string };
    const read = async (): Promise<unknown> =>
      (
        (await (await call("GET", `licenses/${licenseId}`)).json()) as {
          maxOfflineDays: number | null;
        }
      ).maxOfflineDays;

    expect(await read()).toBe(14);
    expect(
      (await call("PATCH", `licenses/${licenseId}`, { name: "A" })).status,
    ).toBe(200);
    expect(await read()).toBe(14);
    expect(
      (await call("PATCH", `licenses/${licenseId}`, { maxOfflineDays: 7 }))
        .status,
    ).toBe(200);
    expect(await read()).toBe(7);
    expect(
      (await call("PATCH", `licenses/${licenseId}`, { maxOfflineDays: null }))
        .status,
    ).toBe(200);
    expect(await read()).toBeNull();

    const audit = await listAudit(db, SLUG);
    expect(audit.some((a) => a.action === "license.update")).toBe(true);
  });

  it("still refuses an out-of-range value", async () => {
    const { call } = await fixture();
    const created = await call("POST", "licenses", {
      name: "Ada",
      email: "ada@x.io",
    });
    const { licenseId } = (await created.json()) as { licenseId: string };
    const res = await call("PATCH", `licenses/${licenseId}`, {
      maxOfflineDays: 0,
    });
    expect(res.status).toBe(422);
  });
});

describe("A-3 · tier PATCH clears its nullable fields", () => {
  it("null clears profile, expiry days and device limit; absent keeps them", async () => {
    const { call } = await fixture();
    expect(
      (
        await call("POST", "tiers", {
          id: "pro",
          label: "Pro",
          policyExpiryDays: 365,
          policyDeviceLimit: 5,
          channels: ["stable"],
        })
      ).status,
    ).toBe(201);
    const read = async () =>
      (
        (await (await call("GET", "tiers")).json()) as {
          tiers: {
            id: string;
            label: string;
            profile: string | null;
            policyExpiryDays: number | null;
            policyDeviceLimit: number | null;
          }[];
        }
      ).tiers.find((t) => t.id === "pro")!;

    expect((await call("PATCH", "tiers/pro", { label: "Pro+" })).status).toBe(
      200,
    );
    expect(await read()).toMatchObject({
      label: "Pro+",
      policyExpiryDays: 365,
      policyDeviceLimit: 5,
    });

    expect(
      (
        await call("PATCH", "tiers/pro", {
          policyExpiryDays: null,
          policyDeviceLimit: null,
          profile: null,
        })
      ).status,
    ).toBe(200);
    expect(await read()).toMatchObject({
      label: "Pro+",
      profile: null,
      policyExpiryDays: null,
      policyDeviceLimit: null,
    });
  });

  it("a value of the wrong type keeps the stored value; a bad limit is still refused", async () => {
    const { call } = await fixture();
    await call("POST", "tiers", { id: "pro", policyDeviceLimit: 5 });
    expect(
      (await call("PATCH", "tiers/pro", { policyExpiryDays: "30" })).status,
    ).toBe(200);
    expect(
      (await call("PATCH", "tiers/pro", { policyDeviceLimit: 0 })).status,
    ).toBe(422);
    const tiers = (
      (await (await call("GET", "tiers")).json()) as {
        tiers: {
          id: string;
          policyExpiryDays: number | null;
          policyDeviceLimit: number | null;
        }[];
      }
    ).tiers;
    expect(tiers.find((t) => t.id === "pro")).toMatchObject({
      policyExpiryDays: null,
      policyDeviceLimit: 5,
    });
  });
});
