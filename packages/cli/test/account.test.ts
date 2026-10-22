import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS, EXIT_CODES, checkRegistry } from "../src/help.js";
import { runPkey } from "../src/index.js";
import {
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

const ME = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  permissions: {
    roles: [
      { role: "admin", scope: "product:djdl" },
      { role: "superadmin", scope: "platform" },
    ],
  },
  sessionExpiresAt: FAR,
};

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function run(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    store?: () => Promise<CredentialStore>;
    fetchImpl?: typeof fetch;
  } = {},
) {
  let out = "";
  let err = "";
  const code = await runPkey(argv, {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { CI: "true", NO_COLOR: "1", TERM: "dumb", ...opts.env },
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    fetchImpl: opts.fetchImpl,
    credentialStore: opts.store,
  });
  return { code, out, err };
}

const signedIn = (expiresAt: number | null = FAR) =>
  memoryStore({ [ORIGIN]: { token: PERSONAL, expiresAt } });

const BASE = ["--base-url", ORIGIN];

describe("whoami", () => {
  it("prints the person, roles and end date, sends the token to its origin only", async () => {
    const store = signedIn();
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
    expect(r.out).toContain("Ada Lovelace");
    expect(r.out).toContain("ada@example.com");
    expect(r.out).toContain("admin (product:djdl), superadmin (platform)");
    expect(r.out).toContain("personal (admin), ends 2096-10-02");
    expect(r.out).toContain("Superadmin access lapses");
  });

  it("--json is one object, with no token", async () => {
    const { f } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    const v = JSON.parse(r.out) as Record<string, unknown>;
    expect(v).toMatchObject({
      v: 1,
      command: "whoami",
      ok: true,
      host: "key.example",
      token: { type: "personal", scope: "admin" },
    });
    expect(r.out).not.toContain("pkeyp_");
    expect(r.err).toBe("");
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

  it("a 403 names the console sign-in", async () => {
    const { f } = fakeFetch(() => json(403, {}));
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("recent console sign-in");
  });

  it("a redirect is not followed and the token goes nowhere else", async () => {
    const { f, calls } = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    );
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(calls).toHaveLength(1);
    expect(r.err + r.out).not.toContain("pkeyp_");
    expect(r.err).not.toContain("evil.example");
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
    expect(r.out).toContain("from PKEY_ADMIN_TOKEN");
    expect(r.out).not.toContain(envToken);
  });

  it("a pkeya_ token has no person: refuses, sends nothing", async () => {
    const { f, calls } = fakeFetch(() => json(200, ME));
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: ADMIN },
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("admin API token");
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

  it("no credential store: refuses with the PKEY_ADMIN_TOKEN fix", async () => {
    const r = await run(["whoami", ...BASE], {
      store: async () => {
        throw new NoStoreError();
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("No credential store on this machine.");
    expect(r.err).toContain("Set PKEY_ADMIN_TOKEN instead.");
  });

  it("a network failure is exit 1 and does not echo the token", async () => {
    const r = await run(["whoami", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(r.code).toBe(1);
    expect(r.err + r.out).not.toContain("pkeyp_");
  });

  it("PKEY_DEBUG output carries no token either", async () => {
    const r = await run(["whoami", ...BASE], {
      env: { PKEY_DEBUG: "1" },
      store: async () => signedIn(),
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(r.err + r.out).not.toContain(PERSONAL);
  });
});

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
    expect(r.out).toContain("Signed out of key.example. The token is revoked.");
    expect(r.out + r.err).not.toContain("pkeyp_");
  });

  it("offline: still clears the store, says the token stays valid until its date, exit 1", async () => {
    const store = signedIn(FAR);
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(store.entries.size).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not be reached to revoke the token");
    expect(r.err).toContain("stays valid until 2096-10-02");
    expect(r.err).toContain(`${ORIGIN}/manage/#/personal-tokens`);
    expect(r.err + r.out).not.toContain("pkeyp_");
  });

  it("a server error clears locally and warns the same way", async () => {
    const store = signedIn(null);
    const { f } = fakeFetch(() => json(500));
    const r = await run(["logout", ...BASE], {
      store: async () => store,
      fetchImpl: f,
    });
    expect(store.entries.size).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err).toContain("stays valid until it ends");
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
    expect(r.out).toContain("already ended");
  });

  it("with PKEY_ADMIN_TOKEN set it refuses and touches nothing", async () => {
    const store = signedIn();
    const { f, calls } = fakeFetch(() => json(200));
    const r = await run(["logout", ...BASE], {
      env: { PKEY_ADMIN_TOKEN: PERSONAL },
      store: async () => store,
      fetchImpl: f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("pkey only ends a sign-in it stored");
    expect(calls).toEqual([]);
    expect(store.entries.size).toBe(1);
    expect(r.err).not.toContain(PERSONAL);
  });

  it("not signed in is a plain exit 0", async () => {
    const r = await run(["logout", ...BASE], {
      store: async () => memoryStore(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Not signed in to key.example.");
  });

  it("only the entry for that origin is revoked and removed", async () => {
    const store = memoryStore({
      [ORIGIN]: { token: PERSONAL, expiresAt: FAR },
      "https://other.example": { token: ADMIN, expiresAt: FAR },
    });
    const { f, calls } = fakeFetch(() => json(200));
    await run(["logout", ...BASE], { store: async () => store, fetchImpl: f });
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${PERSONAL}`]);
    expect([...store.entries.keys()]).toEqual(["https://other.example"]);
  });

  it("--json: one object, no token", async () => {
    const { f } = fakeFetch(() => json(200));
    const r = await run(["logout", "--json", ...BASE], {
      store: async () => signedIn(),
      fetchImpl: f,
    });
    expect(JSON.parse(r.out)).toMatchObject({
      v: 1,
      command: "logout",
      ok: true,
      revoked: true,
      cleared: true,
    });
    expect(r.out).not.toContain("pkeyp_");
  });

  it("no credential store: refuses with the fix", async () => {
    const r = await run(["logout", ...BASE], {
      store: async () => {
        throw new NoStoreError();
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Set PKEY_ADMIN_TOKEN instead.");
  });
});

describe("login stub and registry", () => {
  it("login is registered and refuses until ST-34.8", async () => {
    const r = await run(["login"]);
    expect(r.code).toBe(4);
  });

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
    // Only the lazy import's specifier is there: none of the module's code.
    expect(text.match(/@napi-rs\/keyring/g)).toHaveLength(1);
    expect(text).toContain('import("@napi-rs/keyring")');
  });
});
