import { describe, expect, it } from "vitest";
import { fetchManagedConfig, type FetchOptions } from "../src/fetch.js";

/** A fake `fetch` returning a canned Response + capturing the requests. */
function fakeFetch(
  status: number,
  body: string | null,
  headers: Record<string, string> = {},
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 304 ? null : body, { status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base: Omit<FetchOptions, "fetchImpl"> = {
  baseUrl: "https://k.test",
  product: "djdl",
  token: "pkeyt_test",
  deviceId: "dev-1",
  version: "1.2.3",
  channel: "stable",
};

describe("fetchManagedConfig — request construction", () => {
  it("hits /<product>/config with bearer TOKEN + device/version/channel headers", async () => {
    const { impl, calls } = fakeFetch(200, "JWS", { etag: '"abc"' });
    await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(calls[0]?.url).toBe("https://k.test/djdl/config");
    const h = new Headers((calls[0]?.init as RequestInit).headers);
    expect(h.get("authorization")).toBe("Bearer pkeyt_test");
    expect(h.get("x-pkey-device")).toBe("dev-1");
    expect(h.get("x-pkey-version")).toBe("1.2.3");
    expect(h.get("x-pkey-channel")).toBe("stable");
    expect(h.get("if-none-match")).toBeNull(); // no etag held → header omitted
  });

  it("sends If-None-Match only when an etag is held", async () => {
    const { impl, calls } = fakeFetch(304, "");
    await fetchManagedConfig({ ...base, etag: '"v2"', fetchImpl: impl });
    const h = new Headers((calls[0]?.init as RequestInit).headers);
    expect(h.get("if-none-match")).toBe('"v2"');
  });

  it("forwards the abort signal", async () => {
    const { impl, calls } = fakeFetch(200, "JWS");
    const ctrl = new AbortController();
    await fetchManagedConfig({ ...base, signal: ctrl.signal, fetchImpl: impl });
    expect((calls[0]?.init as RequestInit).signal).toBe(ctrl.signal);
  });
});

describe("fetchManagedConfig — status taxonomy", () => {
  it("200 → ok with the raw JWS body and the response etag", async () => {
    const { impl } = fakeFetch(200, "the-jws", { etag: '"abc"' });
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({ kind: "ok", jws: "the-jws", etag: '"abc"' });
  });

  it("200 with no etag header → ok with etag null", async () => {
    const { impl } = fakeFetch(200, "the-jws");
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({ kind: "ok", jws: "the-jws", etag: null });
  });

  it("304 → not-modified", async () => {
    const { impl } = fakeFetch(304, "");
    expect(await fetchManagedConfig({ ...base, fetchImpl: impl })).toEqual({
      kind: "not-modified",
    });
  });

  it("401 → unauthorized", async () => {
    const { impl } = fakeFetch(401, "");
    expect(await fetchManagedConfig({ ...base, fetchImpl: impl })).toEqual({
      kind: "unauthorized",
    });
  });

  it("403 → blocked with reason + allowedRange parsed from the body", async () => {
    const { impl } = fakeFetch(
      403,
      JSON.stringify({
        reason: "version-too-old",
        allowedRange: { min: "1.0.0", max: "2.0.0" },
      }),
    );
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({
      kind: "blocked",
      reason: "version-too-old",
      allowedRange: { min: "1.0.0", max: "2.0.0" },
    });
  });

  it("403 with an empty/garbage body falls back to version-too-old", async () => {
    const { impl } = fakeFetch(403, "not json");
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({
      kind: "blocked",
      reason: "version-too-old",
      allowedRange: undefined,
    });
  });

  it("429 → device-cap with limit + machineCount", async () => {
    const { impl } = fakeFetch(
      429,
      JSON.stringify({ limit: 3, machineCount: 3 }),
    );
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({ kind: "device-cap", limit: 3, machineCount: 3 });
  });

  it("429 with a garbage body still yields device-cap (counts undefined)", async () => {
    const { impl } = fakeFetch(429, "nope");
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({
      kind: "device-cap",
      limit: undefined,
      machineCount: undefined,
    });
  });

  it("500 → error carrying the status + body message", async () => {
    const { impl } = fakeFetch(500, "boom");
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({ kind: "error", status: 500, message: "boom" });
  });

  it("returns error (not throw) when the network fails", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await fetchManagedConfig({ ...base, fetchImpl: impl });
    expect(res).toEqual({ kind: "error", status: 0, message: "ECONNREFUSED" });
  });
});
