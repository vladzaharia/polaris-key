import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    products: [{ slug: "djdl", name: "DJDL" }],
    permissions: { roles: [{ role: "product_admin", scope: "product:djdl" }] },
  });

/** A fake console: `polls` answers GET /api/device-login/<id> in order (the last repeats). */
function server(
  polls: (() => Response)[],
  opts: {
    start?: () => Response;
    /** The answer to DELETE /me/personal-tokens/current, by the bearer it came with. */
    revoke?: (auth: string | null) => Response;
    onCall?: (c: Call) => void;
  } = {},
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
    opts.onCall?.(c);
    const u = new URL(c.url);
    if (u.pathname === "/api/device-login/start")
      return (opts.start ?? START)();
    if (u.pathname.startsWith("/api/device-login/"))
      return polls[Math.min(n++, polls.length - 1)]!();
    if (u.pathname === "/manage/api/me" && c.method === "GET") return ME();
    if (u.pathname === "/manage/api/me/personal-tokens/current")
      return (opts.revoke ?? (() => json(200, {})))(c.auth);
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
  /** Let the spinner animate on a terminal (the default turns reduced motion on). */
  animate?: boolean;
  /** Leave `--base-url` out (the default console, https://key.plrs.im). */
  defaultBase?: boolean;
}

async function run(argv: string[], o: RunOpts) {
  let out = "";
  let err = "";
  const opened: string[] = [];
  const code = await runPkey(
    ["login", ...(o.defaultBase ? [] : ["--base-url", ORIGIN]), ...argv],
    {
      cwd: HERE,
      env: {
        NO_COLOR: "1",
        ...(o.columns && !o.animate ? { PKEY_REDUCED_MOTION: "1" } : {}),
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
    },
  );
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
    expect(store.entries.get(ORIGIN)).toEqual({
      token: TOKEN,
      expiresAt: FAR,
      label: "pkey on laptop",
      hint: "h7Q2",
    });
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
    expect(r.out).toContain("✓  Signed in as Ada Lovelace (ada@example.com)\n");
    // The rows sit under the text after the glyph (3 columns in).
    expect(r.out).toContain("\n   Roles     DJDL admin\n");
    expect(r.out).toContain("\n   Token     “pkey on laptop” (pkeyp_…h7Q2)\n");
    expect(r.out).toMatch(/\n {3}Ends {6}\d{4}-\d{2}-\d{2}\n/);
    expect(r.out).toContain("\n   Saved in  macOS Keychain\n");
    expect(r.out).toContain("\n   End it with pkey logout.");
    expect(r.out).not.toContain("Signed in to");
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
    expect(r.code).toBe(1);
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
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "✗  macOS Keychain wouldn't save the sign-in, so pkey revoked it.",
    );
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "Unlock the keychain and run pkey login --base-url https://key.example again, or make a token at https://key.example/manage/#/personal-tokens and set PKEY_ADMIN_TOKEN.",
    );
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

  it("F01: the old token is revoked only after the new one is stored and read back", async () => {
    const store = memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } });
    let heldWhenRevoked: string | undefined;
    const { f, calls } = server([APPROVED], {
      onCall: (c) => {
        if (c.method === "DELETE")
          heldWhenRevoked = store.entries.get(ORIGIN)?.token;
      },
    });
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(0);
    // No revoke before start: the first request is the start.
    expect(calls[0]!.url).toContain("/api/device-login/start");
    const del = calls.filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({
      url: `${ORIGIN}/manage/api/me/personal-tokens/current`,
      auth: `Bearer ${OLD}`,
    });
    // By then the store already held the new token.
    expect(heldWhenRevoked).toBe(TOKEN);
    expect(store.entries.get(ORIGIN)!.token).toBe(TOKEN);
    expect(r.err).toBe("");
    expect(r.out + r.err).not.toContain(OLD);
  });

  it("F01: the start says when you are already signed in; an ended sign-in is not mentioned", async () => {
    const live = await run([], {
      f: server([APPROVED]).f,
      store: async () =>
        memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } }),
    });
    expect(live.out).toContain(
      "You're already signed in here. The old token ends once the new one is saved.",
    );
    const ended = await run([], {
      f: server([APPROVED]).f,
      store: async () =>
        memoryStore({ [ORIGIN]: { token: OLD, expiresAt: 1 } }),
      seams: { now: () => 5_000_000_000_000 },
    });
    expect(ended.out).not.toContain("already signed in");
  });

  it("F01: Esc, a denial, an expiry and a network failure each leave the old sign-in working", async () => {
    const base = () => ({
      store: memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } }),
    });
    const check = async (
      make: (store: CredentialStore) => ReturnType<typeof run>,
    ) => {
      const { store } = base();
      const r = await make(store);
      expect(r.code).not.toBe(0);
      expect(store.get(ORIGIN)!.token).toBe(OLD);
      return r;
    };
    const calls: Call[][] = [];
    const track = (polls: (() => Response)[]) => {
      const s = server(polls);
      calls.push(s.calls);
      return s.f;
    };
    const k = keys();
    await check((store) =>
      run([], {
        f: track([PENDING]),
        store: async () => store,
        seams: { stdin: k.input, sleep: async () => k.press("\x1b") },
      }),
    );
    await check((store) =>
      run([], {
        f: track([() => json(200, { status: "denied" })]),
        store: async () => store,
      }),
    );
    await check((store) =>
      run([], { f: track([() => json(410, {})]), store: async () => store }),
    );
    await check((store) =>
      run([], {
        f: (async (url: string) => {
          if (String(url).endsWith("/start")) return START();
          throw new Error("ECONNRESET");
        }) as typeof fetch,
        store: async () => store,
      }),
    );
    for (const c of calls)
      expect(c.filter((x) => x.method === "DELETE")).toEqual([]);
  });

  it("F01: a store that will not keep the new token puts the old one back and revokes only the new", async () => {
    const mem = memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } });
    let writes = 0;
    const flaky: CredentialStore = {
      get: mem.get,
      delete: mem.delete,
      set: (o, c) => {
        if (writes++ === 0) throw new NoStoreError();
        mem.set(o, c);
      },
    };
    const { f, calls } = server([APPROVED]);
    const r = await run([], { f, store: async () => flaky });
    expect(r.code).toBe(1);
    expect(mem.entries.get(ORIGIN)!.token).toBe(OLD);
    const del = calls.filter((c) => c.method === "DELETE");
    expect(del.map((c) => c.auth)).toEqual([`Bearer ${TOKEN}`]);
  });

  it("F01: if the old token cannot be revoked, one line says so; the new sign-in stands", async () => {
    const store = memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } });
    const { f } = server([APPROVED], {
      revoke: (auth) =>
        auth === `Bearer ${OLD}` ? json(500, {}) : json(200, {}),
    });
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(0);
    expect(store.entries.get(ORIGIN)!.token).toBe(TOKEN);
    expect(r.err).toMatch(
      /^\n▲ {2}Couldn't end your previous sign-in, so it still works until \d{4}-\d{2}-\d{2}\. Revoke it at\n {3}https:\/\/key\.example\/manage\/#\/personal-tokens\.\n$|Couldn't end your previous sign-in/,
    );
    expect(r.err.trim().split("\n").length).toBeLessThanOrEqual(2);
    const json1 = await run(["--json"], {
      f: server([APPROVED], {
        revoke: (a) => (a === `Bearer ${OLD}` ? json(500, {}) : json(200, {})),
      }).f,
      store: async () =>
        memoryStore({ [ORIGIN]: { token: OLD, expiresAt: FAR } }),
    });
    expect(
      json1.out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))[1],
    ).toMatchObject({
      ok: true,
      replaced: "not-revoked",
    });
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
  it("denied: a ▲ naming the code and the rerun, exit 1 like Esc, nothing stored", async () => {
    const store = memoryStore();
    const { f } = server([PENDING, () => json(200, { status: "denied" })]);
    const r = await run([], { f, store: async () => store });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`▲  Code ${CODE} was canceled in the browser.`);
    expect(r.err).toContain(
      "Run pkey login --base-url https://key.example to try again.",
    );
    expect(store.entries.size).toBe(0);
  });

  it("expired (410): names the code and the rerun", async () => {
    const { f } = server([() => json(410, { error: "expired" })]);
    const r = await run([], { f });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`Code ${CODE} expired before it was approved.`);
    expect(r.err).toContain(
      "Run pkey login --base-url https://key.example to get a new one.",
    );
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
      "\n▲  You already have 25 personal tokens, the most allowed.\n" +
        "   Revoke one in Personal tokens, then run pkey login --base-url\n" +
        "   https://key.example again.\n" +
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
    expect(r.err).toContain(
      "Run pkey login --base-url https://key.example to try again.",
    );
    // N5: the code may have been approved while the network was down.
    expect(r.err).toContain(
      "If you approved it, the token may exist; check Personal tokens.",
    );
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
      /^\n✗ {2}Code WDJB-MJHT expired before it was approved\./,
    );
  });

  it("a console without terminal sign-in says to use PKEY_ADMIN_TOKEN (404 on start)", async () => {
    const { f, calls } = server([APPROVED], {
      start: () => json(404, { error: "auth_method_disabled" }),
    });
    const r = await run([], { f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("▲  key.example doesn't offer terminal sign-in.\n");
    expect(r.err).toContain(
      "   Set PKEY_ADMIN_TOKEN to a personal token instead.",
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
    for (const l of noLinks(r.out).split("\n"))
      if (!l.startsWith("http")) expect([...l].length).toBeLessThanOrEqual(80);
    expect(
      noLinks(r.out)
        .split("\n")
        .filter((l) => !l.startsWith("http") && !l.includes("\u001b"))
        .every((l) => [...l].length <= 40),
    ).toBe(true);
  });
});

describe("pkey login: keys, browser, --json", () => {
  it("F08: Esc and Ctrl+D cancel (exit 1, cancelled); Ctrl+C is interrupted (130); raw mode is restored", async () => {
    for (const [key, exit] of [
      ["\x1b", 1, "cancelled"],
      ["\x04", 1, "cancelled"],
      ["\x03", 130, "interrupted"],
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
      expect(r.err).toBe("\n▲  Canceled. Nothing was saved.\n");

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
    expect(r.err).toContain("Canceled. Nothing was saved.");
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
      [() => json(200, { status: "denied" }), "denied", 1],
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

/** An OSC 8 link wrapper (m3): the text shows, the target is the link. */
const noLinks = (s: string) =>
  s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const bare = (s: string) => noLinks(s).replace(/\x1b\[[0-9;]*m/g, "");

describe("pkey login: goldens", () => {
  const dump = process.env["PKEY_GOLDENS"];
  const cases: [string, number, () => (() => Response)[], string[]][] = [
    ["approved", 80, () => [PENDING, APPROVED], []],
    ["approved", 40, () => [PENDING, APPROVED], []],
    ["approved", 32, () => [PENDING, APPROVED], []],
    ["approved", 28, () => [PENDING, APPROVED], []],
    ["denied", 40, () => [() => json(200, { status: "denied" })], []],
    ["denied", 32, () => [() => json(200, { status: "denied" })], []],
    ["expired", 32, () => [() => json(410, {})], []],
  ];
  // PKEY_GOLDENS=<dir> rewrites the files this reads (review them before committing).
  const dir = path.join(HERE, "fixtures/login-goldens");
  for (const [name, columns, polls, argv] of cases) {
    it(`${name} at ${columns} columns`, async () => {
      const k = keys();
      const r = await run(argv, {
        f: server(polls()).f,
        columns,
        seams: { stdin: k.input },
      });
      const text = `${bare(r.out)}--- stderr ---\n${bare(r.err)}`;
      if (dump) {
        mkdirSync(dump, { recursive: true });
        writeFileSync(path.join(dump, `${name}-${columns}.txt`), text);
      }
      for (const l of text.split("\n"))
        expect([...l].length, l).toBeLessThanOrEqual(columns);
      expect(text).toBe(
        readFileSync(path.join(dir, `${name}-${columns}.txt`), "utf8"),
      );
    });
  }
});

describe("pkey login: how it looks", () => {
  const widest = (s: string) =>
    s.split("\n").reduce((m, l) => Math.max(m, [...bare(l)].length), 0);

  it("fits 32 columns (the link line aside)", async () => {
    const { f } = server([PENDING, APPROVED]);
    const r = await run([], { f, columns: 32 });
    expect(widest(r.out)).toBeLessThanOrEqual(32);
    expect(widest(r.err)).toBeLessThanOrEqual(32);
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

const failing = (code?: string) =>
  (async (url: string) => {
    if (String(url).endsWith("/start") && code === undefined) return START();
    throw Object.assign(new TypeError("fetch failed"), {
      cause: code ? Object.assign(new Error("x"), { code }) : undefined,
    });
  }) as typeof fetch;

const lastLine = (out: string): Record<string, unknown> =>
  JSON.parse(out.trimEnd().split("\n").at(-1)!) as Record<string, unknown>;

describe("pkey login: failures say what to do (F03, F04, F07)", () => {
  it("F03: no answer from start is ✗ with a fix, keeps the cause, never names an API path", async () => {
    const r = await run([], { f: failing("ECONNREFUSED"), columns: 80 });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "✗  Can't reach key.example.\n   Check your network, or --base-url.\n",
    );
    expect(r.out + r.err).not.toContain("/api/");
    const j = await run(["--json"], { f: failing("ECONNREFUSED") });
    expect(lastLine(j.out)).toMatchObject({
      ok: false,
      exit: 1,
      error: "network",
      cause: "ECONNREFUSED",
      host: "key.example",
    });
    expect(j.out).not.toContain("/api/");
  });

  it("F03: a 500 from start is ✗ with a fix", async () => {
    const { f } = server([APPROVED], { start: () => json(500, {}) });
    const r = await run([], { f, columns: 80 });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "✗  key.example couldn't start a sign-in (HTTP 500).\n   Try again in a minute.\n",
    );
    expect(r.err).not.toContain("/api/");
  });

  it("F04: every exit under --json ends in one result line on stdout", async () => {
    const cases: [string, string[], RunOpts, Record<string, unknown>][] = [
      [
        "network",
        [],
        { f: failing("ENOTFOUND") },
        { error: "network", exit: 1 },
      ],
      [
        "server",
        [],
        { f: server([APPROVED], { start: () => json(500) }).f },
        { error: "server-error", exit: 1 },
      ],
      [
        "usage",
        ["--base-url", "http://key.example"],
        { f: server([APPROVED]).f },
        { error: "usage", exit: 2 },
      ],
      [
        "internal",
        [],
        {
          f: server([APPROVED]).f,
          store: async () => {
            throw new Error("disk on fire");
          },
        },
        { error: "internal", exit: 1 },
      ],
    ];
    for (const [name, argv, o, want] of cases) {
      const r = await run(["--json", ...argv], o);
      expect(r.code, name).toBe(want["exit"]);
      expect(lastLine(r.out), name).toMatchObject({
        v: 1,
        command: "login",
        event: "result",
        ok: false,
        ...want,
      });
      expect(r.err, name).toBe("");
    }
  });

  it("F07: a non-https address is a wrapped ▲ line with the fix, no mid-word break", async () => {
    for (const columns of [80, 40, 32, 28]) {
      const { f, calls } = server([APPROVED]);
      const r = await run(["--base-url", "http://key.example"], { f, columns });
      expect(r.code).toBe(2);
      expect(calls).toEqual([]);
      const text = r.err.replace(/\s+/g, " ").trim();
      expect(text).toBe(
        "▲ pkey login needs an https address. Use https://key.plrs.im; http works only on localhost.",
      );
      for (const l of r.err.trimEnd().split("\n"))
        expect([...l].length, l).toBeLessThanOrEqual(columns);
      expect(r.err).toContain("https://key.plrs.im");
      expect(r.err).not.toContain("PKEY_ADMIN_TOKEN");
    }
  });
});

describe("pkey login: what the person sees (F02, F05, F06, F14, F16)", () => {
  it("F02: roles use the console's names, with product names from /me.products", async () => {
    const me = () =>
      json(200, {
        name: "Ada Lovelace",
        email: "ada@example.com",
        products: [{ slug: "djdl", name: "DJDL" }],
        permissions: {
          roles: [
            { role: "superadmin", scope: "platform" },
            { role: "platform_admin", scope: "platform" },
            { role: "console_access", scope: "platform" },
            { role: "product_admin", scope: "products:*" },
            { role: "product_admin", scope: "product:djdl" },
            { role: "product_admin", scope: "product:ghost" },
          ],
        },
      });
    const f = (async (url: string, init: RequestInit) => {
      if (new URL(String(url)).pathname === "/manage/api/me") return me();
      return server([APPROVED]).f(url, init);
    }) as typeof fetch;
    const r = await run([], { f });
    expect(r.out.replace(/\s+/g, " ")).toContain(
      "Roles Superadmin, Platform admin, Console access, All products admin, DJDL admin, ghost admin",
    );
    expect(r.out).not.toMatch(/product_admin|platform_admin|Admin \(/);
  });

  it("F05: 'Signed in as …' without the host; the name and email never split", async () => {
    const r = await run([], { f: server([APPROVED]).f, columns: 28 });
    expect(bare(r.out)).toContain(
      "✓  Signed in as Ada Lovelace\n   (ada@example.com)\n",
    );
    expect(r.out).not.toContain("Signed in to");
  });

  it("F05: a name or email wider than the row wraps and loses nothing (no ellipsis)", async () => {
    const name = "Maximiliana Alexandrovna Rostropovich-Wellington";
    const email =
      "maximiliana.rostropovich-wellington@subsidiary.example.co.uk";
    const f = (async (url: string, init: RequestInit) => {
      if (new URL(String(url)).pathname === "/manage/api/me")
        return json(200, { name, email, permissions: { roles: [] } });
      return server([APPROVED]).f(url, init);
    }) as typeof fetch;
    for (const columns of [40, 32, 28]) {
      const r = await run([], { f, columns });
      const text = bare(r.out);
      expect(text).not.toContain("…opovich");
      for (const l of text.trimEnd().split("\n"))
        expect([...l].length, l).toBeLessThanOrEqual(columns);
      const squashed = text.replace(/\s+/g, "");
      expect(squashed).toContain(name.replace(/\s+/g, ""));
      expect(squashed).toContain(email);
    }
  });

  it("F06: a code denied in the browser is 'canceled in the browser'; the JSON code stays denied", async () => {
    const j = await run(["--json"], {
      f: server([() => json(200, { status: "denied" })]).f,
    });
    expect(lastLine(j.out)).toMatchObject({
      error: "denied",
      exit: 1,
      message: `Code ${CODE} was canceled in the browser. Run pkey login --base-url ${ORIGIN} to try again.`,
    });
    const text = await run([], {
      f: server([() => json(200, { status: "denied" })]).f,
    });
    expect(text.err + text.out).not.toMatch(/denied|Cancelled|cancelled/i);
  });

  it("F14: the login stores the label and hint, so whoami shows them", async () => {
    const store = memoryStore();
    const { f } = server([APPROVED]);
    await run([], { f, store: async () => store });
    let out = "";
    await runPkey(["whoami", "--base-url", ORIGIN], {
      cwd: HERE,
      env: { NO_COLOR: "1", TZ: "UTC" },
      stdout: { write: (c: string) => ((out += c), true) },
      stderr: { write: () => true },
      fetchImpl: f,
      credentialStore: async () => store,
    });
    expect(out).toContain("Token   “pkey on laptop” (pkeyp_…h7Q2)");
  });

  it("F16: the header is bold with a muted host; the name is bold; the hints are key strong, verb muted", async () => {
    const k = keys();
    const r = await run([], {
      f: server([APPROVED]).f,
      columns: 80,
      env: { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" },
      seams: { stdin: k.input },
    });
    const BOLD = "\x1b[1m";
    expect(r.out).toContain(`${BOLD}Polaris Key console\x1b[22m`);
    expect(r.out).toMatch(/\x1b\[(2|90)m · key\.example\x1b\[(22|39)m/);
    expect(r.out).toMatch(/\x1b\[(2|90)mDidn't open\? Go to\x1b\[(22|39)m/);
    expect(r.out).toContain(`${BOLD}Ada Lovelace\x1b[22m`);
    expect(r.out).toContain(`${BOLD}Enter\x1b[22m`);
    expect(r.out).toMatch(/\x1b\[1mc\x1b\[22m\x1b\[(2|90)m copy the code/);
  });
});

describe("pkey login: the live region and the keys (F09, F10, F13, F15)", () => {
  it("F15: the spinner and the key hints are one region, hints under it, closed at the end", async () => {
    const k = keys();
    const r = await run([], {
      f: server([PENDING, APPROVED]).f,
      columns: 80,
      animate: true,
      env: { NO_COLOR: "1", TERM: "xterm-256color" },
      seams: { stdin: k.input },
    });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Waiting for approval");
    // Both rows are drawn in one frame (spinner, then the hints under it).
    expect(r.err).toMatch(
      /Waiting for approval\n {3}.*Enter.*open again.*copy the code.*Esc.*cancel/,
    );
    // One blank row before the result, and nothing of the region left after it.
    expect(bare(r.out)).toMatch(
      /Check that the code in your browser matches:\n WDJB-MJHT \n\n✓ {2}Signed in as/,
    );
    expect(r.out).not.toContain("Enter open again");
  });

  it("F15: the region is closed on every ending, not only on success", async () => {
    for (const poll of [
      () => json(200, { status: "denied" }),
      () => json(410, {}),
    ]) {
      const k = keys();
      const r = await run([], {
        f: server([poll]).f,
        columns: 80,
        animate: true,
        env: { NO_COLOR: "1", TERM: "xterm-256color" },
        seams: { stdin: k.input },
      });
      expect(r.err).toMatch(/\x1b\[\?25h/);
      expect(r.err.lastIndexOf("Waiting for approval")).toBeLessThan(
        r.err.search(/[▲✗]/),
      );
    }
  });

  it("F09: over SSH there is no copy key, and c copies nothing", async () => {
    for (const env of <Record<string, string>[]>[
      { SSH_CONNECTION: "1 2 3 4" },
      { SSH_TTY: "/dev/pts/1" },
    ]) {
      const k = keys();
      const copied: string[] = [];
      const r = await run([], {
        f: server([PENDING, APPROVED]).f,
        env,
        columns: 80,
        seams: {
          stdin: k.input,
          copyText: async (t) => (copied.push(t), true),
          sleep: async () => k.press("c"),
        },
      });
      expect(r.code).toBe(0);
      expect(copied).toEqual([]);
      expect(bare(r.out)).toContain("Esc cancel");
      expect(bare(r.out)).not.toMatch(/\bc cop/);
      expect(bare(r.out)).not.toContain("Copied");
      expect(bare(r.out)).not.toContain("Enter open again");
    }
  });

  it("F09: off SSH the copy key says what happened, inside the region", async () => {
    const k = keys();
    const r = await run([], {
      f: server([PENDING, APPROVED]).f,
      columns: 80,
      animate: true,
      env: { NO_COLOR: "1", TERM: "xterm-256color" },
      seams: {
        stdin: k.input,
        copyText: async () => true,
        sleep: async () => {
          k.press("c");
          await new Promise((r) => setTimeout(r, 5));
        },
      },
    });
    expect(bare(r.err)).toContain("c copied");
  });

  it("F10: GITHUB_ACTIONS and BUILDKITE are CI too: refused, no network, no store", async () => {
    for (const env of <Record<string, string>[]>[
      { GITHUB_ACTIONS: "true" },
      { BUILDKITE: "true" },
      { CI: "1" },
    ]) {
      const { f, calls } = server([APPROVED]);
      let touched = false;
      const r = await run([], {
        f,
        env,
        store: async () => ((touched = true), memoryStore()),
      });
      expect(r.code).toBe(4);
      expect(r.err).toContain(
        "pkey login needs a person; in CI use PKEY_ADMIN_TOKEN",
      );
      expect(calls).toEqual([]);
      expect(touched).toBe(false);
    }
    const notCi = await run([], {
      f: server([APPROVED]).f,
      env: { CI: "false" },
    });
    expect(notCi.code).toBe(0);
  });

  it("F13: after the first network failure the spinner reads 'Reconnecting to <host>…'", async () => {
    let n = 0;
    const base = server([APPROVED]).f;
    const f = (async (url: string, init: RequestInit) => {
      if (
        new URL(String(url)).pathname.startsWith("/api/device-login/dl_") &&
        n++ === 0
      )
        throw new TypeError("fetch failed");
      return base(url, init);
    }) as typeof fetch;
    const r = await run([], { f, columns: 80 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Reconnecting to key.example…\n");
    expect(r.out.indexOf("Waiting for approval")).toBeLessThan(
      r.out.indexOf("Reconnecting"),
    );
    // Animated: the spinner label changes, then goes back.
    n = 0;
    const a = await run([], {
      f,
      columns: 80,
      animate: true,
      env: { NO_COLOR: "1", TERM: "xterm-256color" },
      seams: { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
    });
    expect(a.err).toContain("Reconnecting to key.example");
    expect(a.err.lastIndexOf("Waiting for approval")).toBeGreaterThan(
      a.err.indexOf("Reconnecting"),
    );
  });
});

describe("pkey login: rerun lines, store failures, bounds (F11, F12, F17, N1-N5)", () => {
  it("F12: a rerun line repeats --base-url only when it came from the flag", async () => {
    const withFlag = await run([], { f: server([() => json(410, {})]).f });
    expect(withFlag.err).toContain(
      `Run pkey login --base-url ${ORIGIN} to get a new one.`,
    );
    const without = await run([], {
      f: server([() => json(410, {})]).f,
      defaultBase: true,
    });
    expect(without.err).toContain("Run pkey login to get a new one.");
    expect(without.err).not.toContain("--base-url");
  });

  it("F11: the store's real name per OS, and 'this computer'", async () => {
    for (const [platform, name, advice] of [
      ["darwin", "macOS Keychain", "Unlock the keychain"],
      [
        "win32",
        "Windows Credential Manager",
        "Check Windows Credential Manager",
      ],
      ["linux", "Secret Service", "Unlock your keyring"],
    ] as const) {
      const mem = memoryStore();
      const failingStore: CredentialStore = {
        get: mem.get,
        delete: mem.delete,
        set: () => {
          throw new NoStoreError();
        },
      };
      const r = await run([], {
        f: server([APPROVED]).f,
        store: async () => failingStore,
        seams: { platform },
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        `✗  ${name} wouldn't save the sign-in, so pkey revoked it.`,
      );
      expect(r.err.replace(/\s+/g, " ")).toContain(advice);
    }
    const r = await run([], {
      f: server([APPROVED]).f,
      store: async () => {
        throw new NoStoreError();
      },
    });
    expect(r.err).toContain("No credential store on this computer.");
    expect(r.err).not.toContain("this machine");
  });

  it("F11: when the new token cannot be revoked either, it says so and where", async () => {
    const mem = memoryStore();
    const failingStore: CredentialStore = {
      get: mem.get,
      delete: mem.delete,
      set: () => {
        throw new NoStoreError();
      },
    };
    const r = await run([], {
      f: server([APPROVED], { revoke: () => json(500) }).f,
      store: async () => failingStore,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "wouldn't save the sign-in, and pkey couldn't revoke it.",
    );
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "Revoke “pkey on laptop” (pkeyp_…h7Q2) at https://key.example/manage/#/personal-tokens",
    );
    noToken(r.out, r.err);
  });

  it("F17: the link drops ?code= below 49 columns (the code is right under it); the JSON url keeps it", async () => {
    const wide = await run([], { f: server([APPROVED]).f, columns: 70 });
    expect(wide.out).toContain(`/manage/device?code=${CODE}`);
    // https://key.plrs.im/manage/device?code=XXXX-XXXX is 48 cells.
    const at49 = await run([], {
      f: server([APPROVED]).f,
      columns: 49,
      defaultBase: true,
    });
    expect(at49.out).toContain("https://key.plrs.im/manage/device?code=");
    const at48 = await run([], {
      f: server([APPROVED]).f,
      columns: 48,
      defaultBase: true,
    });
    expect(noLinks(at48.out)).toContain("https://key.plrs.im/manage/device\n");
    expect(noLinks(at48.out)).not.toContain("?code=");
    expect(at48.out).toContain("Enter this code in your browser:");
    const j = await run(["--json"], { f: server([APPROVED]).f });
    expect(j.out).toContain(`?code=${CODE}`);
  });

  it("N1: a start answer past 64 KiB is read as nothing", async () => {
    const big = () =>
      json(
        201,
        { id: POLL, code: CODE, pad: "x".repeat(70_000) },
        {
          "set-cookie": `__Host-pkey_device_login=${COOKIE}; Path=/; Secure`,
        },
      );
    const r = await run([], { f: server([APPROVED], { start: big }).f });
    expect(r.code).toBe(1);
    expect(r.err).toContain("answered the sign-in start unexpectedly");
  });

  it("N2: expiresIn is clamped to 600 seconds", async () => {
    const j = await run(["--json"], {
      f: server([PENDING], { start: () => START({ expiresIn: 100_000 }) }).f,
      seams: {
        now: (() => {
          let t = 0;
          return () => (t += 3000);
        })(),
      },
    });
    expect(JSON.parse(j.out.split("\n")[0]!)).toMatchObject({
      event: "started",
      expiresIn: 600,
    });
    let t = 0;
    const { f, calls } = server([PENDING], {
      start: () => START({ expiresIn: 100_000 }),
    });
    const r = await run([], {
      f,
      seams: { now: () => t, sleep: async (ms) => void (t += ms) },
    });
    expect(r.code).toBe(1);
    // 600 s at the server's 3 s interval is 200 polls; 100000 s would be tens of thousands.
    expect(
      calls.filter((c) => c.url.includes(POLL)).length,
    ).toBeLessThanOrEqual(201);
  });

  it("N3: start and poll carry a timeout signal; a timeout is a network failure", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const base = server([PENDING, APPROVED]).f;
    const f = (async (url: string, init: RequestInit) => {
      if (new URL(String(url)).pathname.startsWith("/api/"))
        signals.push(init.signal);
      return base(url, init);
    }) as typeof fetch;
    await run([], { f });
    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
    const timeout = (async (url: string) => {
      if (String(url).endsWith("/start")) return START();
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as typeof fetch;
    const r = await run(["--json"], { f: timeout });
    expect(lastLine(r.out)).toMatchObject({
      error: "network",
      cause: "TIMEOUT",
    });
  });

  it("N4: the clipboard tool's stdin has an error handler (a dead pbcopy cannot crash pkey)", () => {
    const src = readFileSync(path.join(HERE, "../src/login.ts"), "utf8");
    expect(src).toMatch(/child\.stdin\.on\("error", \(\) => \{\}\)/);
  });

  it("N5: only an expiry after a network failure adds the 'token may exist' line", async () => {
    const plain = await run([], { f: server([() => json(410, {})]).f });
    expect(plain.err).not.toContain("token may exist");
    let n = 0;
    const base = server([() => json(410, {})]).f;
    const f = (async (url: string, init: RequestInit) => {
      if (
        new URL(String(url)).pathname.startsWith("/api/device-login/dl_") &&
        n++ === 0
      )
        throw new TypeError("fetch failed");
      return base(url, init);
    }) as typeof fetch;
    const r = await run([], { f });
    expect(r.err).toContain(
      "If you approved it, the token may exist; check Personal tokens.",
    );
    expect(
      lastLine((await run(["--json"], { f: ((n = 0), f) })).out)["message"],
    ).toContain("token may exist");
  });

  it("the help says what the keys, the endings and the replaced token do", async () => {
    let out = "";
    await runPkey(["help", "login"], {
      cwd: HERE,
      env: { NO_COLOR: "1" },
      stdout: {
        write: (c: string) => ((out += c), true),
        columns: 200,
        isTTY: true,
      },
      stderr: { write: () => true },
    });
    const text = out.replace(/\s+/g, " ");
    expect(text).toContain(
      "ends the token it replaces once the new one is saved",
    );
    expect(text).toContain(
      "Esc and Ctrl+D cancel and exit 1; Ctrl+C exits 130",
    );
    expect(text).toContain("not over SSH");
  });

  it("SIGINT under --json is one 'interrupted' line, exit 130", async () => {
    let fire: () => void = () => undefined;
    const r = await run(["--json"], {
      f: server([PENDING]).f,
      seams: {
        onInterrupt: (cb) => ((fire = cb), () => undefined),
        sleep: async () => fire(),
      },
    });
    expect(r.code).toBe(130);
    expect(lastLine(r.out)).toMatchObject({
      error: "interrupted",
      exit: 130,
      ok: false,
    });
  });
});

describe("colour terminals: every login glyph renders (R1)", () => {
  it("✗ and ▲ endings and a failed start in colour", async () => {
    const colour = { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" };
    for (const [f, code] of [
      [failing("ECONNREFUSED"), 1],
      [server([APPROVED], { start: () => json(500) }).f, 1],
      [server([() => json(410, {})]).f, 1],
      [server([() => json(200, { status: "denied" })]).f, 1],
    ] as const) {
      const r = await run([], { f, columns: 80, env: colour });
      expect(r.code).toBe(code);
      expect(r.err).toContain("\x1b[");
      expect(r.err).not.toContain("TypeError");
    }
  });
});

describe("pkey login: the review's minors (m3, m7-m11)", () => {
  const link = (url: string) => `\x1b]8;;${url}\x1b\\`;

  it("m3: the approve URL is an OSC 8 link on a terminal (the target keeps the code)", async () => {
    const r = await run([], { f: server([APPROVED]).f, columns: 40 });
    expect(r.out).toContain(link(`${ORIGIN}/manage/device?code=${CODE}`));
    const piped = await run([], { f: server([APPROVED]).f });
    expect(piped.out).not.toContain("\x1b]8;;");
    const j = await run(["--json"], { f: server([APPROVED]).f, columns: 80 });
    expect(j.out).not.toContain("\x1b]8;;");
  });

  it("m3: the token-limit URL is a link too", async () => {
    const r = await run([], {
      f: server([() => json(409, { reason: "token_limit" })]).f,
      columns: 80,
    });
    expect(r.err).toContain(link(`${ORIGIN}/manage/#/personal-tokens`));
  });

  it("m7: the result rows sit under the text after the glyph, and the command is bold", async () => {
    const r = await run([], {
      f: server([APPROVED]).f,
      columns: 80,
      env: { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" },
    });
    const text = bare(r.out);
    expect(text).toContain("✓  Signed in as Ada Lovelace");
    expect(text).toContain("\n   Roles     DJDL admin\n");
    expect(text).toContain("\n   End it with pkey logout.\n");
    expect(r.out).toContain("End it with \x1b[1mpkey logout\x1b[22m.");
  });

  it("m8: a previous sign-in that stays alive is named by its hint, and the URL ends the line", async () => {
    const store = memoryStore({
      [ORIGIN]: { token: OLD, expiresAt: FAR, label: null, hint: null },
    });
    const r = await run([], {
      f: server([APPROVED], {
        revoke: (auth) => (auth === `Bearer ${OLD}` ? json(500) : json(200)),
      }).f,
      store: async () => store,
    });
    expect(r.code).toBe(0);
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "Couldn't end your previous sign-in (pkeyp_…OOOO), so it still works until",
    );
    expect(r.err.trimEnd().endsWith("/manage/#/personal-tokens")).toBe(true);
  });

  it("a failed restore after a failed store write says the old sign-in may need pkey login again", async () => {
    const mem = memoryStore({
      [ORIGIN]: { token: OLD, expiresAt: FAR, label: null, hint: null },
    });
    const failing: CredentialStore = {
      get: mem.get,
      delete: mem.delete,
      set: () => {
        throw new NoStoreError();
      },
    };
    const r = await run([], {
      f: server([APPROVED]).f,
      store: async () => failing,
    });
    expect(r.code).toBe(1);
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "Your old sign-in may need pkey login --base-url https://key.example again.",
    );
    // With a store that takes the restore, the line is not there.
    let first = true;
    const flaky: CredentialStore = {
      get: mem.get,
      delete: mem.delete,
      set: (o, c) => {
        if (first) {
          first = false;
          throw new NoStoreError();
        }
        mem.set(o, c);
      },
    };
    const ok = await run([], {
      f: server([APPROVED]).f,
      store: async () => flaky,
    });
    expect(ok.err).not.toContain("may need");
  });

  it("m9: the missing-terminal-sign-in refusal and the env-token warning keep their fix on its own line", async () => {
    const gone = await run([], {
      f: server([APPROVED], { start: () => json(404, {}) }).f,
    });
    expect(gone.err).toBe(
      "▲  key.example doesn't offer terminal sign-in.\n   Set PKEY_ADMIN_TOKEN to a personal token instead.\n",
    );
    const warned = await run([], {
      f: server([APPROVED]).f,
      env: { PKEY_ADMIN_TOKEN: OLD },
    });
    expect(warned.err).toContain(
      "▲  PKEY_ADMIN_TOKEN is set and takes precedence over this sign-in.\n   Unset it to use the one pkey login saves.\n",
    );
  });

  it("m10: a code canceled in the browser exits 1 like Esc; the JSON code stays denied", async () => {
    const r = await run([], {
      f: server([() => json(200, { status: "denied" })]).f,
    });
    expect(r.code).toBe(1);
    const j = await run(["--json"], {
      f: server([() => json(200, { status: "denied" })]).f,
    });
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out.trim().split("\n").at(-1)!)).toMatchObject({
      error: "denied",
      exit: 1,
    });
  });

  it("m11 and M2: no roles shows None; a narrowed role shows its areas after the role", async () => {
    const asks = (roles: unknown[]) =>
      (async (url: string, init: RequestInit) =>
        new URL(String(url)).pathname === "/manage/api/me"
          ? json(200, {
              name: "Ada Lovelace",
              email: "ada@example.com",
              products: [{ slug: "djdl", name: "DJDL" }],
              permissions: { roles },
            })
          : server([APPROVED]).f(url, init)) as typeof fetch;
    const none = await run([], { f: asks([]), columns: 80 });
    expect(bare(none.out)).toContain("\n   Roles     None\n");
    const narrowed = await run([], {
      f: asks([
        {
          role: "product_admin",
          scope: "product:djdl",
          areas: ["license", "signin"],
        },
      ]),
      columns: 80,
    });
    expect(bare(narrowed.out)).toContain(
      "\n   Roles     DJDL admin · Licensing, Sign-in\n",
    );
  });
});
