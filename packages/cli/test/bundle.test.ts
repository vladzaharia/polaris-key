// `pkey bundle` — the CLI half of the offline activation bundle mint.
//
// ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────────────────────
//
// The command is a two-call client of an authenticated admin API, so the things worth pinning
// are the things that are invisible when they break:
//
//   * the CALL SEQUENCE and its credentials — `/manage/api/me` first for the session's CSRF
//     token, then the mint, with the cookie on both and `X-PKey-CSRF` echoed on the POST. A
//     CLI that skipped the first call would fail only against a live server, as a 403.
//   * the REQUEST BODY, byte for byte. `includeConfig` is omitted when it is true (the server
//     defaults it) and sent only to turn config OFF, so "sends the field" and "sends the right
//     field" are different assertions.
//   * the REFUSALS THAT COST NOTHING. A bad device id, an out-of-range grace window, a missing
//     flag, or an unset PKEY_ADMIN_COOKIE must produce a message with ZERO network calls made —
//     an operator pasting a device id off an air-gapped screen should not learn about a typo
//     from a server round trip, and a mint is an audited event that should not be attempted
//     with input we already know is wrong.
//
// Every network test drives the real `runPkey` entrypoint with `fetch` stubbed globally, so
// flag parsing, the env read and the exit code are all under test rather than just the module.
// `mintBundle`'s own `fetchImpl` seam (the repo-wide pattern from
// `packages/sdk-node/src/discovery.ts`) is pinned separately at the bottom.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE_ENV, mintBundle, runPkey } from "../src/index.js";

const PRODUCT = "acme";
/** 32 base64url characters — the shape wire v3 §6 fixes and `console/handlers/bundles.ts` enforces. */
const DEVICE = "AbCdEfGh0123456789_-ijKLmnOPqrst";
const COOKIE = "__Host-pkey_admin=session-token-value";
const CSRF = "csrf-token-abc123";
const BUNDLE_ID = "01JQ8Z9K3M4N5P6Q7R8S9T0V1W";
const JWS = "eyJhbGciOiJFZERTQSJ9.eyJidW5kbGVJZCI6IjAxSlEifQ.c2lnbmF0dXJl";
const ORIGIN = "https://key.example";
const DEFAULT_FILE = `${PRODUCT}-AbCdEfGh.pkeybundle`;

/** `/manage/api/me`'s body, as `console/handlers/me.ts` builds it. */
const ME = {
  sub: "op@example.com",
  name: "Op Erator",
  email: "op@example.com",
  csrf: CSRF,
  platformAdmin: true,
  products: [{ slug: PRODUCT, name: "Acme", schemaVersion: 3 }],
};

const dirs: string[] = [];
/** Undefined until a test sets it; restored (or deleted) after every test. */
let savedCookie: string | undefined;
let cookieTouched = false;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-bundle-"));
  dirs.push(dir);
  return dir;
}

/** Set (or, with `undefined`, unset) PKEY_ADMIN_COOKIE for one test only. */
function setCookieEnv(value: string | undefined): void {
  if (!cookieTouched) {
    savedCookie = process.env[ADMIN_COOKIE_ENV];
    cookieTouched = true;
  }
  if (value === undefined) delete process.env[ADMIN_COOKIE_ENV];
  else process.env[ADMIN_COOKIE_ENV] = value;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (cookieTouched) {
    if (savedCookie === undefined) delete process.env[ADMIN_COOKIE_ENV];
    else process.env[ADMIN_COOKIE_ENV] = savedCookie;
    cookieTouched = false;
    savedCookie = undefined;
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function capture(): {
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: (chunk: string) => boolean };
  out: () => string;
  err: () => string;
} {
  let out = "";
  let err = "";
  return {
    stdout: {
      write: (chunk: string) => {
        out += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        err += chunk;
        return true;
      },
    },
    out: () => out,
    err: () => err,
  };
}

interface Call {
  url: string;
  method: string;
  /** A real `Headers`, so assertions are case-insensitive like the wire is. */
  headers: Headers;
  body: string | undefined;
}

interface Mock {
  impl: typeof fetch;
  calls: Call[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The admin API's error envelope (`core/console/respond.ts`): flat AND nested, both populated. */
function apiError(
  status: number,
  code: string,
  message: string,
  fields?: string[],
): Response {
  const extra = fields ? { fields } : {};
  return json(status, {
    error: { code, message, ...extra },
    code,
    message,
    ...extra,
  });
}

/** A fetch that records every call and answers from `handler`. */
function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): Mock {
  const calls: Call[] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** The happy server, with either leg overridable. */
function server(overrides: { me?: Response; mint?: Response } = {}): Mock {
  return mockFetch((url) => {
    if (url.endsWith("/manage/api/me")) return overrides.me ?? json(200, ME);
    if (url.endsWith("/bundles"))
      return overrides.mint ?? json(200, { bundleId: BUNDLE_ID, bundle: JWS });
    return apiError(404, "not_found", "no such route");
  });
}

/** Stub the global fetch and hand back the recorder. */
function stub(mock: Mock): Mock {
  vi.stubGlobal("fetch", mock.impl);
  return mock;
}

/** The flags every happy-path run needs, minus whatever the test is varying. */
function argv(...extra: string[]): string[] {
  return [
    "bundle",
    "--product",
    PRODUCT,
    "--device",
    DEVICE,
    "--grace-days",
    "30",
    "--base-url",
    ORIGIN,
    ...extra,
  ];
}

// ── The request ─────────────────────────────────────────────────────────────────────────────
describe("pkey bundle — the request", () => {
  it("GETs /manage/api/me, then POSTs the mint with the cookie, CSRF header and exact body", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(0);

    expect(m.calls).toHaveLength(2);
    // The CSRF token is bound to the session, so it cannot be derived from the cookie: the
    // /me read is not optional and it must come first.
    expect(m.calls[0]?.url).toBe(`${ORIGIN}/manage/api/me`);
    expect(m.calls[0]?.method).toBe("GET");
    expect(m.calls[0]?.headers.get("cookie")).toBe(COOKIE);

    expect(m.calls[1]?.url).toBe(
      `${ORIGIN}/manage/api/products/${PRODUCT}/bundles`,
    );
    expect(m.calls[1]?.method).toBe("POST");
    expect(m.calls[1]?.headers.get("cookie")).toBe(COOKIE);
    expect(m.calls[1]?.headers.get("x-pkey-csrf")).toBe(CSRF);
    expect(m.calls[1]?.headers.get("content-type")).toBe("application/json");
    // `includeConfig` is ABSENT when it is true — the server defaults it, and sending it would
    // pin a default this CLI does not own.
    expect(m.calls[1]?.body).toBe(
      JSON.stringify({ deviceId: DEVICE, graceDays: 30 }),
    );

    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(JWS);
    expect(io.out()).toContain(BUNDLE_ID);
    expect(io.out()).toContain(DEFAULT_FILE);
    expect(io.out()).toContain("30 days offline");
    expect(io.out()).toContain("transfer this file to the offline machine");
    expect(io.err()).toBe("");
  });

  it("sends includeConfig:false for --no-config", async () => {
    const cwd = await tempDir();
    setCookieEnv(COOKIE);
    const m = stub(server());

    expect(await runPkey(argv("--no-config"), { cwd, ...capture() })).toBe(0);

    expect(m.calls[1]?.body).toBe(
      JSON.stringify({
        deviceId: DEVICE,
        graceDays: 30,
        includeConfig: false,
      }),
    );
  });

  it("sends licenseId for --license", async () => {
    const cwd = await tempDir();
    setCookieEnv(COOKIE);
    const m = stub(server());

    expect(
      await runPkey(argv("--license", "lic_123"), { cwd, ...capture() }),
    ).toBe(0);

    expect(m.calls[1]?.body).toBe(
      JSON.stringify({
        deviceId: DEVICE,
        graceDays: 30,
        licenseId: "lic_123",
      }),
    );
  });

  it("strips trailing slashes from --base-url and percent-encodes the slug", async () => {
    const cwd = await tempDir();
    setCookieEnv(COOKIE);
    const m = stub(server());

    expect(
      await runPkey(
        [
          "bundle",
          "--product",
          "../admin",
          "--device",
          DEVICE,
          "--grace-days",
          "7",
          "--base-url",
          `${ORIGIN}///`,
        ],
        { cwd, ...capture() },
      ),
    ).toBe(0);

    expect(m.calls[0]?.url).toBe(`${ORIGIN}/manage/api/me`);
    // Encoded, so a slug can never add a path segment of its own.
    expect(m.calls[1]?.url).toBe(
      `${ORIGIN}/manage/api/products/..%2Fadmin/bundles`,
    );
  });

  it("defaults --base-url to the production origin", async () => {
    const cwd = await tempDir();
    setCookieEnv(COOKIE);
    const m = stub(server());

    expect(
      await runPkey(
        [
          "bundle",
          "--product",
          PRODUCT,
          "--device",
          DEVICE,
          "--grace-days",
          "30",
        ],
        { cwd, ...capture() },
      ),
    ).toBe(0);

    expect(m.calls[0]?.url).toBe("https://key.plrs.im/manage/api/me");
    expect(m.calls[1]?.url).toBe(
      `https://key.plrs.im/manage/api/products/${PRODUCT}/bundles`,
    );
  });

  it("accepts a bare cookie VALUE and prefixes the cookie name", async () => {
    const cwd = await tempDir();
    setCookieEnv("session-token-value");
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...capture() })).toBe(0);

    expect(m.calls[0]?.headers.get("cookie")).toBe(COOKIE);
  });
});

// ── The output file ─────────────────────────────────────────────────────────────────────────
describe("pkey bundle — the output file", () => {
  it("names the file <product>-<first 8 of device>.pkeybundle by default", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(0);

    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(JWS);
    // Reported RELATIVE to the cwd the handler was given, not to process.cwd().
    expect(io.out()).toContain(`- File: ${DEFAULT_FILE}\n`);
  });

  it("honours --out, resolving it against the handler's cwd", async () => {
    const cwd = await tempDir();
    setCookieEnv(COOKIE);
    stub(server());

    expect(
      await runPkey(argv("--out", "ticket-4471.pkeybundle"), {
        cwd,
        ...capture(),
      }),
    ).toBe(0);

    expect(
      await readFile(path.join(cwd, "ticket-4471.pkeybundle"), "utf8"),
    ).toBe(JWS);
  });

  it("refuses to overwrite an existing file, and mints nothing when it refuses", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    const m = stub(server());
    await writeFile(path.join(cwd, DEFAULT_FILE), "an earlier bundle", "utf8");

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("already exists");
    expect(io.err()).toContain("--force");
    // The collision is knowable before the mint, and a mint is an audited server-side event.
    expect(m.calls).toHaveLength(0);
    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(
      "an earlier bundle",
    );
  });

  it("overwrites with --force", async () => {
    const cwd = await tempDir();
    setCookieEnv(COOKIE);
    stub(server());
    await writeFile(path.join(cwd, DEFAULT_FILE), "an earlier bundle", "utf8");

    expect(await runPkey(argv("--force"), { cwd, ...capture() })).toBe(0);

    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(JWS);
  });
});

// ── Refusals that cost nothing ──────────────────────────────────────────────────────────────
// Every case below must reach the network ZERO times.
describe("pkey bundle — local refusals", () => {
  it.each([
    ["a short device id", ["--device", "tooshort"]],
    [
      "a device id with an illegal character",
      ["--device", `${"a".repeat(31)}!`],
    ],
    ["a 33-character device id", ["--device", "a".repeat(33)]],
  ])("refuses %s without calling the server", async (_label, override) => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    const m = stub(server());

    const code = await runPkey(
      [
        "bundle",
        "--product",
        PRODUCT,
        "--grace-days",
        "30",
        "--base-url",
        ORIGIN,
        ...override,
      ],
      { cwd, ...io },
    );

    expect(code).toBe(1);
    expect(io.err()).toContain("--device must be 32 base64url characters");
    expect(m.calls).toHaveLength(0);
  });

  it.each([
    ["0", "0"],
    ["366", "366"],
    ["a fraction", "1.5"],
    ["not a number", "soon"],
  ])(
    "refuses --grace-days %s without calling the server",
    async (_label, value) => {
      const cwd = await tempDir();
      const io = capture();
      setCookieEnv(COOKIE);
      const m = stub(server());

      const code = await runPkey(
        [
          "bundle",
          "--product",
          PRODUCT,
          "--device",
          DEVICE,
          "--grace-days",
          value,
          "--base-url",
          ORIGIN,
        ],
        { cwd, ...io },
      );

      expect(code).toBe(1);
      expect(io.err()).toContain(
        "--grace-days must be a whole number from 1 to 365",
      );
      expect(m.calls).toHaveLength(0);
    },
  );

  it("prints the usage line when --product is missing", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    const m = stub(server());

    const code = await runPkey(
      ["bundle", "--device", DEVICE, "--grace-days", "30"],
      { cwd, ...io },
    );

    expect(code).toBe(1);
    expect(io.err()).toContain(
      "Usage: pkey bundle --product <slug> --device <id> --grace-days <n>",
    );
    expect(m.calls).toHaveLength(0);
  });

  it("names PKEY_ADMIN_COOKIE and how to get it when it is unset", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(undefined);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("PKEY_ADMIN_COOKIE is not set");
    expect(io.err()).toContain("__Host-pkey_admin");
    expect(io.err()).toContain("Application -> Cookies");
    expect(m.calls).toHaveLength(0);
  });
});

// ── Server failures ─────────────────────────────────────────────────────────────────────────
// The admin API always says something; a bare status is never the best this CLI can do.
describe("pkey bundle — server failures", () => {
  it("surfaces a 400's message, code and fields", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    stub(
      server({
        mint: apiError(
          400,
          "bad_request",
          "licenseId is required when the License service is enabled",
          ["licenseId"],
        ),
      }),
    );

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain(
      "licenseId is required when the License service is enabled",
    );
    expect(io.err()).toContain("400 bad_request");
    expect(io.err()).toContain("fields: licenseId");
  });

  it("blames the session cookie for a 401 on /manage/api/me", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    const m = stub(server({ me: apiError(401, "unauthorized", "no session") }));

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("missing or expired");
    expect(io.err()).toContain("PKEY_ADMIN_COOKIE");
    // The mint is never attempted without a CSRF token.
    expect(m.calls).toHaveLength(1);
  });

  it("mentions CSRF and authorization for a 403 on the mint", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    stub(server({ mint: apiError(403, "forbidden", "csrf") }));

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("authorization or CSRF");
    expect(io.err()).toContain("X-PKey-CSRF");
  });

  it("reports a non-JSON body rather than a bare status", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    stub(
      server({
        me: new Response("<html>captive portal</html>", { status: 502 }),
      }),
    );

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("502");
    expect(io.err()).toContain("captive portal");
  });

  it("names the host when the transport never reaches it", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain(`Could not reach ${ORIGIN}/manage/api/me`);
  });

  it("refuses a 200 that carries no bundle", async () => {
    const cwd = await tempDir();
    const io = capture();
    setCookieEnv(COOKIE);
    stub(server({ mint: json(200, { bundleId: BUNDLE_ID }) }));

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("without a bundle");
  });
});

// ── The injected-fetch seam ─────────────────────────────────────────────────────────────────
// `mintBundle` never reads `process.env` and never touches the global fetch, so it is usable
// (and testable) without stubbing anything at all.
describe("mintBundle — the fetchImpl seam", () => {
  it("mints with an injected fetch and an explicitly passed cookie", async () => {
    const cwd = await tempDir();
    const m = mockFetch((url) =>
      url.endsWith("/manage/api/me")
        ? json(200, ME)
        : json(200, { bundleId: BUNDLE_ID, bundle: JWS }),
    );

    const result = await mintBundle({
      cwd,
      product: PRODUCT,
      deviceId: DEVICE,
      graceDays: 14,
      baseUrl: ORIGIN,
      cookie: COOKIE,
      fetchImpl: m.impl,
    });

    expect(result.bundleId).toBe(BUNDLE_ID);
    expect(result.bundle).toBe(JWS);
    expect(result.file).toBe(path.join(cwd, DEFAULT_FILE));
    expect(result.graceDays).toBe(14);
    expect(result.url).toBe(`${ORIGIN}/manage/api/products/${PRODUCT}/bundles`);
    expect(m.calls).toHaveLength(2);
    expect(await readFile(result.file, "utf8")).toBe(JWS);
  });

  it("rejects before the first call when the cookie argument is empty", async () => {
    const cwd = await tempDir();
    const m = mockFetch(() => json(200, ME));

    await expect(
      mintBundle({
        cwd,
        product: PRODUCT,
        deviceId: DEVICE,
        graceDays: 14,
        cookie: "   ",
        fetchImpl: m.impl,
      }),
    ).rejects.toThrow(/PKEY_ADMIN_COOKIE is not set/);
    expect(m.calls).toHaveLength(0);
  });
});
