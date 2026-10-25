/**
 * A malformed percent-escape in the request PATH is a refusal, not a throw.
 *
 * `decodeURIComponent` throws a `URIError` on a truncated or invalid escape. The router decodes
 * two attacker-chosen path segments (the portal download token and a device id), so before the
 * router guarded them `GET /download/%` left `matchRoute` by throwing: not a 404, not a 400, an
 * unhandled rejection before any handler existed to have an opinion.
 *
 * Three layers, each pinned here: the router answers `badRequest` (distinct from `notFound`),
 * the dispatcher turns that into `400 bad_request`, and a `URIError` from anywhere else in the
 * request is a 400 too, while every other failure is rethrown rather than laundered into one.
 */

import { describe, expect, it } from "vitest";
import worker from "../../src/index.js";
import { dispatchWith } from "../../src/dispatch.js";
import { matchRoute } from "../../src/router.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW } from "../seed.js";

const SLUG = "djdl";

/** A database whose every call fails with `error`: the boundary's only way to see a throw. */
function failingDb(error: Error): Db {
  const fail = async (): Promise<never> => {
    throw error;
  };
  return {
    all: fail,
    first: fail,
    run: fail,
    runChanges: fail,
    batch: fail,
  };
}

describe("matchRoute: percent-escapes that do not decode", () => {
  it.each([
    "/download/%",
    "/download/%zz",
    "/download/%E0%A4",
    `/${SLUG}/devices/%`,
    `/${SLUG}/devices/%C0`,
  ])("answers badRequest rather than throwing for %s", (path) => {
    expect(() => matchRoute(path)).not.toThrow();
    expect(matchRoute(path)).toEqual({ kind: "badRequest" });
  });

  it("keeps a genuinely absent path a notFound: the two are not merged", () => {
    expect(matchRoute("/download/a/b")).toEqual({ kind: "notFound" });
    expect(matchRoute(`/${SLUG}/nope/nope`)).toEqual({ kind: "notFound" });
  });

  it("still decodes a well-formed escape at both sites", () => {
    expect(matchRoute("/download/a%2Bb")).toEqual({
      kind: "portalDownload",
      token: "a+b",
    });
    expect(matchRoute(`/${SLUG}/devices/a%2Bb`)).toEqual({
      kind: "devices",
      product: SLUG,
      deviceId: "a+b",
    });
  });
});

describe("the dispatcher's answer", () => {
  it.each(["/download/%", `/${SLUG}/devices/%C0`])(
    "answers 400 bad_request for %s without touching the database",
    async (path) => {
      const res = await dispatchWith(
        new Request(`https://key.plrs.im${path}`) as unknown as Request,
        makeEnv(new KvMock(), [SLUG]),
        // Nothing may be looked up: a refusal about the URL's shape precedes every query.
        failingDb(new Error("the database must not be reached")),
        NOW,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "bad_request" },
        message: "malformed percent-encoding in the request URL",
      });
    },
  );

  it("answers 400 for a URIError raised anywhere else in the request", async () => {
    const res = await dispatchWith(
      new Request(
        `https://key.plrs.im/${SLUG}/.well-known/jwks.json`,
      ) as unknown as Request,
      makeEnv(new KvMock(), [SLUG]),
      failingDb(new URIError("URI malformed")),
      NOW,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("does not launder any other failure into a 400", async () => {
    // A broken database reported as "bad request" would send an operator to inspect the caller
    // instead of the outage.
    await expect(
      dispatchWith(
        new Request(
          `https://key.plrs.im/${SLUG}/.well-known/jwks.json`,
        ) as unknown as Request,
        makeEnv(new KvMock(), [SLUG]),
        failingDb(new Error("d1 unavailable")),
        NOW,
      ),
    ).rejects.toThrow("d1 unavailable");
  });
});

describe("the Worker entry point", () => {
  it("answers GET /download/% with 400, not a 500 and not an unhandled rejection", async () => {
    const env: Env = makeEnv(new KvMock(), [SLUG]);
    const res = await worker.fetch(
      new Request("https://key.plrs.im/download/%") as unknown as Request,
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    // Still wrapped in the origin-wide backstop.
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
  });

  it("does not launder a database failure into a 400 either", async () => {
    // `DB` is unbound in this Env, so a route that reaches D1 throws something that is not a
    // URIError, and the Worker lets it surface.
    const env: Env = makeEnv(new KvMock(), [SLUG]);
    await expect(
      worker.fetch(
        new Request(
          `https://key.plrs.im/${SLUG}/.well-known/jwks.json`,
        ) as unknown as Request,
        env,
      ),
    ).rejects.toBeTruthy();
  });
});
