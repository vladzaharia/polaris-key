// `pkey bundle` — the CLI half of the offline activation bundle mint.
//
// ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────────────────────
//
// The command is a ONE-call client of an authenticated admin API, so the things worth pinning
// are the things that are invisible when they break:
//
//   * the CALL and its credential — a single POST bearing `Authorization: Bearer pkeya_…`, with
//     NO cookie, NO `X-PKey-CSRF` and NO `/manage/api/me` pre-flight. Each of those is a thing
//     the command used to do, and a regression that put one back would look like working code:
//     it would still mint, just with a browser credential the platform no longer wants it to
//     hold. So their ABSENCE is asserted, not merely unmentioned.
//   * the REQUEST BODY, byte for byte. `includeConfig` is omitted when it is true (the server
//     defaults it) and sent only to turn config OFF, so "sends the field" and "sends the right
//     field" are different assertions.
//   * the REFUSALS THAT COST NOTHING. A bad device id, an out-of-range grace window, a missing
//     flag, a plaintext `--base-url`, or a `PKEY_ADMIN_TOKEN` that is unset or the wrong shape
//     must produce a message with ZERO network calls made — an operator pasting a device id off
//     an air-gapped screen should not learn about a typo from a server round trip, the server
//     collapses every bad token into one uninformative 401, and a mint is an audited event that
//     should not be attempted with input we already know is wrong.
//   * the FILE'S PERMISSIONS AND THE SYMLINK REFUSAL. A bundle is a signed credential-bearing
//     artifact: 0600, and `O_NOFOLLOW` rather than whatever a planted link points at.
//
// Every network test drives the real `runPkey` entrypoint with `fetch` stubbed globally, so
// flag parsing, the env read and the exit code are all under test rather than just the module.
// `mintBundle`'s own `fetchImpl` seam (the repo-wide pattern from
// `packages/sdk-node/src/discovery.ts`) is pinned separately at the bottom.

import { existsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_ENV, mintBundle, runPkey } from "../src/index.js";

const PRODUCT = "acme";
/** 32 base64url characters — the shape wire v3 §6 fixes and `console/handlers/bundles.ts` enforces. */
const DEVICE = "AbCdEfGh0123456789_-ijKLmnOPqrst";
/** `pkeya_` + 43 base64url characters — the shape the Worker accepts for an admin API token. */
const TOKEN = "pkeya_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
/** What an operator used to export, and what a muscle-memory paste still produces. */
const COOKIE = "__Host-pkey_admin=session-token-value";
const BUNDLE_ID = "01JQ8Z9K3M4N5P6Q7R8S9T0V1W";
const JWS = "eyJhbGciOiJFZERTQSJ9.eyJidW5kbGVJZCI6IjAxSlEifQ.c2lnbmF0dXJl";
const ORIGIN = "https://key.example";
const DEFAULT_FILE = `${PRODUCT}-AbCdEfGh.pkeybundle`;

const POSIX = process.platform !== "win32";

const dirs: string[] = [];
/** Undefined until a test sets it; restored (or deleted) after every test. */
let savedToken: string | undefined;
let tokenTouched = false;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-bundle-"));
  dirs.push(dir);
  return dir;
}

/** Set (or, with `undefined`, unset) PKEY_ADMIN_TOKEN for one test only. */
function setTokenEnv(value: string | undefined): void {
  if (!tokenTouched) {
    savedToken = process.env[ADMIN_TOKEN_ENV];
    tokenTouched = true;
  }
  if (value === undefined) delete process.env[ADMIN_TOKEN_ENV];
  else process.env[ADMIN_TOKEN_ENV] = value;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (tokenTouched) {
    if (savedToken === undefined) delete process.env[ADMIN_TOKEN_ENV];
    else process.env[ADMIN_TOKEN_ENV] = savedToken;
    tokenTouched = false;
    savedToken = undefined;
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

/** The happy server. Anything that is not the mint is a 404, so a resurrected pre-flight would
 *  fail loudly rather than being quietly answered. */
function server(overrides: { mint?: Response } = {}): Mock {
  return mockFetch((url) => {
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
  it("POSTs the mint with an Authorization: Bearer token and the exact body", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(0);

    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.url).toBe(
      `${ORIGIN}/manage/api/products/${PRODUCT}/bundles`,
    );
    expect(m.calls[0]?.method).toBe("POST");
    expect(m.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(m.calls[0]?.headers.get("content-type")).toBe("application/json");
    // `includeConfig` is ABSENT when it is true — the server defaults it, and sending it would
    // pin a default this CLI does not own.
    expect(m.calls[0]?.body).toBe(
      JSON.stringify({ deviceId: DEVICE, graceDays: 30 }),
    );

    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(JWS);
    expect(io.out()).toContain(BUNDLE_ID);
    expect(io.out()).toContain(DEFAULT_FILE);
    expect(io.out()).toContain("30 days offline");
    expect(io.out()).toContain("transfer this file to the offline machine");
    expect(io.err()).toBe("");
  });

  it("sends no cookie and no X-PKey-CSRF header — the token is not a browser credential", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...capture() })).toBe(0);

    // A token-authenticated request is CSRF-exempt: an `Authorization` header
    // is not ambient, so there is nothing for a cross-site page to forge. Sending either header
    // anyway would mean the CLI still holds a browser credential it has no business holding.
    expect(m.calls[0]?.headers.get("cookie")).toBeNull();
    expect(m.calls[0]?.headers.get("x-pkey-csrf")).toBeNull();
    expect(m.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("makes exactly ONE call — there is no /manage/api/me pre-flight", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...capture() })).toBe(0);

    expect(m.calls).toHaveLength(1);
    expect(m.calls.some((c) => c.url.endsWith("/manage/api/me"))).toBe(false);
  });

  it("sends includeConfig:false for --no-config", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(await runPkey(argv("--no-config"), { cwd, ...capture() })).toBe(0);

    expect(m.calls[0]?.body).toBe(
      JSON.stringify({
        deviceId: DEVICE,
        graceDays: 30,
        includeConfig: false,
      }),
    );
  });

  it("sends licenseId for --license", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(
      await runPkey(argv("--license", "lic_123"), { cwd, ...capture() }),
    ).toBe(0);

    expect(m.calls[0]?.body).toBe(
      JSON.stringify({
        deviceId: DEVICE,
        graceDays: 30,
        licenseId: "lic_123",
      }),
    );
  });

  it("strips trailing slashes from --base-url and percent-encodes the slug", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
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

    // Encoded, so a slug can never add a path segment of its own.
    expect(m.calls[0]?.url).toBe(
      `${ORIGIN}/manage/api/products/..%2Fadmin/bundles`,
    );
  });

  it("defaults --base-url to the production origin", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
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

    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.url).toBe(
      `https://key.plrs.im/manage/api/products/${PRODUCT}/bundles`,
    );
  });
});

// ── The base URL is where the token goes ────────────────────────────────────────────────────
// `--base-url` decides who receives a full-authority bearer credential, so it is an
// allow-list (https, or http on loopback for `wrangler dev`) and not a free-text field. Same
// rule and same host set as `normalizeBaseUrl` in `packages/sdk-node/src/core/context.ts`.
describe("pkey bundle — the --base-url allow-list", () => {
  it.each([
    ["http://127.0.0.1:8787", "127.0.0.1"],
    ["http://localhost:8787", "localhost"],
    ["https://key.example", "an https origin"],
  ])("accepts %s (%s)", async (base) => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
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
          "--base-url",
          base,
        ],
        { cwd, ...capture() },
      ),
    ).toBe(0);

    expect(m.calls[0]?.url).toBe(
      `${base}/manage/api/products/${PRODUCT}/bundles`,
    );
  });

  it("refuses a plaintext non-loopback --base-url without calling it", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(
      await runPkey(argv().slice(0, -1).concat("http://evil.example"), {
        cwd,
        ...io,
      }),
    ).toBe(1);

    expect(io.err()).toContain("--base-url must be https:");
    expect(io.err()).toContain("http://evil.example");
    expect(io.err()).toContain("localhost/127.0.0.1");
    // The refusal is the point: the token must never leave the machine over plaintext, not even
    // once, so this cannot be a post-hoc complaint about a request already sent.
    expect(m.calls).toHaveLength(0);
  });

  it("refuses a --base-url that is not a URL at all", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    const m = stub(server());

    expect(
      await runPkey(argv().slice(0, -1).concat("key.plrs.im"), { cwd, ...io }),
    ).toBe(1);

    expect(io.err()).toContain("--base-url is not a valid URL");
    expect(m.calls).toHaveLength(0);
  });
});

// ── The output file ─────────────────────────────────────────────────────────────────────────
describe("pkey bundle — the output file", () => {
  it("names the file <product>-<first 8 of device>.pkeybundle by default", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(0);

    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(JWS);
    // Reported RELATIVE to the cwd the handler was given, not to process.cwd().
    expect(io.out()).toContain(`- File: ${DEFAULT_FILE}\n`);
  });

  it("honours --out, resolving it against the handler's cwd", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
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

  it.skipIf(!POSIX)("creates the bundle mode 0600, not 0644", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
    stub(server());

    expect(await runPkey(argv(), { cwd, ...capture() })).toBe(0);

    // The bundle carries signed licence, config and trust documents; the default
    // `writeFile` mode made every one of them readable by every account on the machine.
    expect(statSync(path.join(cwd, DEFAULT_FILE)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing file, and mints nothing when it refuses", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
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

  it("overwrites with --force, and tightens the mode it inherited", async () => {
    const cwd = await tempDir();
    setTokenEnv(TOKEN);
    stub(server());
    await writeFile(path.join(cwd, DEFAULT_FILE), "an earlier bundle", "utf8");

    expect(await runPkey(argv("--force"), { cwd, ...capture() })).toBe(0);

    expect(await readFile(path.join(cwd, DEFAULT_FILE), "utf8")).toBe(JWS);
    // `O_TRUNC` does not touch an existing file's mode, so the 0644 the earlier write left
    // behind would otherwise survive underneath a freshly-minted credential.
    if (POSIX)
      expect(statSync(path.join(cwd, DEFAULT_FILE)).mode & 0o777).toBe(0o600);
  });

  // `O_NOFOLLOW` is what these pin, and Windows does not have it — `fs.constants.O_NOFOLLOW` is
  // undefined there and the guard degrades to 0 by design (see `NOFOLLOW` in bundle.ts).
  it.skipIf(!POSIX)(
    "refuses a symlink at the output path instead of following it",
    async () => {
      const cwd = await tempDir();
      const outside = await tempDir();
      const io = capture();
      setTokenEnv(TOKEN);
      const m = stub(server());

      const target = path.join(outside, "someone-elses-file");
      await writeFile(target, "not the bundle", "utf8");
      symlinkSync(target, path.join(cwd, DEFAULT_FILE));

      expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

      expect(io.err()).toContain("already exists");
      // The whole point: the write went nowhere, least of all to the link's target.
      expect(await readFile(target, "utf8")).toBe("not the bundle");
      expect(m.calls).toHaveLength(0);
    },
  );

  it.skipIf(!POSIX)(
    "still refuses a symlink with --force — the flag means overwrite, not follow",
    async () => {
      const cwd = await tempDir();
      const outside = await tempDir();
      const io = capture();
      setTokenEnv(TOKEN);
      stub(server());

      const target = path.join(outside, "someone-elses-file");
      await writeFile(target, "not the bundle", "utf8");
      symlinkSync(target, path.join(cwd, DEFAULT_FILE));

      // `--force` skips the pre-mint check, so this is `O_NOFOLLOW` and nothing else refusing.
      expect(await runPkey(argv("--force"), { cwd, ...io })).toBe(1);

      expect(io.err()).toContain("symbolic link");
      expect(await readFile(target, "utf8")).toBe("not the bundle");
    },
  );

  it.skipIf(!POSIX)(
    "refuses a dangling symlink without creating the path it points at",
    async () => {
      const cwd = await tempDir();
      const outside = await tempDir();
      const io = capture();
      setTokenEnv(TOKEN);
      stub(server());

      // The target does not exist, so the pre-mint `stat` sees ENOENT and lets the mint
      // through: only `O_EXCL | O_NOFOLLOW` stands between the bundle and a file it would have
      // created wherever the link points.
      const target = path.join(outside, "planted");
      symlinkSync(target, path.join(cwd, DEFAULT_FILE));

      expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

      expect(io.err()).toContain("already exists");
      expect(existsSync(target)).toBe(false);
    },
  );

  it("loses the race to a file that appears while the mint is in flight", async () => {
    const cwd = await tempDir();
    const file = path.join(cwd, DEFAULT_FILE);
    // The file does not exist when the pre-mint check runs and does by the time the answer
    // arrives: the window a check-then-write cannot close and `O_EXCL` does.
    const m = mockFetch(() => {
      writeFileSync(file, "written by someone else", "utf8");
      return json(200, { bundleId: BUNDLE_ID, bundle: JWS });
    });

    await expect(
      mintBundle({
        cwd,
        product: PRODUCT,
        deviceId: DEVICE,
        graceDays: 14,
        baseUrl: ORIGIN,
        token: TOKEN,
        fetchImpl: m.impl,
      }),
    ).rejects.toThrow(/already exists.*--force/);

    expect(m.calls).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe("written by someone else");
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
    setTokenEnv(TOKEN);
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
      setTokenEnv(TOKEN);
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
    setTokenEnv(TOKEN);
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

  it("names PKEY_ADMIN_TOKEN and how to get it when it is unset", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(undefined);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("PKEY_ADMIN_TOKEN is not set");
    expect(io.err()).toContain("API tokens");
    expect(io.err()).toContain("Authorization: Bearer");
    expect(m.calls).toHaveLength(0);
  });

  it("refuses a pasted cookie VALUE instead of spending a 401 on it", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(COOKIE);
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    // The server answers ONE 401 for malformed / unknown / revoked / expired, so it cannot tell
    // an operator which; the shape is knowable here, so it is said here.
    expect(io.err()).toContain("does not look like an admin API token");
    expect(io.err()).toContain("session cookie is a DIFFERENT credential");
    expect(m.calls).toHaveLength(0);
    // And the value itself is never echoed back into a terminal or a CI log.
    expect(io.err()).not.toContain("session-token-value");
  });

  it("refuses a truncated token without calling the server", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN.slice(0, 20));
    const m = stub(server());

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("does not look like an admin API token");
    expect(io.err()).toContain("got 20 characters");
    expect(m.calls).toHaveLength(0);
  });
});

// ── Server failures ─────────────────────────────────────────────────────────────────────────
// The admin API always says something; a bare status is never the best this CLI can do.
describe("pkey bundle — server failures", () => {
  it("surfaces a 400's message, code and fields", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
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

  it("blames the API token for a 401 on the mint", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    const m = stub(
      server({ mint: apiError(401, "unauthorized", "no session") }),
    );

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("PKEY_ADMIN_TOKEN");
    expect(io.err()).toContain("unknown, revoked and expired alike");
    expect(io.err()).toContain("API tokens");
    expect(m.calls).toHaveLength(1);
  });

  it("names both the scope and the platform-admin gate for a 403 on the mint", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    stub(
      server({
        mint: apiError(403, "forbidden", "token is not scoped for this route"),
      }),
    );

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    // Both causes answer 403 and look identical from the client, so the hint names both.
    expect(io.err()).toContain("bundles:mint");
    expect(io.err()).toContain("platform admin");
  });

  it("reports a non-JSON body rather than a bare status", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    stub(
      server({
        mint: new Response("<html>captive portal</html>", { status: 502 }),
      }),
    );

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("502");
    expect(io.err()).toContain("captive portal");
  });

  it("names the host when the transport never reaches it", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain(
      `Could not reach ${ORIGIN}/manage/api/products/${PRODUCT}/bundles`,
    );
  });

  it("refuses a 200 that carries no bundle", async () => {
    const cwd = await tempDir();
    const io = capture();
    setTokenEnv(TOKEN);
    stub(server({ mint: json(200, { bundleId: BUNDLE_ID }) }));

    expect(await runPkey(argv(), { cwd, ...io })).toBe(1);

    expect(io.err()).toContain("without a bundle");
  });
});

// ── The injected-fetch seam ─────────────────────────────────────────────────────────────────
// `mintBundle` never reads `process.env` and never touches the global fetch, so it is usable
// (and testable) without stubbing anything at all.
describe("mintBundle — the fetchImpl seam", () => {
  it("mints with an injected fetch and an explicitly passed token", async () => {
    const cwd = await tempDir();
    const m = mockFetch(() => json(200, { bundleId: BUNDLE_ID, bundle: JWS }));

    const result = await mintBundle({
      cwd,
      product: PRODUCT,
      deviceId: DEVICE,
      graceDays: 14,
      baseUrl: ORIGIN,
      token: TOKEN,
      fetchImpl: m.impl,
    });

    expect(result.bundleId).toBe(BUNDLE_ID);
    expect(result.bundle).toBe(JWS);
    expect(result.file).toBe(path.join(cwd, DEFAULT_FILE));
    expect(result.graceDays).toBe(14);
    expect(result.url).toBe(`${ORIGIN}/manage/api/products/${PRODUCT}/bundles`);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(await readFile(result.file, "utf8")).toBe(JWS);
  });

  it("rejects before the first call when the token argument is empty", async () => {
    const cwd = await tempDir();
    const m = mockFetch(() => json(200, { bundleId: BUNDLE_ID, bundle: JWS }));

    await expect(
      mintBundle({
        cwd,
        product: PRODUCT,
        deviceId: DEVICE,
        graceDays: 14,
        token: "   ",
        fetchImpl: m.impl,
      }),
    ).rejects.toThrow(/PKEY_ADMIN_TOKEN is not set/);
    expect(m.calls).toHaveLength(0);
  });
});
