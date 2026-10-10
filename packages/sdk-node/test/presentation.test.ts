// @pkey-feature core.presentation
// Discovery's `core.presentation` in the Node SDK (plans/HA-13.md §3): the client's accessor, the
// icon fetch rules, the cache by hash and `presentation.json`. The parse, pick and verify rules
// are client-core's, run row by row against presentation-matrix.json in
// conformance/runners/node/presentation.test.ts.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import {
  PRESENTATION_MEMBER_FILE,
  PresentationStore,
  safeIconUrl,
} from "../src/core/presentation.js";
import { InMemoryStore } from "../src/core/store.js";
import {
  PRESENTATION_CACHE_MAX_FILES,
  PRESENTATION_ICON_MAX_BYTES,
} from "../src/constants.generated.js";
import { presentationSourceOf, readPresentation } from "../src/cli/theme.js";

const PRODUCT = "djdl";
const BASE = "https://key.plrs.im";
const IMG = "https://img.plrs.im";

const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

const PNG = new TextEncoder().encode("png-original-bytes");
const W64 = new TextEncoder().encode("webp-64-bytes");
const W128 = new TextEncoder().encode("webp-128-bytes");
const ORIGINAL = `${IMG}/${PRODUCT}/a/${sha(PNG)}`;

function presentation(over: Record<string, unknown> = {}) {
  return {
    name: "DJDL",
    developerName: "Vlad Zaharia",
    accent: "#2ED6E6",
    accentDark: "#5ee6f0",
    icon: {
      sha256: sha(PNG),
      contentType: "image/png",
      width: 1024,
      height: 1024,
      original: ORIGINAL,
      url: `${ORIGINAL}/{w}.webp`,
      sizes: [
        { w: 64, sha256: sha(W64) },
        { w: 128, sha256: sha(W128) },
      ],
    },
    ...over,
  };
}

function discoveryDoc(member: unknown): Record<string, unknown> {
  return {
    version: 2,
    protocolVersion: 4,
    schemaVersion: 1,
    product: PRODUCT,
    slug: PRODUCT,
    name: PRODUCT,
    baseUrl: BASE,
    core: {
      registration: "requires-license",
      ...(member === undefined ? {} : { presentation: member }),
    },
    services: { license: { enabled: true }, config: { enabled: true } },
  };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch over a route table; every call is recorded. */
function server(
  routes: Record<string, () => Response>,
  doc: () => unknown,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url === `${BASE}/${PRODUCT}/.well-known/polaris.json`) {
      const d = doc();
      if (d instanceof Response) return d;
      return new Response(JSON.stringify(d), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const route = routes[url];
    return route ? route() : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const ok = (b: Uint8Array) => () => new Response(b.slice(), { status: 200 });

function icons(): Record<string, () => Response> {
  return {
    [ORIGINAL]: ok(PNG),
    [`${ORIGINAL}/64.webp`]: ok(W64),
    [`${ORIGINAL}/128.webp`]: ok(W128),
  };
}

async function client(
  fetchImpl: typeof fetch,
  cacheDir = mkdtempSync(join(tmpdir(), "pkey-presentation-")),
  extra: Record<string, unknown> = {},
): Promise<{ c: PolarisKeyClient; dir: string; cacheDir: string }> {
  const c = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    store: new InMemoryStore(),
    fetchImpl,
    cacheDir,
    stateDir: cacheDir,
    requestTimeoutMs: 0,
    ...extra,
  });
  await c.init();
  return { c, dir: join(cacheDir, PRODUCT, "presentation"), cacheDir };
}

const iconRequests = (calls: Call[]) =>
  calls.filter((x) => x.url.startsWith(IMG));

describe("client.presentation()", () => {
  it("is null before discovery and the normalised member after it", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c } = await client(s.fetch);
    expect(c.presentation()).toBeNull();
    expect((await c.discover()).kind).toBe("ok");
    const p = c.presentation()!;
    expect(p.name).toBe("DJDL");
    expect(p.accent).toBe("#2ed6e6");
    expect(p.icon?.sizes.map((x) => x.w)).toEqual([64, 128]);
    // Discovery alone fetches no icon.
    expect(iconRequests(s.calls)).toEqual([]);
    // A copy: the caller cannot edit the client's member.
    p.name = "edited";
    expect(c.presentation()!.name).toBe("DJDL");
  });

  it("a document without the member clears it; a failed discovery keeps it", async () => {
    let doc: unknown = discoveryDoc(presentation());
    const s = server(icons(), () => doc);
    const { c } = await client(s.fetch);
    await c.discover();
    expect(c.presentation()).not.toBeNull();
    doc = new Response("down", { status: 503 });
    expect((await c.discover()).kind).toBe("error");
    expect(c.presentation()?.name).toBe("DJDL");
    doc = discoveryDoc(undefined);
    await c.discover();
    expect(c.presentation()).toBeNull();
    doc = discoveryDoc("not an object");
    await c.discover();
    expect(c.presentation()).toBeNull();
  });

  it("presentationSource() is client-core's seam: current, icon, subscribe", async () => {
    let doc: unknown = discoveryDoc(presentation());
    const s = server(icons(), () => doc);
    const { c } = await client(s.fetch);
    const source = c.presentationSource();
    const heard: (string | null)[] = [];
    const off = source.subscribe((p) => heard.push(p?.name ?? null));
    await c.discover();
    await c.discover(); // unchanged: no second notification
    doc = discoveryDoc(presentation({ name: "Renamed" }));
    await c.discover();
    off();
    doc = discoveryDoc(undefined);
    await c.discover();
    expect(heard).toEqual(["DJDL", "Renamed"]);
    expect(source.current()).toBeNull();
  });

  it("the terminal kit reads it through the seam (the thin adapter)", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c } = await client(s.fetch);
    await c.discover();
    const p = await readPresentation(presentationSourceOf(c));
    expect(p).toMatchObject({
      name: "DJDL",
      developerName: "Vlad Zaharia",
      accent: "#2ed6e6",
      accentDark: "#5ee6f0",
    });
    // The original `{ presentation() }` shape still reads.
    expect(
      await readPresentation({ presentation: () => ({ name: "Legacy" }) }),
    ).toEqual({ name: "Legacy" });
  });
});

describe("client.presentationIcon(): the fetch rules", () => {
  it("fetches the smallest fitting size with no headers, no credentials and no redirects", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c } = await client(s.fetch);
    await c.discover();
    const bytes = await c.presentationIcon({ px: 32, scale: 2 });
    expect(bytes).toEqual(W64);
    const [req] = iconRequests(s.calls);
    expect(req!.url).toBe(`${ORIGINAL}/64.webp`);
    expect(req!.init?.method).toBe("GET");
    expect(new Headers(req!.init?.headers).entries().next().done).toBe(true);
    expect(req!.init?.credentials).toBe("omit");
    expect(req!.init?.redirect).toBe("manual");
    expect(req!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("the original when nothing else decodes; none when the original does not either", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c } = await client(s.fetch);
    await c.discover();
    expect(
      await c.presentationIcon({ px: 32, decodable: ["image/png"] }),
    ).toEqual(PNG);
    expect(
      await c.presentationIcon({ px: 32, decodable: ["image/gif"] }),
    ).toBeNull();
  });

  it("a 3xx is a miss, and its Location is never followed", async () => {
    const routes = {
      ...icons(),
      [`${ORIGINAL}/64.webp`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: `${ORIGINAL}/128.webp` },
        }),
    };
    const s = server(routes, () => discoveryDoc(presentation()));
    const { c, dir } = await client(s.fetch);
    await c.discover();
    expect(await c.presentationIcon({ px: 32 })).toBeNull();
    expect(iconRequests(s.calls).map((x) => x.url)).toEqual([
      `${ORIGINAL}/64.webp`,
    ]);
    expect(existsSync(join(dir, sha(W64)))).toBe(false);
  });

  it("anything but 200 is a miss", async () => {
    for (const status of [204, 206, 304, 404, 500]) {
      const routes = {
        [`${ORIGINAL}/64.webp`]: () =>
          new Response(status === 204 || status === 304 ? null : W64.slice(), {
            status,
          }),
      };
      const s = server(routes, () => discoveryDoc(presentation()));
      const { c } = await client(s.fetch);
      await c.discover();
      expect(await c.presentationIcon({ px: 32 }), `status ${status}`).toBe(
        null,
      );
    }
  });

  it("bytes past PRESENTATION_ICON_MAX_BYTES are refused, declared or streamed", async () => {
    const big = new Uint8Array(PRESENTATION_ICON_MAX_BYTES + 1);
    const member = presentation({
      icon: {
        sha256: sha(big),
        contentType: "image/png",
        original: `${IMG}/${PRODUCT}/a/${sha(big)}`,
      },
    });
    const declared = server(
      {
        [`${IMG}/${PRODUCT}/a/${sha(big)}`]: () =>
          new Response(big.slice(0, 16), {
            status: 200,
            headers: { "content-length": String(big.byteLength) },
          }),
      },
      () => discoveryDoc(member),
    );
    let { c } = await client(declared.fetch);
    await c.discover();
    expect(await c.presentationIcon({ px: 32 })).toBeNull();

    let pulled = 0;
    const streamed = server(
      {
        [`${IMG}/${PRODUCT}/a/${sha(big)}`]: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(ctl) {
                const chunk = big.subarray(pulled, pulled + 1024 * 1024);
                pulled += chunk.byteLength;
                if (chunk.byteLength === 0) ctl.close();
                else ctl.enqueue(chunk.slice());
              },
            }),
            { status: 200 },
          ),
      },
      () => discoveryDoc(member),
    );
    ({ c } = await client(streamed.fetch));
    await c.discover();
    expect(await c.presentationIcon({ px: 32 })).toBeNull();
    // It stopped reading at the cap rather than draining the whole body.
    expect(pulled).toBeLessThanOrEqual(
      PRESENTATION_ICON_MAX_BYTES + 2 * 1024 * 1024,
    );
  });

  it("bytes whose SHA-256 is not the pick's are neither returned nor cached", async () => {
    const routes = { [`${ORIGINAL}/64.webp`]: ok(W128) };
    const s = server(routes, () => discoveryDoc(presentation()));
    const { c, dir } = await client(s.fetch);
    await c.discover();
    expect(await c.presentationIcon({ px: 32 })).toBeNull();
    expect(existsSync(dir) ? readdirSync(dir) : []).not.toContain(sha(W128));
    expect(existsSync(join(dir, sha(W64)))).toBe(false);
  });

  it("refuses a non-https URL and a size URL off the original's origin before dialling", () => {
    expect(safeIconUrl(`${ORIGINAL}/64.webp`, ORIGINAL)).toBe(true);
    expect(
      safeIconUrl("http://localhost:8787/a/1", "http://localhost:8787/a"),
    ).toBe(true);
    expect(safeIconUrl("http://img.plrs.im/a", "http://img.plrs.im/a")).toBe(
      false,
    );
    expect(safeIconUrl("https://evil.example/a", ORIGINAL)).toBe(false);
    expect(safeIconUrl(`${IMG}:8443/a`, ORIGINAL)).toBe(false);
    expect(safeIconUrl("ftp://img.plrs.im/a", "ftp://img.plrs.im/a")).toBe(
      false,
    );
  });

  it("a local-only client never dials", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const dir = mkdtempSync(join(tmpdir(), "pkey-presentation-"));
    const store = new PresentationStore({
      product: PRODUCT,
      dir,
      fetcher: () => {
        throw new Error("local-only");
      },
    });
    await store.accept(discoveryDoc(presentation()));
    expect(await store.icon(32, 1)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it("concurrent requests for one size share one fetch", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c } = await client(s.fetch);
    await c.discover();
    const [a, b] = await Promise.all([
      c.presentationIcon({ px: 32 }),
      c.presentationIcon({ px: 48 }),
    ]);
    expect(a).toEqual(W64);
    expect(b).toEqual(W64);
    expect(iconRequests(s.calls)).toHaveLength(1);
  });
});

describe("the cache: by hash, re-hashed, pruned, and presentation.json", () => {
  it("caches verified bytes by hash and serves them again without a fetch", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c, dir } = await client(s.fetch);
    await c.discover();
    await c.presentationIcon({ px: 32 });
    expect(readFileSync(join(dir, sha(W64)))).toEqual(Buffer.from(W64));
    expect(await c.presentationIcon({ px: 32 })).toEqual(W64);
    expect(iconRequests(s.calls)).toHaveLength(1);
  });

  it("a tampered cache file is deleted and fetched again", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const { c, dir } = await client(s.fetch);
    await c.discover();
    await c.presentationIcon({ px: 32 });
    writeFileSync(join(dir, sha(W64)), "tampered");
    expect(await c.presentationIcon({ px: 32 })).toEqual(W64);
    expect(iconRequests(s.calls)).toHaveLength(2);
    expect(readFileSync(join(dir, sha(W64)))).toEqual(Buffer.from(W64));
  });

  it("each discovery prunes the files the member no longer names, and the cap holds", async () => {
    let doc: unknown = discoveryDoc(presentation());
    const s = server(icons(), () => doc);
    const { c, dir } = await client(s.fetch);
    await c.discover();
    await c.presentationIcon({ px: 32 });
    await c.presentationIcon({ px: 100 });
    await c.presentationIcon({ px: 32, decodable: ["image/png"] });
    expect(readdirSync(dir).sort()).toEqual(
      [sha(PNG), sha(W64), sha(W128), PRESENTATION_MEMBER_FILE].sort(),
    );
    // Junk and an interrupted write go at the next discovery, with the files not named.
    writeFileSync(join(dir, "f".repeat(64)), "old");
    writeFileSync(join(dir, `${sha(W64)}.abcd.tmp`), "partial");
    doc = discoveryDoc(
      presentation({
        icon: { ...presentation().icon, url: undefined, sizes: [] },
      }),
    );
    await c.discover();
    expect(readdirSync(dir).sort()).toEqual(
      [sha(PNG), PRESENTATION_MEMBER_FILE].sort(),
    );
    doc = discoveryDoc(undefined);
    await c.discover();
    expect(readdirSync(dir)).toEqual([]);
  });

  it(`keeps at most PRESENTATION_CACHE_MAX_FILES (${PRESENTATION_CACHE_MAX_FILES}) icon files, oldest first`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-presentation-"));
    const blobs = Array.from(
      { length: PRESENTATION_CACHE_MAX_FILES + 2 },
      (_, i) => new TextEncoder().encode(`size-${i}`),
    );
    const member = {
      name: "P",
      icon: {
        sha256: sha(PNG),
        contentType: "image/png",
        original: ORIGINAL,
        url: `${ORIGINAL}/{w}.webp`,
        sizes: blobs.map((b, i) => ({ w: (i + 1) * 10, sha256: sha(b) })),
      },
    };
    const routes: Record<string, () => Response> = {};
    blobs.forEach(
      (b, i) => (routes[`${ORIGINAL}/${(i + 1) * 10}.webp`] = ok(b)),
    );
    const s = server(routes, () => discoveryDoc(member));
    const store = new PresentationStore({
      product: PRODUCT,
      dir,
      fetcher: () => s.fetch,
    });
    await store.accept(discoveryDoc(member));
    for (let i = 0; i < blobs.length; i++) {
      expect(await store.icon((i + 1) * 10, 1)).toEqual(blobs[i]);
      // Distinct mtimes, oldest first.
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(join(dir, sha(blobs[i]!)), t, t);
    }
    const left = await store.cachedFiles();
    expect(left).toHaveLength(PRESENTATION_CACHE_MAX_FILES);
    expect(left.sort()).toEqual(
      blobs
        .slice(-PRESENTATION_CACHE_MAX_FILES)
        .map((b) => sha(b))
        .sort(),
    );
  });

  it("presentation.json carries the member across a cold, offline start", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const first = await client(s.fetch);
    await first.c.discover();
    await first.c.presentationIcon({ px: 32 });
    const file = JSON.parse(
      readFileSync(join(first.dir, PRESENTATION_MEMBER_FILE), "utf8"),
    ) as { v: number; product: string; presentation: unknown };
    expect(file.v).toBe(1);
    expect(file.product).toBe(PRODUCT);
    expect(file.presentation).toEqual(first.c.presentation());

    const offline = server({}, () => new Response("offline", { status: 503 }));
    const second = await client(offline.fetch, first.cacheDir);
    expect(second.c.presentation()).toEqual(first.c.presentation());
    // The cached icon serves the cold start too, re-hashed, with no fetch.
    expect(await second.c.presentationIcon({ px: 32 })).toEqual(W64);
    expect(offline.calls).toEqual([]);
  });

  it("a presentation.json that is not this SDK's normal form, or names another product, is deleted", async () => {
    const s = server(icons(), () => discoveryDoc(presentation()));
    const first = await client(s.fetch);
    await first.c.discover();
    const path = join(first.dir, PRESENTATION_MEMBER_FILE);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      presentation: Record<string, unknown>;
    };
    for (const bad of [
      {
        ...written,
        presentation: { ...written.presentation, accent: "#ABCDEF" },
      },
      { ...written, presentation: { ...written.presentation, extra: 1 } },
      { ...written, product: "other" },
      { ...written, v: 2 },
      "not json",
    ]) {
      writeFileSync(path, typeof bad === "string" ? bad : JSON.stringify(bad));
      const again = await client(s.fetch, first.cacheDir);
      expect(again.c.presentation()).toBeNull();
      expect(existsSync(path)).toBe(false);
    }
  });

  it("this session's discovery wins over a slower cold-boot read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-presentation-"));
    const a = new PresentationStore({
      product: PRODUCT,
      dir,
      fetcher: () => fetch,
    });
    await a.accept(discoveryDoc(presentation({ name: "Stored" })));
    const b = new PresentationStore({
      product: PRODUCT,
      dir,
      fetcher: () => fetch,
    });
    await b.accept(discoveryDoc(presentation({ name: "Fresh" })));
    // Another process rewrites the file meanwhile; this session's discovery still wins.
    await a.accept(discoveryDoc(presentation({ name: "Stored" })));
    await b.load();
    expect(b.current()?.name).toBe("Fresh");
  });
});
