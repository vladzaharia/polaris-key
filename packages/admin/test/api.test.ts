import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  setCsrf,
  setLoginRedirectForTests,
} from "../src/api.js";

// The api module is the same-origin client for /manage/api/*. These exercise the transport:
// CSRF echo on mutations, Content-Type only with a body, 401 → login redirect, and the typed
// ApiError surface — all against a stubbed fetch so they're network-free.

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];

/** Stub fetch with a per-call responder; records every call for assertions. */
function stubFetch(
  responder: (url: string, init: RequestInit) => Response,
): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return responder(url, init);
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setCsrf("");
  setLoginRedirectForTests(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLoginRedirectForTests();
});

describe("api — request shaping", () => {
  it("GET requests carry no CSRF header and no Content-Type", async () => {
    stubFetch(() => json({ licenses: [] }));
    await api.licenses("djdl");
    const init = calls[0]!.init;
    const headers = init.headers as Headers;
    expect(calls[0]!.url).toBe("/manage/api/products/djdl/licenses");
    expect(headers.get("X-PKey-CSRF")).toBeNull();
    expect(headers.get("Content-Type")).toBeNull();
    expect(init.credentials).toBe("same-origin");
  });

  it("a mutation echoes the CSRF token and sets Content-Type when there is a body", async () => {
    setCsrf("tok-123");
    stubFetch(() => json({ licenseId: "l1", key: "k", license: {} }));
    await api.createLicense("djdl", { name: "Ada", email: "a@x.io" });
    const init = calls[0]!.init;
    const headers = init.headers as Headers;
    expect(init.method).toBe("POST");
    expect(headers.get("X-PKey-CSRF")).toBe("tok-123");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Ada",
      email: "a@x.io",
    });
  });

  it("a mutation with no body still echoes CSRF but omits Content-Type", async () => {
    setCsrf("tok-9");
    stubFetch(() => json({ ok: true }));
    await api.logout();
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("X-PKey-CSRF")).toBe("tok-9");
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("URL-encodes path parameters", async () => {
    stubFetch(() => json({}));
    await api.license("djdl", "lic/with space");
    expect(calls[0]!.url).toBe(
      "/manage/api/products/djdl/licenses/lic%2Fwith%20space",
    );
  });

  it("builds the activity query string with limit (and cursor when given)", async () => {
    stubFetch(() => json({ items: [], nextCursor: null }));
    await api.activity("djdl", { beforeAt: 123, beforeId: "a1" }, 25);
    const url = calls[0]!.url;
    expect(url).toContain("limit=25");
    expect(url).toContain("beforeAt=123");
    expect(url).toContain("beforeId=a1");
  });

  it("setLicenseEnabled hits enable/disable per the flag", async () => {
    stubFetch(() => json({ ok: true, id: "l1", status: "disabled" }));
    await api.setLicenseEnabled("djdl", "l1", false);
    expect(calls[0]!.url).toBe("/manage/api/products/djdl/licenses/l1/disable");
    await api.setLicenseEnabled("djdl", "l1", true);
    expect(calls[1]!.url).toBe("/manage/api/products/djdl/licenses/l1/enable");
  });
});

describe("api — error handling", () => {
  it("a 401 redirects to login and throws ApiError(401)", async () => {
    const redirect = vi.fn();
    setLoginRedirectForTests(redirect);
    stubFetch(() => new Response(null, { status: 401 }));
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("a non-ok JSON error surfaces fields + code + message", async () => {
    stubFetch(() =>
      json(
        { error: "validation", message: "bad input", fields: ["email"] },
        422,
      ),
    );
    try {
      await api.createLicense("djdl", { name: "x", email: "bad" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(422);
      expect(err.code).toBe("validation");
      expect(err.fields).toEqual(["email"]);
      expect(err.message).toBe("bad input");
    }
  });

  it("a non-ok non-JSON error still throws ApiError with the status", async () => {
    stubFetch(() => new Response("upstream boom", { status: 502 }));
    await expect(api.products()).rejects.toMatchObject({ status: 502 });
  });

  it("a successful response is parsed and returned", async () => {
    stubFetch(() => json({ products: [{ slug: "djdl" }] }));
    const res = await api.products();
    expect(res.products[0]!.slug).toBe("djdl");
  });
});

describe("ApiError", () => {
  it("formats its message from the status by default", () => {
    expect(new ApiError(403).message).toBe("api 403");
  });
});
