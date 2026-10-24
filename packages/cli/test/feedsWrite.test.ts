import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryStore } from "../src/credentials.js";
import { mergeEdits, type FeedWriteSeams } from "../src/feedWrite.js";
import { runPkey } from "../src/index.js";
import type { KeyInput } from "../src/login.js";

const ORIGIN = "https://key.example";
const REGISTRY = "https://pkg.example";
const TOKEN = `pkeyp_${"Q".repeat(39)}h7Q2`;
const ADMIN = `pkeya_${"A".repeat(43)}`;
const CODE = "WDJB-MJHT";
const POLL = `dl_${"a".repeat(43)}`;
const COOKIE = "c".repeat(43);
const FAR = 4_000_000_000;

const json = (
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const FEEDS = [
  {
    ecosystem: "npm",
    product: "acme",
    productName: "Acme",
    namespace: { scope: "@acme" },
  },
  { ecosystem: "pypi", product: "acme", productName: "Acme", namespace: {} },
  { ecosystem: "oci", product: "acme", productName: "Acme", namespace: {} },
  { ecosystem: "swift", product: "acme", productName: "Acme", namespace: {} },
  { ecosystem: "godot", product: "acme", productName: "Acme", namespace: {} },
  {
    ecosystem: "npm",
    product: "other",
    productName: "Other",
    namespace: { scope: "@other" },
  },
];

const approved = (extra: Record<string, unknown> = {}) =>
  json(200, {
    status: "approved",
    token: TOKEN,
    scope: "packages:read",
    expiresAt: FAR,
    label: "pkey on laptop",
    registryOrigin: REGISTRY,
    username: "__token__",
    feeds: FEEDS,
    ...extra,
  });

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function server(poll: () => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      auth: headers.get("authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const u = new URL(String(url));
    if (u.pathname === "/api/device-login/start")
      return json(
        201,
        { id: POLL, code: CODE, expiresIn: 300, interval: 3 },
        {
          "set-cookie": `__Host-pkey_device_login=${COOKIE}; Path=/; Secure; HttpOnly; SameSite=Strict`,
        },
      );
    if (u.pathname.startsWith("/api/device-login/")) return poll();
    return json(404);
  }) as typeof fetch;
  return { f, calls };
}

const tty: KeyInput = {
  isTTY: true,
  setRawMode: () => undefined,
  on: () => undefined,
  removeListener: () => undefined,
  resume: () => undefined,
  pause: () => undefined,
};

interface Ran {
  argv: string[];
  stdin?: string;
  tokenFile?: { path: string; mode: number; content: string };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `pkey-fw-${name}-`));
  dirs.push(d);
  return d;
};

function setup(over: { tools?: string[]; swiftFlag?: boolean } = {}) {
  const home = temp("home");
  const cwd = temp("cwd");
  const ran: Ran[] = [];
  const tools = new Set(over.tools ?? ["npm", "docker", "swift", "pip", "go"]);
  const seams: FeedWriteSeams = {
    onPath: (n) => tools.has(n),
    run: async (argv, o) => {
      const r: Ran = { argv: [...argv], stdin: o.stdin };
      const i = argv.indexOf("--token-file");
      if (argv.includes("--help"))
        return {
          code: 0,
          out: over.swiftFlag === false ? "usage" : "--token-file",
        };
      if (i >= 0) {
        const p = argv[i + 1]!;
        r.tokenFile = {
          path: p,
          mode: statSync(p).mode & 0o777,
          content: readFileSync(p, "utf8"),
        };
      }
      ran.push(r);
      return { code: 0, out: "" };
    },
  };
  return { home, cwd, ran, seams };
}

async function run(
  argv: string[],
  o: {
    f: typeof fetch;
    home?: string | undefined;
    cwd: string;
    env?: Record<string, string>;
    seams?: FeedWriteSeams;
    tty?: boolean;
    store?: () => never;
  },
) {
  let out = "";
  let err = "";
  const code = await runPkey(
    ["feeds", "setup", "--write", "--base-url", ORIGIN, ...argv],
    {
      cwd: o.cwd,
      env: {
        NO_COLOR: "1",
        PKEY_REDUCED_MOTION: "1",
        PATH: "/usr/bin",
        ...(o.home ? { HOME: o.home } : {}),
        ...o.env,
      },
      stdout: {
        write: (c: string) => ((out += c), true),
        columns: 80,
        isTTY: o.tty !== false,
      },
      stderr: {
        write: (c: string) => ((err += c), true),
        columns: 80,
        isTTY: o.tty !== false,
      },
      fetchImpl: o.f,
      credentialStore: (o.store ?? (async () => memoryStore())) as never,
      login: {
        openUrl: async () => undefined,
        platform: "darwin",
        hostname: () => "laptop",
        sleep: async () => undefined,
        stdin: o.tty === false ? undefined : tty,
      },
      feedWrite: o.seams,
    },
  );
  return { code, out, err };
}

const read = (home: string, f: string) =>
  readFileSync(path.join(home, f), "utf8");
const mode = (home: string, f: string) =>
  statSync(path.join(home, f)).mode & 0o777;
const noToken = (...s: string[]) => {
  for (const x of s) {
    expect(x).not.toContain(TOKEN);
    expect(x).not.toContain("QQQQ");
  }
};

describe("pkey feeds setup --write", () => {
  it("merges, writes at 0600 under HOME only, and a rerun changes nothing", async () => {
    const s = setup();
    writeFileSync(
      path.join(s.home, ".npmrc"),
      "foo=bar\n@acme:registry=https://old.example/\n",
    );
    writeFileSync(
      path.join(s.home, ".netrc"),
      "machine other.example\n  login me\n  password hunter2\n",
      { mode: 0o644 },
    );
    const cwdBefore = readdirSync(s.cwd);
    const { f, calls } = server(() => approved());
    const r = await run(["--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    // The request asked for the packages scope only; no credential travelled.
    expect(calls[0]!.body).toMatchObject({
      purpose: "cli",
      scope: "packages:read",
    });
    expect(calls.every((c) => c.auth === null)).toBe(true);
    const npmrc = read(s.home, ".npmrc");
    expect(npmrc).toContain("foo=bar\n");
    expect(npmrc).toContain("@acme:registry=https://pkg.example/npm/acme/\n");
    expect(npmrc).not.toContain("old.example");
    expect(npmrc).toContain(`//pkg.example/npm/acme/:_authToken=${TOKEN}`);
    expect(npmrc).not.toContain("@other");
    const netrc = read(s.home, ".netrc");
    expect(netrc).toContain(
      "machine other.example\n  login me\n  password hunter2",
    );
    expect(netrc).toContain(
      `machine pkg.example\n  login __token__\n  password ${TOKEN}`,
    );
    expect(mode(s.home, ".npmrc")).toBe(0o600);
    expect(mode(s.home, ".netrc")).toBe(0o600);
    // The first version of a changed file is kept, once.
    expect(read(s.home, ".netrc.pkey-backup")).toContain("hunter2");
    expect(mode(s.home, ".netrc.pkey-backup")).toBe(0o600);
    // Nothing landed under the working directory.
    expect(readdirSync(s.cwd)).toEqual(cwdBefore);
    noToken(r.out, r.err);
    expect(r.out).toContain("~/.npmrc");
    expect(r.out).toContain("pkeyp_…h7Q2");

    // A rerun is a no-op on every file.
    const snap = { npmrc, netrc };
    const again = await run(["--owner", "acme"], {
      f: server(() => approved()).f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(again.code).toBe(0);
    expect(read(s.home, ".npmrc")).toBe(snap.npmrc);
    expect(read(s.home, ".netrc")).toBe(snap.netrc);
    expect(again.out).toContain("already set");
  });

  it("never spawns the token in argv: stdin for docker, a 0600 file for swift, deleted", async () => {
    const s = setup();
    const { f } = server(() => approved());
    const r = await run(["--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    for (const c of s.ran)
      for (const a of c.argv) expect(a).not.toContain(TOKEN);
    const docker = s.ran.find((c) => c.argv[0] === "docker")!;
    expect(docker.argv).toContain("--password-stdin");
    expect(docker.stdin).toBe(`${TOKEN}\n`);
    const swift = s.ran.find((c) => c.argv[0] === "swift")!;
    expect(swift.tokenFile).toMatchObject({ mode: 0o600, content: TOKEN });
    expect(existsSync(swift.tokenFile!.path)).toBe(false);
    // The godot feed is skipped, with the reason.
    expect(r.out.replace(/\s+/g, " ")).toContain(
      "acme · needs an editor URL from Polaris Locker, under Packages",
    );
    noToken(r.out, r.err);
  });

  it("skips a swift without --token-file and a tool that is not installed", async () => {
    const s = setup({ tools: ["swift", "npm"], swiftFlag: false });
    const { f } = server(() => approved());
    const r = await run(["--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    expect(s.ran.some((c) => c.argv[0] === "swift")).toBe(false);
    expect(r.out.replace(/\s+/g, " ")).toContain("no --token-file");
    expect(r.out).toContain("Not installed");
    expect(existsSync(path.join(s.home, ".netrc"))).toBe(false);
  });

  it("ignores a stored admin credential and PKEY_ADMIN_TOKEN", async () => {
    const s = setup();
    const { f, calls } = server(() => approved());
    const r = await run([], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
      env: { PKEY_ADMIN_TOKEN: ADMIN },
      store: () => {
        throw new Error("the credential store was opened");
      },
    });
    expect(r.code).toBe(0);
    expect(calls.every((c) => c.auth === null)).toBe(true);
    for (const file of readdirSync(s.home, { recursive: true }) as string[]) {
      const p = path.join(s.home, file);
      if (statSync(p).isFile())
        expect(readFileSync(p, "utf8")).not.toContain(ADMIN);
    }
    for (const c of s.ran) expect(JSON.stringify(c)).not.toContain(ADMIN);
    expect(r.out).not.toContain(ADMIN);
  });

  it.each([
    ["scope admin", { scope: "admin" }],
    ["no scope", { scope: undefined }],
  ])("writes nothing when the answer has %s", async (_n, extra) => {
    const s = setup();
    const { f } = server(() => approved(extra));
    const r = await run([], { f, home: s.home, cwd: s.cwd, seams: s.seams });
    expect(r.code).toBe(4);
    expect(readdirSync(s.home)).toEqual([]);
    expect(s.ran).toEqual([]);
    noToken(r.out, r.err);
  });

  it.each([
    ["a null registry origin", { registryOrigin: null }, 4],
    ["an http registry", { registryOrigin: "http://pkg.example" }, 1],
    ["a registry with a path", { registryOrigin: "https://pkg.example/x" }, 1],
    ["a non-pkeyp token", { token: `pkeya_${"A".repeat(43)}` }, 1],
    [
      "a bad namespace",
      {
        feeds: [
          {
            ecosystem: "npm",
            product: "acme",
            namespace: { scope: "@a b/../x" },
          },
        ],
      },
      1,
    ],
    ["a bad username", { username: "root" }, 1],
  ])("writes nothing for %s", async (_n, extra, exit) => {
    const s = setup();
    const { f } = server(() => approved(extra));
    const r = await run([], { f, home: s.home, cwd: s.cwd, seams: s.seams });
    expect(r.code).toBe(exit);
    expect(readdirSync(s.home)).toEqual([]);
    expect(s.ran).toEqual([]);
    noToken(r.out, r.err);
  });

  it("refuses CI, no terminal, and no HOME before any network call", async () => {
    const s = setup();
    for (const [o, code] of [
      [{ env: { CI: "true" } }, "ci"],
      [{ tty: false }, "no-tty"],
      [{ home: undefined }, "no-home"],
    ] as const) {
      const { f, calls } = server(() => approved());
      const r = await run(["--json"], {
        f,
        cwd: s.cwd,
        seams: s.seams,
        home: "home" in o ? o.home : s.home,
        ...o,
      });
      expect(r.code).toBe(4);
      expect(calls).toEqual([]);
      expect(r.out).toContain(`"error":"${code}"`);
    }
    // A human-readable refusal names the print form.
    const { f } = server(() => approved());
    const r = await run([], {
      f,
      cwd: s.cwd,
      home: s.home,
      seams: s.seams,
      env: { CI: "true" },
    });
    expect(r.err).toContain("pkey feeds setup --ecosystem");
  });

  it("refuses a HOME inside the working directory", async () => {
    const s = setup();
    const inner = path.join(s.cwd, "fakehome");
    mkdirSync(inner);
    const { f, calls } = server(() => approved());
    const r = await run([], { f, cwd: s.cwd, home: inner, seams: s.seams });
    expect(r.code).toBe(4);
    expect(calls).toEqual([]);
  });

  it("refuses a target that leaves HOME by a symlink, and writes the rest", async () => {
    const s = setup({ tools: ["npm", "pip"] });
    const outside = temp("outside");
    writeFileSync(path.join(outside, "netrc"), "machine x\n");
    symlinkSync(path.join(outside, "netrc"), path.join(s.home, ".netrc"));
    const { f } = server(() => approved());
    const r = await run(["--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(4);
    expect(readFileSync(path.join(outside, "netrc"), "utf8")).toBe(
      "machine x\n",
    );
    expect(read(s.home, ".npmrc")).toContain("_authToken");
    expect(r.out).toContain("refused");
  });

  it("follows a symlink that stays inside HOME and keeps the link", async () => {
    const s = setup({ tools: ["npm"] });
    mkdirSync(path.join(s.home, "dotfiles"));
    writeFileSync(path.join(s.home, "dotfiles", "npmrc"), "foo=bar\n");
    symlinkSync(
      path.join(s.home, "dotfiles", "npmrc"),
      path.join(s.home, ".npmrc"),
    );
    const { f } = server(() => approved());
    const r = await run(["--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    expect(read(s.home, "dotfiles/npmrc")).toContain("_authToken");
    expect(read(s.home, ".npmrc")).toContain("foo=bar");
  });

  it("--json is one result line with no token", async () => {
    const s = setup();
    const { f } = server(() => approved());
    const r = await run(["--json", "--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      command: "feeds setup",
      event: "started",
    });
    expect(lines.at(-1)).toMatchObject({
      command: "feeds setup",
      event: "result",
      ok: true,
    });
    noToken(r.out, r.err);
  });
});

describe("mergeEdits", () => {
  it("updates a multi-line and a one-line netrc entry in place", () => {
    const edit = {
      kind: "netrc",
      machine: "pkg.example",
      login: "__token__",
      password: "NEW",
    } as const;
    expect(
      mergeEdits(
        "machine a\n login x\n password y\nmachine pkg.example login old password OLD\nmachine z login q password r\n",
        [edit],
      ),
    ).toBe(
      "machine a\n login x\n password y\nmachine pkg.example login __token__ password NEW\nmachine z login q password r\n",
    );
    expect(mergeEdits("machine pkg.example\n  login u\n", [edit])).toBe(
      "machine pkg.example\n  login __token__\n  password NEW\n",
    );
  });

  it("merges yaml keys under existing mappings and refuses an inline one", () => {
    const y = (k: string, v: string | boolean) =>
      ({ kind: "yaml", path: ["npmScopes", "acme", k], value: v }) as const;
    const base =
      'nodeLinker: node-modules\nnpmScopes:\n  other:\n    npmRegistryServer: "https://x/"\n';
    const out = mergeEdits(base, [
      y("npmRegistryServer", "https://pkg/"),
      y("npmAlwaysAuth", true),
    ]);
    expect(out).toBe(
      'nodeLinker: node-modules\nnpmScopes:\n  other:\n    npmRegistryServer: "https://x/"\n  acme:\n    npmRegistryServer: "https://pkg/"\n    npmAlwaysAuth: true\n',
    );
    expect(
      mergeEdits(out, [
        y("npmRegistryServer", "https://pkg/"),
        y("npmAlwaysAuth", true),
      ]),
    ).toBe(out);
    expect(() => mergeEdits("npmScopes: {}\n", [y("a", "b")])).toThrow();
  });

  it("merges toml keys into a table and adds a missing table", () => {
    const t = {
      kind: "toml",
      table: "registries.acme",
      key: "index",
      value: '"sparse+https://x/"',
    } as const;
    const out = mergeEdits("[net]\nretry = 2\n", [t]);
    expect(out).toBe(
      '[net]\nretry = 2\n\n[registries.acme]\nindex = "sparse+https://x/"\n',
    );
    expect(mergeEdits(out, [t])).toBe(out);
    expect(mergeEdits('[registries.acme]\nindex = "old"\nfoo = 1\n', [t])).toBe(
      '[registries.acme]\nindex = "sparse+https://x/"\nfoo = 1\n',
    );
  });

  it("merges properties and keeps CRLF", () => {
    const p = { kind: "property", key: "acmePassword", value: "NEW" } as const;
    expect(mergeEdits("a=1\r\nacmePassword = old\r\n", [p])).toBe(
      "a=1\r\nacmePassword=NEW\r\n",
    );
  });
});

describe("pkey feeds setup --write: review fixes", () => {
  const dflt = { owner: ["--owner", "acme"] };

  it("merges into a quoted cargo table header instead of duplicating it", () => {
    const t = {
      kind: "toml",
      table: "registries.x",
      key: "index",
      value: '"s"',
    } as const;
    const out = mergeEdits('[registries."x"]\nindex = "old"\n', [t]);
    expect(out).toBe(
      '[registries.x]\nindex = "s"\n'.replace(
        "[registries.x]",
        '[registries."x"]',
      ),
    );
    expect(out.match(/registries/g)).toHaveLength(1);
    expect(mergeEdits("[ registries . 'x' ]\nfoo = 1\n", [t])).toContain(
      'index = "s"',
    );
  });

  it("puts a yarn entry after the comments of an empty rc, at the root", () => {
    const y = (k: string) =>
      ({ kind: "yaml", path: ["npmScopes", "acme", k], value: "v" }) as const;
    expect(mergeEdits("# yarn\n", [y("npmAuthToken")])).toBe(
      '# yarn\nnpmScopes:\n  acme:\n    npmAuthToken: "v"\n',
    );
    expect(mergeEdits("", [y("npmAuthToken")])).toBe(
      'npmScopes:\n  acme:\n    npmAuthToken: "v"\n',
    );
  });

  it("keeps a netrc default entry last", () => {
    const e = {
      kind: "netrc",
      machine: "pkg.example",
      login: "__token__",
      password: "T",
    } as const;
    expect(
      mergeEdits("machine a login b password c\ndefault login d password e\n", [
        e,
      ]),
    ).toBe(
      "machine a login b password c\nmachine pkg.example\n  login __token__\n  password T\n\ndefault login d password e\n",
    );
  });

  it("never loosens a secret file's mode (0400 stays 0400)", async () => {
    const s = setup({ tools: ["npm"] });
    const f = path.join(s.home, ".npmrc");
    writeFileSync(f, "foo=bar\n", { mode: 0o400 });
    const { f: fetchImpl } = server(() => approved());
    const r = await run(dflt.owner, {
      f: fetchImpl,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    expect(statSync(f).mode & 0o777).toBe(0o400);
    expect(readFileSync(f, "utf8")).toContain("_authToken");
  });

  it("reports a token-file or temp-dir failure as one failed row and goes on", async () => {
    const s = setup({ tools: ["npm", "swift", "docker"] });
    s.seams.tmpdir = () => path.join(s.home, "no", "such", "dir");
    const { f } = server(() => approved());
    const r = await run(dflt.owner, {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Set up 2 of 3 tools.");
    expect(r.out).toContain("swift package-registry failed");
    expect(s.ran.some((c) => c.argv[0] === "docker")).toBe(true);
    expect(r.out).toContain(
      "Fix swift, then run pkey feeds setup --write again.",
    );
    noToken(r.out, r.err);
  });

  it("shows a failed command's last line with the token taken out", async () => {
    const s = setup({ tools: ["docker"] });
    s.seams.run = async () => ({
      code: 1,
      out: `warn\nError: bad ${TOKEN} here\n`,
    });
    const { f } = server(() => approved());
    const r = await run(dflt.owner, {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("docker login failed");
    expect(r.out).toContain("Error: bad … here");
    noToken(r.out, r.err);
  });

  it("shows the real path and backup of a symlinked file, and warns about a git work tree", async () => {
    const s = setup({ tools: ["npm"] });
    mkdirSync(path.join(s.home, "dotfiles", ".git"), { recursive: true });
    writeFileSync(path.join(s.home, "dotfiles", "npmrc"), "foo=bar\n");
    symlinkSync(
      path.join(s.home, "dotfiles", "npmrc"),
      path.join(s.home, ".npmrc"),
    );
    const { f } = server(() => approved());
    const r = await run(dflt.owner, {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    const flat = r.out.replace(/\s+/g, " ");
    expect(flat).toMatch(
      /~\/\.npmrc → ~\/dotfiles\/npmrc updated (· )?backup ~\/dotfiles\/npmrc\.pkey-backup/,
    );
    expect(flat).toContain(
      "~/dotfiles is a git repository: the token is now in a tracked file.",
    );
    const j = await run([...dflt.owner, "--json"], {
      f: server(() => approved()).f,
      home: setup({ tools: ["npm"] }).home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(j.code).toBe(0);
    const res = JSON.parse(j.out.trim().split("\n").at(-1)!);
    expect(
      res.steps.find((x: { tool: string }) => x.tool === "npm"),
    ).toMatchObject({ file: "~/.npmrc", state: "created" });
    expect(
      res.steps.find((x: { product?: string }) => x.product === "acme"),
    ).toBeDefined();
    expect(res).not.toHaveProperty("replaces");
    expect(JSON.parse(j.out.trim().split("\n")[0]!)).not.toHaveProperty(
      "replaces",
    );
  });

  it("names the tools before sign-in and refuses with none installed, before the network", async () => {
    const s = setup({ tools: ["npm", "pip", "swift", "docker"] });
    const { f, calls } = server(() => approved());
    const r = await run(dflt.owner, {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.out).toContain("Sets up npm, pip/uv, swift and docker.");
    expect(r.out).toContain("Opening Polaris Locker in your browser");
    expect(calls.length).toBeGreaterThan(0);
    const none = setup({ tools: [] });
    const { f: f2, calls: c2 } = server(() => approved());
    const r2 = await run([], {
      f: f2,
      home: none.home,
      cwd: none.cwd,
      seams: none.seams,
    });
    expect(r2.code).toBe(4);
    expect(c2).toEqual([]);
    expect(r2.err).toContain("None of the tools pkey sets up are installed.");
  });

  it("adds the revoke line to a refusal after the token was minted", async () => {
    const s = setup();
    const { f } = server(() => approved({ scope: "admin" }));
    const r = await run([], { f, home: s.home, cwd: s.cwd, seams: s.seams });
    expect(r.code).toBe(4);
    const flat = r.err.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Check that key.example is your Polaris Key server.",
    );
    expect(flat).toContain(
      "Revoke “pkey on laptop” in Polaris Locker, under Packages.",
    );
  });

  it("keeps the print command whole in the CI refusal, also at 40 columns", async () => {
    const s = setup();
    const { f } = server(() => approved());
    const r = await run([], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
      env: { CI: "true" },
    });
    expect(r.err).toContain(
      "▲  pkey feeds setup --write needs a person at a terminal.",
    );
    expect(r.err).toContain("In CI, print the setup instead:");
    expect(r.err).toContain(
      "pkey feeds setup --ecosystem npm --owner slug --token-env NAME",
    );
  });

  it("says plainly when the account has no feeds, and counts only tools in the headline", async () => {
    const s = setup();
    const { f } = server(() => approved({ feeds: [] }));
    const r = await run(["--owner", "acme"], {
      f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("▲  This account has no private feeds for acme.");
    expect(r.out).not.toContain("✓");
    const s2 = setup({ tools: ["npm"] });
    const r2 = await run(dflt.owner, {
      f: server(() => approved()).f,
      home: s2.home,
      cwd: s2.cwd,
      seams: s2.seams,
    });
    expect(r2.out).toContain("✓  Set up 1 tool.");
    expect(r2.out).toContain("Expires");
  });

  it("words the Polaris Locker refusals for the feeds flow", async () => {
    const s = setup();
    const lim = await run([], {
      f: server(() =>
        json(409, { reason: "token_limit", message: "at most 20 tokens" }),
      ).f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(lim.code).toBe(4);
    expect(lim.err.replace(/\s+/g, " ")).toContain(
      "Revoke one in Polaris Locker, under Packages, then run pkey feeds setup --write again.",
    );
    expect(lim.err).not.toContain("/manage/");
    const no = await run([], {
      f: server(() => json(403)).f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(no.err).toContain("This Polaris Locker account can't get a token.");
    expect(no.err).toContain("Sign in to Polaris Locker to check it.");
    const denied = await run([], {
      f: server(() => json(200, { status: "denied" })).f,
      home: s.home,
      cwd: s.cwd,
      seams: s.seams,
    });
    expect(denied.err).toContain("was denied in Polaris Locker.");
  });
});
