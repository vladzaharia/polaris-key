import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS, EXIT_CODES, checkRegistry } from "../src/help.js";
import { runPkey } from "../src/index.js";
import {
  KeychainRefusedError,
  memoryStore,
  NoStoreError,
  type CredentialStore,
} from "../src/credentials.js";

const PERSONAL = `pkeyp_${"P".repeat(43)}`;
const ADMIN = `pkeya_${"A".repeat(43)}`;
const ORIGIN = "https://key.example";
const FAR = 4_000_000_000;

interface Call {
  url: string;
  method: string;
  auth: string | null;
  redirect: string | undefined;
}

function fakeFetch(answer: (c: Call) => Response | Promise<Response>): {
  f: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = {
      url: String(url),
      method: init.method ?? "GET",
      auth: new Headers(init.headers).get("authorization"),
      redirect: init.redirect,
    };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { f, calls };
}

const role = (r: string, scope: string, source = "grant") => ({
  role: r,
  scope,
  areas: null,
  source,
});

const ME = {
  sub: "sub-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  products: [
    { slug: "djdl", name: "DJDL" },
    { slug: "diceroll", name: "Diceroll" },
  ],
  permissions: {
    roles: [
      role("product_admin", "product:djdl"),
      role("platform_admin", "platform"),
      role("superadmin", "platform", "grant"),
    ],
  },
  sessionExpiresAt: FAR,
};

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A stream of that width (a terminal, so the width is honoured); none given is a pipe. */
const tty = (columns?: number) =>
  columns === undefined ? {} : { isTTY: true, columns };

async function run(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    store?: () => Promise<CredentialStore>;
    fetchImpl?: typeof fetch;
    columns?: number;
  } = {},
) {
  let out = "";
  let err = "";
  const code = await runPkey(argv, {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { CI: "true", NO_COLOR: "1", TERM: "dumb", TZ: "UTC", ...opts.env },
    stdout: { write: (c: string) => ((out += c), true), ...tty(opts.columns) },
    stderr: { write: (c: string) => ((err += c), true), ...tty(opts.columns) },
    fetchImpl: opts.fetchImpl,
    credentialStore: opts.store,
  });
  return { code, out, err };
}

const signedIn = (
  expiresAt: number | null = FAR,
  extra: { label?: string; hint?: string } = {},
) => memoryStore({ [ORIGIN]: { token: PERSONAL, expiresAt, ...extra } });

const LABELLED = { label: "pkey on ada-macbook", hint: "h7Q2" };

/** One `--json` line: parses, ends in a newline, and the stream holds nothing else. */
function oneLine(out: string): Record<string, unknown> {
  expect(out.endsWith("\n")).toBe(true);
  expect(out.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(out) as Record<string, unknown>;
}

const offline = (code = "ECONNREFUSED") =>
  (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code }),
    });
  }) as typeof fetch;

const BASE = ["--base-url", ORIGIN];

describe("whoami", () => {
  it("prints the person, role names and end date; sends the token to its origin only", async () => {
    const store = signedIn(FAR, LABELLED);
    const { f, calls } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", ...BASE], {
      store: async () => store,
      fetchImpl: f,
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        url: `${ORIGIN}/manage/api/me`,
        method: "GET",
        auth: `Bearer ${PERSONAL}`,
        redirect: "manual",
      },
    ]);
    expect(r.out).toBe(
      [
        "Host    key.example",
        "Name    Ada Lovelace",
        "Email   ada@example.com",
        "Roles   DJDL admin, Platform admin, Superadmin",
        "Token   “pkey on ada-macbook” (pkeyp_…h7Q2)",
        "Ends    2096-10-02",
        "",
      ]
        .join("\n")
        .replace(/[“”]/g, '"')
        .replace("…", "..."),
    );
    expect(r.err).toBe("");
  });

  it("names roles the way the console does, and an unknown product by its slug", async () => {
    const { f } = fakeFetch(() =>
      json(200, {
        ...ME,
        permissions: {
          roles: [
            role("console_access", "platform"),
            role("product_admin", "products:*"),
            role("product_admin", "product:ghost"),
            role("product_admin", "product:diceroll"),
          ],
        },
      }),
    );
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.out).toContain(
      "Roles   Console access, All products admin, ghost admin, Diceroll admin",
    );
    expect(r.out).not.toMatch(/product_admin|console_access|products:\*/);
  });

  it("--json keeps the role ids and is one result line with no token", async () => {
    const { f } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(FAR, LABELLED),
      fetchImpl: f,
    });
    const v = oneLine(r.out);
    expect(v).toMatchObject({
      v: 1,
      command: "whoami",
      event: "result",
      ok: true,
      exit: 0,
      host: "key.example",
      roles: [
        { role: "product_admin", scope: "product:djdl" },
        { role: "platform_admin", scope: "platform" },
        { role: "superadmin", scope: "platform" },
      ],
      token: {
        type: "personal",
        scope: "admin",
        source: "credential-store",
        label: "pkey on ada-macbook",
        hint: "h7Q2",
      },
    });
    expect(r.out).not.toContain("pkeyp_");
    expect(r.err).toBe("");
  });

  it("wraps its rows at 40 and 32 columns: hung under the value, the date in one piece", async () => {
    const long = {
      ...ME,
      name: "Ada Augusta King-Noel Lovelace",
      email: "ada.lovelace@analytical-engine.example",
      permissions: {
        roles: [
          role("product_admin", "product:djdl"),
          role("product_admin", "products:*"),
          role("platform_admin", "platform"),
          role("console_access", "platform"),
        ],
      },
    };
    for (const columns of [40, 32]) {
      const { f } = fakeFetch(() => json(200, long));
      const r = await run(["whoami", ...BASE], {
        store: async () => signedIn(FAR, LABELLED),
        fetchImpl: f,
        columns,
      });
      const lines = r.out.trimEnd().split("\n");
      for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(columns);
      // Continuation lines start under the value column.
      const rows = lines.filter((l) => !/^[A-Z][a-z]+ {1,7}\S/.test(l));
      expect(rows.length, `${columns} wraps`).toBeGreaterThan(0);
      for (const l of rows) expect(l.startsWith(" ".repeat(8)), l).toBe(true);
      expect(r.out).toContain("Ends");
      expect(r.out).toContain("2096-10-02");
      expect(r.out.replace(/\s+/g, " ")).toContain("DJDL admin");
    }
  });

  it("warns about the root lapse only when every Superadmin grant comes from the identity provider", async () => {
    const lapse = "Superadmin ends 8 hours after your last console sign-in.";
    const ask = "Ask for a stored Superadmin role to keep it.";
    const say = async (roles: ReturnType<typeof role>[]) => {
      const { f } = fakeFetch(() =>
        json(200, { ...ME, permissions: { roles } }),
      );
      const r = await run(["whoami", ...BASE], {
        store: async () => signedIn(),
        fetchImpl: f,
        columns: 200,
      });
      return r.out;
    };
    const root = await say([role("superadmin", "platform", "root")]);
    expect(root.replace(/\n {3}/g, " ")).toContain(`!  ${lapse} ${ask}`);
    expect(
      await say([
        role("superadmin", "platform", "root"),
        role("superadmin", "platform", "grant"),
      ]),
    ).not.toContain("ends 8 hours after");
    expect(await say([role("superadmin", "platform", "grant")])).not.toContain(
      "ends 8 hours after",
    );
    expect(await say([role("platform_admin", "platform")])).not.toContain(
      "ends 8 hours after",
    );
  });

  it("masks a token a hostile server echoes back in its answer", async () => {
    const { f } = fakeFetch(() =>
      json(200, {
        ...ME,
        name: `x Bearer ${PERSONAL}`,
        email: `${PERSONAL}@x`,
      }),
    );
    for (const argv of [["whoami"], ["whoami", "--json"]]) {
      const r = await run([...argv, ...BASE], {
        store: async () => signedIn(),
        fetchImpl: f,
      });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain(PERSONAL);
      expect(r.out).toContain("[token]");
    }
  });

  it("never offers the token for another origin", async () => {
    const { f, calls } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", "--base-url", "https://evil.example"], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Not signed in to evil.example.");
    expect(r.err).toContain("Run pkey login.");
    expect(calls).toEqual([]);
  });

  it("refuses plaintext http to a remote host without sending", async () => {
    const { f, calls } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", "--base-url", "http://key.example"], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(2);
    expect(calls).toEqual([]);
    expect(r.err).not.toContain("pkeyp_");
  });

  it("an ended sign-in (stored end date passed) refuses locally with the fix", async () => {
    const { f, calls } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(1_000),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Your sign-in to key.example has ended.");
    expect(r.err).toContain("Run pkey login.");
    expect(calls).toEqual([]);
  });

  it("a 401 from the server reads the same", async () => {
    const { f } = fakeFetch(() =>
      json(401, { error: { code: "unauthorized" } }),
    );
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("has ended");
  });

  it("a 403 says the console refused, with no guessed cause", async () => {
    const { f } = fakeFetch(() => json(403, {}));
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe(
      "!  The console refused this sign-in.\n   Run pkey login again, or ask an admin for access.\n",
    );
    expect(r.err).not.toContain("usually");
  });

  it("a redirect is not followed and the token goes nowhere else", async () => {
    const { f, calls } = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    );
    const r = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(calls).toHaveLength(1);
    expect(r.err + r.out).not.toContain("pkeyp_");
    expect(r.out).not.toContain("evil.example");
    expect(oneLine(r.out)).toMatchObject({ ok: false, error: "redirect" });
  });

  it("PKEY_ADMIN_TOKEN (personal) wins over the store and never opens it", async () => {
    const { f, calls } = fakeFetch(() => json(200, ME));
    const envToken = `pkeyp_${"E".repeat(43)}`;
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: envToken },
      store: async () => {
        throw new Error("store must not be opened");
      },
      fetchImpl: f,
    });
    expect(r.code).toBe(0);
    expect(calls[0]?.auth).toBe(`Bearer ${envToken}`);
    expect(r.out).toContain("personal token from PKEY_ADMIN_TOKEN");
    expect(r.out).not.toContain(envToken);
  });

  it("a rejected PKEY_ADMIN_TOKEN also says it may not be an admin token", async () => {
    const { f } = fakeFetch(() => json(401));
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: `pkeyp_${"E".repeat(43)}` },
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "PKEY_ADMIN_TOKEN was refused. It may have ended, been revoked, or not be an admin token.",
    );
  });

  it("a pkeya_ token has no person: says so, sends nothing", async () => {
    const { f, calls } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: ADMIN },
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe(
      "!  PKEY_ADMIN_TOKEN is an admin API token, not a person's sign-in.\n   Unset it, then run pkey login.\n",
    );
    expect(calls).toEqual([]);
    expect(r.err).not.toContain(ADMIN);
  });

  it("a bad PKEY_ADMIN_TOKEN shape names the fix and never quotes it", async () => {
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: "pkeyp_oops-secret" },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("not a pkeya_ or pkeyp_ token");
    expect(r.err).not.toContain("oops-secret");
  });

  it("no credential store: refuses with what to set the variable to", async () => {
    const r = await run(["whoami", ...BASE], {
      store: async () => {
        throw new NoStoreError();
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("No credential store on this computer.");
    expect(r.err).toContain(
      "Set PKEY_ADMIN_TOKEN to a personal token (pkeyp_…) instead.",
    );
  });

  it("a keychain that refuses is not 'no credential store'", async () => {
    const r = await run(["whoami", "--json", ...BASE], {
      store: async () => {
        throw new KeychainRefusedError();
      },
    });
    expect(r.code).toBe(4);
    expect(oneLine(r.out)).toMatchObject({
      ok: false,
      exit: 4,
      error: "keychain-refused",
    });
    expect(r.out).not.toContain("No credential store");
  });

  it("offline: ✗ Can't reach, exit 1, the cause code in --json, no token", async () => {
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: offline(),
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "x  Can't reach key.example.\n   Check your network, or --base-url.\n",
    );
    const j = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: offline("ENOTFOUND"),
    });
    expect(j.code).toBe(1);
    expect(oneLine(j.out)).toMatchObject({
      ok: false,
      exit: 1,
      error: "unreachable",
      cause: "ENOTFOUND",
    });
    expect(j.err).toBe("");
    expect(r.err + r.out + j.out).not.toContain("pkeyp_");
  });

  it("a 5xx is ✗ <host> answered 500, exit 1", async () => {
    const { f } = fakeFetch(() => json(500));
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "x  key.example answered 500.\n   Try again in a minute.\n",
    );
  });

  it("a 200 that is not a console's answer is not a success", async () => {
    for (const body of [
      new Response("<html>hello</html>", { status: 200 }),
      json(200, { hello: "world" }),
      json(200, []),
    ]) {
      const r = await run(["whoami", ...BASE], {
        store: async () => signedIn(),
        fetchImpl: (async () => body.clone()) as typeof fetch,
      });
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toBe(
        "x  key.example didn't answer as a Polaris Key console.\n   Check --base-url.\n",
      );
    }
    const j = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: (async () => json(200, { hello: 1 })) as typeof fetch,
    });
    expect(oneLine(j.out)).toMatchObject({ ok: false, error: "not-a-console" });
  });

  it("--json refusals are one line on stdout and nothing on stderr", async () => {
    const cases: [string, Parameters<typeof run>[1], string][] = [
      ["not-signed-in", { store: async () => memoryStore() }, "not-signed-in"],
      ["ended", { store: async () => signedIn(1_000) }, "sign-in-ended"],
      ["pkeya", { env: { PKEY_ADMIN_TOKEN: ADMIN } }, "admin-api-token"],
      [
        "bad env",
        { env: { PKEY_ADMIN_TOKEN: "pkeyp_x" } },
        "env-token-refused",
      ],
      [
        "no store",
        {
          store: async () => {
            throw new NoStoreError();
          },
        },
        "no-credential-store",
      ],
    ];
    for (const [name, opts, error] of cases) {
      const r = await run(["whoami", "--json", ...BASE], opts);
      expect(r.code, name).toBe(4);
      expect(r.err, name).toBe("");
      expect(oneLine(r.out), name).toMatchObject({
        v: 1,
        command: "whoami",
        event: "result",
        ok: false,
        exit: 4,
        error,
      });
      expect(typeof oneLine(r.out)["message"]).toBe("string");
    }
  });

  it("PKEY_DEBUG output carries no token either", async () => {
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_DEBUG: "1" },
      store: async () => signedIn(),
      fetchImpl: offline(),
    });
    expect(r.err + r.out).not.toContain(PERSONAL);
  });
});

/** A store whose delete fails (a keychain that refuses). */
function failingDelete(): CredentialStore & { calls: number } {
  const inner = signedIn(FAR, LABELLED);
  const s = {
    calls: 0,
    get: (o: string) => inner.get(o),
    set: (o: string, c: Parameters<CredentialStore["set"]>[1]) =>
      inner.set(o, c),
    delete: (): boolean => {
      s.calls++;
      throw new KeychainRefusedError();
    },
  };
  return s;
}

describe("logout", () => {
  it("revokes the presenting token, then clears the store", async () => {
    const store = signedIn();
    const order: string[] = [];
    const { f, calls } = fakeFetch(() => {
      order.push(
        store.entries.size ? "revoke-with-entry" : "revoke-after-clear",
      );
      return json(200, { ok: true });
    });
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      {
        url: `${ORIGIN}/manage/api/me/personal-tokens/current`,
        method: "DELETE",
        auth: `Bearer ${PERSONAL}`,
        redirect: "manual",
      },
    ]);
    expect(order).toEqual(["revoke-with-entry"]);
    expect(store.entries.size).toBe(0);
    expect(r.out).toBe("+  Signed out of key.example. The token is revoked.\n");
    expect(r.out + r.err).not.toContain("pkeyp_");
  });

  it("offline: clears the store, says the token works until its local date, names where to revoke it", async () => {
    const store = signedIn(FAR, LABELLED);
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: offline(),
      columns: 100,
    });
    expect(store.entries.size).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "!  Signed out on this computer, but couldn't reach key.example, so it still",
        "   works until 2096-10-02.",
        '   Revoke "pkey on ada-macbook" (pkeyp_...h7Q2) in Personal tokens:',
        `   ${ORIGIN}/manage/#/personal-tokens`,
        "",
      ].join("\n"),
    );
    expect(r.out).toBe("");
    expect(r.err + r.out).not.toContain(PERSONAL);
  });

  it("the end date is the local one, not UTC", async () => {
    const r = await run(["logout", ...BASE], {
      env: { TZ: "America/Los_Angeles" },
      store: async () => signedIn(3_999_982_000, LABELLED),
      fetchImpl: offline(),
    });
    expect(r.err.replace(/\s+/g, " ")).toContain("works until 2096-10-01.");
  });

  it("offline --json: one line with tokenEndsAt and revokeUrl, nothing on stderr", async () => {
    const r = await run(["logout", "--json", ...BASE], {
      store: async () => signedIn(3_999_982_000, LABELLED),
      fetchImpl: offline(),
    });
    expect(r.code).toBe(1);
    expect(r.err).toBe("");
    expect(oneLine(r.out)).toMatchObject({
      v: 1,
      command: "logout",
      event: "result",
      ok: false,
      exit: 1,
      error: "unreachable",
      revoked: false,
      cleared: true,
      tokenEndsAt: "2096-10-02T02:06:40.000Z",
      revokeUrl: `${ORIGIN}/manage/#/personal-tokens`,
    });
  });

  it("a server error says it didn't revoke the token (not that it couldn't be reached)", async () => {
    const store = signedIn(null, LABELLED);
    const { f } = fakeFetch(() => json(500));
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
      columns: 120,
    });
    expect(store.entries.size).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "Signed out on this computer, but key.example didn't revoke it (HTTP 500), so it still works until it ends.",
    );
    expect(r.err).not.toContain("reach");
  });

  it("a 403, 409 or 429 is 'refused to revoke'", async () => {
    for (const status of [403, 409, 429]) {
      const store = signedIn(FAR, LABELLED);
      const { f } = fakeFetch(() => json(status));
      const r = await run(["logout", ...BASE], {
        store: async () => store,
        fetchImpl: f,
        columns: 120,
      });
      expect(store.entries.size, `${status}`).toBe(0);
      expect(r.code, `${status}`).toBe(1);
      expect(r.err.replace(/\s+/g, " ")).toContain(
        `key.example refused to revoke it (HTTP ${status}), so it still works`,
      );
    }
  });

  it("a token that already ended (401) is cleared, exit 0", async () => {
    const store = signedIn();
    const { f } = fakeFetch(() => json(401));
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
    });
    expect(r.code).toBe(0);
    expect(store.entries.size).toBe(0);
    expect(r.out).toBe(
      "+  Signed out of key.example. The token had already ended.\n",
    );
  });

  it("a 404 counts as ended only when it is the Worker's JSON not_found", async () => {
    const worker = signedIn();
    const a = await run(["logout", ...BASE], {
      store: async () => worker,
      fetchImpl: fakeFetch(() => json(404, { error: { code: "not_found" } })).f,
    });
    expect(a.code).toBe(0);
    expect(a.out).toContain("already ended");
    expect(worker.entries.size).toBe(0);

    for (const res of [
      () => new Response("<h1>Not Found</h1>", { status: 404 }),
      () => json(404, { error: { code: "something_else" } }),
    ]) {
      const store = signedIn();
      const b = await run(["logout", ...BASE], {
        store: async () => store,
        fetchImpl: fakeFetch(res).f,
        columns: 120,
      });
      expect(b.code).toBe(1);
      expect(b.err).toContain("didn't revoke it (HTTP 404)");
      expect(store.entries.size).toBe(0);
    }
  });

  it("a redirect clears the local entry, warns, and follows nothing", async () => {
    const store = signedIn(FAR, LABELLED);
    const { f, calls } = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x" },
        }),
    );
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
      columns: 120,
    });
    expect(calls).toHaveLength(1);
    expect(store.entries.size).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err.replace(/\s+/g, " ")).toContain("redirected the request");
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "still works until 2096-10-02",
    );
    expect(r.err).not.toContain("evil.example");
  });

  it("a stored token whose end date has passed is cleared without a request, exit 0", async () => {
    const store = signedIn(1_000, LABELLED);
    const { f, calls } = fakeFetch(() => json(200));
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
    });
    expect(calls).toEqual([]);
    expect(store.entries.size).toBe(0);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "+  Signed out of key.example. The token had already ended.\n",
    );
  });

  it("with PKEY_ADMIN_TOKEN set it says pkey logout doesn't end it, and touches nothing", async () => {
    const store = signedIn();
    const { f, calls } = fakeFetch(() => json(200));
    const r = await run(["logout", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: ADMIN },
      store: async () => store,
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe(
      "!  pkey is using PKEY_ADMIN_TOKEN, which pkey logout doesn't end.\n   Unset it, then run pkey logout.\n",
    );
    expect(calls).toEqual([]);
    expect(store.entries.size).toBe(1);
    expect(r.err).not.toContain(ADMIN);
  });

  it("not signed in is a plain exit 0", async () => {
    const r = await run(["logout", ...BASE], {
      store: async () => memoryStore(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe("+  Already signed out of key.example.\n");
  });

  it("only the entry for that origin is revoked and removed", async () => {
    const store = memoryStore({
      [ORIGIN]: { token: PERSONAL, expiresAt: FAR },
      "https://other.example": {
        token: `pkeyp_${"O".repeat(43)}`,
        expiresAt: FAR,
      },
    });
    const { f, calls } = fakeFetch(() => json(200));
    await run(["logout", ...BASE], { store: async () => store, fetchImpl: f });
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${PERSONAL}`]);
    expect([...store.entries.keys()]).toEqual(["https://other.example"]);
  });

  it("--json: one result line, no token", async () => {
    const { f } = fakeFetch(() => json(200));
    const r = await run(["logout", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(oneLine(r.out)).toMatchObject({
      v: 1,
      command: "logout",
      event: "result",
      ok: true,
      exit: 0,
      revoked: true,
      cleared: true,
    });
    expect(r.out).not.toContain("pkeyp_");
    expect(r.err).toBe("");
  });

  it("if the store can't delete after a revoke, it says so and never claims there is no store", async () => {
    const store = failingDelete();
    const { f } = fakeFetch(() => json(200));
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
    });
    expect(store.calls).toBe(1);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "x  The token is revoked, but pkey couldn't remove it from the credential store.\n   Allow pkey access to the credential store, then run pkey logout again.\n",
    );
    expect(r.err).not.toContain("No credential store");
    const j = await run(["logout", "--json", ...BASE], {
      store: async () => failingDelete(),
      fetchImpl: f,
    });
    expect(oneLine(j.out)).toMatchObject({
      ok: false,
      error: "keychain-refused",
      revoked: true,
      cleared: false,
    });
  });

  it("no credential store: refuses with the fix", async () => {
    const r = await run(["logout", ...BASE], {
      store: async () => {
        throw new NoStoreError();
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Set PKEY_ADMIN_TOKEN to a personal token");
  });
});

const COLOUR = {
  CI: "",
  NO_COLOR: "",
  TERM: "xterm-256color",
  FORCE_COLOR: "1",
};

describe("colour terminals: every glyph role exists", () => {
  it("whoami ✗ in colour does not throw (R1)", async () => {
    const { f } = fakeFetch(() => json(500));
    const r = await run(["whoami", ...BASE], {
      env: COLOUR,
      store: async () => signedIn(),
      fetchImpl: f,
      columns: 80,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("\x1b[");
    expect(r.err).toContain("key.example answered 500.");
    expect(r.err).not.toContain("TypeError");
  });

  it("logout ✗ in colour does not throw (R1)", async () => {
    const mem = signedIn();
    const refusing: CredentialStore = {
      get: mem.get,
      set: mem.set,
      delete: () => {
        throw new NoStoreError();
      },
    };
    const { f } = fakeFetch(() => json(200));
    const r = await run(["logout", ...BASE], {
      env: COLOUR,
      store: async () => refusing,
      fetchImpl: f,
      columns: 80,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("\x1b[");
    expect(r.err).toContain("couldn't remove it from the credential store");
  });

  it("whoami ▲ and the success row in colour render", async () => {
    const { f } = fakeFetch(() => json(200, ME));
    const ok = await run(["whoami", ...BASE], {
      env: COLOUR,
      store: async () => signedIn(FAR, LABELLED),
      fetchImpl: f,
      columns: 80,
    });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("\x1b[");
    const refused = await run(["whoami", ...BASE], {
      env: COLOUR,
      store: async () => memoryStore(),
      columns: 80,
    });
    expect(refused.code).toBe(4);
    expect(refused.err).toContain("\x1b[");
  });
});

describe("whoami rows (R2, R3, R4)", () => {
  const HOST = "licensing-staging.moonlit-harbor-games.example.com";
  const longMe = (over: Record<string, unknown>) => ({ ...ME, ...over });
  const at = async (columns: number, me: unknown, base = ORIGIN) => {
    const { f } = fakeFetch(() => json(200, me));
    const store = memoryStore({
      [base]: { token: PERSONAL, expiresAt: FAR, ...LABELLED },
    });
    return run(["whoami", "--base-url", base], {
      store: async () => store,
      fetchImpl: f,
      columns,
    });
  };

  it("R2: a long host and email wrap at their own break points and are never cut", async () => {
    const email = "priya.ramanathan-subramanian@analytical-engine.example";
    for (const columns of [60, 40, 32]) {
      const r = await at(columns, longMe({ email }), `https://${HOST}`);
      for (const l of r.out.trimEnd().split("\n"))
        expect(l.length, l).toBeLessThanOrEqual(columns);
      expect(r.out).not.toContain("…");
      const joined = (label: string) => {
        const lines = r.out.split("\n");
        const i = lines.findIndex((l) => l.startsWith(label));
        const parts = [lines[i]!.slice(label.length).trim()];
        for (
          let j = i + 1;
          j < lines.length && lines[j]!.startsWith("        ");
          j++
        )
          parts.push(lines[j]!.trim());
        return parts.join("");
      };
      if (columns >= 32) {
        expect(joined("Host"), `${columns}`).toBe(HOST);
        expect(joined("Email"), `${columns}`).toBe(email);
      }
    }
  });

  it("R3: a spaceless name wider than the row breaks at a hyphen, then in runs, and never overflows", async () => {
    const name =
      "Wolfeschlegelsteinhausenbergerdorff-Wolfeschlegelsteinhausenbergerdorffxxxxxxxxxxxxxxxxxxx";
    for (const columns of [40, 32, 28, 24]) {
      const r = await at(columns, longMe({ name }));
      for (const l of r.out.trimEnd().split("\n"))
        expect(l.length, `${columns}: ${l}`).toBeLessThanOrEqual(columns);
      expect(r.out.replace(/\s+/g, "")).toContain(name.replace(/\s+/g, ""));
    }
  });

  it("R4: below 32 columns each label is its own line and the value starts at column 0", async () => {
    const r = await at(28, ME);
    const lines = r.out.trimEnd().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "Host",
      "key.example",
      "Name",
      "Ada Lovelace",
    ]);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(28);
      expect(l.startsWith(" "), l).toBe(false);
      expect(/^[,;·-]/.test(l), l).toBe(false);
    }
    const t32 = await at(32, ME);
    expect(t32.out.split("\n")[0]).toBe("Host    key.example");
  });

  it("the end date is its own row; the token is the label and the console's hint form", async () => {
    const r = await at(80, ME);
    expect(r.out).toContain('Token   "pkey on ada-macbook" (pkeyp_...h7Q2)\n');
    expect(r.out).toContain("Ends    2096-10-02\n");
    expect(r.out).not.toMatch(/, ends/);
  });

  it("an entry with no stored label shows the hint alone, never an invented label", async () => {
    const { f } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.out).toContain("Token   pkeyp_...PPPP\n");
    expect(r.out).not.toContain("pkey on");
    const j = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    const token = (oneLine(j.out) as { token: Record<string, unknown> }).token;
    expect(token).not.toHaveProperty("label");
    expect(token["hint"]).toBe("PPPP");
  });

  it("the root-lapse note has a blank row before it", async () => {
    const { f } = fakeFetch(() =>
      json(200, {
        ...ME,
        permissions: { roles: [role("superadmin", "platform", "root")] },
      }),
    );
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
      columns: 100,
    });
    expect(r.out).toMatch(/Ends {4}2096-10-02\n\n!  Superadmin ends 8 hours/);
  });
});

describe("account commands: refusals and bounds", () => {
  it("a 403 is sign-in-refused in --json, distinct from sign-in-ended", async () => {
    const { f } = fakeFetch(() => json(403));
    const r = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(oneLine(r.out)).toMatchObject({ exit: 4, error: "sign-in-refused" });
    const ended = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: fakeFetch(() => json(401)).f,
    });
    expect(oneLine(ended.out)).toMatchObject({ error: "sign-in-ended" });
  });

  it("a keychain refusal names the command to run again", async () => {
    const r = await run(["whoami", ...BASE], {
      store: async () => {
        throw new KeychainRefusedError();
      },
    });
    expect(r.err).toContain("then run pkey whoami again.");
    const l = await run(["logout", ...BASE], {
      store: async () => {
        throw new KeychainRefusedError();
      },
    });
    expect(l.err).toContain("then run pkey logout again.");
  });

  it("a non-https --base-url is a short ▲ usage line (exit 2) that never names PKEY_ADMIN_TOKEN", async () => {
    for (const command of ["whoami", "logout"]) {
      const r = await run([command, "--base-url", "http://key.example"], {
        store: async () => signedIn(),
        columns: 40,
      });
      expect(r.code, command).toBe(2);
      expect(r.err, command).toContain(
        `!  pkey ${command} needs an https address.`,
      );
      expect(r.err.replace(/\s+/g, " ")).toContain(
        "Use https://key.plrs.im; http works only on localhost.",
      );
      expect(r.err).not.toContain("PKEY_ADMIN_TOKEN");
      for (const l of r.err.trimEnd().split("\n"))
        expect(l.length, l).toBeLessThanOrEqual(40);
      const j = await run(
        [command, "--json", "--base-url", "http://key.example"],
        {
          store: async () => signedIn(),
        },
      );
      expect(j.code).toBe(2);
      expect(j.err).toBe("");
      expect(oneLine(j.out)).toMatchObject({
        ok: false,
        exit: 2,
        error: "usage",
      });
      expect(j.out).not.toContain("PKEY_ADMIN_TOKEN");
    }
  });

  it("unknown flags and extra words are ignored, as every other command does", async () => {
    const { f } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", "--bogus", "extra", ...BASE], {
      store: async () => signedIn(FAR, LABELLED),
      fetchImpl: f,
    });
    expect(r.code).toBe(0);
    const v = await run(["validate", "--bogus", "extra"]);
    expect(v.err).not.toContain("Unknown option");
  });

  it("N1: a body past 64 KiB is read as nothing, not buffered", async () => {
    const big = "x".repeat(70_000);
    const { f } = fakeFetch(() => json(200, { ...ME, pad: big }));
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("didn't answer as a Polaris Key console");
  });

  it("N3: a request that times out is the same as one that cannot connect", async () => {
    const timeout = (async () => {
      throw Object.assign(new Error("The operation timed out"), {
        name: "TimeoutError",
      });
    }) as typeof fetch;
    const r = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: timeout,
    });
    expect(oneLine(r.out)).toMatchObject({
      exit: 1,
      error: "unreachable",
      cause: "TIMEOUT",
    });
  });

  it("every call carries a timeout signal", async () => {
    let signal: AbortSignal | null | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      signal = init.signal;
      return json(200, ME);
    }) as typeof fetch;
    await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("a token typed into --base-url is masked in the error", async () => {
    const r = await run(["whoami", "--base-url", `not a url ${PERSONAL}`], {
      store: async () => signedIn(),
    });
    expect(r.err + r.out).not.toContain(PERSONAL);
  });
});

describe("account registry", () => {
  it("the account commands are in the registry, which is sound", () => {
    const names = COMMANDS.filter((c) => c.group === "account").map(
      (c) => c.name,
    );
    expect(names).toEqual(["login", "whoami", "logout"]);
    expect(checkRegistry()).toEqual([]);
  });

  it("exit 4 is in the table", () => {
    expect(EXIT_CODES.map(([c]) => c)).toContain("4");
  });
});

describe("the Action bundle", () => {
  it("does not contain the keyring module", () => {
    const bundle = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../actions/publish/dist/index.js",
    );
    if (!existsSync(bundle)) return;
    const text = readFileSync(bundle, "utf8");
    expect(text).not.toMatch(/keyring-(darwin|linux|win32)/);
    // The import is aliased to a module that throws: the Action can never load a keyring, nor
    // resolve one from the runner's working directory.
    expect(text).not.toContain("@napi-rs/keyring");
    expect(text).toContain('throw new Error("pkey-action-no-keyring")');
  });
});
