import { describe, expect, it, vi } from "vitest";
import {
  browserAdapter,
  BrowserAdapter,
} from "../src/browser/browserAdapter.js";
import { makeDoc, makeFakeFetch, NOW_SEC } from "./fixtures.js";

// The browser adapter is a cookie-session transport. These tests drive it directly (no
// React) with an injected fetch/navigate/clock so every path is deterministic and offline.

/** Resolve once the adapter has left the initial `loading` phase. */
async function ready(
  adapter: ReturnType<typeof browserAdapter>,
): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("BrowserAdapter — construction + first load", () => {
  it("loads the session and projects the doc to an ok snapshot", async () => {
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
    adapter.dispose();
  });

  it("an unauthenticated session lands on needs-enroll", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("needs-enroll");
    adapter.dispose();
  });

  it("scopes every request under /<product>", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/acme/session");
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
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://example.test/acme/session",
    );
    adapter.dispose();
  });
});

describe("BrowserAdapter — signInWithOidc redirect", () => {
  it("navigates to the worker login entrypoint with a return_to and never returns a handle", async () => {
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
    expect(target).toContain("/acme/auth/login?return_to=");
    adapter.dispose();
  });
});

describe("BrowserAdapter — submitKey", () => {
  it("posts a license key and refreshes the cookie session", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await adapter.submitKey("pkey_acme_test");
    const call = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("/session/license"),
    );
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({ key: "pkey_acme_test" });
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("surfaces rejected keys as sign-in-failed with a clear message", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/session/license")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ authenticated: false, doc: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.submitKey("bad")).rejects.toMatchObject({
      code: "sign-in-failed",
      message: "That key was not accepted.",
    });
    adapter.dispose();
  });
});

describe("BrowserAdapter — signOut", () => {
  it("posts logout (echoing CSRF) and resets to needs-enroll", async () => {
    const fetchImpl = vi.fn(makeFakeFetch(makeDoc()));
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await adapter.signOut();
    const s = adapter.snapshot();
    expect(s.status).toBe("needs-enroll");
    expect(s.profile).toBeNull();
    expect(s.config).toEqual({});
    // The logout POST echoed the CSRF token from the session response.
    const logoutCall = fetchImpl.mock.calls.find((c) =>
      String(c[0]).includes("/auth/logout"),
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
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            doc: makeDoc(),
            csrfToken: "c",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.signOut()).resolves.toBeUndefined();
    expect(adapter.snapshot().status).toBe("needs-enroll");
    adapter.dispose();
  });

  it("surfaces a non-401 logout failure as sign-out-failed", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/session")) {
        return new Response(
          JSON.stringify({ authenticated: true, doc: makeDoc() }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await expect(adapter.signOut()).rejects.toMatchObject({
      code: "sign-out-failed",
    });
    expect(adapter.snapshot().error?.code).toBe("sign-out-failed");
    adapter.dispose();
  });
});

describe("BrowserAdapter — 401 / refresh handling", () => {
  it("a hard 401 after a live session ⇒ revoked", async () => {
    let authed = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/session")) {
        if (authed) {
          return new Response(
            JSON.stringify({
              authenticated: true,
              doc: makeDoc(),
              csrfToken: "c",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(null, { status: 401 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.snapshot().status).toBe("ok");
    authed = false;
    await adapter.refresh();
    expect(adapter.snapshot().status).toBe("revoked");
    adapter.dispose();
  });

  it("a 401 with no prior session stays needs-enroll (not revoked)", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 401 })) as unknown as typeof fetch;
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl,
      now: () => NOW_SEC,
    });
    await ready(adapter);
    await adapter.refresh();
    expect(adapter.snapshot().status).toBe("needs-enroll");
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
    expect(adapter.snapshot().error?.code).toBe("network");
    expect(adapter.snapshot().status).toBe("needs-enroll");
    adapter.dispose();
  });

  it("a thrown fetch on refresh rejects with refresh-failed and records the error", async () => {
    let first = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (first && String(input).includes("/session")) {
        first = false;
        return new Response(
          JSON.stringify({ authenticated: true, doc: makeDoc() }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
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
    expect(adapter.snapshot().busy).toBe(false);
    adapter.dispose();
  });
});

describe("BrowserAdapter — config / secret / entitlement accessors", () => {
  it("getConfig reads the doc value, getSecret is always null, isEntitled reflects flags", async () => {
    const adapter = browserAdapter({
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc()),
      now: () => NOW_SEC,
    });
    await ready(adapter);
    expect(adapter.getConfig("theme.mode", "light")).toBe("dark");
    expect(adapter.getConfig("missing", 42)).toBe(42);
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
