// PX-14a: `/signin?request=rq_…` is the portal SPA's card. The Worker serves the shell for it (the
// SPA reads the handle itself; the API answers only the browser holding the request's binder), and
// every other `/signin` shape is still the redirect.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const NOW = 1_800_000_000;

describe("GET /signin?request=", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
  });
  const get = (path: string, cookie?: string) =>
    dispatchWith(
      new Request(`https://key.plrs.im${path}`, {
        redirect: "manual",
        ...(cookie ? { headers: { cookie } } : {}),
      }),
      env,
      db,
      NOW,
    );

  const BINDER = `__Host-pk_req=${"A".repeat(43)}`;

  it("serves the portal shell to a browser that holds a binder", async () => {
    const res = await get(
      "/signin?request=rq_AAAAAAAAAAAAAAAAAAAAAA",
      BINDER,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src",
    );
  });

  it("is a plain not-found with no binder, and on the bind hop", async () => {
    expect(
      (await get("/signin?request=rq_AAAAAAAAAAAAAAAAAAAAAA")).status,
    ).toBe(404);
    expect(
      (await get("/signin?request=rq_AAAAAAAAAAAAAAAAAAAAAA&bind=x", BINDER))
        .status,
    ).toBe(404);
  });

  it("keeps the redirect for a plain sign-in", async () => {
    const res = await get("/signin?product=djdl");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?product=djdl");
  });
});
