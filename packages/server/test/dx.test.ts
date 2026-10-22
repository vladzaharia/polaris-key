// The developer-experience surface: the errors a mistake produces, per-route tiers, CORS
// preflight, a custom denial, streaming, Next.js middleware, and ./testing's verdict and fake
// trust helpers. Each adapter runs the same table the way an app's own tests would.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as exp from "../src/express.js";
import * as hon from "../src/hono.js";
import { createNextPolarisKey } from "../src/next.js";
import {
  createPolarisKey,
  isCorsPreflight,
  requirement,
  type BackendRefusalCode,
} from "../src/index.js";
import { createTestKit, type TestKit } from "../src/testing.js";

let kit: TestKit;
beforeAll(async () => {
  kit = await createTestKit({ product: "acme" });
});

const PIN = "A".repeat(43);
const cfg = (over: Record<string, unknown> = {}) => ({
  productSlug: "acme",
  trust: { pinnedKeys: { k: PIN } },
  ...over,
});

describe("a mistake in the options says what to do", () => {
  it("no options, no config", () => {
    expect(() => createPolarisKey(undefined as never)).toThrow(
      /need a config.*pkey sdk --lang node --write/,
    );
    expect(() => createPolarisKey({} as never)).toThrow(/need a config/);
    expect(() => exp.polarisKey(undefined as never)).toThrow(/need a config/);
    expect(() => createPolarisKey({ config: [] })).toThrow(/names no product/);
    expect(() => createPolarisKey({ config: [undefined as never] })).toThrow(
      /config is missing/,
    );
  });
  it("a missing slug names the generated config", () => {
    expect(() =>
      createPolarisKey({ config: cfg({ productSlug: "" }) as never }),
    ).toThrow(/productSlug is missing; pass the object/);
  });
  it("no pins, or a pin that is not a key, fails at startup", () => {
    expect(() =>
      createPolarisKey({ config: cfg({ trust: { pinnedKeys: {} } }) as never }),
    ).toThrow(/pinnedKeys.*is empty/);
    expect(() =>
      createPolarisKey({
        config: cfg({ trust: { pinnedKeys: { k: "nope" } } }) as never,
      }),
    ).toThrow(/pinned key "k".*43 base64url/);
    expect(() => createPolarisKey({ config: cfg() as never })).not.toThrow();
  });
  it("a baseUrl that is not an origin", () => {
    expect(() =>
      createPolarisKey({ config: cfg({ baseUrl: "key.plrs.im" }) as never }),
    ).toThrow(/not an http\(s\) origin/);
  });
  it("a gate before the install middleware says where to add it", async () => {
    const app = express();
    app.get("/x", exp.requireLicense());
    app.use(((err, _req, res, _next) => {
      res.status(500).send(err.message);
    }) as express.ErrorRequestHandler);
    const s = await listen(app);
    try {
      const res = await fetch(`${s.url}/x`);
      expect(await res.text()).toMatch(/app\.use\(polarisKey\(/);
    } finally {
      s.server.close();
    }
    const h = new Hono();
    h.get("/x", hon.requireLicense(), (c) => c.text("ok"));
    const res = await h.request("/x");
    expect(res.status).toBe(500);
  });
});

describe("an unreachable trust fetch", () => {
  it("keeps the pins working and tells the debug sink why", async () => {
    const lines: string[] = [];
    kit.trust.offline = true;
    try {
      const polaris = kit.polarisKey({
        ...kit.trust.options(),
        debug: (l) => lines.push(l),
      });
      const jws = await kit.sign({ entitlements: { x: true } });
      const auth = await polaris.authenticate(kit.headers(jws), {
        require: [requirement.entitlement("x")],
      });
      expect(auth.problem).toBeNull();
      await new Promise((r) => setTimeout(r, 20));
      const failed = lines.find((l) => l.startsWith("trust: fetch failed"));
      expect(failed).toMatch(/TypeError: fetch failed.*pins/);
      expect(lines.join("\n")).not.toContain(jws);
    } finally {
      kit.trust.offline = false;
    }
  });
  it("a wrong baseUrl (404) says so", async () => {
    const lines: string[] = [];
    const polaris = kit.polarisKey({
      trustRefresh: true,
      fetch: async () => new Response("no", { status: 404 }),
      debug: (l) => lines.push(l),
    });
    await polaris.authenticate({});
    await new Promise((r) => setTimeout(r, 20));
    expect(lines.join("\n")).toMatch(/answered 404.*check baseUrl/);
  });
});

describe("./testing: the fake trust service", () => {
  it("a key only the manifest vouches for verifies after the fetch", async () => {
    const k = await createTestKit({ product: "acme" });
    const rotated = await k.trust.addKey("rotated-2027");
    const jws = await rotated.sign({ entitlements: { x: true } });
    const polaris = k.polarisKey(k.trust.options());
    const first = await polaris.authenticate(k.headers(jws));
    // The unknown kid waits for one fetch, then verifies.
    expect(first.problem).toBeNull();
    expect(k.trust.calls.length).toBeGreaterThan(0);
    const without = k.polarisKey();
    expect((await without.authenticate(k.headers(jws))).problem?.code).toBe(
      "license_invalid",
    );
  });
});

describe("./testing: each verdict", () => {
  const route = { require: [requirement.entitlement("export.pdf")] };
  it.each([
    ["license_required", 401],
    ["license_invalid", 401],
    ["license_stale", 401],
    ["not_entitled", 403],
  ] as const)("headersFor(%s) -> %i", async (code, status) => {
    const polaris = kit.polarisKey();
    const auth = await polaris.authenticate(await kit.headersFor(code), route);
    expect(auth.problem?.code).toBe(code);
    expect(auth.problem?.status).toBe(status);
  });
  it("sign_in_required and ok", async () => {
    const polaris = kit.polarisKey();
    const need = await polaris.authenticate(
      await kit.headersFor("sign_in_required"),
      { require: [requirement.signIn()] },
    );
    expect(need.problem?.code).toBe("sign_in_required");
    const ok = await polaris.authenticate(
      await kit.headersFor("ok", {
        entitlements: { "export.pdf": true },
        tier: "pro",
        user: { subject: "ps_" + "A".repeat(22) },
      }),
      {
        require: [requirement.entitlement("export.pdf"), requirement.signIn()],
      },
    );
    expect(ok.problem).toBeNull();
    expect(ok.license?.tier).toBe("pro");
    expect(Object.keys(await kit.signedHeaders())).toEqual([
      "X-PKey-License",
      "X-PKey-Device",
    ]);
  });
});

describe("tiers and requirements", () => {
  it("requirement.tier passes the listed tiers only", async () => {
    const polaris = kit.polarisKey();
    const route = { require: [requirement.tier("pro", "team")] };
    const pro = await kit.signedHeaders({ tier: "team" });
    const free = await kit.signedHeaders({ tier: "free" });
    const none = await kit.signedHeaders();
    expect((await polaris.authenticate(pro, route)).problem).toBeNull();
    expect((await polaris.authenticate(free, route)).problem?.code).toBe(
      "not_entitled",
    );
    expect((await polaris.authenticate(none, route)).problem?.code).toBe(
      "not_entitled",
    );
  });
});

interface Listening {
  server: Server;
  url: string;
}
async function listen(app: express.Express): Promise<Listening> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

type Send = (
  method: string,
  path: string,
  headers?: Record<string, string>,
) => Promise<Response>;

/** The same app, three ways: the paths are identical. */
function suite(
  name: string,
  make: () => Promise<{ send: Send; close(): void }>,
) {
  describe(`${name}: an app's gates`, () => {
    let send: Send;
    let close: () => void;
    beforeAll(async () => {
      ({ send, close } = await make());
    });
    afterAll(() => close());

    it("per-route tiers: pro and team pass, free is refused 403", async () => {
      expect(
        (await send("GET", "/pro", await kit.signedHeaders({ tier: "pro" })))
          .status,
      ).toBe(200);
      const free = await send(
        "GET",
        "/pro",
        await kit.signedHeaders({ tier: "free" }),
      );
      expect(free.status).toBe(403);
      expect((await free.json()).code).toBe("not_entitled");
    });

    it("requireAll checks in order: sign-in, then tier", async () => {
      const h = await kit.signedHeaders({ tier: "pro" });
      const res = await send("GET", "/both", h);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("sign_in_required");
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

    it("a refusal carries the catalog copy, localised", async () => {
      const res = await send("GET", "/pro", {
        "Accept-Language": "de",
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = await res.json();
      expect(body.title).toBe("Lizenz erforderlich");
      expect(body.code).toBe("license_required");
    });

    it("a streamed body arrives whole and private", async () => {
      const res = await send(
        "GET",
        "/stream",
        await kit.signedHeaders({ tier: "pro" }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("onetwothree");
      expect(res.headers.get("cache-control")).toBe("private");
    });

    it("verdicts from the kit reach the app", async () => {
      for (const code of [
        "license_required",
        "license_invalid",
        "license_stale",
      ] as BackendRefusalCode[]) {
        const res = await send("GET", "/pro", await kit.headersFor(code));
        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe(code);
      }
    });
  });
}

const chunks = ["one", "two", "three"];
const stream = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const t of chunks) c.enqueue(enc.encode(t));
      c.close();
    },
  });

suite("Express", async () => {
  const app = express();
  app.use(exp.polarisKey(kit.options()));
  app.get("/pro", exp.requireTier("pro", "team"), (req, res) => {
    res.json({ tier: exp.getPolarisLicense(req).tier });
  });
  app.get(
    "/both",
    exp.requireAll(exp.requirement.signIn(), exp.requirement.tier("pro")),
    (_req, res) => void res.end("ok"),
  );
  app.get("/stream", exp.requireTier("pro"), async (_req, res) => {
    res.type("text/plain");
    for (const t of chunks) {
      res.write(t);
      await new Promise((r) => setTimeout(r, 1));
    }
    res.end();
  });
  app.options("/pro", (_req, res) => void res.sendStatus(204));
  const s = await listen(app);
  return {
    send: (method, path, headers) => fetch(s.url + path, { method, headers }),
    close: () => s.server.close(),
  };
});

suite("Hono", async () => {
  const app = new Hono<hon.PolarisEnv>();
  app.use("*", hon.polarisKey(kit.options()));
  app.get("/pro", hon.requireTier("pro", "team"), (c) =>
    // Typed: no null check on the license behind a gate.
    c.json({ tier: c.var.polaris.license.tier }),
  );
  app.get(
    "/both",
    hon.requireAll(hon.requirement.signIn(), hon.requirement.tier("pro")),
    (c) => c.text("ok"),
  );
  app.get(
    "/stream",
    hon.requireTier("pro"),
    () => new Response(stream(), { headers: { "content-type": "text/plain" } }),
  );
  app.options("/pro", hon.requireLicense(), (c) => c.body(null, 204));
  return {
    send: (method, path, headers) =>
      Promise.resolve(app.request(path, { method, headers })),
    close() {},
  };
});

suite("Next route handlers", async () => {
  const polaris = createNextPolarisKey(kit.options());
  const handlers = {
    "/pro": polaris.requireTier(["pro", "team"], (_req, { license }) =>
      Response.json({ tier: license.tier }),
    ),
    "/both": polaris.requireAll(
      [requirement.signIn(), requirement.tier("pro")],
      () => new Response("ok"),
    ),
    "/stream": polaris.requireTier(
      ["pro"],
      () =>
        new Response(stream(), { headers: { "content-type": "text/plain" } }),
    ),
  } as const;
  // Next gates preflight in middleware; the route exports its own OPTIONS.
  const mw = polaris.middleware({ path: "/pro", require: [] });
  return {
    async send(method, path, headers) {
      const req = new Request(`http://localhost${path}`, { method, headers });
      if (method === "OPTIONS") {
        const early = await mw(req);
        return early ?? new Response(null, { status: 204 });
      }
      return handlers[path as keyof typeof handlers](req, undefined);
    },
    close() {},
  };
});

describe("Next.js middleware", () => {
  const polaris = () =>
    createNextPolarisKey({
      ...kit.options(),
      baseUrl: undefined,
    } as never);
  const req = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) => new Request(`https://app.example${path}`, { method, headers });

  it("with no rules every request needs a license", async () => {
    const mw = polaris().middleware();
    const res = await mw(req("/anything"));
    expect(res?.status).toBe(401);
    expect(
      await mw(req("/anything", await kit.signedHeaders())),
    ).toBeUndefined();
  });

  it("rules: the first match decides; unmatched paths pass", async () => {
    const mw = polaris().middleware([
      { path: "/api/pro/*", require: [requirement.tier("pro")] },
      { path: "/api/*" },
      { path: /^\/admin(\/|$)/, require: [requirement.signIn()] },
    ]);
    const free = await kit.signedHeaders({ tier: "free" });
    expect(await mw(req("/home"))).toBeUndefined();
    expect((await mw(req("/api/pro/x", free)))?.status).toBe(403);
    expect(await mw(req("/api/other", free))).toBeUndefined();
    expect((await mw(req("/api/other")))?.status).toBe(401);
    expect((await mw(req("/admin", free)))?.status).toBe(403);
    expect(
      await mw(req("/api/pro/x", await kit.signedHeaders({ tier: "pro" }))),
    ).toBeUndefined();
    // "/api/pro/*" also matches its own root, and not a lookalike.
    expect((await mw(req("/api/pro", free)))?.status).toBe(403);
    expect(await mw(req("/api/professional", free))).toBeUndefined();
  });

  it("a preflight passes, unless preflight: gate", async () => {
    const pre = {
      origin: "https://x.example",
      "access-control-request-method": "POST",
    };
    expect(
      await polaris().middleware()(req("/api", pre, "OPTIONS")),
    ).toBeUndefined();
    const strict = createNextPolarisKey({
      ...kit.options(),
      preflight: "gate",
    });
    expect(
      (await strict.middleware()(req("/api", pre, "OPTIONS")))?.status,
    ).toBe(401);
  });

  it("a plain OPTIONS (no request-method header) is not a preflight", () => {
    expect(isCorsPreflight("OPTIONS", new Headers())).toBe(false);
    expect(
      isCorsPreflight(
        "options",
        new Headers({ "Access-Control-Request-Method": "GET" }),
      ),
    ).toBe(true);
    expect(
      isCorsPreflight(
        "GET",
        new Headers({ "Access-Control-Request-Method": "GET" }),
      ),
    ).toBe(false);
  });

  it("errors: throw and onRefusal apply to middleware", async () => {
    const throwing = createNextPolarisKey({
      ...kit.options(),
      errors: "throw",
    });
    await expect(throwing.middleware()(req("/x"))).rejects.toMatchObject({
      name: "PolarisKeyError",
      status: 401,
    });
    const custom = createNextPolarisKey({
      ...kit.options(),
      onRefusal: (p) => Response.json({ error: p.code }, { status: 402 }),
    });
    const res = await custom.middleware()(req("/x"));
    expect(res?.status).toBe(402);
    expect(await res?.json()).toEqual({ error: "license_required" });
  });
});

describe("a custom denial", () => {
  it("Express answers 402 with the catalog's copy in the app's own shape", async () => {
    const app = express();
    app.use(
      exp.polarisKey({
        ...kit.options(),
        onRefusal: (problem, _req, res) => {
          res.status(402).json({
            error: problem.body.code,
            title: problem.body.title,
            message: problem.body.detail,
          });
        },
      }),
    );
    app.get(
      "/x",
      exp.requireEntitlement("export.pdf"),
      (_q, r) => void r.end(),
    );
    const s = await listen(app);
    try {
      const res = await fetch(`${s.url}/x`, {
        headers: await kit.headersFor("not_entitled"),
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({
        error: "not_entitled",
        title: "Not included",
        message: "Your license doesn't include this.",
      });
    } finally {
      s.server.close();
    }
  });
  it("Hono's onRefusal returns a Response", async () => {
    const app = new Hono<hon.PolarisEnv>();
    app.use(
      "*",
      hon.polarisKey({
        ...kit.options(),
        onRefusal: (p, c) => c.json({ error: p.code }, 402),
      }),
    );
    app.get("/x", hon.requireEntitlement("export.pdf"), (c) => c.text("ok"));
    const res = await app.request("/x", {
      headers: await kit.headersFor("not_entitled"),
    });
    expect(res.status).toBe(402);
  });
});

describe("Express helpers", () => {
  it("getPolarisLicense on an ungated route says to add a gate", async () => {
    const app = express();
    app.use(exp.polarisKey(kit.options()));
    app.get("/x", (req, res) => {
      try {
        exp.getPolarisLicense(req);
        res.end("ok");
      } catch (e) {
        res.status(500).end((e as Error).message);
      }
    });
    const s = await listen(app);
    try {
      expect(await (await fetch(`${s.url}/x`)).text()).toMatch(
        /requireLicense\(\)/,
      );
    } finally {
      s.server.close();
    }
  });
});
