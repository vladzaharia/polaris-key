// `pkey doctor` shows Signed in and ST-40's Integration (ST-34.10).
//
// Pinned here:
//   * a fixture view in the shape of `GET /manage/api/products/<slug>/integration` renders the
//     mockup's facts (sdk.pkey-doctor): ✓ Verified, ● Waiting, ○ Not seen yet, a platform where
//     nothing is verified as one line, Commerce off, Left to do with /manage deep links;
//   * signed out: a ▲ warning with the fix, no console request, the exit code unchanged;
//   * a 403 is a ▲ warning with 34.9's access copy; a 401 says the sign-in ended;
//   * discovery, /me and the view share one deadline;
//   * 80 and 40 column frames, and a colour terminal (a wrong painter role crashes only there);
//   * `--json` carries the same facts as the text;
//   * no 'outlet', 'grant' or programme id in any output.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/credentials.js";
import { gatherSession, integrationFacts } from "../src/doctor.js";
import { runPkey } from "../src/index.js";

const ORIGIN = "https://key.example";
const TOKEN = `pkeyp_${"S".repeat(43)}`;
const API = `pkeya_${"A".repeat(43)}`;
const FAR = 4_000_000_000;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-doctor-"));
  dirs.push(dir);
  await mkdir(path.join(dir, ".pkey"));
  await writeFile(
    path.join(dir, ".pkey", "product.yaml"),
    "apiVersion: pkey.dev/v1\nproduct:\n  slug: djdl\n  name: DJDL\nmodules:\n  license:\n    enabled: true\n",
  );
  await writeFile(
    path.join(dir, ".pkey", "schema.yaml"),
    "schemaVersion: 1\nentries: []\n",
  );
  return dir;
}

const verifiedOn = (platform: string) => ({
  sdk: "swift",
  platform,
  arch: "arm64",
  sdkVersion: "1.2.0",
  lastOkAt: 1_700_000_000,
});

const feature = (
  id: string,
  status: "verified" | "not_seen" | "blocked",
  extra: Record<string, unknown> = {},
) => ({
  id,
  service: id,
  prerequisites: [],
  unavailable: false,
  facts: {},
  status,
  verifiedOn: status === "verified" ? [verifiedOn("macos")] : [],
  ...extra,
});

/** The mockup's product: Licensing and Managed config Verified on macOS, Windows seen but nothing
 * Verified there, Sign-in and Ship builds waiting, Cloud Sync and Content packs behind a console
 * step, Commerce off. */
const VIEW = {
  product: "djdl",
  now: 1_700_000_100,
  snippet: { slug: "djdl", services: [], pins: [], releaseKeys: [] },
  features: [
    feature("licensing", "verified"),
    feature("config", "verified"),
    feature("update", "not_seen"),
    feature("identity", "not_seen"),
    feature("sync", "blocked", {
      prerequisites: [{ id: "catalog", met: false }],
    }),
    feature("packs", "blocked", {
      prerequisites: [
        { id: "release", met: true },
        { id: "outlets", met: false },
      ],
    }),
  ],
  server: [],
  sightings: [
    {
      sdk: "swift",
      platform: "macos",
      arch: "arm64",
      sdkVersion: "1.2.0",
      firstSeenAt: 1,
      lastSeenAt: 2,
    },
    {
      sdk: "kotlin",
      platform: "windows",
      arch: "x64",
      sdkVersion: "1.2.0",
      firstSeenAt: 1,
      lastSeenAt: 2,
    },
  ],
  verified: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const DISCOVERY = {
  services: { license: { enabled: true } },
  signing: { "djdl-2026": "key" },
};

interface Call {
  url: string;
  auth: string | null;
  signal: AbortSignal | null;
}

function server(
  answer: (url: string) => Response | Promise<Response> = (url) => {
    if (url.endsWith("/.well-known/polaris.json")) return json(200, DISCOVERY);
    if (url.endsWith("/manage/api/me"))
      return json(200, {
        name: "Ada Lindqvist",
        email: "ada@example.com",
        sessionExpiresAt: 1_793_000_000,
        permissions: { roles: [{ role: "superadmin", scope: "platform" }] },
      });
    if (url.endsWith("/integration")) return json(200, VIEW);
    return json(404, {});
  },
) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      auth: new Headers(init.headers).get("authorization"),
      signal: init.signal ?? null,
    });
    return answer(String(url));
  }) as typeof fetch;
  return { f, calls };
}

async function run(
  argv: string[],
  opts: {
    stored?: boolean;
    env?: Record<string, string>;
    fetchImpl: typeof fetch;
    columns?: number;
    cwd?: string;
  },
) {
  let out = "";
  let err = "";
  const store = memoryStore(
    opts.stored === false
      ? undefined
      : { [ORIGIN]: { token: TOKEN, expiresAt: FAR } },
  );
  const code = await runPkey(
    ["doctor", "--base-url", ORIGIN, "--product", "djdl", ...argv],
    {
      cwd: opts.cwd ?? (await repo()),
      env: { CI: "true", NO_COLOR: "1", TERM: "xterm-256color", ...opts.env },
      stdout: {
        write: (s: string) => ((out += s), true),
        ...(opts.columns ? { isTTY: true, columns: opts.columns } : {}),
      },
      stderr: { write: (s: string) => ((err += s), true) },
      credentialStore: async () => store,
      fetchImpl: opts.fetchImpl,
    },
  );
  return { code, out, err };
}

const FORBIDDEN = /outlet|grant|programme/i;
/** The words of the output: a console link's path is a real route (Channel setup lives at
 * distribution/outlets), so links are not read for words. */
const words = (out: string): string =>
  out
    .split(/\s+/)
    .filter((w) => !w.includes("/"))
    .join(" ");
/** Colour and weight escapes off, so frames compare as text. */
const plain = (out: string): string => out.replace(/\u001b\[[0-9;]*m/g, "");
/** The part of the report this slice adds: from Signed in on. */
const body = (out: string): string =>
  plain(out)
    .slice(plain(out).indexOf("Signing keys exposed"))
    .split("\n")
    .slice(2)
    .join("\n")
    .trimEnd();

describe("pkey doctor: Signed in and Integration", () => {
  it("renders the mockup's facts from a fixture view (80 columns)", async () => {
    const s = server();
    const r = await run([], { fetchImpl: s.f, columns: 80 });
    expect(r.code).toBe(1); // open console steps
    expect(body(r.out)).toMatchInlineSnapshot(`
      "  ✓ Signed in                 Ada Lindqvist (ada@example.com) · ends 2026-10-26

      Integration on macOS
        Licensing                   ✓ Verified
        Managed config              ✓ Verified
        Ship builds                 ● Waiting
        Sign-in                     ● Waiting
        Cloud Sync                  ○ Not seen yet
        Content packs               ○ Not seen yet

      Integration on Windows        ● Waiting

      Commerce                      off

      Left to do
        ✗ A published catalog       Cloud Sync needs it
            → key.example/manage/#/p/djdl/config/catalog
        ✗ A channel                 Content packs needs it
            → key.example/manage/#/p/djdl/distribution/outlets

      2 to do · 0 warnings"
    `);
    expect(r.out).toContain("Remote discovery: ok");
    expect(s.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/djdl/.well-known/polaris.json`,
      `${ORIGIN}/manage/api/me`,
      `${ORIGIN}/manage/api/products/djdl/integration`,
    ]);
    expect(s.calls[1]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("the counts match Integration: verified, waiting, not seen, to do", async () => {
    const facts = integrationFacts(VIEW, "djdl", ORIGIN, {});
    const on = (id: string) =>
      facts.features.filter((f) => f.platforms[id] === "verified").length;
    expect(on("macos")).toBe(2);
    expect(on("windows")).toBe(0);
    expect(facts.features.filter((f) => f.state === "waiting")).toHaveLength(2);
    expect(facts.features.filter((f) => f.state === "unseen")).toHaveLength(2);
    expect(facts.todo.map((t) => t.id)).toEqual(["catalog", "channels"]);
    expect(facts.commerce).toBe("off");
    const r = await run([], { fetchImpl: server().f, columns: 80 });
    expect(r.out).toContain("2 to do · 0 warnings");
    expect(plain(r.out).match(/✓ Verified/g)).toHaveLength(2);
    expect(plain(r.out).match(/● Waiting/g)).toHaveLength(3); // Ship builds, Sign-in, Windows
  });

  it("re-wraps at 40 columns and keeps every fact and link whole", async () => {
    const narrow = await run([], { fetchImpl: server().f, columns: 40 });
    const text = body(narrow.out);
    expect(text).toMatchInlineSnapshot(`
      "  ✓ Signed in
          Ada Lindqvist (ada@example.com)
          ends 2026-10-26

      Integration on macOS
        ✓ Licensing        Verified
        ✓ Managed config   Verified
        ● Ship builds      Waiting
        ● Sign-in          Waiting
        ○ Cloud Sync       Not seen yet
        ○ Content packs    Not seen yet

      Integration on Windows
        ● Waiting

      Commerce  off

      Left to do
        ✗ A published catalog
          Cloud Sync needs it
          → key.example/manage/#/p/djdl/
            config/catalog
        ✗ A channel  Content packs needs it
          → key.example/manage/#/p/djdl/
            distribution/outlets

      2 to do · 0 warnings"
    `);
    for (const line of text.split("\n"))
      expect([...line].length).toBeLessThanOrEqual(40);
    const joined = text.replace(/\n\s+(→\s+)?/g, "");
    expect(joined).toContain("key.example/manage/#/p/djdl/config/catalog");
    expect(joined).toContain(
      "key.example/manage/#/p/djdl/distribution/outlets",
    );
    for (const w of ["Licensing", "Managed config", "Ship builds", "Sign-in"])
      expect(text).toContain(w);
  });

  it("signed out: a warning with the fix, no console request, the exit code unchanged", async () => {
    const s = server();
    const r = await run([], { fetchImpl: s.f, stored: false, columns: 80 });
    expect(r.code).toBe(0);
    expect(body(r.out)).toMatchInlineSnapshot(`
      "  ▲ Signed in                 Not signed in
            → pkey login

      0 to do · 1 warning"
    `);
    expect(s.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/djdl/.well-known/polaris.json`,
    ]);
  });

  it("a 403 is a warning with the access copy, not a to-do", async () => {
    const s = server((url) => {
      if (url.endsWith("/.well-known/polaris.json"))
        return json(200, DISCOVERY);
      if (url.endsWith("/manage/api/me"))
        return json(200, {
          name: "Ada",
          email: "ada@example.com",
          permissions: {
            roles: [{ role: "console_access", scope: "platform" }],
          },
        });
      if (url.includes("/access/admins"))
        return json(200, {
          admins: [
            {
              name: "Grace",
              email: "grace@example.com",
              role: "product_admin",
            },
          ],
        });
      if (url.endsWith("/integration"))
        return json(403, {
          error: { code: "forbidden", message: "no" },
          reason: "no_access",
          scope: "product:djdl",
          area: "core",
        });
      return json(404, {});
    });
    const r = await run([], { fetchImpl: s.f, columns: 80 });
    expect(r.code).toBe(0);
    expect(plain(r.out)).toContain("▲  You don't have access to djdl → Core.");
    expect(r.out).toContain("grace@example.com");
    expect(r.out).toContain("0 to do · 1 warning");
    expect(r.out).not.toContain("Left to do");
  });

  it("an ended sign-in is a warning that says so", async () => {
    const s = server((url) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(200, DISCOVERY)
        : json(401, {}),
    );
    const r = await run([], { fetchImpl: s.f });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Your sign-in has ended");
    expect(r.out).toContain("→ pkey login");
  });

  it("discovery, /me and the view share one deadline", async () => {
    const s = server();
    await run([], { fetchImpl: s.f });
    const signals = s.calls.map((c) => c.signal);
    expect(signals.every((x) => x !== null)).toBe(true);
    expect(new Set(signals).size).toBe(1);
  });

  it("a deadline that passes mid-run is a warning, not a hang", async () => {
    const controller = new AbortController();
    const f = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/me"))
        return json(200, { name: "Ada", email: "a@b.c" });
      controller.abort();
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return json(200, VIEW);
    }) as typeof fetch;
    const session = await gatherSession({
      io: {
        baseUrl: ORIGIN,
        env: {},
        stderr: { write: () => true },
        term: () => {
          throw new Error("unused");
        },
        store: async () =>
          memoryStore({ [ORIGIN]: { token: TOKEN, expiresAt: FAR } }),
        fetchImpl: f,
      },
      slug: "djdl",
      signal: controller.signal,
    });
    expect(session.signedIn.state).toBe("in");
    expect(session.integration).toEqual({
      state: "unavailable",
      detail: "The console did not answer in time.",
    });
  });

  it("colour terminal: every painter role exists", async () => {
    const env = { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" };
    const r = await run([], { fetchImpl: server().f, columns: 80, env });
    expect(r.err).toBe("");
    expect(r.out).toContain("\u001b[");
    expect(r.out).toContain("Left to do");
    const out = await run([], {
      fetchImpl: server().f,
      stored: false,
      columns: 80,
      env,
    });
    expect(out.out).toContain("\u001b[33m"); // the ▲ is the warning colour
  });

  it("--json carries the same facts as the text", async () => {
    const text = await run([], { fetchImpl: server().f, columns: 80 });
    const r = await run(["--json"], { fetchImpl: server().f });
    const line = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(line.ok).toBe(false);
    expect(line.signedIn).toMatchObject({
      state: "in",
      tokenType: "personal",
      name: "Ada Lindqvist",
      email: "ada@example.com",
      endsAt: new Date(1_793_000_000 * 1000).toISOString(),
    });
    expect(line.integration.state).toBe("ok");
    expect(line.integration.todo.map((t: { id: string }) => t.id)).toEqual([
      "catalog",
      "channels",
    ]);
    expect(line.integration.platforms).toEqual([
      { id: "macos", label: "macOS" },
      { id: "windows", label: "Windows" },
    ]);
    expect(line.integration.commerce).toBe("off");
    for (const f of line.integration.features)
      expect(text.out).toContain(f.label);
    for (const t of line.integration.todo) expect(text.out).toContain(t.label);
    expect(line.facts.map((f: { id: string }) => f.id)).toEqual([
      "manifest",
      "discovery",
      "services",
      "signing-keys",
    ]);
  });

  it("--json signed out: signedIn out, integration skipped, exit unchanged", async () => {
    const s = server();
    const r = await run(["--json"], { fetchImpl: s.f, stored: false });
    const line = JSON.parse(r.out);
    expect(r.code).toBe(0);
    expect(line.signedIn).toMatchObject({ state: "out", fix: "pkey login" });
    expect(line.integration).toEqual({
      state: "skipped",
      reason: "signed-out",
    });
    expect(s.calls).toHaveLength(1);
  });

  it("an API token has no person: signed in as an API token, view still read", async () => {
    const s = server();
    const r = await run([], {
      fetchImpl: s.f,
      stored: false,
      env: { PKEY_ADMIN_TOKEN: API },
      columns: 80,
    });
    expect(r.out).toContain("API token, no person");
    expect(s.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/djdl/.well-known/polaris.json`,
      `${ORIGIN}/manage/api/products/djdl/integration`,
    ]);
    expect(s.calls[1]!.auth).toBe(`Bearer ${API}`);
  });

  it("never prints the token, and no outlet, grant or programme id", async () => {
    for (const columns of [80, 40])
      for (const flags of [[], ["--json"]]) {
        const r = await run(flags, { fetchImpl: server().f, columns });
        expect(words(r.out.replace(/\\\//g, "/"))).not.toMatch(FORBIDDEN);
        expect(r.out + r.err).not.toContain(TOKEN);
      }
  });

  it("hostile view text is inert", async () => {
    const s = server((url) =>
      url.endsWith("/integration")
        ? json(200, {
            ...VIEW,
            features: [
              feature("licensing", "blocked", {
                prerequisites: [{ id: "\u001b]52;c;x\u0007evil", met: false }],
              }),
            ],
          })
        : url.endsWith("/me")
          ? json(200, { name: "\u001b[2J", email: "a@b.c" })
          : json(200, DISCOVERY),
    );
    const r = await run([], { fetchImpl: s.f, columns: 80 });
    expect(r.out).not.toContain("\u001b]52");
    expect(r.out).not.toContain("\u001b[2J");
  });
});
