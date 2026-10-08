// @pkey-feature core.errors
// SP-46: the Node library's one error taxonomy and its redaction, one test per acceptance line.
//
//   1. Offline, every network call reports ONE code, `network-error`: activate, enrol, sync,
//      update.check, release (changelog and download), identity (start and poll), devices,
//      distribution, edge-mint, commerce and discovery. A deadline that fires is the same code.
//   2. A 404/429/500/503 matrix over the same calls: `not_found` only for a 404, `rate_limited`
//      with `retryAfterSeconds` for a 429, `server-error` for a 5xx (the server's own code as
//      `wireCode`), and the server's message kept.
//   3. (test/redaction.test.ts) No public result prints or serialises a `pkeyt_` device token.
//   4. `instanceof PolarisError` catches every SDK error: every error class any entry point
//      exports is a `PolarisError`, and every error the matrices raise is one.
//
// Plus the local refusal: `beginSignIn` sends nothing when this session's discovery says Identity
// is off or not set up.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import type { SignInPrompt } from "../src/identity/client.js";
import { InsecureBaseUrlError } from "../src/core/context.js";
import { DeviceManagementUnsupportedError } from "../src/devices/client.js";
import { retryAfterSeconds } from "../src/core/http.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const PINS = {
  "pkey-test-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI",
};
const HELD = `pkeyt_${"H".repeat(43)}`;
const ALL = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
] as const;

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Discovery with every service on and the builds route the download needs. */
const DISCOVERY = {
  product: PRODUCT,
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: {
      enabled: true,
      endpoints: {
        builds: `${BASE}/${PRODUCT}/distribution/builds/{selector}/{buildId}`,
      },
    },
    update: { enabled: true },
    identity: { enabled: true },
  },
};

type Route = (path: string, method: string) => Response | Promise<Response>;

async function makeClient(
  route: Route,
  opts: { token?: boolean; requestTimeoutMs?: number } = {},
): Promise<{ client: PolarisKeyClient; calls: string[] }> {
  const calls: string[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    return route(url.pathname, method);
  }) as typeof fetch;
  const store = new InMemoryStore(PRODUCT);
  if (opts.token !== false) await store.setToken(HELD);
  const client = await PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: PINS },
    store,
    fetchImpl,
    requestTimeoutMs: opts.requestTimeoutMs ?? 0,
    deviceName: "",
    stateDir: mkdtempSync(join(tmpdir(), "pkey-sp46-")),
    expectedServices: [...ALL],
    license: { fingerprint: false },
    devices: { fingerprint: false },
  });
  return { client, calls };
}

/** What one call reported: a thrown `PolarisError`'s fields, or a result's. */
interface Seen {
  thrown: boolean;
  /** The code (or, for an outcome with none, its kind). */
  code: string;
  status?: number;
  retryAfterSeconds?: number;
  wireCode?: string;
  message?: string;
}

const PROMPT = {
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  verificationUri: `${BASE}/${PRODUCT}/identity/auth/device`,
  verificationUriComplete: `${BASE}/${PRODUCT}/identity/auth/device?user_code=ABCD-EFGH`,
  expiresIn: 600,
  interval: 5,
  expiresAt: Number.MAX_SAFE_INTEGER,
  deviceName: null,
} satisfies SignInPrompt;

const RECORD = {
  record: {
    version: "1.0.0",
    builds: [
      {
        id: "linux-x64",
        platform: "linux",
        arch: "x86_64",
        artifacts: [{ role: "payload", sha256: "a".repeat(64), size: 10 }],
      },
    ],
  } as never,
  buildId: "linux-x64",
};

/** Every network call of the library, each with the path it dials and how it reports. */
const CALLS: {
  name: string;
  path: string;
  run: (c: PolarisKeyClient) => Promise<Seen>;
}[] = [
  {
    name: "license.activateWithKey",
    path: "/license/activate",
    run: async (c) => outcome(await c.license.activateWithKey("pkey_djdl_x")),
  },
  {
    name: "license.enroll",
    path: "/license/enroll",
    run: async (c) => outcome(await c.license.enroll()),
  },
  {
    name: "sync",
    path: "/license/document",
    run: async (c) => {
      const doc = (await c.sync()).documents.license!;
      return doc.kind === "error"
        ? {
            thrown: false,
            code: doc.code,
            ...(doc.status !== undefined ? { status: doc.status } : {}),
          }
        : { thrown: false, code: doc.kind };
    },
  },
  {
    name: "update.check",
    path: "/update/version",
    run: (c) => thrown(c.update.check()),
  },
  {
    name: "release.changelog",
    path: "/release/changelog",
    run: (c) => thrown(c.release.changelog()),
  },
  {
    name: "release.fetch",
    path: "/distribution/builds/",
    run: (c) =>
      thrown(
        c.release.fetch(RECORD, {
          to: join(mkdtempSync(join(tmpdir(), "pkey-sp46-dl-")), "app.bin"),
        }),
      ),
  },
  {
    name: "identity.beginSignIn",
    path: "/identity/auth/device/start",
    run: (c) => thrown(c.identity.beginSignIn()),
  },
  {
    name: "identity.pollSignIn",
    path: "/identity/auth/device/poll",
    run: async (c) => {
      try {
        const poll = await c.identity.pollSignIn(PROMPT);
        return {
          thrown: false,
          code: poll.status,
          ...(poll.status === "error" ? { message: poll.message } : {}),
        };
      } catch (e) {
        return fromError(e);
      }
    },
  },
  {
    name: "devices.list",
    path: "/devices",
    run: (c) => thrown(c.devices.list()),
  },
  {
    name: "devices.register",
    path: "/devices/register",
    run: async (c) => {
      const r = await c.devices.register();
      if (r.kind === "error")
        return {
          thrown: false,
          code: r.code,
          ...(r.status !== undefined ? { status: r.status } : {}),
          message: r.message,
        };
      return {
        thrown: false,
        code: r.kind,
        ...(r.kind === "rate-limited" && r.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: r.retryAfterSeconds }
          : {}),
      };
    },
  },
  {
    name: "distribution.downloadModel",
    path: "/distribution/download.json",
    run: (c) => thrown(c.distribution.downloadModel()),
  },
  {
    name: "config.mintToken",
    path: "/config/mint/recipe/token",
    run: (c) => thrown(c.config.mintToken("recipe")),
  },
  {
    name: "commerce.binding",
    path: "/distribution/commerce/binding",
    run: async (c) => {
      const r = await c.commerce.binding();
      if (r.kind === "ok") return { thrown: false, code: "ok" };
      return {
        thrown: false,
        code: r.code,
        ...(r.status > 0 ? { status: r.status } : {}),
        ...(r.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: r.retryAfterSeconds }
          : {}),
        ...(r.wireCode !== undefined ? { wireCode: r.wireCode } : {}),
        message: r.message,
      };
    },
  },
  {
    name: "discover",
    path: "/.well-known/polaris.json",
    run: async (c) => {
      const r = await c.discover();
      return r.kind === "error"
        ? { thrown: false, code: r.code, status: r.status, message: r.message }
        : { thrown: false, code: r.kind };
    },
  },
];

function outcome(r: {
  kind: string;
  code?: string;
  status?: number;
  message?: string;
  retryAfterSeconds?: number;
  wireCode?: string;
}): Seen {
  return {
    thrown: false,
    code: r.code ?? r.kind,
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: r.retryAfterSeconds }
      : {}),
    ...(r.wireCode !== undefined ? { wireCode: r.wireCode } : {}),
    ...(r.message !== undefined && r.message !== ""
      ? { message: r.message }
      : {}),
  };
}

function fromError(e: unknown): Seen {
  // Acceptance 4, behaviourally: nothing raw escapes a network call.
  expect(e).toBeInstanceOf(PolarisError);
  const p = e as PolarisError;
  return {
    thrown: true,
    code: p.code,
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(p.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: p.retryAfterSeconds }
      : {}),
    ...(p.wireCode !== undefined ? { wireCode: p.wireCode } : {}),
    message: p.message,
  };
}

async function thrown(p: Promise<unknown>): Promise<Seen> {
  try {
    await p;
  } catch (e) {
    return fromError(e);
  }
  throw new Error("expected the call to throw");
}

describe("SP-46 acceptance 1: offline, one code everywhere", () => {
  const offline: Route = () => {
    throw new TypeError("fetch failed");
  };

  it.each(CALLS)("$name reports network-error", async ({ run }) => {
    const { client } = await makeClient(offline);
    const seen = await run(client);
    client.close();
    expect(seen.code).toBe("network-error");
    if (seen.thrown) {
      expect(seen.message).toContain("fetch failed");
      expect(seen.status).toBeUndefined();
    }
  });

  it("is one code across the whole surface, with the transport failure as the cause", async () => {
    const codes = new Set<string>();
    for (const { run } of CALLS) {
      const { client } = await makeClient(offline);
      codes.add((await run(client)).code);
      client.close();
    }
    expect([...codes]).toEqual(["network-error"]);
    const { client } = await makeClient(offline);
    const e = await client.update.check().catch((x: unknown) => x);
    client.close();
    expect(e).toBeInstanceOf(PolarisError);
    expect((e as Error).cause).toBeInstanceOf(TypeError);
  });

  it("a deadline that fires is network-error too", async () => {
    // The fetch never answers; it rejects only when the client's deadline aborts it.
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as typeof fetch;
    const store = new InMemoryStore(PRODUCT);
    await store.setToken(HELD);
    const client = await PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.0.0",
      trust: { pinnedKeys: PINS },
      store,
      fetchImpl,
      requestTimeoutMs: 20,
      deviceName: "",
      stateDir: mkdtempSync(join(tmpdir(), "pkey-sp46-")),
      expectedServices: [...ALL],
      license: { fingerprint: false },
    });
    await expect(client.update.check()).rejects.toMatchObject({
      code: "network-error",
    });
    expect(await client.license.activateWithKey("pkey_djdl_x")).toMatchObject({
      kind: "error",
      code: "network-error",
    });
    expect((await client.sync()).documents.license).toMatchObject({
      kind: "error",
      code: "network-error",
    });
    client.close();
  });
});

// ── 2. The status matrix ──────────────────────────────────────────────────────────────────────

const ANSWERS: Record<number, () => Response> = {
  404: () =>
    json({ error: { code: "not_found", message: "no such thing here" } }, 404),
  429: () =>
    json({ error: { code: "rate_limited" } }, 429, { "retry-after": "7" }),
  500: () =>
    json(
      { error: "misconfigured", message: "custom oidc config missing" },
      500,
    ),
  503: () =>
    new Response("upstream unavailable", {
      status: 503,
      headers: { "retry-after": "30" },
    }),
};

/** Where a call's answer deviates from the plain taxonomy, by contract. */
const EXPECTED: Record<string, Partial<Record<number, string>>> = {
  // §5's document ladder: a 429 on a signed document is the device cap.
  sync: { 429: "device-cap" },
  // RFC 8628 §3.5: a 429 on a poll is `slow_down`; any other refusal is a poll status.
  "identity.pollSignIn": { 404: "error", 429: "slow-down" },
  // The registration ladder: 404 is "registration is not set up", 429 its own kind.
  "devices.register": { 404: "not-configured", 429: "rate-limited" },
  // Discovery's own kind for an unregistered product.
  discover: { 404: "not-found" },
};

const TAXONOMY: Record<number, string> = {
  404: "not_found",
  429: "rate_limited",
  500: "server-error",
  503: "server-error",
};

describe("SP-46 acceptance 2: the 404/429/500/503 matrix", () => {
  for (const call of CALLS) {
    for (const status of [404, 429, 500, 503]) {
      it(`${call.name} ← ${status}`, async () => {
        const { client, calls } = await makeClient((path) => {
          if (
            call.path !== "/.well-known/polaris.json" &&
            path.endsWith("/.well-known/polaris.json")
          )
            return json(DISCOVERY);
          if (path.includes(call.path)) return ANSWERS[status]!();
          return new Response("", { status: 404 });
        });
        const seen = await call.run(client);
        client.close();
        expect(
          calls.some((c) => c.includes(call.path)),
          "the call dialled its route",
        ).toBe(true);
        const want = EXPECTED[call.name]?.[status] ?? TAXONOMY[status]!;
        expect(seen.code).toBe(want);
        if (want !== TAXONOMY[status]) return;
        // The fields beside the code, wherever the call reports them.
        if (status === 429 && call.name !== "discover")
          expect(seen.retryAfterSeconds).toBe(7);
        if (status === 503 && seen.thrown)
          expect(seen.retryAfterSeconds).toBe(30);
        if (status >= 500) expect(seen.status).toBe(status);
        if (seen.thrown || seen.message !== undefined) {
          // The server's message, never a generic one, when its body had one.
          if (status === 404) expect(seen.message).toBe("no such thing here");
          if (status === 500)
            expect(seen.message).toBe("custom oidc config missing");
          if (status === 503) expect(seen.message).toBe("upstream unavailable");
        }
        if (status === 500 && seen.thrown)
          expect(seen.wireCode).toBe("misconfigured");
      });
    }
  }

  it("a 404 is the only status that is not_found", async () => {
    for (const call of CALLS.filter((c) => !EXPECTED[c.name])) {
      for (const status of [400, 409, 410, 500, 502, 503, 504]) {
        const { client } = await makeClient((path) => {
          if (path.endsWith("/.well-known/polaris.json"))
            return json(DISCOVERY);
          return path.includes(call.path)
            ? json({}, status)
            : new Response("", { status: 404 });
        });
        const seen = await call.run(client);
        client.close();
        expect(seen.code, `${call.name} ← ${status}`).not.toBe("not_found");
      }
    }
  });

  it("Retry-After is read as seconds or as an HTTP date", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(retryAfterSeconds("7", now)).toBe(7);
    expect(retryAfterSeconds("1.2", now)).toBe(2);
    expect(retryAfterSeconds("Thu, 08 Oct 2026 12:01:30 GMT", now)).toBe(90);
    expect(retryAfterSeconds("Thu, 08 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds("soon", now)).toBeUndefined();
    expect(retryAfterSeconds(null, now)).toBeUndefined();
  });
});

// ── 4. One error type ─────────────────────────────────────────────────────────────────────────

/** Every module a host can import (package.json `exports`), less the preload, which is the one
 *  entry that imports `electron` itself. */
const ENTRY_POINTS = [
  "../src/index.js",
  "../src/core/index.js",
  "../src/license/index.js",
  "../src/config/index.js",
  "../src/devices/index.js",
  "../src/identity/client.js",
  "../src/release/client.js",
  "../src/update/client.js",
  "../src/packs/index.js",
  "../src/local/index.js",
  "../src/cli/index.js",
  "../src/cli/term/index.js",
  "../src/commerce/index.js",
  "../src/distribution/client.js",
  "../src/qr/index.js",
  "../src/server.js",
  "../src/electron/index.js",
  "../src/electron/renderer.js",
  "../src/update/drivers/index.js",
  "../src/update/drivers/electronUpdater.js",
  "../src/update/drivers/velopack.js",
  "../src/update/drivers/sea.js",
  "../src/update/drivers/storeLink.js",
];

describe("SP-46 acceptance 4: instanceof PolarisError catches every SDK error", () => {
  it("every error class an entry point exports is a PolarisError", async () => {
    const errorClasses: string[] = [];
    const strays: string[] = [];
    for (const entry of ENTRY_POINTS) {
      const mod = (await import(entry)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        const proto = (value as { prototype?: unknown }).prototype;
        if (!(proto instanceof Error)) continue;
        errorClasses.push(name);
        if (!(proto instanceof PolarisError) && value !== PolarisError)
          strays.push(`${entry}: ${name}`);
      }
    }
    expect(strays).toEqual([]);
    // The scan saw the classes it is about.
    for (const name of [
      "InsecureBaseUrlError",
      "DeviceManagementUnsupportedError",
      "UnsupportedError",
      "UpdateError",
      "PackError",
      "PolarisBridgeError",
    ])
      expect(errorClasses).toContain(name);
  });

  it("the two classes that were plain Errors carry their registry codes", async () => {
    let caught: unknown;
    try {
      new PolarisKeyClient({
        productSlug: PRODUCT,
        baseUrl: "http://example.com",
        trust: { pinnedKeys: PINS },
        store: new InMemoryStore(PRODUCT),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PolarisError);
    expect(caught).toBeInstanceOf(InsecureBaseUrlError);
    expect(caught).toMatchObject({
      code: "insecure-base-url",
      name: "InsecureBaseUrlError",
    });

    const { client, calls } = await makeClient(() => json({}), {
      token: false,
    });
    const e = await client.devices.list().catch((x: unknown) => x);
    client.close();
    expect(e).toBeInstanceOf(PolarisError);
    expect(e).toBeInstanceOf(DeviceManagementUnsupportedError);
    expect(e).toMatchObject({ code: "device-management-unsupported" });
    expect(calls).toEqual([]);
  });

  it("a 200 the call cannot read is bad_response, not a raw SyntaxError", async () => {
    const garbage: Route = () =>
      new Response("<html>captive portal</html>", { status: 200 });
    for (const call of [
      "update.check",
      "release.changelog",
      "devices.list",
      "distribution.downloadModel",
    ]) {
      const { client } = await makeClient(garbage);
      const seen = await CALLS.find((c) => c.name === call)!.run(client);
      client.close();
      expect(seen, call).toMatchObject({ thrown: true, code: "bad_response" });
    }
    const { client } = await makeClient(garbage);
    expect(await client.license.activateWithKey("pkey_djdl_x")).toMatchObject({
      kind: "error",
      code: "bad_response",
    });
    client.close();
  });
});

// ── The local refusal ─────────────────────────────────────────────────────────────────────────

describe("SP-46: beginSignIn refuses locally when discovery says Identity is off", () => {
  async function withIdentity(identity: Record<string, unknown>) {
    const doc = {
      ...DISCOVERY,
      services: { ...DISCOVERY.services, identity },
    };
    const made = await makeClient((path) =>
      path.endsWith("/.well-known/polaris.json")
        ? json(doc)
        : new Response("", { status: 500 }),
    );
    await made.client.discover();
    made.calls.length = 0;
    return made;
  }

  it("off: service-unavailable, no request", async () => {
    const { client, calls } = await withIdentity({ enabled: false });
    await expect(client.identity.beginSignIn()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    client.close();
    expect(calls).toEqual([]);
  });

  it("on but not set up: the Worker's own `disabled`, no request", async () => {
    const { client, calls } = await withIdentity({
      enabled: true,
      configured: false,
    });
    const e = await client.identity.beginSignIn().catch((x: unknown) => x);
    client.close();
    expect(e).toBeInstanceOf(PolarisError);
    expect(e).toMatchObject({ code: "disabled" });
    expect(calls).toEqual([]);
  });

  it("set up: the request goes out", async () => {
    const { client, calls } = await withIdentity({
      enabled: true,
      configured: true,
    });
    await expect(client.identity.beginSignIn()).rejects.toMatchObject({
      code: "server-error",
    });
    client.close();
    expect(calls).toEqual(["POST /djdl/identity/auth/device/start"]);
  });
});

// ── lastVerifiedAt is milliseconds (client-core's comment, corrected) ─────────────────────────

describe("SP-46: lastVerifiedAt is epoch milliseconds", () => {
  it("a 304 sync marks it at Date.now(), not in seconds", async () => {
    const { client } = await makeClient((path) =>
      path.endsWith("/license/document") || path.endsWith("/config/document")
        ? new Response(null, { status: 304 })
        : new Response("", { status: 404 }),
    );
    const before = Date.now();
    await client.sync();
    const at = client.getSyncState().lastVerifiedAt;
    client.close();
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(before);
    expect(at!).toBeLessThanOrEqual(Date.now());
  });
});
