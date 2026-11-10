// @vitest-environment node
//
// jsdom's cross-realm typed arrays make WebCrypto's Ed25519 verify reject every signature, so a
// page that verifies documents runs in the node environment.

import { describe, expect, it, vi } from "vitest";
import {
  browserAdapter,
  BrowserAdapter,
  InsecureBaseUrlError,
} from "../src/browser/browserAdapter.js";
import {
  PolarisError,
  isSecureTransportUrl,
  type PolarisAdapter,
} from "../src/core/index.js";
import { safeLink } from "../src/kit/links.js";
import {
  fakeWorld,
  makeDoc,
  makeFakeFetch,
  NOW_SEC,
  services,
} from "./fixtures.js";

// The browser adapter drives a device token over the CORS routes and verifies every document in
// the page. These tests drive it directly (no React) with an injected fetch/clock so every path
// is deterministic and offline; `fakeWorld` signs the documents with the pinned fixture key.

/** Resolve once the adapter has left the initial `loading` phase. */
async function ready(
  adapter: ReturnType<typeof browserAdapter>,
): Promise<void> {
  for (let i = 0; i < 200 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("BrowserAdapter — construction + first load", () => {
  it("loads the verified documents and projects an ok snapshot", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const s = adapter.snapshot();
    expect(s.mode).toBe("browser");
    expect(s.phase).toBe("ready");
    expect(s.status).toBe("ok");
    expect(s.config["theme.mode"]).toBe("dark");
    expect(s.activation).toBe("token");
    adapter.dispose();
  });

  it("derives the clock floor from the licence document (§4.2)", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(makeDoc({ issuedAt: 1234 })),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().highWaterMark).toBe(1234);
    adapter.dispose();
  });

  it("a page without a token lands on needs-activation with a null activation", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(null),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("needs-activation");
    expect(adapter.snapshot().activation).toBeNull();
    adapter.dispose();
  });

  it("scopes the document requests under /<product> and sends the bearer", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(makeDoc()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/acme/license/document"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/acme/config/document"))).toBe(true);
    expect(urls.some((u) => u.includes("/identity/session"))).toBe(false);
    adapter.dispose();
  });

  it("uses a custom baseUrl and strips trailing slashes", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      baseUrl: "https://example.test//",
      ...fakeWorld(makeDoc()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("https://example.test/acme/license/document");
    adapter.dispose();
  });

  it("sends the X-PKey-* metadata headers, and none of the withdrawn X-Polaris-* ones", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(makeDoc()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
      version: "1.4.2",
    });
    await ready(adapter);
    const call = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("/license/document"),
    );
    const headers = new Headers((call?.[1] as RequestInit).headers);
    expect(headers.get("x-pkey-platform")).toBe("web");
    expect(headers.get("x-pkey-sdk")).toBe("react");
    expect(headers.get("x-pkey-version")).toBe("1.4.2");
    expect([...headers.keys()].some((k) => k.startsWith("x-polaris-"))).toBe(
      false,
    );
    adapter.dispose();
  });

  it("reports the current device from the verified licence document", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.currentDevice()).toMatchObject({
      id: "dev-1",
      current: true,
      status: "ok",
      licenseId: "lic-1",
    });
    adapter.dispose();
  });
});

describe("BrowserAdapter — the auth option", () => {
  it('refuses "cookie" with invalid-options naming the replacement', () => {
    expect(() =>
      browserAdapter({
        productSlug: "acme",
        auth: "cookie" as unknown as "bearer",
        ...fakeWorld(null),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid-options",
        message: expect.stringMatching(/cookie.*removed.*bearer/),
      }),
    );
    expect(() =>
      browserAdapter({
        productSlug: "acme",
        auth: "magic" as unknown as "bearer",
        ...fakeWorld(null),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-options" }));
  });

  it("accepts bearer and auto", () => {
    for (const auth of ["bearer", "auto"] as const) {
      const adapter = browserAdapter({
        productSlug: "acme",
        auth,
        ...fakeWorld(null),
        autoStart: false,
      });
      expect(adapter.mode).toBe("browser");
      adapter.dispose();
    }
  });
});

// @pkey-feature update.check
describe("BrowserAdapter — update checks", () => {
  const updateWorld = (hostVersion: string, latest = "2.0.0") => {
    const seen: string[] = [];
    const inner = makeFakeFetch(null, {
      capabilities: services("license", "config", "update"),
    });
    const world = fakeWorld(null);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/update/version"))
        return json({ version: latest, tag: `v${latest}`, url: "https://dl" });
      return inner(input, init);
    }) as unknown as typeof fetch;
    return {
      seen,
      adapter: browserAdapter({
        productSlug: "acme",
        version: hostVersion,
        ...world,
        fetchImpl,
        now: () => NOW_SEC,
      }),
    };
  };

  it("calls GET /<product>/update/version and compares the HOST version", async () => {
    const { adapter, seen } = updateWorld("1.0.0");
    await ready(adapter);
    await expect(adapter.checkUpdate({ channel: "beta" })).resolves.toEqual({
      version: "2.0.0",
      tag: "v2.0.0",
      url: "https://dl",
      updateAvailable: true,
    });
    expect(
      seen.some((u) => u.includes("/acme/update/version?channel=beta")),
    ).toBe(true);
    adapter.dispose();
  });

  it("reports no update when the host is already current", async () => {
    const { adapter } = updateWorld("2.0.0");
    await ready(adapter);
    expect((await adapter.checkUpdate()).updateAvailable).toBe(false);
    adapter.dispose();
  });
});

describe("BrowserAdapter — config / secret / entitlement accessors", () => {
  it("getConfig reads the config document, getSecret refuses (config.secret web N/A), isEntitled reflects flags", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.getConfig("theme.mode", "light")).toBe("dark");
    expect(adapter.getConfig("missing", 42)).toBe(42);
    // Secrets ride the config document's `secrets` block and are never projected into state:
    // asking is the typed `config.secret` refusal (P1b-10), never an indistinguishable null.
    expect(() => adapter.getSecret("api.token")).toThrow(
      expect.objectContaining({
        code: "unsupported",
        feature: "config.secret",
        reason: "runtime",
      }),
    );
    expect(adapter.isEntitled("polarisVpn")).toBe(true);
    expect(adapter.isEntitled("beta")).toBe(false);
    adapter.dispose();
  });

  it("exposes mode + the BrowserAdapter class as the factory's product", () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      ...fakeWorld(null),
      now: () => NOW_SEC,
    });
    expect(adapter).toBeInstanceOf(BrowserAdapter);
    expect(adapter.mode).toBe("browser");
    adapter.dispose();
  });
});

describe("BrowserAdapter — baseUrl scheme enforcement", () => {
  const build = (baseUrl: string): PolarisAdapter =>
    browserAdapter({
      productSlug: "acme",
      baseUrl,
      ...fakeWorld(null),
      now: () => NOW_SEC,
    });

  it("refuses a plaintext base URL at CONSTRUCTION, not on the first request", () => {
    // The device token rides every request, so a plaintext control plane is a cleartext
    // credential. It is not worth discovering asynchronously: the same rule `@polaris-key/node`
    // enforces.
    let caught: unknown;
    try {
      build("http://evil.example");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsecureBaseUrlError);
    // It is a PolarisError too, so `e instanceof PolarisError` and `.code` keep working.
    expect(caught).toBeInstanceOf(PolarisError);
    expect((caught as PolarisError).code).toBe("insecure-base-url");
    expect((caught as Error).message).toContain("must be https:");
  });

  it("refuses every other non-https scheme, and anything that is not a URL at all", () => {
    for (const bad of [
      "http://evil.example",
      "http://key.plrs.im.evil.example",
      "http://localhost.evil.example",
      "ftp://key.plrs.im",
      "javascript:fetch('/acme/license/document')",
      "data:text/html,<script>1</script>",
      "//key.plrs.im",
      "key.plrs.im",
      "",
    ]) {
      expect(() => build(bad), bad).toThrow(InsecureBaseUrlError);
    }
  });

  it("accepts https:, and http: on loopback for wrangler dev", async () => {
    for (const good of [
      "https://key.plrs.im",
      "https://example.test",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ]) {
      const adapter = build(good);
      await ready(adapter);
      expect(adapter.mode, good).toBe("browser");
      adapter.dispose();
    }
  });

  it("still strips the trailing slash off an accepted loopback base", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      baseUrl: "http://localhost:8787//",
      ...fakeWorld(makeDoc()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(
      "http://localhost:8787/acme/.well-known/polaris.json",
    );
    adapter.dispose();
  });

  it("shares ONE https-or-loopback rule with the kit's link validator", () => {
    // `isSecureTransportUrl` is the single predicate both surfaces call, so the base URL the
    // token rides over and a link the kit opens cannot drift apart.
    expect(isSecureTransportUrl("https://dl.example/app.dmg")).toBe(true);
    expect(isSecureTransportUrl("http://localhost:8787/app.dmg")).toBe(true);
    expect(isSecureTransportUrl("http://127.0.0.1/app.dmg")).toBe(true);
    expect(isSecureTransportUrl("http://[::1]/app.dmg")).toBe(true);
    expect(isSecureTransportUrl("http://evil.example/app.dmg")).toBe(false);
    expect(isSecureTransportUrl("javascript:alert(1)")).toBe(false);
    expect(isSecureTransportUrl("file:///etc/passwd")).toBe(false);
    expect(isSecureTransportUrl("not a url")).toBe(false);
    for (const url of [
      "https://dl.example/app.dmg",
      "http://localhost:8787/app.dmg",
      "http://evil.example/app.dmg",
      "javascript:alert(1)",
    ]) {
      expect(safeLink(url) !== null, url).toBe(isSecureTransportUrl(url));
    }
    // The kit additionally refuses userinfo, which a base URL never carries either.
    expect(safeLink("https://user:pw@dl.example/")).toBeNull();
  });
});
