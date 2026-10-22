// The admin commands after the ST-34 integration review (fix A): `pkey bundle`, `pkey migrate`
// and `pkey listing import` on the shared credential.
//
// Pinned here:
//   S-B1  a token pasted into --base-url (host, path) never prints, on every admin command;
//   S-B2  every read is capped at 64 KiB and every request has a deadline; a 3xx is refused;
//   M1    the access refusal's people rows fit 80, 40 and 32 columns and lose nothing;
//   M2    product names and narrowed areas as the console shows them; "Platform" has no area;
//   M3    --json: every outcome is one result line, `bundle` included;
//   M4-6  a network error, an ended sign-in and a server error each say one thing, never a path;
//   m1/m2 the https refusal, and the ASCII fallback.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_JSON_BYTES,
  readCappedJson,
  readCappedText,
} from "../src/httpRead.js";
import { memoryStore } from "../src/credentials.js";
import { runPkey } from "../src/index.js";

const PERSONAL = `pkeyp_${"P".repeat(43)}`;
const API = `pkeya_${"A".repeat(43)}`;
const STORED = `pkeyp_${"S".repeat(39)}h7Q2`;
const ORIGIN = "https://key.example";
const FAR = 4_000_000_000;
const DEVICE = "AbCdEfGh0123456789_-ijKLmnOPqrst";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Call {
  url: string;
  signal: AbortSignal | null | undefined;
  redirect: string | undefined;
}

function server(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      signal: init.signal,
      redirect: init.redirect,
    });
    return answer(String(url));
  }) as typeof fetch;
  return { f, calls };
}

async function run(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    stored?: { token: string; expiresAt: number | null };
    /** The origin the stored credential is for; the default is `ORIGIN`. */
    storedAt?: string;
    fetchImpl: typeof fetch;
    columns?: number;
  },
) {
  let out = "";
  let err = "";
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pkey-fixa-"));
  dirs.push(cwd);
  const store = memoryStore(
    opts.stored ? { [opts.storedAt ?? ORIGIN]: opts.stored } : undefined,
  );
  const tty = opts.columns
    ? { isTTY: true as const, columns: opts.columns }
    : {};
  const code = await runPkey(argv, {
    cwd,
    env: { CI: "true", NO_COLOR: "1", TERM: "xterm-256color", ...opts.env },
    stdout: { write: (s: string) => ((out += s), true), ...tty },
    stderr: { write: (s: string) => ((err += s), true), ...tty },
    credentialStore: async () => store,
    fetchImpl: opts.fetchImpl,
  });
  const bare = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
  return { code, out: bare(out), err: bare(err), cwd };
}

const BUNDLE = [
  "bundle",
  "--product",
  "djdl",
  "--device",
  DEVICE,
  "--grace-days",
  "7",
  "--base-url",
  ORIGIN,
];
const MIGRATE = ["migrate", "list", "--base-url", ORIGIN];
const IN = { stored: { token: STORED, expiresAt: FAR } };
const lines = (s: string) => s.trimEnd().split("\n");
const widest = (s: string) => Math.max(...lines(s).map((l) => [...l].length));

describe("S-B1: a token in --base-url never prints", () => {
  const pasted = [
    ["host", `https://${PERSONAL}.example.com`],
    ["path", `https://key.example/${PERSONAL}`],
    ["whole", PERSONAL],
  ] as const;
  const commands: [string, string[]][] = [
    ["bundle", BUNDLE.slice(0, 7)],
    ["migrate", ["migrate", "list"]],
    ["listing import", ["listing", "import", "--godot", "x", "--product", "d"]],
    ["whoami", ["whoami"]],
  ];

  for (const [name, argv] of commands)
    for (const [where, base] of pasted) {
      it(`${name}: ${where}, when the host is down and when it answers 400 with an echo`, async () => {
        const down = server(() => {
          throw new TypeError("fetch failed");
        });
        const echo = server(() =>
          json(400, { error: { message: `bad ${PERSONAL} here` } }),
        );
        for (const s of [down, echo])
          for (const flags of [[], ["--json"]]) {
            const r = await run([...argv, "--base-url", base, ...flags], {
              fetchImpl: s.f,
              env: { PKEY_ADMIN_TOKEN: STORED },
            });
            for (const text of [r.out, r.err]) {
              expect(text).not.toContain(PERSONAL);
              expect(text).not.toContain("PPPPPPPPPP");
              expect(text).not.toContain(STORED);
            }
          }
      });
    }

  for (const [where, base] of pasted)
    it(`logout: ${where}, signed in, when the revoke cannot reach the host (the Personal tokens link)`, async () => {
      const down = server(() => {
        throw new TypeError("fetch failed");
      });
      let origin = ORIGIN;
      try {
        origin = new URL(base).origin;
      } catch {
        // not a URL: logout refuses it
      }
      for (const flags of [[], ["--json"]]) {
        const r = await run(["logout", "--base-url", base, ...flags], {
          fetchImpl: down.f,
          stored: { token: STORED, expiresAt: FAR },
          storedAt: origin,
        });
        for (const text of [r.out, r.err]) {
          expect(text.toLowerCase()).not.toContain("pppppppppp");
          expect(text).not.toContain(PERSONAL);
          expect(text).not.toContain(STORED);
        }
      }
    });

  it("the server's own words are masked when it echoes a token", async () => {
    const s = server(() =>
      json(400, { error: { message: `no such thing ${PERSONAL}` } }),
    );
    const r = await run(BUNDLE, { ...IN, fetchImpl: s.f });
    expect(r.err).toContain("[token]");
    expect(r.err).not.toContain("PPPPPPPP");
  });
});

describe("S-B2: bounded reads and a deadline", () => {
  const big = (bytes: number) => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= bytes) return c.close();
        sent += 16 * 1024;
        c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
      },
    });
    return { res: new Response(stream, { status: 200 }), sent: () => sent };
  };

  it("readCappedText stops reading past the cap and answers null", async () => {
    const b = big(10 * 1024 * 1024);
    expect(await readCappedText(b.res)).toBeNull();
    expect(b.sent()).toBeLessThan(MAX_JSON_BYTES * 4);
  });

  it("readCappedJson: an object under the cap, else {}", async () => {
    expect(await readCappedJson(json(200, { a: 1 }))).toEqual({ a: 1 });
    expect(await readCappedJson(new Response("[1]"))).toEqual({});
    expect(await readCappedJson(new Response("nope"))).toEqual({});
    expect(
      await readCappedJson(
        new Response("{}", { headers: { "content-length": "9999999" } }),
      ),
    ).toEqual({});
  });

  it("a 200 past the cap is an error that prints no body, not an unbounded read", async () => {
    const b = big(10 * 1024 * 1024);
    const s = server(() => b.res);
    const r = await run(BUNDLE, { ...IN, fetchImpl: s.f });
    expect(r.code).toBe(1);
    expect(r.err).toContain("with a body over 64 KiB");
    expect(b.sent()).toBeLessThan(MAX_JSON_BYTES * 4);
  });

  it("an error page past the cap is read as nothing", async () => {
    const b = big(10 * 1024 * 1024);
    const s = server(() => new Response(b.res.body, { status: 502 }));
    const r = await run(BUNDLE, { ...IN, fetchImpl: s.f });
    expect(r.code).toBe(1);
    expect(r.err).toContain("(HTTP 502).");
    expect(b.sent()).toBeLessThan(MAX_JSON_BYTES * 4);
  });

  it("the access lookups (/me, /access/admins) are capped and carry a deadline", async () => {
    const streams: ReturnType<typeof big>[] = [];
    const s = server((url) => {
      if (url.endsWith("/bundles"))
        return json(403, {
          reason: "no_access",
          scope: "product:djdl",
          area: "license",
        });
      const b = big(10 * 1024 * 1024);
      streams.push(b);
      return b.res;
    });
    const r = await run(BUNDLE, { ...IN, fetchImpl: s.f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("Ask an admin to give you access.");
    const lookups = s.calls.filter((c) => !c.url.endsWith("/bundles"));
    expect(lookups).toHaveLength(2);
    for (const c of lookups) expect(c.signal).toBeInstanceOf(AbortSignal);
    for (const b of streams) expect(b.sent()).toBeLessThan(MAX_JSON_BYTES * 4);
  });

  it("every request has a deadline and refuses to follow a redirect", async () => {
    const s = server(() => json(200, { jobs: [] }));
    await run(MIGRATE, { ...IN, fetchImpl: s.f });
    expect(s.calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(s.calls[0]!.redirect).toBe("manual");
  });

  it("a request that times out is 'Can't reach', with the cause TIMEOUT under --json", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
    const s = server(
      (_url) =>
        new Promise<Response>((_res, rej) =>
          rej(new DOMException("t", "TimeoutError")),
        ),
    );
    const r = await run([...MIGRATE, "--json"], { ...IN, fetchImpl: s.f });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      command: "migrate",
      error: "network",
      cause: "TIMEOUT",
    });
  });

  it("a 3xx is refused: nothing further is sent", async () => {
    const s = server(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        }),
    );
    const r = await run(MIGRATE, { ...IN, fetchImpl: s.f });
    expect(r.code).toBe(4);
    expect(r.err).toContain("▲  key.example answered with a redirect");
    expect(s.calls).toHaveLength(1);
  });
});

const ME = {
  products: [
    { slug: "djdl", name: "DJDL" },
    { slug: "diceroll", name: "Diceroll" },
  ],
  permissions: {
    roles: [
      { role: "platform_admin", scope: "platform" },
      {
        role: "product_admin",
        scope: "product:djdl",
        areas: ["license", "signin"],
      },
      { role: "product_admin", scope: "product:diceroll", areas: null },
    ],
  },
};
const LONG = {
  name: "Maximiliana Alexandrovna Rostropovich-Wellington",
  email: "maximiliana.rostropovich-wellington@subsidiary.example.co.uk",
  role: "superadmin",
};
const PEOPLE = [
  { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
  LONG,
];

function noAccess(scope: string, area: string, people = PEOPLE) {
  return server((url) => {
    if (url.endsWith("/manage/api/me")) return json(200, ME);
    if (url.includes("/access/admins"))
      return json(200, { scope, area, admins: people });
    return json(403, { reason: "no_access", scope, area, code: "forbidden" });
  });
}

describe("M1/M2: the access refusal", () => {
  it("names the product as the console does, narrowed areas after the role, the role muted", async () => {
    const s = noAccess("product:diceroll", "ship");
    const r = await run(BUNDLE, { ...IN, fetchImpl: s.f, columns: 100 });
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "▲  You don't have access to Diceroll → Ship builds.",
    );
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "Your roles: Platform admin, DJDL admin · Licensing, Sign-in, Diceroll admin. Ask one of these people:",
    );
    expect(r.err).toContain("Kenji Mori");
    expect(r.err).toContain("Diceroll admin");
  });

  it("Platform says so without an area", async () => {
    const s = noAccess("platform", "platform");
    const r = await run(MIGRATE, { ...IN, fetchImpl: s.f, columns: 80 });
    expect(r.err).toContain("▲  You don't have access to Platform.");
    expect(r.err).not.toContain("→");
  });

  for (const columns of [80, 40, 32])
    it(`long names and addresses lose nothing at ${columns} columns`, async () => {
      const s = noAccess("product:diceroll", "ship");
      const r = await run(BUNDLE, { ...IN, fetchImpl: s.f, columns });
      expect(widest(r.err)).toBeLessThanOrEqual(columns);
      const squashed = r.err.replace(/\s+/g, "");
      expect(squashed).toContain(LONG.name.replace(/\s+/g, ""));
      expect(squashed).toContain(LONG.email);
      expect(squashed).toContain("Superadmin");
      // Below 40 each person stacks at a 5-column indent; the sentence unit stays whole.
      if (columns < 40) {
        const stack = lines(r.err).filter((l) => l.startsWith("     "));
        expect(stack.length).toBeGreaterThanOrEqual(6);
        expect(lines(r.err).some((l) => l === "     Kenji Mori")).toBe(true);
        expect(lines(r.err).some((l) => l === "     kenji@example.com")).toBe(
          true,
        );
        expect(
          lines(r.err).some(
            (l) => l === "     product_admin" || l === "     Diceroll admin",
          ),
        ).toBe(true);
      }
    });

  it("the ASCII fallback draws the arrow and the separator from the symbol set", async () => {
    const s = noAccess("product:djdl", "license");
    const r = await run(BUNDLE, {
      ...IN,
      fetchImpl: s.f,
      columns: 100,
      env: { TERM: "dumb" },
    });
    expect(r.err).toContain("DJDL -> Licensing");
    expect(r.err).toContain("DJDL admin - Licensing, Sign-in");
    expect(r.err).not.toMatch(/[^\x00-\x7f]/);
  });

  it("--json carries the refusal, the product, area, roles and people, exit 4", async () => {
    const s = noAccess("product:diceroll", "ship");
    const r = await run([...BUNDLE, "--json"], { ...IN, fetchImpl: s.f });
    expect(r.code).toBe(4);
    expect(r.err).toBe("");
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({
      v: 1,
      command: "bundle",
      event: "result",
      ok: false,
      exit: 4,
      error: "no-access",
      product: "Diceroll",
      area: "Ship builds",
    });
    expect(j.roles).toContain("DJDL admin · Licensing, Sign-in");
    expect(j.people[0]).toMatchObject({
      name: "Kenji Mori",
      role: "Diceroll admin",
    });
    expect(r.out.trim().split("\n")).toHaveLength(1);
  });
});

describe("M3: --json on the admin commands", () => {
  it("every refusal is a result line at exit 4", async () => {
    const out = await run([...MIGRATE, "--json"], {
      fetchImpl: server(() => json(200, {})).f,
    });
    expect(out.code).toBe(4);
    expect(out.err).toBe("");
    expect(JSON.parse(out.out)).toMatchObject({
      command: "migrate",
      exit: 4,
      error: "not-signed-in",
    });
    const reach = await run([...BUNDLE, "--json"], {
      env: { PKEY_ADMIN_TOKEN: PERSONAL },
      fetchImpl: server(() => json(403, { code: "forbidden" })).f,
    });
    expect(JSON.parse(reach.out)).toMatchObject({
      exit: 4,
      error: "token-refused",
    });
    const ended = await run([...BUNDLE, "--json"], {
      stored: { token: STORED, expiresAt: 5 },
      fetchImpl: server(() => json(200, {})).f,
    });
    expect(JSON.parse(ended.out)).toMatchObject({
      exit: 4,
      error: "sign-in-ended",
    });
  });

  it("bundle --json: the result line on success and on failure", async () => {
    const jws = `e30.${Buffer.from(JSON.stringify({ docs: { license: {}, config: {} } })).toString("base64url")}.c2ln`;
    const ok = await run([...BUNDLE, "--json"], {
      ...IN,
      fetchImpl: server(() => json(200, { bundleId: "bnd_1", bundle: jws })).f,
    });
    expect(ok.code).toBe(0);
    expect(ok.err).toBe("");
    expect(JSON.parse(ok.out)).toMatchObject({
      v: 1,
      command: "bundle",
      ok: true,
      exit: 0,
      bundleId: "bnd_1",
      deviceId: DEVICE,
      graceDays: 7,
      documents: ["license", "config"],
    });
    const fail = await run([...BUNDLE, "--json"], {
      ...IN,
      fetchImpl: server(() => json(500, { error: { message: "boom" } })).f,
    });
    expect(fail.code).toBe(1);
    expect(JSON.parse(fail.out)).toMatchObject({
      command: "bundle",
      exit: 1,
      error: "failed",
      status: 500,
    });
  });

  it("migrate --json success is inside the envelope", async () => {
    const r = await run([...MIGRATE, "--json"], {
      ...IN,
      fetchImpl: server(() => json(200, { jobs: [] })).f,
    });
    expect(JSON.parse(r.out)).toMatchObject({
      v: 1,
      command: "migrate",
      event: "result",
      ok: true,
      exit: 0,
      verb: "list",
      jobs: [],
    });
  });
});

describe("m14: the bundle's success line", () => {
  const withDocs = (docs: object) =>
    `e30.${Buffer.from(JSON.stringify({ docs })).toString("base64url")}.c2ln`;
  it("says what the bundle carries, from the bundle itself", async () => {
    for (const [docs, says] of [
      [{ license: {}, config: {} }, "license and config, 7 days offline"],
      [{ license: {} }, "license, 7 days offline"],
      [{ config: {} }, "config, 7 days offline"],
    ] as const) {
      const r = await run(BUNDLE, {
        ...IN,
        fetchImpl: server(() =>
          json(200, { bundleId: "bnd_1", bundle: withDocs(docs) }),
        ).f,
      });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(
        new RegExp(`^✓  Wrote \\S+\\.pkeybundle \\(${says}\\)\\n`),
      );
    }
  });

  it("the reach refusal's fix is the console URL", async () => {
    const r = await run(BUNDLE, {
      env: { PKEY_ADMIN_TOKEN: PERSONAL },
      fetchImpl: server(() => json(403, { code: "forbidden" })).f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "Make an API token at https://key.example/manage/#/tokens",
    );
    expect(r.err).not.toContain("/manage -> API tokens");
  });
});

describe("M4: a network error", () => {
  it("is the shared 'Can't reach' with the fix, never a path", async () => {
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const s = server(() => {
      throw e;
    });
    for (const argv of [BUNDLE, MIGRATE]) {
      const r = await run(argv, { ...IN, fetchImpl: s.f });
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        "✗  Can't reach key.example.\n   Check your network, or --base-url.\n",
      );
    }
    const j = await run([...MIGRATE, "--json"], { ...IN, fetchImpl: s.f });
    expect(JSON.parse(j.out)).toMatchObject({
      error: "network",
      cause: "ECONNREFUSED",
      message: "Can't reach key.example. Check your network, or --base-url.",
    });
  });
});

describe("M5: an ended sign-in", () => {
  it("a stored credential past its end is refused before anything is sent", async () => {
    const s = server(() => json(200, {}));
    const r = await run(BUNDLE, {
      stored: { token: STORED, expiresAt: 5 },
      fetchImpl: s.f,
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe(
      "▲  Your sign-in to key.example has ended.\n   Run pkey login.\n",
    );
    expect(s.calls).toEqual([]);
  });

  it("a 401 is whoami's ▲ ended, for the sign-in and for PKEY_ADMIN_TOKEN", async () => {
    const s = server(() => json(401, { error: { message: "no session" } }));
    const stored = await run(MIGRATE, { ...IN, fetchImpl: s.f });
    expect(stored.code).toBe(4);
    expect(stored.err).toBe(
      "▲  Your sign-in to key.example has ended.\n   Run pkey login.\n",
    );
    const env = await run(MIGRATE, {
      env: { PKEY_ADMIN_TOKEN: API },
      fetchImpl: s.f,
    });
    expect(env.code).toBe(4);
    expect(env.err).toContain("▲  PKEY_ADMIN_TOKEN was refused.");
    expect(env.err).toContain("unset it and run pkey login");
    expect(env.err).not.toContain("unknown, revoked and expired alike");
  });
});

describe("M6: a server error", () => {
  it("reads 'couldn't <verb> (HTTP n): <server message>.' with the fix, and no path", async () => {
    const bad = await run(BUNDLE, {
      ...IN,
      fetchImpl: server(() =>
        json(400, {
          error: {
            message:
              "licenseId is required when the License service is enabled",
            fields: ["licenseId"],
          },
          fields: ["licenseId"],
        }),
      ).f,
    });
    expect(bad.code).toBe(1);
    expect(bad.err.replace(/\s+/g, " ").trim()).toBe(
      "✗ key.example couldn't mint a bundle (HTTP 400): licenseId is required when the License service is enabled. Add --license <id>.",
    );
    const down = await run(MIGRATE, {
      ...IN,
      fetchImpl: server(() => json(503, { error: { message: "busy" } })).f,
    });
    expect(down.err).toContain(
      "couldn't read the migration jobs (HTTP 503): busy.",
    );
    expect(down.err).toContain("Try again in a minute.");
    for (const r of [bad, down]) {
      expect(r.err).not.toContain("/manage/api");
      expect(r.err).not.toContain("https://");
    }
  });
});

describe("m1: the https refusal", () => {
  it("is the ▲ Usage line: wrapped, with the glyph, and no word of a token nobody set", async () => {
    const s = server(() => json(200, {}));
    const r = await run(
      [...MIGRATE.slice(0, 2), "--base-url", "http://key.example"],
      { ...IN, fetchImpl: s.f, columns: 32 },
    );
    expect(r.code).toBe(2);
    expect(r.err.startsWith("▲  pkey migrate needs an")).toBe(true);
    expect(r.err.replace(/\s+/g, " ")).toContain(
      "pkey migrate needs an https address.",
    );
    expect(widest(r.err)).toBeLessThanOrEqual(32);
    expect(r.err).not.toContain("PKEY_ADMIN_TOKEN");
    const j = await run(
      [...MIGRATE.slice(0, 2), "--base-url", "http://key.example", "--json"],
      {
        ...IN,
        fetchImpl: s.f,
      },
    );
    expect(JSON.parse(j.out)).toMatchObject({ exit: 2, error: "usage" });
    expect(s.calls).toEqual([]);
  });
});

// The frames at 80, 40 and 32 columns, as plain text. PKEY_GOLDENS=<dir> writes them there
// (review the diff before copying them over test/fixtures/admin-goldens).
describe("goldens: the refusal, ended and network frames", () => {
  const dir = path.join(import.meta.dirname, "fixtures", "admin-goldens");
  const dump = process.env["PKEY_GOLDENS"];
  const down = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
  const cases: [string, () => Promise<{ err: string }>][] = [];
  for (const columns of [80, 40, 32]) {
    cases.push(
      [
        `refusal-${columns}`,
        () =>
          run(BUNDLE, {
            ...IN,
            fetchImpl: noAccess("product:diceroll", "ship").f,
            columns,
          }),
      ],
      [
        `ended-${columns}`,
        () =>
          run(BUNDLE, {
            stored: { token: STORED, expiresAt: 5 },
            fetchImpl: server(() => json(200, {})).f,
            columns,
          }),
      ],
      [
        `network-${columns}`,
        () =>
          run(BUNDLE, {
            ...IN,
            fetchImpl: server(() => {
              throw down;
            }).f,
            columns,
          }),
      ],
    );
  }
  it.each(cases)("%s", async (name, go) => {
    const { err } = await go();
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(path.join(dump, `${name}.txt`), err);
    }
    const columns = Number(name.split("-")[1]);
    expect(widest(err)).toBeLessThanOrEqual(columns);
    expect(err).toBe(readFileSync(path.join(dir, `${name}.txt`), "utf8"));
  });
});
