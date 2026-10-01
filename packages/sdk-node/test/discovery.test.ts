// @pkey-feature core.discover
// Product discovery — `GET /<product>/.well-known/polaris.json`, wire contract v3 §2.2/§5.
//
// ── WHAT THIS FILE PINS, AND WHY ────────────────────────────────────────────────────────────
//
// This document is the ONE authority a product publishes about itself. v2's `modules` object
// let four surfaces each re-infer enablement from row presence, so the document could claim a
// capability whose routes 404ed — or deny one that answered. v3 replaces it with a top-level
// `services` map keyed by the service slugs, and the SDK gates its sub-clients on the parse of
// that map (D-21). Everything below therefore protects one of two properties:
//
//   * the FIXTURES ARE THE WORKER'S REAL EMISSION. `packages/worker/src/core/discovery.ts`
//     serves `{version, protocolVersion, schemaVersion, product, slug, name, baseUrl, core,
//     trust, services}` — a fixture that drifted from it would pin this parser against a
//     document nobody serves, which is worse than no test at all.
//   * the PARSE FAILS CLOSED. A slug the document omits reads as disabled; `enabled` must be a
//     real boolean, so the truthy string `"false"` reads as OFF; and a `services` value that is
//     not a map REJECTS the whole document rather than falling back to `DEFAULT_SERVICES`.
//     Silently substituting the permissive default for an unreadable authority is exactly how a
//     fail-closed gate becomes a fail-open one.
//
// The complementary half — what a client believes when it has NO document, and what
// `requireService` does with the answer — lives in `capabilities.test.ts`.
//
// Every `it(...)` of the v2 suite has an heir here: the well-known GET and its stable fields,
// the 404, the product mismatch, and the richer worker-shaped `product:{slug,name}` form.

import { describe, expect, it } from "vitest";
import {
  appcastUrlFrom,
  discoverProduct,
  type DiscoverProductResult,
  type ProductDiscoveryDocument,
} from "../src/discovery.js";

const PRODUCT = "djdl";
const ORIGIN = "https://key.plrs.im";
const BASE = `${ORIGIN}/${PRODUCT}`;

/** Every slug off — the shape a document that advertises nothing parses to. */
const NONE = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: false },
  distribution: { enabled: false },
  update: { enabled: false },
  identity: { enabled: false },
} as const;

/**
 * The Worker's emission, verbatim in shape: `handleDiscovery` builds exactly these top-level
 * keys, and each service fragment is that service's own `discoveryFragment` (license/config
 * shown; release/distribution/update/identity default to the `DISABLED` singleton `{enabled:false}`).
 */
function workerDoc(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    protocolVersion: 3,
    schemaVersion: 4,
    product: PRODUCT,
    slug: PRODUCT,
    name: "DJDL",
    baseUrl: ORIGIN,
    core: {
      registration: "requires-license",
      compat: { min: "1.0.0", max: "2.0.0" },
      endpoints: {
        discovery: `${BASE}/.well-known/polaris.json`,
        jwks: `${BASE}/.well-known/jwks.json`,
        trustManifest: `${BASE}/.well-known/polaris-trust.jws`,
        devices: `${BASE}/devices`,
        report: `${BASE}/devices/report`,
      },
    },
    trust: {
      jwksUrl: `${BASE}/.well-known/jwks.json`,
      trustManifestUrl: `${BASE}/.well-known/polaris-trust.jws`,
      cacheSeconds: 300,
      pinnedKeys: { "pkey-djdl-prod-2026-06": "pub" },
      signingKid: "pkey-djdl-prod-2026-06",
      signingPub: "pub",
      keys: [
        {
          kid: "pkey-djdl-prod-2026-06",
          alg: "EdDSA",
          kty: "OKP",
          crv: "Ed25519",
          publicKey: "pub",
          status: "active",
          active: true,
        },
      ],
    },
    services: {
      license: {
        enabled: true,
        endpoints: {
          activate: `${BASE}/license/activate`,
          enroll: `${BASE}/license/enroll`,
          token: `${BASE}/license/token`,
          deauthorize: `${BASE}/license/deauthorize`,
          document: `${BASE}/license/document`,
        },
      },
      config: {
        enabled: true,
        schemaVersion: 4,
        endpoints: {
          document: `${BASE}/config/document`,
          schema: `${BASE}/config/schema`,
        },
        mint: { available: false },
      },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    },
    ...overrides,
  };
}

/** Update's fragment as `updateService.discoveryFragment` builds it. */
const UPDATE_ON = {
  enabled: true,
  configured: true,
  channels: ["stable", "beta"],
  sparkleEd25519PublicKey: "spub",
  endpoints: {
    version: `${BASE}/update/version`,
    appcast: `${BASE}/update/appcast.xml`,
    channelAppcast: `${BASE}/update/{channel}/appcast.xml`,
  },
  archParameter: ["arm64", "x86_64"],
};

interface Mock {
  impl: typeof fetch;
  calls: Array<{ url: string; signal: AbortSignal | null | undefined }>;
}

/** A fetch returning one canned response. `body` is serialised as JSON unless already a string,
 *  so a "200 with an HTML error page" case can be expressed directly. */
function mockFetch(
  status: number,
  body?: unknown,
  opts: { raw?: string } = {},
): Mock {
  const calls: Mock["calls"] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), signal: init?.signal });
    if (opts.raw !== undefined) return new Response(opts.raw, { status });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Parse one 200 JSON body as `PRODUCT`'s discovery document. */
function parse(
  body: unknown,
  product = PRODUCT,
): Promise<DiscoverProductResult> {
  return discoverProduct({
    baseUrl: ORIGIN,
    product,
    fetchImpl: mockFetch(200, body).impl,
  });
}

/** A fixture that MUST parse — used to build a typed manifest for `appcastUrlFrom`. */
async function manifestOf(
  overrides: Record<string, unknown>,
): Promise<ProductDiscoveryDocument> {
  const res = await parse(workerDoc(overrides));
  if (res.kind !== "ok") {
    throw new Error(`fixture did not parse: ${JSON.stringify(res)}`);
  }
  return res.manifest;
}

// ── The request itself ──────────────────────────────────────────────────────────────────────
// §5: the document lives under the PRODUCT path, and the product is a value the caller supplied
// rather than one this client vouches for.
describe("discoverProduct — the request", () => {
  it("GETs <base>/<product>/.well-known/polaris.json, normalising trailing slashes", async () => {
    const m = mockFetch(200, workerDoc());
    const res = await discoverProduct({
      baseUrl: `${ORIGIN}///`,
      product: PRODUCT,
      fetchImpl: m.impl,
    });

    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.url).toBe(`${BASE}/.well-known/polaris.json`);
    expect(res.kind).toBe("ok");
  });

  it("percent-encodes the product so a slug cannot add a path segment", async () => {
    const m = mockFetch(
      200,
      workerDoc({ product: "../admin", slug: "../admin" }),
    );
    await discoverProduct({
      baseUrl: ORIGIN,
      product: "../admin",
      fetchImpl: m.impl,
    });

    // The separator is encoded, so the traversal stays INSIDE one segment.
    expect(m.calls[0]?.url).toBe(
      `${ORIGIN}/..%2Fadmin/.well-known/polaris.json`,
    );
  });

  it("forwards the caller's AbortSignal so the read carries a deadline (R4-08)", async () => {
    const controller = new AbortController();
    const m = mockFetch(200, workerDoc());
    await discoverProduct({
      baseUrl: ORIGIN,
      product: PRODUCT,
      fetchImpl: m.impl,
      signal: controller.signal,
    });

    expect(m.calls[0]?.signal).toBe(controller.signal);
  });
});

// ── The stable fields ───────────────────────────────────────────────────────────────────────
// The parser validates what the SDK consumes and PRESERVES the rest, so a product publishing
// richer metadata is not rejected by an SDK that predates it (§2.2).
describe("discoverProduct — the typed stable fields", () => {
  it("returns the worker-shaped document's stable fields and the parsed services map", async () => {
    const res = await parse(workerDoc());

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.manifest.product).toBe(PRODUCT);
    expect(res.manifest.name).toBe("DJDL");
    expect(res.manifest.baseUrl).toBe(ORIGIN);
    expect(res.manifest.version).toBe(2);
    expect(res.manifest.protocolVersion).toBe(3);
    expect(res.manifest.schemaVersion).toBe(4);
    // v3 moved the endpoint list off the top level into Core's always-on block (§2.1).
    expect(res.manifest.core?.registration).toBe("requires-license");
    expect(res.manifest.core?.compat).toEqual({ min: "1.0.0", max: "2.0.0" });
    expect(res.manifest.core?.endpoints?.jwks).toBe(
      `${BASE}/.well-known/jwks.json`,
    );
    expect(res.manifest.trust?.pinnedKeys?.["pkey-djdl-prod-2026-06"]).toBe(
      "pub",
    );
    expect(res.manifest.trust?.trustManifestUrl).toBe(
      `${BASE}/.well-known/polaris-trust.jws`,
    );
    // The capability map the caller actually gates on, alongside the raw manifest.
    expect(res.services).toEqual({
      ...NONE,
      license: { enabled: true },
      config: { enabled: true },
    });
  });

  it("accepts the richer worker-shaped product:{slug,name} form", async () => {
    const res = await parse(
      workerDoc({
        product: { slug: PRODUCT, name: "DJDL" },
        trust: { signingKid: "kid", signingPub: "pub" },
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // The nested form is FLATTENED to the slug the SDK compares and routes with.
    expect(res.manifest.product).toBe(PRODUCT);
    expect(res.manifest.trust?.signingKid).toBe("kid");
  });

  it("preserves unknown top-level fields verbatim — the document is allowed to grow", async () => {
    const res = await parse(
      workerDoc({
        sdk: { node: { package: "@polaris-key/node" } },
        onboarding: { steps: ["register", "activate"] },
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.manifest.sdk).toEqual({
      node: { package: "@polaris-key/node" },
    });
    expect(res.manifest.onboarding).toEqual({
      steps: ["register", "activate"],
    });
    // …including the fields the parser does not read at all.
    expect(res.manifest.slug).toBe(PRODUCT);
  });

  it("preserves a service fragment's own contents for the sub-client that wants it", async () => {
    const res = await parse(workerDoc({ services: { update: UPDATE_ON } }));

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.manifest.services.update.channels).toEqual(["stable", "beta"]);
    expect(res.manifest.services.update.sparkleEd25519PublicKey).toBe("spub");
    expect(res.manifest.services.update.endpoints?.version).toBe(
      `${BASE}/update/version`,
    );
  });
});

// ── The v3 services map ─────────────────────────────────────────────────────────────────────
// D-21's fail-closed half, at the parse boundary: absence is DISABLED, `enabled` must be a real
// boolean, and an unreadable `services` value rejects the document instead of degrading to the
// permissive default.
describe("discoverProduct — the v3 services map (D-21)", () => {
  it("expands a partial map into all six slugs, absent ⇒ disabled", async () => {
    const res = await parse(
      workerDoc({
        services: {
          license: {
            enabled: true,
            endpoints: { document: `${BASE}/license/document` },
          },
          config: { enabled: true },
          release: { enabled: false },
        },
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      // Never mentioned by the document at all — and therefore OFF.
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    });
    expect(Object.keys(res.manifest.services).sort()).toEqual([
      "config",
      "distribution",
      "identity",
      "license",
      "release",
      "update",
    ]);
  });

  it("reads a truthy STRING `enabled` as disabled, not as enabled", async () => {
    const res = await parse(
      workerDoc({
        services: {
          license: { enabled: "false" },
          config: { enabled: "true" },
          release: { enabled: 1 },
        },
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // `"false"`, `"true"` and `1` are all truthy or all coercible; none of them is `true`.
    expect(res.services).toEqual(NONE);
    expect(res.manifest.services.config.enabled).toBe(false);
  });

  it("gives a disabled service {enabled:false} and NOTHING else", async () => {
    const res = await parse(
      workerDoc({
        services: {
          license: { enabled: true },
          release: { enabled: false },
        },
      }),
    );

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // Explicitly disabled by the document…
    expect(res.manifest.services.release).toEqual({ enabled: false });
    expect(Object.keys(res.manifest.services.release)).toEqual(["enabled"]);
    expect(res.manifest.services.release.endpoints).toBeUndefined();
    // …and omitted entirely: the parser invents no shape for a service it was not told about.
    expect(res.manifest.services.update).toEqual({ enabled: false });
    expect(Object.keys(res.manifest.services.identity)).toEqual(["enabled"]);
    expect(res.manifest.services.identity.endpoints).toBeUndefined();
  });

  it.each([
    ["an array", []],
    ["a string", "on"],
    ["a number", 1],
    ["null", null],
  ])(
    "rejects the whole document when `services` is %s",
    async (_label, services) => {
      const res = await parse(workerDoc({ services }));

      expect(res.kind).toBe("invalid");
      expect(res.kind === "invalid" ? res.message : "").toContain(
        "map of service fragments",
      );
    },
  );

  it("rejects the whole document when `services` is missing entirely", async () => {
    const doc = workerDoc();
    delete doc.services;
    const res = await parse(doc);

    // NOT "assume the default": an authority that cannot be read is not an authority.
    expect(res.kind).toBe("invalid");
  });

  it("rejects the whole document when one fragment is not an object", async () => {
    const res = await parse(
      workerDoc({ services: { license: { enabled: true }, config: true } }),
    );

    expect(res.kind).toBe("invalid");
  });
});

// ── The failure ladder ──────────────────────────────────────────────────────────────────────
// Four distinguishable outcomes, because a caller treats them differently: `not-found` means
// "this product publishes nothing", `invalid` means "it published something wrong", and `error`
// means "we never found out".
describe("discoverProduct — the failure ladder", () => {
  it("maps a missing well-known document distinctly", async () => {
    const res = await discoverProduct({
      baseUrl: ORIGIN,
      product: PRODUCT,
      fetchImpl: mockFetch(404).impl,
    });

    expect(res).toEqual({ kind: "not-found" });
  });

  it("maps a non-OK status to error with the status and body", async () => {
    const res = await discoverProduct({
      baseUrl: ORIGIN,
      product: PRODUCT,
      fetchImpl: mockFetch(503, undefined, { raw: "upstream unavailable" })
        .impl,
    });

    expect(res).toEqual({
      kind: "error",
      status: 503,
      message: "upstream unavailable",
    });
  });

  it("maps a 200 that is not JSON to invalid", async () => {
    const res = await discoverProduct({
      baseUrl: ORIGIN,
      product: PRODUCT,
      fetchImpl: mockFetch(200, undefined, {
        raw: "<html>captive portal</html>",
      }).impl,
    });

    expect(res.kind).toBe("invalid");
    expect(res.kind === "invalid" ? res.message : "").toContain("valid JSON");
  });

  it("maps a transport throw to error with status 0", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND key.plrs.im");
    }) as unknown as typeof fetch;

    const res = await discoverProduct({
      baseUrl: ORIGIN,
      product: PRODUCT,
      fetchImpl: impl,
    });

    // status 0 is the "never reached the server" sentinel — distinct from any HTTP answer.
    expect(res).toEqual({
      kind: "error",
      status: 0,
      message: "getaddrinfo ENOTFOUND key.plrs.im",
    });
  });

  it("rejects a JSON body that is not an object", async () => {
    expect((await parse([workerDoc()])).kind).toBe("invalid");
    expect((await parse("djdl")).kind).toBe("invalid");
  });

  it("rejects a document with no product at all", async () => {
    const doc = workerDoc();
    delete doc.product;
    delete doc.slug;
    const res = await parse(doc);

    expect(res.kind).toBe("invalid");
    expect(res.kind === "invalid" ? res.message : "").toContain(
      "missing product",
    );
  });

  it("rejects a product mismatch", async () => {
    const res = await parse(workerDoc({ product: "other", slug: "other" }));

    expect(res.kind).toBe("invalid");
    expect(res.kind === "invalid" ? res.message : "").toContain(
      "does not match",
    );
  });

  it("rejects a non-object trust block", async () => {
    expect((await parse(workerDoc({ trust: ["pub"] }))).kind).toBe("invalid");
  });
});

// ── The Sparkle feed URL ────────────────────────────────────────────────────────────────────
// §R1 moved the update paths and left permanent aliases behind, so the feed URL is READ from
// Update's published fragment rather than string-built by the host. The channel is a PATH
// segment, not a query parameter.
describe("appcastUrlFrom", () => {
  it("returns the published stable feed as-is", async () => {
    const doc = await manifestOf({ services: { update: UPDATE_ON } });

    expect(appcastUrlFrom(doc)).toBe(`${BASE}/update/appcast.xml`);
    expect(appcastUrlFrom(doc, { channel: "stable" })).toBe(
      `${BASE}/update/appcast.xml`,
    );
  });

  it("appends ?arch= for a non-default architecture", async () => {
    const doc = await manifestOf({ services: { update: UPDATE_ON } });

    expect(appcastUrlFrom(doc, { arch: "x86_64" })).toBe(
      `${BASE}/update/appcast.xml?arch=x86_64`,
    );
  });

  it("rewrites the PATH — not a query parameter — for a non-stable channel", async () => {
    const doc = await manifestOf({ services: { update: UPDATE_ON } });

    expect(appcastUrlFrom(doc, { channel: "beta" })).toBe(
      `${BASE}/update/beta/appcast.xml`,
    );
    expect(appcastUrlFrom(doc, { channel: "beta", arch: "x86_64" })).toBe(
      `${BASE}/update/beta/appcast.xml?arch=x86_64`,
    );
  });

  it("returns null when Update is disabled or has published no feed", async () => {
    // Omitted ⇒ disabled ⇒ no fragment to read a feed out of.
    const off = await manifestOf({ services: { license: { enabled: true } } });
    expect(appcastUrlFrom(off, { channel: "beta" })).toBeNull();

    // On, but nothing configured yet: `configured:false` publishes no endpoints.
    const unconfigured = await manifestOf({
      services: { update: { enabled: true, configured: false, channels: [] } },
    });
    expect(appcastUrlFrom(unconfigured)).toBeNull();
  });

  it("refuses a feed leaked onto a DISABLED fragment", async () => {
    // The Worker serves `{enabled:false}` and nothing else, but the flag — not the presence of
    // an endpoint — is what decides. A document that carried both must not be usable.
    const leaked = await manifestOf({
      services: { update: { ...UPDATE_ON, enabled: false } },
    });

    expect(leaked.services.update.endpoints?.appcast).toBe(
      `${BASE}/update/appcast.xml`,
    );
    expect(appcastUrlFrom(leaked)).toBeNull();
  });
});
