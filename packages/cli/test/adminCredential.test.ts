// The admin commands on the shared credential (ST-34.9): `pkey bundle`, `pkey migrate` and
// `pkey listing import` all resolve `adminCredential()` and send it as a bearer token.
//
// Pinned here:
//   * each command with a keychain token, a `pkeya_` env token and a `pkeyp_` env token;
//   * a 403 `no_access` is a ▲ refusal (exit 4) naming the product and area, the roles and the
//     people to ask; a 403 outside a personal token's reach, and a `pkeya_` token on the import,
//     say "isn't available to ... tokens";
//   * the base-URL rule runs before the credential leaves, and a token pasted into --base-url is
//     never printed back;
//   * 80 and 40 column frames of the refusal and the not-signed-in frame.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/credentials.js";
import { runPkey } from "../src/index.js";

const PERSONAL = `pkeyp_${"P".repeat(43)}`;
const API = `pkeya_${"A".repeat(43)}`;
const STORED = `pkeyp_${"S".repeat(43)}`;
const ORIGIN = "https://key.example";
const FAR = 4_000_000_000;
const GODOT = path.join(import.meta.dirname, "fixtures", "godot-listing");
const DEVICE = "AbCdEfGh0123456789_-ijKLmnOPqrst";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

interface Call {
  url: string;
  method: string;
  auth: string | null;
  cookie: string | null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A server that answers each admin route with `answer`; every call is recorded. */
function server(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    const c: Call = {
      url: String(url),
      method: init.method ?? "GET",
      auth: h.get("authorization"),
      cookie: h.get("cookie"),
    };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return { f, calls };
}

const ok = (c: Call): Response => {
  if (c.url.endsWith("/bundles"))
    return json(200, { bundleId: "b1", bundle: "e30.e30.c2ln" });
  if (c.url.includes("/platform/migrations")) return json(200, { jobs: [] });
  if (c.url.endsWith("/listing/import"))
    return json(200, {
      import: {
        applied: false,
        digest: "d".repeat(64),
        createsListing: false,
        defaultLocale: "en-US",
        changes: [],
        refused: [],
        identifiers: [],
        assets: [],
        written: [],
      },
    });
  return json(404, {});
};

async function run(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    stored?: string;
    fetchImpl: typeof fetch;
    columns?: number;
    cwd?: string;
  },
) {
  let out = "";
  let err = "";
  const store = memoryStore(
    opts.stored
      ? { [ORIGIN]: { token: opts.stored, expiresAt: FAR } }
      : undefined,
  );
  const code = await runPkey(argv, {
    cwd: opts.cwd ?? (await mkdtemp(path.join(os.tmpdir(), "pkey-admin-"))),
    env: { CI: "true", NO_COLOR: "1", TERM: "xterm-256color", ...opts.env },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: {
      write: (s: string) => ((err += s), true),
      ...(opts.columns ? { isTTY: true, columns: opts.columns } : {}),
    },
    credentialStore: async () => store,
    fetchImpl: opts.fetchImpl,
  });
  return { code, out, err };
}

const BUNDLE = [
  "bundle",
  "--product",
  "djdl",
  "--device",
  DEVICE,
  "--grace-days",
  "30",
  "--base-url",
  ORIGIN,
  "--out",
  "x.pkeybundle",
];
const MIGRATE = ["migrate", "list", "--base-url", ORIGIN];
const IMPORT = [
  "listing",
  "import",
  "--godot",
  GODOT,
  "--product",
  "diceroll",
  "--base-url",
  ORIGIN,
];

describe("the three admin commands share one credential", () => {
  const cases: [string, string[], string][] = [
    ["bundle", BUNDLE, "/manage/api/products/djdl/bundles"],
    ["migrate", MIGRATE, "/manage/api/platform/migrations"],
    [
      "listing import",
      IMPORT,
      "/manage/api/products/diceroll/distribution/listing/import",
    ],
  ];

  describe.each(cases)("pkey %s", (name, argv, route) => {
    it("sends the keychain token when PKEY_ADMIN_TOKEN is unset", async () => {
      const s = server(ok);
      const cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-admin-"));
      dirs.push(cwd);
      const r = await run(argv, { stored: STORED, fetchImpl: s.f, cwd });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(s.calls.map((c) => c.url)).toEqual([`${ORIGIN}${route}`]);
      expect(s.calls[0]!.auth).toBe(`Bearer ${STORED}`);
      expect(s.calls[0]!.cookie).toBeNull();
    });

    it("sends a pkeyp_ env token, ahead of the keychain", async () => {
      const s = server(ok);
      const cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-admin-"));
      dirs.push(cwd);
      const r = await run(argv, {
        env: { PKEY_ADMIN_TOKEN: PERSONAL },
        stored: STORED,
        fetchImpl: s.f,
        cwd,
      });
      expect(r.code).toBe(0);
      expect(s.calls[0]!.auth).toBe(`Bearer ${PERSONAL}`);
    });

    it(
      name === "listing import"
        ? "sends a pkeya_ env token (the server then refuses it)"
        : "sends a pkeya_ env token",
      async () => {
        const s = server(ok);
        const cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-admin-"));
        dirs.push(cwd);
        const r = await run(argv, {
          env: { PKEY_ADMIN_TOKEN: API },
          fetchImpl: s.f,
          cwd,
        });
        expect(r.code).toBe(0);
        expect(s.calls[0]!.auth).toBe(`Bearer ${API}`);
      },
    );

    it("refuses a signed-out run with the fix and sends nothing", async () => {
      const s = server(ok);
      const r = await run(argv, { fetchImpl: s.f });
      expect(r.code).toBe(4);
      expect(r.err).toContain("▲  Not signed in to key.example.");
      expect(r.err).toContain("Run pkey login.");
      expect(s.calls).toEqual([]);
    });

    it("checks the base-URL rule before the credential leaves", async () => {
      const s = server(ok);
      const bad = argv.map((a) => (a === ORIGIN ? "http://evil.example" : a));
      const r = await run(bad, { stored: STORED, fetchImpl: s.f });
      expect(r.code).toBe(2);
      expect(r.err).toContain("--base-url must be https:");
      expect(s.calls).toEqual([]);
    });

    it("never prints a token pasted into --base-url", async () => {
      const s = server(ok);
      for (const pasted of [PERSONAL, API]) {
        const bad = argv.map((a) => (a === ORIGIN ? pasted : a));
        const r = await run(bad, {
          env: { PKEY_ADMIN_TOKEN: STORED },
          fetchImpl: s.f,
        });
        expect(r.code).toBe(2);
        expect(r.err).toContain("[token]");
        for (const text of [r.out, r.err]) {
          expect(text).not.toContain(pasted);
          expect(text).not.toContain(STORED);
        }
      }
      expect(s.calls).toEqual([]);
    });
  });

  it.each([
    ["whoami", ["whoami"]],
    ["whoami --json", ["whoami", "--json"]],
    ["migrate --json", ["migrate", "list", "--json"]],
  ])(
    "pkey %s never prints a token pasted into --base-url",
    async (_n, argv) => {
      const s = server(ok);
      for (const pasted of [PERSONAL, API]) {
        const r = await run([...argv, "--base-url", pasted], {
          env: { PKEY_ADMIN_TOKEN: STORED },
          fetchImpl: s.f,
        });
        expect(r.code).toBe(2);
        for (const text of [r.out, r.err]) {
          expect(text).not.toContain(pasted);
          expect(text).not.toContain(STORED);
          expect(text).not.toContain(
            pasted.slice(0, 12) + pasted.slice(12, 20),
          );
        }
        expect(r.err).toContain("[token]");
      }
      expect(s.calls).toEqual([]);
    },
  );

  it("listing import --dry-run needs no credential and sends nothing", async () => {
    const s = server(ok);
    const r = await run(["listing", "import", "--godot", GODOT, "--dry-run"], {
      fetchImpl: s.f,
    });
    expect(r.code).toBe(0);
    expect(s.calls).toEqual([]);
  });
});

const ME = {
  permissions: {
    roles: [
      { role: "platform_admin", scope: "platform" },
      { role: "product_admin", scope: "product:djdl" },
    ],
  },
};
const ADMINS = {
  scope: "product:diceroll",
  area: "ship",
  admins: [
    { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
    { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
  ],
};

function noAccess(c: Call): Response {
  if (c.url.endsWith("/manage/api/me")) return json(200, ME);
  if (c.url.includes("/manage/api/access/admins")) return json(200, ADMINS);
  return json(403, {
    error: {
      code: "forbidden",
      message: "You don't have access to this.",
      reason: "no_access",
      scope: "product:diceroll",
      area: "ship",
    },
    code: "forbidden",
    reason: "no_access",
    scope: "product:diceroll",
    area: "ship",
  });
}

describe("a 403 is a refusal that says who to ask", () => {
  it("no_access: names the product and area, the roles and the people, and exits 4", async () => {
    const s = server(noAccess);
    const r = await run(IMPORT, {
      env: { PKEY_ADMIN_TOKEN: PERSONAL },
      fetchImpl: s.f,
    });
    expect(r.code).toBe(4);
    expect(r.out).toBe("");
    expect(r.err).toContain(
      "▲  You don't have access to diceroll → Ship builds.",
    );
    expect(r.err).toContain(
      "Your roles: Platform admin, djdl admin. Ask one of these people:",
    );
    expect(r.err).toContain(
      "     Kenji Mori     kenji@example.com  diceroll admin\n",
    );
    expect(r.err).toContain(
      "     Ada Lindqvist  ada@example.com    Superadmin\n",
    );
    // The lookups ask for the scope and area the server named.
    expect(s.calls.map((c) => c.url)).toContain(
      `${ORIGIN}/manage/api/access/admins?scope=product%3Adiceroll&area=ship`,
    );
    expect(r.err).not.toContain(PERSONAL);
  });

  it("no_access: with nobody to name, still a refusal", async () => {
    const s = server((c) =>
      c.url.endsWith("/manage/api/me") || c.url.includes("/access/admins")
        ? json(500, {})
        : noAccess(c),
    );
    const r = await run(IMPORT, {
      env: { PKEY_ADMIN_TOKEN: PERSONAL },
      fetchImpl: s.f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Ask an admin to give you access.");
  });

  it("a personal token outside its reach: not available to personal tokens", async () => {
    const s = server(() =>
      json(403, {
        code: "forbidden",
        message: "token is not scoped for this route",
      }),
    );
    const r = await run(BUNDLE, {
      env: { PKEY_ADMIN_TOKEN: PERSONAL },
      fetchImpl: s.f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "▲  pkey bundle isn't available to personal tokens.",
    );
  });

  it("listing import with a pkeya_ token: 403 with the not-available-to-API-tokens copy", async () => {
    const s = server(() =>
      json(403, {
        code: "forbidden",
        message: "token is not scoped for this route",
      }),
    );
    const r = await run(IMPORT, {
      env: { PKEY_ADMIN_TOKEN: API },
      fetchImpl: s.f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "▲  pkey listing import isn't available to API tokens.",
    );
    expect(r.err).toContain("Run pkey login.");
    expect(s.calls).toHaveLength(1);
  });

  it("a pkeya_ token that lacks the scope on bundle keeps the plain failure", async () => {
    const s = server(() =>
      json(403, {
        code: "forbidden",
        message: "token is not scoped for this route",
      }),
    );
    const r = await run(BUNDLE, {
      env: { PKEY_ADMIN_TOKEN: API },
      fetchImpl: s.f,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("bundles:mint");
  });
});

describe("the terminal frames at 80 and 40 columns", () => {
  for (const columns of [80, 40]) {
    it(`no_access frame fits ${columns} columns`, async () => {
      const s = server(noAccess);
      const r = await run(IMPORT, {
        env: { PKEY_ADMIN_TOKEN: PERSONAL },
        fetchImpl: s.f,
        columns,
      });
      for (const line of r.err.split("\n"))
        expect([...line].length).toBeLessThanOrEqual(columns);
      expect(r.err.startsWith("▲  You don't have access")).toBe(true);
    });

    it(`not-signed-in frame fits ${columns} columns`, async () => {
      const s = server(ok);
      const r = await run(IMPORT, { fetchImpl: s.f, columns });
      for (const line of r.err.split("\n"))
        expect([...line].length).toBeLessThanOrEqual(columns);
      expect(r.err).toBe(
        "▲  Not signed in to key.example.\n   Run pkey login.\n",
      );
    });
  }
});
