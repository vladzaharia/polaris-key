// @pkey-feature core.discover
// D-21 — capability negotiation, and the three ways it can go.
//
//   discovery succeeded   → the document's `services` map is the authority, absent = disabled
//   discovery failed      → the host's `expectServices`
//   nothing configured    → license + config
//
// The one answer that must never appear is "everything is on", so most of this file is about
// what does NOT get enabled: a malformed document, a truthy-but-not-`true` flag, a 404, an
// unreachable origin. Each of those is a route by which a fail-closed gate becomes fail-open.

import { describe, expect, it } from "vitest";
import {
  browserAdapter,
  BrowserAdapter,
} from "../src/browser/browserAdapter.js";
import { parseDiscovery, parseServices } from "../src/browser/discovery.js";
import {
  SERVICE_SLUGS,
  anyBusy,
  copyServices,
  defaultServices,
  firstError,
  noBusy,
  noErrors,
  noServices,
  servicesEqual,
  servicesFromList,
  withBusy,
  withError,
} from "../src/core/services.js";
import { PolarisError } from "../src/core/types.js";
import {
  discoveryBody,
  makeDoc,
  makeFakeFetch,
  NOW_SEC,
  services,
} from "./fixtures.js";

async function ready(adapter: {
  snapshot(): { phase: string };
}): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("service map shape mirrors @polaris-key/node's discovery.ts", () => {
  it("carries exactly the six slugs, in the canonical order", () => {
    // The order is load-bearing: every SDK iterates it rather than a language-native map
    // ordering, so a reorder here silently reorders output everywhere else.
    expect(SERVICE_SLUGS).toEqual([
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
    ]);
    expect(Object.keys(noServices()).sort()).toEqual([...SERVICE_SLUGS].sort());
  });

  it("the no-document default is license + config, never all-true", () => {
    expect(defaultServices()).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    });
  });

  it("servicesFromList enables only what is listed", () => {
    expect(servicesFromList(["update"])).toEqual({
      license: { enabled: false },
      config: { enabled: false },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: true },
      identity: { enabled: false },
    });
    expect(servicesFromList([])).toEqual(noServices());
  });

  it("copyServices is deep — a caller cannot mutate the adapter's map", () => {
    const source = defaultServices();
    const copy = copyServices(source);
    copy.license.enabled = false;
    expect(source.license.enabled).toBe(true);
    expect(servicesEqual(source, defaultServices())).toBe(true);
  });
});

describe("parseServices — fail-closed", () => {
  it("an omitted slug reads as disabled", () => {
    const parsed = parseServices({ license: { enabled: true } });
    expect(parsed?.map.license.enabled).toBe(true);
    expect(parsed?.map.identity.enabled).toBe(false);
    expect(parsed?.map.update.enabled).toBe(false);
  });

  it("`enabled` must be a real boolean — a truthy string does NOT enable", () => {
    const parsed = parseServices({
      license: { enabled: "true" },
      config: { enabled: 1 },
      update: { enabled: "false" },
    });
    expect(parsed?.map.license.enabled).toBe(false);
    expect(parsed?.map.config.enabled).toBe(false);
    expect(parsed?.map.update.enabled).toBe(false);
  });

  it("a non-object services value rejects the document rather than defaulting", () => {
    expect(parseServices("nope")).toBeNull();
    expect(parseServices(null)).toBeNull();
    expect(parseServices({ license: "on" })).toBeNull();
  });

  it("preserves a fragment's endpoints for the UI that wants them", () => {
    const parsed = parseServices({
      identity: { enabled: true, endpoints: { authStart: "/a/auth/start" } },
    });
    expect(parsed?.fragments.identity.endpoints?.authStart).toBe(
      "/a/auth/start",
    );
    // A disabled service publishes NOTHING a client could read its shape out of.
    expect(parsed?.fragments.update).toEqual({ enabled: false });
  });
});

describe("parseDiscovery — document-level guards", () => {
  it("rejects a document for a different product", () => {
    const result = parseDiscovery(
      { product: "other", services: { license: { enabled: true } } },
      "acme",
    );
    expect(result.kind).toBe("invalid");
  });

  it("accepts `slug` as the product identifier", () => {
    const result = parseDiscovery(
      { slug: "acme", services: { config: { enabled: true } } },
      "acme",
    );
    expect(result.kind).toBe("ok");
  });

  it("rejects a document with no services map at all", () => {
    expect(parseDiscovery({ product: "acme" }, "acme").kind).toBe("invalid");
  });
});

describe("BrowserAdapter capability resolution (D-21)", () => {
  it("discovery success installs the honest map", async () => {
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("license", "config", "update"),
      }),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const caps = adapter.snapshot().capabilities;
    expect(caps.update.enabled).toBe(true);
    expect(caps.identity.enabled).toBe(false); // not advertised ⇒ off
    adapter.dispose();
  });

  it("discovery failure falls back to expectServices, not all-true", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/polaris.json")) {
        return new Response("gone", { status: 404 });
      }
      return new Response(JSON.stringify({ authenticated: false, doc: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
      expectServices: services("config", "update"),
    });
    await ready(adapter);
    const caps = adapter.snapshot().capabilities;
    expect(caps.config.enabled).toBe(true);
    expect(caps.update.enabled).toBe(true);
    expect(caps.license.enabled).toBe(false);
    expect(caps.identity.enabled).toBe(false);
    adapter.dispose();
  });

  it("a malformed discovery document does NOT widen capabilities", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/polaris.json")) {
        // `services` present but not a fragment map: the classic almost-valid document.
        return new Response(
          JSON.stringify({
            product: "acme",
            services: ["license", "identity"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ authenticated: false, doc: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
      expectServices: servicesFromList(["config"]),
    });
    await ready(adapter);
    expect(adapter.snapshot().capabilities).toEqual(
      servicesFromList(["config"]),
    );
    adapter.dispose();
  });

  it("no expectServices ⇒ license + config", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().capabilities).toEqual(defaultServices());
    adapter.dispose();
  });

  it("refuses the disabled services' operations instead of calling them", async () => {
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null, {
        capabilities: services("license", "config"),
      }),
      now: () => NOW_SEC,
    }) as BrowserAdapter;
    await ready(adapter);
    // Identity is off ⇒ no OIDC entrypoint to navigate to.
    await expect(adapter.signInWithOidc()).rejects.toMatchObject({
      code: "service-disabled",
    });
    // Update is off ⇒ no version feed to poll.
    await expect(adapter.checkUpdate()).rejects.toMatchObject({
      code: "service-disabled",
    });
    adapter.dispose();
  });

  it("the discovery document is fetched from the product-scoped well-known path", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      if (String(input).includes("polaris.json")) {
        return new Response(discoveryBody(services(), "acme"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ authenticated: false, doc: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      baseUrl: "https://example.test",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(seen).toContain(
      "https://example.test/acme/.well-known/polaris.json",
    );
    adapter.dispose();
  });
});

describe("per-service busy / error maps", () => {
  it("withBusy returns the same reference for a no-op (no re-render churn)", () => {
    const map = noBusy();
    expect(withBusy(map, "license", false)).toBe(map);
    expect(withBusy(map, "license", true)).not.toBe(map);
  });

  it("one service's busy does not read as another's", () => {
    const map = withBusy(noBusy(), "config", true);
    expect(map.config).toBe(true);
    expect(map.identity).toBe(false);
    expect(anyBusy(map)).toBe(true);
    expect(anyBusy(noBusy())).toBe(false);
  });

  it("firstError walks the canonical order", () => {
    const licenseErr = new PolarisError("refresh-failed");
    const identityErr = new PolarisError("sign-out-failed");
    const map = withError(
      withError(noErrors(), "identity", identityErr),
      "license",
      licenseErr,
    );
    expect(firstError(map)).toBe(licenseErr); // license precedes identity
    expect(firstError(noErrors())).toBeNull();
  });
});
