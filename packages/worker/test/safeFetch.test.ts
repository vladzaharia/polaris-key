/**
 * HA-01 — the guarded outbound fetcher (`core/safeFetch.ts`; notes/S-20 §6.3 step 1).
 *
 * The guard table below IS the S-20 reference puller's `--self-test` table: the first test reads
 * the prototype's source and fails if the two have drifted, case for case.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SAFE_FETCH_MAX_REDIRECTS,
  TooLargeError,
  guardUrl,
  safeFetch,
  type FetchImpl,
} from "../src/core/safeFetch.js";

const here = dirname(fileURLToPath(import.meta.url));
const PULL_MJS = join(
  here,
  "../../../docs/research/2026-09-29-godot-omniplatform/prototype/hosted-assets/pull.mjs",
);

/** The prototype's `SELF_TEST`, verbatim. */
const GUARD_TABLE: [string, string | null][] = [
  ["https://raw.githubusercontent.com/o/r/abc/icon.png", null],
  ["https://cdn.example.com/a.png", null],
  ["http://cdn.example.com/a.png", "scheme"],
  ["https://user:pw@cdn.example.com/a.png", "credentials"],
  ["https://cdn.example.com:8443/a.png", "port"],
  ["https://10.0.0.1/a.png", "ip-literal"],
  ["https://[::1]/a.png", "ip-literal"],
  ["https://intranet/a.png", "single-label"],
  ["https://key.plrs.im/admin", "denied-host"],
  ["https://dl.plrs.im/x", "denied-host"],
  ["https://printer.local/a.png", "denied-host"],
  ["ftp://cdn.example.com/a.png", "scheme"],
];

function prototypeTable(): [string, string | null][] {
  const src = readFileSync(PULL_MJS, "utf8");
  const m = /const SELF_TEST = (\[[\s\S]*?\n\]);/.exec(src);
  if (!m) throw new Error("SELF_TEST not found in pull.mjs");
  return JSON.parse(m[1]!.replace(/,(\s*\])/g, "$1")) as [
    string,
    string | null,
  ][];
}

describe("guardUrl", () => {
  it("is the reference puller's --self-test table, case for case", () => {
    expect(prototypeTable()).toEqual(GUARD_TABLE);
  });

  it.each(GUARD_TABLE)("%s → %s", (url, want) => {
    expect(guardUrl(url)).toBe(want);
  });

  it("also refuses the remaining S-20 names and spellings", () => {
    expect(guardUrl("https://plrs.im/x")).toBe("denied-host");
    expect(guardUrl("https://KEY.PLRS.IM./x")).toBe("denied-host");
    expect(guardUrl("https://media-staging.plrs.im/x")).toBe("denied-host");
    expect(guardUrl("https://box.internal/a.png")).toBe("denied-host");
    expect(guardUrl("https://app.localhost/a.png")).toBe("denied-host");
    expect(guardUrl("https://nas.home.arpa/a.png")).toBe("denied-host");
    expect(guardUrl("https://localhost/a.png")).toBe("single-label");
    // Every IPv4 spelling the URL parser normalises to a dotted quad.
    expect(guardUrl("https://0x7f.1/a.png")).toBe("ip-literal");
    expect(guardUrl("https://2130706433/a.png")).toBe("ip-literal");
    expect(guardUrl("https://[fd00::1]:443/a.png")).toBe("ip-literal");
    expect(guardUrl("https://cdn.example.com:443/a.png")).toBeNull();
    expect(guardUrl(`https://cdn.example.com/${"a".repeat(2048)}`)).toBe(
      "too-long",
    );
    expect(guardUrl("not a url")).toBe("unparseable");
    expect(guardUrl("javascript:alert(1)")).toBe("scheme");
    expect(guardUrl("data:image/png;base64,AAAA")).toBe("scheme");
  });
});

// ── The fetch ────────────────────────────────────────────────────────────────────────────────

interface Call {
  url: string;
  headers: Headers;
}

/** A scripted upstream: each URL answers the response its handler builds. */
function upstream(
  routes: Record<string, () => Response>,
): FetchImpl & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe("manual");
    const route = routes[url];
    if (!route) return new Response("nope", { status: 404 });
    return route();
  }) as FetchImpl & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

const redirect =
  (to: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location: to } });

function chunked(total: number, chunk = 1000): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<number> {
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.byteLength;
  }
}

describe("safeFetch", () => {
  it("returns the body, its length and its validator", async () => {
    const fetchImpl = upstream({
      "https://cdn.example.com/a.png": () =>
        new Response(new Uint8Array(10), {
          headers: { "content-length": "10", etag: '"v1"' },
        }),
    });
    const res = await safeFetch("https://cdn.example.com/a.png", {
      maxBytes: 100,
      fetchImpl,
    });
    expect(res).toMatchObject({
      ok: true,
      status: 200,
      length: 10,
      etag: '"v1"',
    });
    if (!res.ok || res.status !== 200) throw new Error("unreachable");
    expect(await drain(res.body)).toBe(10);
  });

  it("refuses the first URL by the guard without dialling it", async () => {
    const fetchImpl = upstream({});
    const res = await safeFetch("https://key.plrs.im/admin", {
      maxBytes: 100,
      fetchImpl,
    });
    expect(res).toEqual({ ok: false, reason: "guard:denied-host", hops: [] });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("refuses a redirect to a denied host AT THE HOP, before dialling it", async () => {
    const fetchImpl = upstream({
      "https://cdn.example.com/a.png": redirect("https://dl.plrs.im/secret"),
      "https://dl.plrs.im/secret": () => new Response("must not be reached"),
    });
    const res = await safeFetch("https://cdn.example.com/a.png", {
      maxBytes: 100,
      fetchImpl,
    });
    expect(res).toEqual({
      ok: false,
      reason: "guard:denied-host",
      hops: ["dl.plrs.im"],
    });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      "https://cdn.example.com/a.png",
    ]);
  });

  it("refuses a redirect to an IP literal, plain http or a relative escape the same way", async () => {
    for (const [to, reason] of [
      ["https://169.254.169.254/latest/meta-data", "guard:ip-literal"],
      ["http://cdn.example.com/a.png", "guard:scheme"],
      ["https://printer.local/a.png", "guard:denied-host"],
    ] as const) {
      const fetchImpl = upstream({
        "https://cdn.example.com/start": redirect(to, 307),
      });
      const res = await safeFetch("https://cdn.example.com/start", {
        maxBytes: 100,
        fetchImpl,
      });
      expect(res).toMatchObject({ ok: false, reason });
      expect(fetchImpl.calls).toHaveLength(1);
    }
  });

  it(`follows at most ${SAFE_FETCH_MAX_REDIRECTS} redirects`, async () => {
    const ok = upstream({
      "https://a.example.com/0": redirect("https://a.example.com/1"),
      "https://a.example.com/1": redirect("/2"),
      "https://a.example.com/2": redirect("https://b.example.com/3"),
      "https://b.example.com/3": () => new Response(new Uint8Array(3)),
    });
    const three = await safeFetch("https://a.example.com/0", {
      maxBytes: 100,
      fetchImpl: ok,
    });
    expect(three).toMatchObject({
      ok: true,
      status: 200,
      url: "https://b.example.com/3",
      hops: ["a.example.com", "a.example.com", "b.example.com"],
    });
    const tooMany = upstream({
      "https://a.example.com/0": redirect("https://a.example.com/1"),
      "https://a.example.com/1": redirect("https://a.example.com/2"),
      "https://a.example.com/2": redirect("https://a.example.com/3"),
      "https://a.example.com/3": redirect("https://a.example.com/4"),
    });
    expect(
      await safeFetch("https://a.example.com/0", {
        maxBytes: 100,
        fetchImpl: tooMany,
      }),
    ).toMatchObject({ ok: false, reason: "guard:redirects" });
    expect(tooMany.calls).toHaveLength(4);
  });

  it("sends Authorization to the first hop only", async () => {
    const fetchImpl = upstream({
      "https://api.github.com/x": redirect(
        "https://objects.githubusercontent.com/y",
      ),
      "https://objects.githubusercontent.com/y": () =>
        new Response(new Uint8Array(1)),
    });
    await safeFetch("https://api.github.com/x", {
      maxBytes: 100,
      headers: { authorization: "Bearer ghs_x", accept: "image/png" },
      fetchImpl,
    });
    expect(fetchImpl.calls[0]!.headers.get("authorization")).toBe(
      "Bearer ghs_x",
    );
    expect(fetchImpl.calls[1]!.headers.get("authorization")).toBeNull();
    expect(fetchImpl.calls[1]!.headers.get("accept")).toBe("image/png");
  });

  it("refuses a declared Content-Length over the cap before reading the body", async () => {
    let pulled = false;
    const fetchImpl = upstream({
      "https://cdn.example.com/big": () =>
        new Response(
          new ReadableStream(
            {
              pull() {
                pulled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-length": "1000" } },
        ),
    });
    const res = await safeFetch("https://cdn.example.com/big", {
      maxBytes: 999,
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: false, reason: "too-large" });
    expect(pulled).toBe(false);
  });

  it("cuts a body with no (or a lying) Content-Length at the cap while streaming", async () => {
    const fetchImpl = upstream({
      "https://cdn.example.com/liar": () =>
        new Response(chunked(5000), { headers: { "content-length": "10" } }),
    });
    const res = await safeFetch("https://cdn.example.com/liar", {
      maxBytes: 2500,
      fetchImpl,
    });
    if (!res.ok || res.status !== 200) throw new Error("expected a body");
    await expect(drain(res.body)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("sends If-None-Match and answers a 304 as no work", async () => {
    const fetchImpl = upstream({
      "https://cdn.example.com/a.png": () =>
        new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    });
    const res = await safeFetch("https://cdn.example.com/a.png", {
      maxBytes: 100,
      etag: '"v1"',
      fetchImpl,
    });
    expect(res).toMatchObject({ ok: true, status: 304, etag: '"v1"' });
    expect(fetchImpl.calls[0]!.headers.get("if-none-match")).toBe('"v1"');
  });

  it("answers any other status as status:<n>", async () => {
    const fetchImpl = upstream({
      "https://cdn.example.com/x": () => new Response("x", { status: 500 }),
    });
    expect(
      await safeFetch("https://cdn.example.com/x", { maxBytes: 10, fetchImpl }),
    ).toMatchObject({ ok: false, reason: "status:500" });
    expect(
      await safeFetch("https://cdn.example.com/missing", {
        maxBytes: 10,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, reason: "status:404" });
  });

  it("times out", async () => {
    const fetchImpl: FetchImpl = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      });
    expect(
      await safeFetch("https://slow.example.com/a.png", {
        maxBytes: 10,
        timeoutMs: 20,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("answers a thrown fetch as network", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new TypeError("connection reset");
    };
    expect(
      await safeFetch("https://cdn.example.com/a.png", {
        maxBytes: 10,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, reason: "network" });
  });

  it("applies a caller's host rule to every hop, on top of the guard", async () => {
    const github = (h: string) =>
      h === "github.com" || h.endsWith(".githubusercontent.com");
    const fetchImpl = upstream({
      "https://github.com/o/r/raw/x/icon.png": redirect(
        "https://cdn.example.com/icon.png",
      ),
    });
    expect(
      await safeFetch("https://github.com/o/r/raw/x/icon.png", {
        maxBytes: 10,
        allowHost: github,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, reason: "guard:not-allowed" });
    expect(fetchImpl.calls).toHaveLength(1);
  });
});
