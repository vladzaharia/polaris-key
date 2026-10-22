// A gated Fastify, NestJS (on Express and on Fastify) and Koa route answers each §5.2 verdict
// with the right status and problem+json body, as the Express, Hono and Next.js adapters do
// (adapters.test.ts). The verdicts themselves are decided by the shared core, which matrix.test.ts
// runs through conformance/corpus/v2/backend-matrix.json; these tests pin the adapters' wiring.
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import Koa from "koa";
import { Controller, Get, Header, HttpException, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fas from "../src/fastify.js";
import * as koa from "../src/koa.js";
import * as nest from "../src/nestjs.js";
import { PolarisKeyConfigError, PolarisKeyError } from "../src/index.js";
import { createTestKit, type TestKit } from "../src/testing.js";

const SUBJECT = "ps_" + "A".repeat(22);

type Send = (
  method: string,
  path: string,
  headers?: Record<string, string>,
) => Promise<Response>;

let kit: TestKit;
beforeAll(async () => {
  kit = await createTestKit({ product: "acme" });
});

function suite(
  name: string,
  make: () => Promise<{ base: string; close(): Promise<void> | void }>,
) {
  describe(`${name}: the §5.2 verdicts`, () => {
    let send: Send;
    let close: () => Promise<void> | void;
    beforeAll(async () => {
      const s = await make();
      close = s.close;
      send = (method, path, headers) =>
        fetch(s.base + path, { method, headers });
    });
    afterAll(() => close());
    const get = (p: string, h: Record<string, string> = {}) =>
      send("GET", p, h);
    const code = async (res: Response) =>
      ((await res.json()) as { code: string }).code;

    it("an open route needs nothing", async () => {
      expect((await get("/open")).status).toBe(200);
    });

    it("license_required: 401 with the challenge, problem+json and no-store", async () => {
      const res = await get("/export");
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("www-authenticate")).toBe(
        'PKey-License realm="acme", error="license_required"',
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "code",
        "detail",
        "status",
        "title",
        "type",
      ]);
      expect(body).toMatchObject({ status: 401, code: "license_required" });
    });

    it("license_invalid: 401 for a document nobody signed for this product", async () => {
      const other = await createTestKit({ product: "acme" });
      const jws = await other.sign({ entitlements: { "export.pdf": true } });
      const res = await get("/export", kit.headers(jws));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("license_invalid");
    });

    it("license_stale: 401 past expiresAt plus 300 s", async () => {
      const res = await get(
        "/export",
        await kit.headersFor("license_stale", {
          entitlements: { "export.pdf": true },
        }),
      );
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("license_stale");
    });

    it("not_entitled: 403 with no challenge", async () => {
      const res = await get(
        "/export",
        await kit.signedHeaders({ entitlements: { other: true } }),
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await code(res)).toBe("not_entitled");
    });

    it("sign_in_required: 403 for a key-only device, 200 with a subject", async () => {
      const refused = await get("/save", await kit.signedHeaders({}));
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("sign_in_required");
      const ok = await get(
        "/save",
        await kit.signedHeaders({ user: { subject: SUBJECT } }),
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ subject: SUBJECT });
    });

    it("a passing request reaches the handler with the typed license, and the answer is private", async () => {
      const res = await get(
        "/export",
        await kit.signedHeaders({
          tier: "pro",
          entitlements: { "export.pdf": true },
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await res.json()).toEqual({ tier: "pro", id: "lic_test" });
    });

    it("a valued entitlement goes through the test", async () => {
      const five = await kit.signedHeaders({ entitlements: { seats: 5 } });
      const two = await kit.signedHeaders({ entitlements: { seats: 2 } });
      expect((await get("/seats", five)).status).toBe(200);
      expect((await get("/seats", two)).status).toBe(403);
    });

    it("requireTier: pro and team pass, free is refused 403", async () => {
      for (const tier of ["pro", "team"])
        expect(
          (await get("/pro", await kit.signedHeaders({ tier }))).status,
        ).toBe(200);
      const free = await get("/pro", await kit.signedHeaders({ tier: "free" }));
      expect(free.status).toBe(403);
      expect(await code(free)).toBe("not_entitled");
    });

    it("requireAll checks in order: sign-in, then tier", async () => {
      const res = await get("/both", await kit.signedHeaders({ tier: "pro" }));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("sign_in_required");
      const ok = await get(
        "/both",
        await kit.signedHeaders({ tier: "pro", user: { subject: SUBJECT } }),
      );
      expect(ok.status).toBe(200);
    });

    it("a CORS preflight passes the gate", async () => {
      const res = await send("OPTIONS", "/pro", {
        origin: "https://app.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-pkey-license, x-pkey-device",
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("the refusal speaks the caller's language", async () => {
      const res = await get("/export", { "Accept-Language": "de" });
      expect(((await res.json()) as { title: string }).title).toBe(
        "Lizenz erforderlich",
      );
    });

    it("a route whose handler sets its own Cache-Control keeps it", async () => {
      const res = await get("/cached", await kit.signedHeaders({}));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("max-age=5");
    });
  });
}

const opts = () => ({
  config: kit.config,
  now: kit.clock.now,
  trustRefresh: false,
});

function seatsAtLeast5(v: unknown): boolean {
  return typeof v === "number" && v >= 5;
}

// ── Fastify ────────────────────────────────────────────────────────────────────────────────────

async function fastifyApp(
  extra: Partial<fas.PolarisKeyFastifyOptions> = {},
  prepare?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const app = Fastify();
  prepare?.(app);
  await app.register(fas.polarisKey, { ...opts(), ...extra });
  app.get("/open", async () => ({ ok: true }));
  app.get("/license", { preHandler: fas.requireLicense() }, async () => ({}));
  app.get(
    "/export",
    { preHandler: fas.requireEntitlement("export.pdf") },
    async (req) => {
      const license = fas.getPolarisLicense(req);
      return { tier: license.tier, id: license.id };
    },
  );
  app.get(
    "/seats",
    { preHandler: fas.requireEntitlement("seats", seatsAtLeast5) },
    async () => ({}),
  );
  app.get("/save", { preHandler: fas.requireSignIn() }, async (req) => ({
    subject: fas.getPolarisAuth(req).user!.subject,
  }));
  app.get("/pro", { preHandler: fas.requireTier("pro", "team") }, async () => ({
    ok: true,
  }));
  app.get(
    "/both",
    {
      preHandler: fas.requireAll(
        fas.requirement.signIn(),
        fas.requirement.tier("pro"),
      ),
    },
    async () => ({ ok: true }),
  );
  app.get(
    "/cached",
    { preHandler: fas.requireLicense() },
    async (_q, reply) => {
      reply.header("cache-control", "max-age=5");
      return {};
    },
  );
  return app;
}

suite("Fastify", async () => {
  const app = await fastifyApp();
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  return { base, close: () => app.close() };
});

// ── Koa ────────────────────────────────────────────────────────────────────────────────────────

function koaApp(extra: Partial<koa.PolarisKeyKoaOptions> = {}): Koa {
  const app = new Koa();
  app.use(koa.polarisKey({ ...opts(), ...extra }));
  const routes: Record<string, [Koa.Middleware | null, Koa.Middleware]> = {
    "/open": [null, (ctx) => void (ctx.body = { ok: true })],
    "/license": [koa.requireLicense(), (ctx) => void (ctx.body = {})],
    "/export": [
      koa.requireEntitlement("export.pdf"),
      (ctx) => {
        const license = koa.getPolarisLicense(ctx);
        ctx.body = { tier: license.tier, id: license.id };
      },
    ],
    "/seats": [
      koa.requireEntitlement("seats", seatsAtLeast5),
      (ctx) => void (ctx.body = {}),
    ],
    "/save": [
      koa.requireSignIn(),
      (ctx) =>
        void (ctx.body = { subject: koa.getPolarisAuth(ctx).user!.subject }),
    ],
    "/pro": [
      koa.requireTier("pro", "team"),
      (ctx) => void (ctx.body = { ok: true }),
    ],
    "/both": [
      koa.requireAll(koa.requirement.signIn(), koa.requirement.tier("pro")),
      (ctx) => void (ctx.body = { ok: true }),
    ],
    "/cached": [
      koa.requireLicense(),
      (ctx) => {
        ctx.set("Cache-Control", "max-age=5");
        ctx.body = {};
      },
    ],
  };
  // A minimal router: the first middleware is the gate, so the gate sits in the app's chain.
  app.use(async (ctx, next) => {
    const route = routes[ctx.path];
    if (!route) return next();
    const [gate, handler] = route;
    const run = async () => handler(ctx, next);
    return gate ? gate(ctx, run) : run();
  });
  return app;
}

function listenKoa(app: Koa) {
  return new Promise<{ base: string; close(): Promise<void> }>((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () =>
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise((r) => void server.close(() => r())),
      }),
    );
  });
}

suite("Koa", () => listenKoa(koaApp()));

// ── NestJS ─────────────────────────────────────────────────────────────────────────────────────

@Controller()
class AppController {
  @Get("open") open() {
    return { ok: true };
  }
  @Get("license") @nest.RequireLicense() license() {
    return {};
  }
  @Get("export") @nest.RequireEntitlement("export.pdf") exported(
    @nest.GetPolarisLicense() license: { tier: string | null; id: string },
  ) {
    return { tier: license.tier, id: license.id };
  }
  @Get("seats") @nest.RequireEntitlement("seats", seatsAtLeast5) seats() {
    return {};
  }
  @Get("save") @nest.RequireSignIn() save(
    @nest.GetPolarisAuth() auth: { user: { subject: string } | null },
  ) {
    return { subject: auth.user!.subject };
  }
  @Get("pro") @nest.RequireTier("pro", "team") pro() {
    return { ok: true };
  }
  @Get("both")
  @nest.RequireAll(nest.requirement.signIn(), nest.requirement.tier("pro"))
  both() {
    return { ok: true };
  }
  @Get("cached")
  @Header("Cache-Control", "max-age=5")
  @nest.RequireLicense()
  cached(@nest.GetPolarisLicense() _license: unknown) {
    return {};
  }
}

async function nestApp(
  platform: "express" | "fastify",
  extra: Partial<nest.PolarisKeyNestOptions> = {},
) {
  @Module({
    imports: [nest.PolarisKeyModule.register({ ...opts(), ...extra })],
    controllers: [AppController],
  })
  class AppModule {}
  const app =
    platform === "express"
      ? await NestFactory.create(AppModule, new ExpressAdapter(), {
          logger: false,
        })
      : await NestFactory.create(AppModule, new FastifyAdapter(), {
          logger: false,
        });
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  return { app, base: url.replace("[::1]", "127.0.0.1") };
}

for (const platform of ["express", "fastify"] as const)
  suite(`NestJS on ${platform}`, async () => {
    const { app, base } = await nestApp(platform);
    return { base, close: () => app.close() };
  });

// ── Customising a refusal, and the wiring errors ───────────────────────────────────────────────

describe("customising a refusal", () => {
  it("Fastify: onRefusal answers in the app's own shape; errors: throw reaches setErrorHandler", async () => {
    const own = await fastifyApp({
      onRefusal: (p, _req, reply) =>
        reply.code(p.status).send({ error: p.code }),
    });
    const res = await own.inject({ url: "/export" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "license_required" });
    await own.close();

    const thrower = await fastifyApp({ errors: "throw" }, (a) =>
      a.setErrorHandler((err, _req, reply) => {
        reply.code((err as PolarisKeyError).status).send({
          kind: (err as Error).name,
          code: (err as PolarisKeyError).problem.code,
        });
      }),
    );
    const t = await thrower.inject({ url: "/export" });
    expect(t.json()).toEqual({
      kind: "PolarisKeyError",
      code: "license_required",
    });
    await thrower.close();
  });

  it("Koa: onRefusal answers in the app's own shape; errors: throw reaches app.onerror", async () => {
    const own = await listenKoa(
      koaApp({
        onRefusal: (p, ctx) => {
          ctx.status = p.status;
          ctx.body = { error: p.code };
        },
      }),
    );
    const res = await fetch(own.base + "/export");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "license_required" });
    await own.close();

    const app = koaApp({ errors: "throw" });
    const seen: unknown[] = [];
    app.silent = true;
    app.on("error", (e) => void seen.push(e));
    const thrower = await listenKoa(app);
    const t = await fetch(thrower.base + "/export");
    expect(t.status).toBe(401);
    expect(seen[0]).toBeInstanceOf(PolarisKeyError);
    await thrower.close();
  });

  it("NestJS: onRefusal returns the exception to throw", async () => {
    const { app, base } = await nestApp("express", {
      onRefusal: (p) => new HttpException({ error: p.code }, p.status),
    });
    try {
      const res = await fetch(base + "/export");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "license_required" });
    } finally {
      await app.close();
    }
  });

  it("preflight: gate refuses a preflight like any request", async () => {
    const app = await fastifyApp({ preflight: "gate" });
    app.options("/pro", { preHandler: fas.requireTier("pro") }, async () => "");
    const res = await app.inject({
      method: "OPTIONS",
      url: "/pro",
      headers: { "access-control-request-method": "GET" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("a gate used out of order says what to add", () => {
  it("Fastify and Koa: PolarisKeyConfigError names the install", async () => {
    const app = Fastify();
    app.get("/x", { preHandler: fas.requireLicense() }, async () => "ok");
    const res = await app.inject({ url: "/x" });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/register\(polarisKey/);
    await app.close();

    const k = new Koa();
    k.silent = true;
    let error: unknown;
    k.use(async (ctx, next) => {
      try {
        await next();
      } catch (e) {
        error = e;
        ctx.status = 500;
      }
    });
    k.use(koa.requireLicense());
    const s = await listenKoa(k);
    await fetch(s.base + "/x");
    expect(error).toBeInstanceOf(PolarisKeyConfigError);
    expect((error as Error).message).toMatch(/app\.use\(polarisKey\(/);
    await s.close();
  });

  it("getPolarisLicense on an ungated route says to add a gate", async () => {
    const app = Fastify();
    await app.register(fas.polarisKey, opts());
    app.get("/x", async (req) => fas.getPolarisLicense(req));
    const res = await app.inject({ url: "/x" });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toMatch(/requireLicense\(\)/);
    await app.close();
  });

  it("NestJS: a Require* decorator without the module", async () => {
    @Module({ controllers: [AppController] })
    class Bare {}
    const app = await NestFactory.create(Bare, new ExpressAdapter(), {
      logger: false,
    });
    await app.listen(0, "127.0.0.1");
    try {
      const res = await fetch(
        (await app.getUrl()).replace("[::1]", "127.0.0.1") + "/license",
      );
      expect(res.status).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("a bad config stops each adapter at startup", () => {
    expect(() => nest.PolarisKeyModule.register(undefined as never)).toThrow(
      /need a config/,
    );
    expect(() => koa.polarisKey({} as never)).toThrow(/need a config/);
  });
});
