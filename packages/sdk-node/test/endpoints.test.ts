import { describe, expect, it, vi } from "vitest";
import { deauthorize, enrollWithKey, reacquireToken, reportSnapshot } from "../src/endpoints.js";

/** A fake fetch returning canned Responses in order + capturing the requests. */
function fakeFetch(responses: Array<{ status: number; body?: unknown }>): {
  impl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = { baseUrl: "https://k.test", product: "djdl", deviceId: "dev-1" };

describe("enrollWithKey", () => {
  it("POSTs /enroll with Bearer <key> + device header and returns the minted token", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { token: "pkeyt_minted", schemaVersion: 2 } }]);
    const res = await enrollWithKey({ ...base, key: "pkey_djdl_AAA", fetchImpl: impl });
    expect(res).toEqual({ kind: "ok", token: "pkeyt_minted", schemaVersion: 2 });
    expect(calls[0]?.url).toBe("https://k.test/djdl/enroll");
    expect((calls[0]?.init as RequestInit).method).toBe("POST");
    const h = new Headers((calls[0]?.init as RequestInit).headers);
    expect(h.get("authorization")).toBe("Bearer pkey_djdl_AAA");
    expect(h.get("x-pkey-device")).toBe("dev-1");
  });

  it("surfaces a 403 machine-limit distinctly with limit + count", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { limit: 3, machineCount: 3 } }]);
    expect(await enrollWithKey({ ...base, key: "pkey_x", fetchImpl: impl })).toEqual({
      kind: "machine-limit",
      limit: 3,
      machineCount: 3,
    });
  });

  it("maps a 401 to unauthorized (bad/revoked key)", async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    expect((await enrollWithKey({ ...base, key: "pkey_bad", fetchImpl: impl })).kind).toBe("unauthorized");
  });

  it("maps other failures to error with the body message", async () => {
    const { impl } = fakeFetch([{ status: 500, body: "boom" }]);
    const res = await enrollWithKey({ ...base, key: "pkey_x", fetchImpl: impl });
    expect(res.kind).toBe("error");
  });

  it("returns error (not throw) on a network failure", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await enrollWithKey({ ...base, key: "pkey_x", fetchImpl: impl })).kind).toBe("error");
  });
});

describe("reacquireToken", () => {
  it("POSTs /token with the device header only (NO bearer) and returns the fresh token", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { token: "pkeyt_reacquired", schemaVersion: 1 } }]);
    const res = await reacquireToken({ ...base, fetchImpl: impl });
    expect(res).toEqual({ kind: "ok", token: "pkeyt_reacquired", schemaVersion: 1 });
    expect(calls[0]?.url).toBe("https://k.test/djdl/token");
    const h = new Headers((calls[0]?.init as RequestInit).headers);
    expect(h.get("x-pkey-device")).toBe("dev-1");
    expect(h.get("authorization")).toBeNull(); // no bearer on /token
  });

  it("maps 403 to machine-limit", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { limit: 2, machineCount: 2 } }]);
    expect((await reacquireToken({ ...base, fetchImpl: impl })).kind).toBe("machine-limit");
  });

  it("maps 401 to unauthorized", async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    expect((await reacquireToken({ ...base, fetchImpl: impl })).kind).toBe("unauthorized");
  });

  it("returns error on a network failure", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await reacquireToken({ ...base, fetchImpl: impl })).kind).toBe("error");
  });
});

describe("deauthorize", () => {
  it("POSTs /deauthorize with the token bearer", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
    await deauthorize({ baseUrl: base.baseUrl, product: base.product, token: "pkeyt_x", fetchImpl: impl });
    expect(calls[0]?.url).toBe("https://k.test/djdl/deauthorize");
    expect((calls[0]?.init as RequestInit).method).toBe("POST");
    const h = new Headers((calls[0]?.init as RequestInit).headers);
    expect(h.get("authorization")).toBe("Bearer pkeyt_x");
  });

  it("is best-effort: swallows a network failure", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      deauthorize({ baseUrl: base.baseUrl, product: base.product, token: "pkeyt_x", fetchImpl: impl }),
    ).resolves.toBeUndefined();
  });

  it("swallows a non-OK response too (no throw)", async () => {
    const { impl } = fakeFetch([{ status: 401 }]);
    await expect(
      deauthorize({ baseUrl: base.baseUrl, product: base.product, token: "pkeyt_x", fetchImpl: impl }),
    ).resolves.toBeUndefined();
  });
});

describe("reportSnapshot", () => {
  it("POSTs the JSON snapshot to /config/report with the token bearer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await reportSnapshot({
      baseUrl: base.baseUrl,
      product: base.product,
      token: "pkeyt_x",
      snapshot: { config: { a: 1 }, entitlements: {} },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://k.test/djdl/config/report");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer pkeyt_x");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ config: { a: 1 }, entitlements: {} });
  });

  it("returns false on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const ok = await reportSnapshot({
      baseUrl: base.baseUrl,
      product: base.product,
      token: "pkeyt_x",
      snapshot: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it("swallows a network failure and returns false (best-effort)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const ok = await reportSnapshot({
      baseUrl: base.baseUrl,
      product: base.product,
      token: "pkeyt_x",
      snapshot: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });
});
