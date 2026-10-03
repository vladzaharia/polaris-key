/**
 * fix/connector-hardening — every store-API client and token exchange refuses redirects and reads
 * a bounded body, to the standard P5-04 set for the Microsoft Store connector:
 *
 *   - a 302 / 307 from the API is a failure in that connector's error model, and nothing is ever
 *     sent to the `Location` (driven through the real runtime `fetch` against a loopback server,
 *     so a client that dropped `redirect: "manual"` would be caught following it);
 *   - an oversized streamed body (no `Content-Length`) and an oversized declared `Content-Length`
 *     are refused as the connector's "unreadable answer";
 *   - the Google token endpoint answering a redirect fails the exchange before any API call.
 *
 * App Store Connect has no token exchange (the bearer is a locally signed ES256 JWT), so the
 * token-redirect case applies to Google (Play) here and to Entra in `msstore.test.ts`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AscClient,
  AscError,
  ascPath,
  MAX_RESPONSE_BYTES as ASC_MAX,
} from "../src/services/distribution/connectors/asc/client.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  GoogleApiClient,
  MAX_RESPONSE_BYTES as PLAY_MAX,
  PlayError,
} from "../src/services/distribution/connectors/play/client.js";
import { MsStoreClient } from "../src/services/distribution/connectors/msstore/client.js";
import { MAX_GOOGLE_TOKEN_RESPONSE_BYTES } from "../src/core/outletTokens.js";
import { isRedirect } from "../src/core/readCapped.js";
import { loadProductPublic } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { pollConnectors } from "../src/services/distribution/connectors/index.js";
import {
  playWorld,
  NOW,
  PLAY_PACKAGE,
  SLUG,
  type PlayWorld,
} from "./playWorld.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// ── A loopback server: `/redirect/<status>` answers that redirect to `/stolen` ───────────────

let server: Server;
let base = "";
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const m = /\/redirect-(30[0-8])\b/.exec(path);
    if (m) {
      res.writeHead(Number(m[1]), { location: `${base}/stolen` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hits.length = 0;
});

/** The real runtime fetch, with the store origin swapped for the loopback server. */
function loopback(seen: RequestInit[]): Fetch {
  return (input, init) => {
    seen.push(init ?? {});
    const u = new URL(input);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  };
}

/** A body streamed in 256 KiB chunks up to `total` bytes, with no `Content-Length`; `pulled`
 *  counts the chunks the reader asked for, so the test can see the read stopped at the cap. */
function streamed(total: number): { res: Response; pulled: () => number } {
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  let sent = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (sent >= total) return c.close();
      c.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
  return { res: new Response(body, { status: 200 }), pulled: () => pulls };
}

const declared = (bytes: number) =>
  new Response("{}", {
    status: 200,
    headers: { "content-length": String(bytes) },
  });

const stolen = () => hits.filter((h) => h === "/stolen");

describe("isRedirect", () => {
  it("is every 3xx and an opaque redirect, and nothing else", () => {
    for (const s of [300, 301, 302, 303, 307, 308])
      expect(isRedirect(new Response(null, { status: s }))).toBe(true);
    for (const s of [200, 204, 404, 500])
      expect(isRedirect(new Response(null, { status: s }))).toBe(false);
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    expect(isRedirect(opaque)).toBe(true);
  });
});

// ── App Store Connect ────────────────────────────────────────────────────────────────────────

describe("App Store Connect client", () => {
  const asc = (fetchImpl: Fetch) =>
    new AscClient({ token: async () => "asc-bearer", fetchImpl });

  it.each([302, 307])(
    "a %i from the API is refused as an AscError, and nothing reaches the Location",
    async (status) => {
      const seen: RequestInit[] = [];
      const err = await asc(loopback(seen))
        .get(ascPath("apps", `redirect-${status}`))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AscError);
      expect((err as AscError).status).toBe(status);
      expect((err as AscError).message).not.toContain("asc-bearer");
      expect(seen.map((i) => i.redirect)).toEqual(["manual"]);
      expect(hits).toEqual([`/v1/apps/redirect-${status}`]);
      expect(stolen()).toEqual([]);
    },
  );

  it("every method sends redirect: manual", async () => {
    const seen: RequestInit[] = [];
    const c = asc(loopback(seen));
    await c.get(ascPath("apps", "a1"));
    await c.patch(ascPath("apps", "a1"), { data: {} });
    await c.post(ascPath("apps"), { data: {} });
    expect(seen.map((i) => i.redirect)).toEqual(["manual", "manual", "manual"]);
  });

  it("an oversized streamed body is AscError(502), and the read stops at the cap", async () => {
    const { res, pulled } = streamed(ASC_MAX * 2);
    await expect(
      asc(async () => res).get(ascPath("apps", "a1")),
    ).rejects.toThrow("App Store Connect GET /v1/apps/a1: HTTP 502");
    expect(pulled() * 256 * 1024).toBeLessThanOrEqual(ASC_MAX + 2 * 256 * 1024);
  });

  it("an oversized Content-Length is AscError(502)", async () => {
    await expect(
      asc(async () => declared(ASC_MAX + 1)).get(ascPath("apps", "a1")),
    ).rejects.toThrow("HTTP 502");
  });

  it("a body that is not a JSON object is AscError(502); 204 is null", async () => {
    for (const body of ["null", "[1]", "7", "{"])
      await expect(
        asc(async () => new Response(body, { status: 200 })).get(
          ascPath("apps", "a1"),
        ),
      ).rejects.toThrow("HTTP 502");
    expect(
      await asc(async () => new Response(null, { status: 204 })).get(
        ascPath("apps", "a1"),
      ),
    ).toBeNull();
  });
});

// ── Google Play ──────────────────────────────────────────────────────────────────────────────

describe("Google Play client", () => {
  const play = (fetchImpl: Fetch) =>
    new GoogleApiClient({
      origin: ANDROID_PUBLISHER_ORIGIN,
      packageName: PLAY_PACKAGE,
      token: async () => "play-bearer",
      fetchImpl,
    });

  it.each([302, 307])(
    "a %i from the API is refused as a PlayError, and nothing reaches the Location",
    async (status) => {
      const seen: RequestInit[] = [];
      const err = await play(loopback(seen))
        .request("GET", ["edits", `redirect-${status}`], "edits.get")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlayError);
      expect((err as PlayError).status).toBe(status);
      expect((err as PlayError).message).not.toContain("play-bearer");
      expect(seen.map((i) => i.redirect)).toEqual(["manual"]);
      expect(hits).toHaveLength(1);
      expect(stolen()).toEqual([]);
    },
  );

  it("an oversized streamed body is PlayError(502), and the read stops at the cap", async () => {
    const { res, pulled } = streamed(PLAY_MAX * 2);
    await expect(
      play(async () => res).request("GET", ["edits", "1"], "edits.get"),
    ).rejects.toThrow("Google Play GET edits.get: HTTP 502");
    expect(pulled() * 256 * 1024).toBeLessThanOrEqual(
      PLAY_MAX + 2 * 256 * 1024,
    );
  });

  it("an oversized Content-Length is PlayError(502)", async () => {
    await expect(
      play(async () => declared(PLAY_MAX + 1)).request(
        "GET",
        ["edits", "1"],
        "edits.get",
      ),
    ).rejects.toThrow("HTTP 502");
  });
});

// ── Microsoft Store (the reference), through the real runtime fetch ──────────────────────────

describe("Microsoft Store client", () => {
  it.each([302, 307])("a %i never reaches the Location", async (status) => {
    const seen: RequestInit[] = [];
    const c = new MsStoreClient({
      applicationId: "9NBLGGH4R315",
      token: async () => "ms-bearer",
      fetchImpl: loopback(seen),
    });
    await expect(c.get([`redirect-${status}`], "probe")).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(stolen()).toEqual([]);
    expect(seen.every((i) => i.redirect === "manual")).toBe(true);
  });
});

// ── The Google token exchange (through the Play poll) ────────────────────────────────────────

describe("Google token exchange", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function pollDirect(w: PlayWorld) {
    const product = (await loadProductPublic(w.db, SLUG))!;
    const hooks = buildHooks(SERVICES, product.services, {
      env: w.env,
      db: w.db,
      product,
      now: NOW,
    });
    const outcomes = await pollConnectors({
      env: w.env,
      db: w.db,
      product,
      hooks,
      now: NOW,
      fetchImpl: w.fetchImpl,
      sleep: async () => undefined,
    });
    return outcomes.find((o) => o.connector === "play")!;
  }

  /** Answer the token endpoint with `answer`; everything else goes to the fakes. */
  async function withToken(answer: () => Response) {
    const w = await playWorld();
    const tokenInits: RequestInit[] = [];
    const other: string[] = [];
    const inner = w.fetchImpl;
    w.fetchImpl = async (input, init) => {
      const host = new URL(input).hostname;
      if (host === "oauth2.googleapis.com") {
        tokenInits.push(init!);
        return answer();
      }
      if (!host.endsWith("googleapis.com")) other.push(input);
      return inner(input, init);
    };
    return { w, tokenInits, other };
  }

  it.each([302, 307])(
    "a %i from the token endpoint fails the exchange, and no API call is made",
    async (status) => {
      const { w, tokenInits, other } = await withToken(
        () =>
          new Response(null, {
            status,
            headers: { location: "https://evil.example/token" },
          }),
      );
      const outcome = await pollDirect(w);
      expect(outcome.error).toBe(`google token exchange failed: ${status}`);
      expect(tokenInits.map((i) => i.redirect)).toEqual(["manual"]);
      expect(w.fake.requests).toEqual([]);
      expect(other.filter((u) => u.includes("evil.example"))).toEqual([]);
    },
  );

  it("an oversized token body (streamed or declared) fails the exchange, and no API call is made", async () => {
    for (const answer of [
      () => streamed(MAX_GOOGLE_TOKEN_RESPONSE_BYTES * 4).res,
      () => declared(MAX_GOOGLE_TOKEN_RESPONSE_BYTES + 1),
    ]) {
      const { w } = await withToken(answer);
      const outcome = await pollDirect(w);
      expect(outcome.error).toBe("google token exchange returned no JSON");
      expect(w.fake.requests).toEqual([]);
    }
  });

  it("a token body that is not a JSON object is 'no token', not a crash", async () => {
    for (const body of ["null", "[]", "42"]) {
      const { w } = await withToken(() => new Response(body, { status: 200 }));
      const outcome = await pollDirect(w);
      expect(outcome.error).toBe("google token exchange returned no token");
      expect(w.fake.requests).toEqual([]);
    }
  });
});
