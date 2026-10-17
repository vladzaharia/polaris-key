// A gated Express, Hono and Next.js route answers each §5.2 verdict with the right status and
// problem+json body. The three adapters run the same table.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as exp from "../src/express.js";
import * as hon from "../src/hono.js";
import { createNextPolarisKey } from "../src/next.js";
import { PolarisKeyError } from "../src/index.js";
import { createTestKit, type TestKit } from "../src/testing.js";

const SUBJECT = "ps_" + "A".repeat(22);

type Send = (
  path: string,
  headers: Record<string, string>,
) => Promise<Response>;

let kit: TestKit;
beforeAll(async () => {
  kit = await createTestKit({ product: "acme" });
});

/** The routes every adapter serves: open, license, entitlement, valued entitlement, sign-in. */
const ROUTES = {
  open: "/open",
  license: "/license",
  entitled: "/export",
  seats: "/seats",
  signin: "/save",
};

async function runTable(name: string, send: Send) {
  describe(`${name}: the §5.2 verdicts`, () => {
    it("an open route needs nothing", async () => {
      expect((await send(ROUTES.open, {})).status).toBe(200);
    });

    it("license_required: 401 with the challenge, problem+json and no-store", async () => {
      const res = await send(ROUTES.entitled, {});
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("www-authenticate")).toBe(
        'PKey-License realm="acme", error="license_required"',
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 401, code: "license_required" });
      expect(Object.keys(body).sort()).toEqual([
        "code",
        "detail",
        "status",
        "title",
        "type",
      ]);
    });

    it("license_invalid: 401 for a document nobody signed for this product", async () => {
      const other = await createTestKit({ product: "acme" });
      const jws = await other.sign({ entitlements: { "export.pdf": true } });
      const res = await send(ROUTES.entitled, kit.headers(jws));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe(
        "license_invalid",
      );
    });

    it("license_stale: 401 past expiresAt plus 300 s", async () => {
      const jws = await kit.sign({ entitlements: { "export.pdf": true } });
      kit.clock.advance(3600 + 301);
      try {
        const res = await send(ROUTES.entitled, kit.headers(jws));
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toContain(
          'error="license_stale"',
        );
        expect(((await res.json()) as { code: string }).code).toBe(
          "license_stale",
        );
      } finally {
        kit.clock.advance(-(3600 + 301));
      }
    });

    it("not_entitled: 403 with no challenge", async () => {
      const jws = await kit.sign({ entitlements: { other: true } });
      const res = await send(ROUTES.entitled, kit.headers(jws));
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(((await res.json()) as { code: string }).code).toBe(
        "not_entitled",
      );
    });

    it("sign_in_required: 403 for a key-only device, 200 with a subject", async () => {
      const keyOnly = await kit.sign({});
      const refused = await send(ROUTES.signin, kit.headers(keyOnly));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe(
        "sign_in_required",
      );
      const signedIn = await kit.sign({ user: { subject: SUBJECT } });
      const ok = await send(ROUTES.signin, kit.headers(signedIn));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ subject: SUBJECT });
    });

    it("a passing request reaches the handler with the context, and the answer is private", async () => {
      const jws = await kit.sign({
        tier: "pro",
        entitlements: { "export.pdf": true },
      });
      const res = await send(ROUTES.entitled, kit.headers(jws));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await res.json()).toEqual({ tier: "pro", id: "lic_test" });
    });

    it("a valued entitlement goes through the test", async () => {
      const five = await kit.sign({ entitlements: { seats: 5 } });
      const two = await kit.sign({ entitlements: { seats: 2 } });
      expect((await send(ROUTES.seats, kit.headers(five))).status).toBe(200);
      expect((await send(ROUTES.seats, kit.headers(two))).status).toBe(403);
    });

    it("the refusal speaks the caller's language", async () => {
      const res = await send(ROUTES.entitled, { "Accept-Language": "de" });
      const body = (await res.json()) as { title: string };
      expect(body.title).toBe("Lizenz erforderlich");
    });
  });
}

// Express, over a real socket.
{
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use(
      exp.polarisKey({
        config: kit.config,
        now: kit.clock.now,
        trustRefresh: false,
      }),
    );
    app.get("/open", (_req, res) => void res.json({ ok: true }));
    app.get("/license", exp.requireLicense(), (_req, res) => void res.json({}));
    app.get("/export", exp.requireEntitlement("export.pdf"), (req, res) => {
      const { license } = exp.getPolarisAuth(req);
      res.json({ tier: license!.tier, id: license!.id });
    });
    app.get(
      "/seats",
      exp.requireEntitlement("seats", (v) => v >= 5),
      (_q, res) => void res.json({}),
    );
    app.get("/save", exp.requireSignIn(), (req, res) => {
      res.json({ subject: exp.getPolarisAuth(req).user!.subject });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  await runTable("Express", (path, headers) => fetch(base + path, { headers }));
}

// Hono, through app.request (the same Fetch path as Workers, Bun and Deno).
{
  const app = new Hono<hon.PolarisEnv>();
  beforeAll(() => {
    app.use(
      "/*",
      hon.polarisKey({
        config: kit.config,
        now: kit.clock.now,
        trustRefresh: false,
      }),
    );
    app.get("/open", (c) => c.json({ ok: true }));
    app.get("/license", hon.requireLicense(), (c) => c.json({}));
    app.get("/export", hon.requireEntitlement("export.pdf"), (c) =>
      c.json({
        tier: c.var.polaris.license!.tier,
        id: c.var.polaris.license!.id,
      }),
    );
    app.get(
      "/seats",
      hon.requireEntitlement("seats", (v) => v >= 5),
      (c) => c.json({}),
    );
    app.get("/save", hon.requireSignIn(), (c) =>
      c.json({ subject: c.var.polaris.user!.subject }),
    );
  });
  await runTable("Hono", async (path, headers) =>
    app.request(path, { headers }),
  );
}

// Next.js route handlers, called the way the framework calls them.
{
  let routes: Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
  beforeAll(() => {
    const polaris = createNextPolarisKey({
      config: kit.config,
      now: kit.clock.now,
      trustRefresh: false,
    });
    routes = {
      "/open": async () => Response.json({ ok: true }),
      "/license": polaris.requireLicense(async () => Response.json({})),
      "/export": polaris.requireEntitlement(
        "export.pdf",
        async (_req, { license }) =>
          Response.json({ tier: license.tier, id: license.id }),
      ),
      "/seats": polaris.requireEntitlement(
        "seats",
        async () => Response.json({}),
        (v) => v >= 5,
      ),
      "/save": polaris.requireSignIn(async (_req, { user }) =>
        Response.json({ subject: user!.subject }),
      ),
    };
  });
  await runTable("Next.js", (path, headers) =>
    routes[path]!(new Request("http://localhost" + path, { headers }), {}),
  );
}

describe("customising a refusal", () => {
  it("errors: throw raises a PolarisKeyError into Hono's onError", async () => {
    const app = new Hono<hon.PolarisEnv>();
    app.use(
      "/*",
      hon.polarisKey({
        config: kit.config,
        errors: "throw",
        trustRefresh: false,
        now: kit.clock.now,
      }),
    );
    app.get("/x", hon.requireLicense(), (c) => c.text("ok"));
    app.onError((e, c) =>
      e instanceof PolarisKeyError
        ? c.json({ error: e.problem.code, status: e.status }, e.status)
        : c.text("error", 500),
    );
    const res = await app.request("/x");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "license_required",
      status: 401,
    });
  });

  it("onRefusal answers in the app's own shape in Express", async () => {
    const app = express();
    app.use(
      exp.polarisKey({
        config: kit.config,
        trustRefresh: false,
        now: kit.clock.now,
        onRefusal: (p, _req, res) =>
          void res.status(p.status).json({ error: p.code }),
      }),
    );
    app.get("/x", exp.requireLicense(), (_q, res) => void res.send("ok"));
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "license_required" });
    } finally {
      server.close();
    }
  });

  it("errors: throw goes to Express's error handler", async () => {
    const app = express();
    app.use(
      exp.polarisKey({
        config: kit.config,
        errors: "throw",
        trustRefresh: false,
        now: kit.clock.now,
      }),
    );
    app.get("/x", exp.requireLicense(), (_q, res) => void res.send("ok"));
    app.use(((err, _req, res, _next) => {
      res.status(err.status).json({ kind: err.name, code: err.problem.code });
    }) as express.ErrorRequestHandler);
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`,
      );
      expect(await res.json()).toEqual({
        kind: "PolarisKeyError",
        code: "license_required",
      });
    } finally {
      server.close();
    }
  });

  it("onRefusal and errors work in Next.js", async () => {
    const own = createNextPolarisKey({
      config: kit.config,
      trustRefresh: false,
      now: kit.clock.now,
      onRefusal: (p) => Response.json({ error: p.code }, { status: p.status }),
    });
    const res = await own.requireLicense(async () => new Response("ok"))(
      new Request("http://localhost/x"),
      {},
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "license_required" });
    const thrower = createNextPolarisKey({
      config: kit.config,
      trustRefresh: false,
      errors: "throw",
    });
    await expect(
      thrower.requireLicense(async () => new Response("ok"))(
        new Request("http://localhost/x"),
        {},
      ),
    ).rejects.toBeInstanceOf(PolarisKeyError);
  });

  it("deciding inside the handler: auth() then refuse()", async () => {
    const polaris = createNextPolarisKey({
      config: kit.config,
      trustRefresh: false,
      now: kit.clock.now,
    });
    const req = new Request("http://localhost/x");
    const auth = await polaris.auth(req);
    expect(auth.license).toBeNull();
    expect(polaris.refuse(auth.problem!, req).status).toBe(401);
    expect(polaris.refuse("not_entitled", req).status).toBe(403);
  });

  it("a route a handler gives its own Cache-Control keeps it", async () => {
    const polaris = createNextPolarisKey({
      config: kit.config,
      trustRefresh: false,
      now: kit.clock.now,
    });
    const jws = await kit.sign({});
    const res = await polaris.requireLicense(
      async () =>
        new Response("ok", { headers: { "Cache-Control": "max-age=5" } }),
    )(new Request("http://localhost/x", { headers: kit.headers(jws) }), {});
    expect(res.headers.get("cache-control")).toBe("max-age=5");
  });
});
