import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http.js";
import { PortalApiError, portalApi, setPortalCsrf } from "../src/portal/api.js";

const CSRF = "X-PKey-Portal-CSRF";

function stub(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sent(fn: ReturnType<typeof stub>, i = 0) {
  const [path, init] = fn.mock.calls[i] as unknown as [string, RequestInit];
  return { path, init, headers: new Headers(init.headers) };
}

beforeEach(() => setPortalCsrf("portal-token"));
afterEach(() => {
  vi.unstubAllGlobals();
  setPortalCsrf("");
});

describe("the portal's transport (security-relevant behaviour)", () => {
  it("sends the portal CSRF header on a change, and not on a read", async () => {
    const fn = stub(new Response("{}"), new Response("{}"), new Response("{}"));
    await portalApi.cancelDeletion();
    await portalApi.deleteMe();
    await portalApi.me();
    expect(sent(fn, 0).headers.get(CSRF)).toBe("portal-token");
    expect(sent(fn, 1).headers.get(CSRF)).toBe("portal-token");
    expect(sent(fn, 2).headers.has(CSRF)).toBe(false);
  });

  it("sends the CSRF header on a personal-data download (a GET)", async () => {
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: () => "blob:x",
        revokeObjectURL: () => {},
      }),
    );
    const fn = stub(new Response("{}"), new Response("{}"));
    await portalApi.exportAccountData();
    await portalApi.exportProductData("djdl");
    for (const i of [0, 1]) {
      expect(sent(fn, i).init.method ?? "GET").toBe("GET");
      expect(sent(fn, i).headers.get(CSRF)).toBe("portal-token");
    }
  });

  it("uses same-origin credentials on every request", async () => {
    const fn = stub(new Response("{}"), new Response("{}"), new Response(null));
    await portalApi.me();
    await portalApi.cancelDeletion();
    await portalApi.signOutHere();
    for (const i of [0, 1, 2])
      expect(sent(fn, i).init.credentials).toBe("same-origin");
  });

  it("/logout carries no CSRF header and does not follow the redirect", async () => {
    const fn = stub(new Response(null, { status: 500 }));
    await portalApi.signOutHere();
    const req = sent(fn);
    expect(req.path).toBe("/logout");
    expect(req.init.method).toBe("POST");
    expect(req.init.redirect).toBe("manual");
    expect(req.headers.has(CSRF)).toBe(false);
  });

  it("/logout accepts any status but reports a network failure", async () => {
    stub(new TypeError("offline"));
    const e = await portalApi.signOutHere().catch((x) => x);
    expect(e).toBeInstanceOf(PortalApiError);
    expect(e).toMatchObject({ status: 0, code: "network" });
  });
});

describe("PortalApiError on the core", () => {
  it("is an HttpError and keeps the portal's fields", async () => {
    stub(
      new Response(
        JSON.stringify({
          error: "step_up_required",
          message: "Sign in again",
          triesLeft: 2,
          retryAfter: 9,
          reason: "r",
          stale: ["started"],
          unknownCredential: true,
          next: { kind: "sso", connection: "okta", label: "Okta" },
        }),
        { status: 403 },
      ),
    );
    const e = await portalApi.cancelDeletion().catch((x) => x);
    expect(e).toBeInstanceOf(PortalApiError);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({
      status: 403,
      code: "step_up_required",
      message: "Sign in again",
      triesLeft: 2,
      retryAfter: 9,
      reason: "r",
      stale: ["started"],
      unknownCredential: true,
    });
    expect(e.body).toMatchObject({ unknownCredential: true });
  });

  it("keeps the 'portal api N' message when the server sent none", async () => {
    stub(new Response("nope", { status: 502 }), new TypeError("offline"));
    const a = await portalApi.me().catch((x) => x);
    expect(a.message).toBe("portal api 502");
    const b = await portalApi.me().catch((x) => x);
    expect(b).toMatchObject({
      status: 0,
      code: "network",
      message: "portal api 0",
    });
  });
});
