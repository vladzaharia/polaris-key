// Core's service dispatch (design spec §5.1, D-02).
//
// The one behaviour worth pinning at this layer is the NEGATIVE one. A disabled service, an
// unregistered slug, and a route that does not exist inside a registered service must be
// indistinguishable from the outside: same status, same body, and the disabled case must not
// run a single line of the service's code. Anything less turns the enablement flag into an
// oracle that maps which products run which services.

import { describe, expect, it } from "vitest";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Product } from "../src/core/products.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../src/fingerprint.js";
import {
  DEFAULT_SERVICES,
  type ServicesMap,
  type ServiceSlug,
} from "../src/core/services.js";
import {
  dispatchService,
  type ServiceContext,
  type ServiceDescriptor,
  type ServiceRegistry,
} from "../src/core/registry.js";

function makeProduct(): Product {
  return {
    slug: "djdl",
    name: "djdl",
    signingKid: "kid",
    signingKeyPem: "pem",
    signingPub: null,
    compatMin: "0.0.0",
    compatMax: "99.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: null,
    schemaVersion: 1,
    fingerprintPolicy: DEFAULT_FINGERPRINT_POLICY,
    autoIssue: DEFAULT_AUTO_ISSUE,
    services: DEFAULT_SERVICES,
    registration: "requires-license",
  };
}

function makeCtx(env: Env, rest: string[] = ["document"]): ServiceContext {
  return {
    req: new Request("https://key.plrs.im/djdl/license/document") as Request,
    env,
    // Dispatch never touches either of these — the point of the suite is what happens BEFORE a
    // descriptor runs — so a stub database and a fixed epoch are enough to satisfy the context.
    db: null as unknown as ServiceContext["db"],
    product: makeProduct(),
    rest,
    now: 1_700_000_000,
  };
}

/** A descriptor that records every call, so "was the service reached at all?" is observable. */
function stub(
  slug: ServiceSlug,
  answer: (ctx: ServiceContext) => Response | null,
): { descriptor: ServiceDescriptor; calls: ServiceContext[] } {
  const calls: ServiceContext[] = [];
  const descriptor: ServiceDescriptor = {
    slug,
    handle: async (ctx) => {
      calls.push(ctx);
      return answer(ctx);
    },
    discoveryFragment: async () => ({ enabled: true }),
  };
  return { descriptor, calls };
}

function registryOf(...descriptors: ServiceDescriptor[]): ServiceRegistry {
  return new Map(descriptors.map((d) => [d.slug, d]));
}

function servicesWith(over: Partial<ServicesMap>): ServicesMap {
  return { ...DEFAULT_SERVICES, ...over };
}

describe("dispatchService", () => {
  it("routes to the descriptor when the service is enabled", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const { descriptor, calls } = stub(
      "license",
      () => new Response("ok", { status: 200 }),
    );

    const res = await dispatchService(
      registryOf(descriptor),
      "license",
      servicesWith({ license: { enabled: true } }),
      makeCtx(env),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("hands the descriptor the remaining path segments", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const { descriptor, calls } = stub(
      "config",
      () => new Response(null, { status: 204 }),
    );

    await dispatchService(
      registryOf(descriptor),
      "config",
      servicesWith({ config: { enabled: true } }),
      makeCtx(env, ["mint", "applemusic", "token"]),
    );

    expect(calls[0]?.rest).toEqual(["mint", "applemusic", "token"]);
    expect(calls[0]?.product.slug).toBe("djdl");
  });

  it("404s a disabled service WITHOUT running it", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const { descriptor, calls } = stub(
      "release",
      () => new Response("secret", { status: 200 }),
    );

    const res = await dispatchService(
      registryOf(descriptor),
      "release",
      servicesWith({ release: { enabled: false } }),
      makeCtx(env),
    );

    expect(res.status).toBe(404);
    // The point of checking the flag before the registry: a disabled service reads no row,
    // writes no audit entry, and consumes no rate-limit token.
    expect(calls).toHaveLength(0);
  });

  it("404s an enabled service with no descriptor registered", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const res = await dispatchService(
      registryOf(),
      "identity",
      servicesWith({ identity: { enabled: true } }),
      makeCtx(env),
    );
    expect(res.status).toBe(404);
  });

  it("404s when the service matched no route inside itself", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const { descriptor, calls } = stub("license", () => null);

    const res = await dispatchService(
      registryOf(descriptor),
      "license",
      servicesWith({ license: { enabled: true } }),
      makeCtx(env, ["no-such-route"]),
    );

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("answers all three not-found causes identically (hide, don't reveal)", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const disabled = await dispatchService(
      registryOf(stub("release", () => new Response("x")).descriptor),
      "release",
      servicesWith({ release: { enabled: false } }),
      makeCtx(env),
    );
    const unregistered = await dispatchService(
      registryOf(),
      "release",
      servicesWith({ release: { enabled: true } }),
      makeCtx(env),
    );
    const noRoute = await dispatchService(
      registryOf(stub("release", () => null).descriptor),
      "release",
      servicesWith({ release: { enabled: true } }),
      makeCtx(env),
    );

    const shapes = await Promise.all(
      [disabled, unregistered, noRoute].map(async (r) => ({
        status: r.status,
        contentType: r.headers.get("content-type"),
        cacheControl: r.headers.get("cache-control"),
        body: await r.text(),
      })),
    );
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it("uses the wire-v3 nested error body", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const res = await dispatchService(
      registryOf(),
      "update",
      servicesWith({ update: { enabled: false } }),
      makeCtx(env),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // WIRE-CONTRACT-V3 §5 / plan R4: `{"error":{"code":…}}`, not the flat v2 `{"error":"…"}`.
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });

  it("404s every service for a product that enables nothing", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    const registry = registryOf(
      ...(
        ["license", "config", "release", "update", "identity"] as ServiceSlug[]
      ).map(
        (slug) =>
          stub(slug, () => new Response("reached", { status: 200 })).descriptor,
      ),
    );
    const allOff: ServicesMap = {
      license: { enabled: false },
      config: { enabled: false },
      release: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    };

    for (const slug of [
      "license",
      "config",
      "release",
      "update",
      "identity",
    ] as ServiceSlug[]) {
      const res = await dispatchService(registry, slug, allOff, makeCtx(env));
      expect(res.status).toBe(404);
    }
  });

  it("survives an enablement set missing the slug entirely (fails closed)", async () => {
    const env = makeEnv(new KvMock(), ["djdl"]);
    // A hand-built map is not something `parseServices` can produce, but dispatch must not
    // throw its way into a 500 if one ever reaches it — absent means off.
    const partial = { license: { enabled: true } } as unknown as ServicesMap;
    const { descriptor, calls } = stub("identity", () => new Response("x"));

    const res = await dispatchService(
      registryOf(descriptor),
      "identity",
      partial,
      makeCtx(env),
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
