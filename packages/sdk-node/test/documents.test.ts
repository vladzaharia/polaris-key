// The signed-document GETs — wire contract v3 §5. Heir to v2's `fetch.test.ts`.
//
// v2 had ONE document on ONE route (`GET /<p>/config`) and one status ladder to go with it.
// v3 splits it in two — `GET /<p>/license/document` (grants, D-20) and
// `GET /<p>/config/document` (settings + secrets, D-08) — and then deliberately refuses to
// split the ladder: both routes go through `CoreContext.getDocument`, so a 403, a 429 or a
// dropped connection cannot come to mean different things depending on which service asked.
//
// That single implementation is exactly why this file runs the WHOLE taxonomy against BOTH
// documents rather than testing the shared helper once. The pin is not "the helper works", it
// is "the two documents behave identically", which is a property of the call sites as much as
// of the helper — and the cheapest way for a future third document to acquire its own private
// ladder is for nobody to have written this test.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────
//
// Verification. `getDocument` returns the RAW compact JWS and nothing else; `sync()` hands it
// to client-core with the right trust set and anti-replay floor. An HTTP layer that verified
// would be an HTTP layer that could be talked into not verifying, so there is deliberately no
// signature, no `aud` check and no clock anywhere in this module to test.
//
// ── THE ETAGS ARE INDEPENDENT ───────────────────────────────────────────────────────────────
//
// §5 gives each document its OWN conditional-request validator, cached in its own slice
// (`CacheRecordV3.etags.{license,config}`). That is what stops a settings edit from forcing a
// licence re-download and a tier change from forcing a settings refetch. Sending the licence's
// ETag on the config request would 304 a config document the client has never seen — so the
// last describe below pins that it cannot happen.

import { describe, expect, it } from "vitest";
import { CoreContext, type DocumentResult } from "../src/core/context.js";
import { InMemoryStore } from "../src/core/store.js";
import { fetchLicenseDocument } from "../src/license/endpoints.js";
import { fetchConfigDocument } from "../src/config/fetch.js";

/** A fake `fetch` returning a canned Response + capturing the requests. */
function fakeFetch(
  status: number,
  body: string | null,
  headers: Record<string, string> = {},
): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    // 304 (like 204/205) may not carry a body at all.
    return new Response(status === 304 ? null : body, { status, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function explodingFetch(message = "ECONNREFUSED"): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** A ready-to-use Core. `init()` loads the device id, which rides `X-PKey-Device`. */
async function makeCtx(impl: typeof fetch): Promise<CoreContext> {
  const ctx = new CoreContext({
    productSlug: "djdl",
    baseUrl: "https://k.test",
    version: "1.2.3",
    channel: "stable",
    trust: { pinnedKeys: {} },
    store: new InMemoryStore("djdl"),
    fetchImpl: impl,
  });
  await ctx.init();
  return ctx;
}

const TOKEN = "pkeyt_test";

/** The two documents, driven through identical assertions. */
const DOCUMENTS = [
  {
    name: "license",
    url: "https://k.test/djdl/license/document",
    fetchDoc: fetchLicenseDocument,
  },
  {
    name: "config",
    url: "https://k.test/djdl/config/document",
    fetchDoc: fetchConfigDocument,
  },
] as const satisfies ReadonlyArray<{
  name: string;
  url: string;
  fetchDoc: (
    ctx: CoreContext,
    token: string,
    etag?: string,
  ) => Promise<DocumentResult>;
}>;

describe.each(DOCUMENTS)("$name document — request construction", (doc) => {
  it("GETs the v3 route with the device bearer + device/version/channel headers", async () => {
    const { impl, calls } = fakeFetch(200, "JWS", { etag: '"abc"' });
    const ctx = await makeCtx(impl);
    await doc.fetchDoc(ctx, TOKEN);

    expect(calls[0]?.url).toBe(doc.url);
    const h = new Headers(calls[0]!.init.headers);
    // The `pkeyt_` DEVICE token — never a licence key. Both documents are device-scoped.
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("x-pkey-device")).toBe(ctx.deviceId);
    expect(h.get("x-pkey-version")).toBe("1.2.3");
    expect(h.get("x-pkey-channel")).toBe("stable");
    // No ETag held ⇒ the conditional header is omitted, not sent empty.
    expect(h.get("if-none-match")).toBeNull();
  });

  it("sends If-None-Match only when an etag is held", async () => {
    const { impl, calls } = fakeFetch(304, null);
    await doc.fetchDoc(await makeCtx(impl), TOKEN, '"v2"');
    expect(new Headers(calls[0]!.init.headers).get("if-none-match")).toBe(
      '"v2"',
    );
  });

  it("forwards the Core deadline (R4-08)", async () => {
    // `getDocument` takes its signal from `CoreContext.deadline()` rather than accepting one,
    // so no call site can forget it — but a request with no signal at all would hang `sync()`.
    const { impl, calls } = fakeFetch(200, "JWS");
    await doc.fetchDoc(await makeCtx(impl), TOKEN);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe.each(DOCUMENTS)("$name document — status taxonomy", (doc) => {
  it("200 → ok with the raw JWS body and the response etag", async () => {
    const { impl } = fakeFetch(200, "the-jws", { etag: '"abc"' });
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "ok",
      jws: "the-jws",
      etag: '"abc"',
    });
  });

  it("200 with no etag header → ok with etag null", async () => {
    // A server that omits the validator is not an error; it just means no conditional request
    // is possible next time. `null` (not `undefined`) is what the cache stores as "none".
    const { impl } = fakeFetch(200, "the-jws");
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "ok",
      jws: "the-jws",
      etag: null,
    });
  });

  it("304 → not-modified", async () => {
    const { impl } = fakeFetch(304, null);
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "not-modified",
    });
  });

  it("401 → unauthorized", async () => {
    const { impl } = fakeFetch(401, "");
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "unauthorized",
    });
  });

  it("429 → device-cap with limit + deviceCount", async () => {
    const { impl } = fakeFetch(
      429,
      JSON.stringify({ limit: 3, deviceCount: 3 }),
    );
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "device-cap",
      limit: 3,
      deviceCount: 3,
    });
  });

  it("429 with an unparseable body still yields device-cap (counts undefined)", async () => {
    // The KIND is the load-bearing part: the client must stop asking. The counts are UI detail
    // and their absence must not downgrade the outcome to a generic error.
    const { impl } = fakeFetch(429, "nope");
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "device-cap",
      limit: undefined,
      deviceCount: undefined,
    });
  });

  it("500 → error carrying the status + body message", async () => {
    const { impl } = fakeFetch(500, "boom");
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "error",
      status: 500,
      message: "boom",
    });
  });

  it("returns error (not throw) when the network fails, with status 0", async () => {
    // `status: 0` is the marker for "never reached the server" — distinct from any HTTP
    // status, so `sync()` can tell an offline client from a refusing one.
    expect(await doc.fetchDoc(await makeCtx(explodingFetch()), TOKEN)).toEqual({
      kind: "error",
      status: 0,
      message: "ECONNREFUSED",
    });
  });
});

describe.each(DOCUMENTS)("$name document — 403 block parsing", (doc) => {
  // The build gate lives on `/license/document` (D-20), so in practice only that route ever
  // answers `blocked` — but the ladder is shared, and a config route that parsed a 403
  // differently would be a silent divergence. Both are pinned.

  it("reads reason + allowedRange out of the v3 NESTED error body", async () => {
    const { impl } = fakeFetch(
      403,
      JSON.stringify({
        error: { code: "version_blocked", reason: "version-too-new" },
        allowedRange: { min: "1.0.0", max: "2.0.0" },
      }),
    );
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "blocked",
      reason: "version-too-new",
      allowedRange: { min: "1.0.0", max: "2.0.0" },
    });
  });

  it("reads reason + allowedRange out of the FLAT body", async () => {
    const { impl } = fakeFetch(
      403,
      JSON.stringify({
        reason: "version-too-old",
        allowedRange: { min: "1.0.0", max: "2.0.0" },
      }),
    );
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "blocked",
      reason: "version-too-old",
      allowedRange: { min: "1.0.0", max: "2.0.0" },
    });
  });

  it("maps the channel_not_allowed code to channel-not-entitled", async () => {
    // A body that carries the CODE but no `reason` still has to reach the right gate state:
    // "you are on the wrong channel" is a different remedy from "you are on the wrong version".
    const { impl } = fakeFetch(
      403,
      JSON.stringify({ error: { code: "channel_not_allowed" } }),
    );
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "blocked",
      reason: "channel-not-entitled",
      allowedRange: undefined,
    });
  });

  it("falls back to version-too-old for an empty/garbage body", async () => {
    // Fail closed: an unexplained block is reported as the stricter, actionable reason rather
    // than being dropped for want of a parse.
    const { impl } = fakeFetch(403, "not json");
    expect(await doc.fetchDoc(await makeCtx(impl), TOKEN)).toEqual({
      kind: "blocked",
      reason: "version-too-old",
      allowedRange: undefined,
    });
  });
});

describe("the two documents carry INDEPENDENT etags (§5)", () => {
  /** Records every request so the two conditional headers can be compared side by side. */
  function recordingFetch(): {
    impl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const ifNoneMatch = (init: RequestInit): string | null =>
    new Headers(init.headers).get("if-none-match");

  it("each request carries its own validator and never the other's", async () => {
    const { impl, calls } = recordingFetch();
    const ctx = await makeCtx(impl);

    await fetchLicenseDocument(ctx, TOKEN, '"lic-v1"');
    await fetchConfigDocument(ctx, TOKEN, '"cfg-v7"');

    expect(calls[0]?.url).toBe("https://k.test/djdl/license/document");
    expect(ifNoneMatch(calls[0]!.init)).toBe('"lic-v1"');
    expect(calls[1]?.url).toBe("https://k.test/djdl/config/document");
    expect(ifNoneMatch(calls[1]!.init)).toBe('"cfg-v7"');
  });

  it("a held license etag is NOT sent on a config request that has none", async () => {
    // The failure this forbids: a 304 on a config document the client has never actually
    // received, leaving the config slice permanently empty while the client believes it is
    // up to date. The two slices are separate in `CacheRecordV3.etags` for this reason.
    const { impl, calls } = recordingFetch();
    const ctx = await makeCtx(impl);

    await fetchLicenseDocument(ctx, TOKEN, '"lic-v1"');
    await fetchConfigDocument(ctx, TOKEN);

    expect(ifNoneMatch(calls[0]!.init)).toBe('"lic-v1"');
    expect(ifNoneMatch(calls[1]!.init)).toBeNull();
  });

  it("and the reverse: a held config etag is NOT sent on a license request", async () => {
    const { impl, calls } = recordingFetch();
    const ctx = await makeCtx(impl);

    await fetchConfigDocument(ctx, TOKEN, '"cfg-v7"');
    await fetchLicenseDocument(ctx, TOKEN);

    expect(ifNoneMatch(calls[0]!.init)).toBe('"cfg-v7"');
    expect(ifNoneMatch(calls[1]!.init)).toBeNull();
  });
});
