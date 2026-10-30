// `pkey doctor` shows Signed in and ST-40's Integration (ST-34.10), as one report (ST-34-INTEG fix B).
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

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/credentials.js";
import { bareFix, gatherSession, integrationFacts } from "../src/doctor.js";
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

async function bare(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-doctor-"));
  dirs.push(dir);
  return dir;
}

async function repo(opts: { name?: boolean } = {}): Promise<string> {
  const dir = await bare();
  await mkdir(path.join(dir, ".pkey"));
  await writeFile(
    path.join(dir, ".pkey", "product.yaml"),
    `apiVersion: pkey.dev/v1\nproduct:\n  slug: djdl\n${opts.name === false ? "" : "  name: DJDL\n"}modules:\n  license:\n    enabled: true\n`,
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
  snippet: {
    slug: "djdl",
    services: [],
    pins: [],
    releaseKeys: [{ kid: "djdl-rk-2026", publicKey: "k" }],
  },
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

/** The discovery document the Worker really sends, as the conformance transcript recorded it. */
const DISCOVERY = (
  JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        "../../../conformance/transcripts/discovery-capabilities.json",
      ),
      "utf8",
    ),
  ) as {
    steps: Array<{
      exchanges: { items: Array<{ response: { body: unknown } }> };
    }>;
  }
).steps[0]!.exchanges.items[0]!.response.body as {
  trust: {
    keys: Array<Record<string, unknown>>;
    pinnedKeys: Record<string, string>;
  };
};
// The fixture manifest enables only the licence service, so the default live product does too
// and the two are in sync.
const SERVICES = (DISCOVERY as unknown as { services: Record<string, unknown> })
  .services;
for (const slug of Object.keys(SERVICES))
  SERVICES[slug] = {
    ...(SERVICES[slug] as object),
    enabled: slug === "license",
  };
const KID = "pkey-test-prod-2026";

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
    /** Leave --product off, so the product is the repository's, if any. */
    noProduct?: boolean;
    baseUrl?: string;
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
    [
      "doctor",
      "--base-url",
      opts.baseUrl ?? ORIGIN,
      ...(opts.noProduct ? [] : ["--product", "djdl"]),
      ...argv,
    ],
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
/** The frame: colour off, and the run time (which varies) taken off the summary line. */
const frame = (out: string): string =>
  plain(out)
    .trimEnd()
    .replace(/ · \d+\.\d s$/m, "")
    .replace(/\n\d+\.\d s$/, "");
const deny403 = (url: string): Response | undefined => {
  if (url.endsWith("/manage/api/me"))
    return json(200, {
      name: "Ada",
      email: "ada@example.com",
      permissions: { roles: [{ role: "console_access", scope: "platform" }] },
    });
  if (url.includes("/access/admins"))
    return json(200, {
      admins: [
        { name: "Grace", email: "grace@example.com", role: "product_admin" },
      ],
    });
  return undefined;
};

const answering =
  (view: (url: string) => Response) =>
  (url: string): Response =>
    url.endsWith("/.well-known/polaris.json")
      ? json(200, DISCOVERY)
      : url.endsWith("/manage/api/me")
        ? json(200, { name: "Ada", email: "ada@example.com" })
        : view(url);

/** A fetch that cannot reach the server at all, the way undici fails. */
const unreachable = (): never => {
  throw Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" },
  });
};

describe("pkey doctor: one report, one count", () => {
  it("renders the mockup's report at 80 columns", async () => {
    const s = server();
    const r = await run([], { fetchImpl: s.f, columns: 80 });
    expect(r.code).toBe(1); // open console steps
    expect(frame(r.out)).toMatchInlineSnapshot(`
      "DJDL (djdl) · key.example

      Manifest
        ✓ .pkey/                    valid · license
        ✓ Services                  license
        ✓ In sync                   Features match
        ✓ Signed in                 Ada Lindqvist (ada@example.com) · ends 2026-10-26
        ○ polaris-key.json          Not found here

      Keys
        ✓ Signing key               pkey-test-prod-2026 · active
        ✓ Release key               djdl-rk-2026 · pinned

      Integration on macOS
        Licensing                   ✓ Verified
        Managed config              ✓ Verified
        Ship builds                 ● Waiting
        Sign-in                     ● Waiting
        Cloud Sync                  ○ Not seen yet
        Content packs               ○ Not seen yet

      Integration on Windows
        Licensing                   ○ Not seen yet
        Managed config              ○ Not seen yet
        Ship builds                 ● Waiting
        Sign-in                     ● Waiting
        Cloud Sync                  ○ Not seen yet
        Content packs               ○ Not seen yet

      Commerce                      off

      Left to do
        ✗ A published catalog       Cloud Sync needs it
            → key.example/manage/#/p/djdl/config/catalog
        ✗ A channel                 Content packs needs it
            → key.example/manage/#/p/djdl/distribution/outlets

      2 to do · 0 warnings"
    `);
    expect(s.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/djdl/.well-known/polaris.json`,
      `${ORIGIN}/manage/api/me`,
      `${ORIGIN}/manage/api/products/djdl/integration`,
    ]);
    expect(s.calls[1]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("40 columns: every fact kept, links whole", async () => {
    const r = await run([], { fetchImpl: server().f, columns: 40 });
    const text = frame(r.out);
    expect(text).toMatchInlineSnapshot(`
      "DJDL (djdl) · key.example

      Manifest
        ✓ .pkey/            valid · license
        ✓ Services          license
        ✓ In sync           Features match
        ✓ Signed in
          Ada Lindqvist (ada@example.com)
          ends 2026-10-26
        ○ polaris-key.json  Not found here

      Keys
        ✓ Signing key
          pkey-test-prod-2026 · active
        ✓ Release key  djdl-rk-2026 · pinned

      Integration on macOS
        Licensing       ✓ Verified
        Managed config  ✓ Verified
        Ship builds     ● Waiting
        Sign-in         ● Waiting
        Cloud Sync      ○ Not seen yet
        Content packs   ○ Not seen yet

      Integration on Windows
        Licensing       ○ Not seen yet
        Managed config  ○ Not seen yet
        Ship builds     ● Waiting
        Sign-in         ● Waiting
        Cloud Sync      ○ Not seen yet
        Content packs   ○ Not seen yet

      Commerce  off

      Left to do
        ✗ A published catalog
          Cloud Sync needs it
            → key.example/manage/#/p/djdl/
              config/catalog
        ✗ A channel
          Content packs needs it
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
  });

  it("32 columns: the state goes under the feature name", async () => {
    const r = await run([], { fetchImpl: server().f, columns: 32 });
    const text = frame(r.out);
    expect(text).toMatchInlineSnapshot(`
      "DJDL (djdl) · key.example

      Manifest
        ✓ .pkey/     valid · license
        ✓ Services   license
        ✓ In sync    Features match
        ✓ Signed in
          Ada Lindqvist
          (ada@example.com)
          ends 2026-10-26
        ○ polaris-key.json
          Not found here

      Keys
        ✓ Signing key
          pkey-test-prod-2026 · active
        ✓ Release key
          djdl-rk-2026 · pinned

      Integration on macOS
        Licensing
          ✓ Verified
        Managed config
          ✓ Verified
        Ship builds
          ● Waiting
        Sign-in
          ● Waiting
        Cloud Sync
          ○ Not seen yet
        Content packs
          ○ Not seen yet

      Integration on Windows
        Licensing
          ○ Not seen yet
        Managed config
          ○ Not seen yet
        Ship builds
          ● Waiting
        Sign-in
          ● Waiting
        Cloud Sync
          ○ Not seen yet
        Content packs
          ○ Not seen yet

      Commerce
        off

      Left to do
        ✗ A published catalog
          Cloud Sync needs it
          → key.example/manage/#/p/
            djdl/config/catalog
        ✗ A channel
          Content packs needs it
          → key.example/manage/#/p/
            djdl/distribution/outlets

      2 to do · 0 warnings"
    `);
    for (const line of text.split("\n"))
      expect([...line].length).toBeLessThanOrEqual(32);
    expect(text).toMatch(/^ {2}Licensing\n {4}✓ Verified$/m);
  });

  it("24 columns: nothing overflows and no line starts with a separator", async () => {
    const r = await run([], { fetchImpl: server().f, columns: 24 });
    const text = frame(r.out);
    expect(text).toMatchInlineSnapshot(`
      "DJDL (djdl)
      key.example

      Manifest
        ✓ .pkey/
          valid · license
        ✓ Services
          license
        ✓ In sync
          Features match
        ✓ Signed in
          Ada Lindqvist
          (ada@example.com)
          ends 2026-10-26
        ○ polaris-key.json
          Not found here

      Keys
        ✓ Signing key
          pkey-test-prod-2026
          active
        ✓ Release key
          djdl-rk-2026
          pinned

      Integration on macOS
        Licensing
          ✓ Verified
        Managed config
          ✓ Verified
        Ship builds
          ● Waiting
        Sign-in
          ● Waiting
        Cloud Sync
          ○ Not seen yet
        Content packs
          ○ Not seen yet

      Integration on Windows
        Licensing
          ○ Not seen yet
        Managed config
          ○ Not seen yet
        Ship builds
          ● Waiting
        Sign-in
          ● Waiting
        Cloud Sync
          ○ Not seen yet
        Content packs
          ○ Not seen yet

      Commerce
        off

      Left to do
        ✗ A published catalog
          Cloud Sync needs it
          → key.example/
            manage/#/p/djdl/
            config/catalog
        ✗ A channel
          Content packs
          needs it
          → key.example/
            manage/#/p/djdl/
            distribution/
            outlets

      2 to do · 0 warnings"
    `);
    for (const line of text.split("\n")) {
      expect([...line].length).toBeLessThanOrEqual(24);
      expect(line.trim().startsWith("·")).toBe(false);
    }
  });

  it("B1: a manifest error with no console steps is '1 to do' in red, and exit 1", async () => {
    const cwd = await repo({ name: false });
    const view = answering(() => json(200, { ...VIEW, features: [] }));
    const s = server(view);
    const env = { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" };
    const r = await run([], { fetchImpl: s.f, columns: 80, cwd, env });
    expect(r.code).toBe(1);
    expect(frame(r.out)).toContain("1 to do · 0 warnings");
    expect(r.out).toContain("\u001b[31m1 to do");
    const j = await run(["--json"], { fetchImpl: s.f, cwd });
    const line = JSON.parse(j.out);
    expect(j.code).toBe(1);
    expect(line.ok).toBe(false);
    expect(line.summary).toEqual({ todo: 1, warnings: 0 });
    expect(line.facts[0]).toMatchObject({ id: "manifest", state: "todo" });
  });

  it("B1 at 40 columns: a long manifest pointer stacks without widening the column", async () => {
    const cwd = await repo({ name: false });
    const r = await run([], {
      fetchImpl: server(answering(() => json(200, { ...VIEW, features: [] })))
        .f,
      columns: 40,
      cwd,
    });
    expect(r.code).toBe(1);
    expect(frame(r.out)).toMatchInlineSnapshot(`
      "djdl · key.example

      Manifest
        ✗ product/product/name
          Add product.name.
            → pkey validate
        ✓ Services              license
        ✓ Signed in
          Ada (ada@example.com)
          ends 2096-10-02
        ○ polaris-key.json      Not found here

      Keys
        ✓ Signing key
          pkey-test-prod-2026 · active
        ✓ Release key  djdl-rk-2026 · pinned

      Commerce  off, needs Licensing

      1 to do · 0 warnings"
    `);
  });

  it("the summary is red exactly when the exit is 1, from the same count", async () => {
    const red = "\u001b[31m";
    const env = { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" };
    const todo = await run([], { fetchImpl: server().f, columns: 80, env });
    expect(todo.code).toBe(1);
    expect(todo.out).toContain(`${red}2 to do`);
    const clear = await run([], {
      fetchImpl: server((url) =>
        answering(() => json(200, { ...VIEW, features: [] }))(url),
      ).f,
      columns: 80,
      env,
    });
    expect(clear.code).toBe(0);
    expect(clear.out).not.toContain(`${red}0 to do`);
    expect(clear.out).toContain("\u001b[32m0 to do");
  });

  it("M8: a network failure is a row and the report goes on to Signed in and the summary", async () => {
    const f = (async (url: string) =>
      url.endsWith("/.well-known/polaris.json")
        ? unreachable()
        : server().f(url)) as typeof fetch;
    const r = await run([], { fetchImpl: f, columns: 80 });
    expect(r.code).toBe(1);
    expect(frame(r.out)).toMatchInlineSnapshot(`
      "DJDL (djdl) · key.example

      Manifest
        ✓ .pkey/                    valid · license
        ✓ Signed in                 Ada Lindqvist (ada@example.com) · ends 2026-10-26
        ○ polaris-key.json          Not found here

      Keys
        ✗ Discovery                 Can't reach key.example.
            → Check your network, or --base-url.
        ✓ Release key               djdl-rk-2026 · pinned

      Integration on macOS
        Licensing                   ✓ Verified
        Managed config              ✓ Verified
        Ship builds                 ● Waiting
        Sign-in                     ● Waiting
        Cloud Sync                  ○ Not seen yet
        Content packs               ○ Not seen yet

      Integration on Windows
        Licensing                   ○ Not seen yet
        Managed config              ○ Not seen yet
        Ship builds                 ● Waiting
        Sign-in                     ● Waiting
        Cloud Sync                  ○ Not seen yet
        Content packs               ○ Not seen yet

      Commerce                      off

      Left to do
        ✗ A published catalog       Cloud Sync needs it
            → key.example/manage/#/p/djdl/config/catalog
        ✗ A channel                 Content packs needs it
            → key.example/manage/#/p/djdl/distribution/outlets

      3 to do · 0 warnings"
    `);
    const j = JSON.parse((await run(["--json"], { fetchImpl: f })).out);
    expect(j.facts.find((x: { id: string }) => x.id === "discovery")).toEqual({
      id: "discovery",
      state: "todo",
      detail: "Can't reach key.example.",
      code: "network",
    });
    expect(j.signedIn.state).toBe("in");
    expect(j.integration.state).toBe("ok");
  });

  it("M8: a discovery 404 continues to Signed in, Integration and the summary", async () => {
    const f = server((url) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(404, {})
        : answering(() => json(200, VIEW))(url),
    ).f;
    const r = await run([], { fetchImpl: f, columns: 80 });
    expect(r.code).toBe(1);
    const text = frame(r.out);
    expect(text).toContain("✗ Discovery");
    expect(text).toContain("Answered 404 at key.example");
    expect(text).toContain("Signed in");
    expect(text).toContain("Integration on macOS");
    expect(text).toMatch(/\d+ to do · 0 warnings$/);
  });

  it("M8: outside a repository it checks sign-in, the base URL and polaris-key.json", async () => {
    const cwd = await bare();
    await writeFile(
      path.join(cwd, "polaris-key.json"),
      JSON.stringify({ baseUrl: "https://elsewhere.example", trust: {} }),
    );
    const s = server();
    const r = await run([], {
      fetchImpl: s.f,
      columns: 80,
      cwd,
      noProduct: true,
    });
    expect(r.code).toBe(1);
    expect(frame(r.out)).toMatchInlineSnapshot(`
      "Polaris Key · key.example

      Manifest
        ✗ .pkey/                    Not found here
            → pkey init
        ✓ Signed in                 Ada Lindqvist (ada@example.com) · ends 2026-10-26
        ▲ polaris-key.json          ./ · points at elsewhere.example, not key.example
            → pkey help sdk
        ○ Discovery                 Needs a product: pass --product
        ○ Integration               Needs a product: pass --product

      1 to do · 1 warning"
    `);
    expect(s.calls.map((c) => c.url)).toEqual([`${ORIGIN}/manage/api/me`]);
    const j = JSON.parse(
      (await run(["--json"], { fetchImpl: server().f, cwd, noProduct: true }))
        .out,
    );
    expect(j.product).toBeNull();
    expect(j.signedIn.state).toBe("in");
    expect(j.facts.map((x: { id: string }) => x.id)).toEqual([
      "manifest",
      "config-file",
    ]);
  });

  it("M9: the header, then Manifest, Keys, Integration, CI, Commerce and Left to do", async () => {
    const view = { ...VIEW, features: VIEW.features.map((f) => ({ ...f })) };
    const s = server((url) =>
      answering(() =>
        json(200, {
          ...view,
          features: [
            ...view.features.slice(0, 4),
            feature("sync", "blocked", {
              prerequisites: [{ id: "catalog", met: false }],
              facts: { packages: 2, firstPackageAt: 1_700_000_000 },
            }),
          ],
        }),
      )(url),
    );
    const r = await run([], { fetchImpl: s.f, columns: 80 });
    const text = frame(r.out);
    const order = [
      "DJDL (djdl) · key.example",
      "Manifest",
      "Keys",
      "Integration on macOS",
      "CI",
      "Commerce",
      "Left to do",
    ].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(
      "✓ Signing key               pkey-test-prod-2026 · active",
    );
    expect(text).toContain("✓ Release key               djdl-rk-2026 · pinned");
    expect(text).not.toContain("MCowBQ"); // key ids, never key material
    expect(text).not.toContain("{");
  });

  it("M9: bold is for headings only (DL12), and the Waiting dot is cyan", async () => {
    const env = { NO_COLOR: "", FORCE_COLOR: "1", TERM: "xterm-256color" };
    const r = await run([], { fetchImpl: server().f, columns: 80, env });
    const bold = [...r.out.matchAll(/\u001b\[1m([^\u001b]*)\u001b/g)].map(
      (m) => m[1],
    );
    expect(bold).toContain("Manifest");
    expect(bold).toContain("DJDL");
    for (const feature of [
      "Licensing",
      "Managed config",
      "Signed in",
      "Cloud Sync",
    ])
      expect(bold).not.toContain(feature);
    expect(r.out).toContain("\u001b[36m●");
  });

  it("M10: a platform collapses only when every feature has one state", async () => {
    const mixed = {
      ...VIEW,
      features: VIEW.features.map((f) =>
        f.id === "licensing"
          ? { ...f, verifiedOn: [verifiedOn("macos"), verifiedOn("windows")] }
          : f,
      ),
    };
    const r = await run([], {
      fetchImpl: server(answering(() => json(200, mixed))).f,
      columns: 80,
    });
    const text = frame(r.out);
    expect(text).toMatch(
      /Integration on Windows\n {2}Licensing +✓ Verified\n {2}Managed config +○ Not seen yet/,
    );
    const uniform = {
      ...VIEW,
      features: VIEW.features.slice(0, 2),
    };
    const same = frame(
      (
        await run([], {
          fetchImpl: server(answering(() => json(200, uniform))).f,
          columns: 80,
        })
      ).out,
    );
    expect(same).toMatch(/Integration on Windows +○ Not seen yet\n/);
  });

  it("m2: the ASCII fallback draws → and · from the symbol set", async () => {
    const r = await run(["--ascii"], {
      fetchImpl: server().f,
      stored: false,
      columns: 80,
    });
    expect(r.out).not.toMatch(/[→·✓✗▲●○]/);
    expect(r.out).toContain("-> pkey");
  });

  it("m5: signed out reads 'Not signed in', fix is a bare command", async () => {
    const s = server();
    const r = await run([], { fetchImpl: s.f, stored: false, columns: 80 });
    expect(r.code).toBe(0);
    expect(frame(r.out)).toContain(
      "  ▲ Not signed in             Integration needs it\n      → pkey login\n",
    );
    expect(s.calls.map((c) => c.url)).toEqual([
      `${ORIGIN}/djdl/.well-known/polaris.json`,
    ]);
    // A refusal's "Run pkey login once." is drawn as the bare command.
    expect(bareFix("Run pkey login once.")).toBe("pkey login");
    expect(bareFix("Run pkey login.")).toBe("pkey login");
    expect(bareFix("Copy it again whole.")).toBe("Copy it again whole.");
  });

  it("m5: an ended sign-in names the host", async () => {
    const f = server((url) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(200, DISCOVERY)
        : json(401, {}),
    ).f;
    const r = await run([], { fetchImpl: f, columns: 80 });
    expect(r.code).toBe(0);
    expect(frame(r.out)).toContain("Your sign-in to key.example has ended.");
    expect(frame(r.out)).toContain("→ pkey login");
  });

  it("m6: a 403 is in doctor's row grammar and says it concerns Integration", async () => {
    const s = server((url) => {
      if (url.endsWith("/.well-known/polaris.json"))
        return json(200, DISCOVERY);
      const d = deny403(url);
      if (d) return d;
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
    const text = frame(r.out);
    expect(text).toContain(
      "▲ Integration               You don't have access to djdl (Core).",
    );
    expect(text).toContain("Ask one of these people:");
    expect(text).toContain("Grace grace@example.com · djdl admin");
    expect(text).toContain("0 to do · 1 warning");
    expect(text).not.toContain("Left to do");
    const narrow = await run([], { fetchImpl: s.f, columns: 40 });
    for (const line of frame(narrow.out).split("\n"))
      expect([...line].length).toBeLessThanOrEqual(40);
  });

  it("m6: the 403 for a token type and a 500 each carry a fix", async () => {
    const reach = await run([], {
      fetchImpl: server((url) =>
        answering(() =>
          json(403, { error: { code: "forbidden", message: "no" } }),
        )(url),
      ).f,
      columns: 80,
    });
    expect(frame(reach.out)).toContain(
      "▲ Integration               Isn't available to personal tokens.\n      → pkey login",
    );
    const down = await run([], {
      fetchImpl: server((url) => answering(() => json(500, {}))(url)).f,
      columns: 80,
    });
    expect(frame(down.out)).toContain(
      "▲ Integration               The console answered HTTP 500.\n      → pkey doctor",
    );
  });

  it("m6: house wording, 'Can't reach' everywhere", async () => {
    const f = server((url) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(200, DISCOVERY)
        : url.endsWith("/manage/api/me")
          ? json(500, {})
          : unreachable(),
    ).f;
    const r = await run([], { fetchImpl: f, columns: 80 });
    const text = frame(r.out);
    expect(text).not.toMatch(/Could not/);
    expect(text).toContain("The console answered HTTP 500 for your identity.");
    expect(text).toContain("Can't reach key.example.");
    expect(text).toContain("Check your network, or --base-url.");
  });

  it("m12: the --json shape in doctor's help wraps within 80 and 40 columns", async () => {
    for (const columns of [80, 40]) {
      let out = "";
      await runPkey(["help", "doctor"], {
        cwd: await bare(),
        env: { CI: "true", NO_COLOR: "1", TERM: "xterm-256color" },
        stdout: {
          write: (s: string) => ((out += s), true),
          isTTY: true,
          columns,
        },
        stderr: { write: () => true },
      });
      expect(out).toContain('"command":"doctor"');
      for (const line of plain(out).split("\n"))
        expect([...line].length).toBeLessThanOrEqual(columns);
    }
  });

  it("security: a token in --base-url is never printed, in text or --json", async () => {
    const polluted = `${ORIGIN}/${TOKEN}`;
    for (const flags of [[], ["--json"]]) {
      const ok = await run(flags, {
        fetchImpl: server().f,
        columns: 80,
        baseUrl: polluted,
      });
      expect(ok.out + ok.err).not.toContain(TOKEN);
      const down = await run(flags, {
        fetchImpl: (async () => unreachable()) as typeof fetch,
        columns: 80,
        baseUrl: polluted,
      });
      expect(down.out + down.err).not.toContain(TOKEN);
      expect(down.code).toBe(1);
    }
    const j = JSON.parse(
      (await run(["--json"], { fetchImpl: server().f, baseUrl: polluted })).out,
    );
    expect(j.baseUrl).toContain("[token]");
  });

  it("an oversize discovery body is a failed discovery, not a crash", async () => {
    const huge = new Response("x".repeat(70 * 1024), { status: 200 });
    const f = server((url) =>
      url.endsWith("/.well-known/polaris.json") ? huge : json(200, VIEW),
    ).f;
    const r = await run(["--json"], { fetchImpl: f });
    const line = JSON.parse(r.out);
    expect(
      line.facts.find((x: { id: string }) => x.id === "discovery").state,
    ).toBe("todo");
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
    expect(facts.releaseKeys).toEqual(["djdl-rk-2026"]);
    const r = await run([], { fetchImpl: server().f, columns: 80 });
    expect(r.out).toContain("2 to do · 0 warnings");
    expect(plain(r.out).match(/✓ Verified/g)).toHaveLength(2);
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
      fix: "pkey doctor",
      code: "timeout",
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
    expect(out.out).toContain("\u001b[33m▲"); // the ▲ is the warning colour
  });

  it("--json carries the same facts as the text", async () => {
    const text = await run([], { fetchImpl: server().f, columns: 80 });
    const r = await run(["--json"], { fetchImpl: server().f });
    const line = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(line.ok).toBe(false);
    expect(line.summary).toEqual({ todo: 2, warnings: 0 });
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
    expect(line.keys).toEqual(["pkey-test-prod-2026"]);
    for (const f of line.integration.features)
      expect(text.out).toContain(f.label);
    for (const t of line.integration.todo) expect(text.out).toContain(t.label);
    expect(line.facts.map((f: { id: string }) => f.id)).toEqual(
      [
        "manifest",
        "discovery",
        "services",
        "signing-keys",
        "in-sync",
        "config-file",
      ].filter((id) => id !== "config-file"),
    );
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

describe("pkey doctor: in sync and the fix hint", () => {
  const live = (on: string[]) => {
    const body = structuredClone(DISCOVERY) as unknown as {
      services: Record<string, { enabled?: boolean }>;
    };
    for (const k of Object.keys(body.services))
      body.services[k]!.enabled = on.includes(k);
    return (url: string) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(200, body)
        : json(404, {});
  };
  const doctor = async (dir: string, on: string[], extra: string[] = []) => {
    const o = { cwd: dir, fetchImpl: server(live(on)).f, columns: 80 };
    return [
      await run(extra, o),
      JSON.parse((await run([...extra, "--json"], o)).out),
    ] as const;
  };

  it("in sync: a row and a fact that agree", async () => {
    const [t, j] = await doctor(await repo(), ["license"]);
    expect(plain(t.out)).toContain(
      "✓ In sync                   Features match",
    );
    expect(j.facts.find((f: { id: string }) => f.id === "in-sync")).toEqual({
      id: "in-sync",
      state: "ok",
      detail: "matches",
    });
  });

  it("out of sync: a warning with the fix, in text and --json", async () => {
    const [t, j] = await doctor(await repo(), ["license", "release"]);
    expect(plain(t.out)).toContain(
      "▲ In sync                   only live: release",
    );
    expect(plain(t.out)).toContain(
      "→ Resync the product from .pkey/ in the console.",
    );
    const f = j.facts.find((x: { id: string }) => x.id === "in-sync");
    expect(f).toMatchObject({
      state: "warn",
      detail: "only live: release",
      fix: "Resync the product from .pkey/ in the console.",
    });
    expect(t.code).toBe(0);
    const [, ok] = await doctor(await repo(), ["license"]);
    expect(j.summary.warnings).toBe(ok.summary.warnings + 1);
  });

  it("a deprecated spelling names pkey validate --fix, in text and --json", async () => {
    const dir = await repo();
    await writeFile(
      path.join(dir, ".pkey", "product.yaml"),
      "apiVersion: pkey.dev/v1\nproduct:\n  slug: djdl\n  name: DJDL\ncompatMin: 0.0.0\nmodules:\n  license:\n    enabled: true\n",
    );
    const [t, j] = await doctor(dir, ["license"]);
    expect(plain(t.out)).toContain("→ pkey validate --fix");
    expect(j.facts.find((f: { id: string }) => f.id === "manifest").fix).toBe(
      "pkey validate --fix",
    );
  });
});

describe("pkey doctor: the real discovery document (NB1)", () => {
  it("lists the trust keys by id, never the trust object's field names", async () => {
    const r = await run([], { fetchImpl: server().f, columns: 80 });
    const text = frame(r.out);
    expect(text).toContain(`✓ Signing key               ${KID} · active`);
    for (const field of [
      "jwksUrl",
      "trustManifestUrl",
      "cacheSeconds",
      "pinnedKeys",
      "signingKid",
      "signingPub",
    ])
      expect(text).not.toContain(field);
    expect(text.match(/Signing key/g)).toHaveLength(1);
    const j = JSON.parse(
      (await run(["--json"], { fetchImpl: server().f })).out,
    );
    expect(j.keys).toEqual([KID]);
    expect(j.signing).toEqual(DISCOVERY.trust.pinnedKeys);
  });

  it("compares polaris-key.json pins with trust.pinnedKeys", async () => {
    const cwd = await repo();
    await writeFile(
      path.join(cwd, "polaris-key.json"),
      JSON.stringify({
        baseUrl: ORIGIN,
        trust: { pinnedKeys: DISCOVERY.trust.pinnedKeys },
      }),
    );
    const ok = await run([], { fetchImpl: server().f, columns: 80, cwd });
    expect(frame(ok.out)).toContain(`pins match key.example`);
    await writeFile(
      path.join(cwd, "polaris-key.json"),
      JSON.stringify({ baseUrl: ORIGIN, trust: { pinnedKeys: { old: "x" } } }),
    );
    const bad = await run([], { fetchImpl: server().f, columns: 80, cwd });
    expect(frame(bad.out)).toContain("pins old are not exposed by key.example");
  });

  it("a staged key is a warning with one fix per app folder", async () => {
    const cwd = await repo();
    for (const dir of ["macos", "windows"]) {
      await mkdir(path.join(cwd, dir));
      await writeFile(
        path.join(cwd, dir, "polaris-key.json"),
        JSON.stringify({
          baseUrl: ORIGIN,
          trust: { pinnedKeys: DISCOVERY.trust.pinnedKeys },
        }),
      );
    }
    const staged = {
      ...DISCOVERY,
      trust: {
        ...DISCOVERY.trust,
        keys: [
          ...DISCOVERY.trust.keys,
          { kid: "pkey-test-prod-2026b", status: "staged", active: false },
        ],
      },
    };
    const f = server((url) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(200, staged)
        : answering(() => json(200, { ...VIEW, features: [] }))(url),
    ).f;
    const r = await run([], { fetchImpl: f, columns: 80, cwd });
    const text = frame(r.out);
    expect(text).toMatch(
      /▲ Next signing key\s+pkey-test-prod-2026b · is staged/,
    );
    expect(text).toContain("→ pkey sdk --lang <sdk> --write --out macos/");
    expect(text).toContain("→ pkey sdk --lang <sdk> --write --out windows/");
    expect(r.code).toBe(0); // a warning, not a to-do
    expect(text).toContain("0 to do · 1 warning");
  });
});

describe("pkey doctor: a failed console read says what happened (NM1)", () => {
  const meWith = (answer: () => Response | Promise<Response>) =>
    server((url) =>
      url.endsWith("/.well-known/polaris.json")
        ? json(200, DISCOVERY)
        : url.endsWith("/manage/api/me")
          ? answer()
          : json(200, { ...VIEW, features: [] }),
    ).f;

  it("a redirect is a redirect row, code redirect", async () => {
    const f = meWith(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://x.example/" },
        }),
    );
    const r = await run([], { fetchImpl: f, columns: 80 });
    const text = frame(r.out);
    expect(text).toContain("key.example answered with a redirect");
    expect(text).not.toContain("Can't reach");
    expect(text).toContain("→ Check --base-url.");
    const j = JSON.parse((await run(["--json"], { fetchImpl: f })).out);
    expect(j.signedIn).toMatchObject({ state: "unreadable", code: "redirect" });
  });

  it("an unreadable or oversize body is 'didn't answer as a Polaris Key console'", async () => {
    for (const body of ["<html>no</html>", "x".repeat(70 * 1024)]) {
      const f = meWith(() => new Response(body, { status: 200 }));
      const r = await run([], { fetchImpl: f, columns: 80 });
      expect(frame(r.out).replace(/\s+/g, " ")).toContain(
        "key.example didn't answer as a Polaris Key console.",
      );
      expect(frame(r.out)).not.toContain("Can't reach");
      const j = JSON.parse((await run(["--json"], { fetchImpl: f })).out);
      expect(j.signedIn.code).toBe("not-a-console");
    }
  });

  it("a redirect and an unreadable body on the Integration view say the same", async () => {
    for (const [answer, code] of [
      [
        () =>
          new Response("", {
            status: 301,
            headers: { location: "https://x/" },
          }),
        "redirect",
      ],
      [() => new Response("nope", { status: 200 }), "not-a-console"],
    ] as const) {
      const f = server((url) =>
        url.endsWith("/.well-known/polaris.json")
          ? json(200, DISCOVERY)
          : url.endsWith("/manage/api/me")
            ? json(200, { name: "Ada", email: "ada@example.com" })
            : answer(),
      ).f;
      const j = JSON.parse((await run(["--json"], { fetchImpl: f })).out);
      expect(j.integration).toMatchObject({ state: "unavailable", code });
    }
  });

  it("only an unreachable host says 'Can't reach', code network", async () => {
    const f = meWith(() => unreachable());
    const j = JSON.parse((await run(["--json"], { fetchImpl: f })).out);
    expect(j.signedIn).toMatchObject({ state: "unreadable", code: "network" });
    expect(j.signedIn.detail).toBe("Can't reach key.example.");
  });
});

describe("pkey doctor: an address that is not https (m1)", () => {
  it("is the ▲ usage line, exit 2, and sends nothing", async () => {
    const s = server();
    const r = await run([], { fetchImpl: s.f, baseUrl: "http://key.example" });
    expect(r.code).toBe(2);
    expect(plain(r.err)).toContain("▲  pkey doctor needs an https address.");
    expect(plain(r.err)).toContain("http works only on localhost");
    expect(r.out).toBe("");
    expect(s.calls).toEqual([]);
  });

  it("under --json prints one result line", async () => {
    const s = server();
    const r = await run(["--json"], {
      fetchImpl: s.f,
      baseUrl: "http://key.example",
    });
    expect(r.code).toBe(2);
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      v: 1,
      command: "doctor",
      event: "result",
      ok: false,
      exit: 2,
    });
  });
});
