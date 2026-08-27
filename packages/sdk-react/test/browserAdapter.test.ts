import { describe, expect, it, vi } from "vitest";
import {
  browserAdapter,
  BrowserAdapter,
  splitSessionDoc,
} from "../src/browser/browserAdapter.js";
import {
  discoveryBody,
  fuse,
  makeConfig,
  makeDoc,
  makeFakeFetch,
  NOW_SEC,
  services,
} from "./fixtures.js";

// The browser adapter is a cookie-session transport. These tests drive it directly (no
// React) with an injected fetch/navigate/clock so every path is deterministic and offline.
// The routes are the §R1 identity homes; the response shapes are unchanged.

/** Resolve once the adapter has left the initial `loading` phase. */
async function ready(
  adapter: ReturnType<typeof browserAdapter>,
): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A fetch that answers discovery + one canned session body. */
function fetchWith(
  session: (url: string) => Response | null,
  capabilities = services(),
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/.well-known/polaris.json")) {
      return new Response(discoveryBody(capabilities), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return session(url) ?? new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("BrowserAdapter — construction + first load", () => {
  it("loads the session and projects the documents to an ok snapshot", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const s = adapter.snapshot();
    expect(s.mode).toBe("browser");
    expect(s.phase).toBe("ready");
    expect(s.status).toBe("ok");
    expect(s.config["theme.mode"]).toBe("dark");
    // The cookie session stands in for the per-device token (§5).
    expect(s.activation).toBe("token");
    adapter.dispose();
  });

  it("derives the clock floor from the session document (§4.2)", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc({ issuedAt: 1234 })),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().highWaterMark).toBe(1234);
    adapter.dispose();
  });

  it("an unauthenticated session lands on needs-activation with a null activation", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("needs-activation");
    expect(adapter.snapshot().activation).toBeNull();
    adapter.dispose();
  });

  it("scopes the session request under /<product>/identity (§R1)", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/acme/identity/session"))).toBe(true);
    adapter.dispose();
  });

  it("uses a custom baseUrl and strips trailing slashes", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      baseUrl: "https://example.test//",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("https://example.test/acme/identity/session");
    adapter.dispose();
  });

  it("sends the X-PKey-* metadata headers, and none of the withdrawn X-Polaris-* ones", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
      version: "1.4.2",
    });
    await ready(adapter);
    const call = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("/identity/session"),
    );
    const headers = (call?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["X-PKey-Platform"]).toBe("browser");
    expect(headers["X-PKey-SDK"]).toBe("@polaris-key/react");
    expect(headers["X-PKey-Version"]).toBe("1.4.2");
    expect(Object.keys(headers).some((k) => k.startsWith("X-Polaris-"))).toBe(
      false,
    );
    adapter.dispose();
  });

  it("reports the current device from the verified session document", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.currentDevice()).toMatchObject({
      id: "dev-1",
      current: true,
      status: "ok",
      licenseId: "lic-1",
    });
    // A cookie session holds no bearer token, so remote device management is unreachable.
    await expect(adapter.listDevices()).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    await expect(adapter.renameDevice("dev-1", "x")).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    await expect(adapter.deauthorizeDevice("other")).rejects.toMatchObject({
      code: "device-management-unsupported",
    });
    adapter.dispose();
  });
});

describe("splitSessionDoc — the fused artifact becomes the v3 pair", () => {
  it("routes entitlements to the license half and config to the config half (D-20)", () => {
    const docs = splitSessionDoc(
      fuse(makeDoc(), makeConfig()) as unknown as Parameters<
        typeof splitSessionDoc
      >[0],
    );
    expect(docs.license?.licenseId).toBe("lic-1");
    expect(docs.license?.entitlements.polarisVpn?.value).toBe(true);
    expect(docs.config["theme.mode"]?.value).toBe("dark");
    // The claims envelope is shared, so the gate sees the same window either way.
    expect(docs.license?.graceUntil).toBe(1000 + 30 * 86400);
  });

  it("a null document is an empty pair, not a throw", () => {
    expect(splitSessionDoc(null)).toEqual({ license: null, config: {} });
  });
});

describe("BrowserAdapter — signInWithOidc redirect", () => {
  it("navigates to the identity auth entrypoint with a return_to and never returns a handle", async () => {
    const navigate = vi.fn();
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      navigate,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const handle = await adapter.signInWithOidc();
    expect(handle).toBeUndefined();
    expect(navigate).toHaveBeenCalledTimes(1);
    const target = navigate.mock.calls[0]?.[0] as string;
    expect(target).toContain("/acme/identity/auth/start?return_to=");
    adapter.dispose();
  });
});

describe("BrowserAdapter — submitKey", () => {
  it("posts a license key to the identity session route and refreshes the session", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await adapter.submitKey("pkey_acme_test");
    const call = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("/identity/session/license"),
    );
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({ key: "pkey_acme_test" });
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("surfaces rejected keys as sign-in-failed on the LICENSE slice", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchWith((url) =>
        url.includes("/identity/session/license")
          ? json({ error: "unauthorized" }, 401)
          : json({ authenticated: false, doc: null }),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.submitKey("bad")).rejects.toMatchObject({
      code: "sign-in-failed",
      message: "That key was not accepted.",
    });
    expect(adapter.snapshot().error.license?.code).toBe("sign-in-failed");
    // The identity slice is untouched — a bad key is not a broken sign-in service.
    expect(adapter.snapshot().error.identity).toBeNull();
    adapter.dispose();
  });

  it("humanizes a device-limit 403", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchWith((url) =>
        url.includes("/identity/session/license")
          ? json({ error: { code: "device_limit" } }, 403)
          : json({ authenticated: false, doc: null }),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.submitKey("k")).rejects.toMatchObject({
      message: "This license has reached its device limit.",
    });
    adapter.dispose();
  });
});

describe("BrowserAdapter — signOut", () => {
  it("posts logout (echoing CSRF) and resets to needs-activation", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await adapter.signOut();
    const s = adapter.snapshot();
    expect(s.status).toBe("needs-activation");
    expect(s.activation).toBeNull();
    expect(s.profile).toBeNull();
    expect(s.config).toEqual({});
    const logoutCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("/identity/auth/logout"),
    );
    expect(logoutCall).toBeTruthy();
    const init = logoutCall?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "csrf-1",
    );
    adapter.dispose();
  });

  it("treats a 401 logout as success (already signed out)", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchWith((url) =>
        url.includes("/identity/session")
          ? json({
              authenticated: true,
              doc: fuse(makeDoc(), makeConfig()),
              csrfToken: "c",
            })
          : new Response(null, { status: 401 }),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.signOut()).resolves.toBeUndefined();
    expect(adapter.snapshot().status).toBe("needs-activation");
    adapter.dispose();
  });

  it("surfaces a non-401 logout failure as sign-out-failed on the IDENTITY slice", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchWith((url) =>
        url.includes("/identity/session")
          ? json({ authenticated: true, doc: fuse(makeDoc(), makeConfig()) })
          : new Response("nope", { status: 500 }),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.signOut()).rejects.toMatchObject({
      code: "sign-out-failed",
    });
    expect(adapter.snapshot().error.identity?.code).toBe("sign-out-failed");
    expect(adapter.snapshot().error.license).toBeNull();
    adapter.dispose();
  });
});

describe("BrowserAdapter — 401 / refresh handling", () => {
  it("a hard 401 after a live session ⇒ revoked", async () => {
    let authed = true;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchWith((url) => {
        if (!url.includes("/identity/session")) return null;
        return authed
          ? json({
              authenticated: true,
              doc: fuse(makeDoc(), makeConfig()),
              csrfToken: "c",
            })
          : new Response(null, { status: 401 });
      }),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("ok");
    authed = false;
    await adapter.refresh();
    expect(adapter.snapshot().status).toBe("revoked");
    adapter.dispose();
  });

  it("a 401 with no prior session stays needs-activation (not revoked)", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await adapter.refresh();
    expect(adapter.snapshot().status).toBe("needs-activation");
    adapter.dispose();
  });

  it("a non-ok, non-401 session response surfaces a network error on first load", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().error.identity?.code).toBe("network");
    expect(adapter.snapshot().status).toBe("needs-activation");
    adapter.dispose();
  });

  it("a thrown fetch on refresh rejects with refresh-failed and clears busy", async () => {
    let first = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/polaris.json")) {
        return new Response(discoveryBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (first && url.includes("/identity/session")) {
        first = false;
        return json({
          authenticated: true,
          doc: fuse(makeDoc(), makeConfig()),
        });
      }
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.refresh()).rejects.toMatchObject({
      code: "refresh-failed",
    });
    expect(adapter.snapshot().busy.license).toBe(false);
    expect(adapter.snapshot().busy.config).toBe(false);
    adapter.dispose();
  });
});

describe("BrowserAdapter — update checks", () => {
  it("calls GET /<product>/update/version and compares the HOST version", async () => {
    const seen: string[] = [];
    const adapter = browserAdapter({
      productSlug: "acme",
      version: "1.0.0",
      fetchImpl: fetchWith(
        (url) => {
          seen.push(url);
          if (url.includes("/update/version"))
            return json({ version: "2.0.0", tag: "v2.0.0", url: "https://dl" });
          return json({ authenticated: false, doc: null });
        },
        services("license", "config", "update"),
      ),
      now: () => NOW_SEC,
    });
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
    const adapter = browserAdapter({
      productSlug: "acme",
      version: "2.0.0",
      fetchImpl: fetchWith(
        (url) =>
          url.includes("/update/version")
            ? json({ version: "2.0.0", tag: "v2.0.0", url: "https://dl" })
            : json({ authenticated: false, doc: null }),
        services("license", "config", "update"),
      ),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect((await adapter.checkUpdate()).updateAvailable).toBe(false);
    adapter.dispose();
  });
});

describe("BrowserAdapter — config / secret / entitlement accessors", () => {
  it("getConfig reads the config document, getSecret is always null, isEntitled reflects flags", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.getConfig("theme.mode", "light")).toBe("dark");
    expect(adapter.getConfig("missing", 42)).toBe(42);
    // Secrets ride the config document's `secrets` block and are never projected into state.
    expect(adapter.getSecret("api.token")).toBeNull();
    expect(adapter.isEntitled("polarisVpn")).toBe(true);
    expect(adapter.isEntitled("beta")).toBe(false);
    adapter.dispose();
  });

  it("exposes mode + the BrowserAdapter class as the factory's product", () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => NOW_SEC,
    });
    expect(adapter).toBeInstanceOf(BrowserAdapter);
    expect(adapter.mode).toBe("browser");
    adapter.dispose();
  });
});
