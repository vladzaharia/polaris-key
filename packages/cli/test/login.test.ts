import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  memoryStore,
  NoStoreError,
  type CredentialStore,
} from "../src/credentials.js";
import { runPkey } from "../src/index.js";
import type { KeyInput, LoginSeams } from "../src/login.js";

const ORIGIN = "https://key.example";
const TOKEN = `pkeyp_${"Q".repeat(39)}h7Q2`;
const OLD = `pkeyp_${"O".repeat(43)}`;
const CODE = "WDJB-MJHT";
const POLL = `dl_${"a".repeat(43)}`;
const COOKIE = "c".repeat(43);
const FAR = 4_000_000_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Call {
  url: string;
  method: string;
  cookie: string | null;
  auth: string | null;
  redirect: string | undefined;
  body: unknown;
}

const json = (
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const START = (extra: Record<string, unknown> = {}) =>
  json(
    201,
    {
      id: POLL,
      code: CODE,
      approveUrl: "https://evil.example/phish",
      expiresIn: 300,
      interval: 3,
      ...extra,
    },
    {
      "set-cookie": `__Host-pkey_device_login=${COOKIE}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    },
  );
const APPROVED = () =>
  json(200, {
    status: "approved",
    token: TOKEN,
    scope: "admin",
    expiresAt: FAR,
    label: "pkey on laptop",
  });
const PENDING = () =>
  json(200, { status: "pending", expiresIn: 200, interval: 3 });
const ME = () =>
  json(200, {
    name: "Ada Lovelace",
    email: "ada@example.com",
    permissions: { roles: [{ role: "admin", scope: "product:djdl" }] },
  });

/** A fake console: `polls` answers GET /api/device-login/<id> in order (the last repeats). */
function server(
  polls: (() => Response)[],
  opts: { start?: () => Response } = {},
) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const c: Call = {
      url: String(url),
      method: init.method ?? "GET",
      cookie: headers.get("cookie"),
      auth: headers.get("authorization"),
      redirect: init.redirect,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const u = new URL(c.url);
    if (u.pathname === "/api/device-login/start")
      return (opts.start ?? START)();
    if (u.pathname.startsWith("/api/device-login/"))
      return polls[Math.min(n++, polls.length - 1)]!();
    if (u.pathname === "/manage/api/me" && c.method === "GET") return ME();
    if (u.pathname === "/manage/api/me/personal-tokens/current")
      return json(200, {});
    return json(404);
  }) as typeof fetch;
  return { f, calls };
}

function keys() {
  const listeners = new Set<(c: Buffer | string) => void>();
  const raw: boolean[] = [];
  const input: KeyInput = {
    isTTY: true,
    setRawMode: (on) => void raw.push(on),
    on: (_e, cb) => void listeners.add(cb),
    removeListener: (_e, cb) => void listeners.delete(cb),
    resume: () => undefined,
    pause: () => undefined,
  };
  return {
    input,
    raw,
    press: (k: string) => listeners.forEach((l) => l(k)),
    listeners,
  };
}

interface RunOpts {
  env?: Record<string, string>;
  store?: () => Promise<CredentialStore>;
  f: typeof fetch;
  seams?: LoginSeams;
  columns?: number;
}

async function run(argv: string[], o: RunOpts) {
  let out = "";
  let err = "";
  const opened: string[] = [];
  const code = await runPkey(["login", "--base-url", ORIGIN, ...argv], {
    cwd: HERE,
    env: {
      NO_COLOR: "1",
      ...(o.columns ? { PKEY_REDUCED_MOTION: "1" } : {}),
      ...o.env,
    },
    stdout: {
      write: (c: string) => ((out += c), true),
      columns: o.columns,
      isTTY: o.columns !== undefined,
    },
    stderr: {
      write: (c: string) => ((err += c), true),
      columns: o.columns,
      isTTY: o.columns !== undefined,
    },
    fetchImpl: o.f,
    credentialStore: o.store ?? (async () => memoryStore()),
    login: {
      openUrl: async (u) => void opened.push(u),
      platform: "darwin",
      hostname: () => "laptop",
      sleep: async () => undefined,
      ...o.seams,
    },
  });
  return { code, out, err, opened };
}

const noToken = (...s: string[]) => {
  for (const x of s) {
    expect(x).not.toContain(TOKEN);
    expect(x).not.toContain("QQQQ");
    expect(x).not.toContain(COOKIE);
  }
};

describe("pkey login: the flow", () => {
  it("start -> pending -> approved: stores the token, prints who, never the token", async () => {
    const store = memoryStore();
    const { f, calls } = server([PENDING, APPROVED]);
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(0);
    expect(store.entries.get(ORIGIN)).toEqual({ token: TOKEN, expiresAt: FAR });
    expect(calls[0]).toMatchObject({
      url: `${ORIGIN}/api/device-login/start`,
      method: "POST",
      body: {
        purpose: "cli",
        scope: "admin",
        client: { name: "pkey", host: "laptop" },
      },
    });
    expect(calls.map((c) => c.method + " " + new URL(c.url).pathname)).toEqual([
      "POST /api/device-login/start",
      `GET /api/device-login/${POLL}`,
      `GET /api/device-login/${POLL}`,
      "GET /manage/api/me",
    ]);
    expect(r.out).toContain("Polaris Key console · key.example");
    expect(r.out).toContain(
      "Signed in to key.example as Ada Lovelace (ada@example.com)",
    );
    expect(r.out).toContain("Admin (djdl)");
    expect(r.out).toMatch(/pkeyp_…h7Q2 · admin · ends \d{4}-\d{2}-\d{2}/);
    expect(r.out).toContain("Saved in  macOS Keychain\n");
    expect(r.out).toContain("End it with pkey logout.");
    noToken(r.out, r.err);
  });

  it("security: the code is shown with the phishing check, and the link is built here", async () => {
    const { f } = server([APPROVED]);
    const r = await run([], { f });
    expect(r.out).toContain("Check that the code in your browser matches:");
    expect(r.out).toContain(` ${CODE} `);
    const url = `${ORIGIN}/manage/device?code=${CODE}`;
    expect(r.out).toContain(url);
    expect(r.opened).toEqual([url]);
    // The server's own approveUrl is never printed or opened.
    expect(r.out + r.err + r.opened.join()).not.toContain("evil.example");
  });

  it("security: the code is reverse video on a colour terminal", async () => {
    const { f } = server([APPROVED]);
    const r = await run([], {
      f,
      env: { FORCE_COLOR: "1", NO_COLOR: "", TERM: "xterm-256color" },
    });
    expect(r.out).toContain("\x1b[7m\x1b[1m WDJB-MJHT \x1b[22m\x1b[27m");
  });

  it("security: the binding cookie goes only to the poll, on the same origin, and is never printed", async () => {
    const { f, calls } = server([PENDING, APPROVED]);
    const r = await run([], { f });
    const polls = calls.filter((c) =>
      c.url.includes(`/api/device-login/${POLL}`),
    );
    expect(polls.length).toBe(2);
    for (const p of polls) {
      expect(p.cookie).toBe(`__Host-pkey_device_login=${COOKIE}`);
      expect(new URL(p.url).origin).toBe(ORIGIN);
    }
    for (const c of calls.filter((c) => !polls.includes(c)))
      expect(c.cookie).toBeNull();
    noToken(r.out, r.err);
  });

  it("security: a Set-Cookie of another name or shape is not kept", async () => {
    const { f } = server([APPROVED], {
      start: () =>
        json(
          201,
          { id: POLL, code: CODE, expiresIn: 300, interval: 3 },
          {
            "set-cookie": "session=abc; Path=/",
          },
        ),
    });
    const r = await run([], { f });
    expect(r.code).toBe(1);
    expect(r.err).toContain("answered the sign-in start unexpectedly");
  });

  it("security: every request is redirect: manual", async () => {
    const { f, calls } = server([APPROVED]);
    await run([], { f });
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c.redirect).toBe("manual");
  });

  it("security: a redirect from start is refused and nothing more is sent", async () => {
    const { f, calls } = server([APPROVED], {
      start: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        }),
    });
    const r = await run([], { f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("answered with a redirect");
    expect(calls.length).toBe(1);
  });

  it("security: a redirect while polling is refused (the cookie is not carried on)", async () => {
    const { f, calls } = server([
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/" },
        }),
    ]);
    const r = await run([], { f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("answered with a redirect");
    expect(calls.filter((c) => c.url.includes("evil")).length).toBe(0);
    expect(calls.length).toBe(2);
  });

  it("security: a non-https base URL is refused before start; loopback http is accepted", async () => {
    const { f, calls } = server([APPROVED]);
    const bad = await run([], { f }).then(() =>
      runPkey(["login", "--base-url", "http://key.example"], {
        cwd: HERE,
        env: { NO_COLOR: "1" },
        stdout: { write: () => true },
        stderr: { write: () => true },
        fetchImpl: f,
        credentialStore: async () => memoryStore(),
      }),
    );
    expect(bad).toBe(2);
    const before = calls.length;
    let out = "";
    const ok = await runPkey(["login", "--base-url", "http://127.0.0.1:8787"], {
      cwd: HERE,
      env: { NO_COLOR: "1" },
      stdout: { write: (c: string) => ((out += c), true) },
      stderr: { write: () => true },
      fetchImpl: f,
      credentialStore: async () => memoryStore(),
      login: {
        openUrl: async () => undefined,
        platform: "darwin",
        sleep: async () => undefined,
      },
    });
    expect(ok).toBe(0);
    expect(calls.slice(before)[0]!.url).toBe(
      "http://127.0.0.1:8787/api/device-login/start",
    );
    expect(out).toContain("http://127.0.0.1:8787/manage/device?code=");
  });

  it("security: the store is keyed by the origin, not the raw URL", async () => {
    const store = memoryStore();
    const { f, calls } = server([APPROVED]);
    const r = await runPkey(
      ["login", "--base-url", "https://KEY.example/some/path/"],
      {
        cwd: HERE,
        env: { NO_COLOR: "1" },
        stdout: { write: () => true },
        stderr: { write: () => true },
        fetchImpl: f,
        credentialStore: async () => store,
        login: {
          openUrl: async () => undefined,
          platform: "darwin",
          sleep: async () => undefined,
        },
      },
    );
    expect(r).toBe(0);
    expect([...store.entries.keys()]).toEqual([ORIGIN]);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/device-login/start`);
  });

  it("security: under CI it refuses with no network call and no store access", async () => {
    const { f, calls } = server([APPROVED]);
    let touched = false;
    const r = await run([], {
      f,
      env: { CI: "true" },
      store: async () => ((touched = true), memoryStore()),
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "pkey login needs a person; in CI use PKEY_ADMIN_TOKEN",
    );
    expect(calls).toEqual([]);
    expect(touched).toBe(false);
  });

  it("security: the store is opened and probed before start; none means no start", async () => {
    const { f, calls } = server([APPROVED]);
    const r = await run([], {
      f,
      store: async () => {
        throw new NoStoreError();
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("No credential store");
    expect(calls).toEqual([]);
  });

  it("security: a store that will not keep the token gets the new token revoked", async () => {
    const mem = memoryStore();
    const failing: CredentialStore = {
      get: mem.get,
      delete: mem.delete,
      set: () => {
        throw new NoStoreError();
      },
    };
    const { f, calls } = server([APPROVED]);
    const r = await run([], { f, store: async () => failing });
    expect(r.code).toBe(4);
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe(`${ORIGIN}/manage/api/me/personal-tokens/current`);
    expect(del.auth).toBe(`Bearer ${TOKEN}`);
    noToken(r.out, r.err);
  });

  it("security: a write that does not read back is treated as failed and revoked", async () => {
    const mem = memoryStore();
    const lossy: CredentialStore = {
      get: mem.get,
      delete: mem.delete,
      set: () => undefined,
    };
    const { f, calls } = server([APPROVED]);
    const r = await run([], { f, store: async () => lossy });
    expect(r.code).toBe(4);
    expect(r.err).toContain("wouldn't keep the token");
    expect(
      calls.some((c) => c.method === "DELETE" && c.auth === `Bearer ${TOKEN}`),
    ).toBe(true);
  });

  it("security: only a pkeyp_ token is stored; anything else is an unexpected answer", async () => {
    const store = memoryStore();
    const { f } = server([
      () =>
        json(200, {
          status: "approved",
          token: `pkeya_${"A".repeat(43)}`,
          scope: "admin",
          expiresAt: FAR,
        }),
    ]);
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(1);
    expect(store.entries.size).toBe(0);
  });

  it("a second login first ends the token it replaces, at its own origin, before start", async () => {
    const store = memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } });
    const { f, calls } = server([APPROVED]);
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `${ORIGIN}/manage/api/me/personal-tokens/current`,
      auth: `Bearer ${OLD}`,
    });
    expect(calls[1]!.url).toContain("/api/device-login/start");
    expect(store.entries.get(ORIGIN)!.token).toBe(TOKEN);
    expect(r.out + r.err).not.toContain(OLD);
  });

  it("an old token for another origin is not touched", async () => {
    const store = memoryStore({
      "https://other.example": { token: OLD, expiresAt: FAR },
    });
    const { f, calls } = server([APPROVED]);
    await run([], { f, store: async () => store });
    expect(calls.some((c) => c.auth === `Bearer ${OLD}`)).toBe(false);
    expect(store.entries.get("https://other.example")!.token).toBe(OLD);
  });
});

describe("pkey login: the other endings", () => {
  it("denied: a ▲ naming the code and the rerun, exit 4, nothing stored", async () => {
    const store = memoryStore();
    const { f } = server([PENDING, () => json(200, { status: "denied" })]);
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(4);
    expect(r.err).toContain(`▲  Code ${CODE} was denied in the browser.`);
    expect(r.err).toContain("Run pkey login to try again.");
    expect(store.entries.size).toBe(0);
  });

  it("expired (410): names the code and the rerun", async () => {
    const { f } = server([() => json(410, { error: "expired" })]);
    const r = await run([], { f });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Code ${CODE} expired before it was approved.`);
    expect(r.err).toContain("Run pkey login to get a new one.");
  });

  it("expired by the clock when the server stays pending", async () => {
    let t = 0;
    const { f } = server([PENDING]);
    const r = await run([], {
      f,
      seams: { now: () => t, sleep: async (ms) => void (t += ms * 100) },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("expired before it was approved");
  });

  it("token_limit (409): points to Personal tokens and says to end one, exit 4", async () => {
    const store = memoryStore();
    const { f } = server([
      () =>
        json(409, {
          error: "bad_request",
          reason: "token_limit",
          message:
            "at most 25 live personal tokens per account; revoke one first",
        }),
    ]);
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(4);
    expect(r.err).toBe(
      "▲  You already have 25 personal tokens, the most allowed.\n" +
        "   Revoke one in Personal tokens, then run pkey login again.\n" +
        `   ${ORIGIN}/manage/#/personal-tokens\n`,
    );
    expect(store.entries.size).toBe(0);
  });

  it("a 503 (erasure ledger) and a 429 are retried with back-off", async () => {
    const waits: number[] = [];
    const { f } = server([
      () => json(503, { error: "erasure_ledger_unavailable" }),
      () => json(429, {}),
      APPROVED,
    ]);
    const r = await run([], {
      f,
      seams: { sleep: async (ms) => void waits.push(ms) },
    });
    expect(r.code).toBe(0);
    expect(waits).toEqual([3000, 6000, 12000]);
  });

  it("network failure while polling names the code and the rerun", async () => {
    let n = 0;
    const f = (async (url: string) => {
      if (String(url).endsWith("/start")) return START();
      n++;
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const r = await run([], { f });
    expect(r.code).toBe(1);
    expect(n).toBe(5);
    expect(r.err).toContain(
      `Lost contact with key.example while waiting for code ${CODE}.`,
    );
    expect(r.err).toContain("Run pkey login to try again.");
  });

  it("a rate-limited start is a refusal", async () => {
    const { f } = server([APPROVED], { start: () => json(429, {}) });
    const r = await run([], { f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Too many sign-in attempts");
  });
});

describe("pkey login: copy", () => {
  it("expired is a failure (✗, exit 1), unlike a denial", async () => {
    const r = await run([], { f: server([() => json(410, {})]).f });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(
      /^✗ {2}Code WDJB-MJHT expired before it was approved\./,
    );
  });

  it("a console without terminal sign-in says to use PKEY_ADMIN_TOKEN (404 on start)", async () => {
    const { f, calls } = server([APPROVED], {
      start: () => json(404, { error: "auth_method_disabled" }),
    });
    const r = await run([], { f });
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "key.example doesn't offer terminal sign-in; use PKEY_ADMIN_TOKEN.",
    );
    expect(calls.length).toBe(1);
  });

  it("PKEY_ADMIN_TOKEN set: said up front, before the browser opens", async () => {
    const { f, calls } = server([APPROVED]);
    const env = { PKEY_ADMIN_TOKEN: OLD };
    const r = await run([], { f, env });
    expect(r.code).toBe(0);
    expect(r.err).toContain("PKEY_ADMIN_TOKEN is set and takes precedence");
    expect(r.err).toContain("Unset it");
    expect(calls[0]!.url).toContain("/start");
    expect(r.out + r.err).not.toContain(OLD);
  });

  it("at 40 columns the code stays whole on its own line and the keys wrap", async () => {
    const k = keys();
    const { f } = server([APPROVED]);
    const r = await run([], { f, columns: 40, seams: { stdin: k.input } });
    expect(r.out).toContain(
      "\n\u001b[7m\u001b[1m WDJB-MJHT \u001b[22m\u001b[27m\n",
    );
    for (const l of r.out.split("\n"))
      if (!l.startsWith("http")) expect([...l].length).toBeLessThanOrEqual(80);
    expect(
      r.out
        .split("\n")
        .filter((l) => !l.startsWith("http") && !l.includes("\u001b"))
        .every((l) => [...l].length <= 40),
    ).toBe(true);
  });
});

describe("pkey login: keys, browser, --json", () => {
  it("Esc and Ctrl+C each cancel with one line and exit 130; raw mode is restored", async () => {
    for (const [key, exit] of [
      ["\x1b", 130],
      ["\x03", 130],
    ] as const) {
      const k = keys();
      const store = memoryStore();
      const { f, calls } = server([PENDING]);
      const r = await run([], {
        f,
        store: async () => store,
        seams: { stdin: k.input, sleep: async () => k.press(key) },
      });
      expect(r.code).toBe(exit);
      expect(r.err).toBe(
        "!  Cancelled. Nothing was saved.\n".replace("!", "▲"),
      );
      expect(store.entries.size).toBe(0);
      expect(calls.filter((c) => c.url.includes(POLL)).length).toBe(0);
      expect(k.raw).toEqual([true, false]);
      expect(k.listeners.size).toBe(0);
    }
  });

  it("SIGINT without a TTY cancels with exit 130", async () => {
    let fire: () => void = () => undefined;
    const { f } = server([PENDING]);
    const r = await run([], {
      f,
      seams: {
        onInterrupt: (cb) => ((fire = cb), () => undefined),
        sleep: async () => fire(),
      },
    });
    expect(r.code).toBe(130);
    expect(r.err).toContain("Cancelled");
  });

  it("Enter opens the page again, c copies the code", async () => {
    const k = keys();
    const copied: string[] = [];
    const { f } = server([PENDING, APPROVED]);
    let n = 0;
    const r = await run([], {
      f,
      seams: {
        stdin: k.input,
        copyText: async (t) => (copied.push(t), true),
        sleep: async () => {
          if (n++ === 0) {
            k.press("\r");
            k.press("c");
          }
        },
      },
    });
    expect(r.code).toBe(0);
    expect(r.opened.length).toBe(2);
    expect(copied).toEqual([CODE]);
    expect(r.out).toContain("Enter open again · c copy the code · Esc cancel");
  });

  it("no browser over SSH, with --no-browser, or without a display; the link is printed", async () => {
    for (const [argv, env, platform] of [
      [[], { SSH_CONNECTION: "1 2 3 4" }, "darwin"],
      [[], { SSH_TTY: "/dev/pts/1" }, "darwin"],
      [["--no-browser"], {}, "darwin"],
      [[], {}, "linux"],
    ] as const) {
      const { f } = server([APPROVED]);
      const r = await run([...argv], {
        f,
        env: { ...env },
        seams: { platform },
      });
      expect(r.code).toBe(0);
      expect(r.opened).toEqual([]);
      expect(r.out).toContain(`${ORIGIN}/manage/device?code=${CODE}`);
      expect(r.out).toContain("Open this link in a browser:");
    }
  });

  it("--json: one parseable line per state, no token, no browser, no keys", async () => {
    const k = keys();
    const { f } = server([PENDING, APPROVED]);
    const r = await run(["--json"], { f, seams: { stdin: k.input } });
    expect(r.code).toBe(0);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l["event"])).toEqual(["started", "result"]);
    expect(lines[0]).toMatchObject({
      v: 1,
      command: "login",
      code: CODE,
      url: `${ORIGIN}/manage/device?code=${CODE}`,
    });
    expect(lines[1]).toMatchObject({
      ok: true,
      name: "Ada Lovelace",
      token: { type: "personal", scope: "admin" },
    });
    expect(r.opened).toEqual([]);
    expect(k.raw).toEqual([]);
    noToken(r.out, r.err);
    expect(r.err).toBe("");
  });

  it("--json: denied, expired, token_limit and refusals are each one line on stdout", async () => {
    const cases: [() => Response, string, number][] = [
      [() => json(200, { status: "denied" }), "denied", 4],
      [() => json(410, {}), "expired", 1],
      [() => json(409, { reason: "token_limit" }), "token_limit", 4],
    ];
    for (const [poll, state, exit] of cases) {
      const { f } = server([poll]);
      const r = await run(["--json"], { f });
      const last = JSON.parse(r.out.trim().split("\n").at(-1)!) as Record<
        string,
        unknown
      >;
      expect(last).toMatchObject({
        event: "result",
        error: state,
        ok: false,
        exit,
      });
      expect(r.code).toBe(exit);
      expect(r.err).toBe("");
    }
    const ci = await run(["--json"], {
      f: server([APPROVED]).f,
      env: { CI: "1" },
    });
    expect(JSON.parse(ci.out)).toMatchObject({
      event: "result",
      error: "refused",
      ok: false,
      exit: 4,
    });
    expect(ci.code).toBe(4);
  });
});

describe("pkey login: how it looks", () => {
  const widest = (s: string) =>
    s
      .split("\n")
      .filter((l) => !l.startsWith("http"))
      .reduce((m, l) => Math.max(m, [...l].length), 0);

  it("fits 32 columns (the link line aside)", async () => {
    const { f } = server([PENDING, APPROVED]);
    const r = await run([], { f, columns: 32 });
    expect(widest(r.out)).toBeLessThanOrEqual(32);
    const d = await run([], {
      f: server([() => json(200, { status: "denied" })]).f,
      columns: 32,
    });
    expect(widest(d.err)).toBeLessThanOrEqual(32);
  });

  it("NO_COLOR keeps the text plain; ASCII uses only ASCII", async () => {
    const plain = await run([], { f: server([APPROVED]).f });
    expect(plain.out).not.toContain("\x1b[");
    const ascii = await run(["--ascii"], {
      f: server([() => json(200, { status: "denied" })]).f,
      env: { TERM: "dumb" },
    });
    expect(ascii.out + ascii.err).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    expect(ascii.err).toContain("!  Code");
    const ok = await run(["--ascii"], {
      f: server([APPROVED]).f,
      env: { TERM: "dumb" },
    });
    expect(ok.out).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    expect(ok.out).toContain("pkeyp_...h7Q2");
  });

  it("records transcripts for the UX review", async () => {
    const dir = process.env["PKEY_TRANSCRIPTS"];
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const frames: [
      string,
      () => Response[] | (() => Response)[],
      Record<string, string>,
      number,
    ][] = [
      ["approved", () => [PENDING, APPROVED], {}, 80],
      ["approved-32", () => [PENDING, APPROVED], {}, 32],
      ["denied", () => [() => json(200, { status: "denied" })], {}, 80],
      ["expired", () => [() => json(410, {})], {}, 80],
      [
        "token-limit",
        () => [() => json(409, { reason: "token_limit" })],
        {},
        80,
      ],
      ["ci", () => [APPROVED], { CI: "true" }, 80],
      ["ssh", () => [APPROVED], { SSH_CONNECTION: "1 2 3 4" }, 80],
    ];
    for (const [name, polls, env, columns] of frames) {
      const r = await run([], {
        f: server(polls() as (() => Response)[]).f,
        env,
        columns,
      });
      writeFileSync(
        path.join(dir, `${name}.txt`),
        `$ pkey login   (exit ${r.code})\n--- stdout ---\n${r.out}--- stderr ---\n${r.err}`,
      );
    }
    const k = keys();
    const c = await run([], {
      f: server([PENDING]).f,
      seams: { stdin: k.input, sleep: async () => k.press("\x1b") },
    });
    writeFileSync(
      path.join(dir, "cancelled.txt"),
      `$ pkey login   (Esc, exit ${c.code})\n--- stdout ---\n${c.out}--- stderr ---\n${c.err}`,
    );
    const j = await run(["--json"], { f: server([PENDING, APPROVED]).f });
    writeFileSync(path.join(dir, "json.txt"), j.out);
  });
});
