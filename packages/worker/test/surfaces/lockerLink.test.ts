// F-37.1b: the key host's hops into Polaris Locker, `/approve?code=` and `/account/packages`.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, seedProduct } from "../seed.js";
import { dispatchWith } from "../../src/dispatch.js";
import type { Env } from "../../src/platform/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const NOW = 1_800_000_000;

describe("the key host's Locker hops", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.CONSOLE_ORIGIN = API;
    await seedProduct(db, "djdl");
  });
  const get = (path: string, host = API, method = "GET") =>
    dispatchWith(new Request(`${host}${path}`, { method }), env, db, NOW);

  it("sends the approval to the customer origin's hash route, the code encoded", async () => {
    env.CUSTOMER_ORIGIN = CUSTOMER;
    const res = await get("/approve?code=BCDF-GHJK");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${CUSTOMER}/#/account/approve?code=BCDF-GHJK`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await get("/approve?code=BCDF-GHJK", API, "HEAD")).status).toBe(
      302,
    );
  });

  it("falls back to this host's own portal with no customer origin", async () => {
    const res = await get("/approve?code=BCDF-GHJK");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${API}/#/account/approve?code=BCDF-GHJK`,
    );
  });

  it("refuses anything but a device code in display form with 400, echoing nothing", async () => {
    env.CUSTOMER_ORIGIN = CUSTOMER;
    for (const bad of [
      "",
      "?code=",
      "?code=bcdf-ghjk",
      "?code=BCDFGHJK",
      "?code=BCDF-GHJK%0d%0aX:1",
      "?code=BCDF-GHJK%23x",
      "?code=BCDF-GHJA",
      "?code=https://evil.example",
      "?code=//evil.example",
      "?code=BCDF-GHJK-BCDF",
    ]) {
      const res = await get(`/approve${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("location"), bad).toBeNull();
      expect(await res.text()).not.toMatch(/BCDF|evil/);
    }
  });

  it("only GET and HEAD", async () => {
    expect((await get("/approve?code=BCDF-GHJK", API, "POST")).status).toBe(
      405,
    );
  });

  it("sends the Packages page the same way", async () => {
    expect((await get("/account/packages")).headers.get("location")).toBe(
      `${API}/#/account/packages`,
    );
    env.CUSTOMER_ORIGIN = CUSTOMER;
    const res = await get("/account/packages");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${CUSTOMER}/#/account/packages`);
  });

  it("is a key-host hop only: the customer host does not serve it", async () => {
    env.CUSTOMER_ORIGIN = CUSTOMER;
    expect((await get("/approve?code=BCDF-GHJK", CUSTOMER)).status).toBe(404);
    expect((await get("/account/packages", CUSTOMER)).status).toBe(404);
  });
});
