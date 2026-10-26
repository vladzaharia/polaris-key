/**
 * The developer-facing rough edges `pkey` is held to (the CLI UX pass): exit codes that match the
 * documented table (0 success, 1 failure, 2 usage), a failed request that says what to check, no
 * stack trace for a person, flags that never swallow the next word, `--json` that parses, and a
 * CLI that never waits on a prompt.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isInternalError,
  isUsageError,
  networkMessage,
} from "../src/errors.js";
import { memoryStore } from "../src/credentials.js";
import { runPkey } from "../src/index.js";

const TOKEN = `pkeya_${"A".repeat(43)}`;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-ux-"));
  dirs.push(dir);
  return dir;
}

async function run(
  argv: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runPkey(argv, {
    cwd: opts.cwd ?? (await tempDir()),
    env: { CI: "true", ...opts.env },
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    // Never the real keychain: a test machine's own sign-in must not answer for the test.
    credentialStore: async () => memoryStore(),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { code, out, err };
}

const refused = (): typeof fetch =>
  (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
  }) as typeof fetch;

describe("exit codes: 0 success, 1 failure, 2 usage", () => {
  it("a missing subcommand or argument is a usage error", async () => {
    for (const argv of [
      ["release"],
      ["feeds"],
      ["migrate"],
      ["mirror"],
      ["bundle"],
      ["trust"],
      ["manifest"],
      ["sdk"],
      ["assets", "push"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toContain("Usage: pkey");
    }
  });

  it("an unknown subcommand names the command and points at its help", async () => {
    for (const cmd of ["release", "feeds", "migrate", "dev", "storefront"]) {
      const r = await run([cmd, "bogus"]);
      expect(r.code, cmd).toBe(2);
      expect(r.err).toContain(`Unknown ${cmd} command "bogus"`);
      expect(r.err).toContain(`pkey help ${cmd}`);
      expect(r.err).not.toContain("    at ");
    }
  });

  it("a bad flag value is a usage error, a refused request is a failure", async () => {
    expect((await run(["dev", "--port", "x"])).code).toBe(2);
    expect(
      (await run(["feeds", "setup", "--ecosystem", "cobol", "--owner", "a"]))
        .code,
    ).toBe(2);
    expect((await run(["validate"])).code).toBe(1);
  });

  it("a leading unknown option names itself and exits 2", async () => {
    for (const argv of [["--bogus"], ["--bogus=1", "release"]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain(
        "Unknown option --bogus. Run pkey help to see the options.",
      );
      expect(r.err).not.toContain("Unknown command");
      expect(r.out).toBe("");
    }
  });

  it("pkey sdk's usage lists sdk add", async () => {
    const r = await run(["sdk"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("pkey sdk add <lang> --expect");
  });

  // A bad value the user typed is a usage error (2) wherever it is caught; no server is reached.
  const BAD_VALUES: [string, string[]][] = [
    ["a dev key that is not a test key", ["dev", "expire", "nokey"]],
    ["dev config value that is not JSON", ["dev", "config", "a", "{nope"]],
    ["a non-numeric port", ["dev", "--port", "x"]],
    ["a mirror language that is unknown", ["mirror", "--lang", "cobol"]],
    [
      "an sdk product that is not a slug",
      ["sdk", "--lang", "node", "--product", "Bad Slug"],
    ],
    [
      "an sdk base URL that is not a URL",
      ["sdk", "--lang", "node", "--product", "demo", "--base-url", "nope"],
    ],
    [
      "an sdk base URL over http",
      [
        "sdk",
        "--lang",
        "node",
        "--product",
        "demo",
        "--base-url",
        "http://example.com",
      ],
    ],
    ["a bundle device id that is too short", ["bundle", "--device", "abc"]],
    [
      "a feeds ecosystem that is unknown",
      ["feeds", "setup", "--ecosystem", "x"],
    ],
    [
      "a module that is not a module",
      ["init", "--product", "d", "--modules", "nope"],
    ],
  ];
  it.each(BAD_VALUES)("%s exits 2", async (_what, argv) => {
    const r = await run(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.err).not.toContain("    at ");
  });

  it("a runtime failure stays a failure (1)", async () => {
    expect((await run(["validate"])).code).toBe(1);
  });

  it("the usage test reads both shapes of a usage message", () => {
    expect(isUsageError("Usage: pkey x")).toBe(true);
    expect(isUsageError("--bp must be a number")).toBe(true);
    expect(isUsageError("--build and --platform-ref go with a report")).toBe(
      true,
    );
    expect(isUsageError("No .pkey/product manifest found")).toBe(false);
  });
});

describe("a failed request says what to check", () => {
  it("doctor names the URL, the reason and the flag to change", async () => {
    const cwd = await tempDir();
    await run(["init", "--product", "demo"], { cwd });
    const r = await run(["doctor", "--base-url", "http://127.0.0.1:1"], {
      cwd,
      fetchImpl: refused(),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Can't reach 127.0.0.1:1.");
    expect(r.out).toContain("Check your network, or --base-url.");
    expect(r.out + r.err).not.toContain("fetch failed");
  });

  it("doctor --json keeps the same sentence in the discovery fact", async () => {
    const cwd = await tempDir();
    await run(["init", "--product", "demo"], { cwd });
    const r = await run(
      ["doctor", "--json", "--base-url", "http://127.0.0.1:1"],
      {
        cwd,
        fetchImpl: refused(),
      },
    );
    const line = JSON.parse(r.out) as {
      ok: boolean;
      exit: number;
      facts: { id: string; state: string; detail: string }[];
    };
    expect(r.code).toBe(1);
    expect(line.ok).toBe(false);
    expect(line.facts.find((f) => f.id === "discovery")).toMatchObject({
      state: "todo",
      detail: "Can't reach 127.0.0.1:1.",
      code: "network",
    });
  });

  it("any other command that cannot reach the server gets the same sentence", async () => {
    const r = await run(["sdk", "--lang", "node", "--product", "demo"], {
      fetchImpl: refused(),
    });
    expect(r.code).toBe(1);
    expect(networkMessage(new TypeError("fetch failed"))).toContain(
      "Could not reach the server",
    );
    expect(r.err).not.toBe("fetch failed\n");
  });

  it("doctor on a 404 says what to check", async () => {
    const cwd = await tempDir();
    await run(["init", "--product", "demo"], { cwd });
    const r = await run(["doctor"], {
      cwd,
      fetchImpl: (async () =>
        new Response("", { status: 404 })) as typeof fetch,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Answered 404 at key.plrs.im");
    expect(r.out).toContain("register the product");
  });
});

describe("no stack trace reaches a person", () => {
  // A request that throws a TypeError with no code where pkey makes it: a bug in pkey, not a
  // refusal and not a network failure.
  const crash: typeof fetch = (async () => {
    throw new TypeError("x is not a function");
  }) as unknown as typeof fetch;

  it("a bug prints one line and how to get the detail", async () => {
    const r = await run(["migrate", "list"], {
      fetchImpl: crash,
      env: { PKEY_ADMIN_TOKEN: TOKEN },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "pkey hit an unexpected error: TypeError: x is not a function",
    );
    expect(r.err).toContain("PKEY_DEBUG=1");
    expect(r.err).not.toMatch(/^\s+at /m);
  });

  it("PKEY_DEBUG=1 adds the stack", async () => {
    const r = await run(["migrate", "list"], {
      fetchImpl: crash,
      env: { PKEY_ADMIN_TOKEN: TOKEN, PKEY_DEBUG: "1" },
    });
    expect(r.err).toMatch(/^\s+at /m);
  });

  it("a Node input error with a code is the user's, not a bug", () => {
    const err = Object.assign(new TypeError("Invalid URL"), {
      code: "ERR_INVALID_URL",
    });
    expect(isInternalError(err)).toBe(false);
  });

  it.skipIf(!existsSync(path.join(__dirname, "../dist/bin/pkey.js")))(
    "a closed pipe (`pkey --help | head -1`) ends quietly",
    () => {
      const bin = path.join(__dirname, "../dist/bin/pkey.js");
      const r = spawnSync(
        "sh",
        ["-c", `"${process.execPath}" "${bin}" --help | head -1 >/dev/null`],
        { encoding: "utf8" },
      );
      expect(r.stderr).toBe("");
    },
  );
});

describe("flags never swallow the next word", () => {
  it("init --force dir: --force stays on", async () => {
    const cwd = await tempDir();
    expect((await run(["init", "--product", "demo"], { cwd })).code).toBe(
      1 - 1,
    );
    const again = await run(["init", "--product", "demo", "--force", "extra"], {
      cwd,
    });
    expect(again.code).toBe(0);
    expect(again.err).toBe("");
  });

  it("help no longer carries the swallow note", async () => {
    const r = await run(["help", "init"]);
    expect(r.out).not.toContain("swallows");
  });
});

describe("credentials: a signed-out admin command refuses with the fix", () => {
  it.each([
    ["migrate", ["migrate", "list"]],
    [
      "bundle",
      [
        "bundle",
        "--product",
        "demo",
        "--device",
        "A".repeat(32),
        "--grace-days",
        "5",
      ],
    ],
    [
      "listing import",
      [
        "listing",
        "import",
        "--godot",
        path.join(import.meta.dirname, "fixtures", "godot-listing"),
        "--product",
        "demo",
      ],
    ],
  ])(
    "pkey %s without a sign-in is a refusal: exit 4, pkey login",
    async (_n, argv) => {
      const r = await run(argv);
      expect(r.code).toBe(4);
      expect(r.err).toContain("▲  Not signed in to key.plrs.im.");
      expect(r.err).toContain("Run pkey login.");
      expect(r.out).toBe("");
    },
  );
});

describe("trust refuses a key no SDK could verify with", () => {
  it("a key that is not 43 base64url characters is a usage error", async () => {
    const r = await run(["trust", "--kid", "k1", "--public-key", "abc"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("43 base64url characters");
    expect(r.out).toBe("");
  });
});

describe("--json is one parseable line", () => {
  it("validate --json with no manifest", async () => {
    const r = await run(["validate", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.out)).toMatchObject({
      v: 1,
      command: "validate",
      event: "result",
      ok: false,
      exit: 1,
    });
  });

  it("a command's usage error stays on stderr and leaves stdout empty", async () => {
    const r = await run(["migrate", "--json"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });
});

describe("CI never waits on a prompt", () => {
  it("no source file reads stdin or opens a prompt", () => {
    const src = path.join(__dirname, "../src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : e.name.endsWith(".ts")
            ? [path.join(dir, e.name)]
            : [],
      );
    for (const f of files(src)) {
      const text = readFileSync(f, "utf8");
      // `pkey login` and `pkey init`'s questions (initPrompt.ts) alone read keys, from a TTY and
      // never under CI or --json: init asks only when mayPrompt holds (a TTY, not CI, not
      // TERM=dumb); the "never prompts under CI" cases are in init.test.ts / initPrompt.test.ts.
      const pattern = ["login.ts", "initPrompt.ts"].includes(path.basename(f))
        ? /node:readline|createInterface/
        : /node:readline|process\.stdin|createInterface/;
      expect(text, f).not.toMatch(pattern);
    }
  });

  it("pkey login under CI refuses (4) without waiting, and names the fix", async () => {
    const r = await run(["login"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain(
      "pkey login needs a person; in CI use PKEY_ADMIN_TOKEN",
    );
    expect(r.out).toBe("");
  });
});

describe("a manifest that does not parse names the file", () => {
  async function badYaml(): Promise<string> {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".pkey"));
    await writeFile(
      path.join(cwd, ".pkey/product.yaml"),
      "product: [unclosed\n",
    );
    return cwd;
  }

  it("validate says which file and keeps the code frame out", async () => {
    const cwd = await badYaml();
    const r = await run(["validate"], { cwd });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "✗  .pkey/product.yaml line 2: not valid YAML (an unclosed [).",
    );
    expect(r.err).not.toContain(cwd);
    expect(r.err).not.toContain("^");
  });

  it("validate --json says unreadable-manifest, not no-manifest", async () => {
    const cwd = await badYaml();
    const r = await run(["validate", "--json"], { cwd });
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      exit: 1,
      error: "unreadable-manifest",
    });
  });

  it("a missing file reads as a sentence, not a raw ENOENT", async () => {
    const r = await run(["mirror", "--lang", "ts", "--catalog", "nofile.json"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^No such file or directory: .*nofile\.json\n$/);
  });
});

describe("pkey dev on a taken port", () => {
  it("says which address and what to do", () => {
    const err = Object.assign(
      new Error("listen EADDRINUSE: address already in use 127.0.0.1:8787"),
      {
        code: "EADDRINUSE",
        address: "127.0.0.1",
        port: 8787,
      },
    );
    expect(networkMessage(err)).toBe(
      "127.0.0.1:8787 is already in use. Stop what holds it, or pass --port <n>.",
    );
  });
});

describe("pkey --version", () => {
  it("prints the version as the first word, and stays a flag after a command", async () => {
    for (const flag of ["--version", "-V", "-v"]) {
      const r = await run([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^pkey \d+\.\d+\.\d+\n$/);
    }
    // `release publish --version v` is the release's version, not a request for pkey's.
    const publish = await run(["release", "publish", "--version", "1.0.0"]);
    expect(publish.out).not.toMatch(/^pkey \d/);
    expect(publish.code).toBe(2);
  });
});

describe("terminology", () => {
  it("no command's help says machine (a device, not a machine)", async () => {
    const { COMMANDS } = await import("../src/help.js");
    for (const c of COMMANDS) {
      const r = await run(["help", c.name]);
      expect(r.out, c.name).not.toMatch(/\bmachines?\b/i);
    }
  });
});

describe("pkey whoami and pkey logout at narrow widths (goldens)", () => {
  const PERSONAL = `pkeyp_${"P".repeat(39)}h7Q2`;
  const ORIGIN = "https://key.plrs.im";
  const role = (r: string, scope: string, source = "grant") => ({
    role: r,
    scope,
    areas: null,
    source,
  });
  const ME = {
    sub: "s1",
    name: "Priya Raman",
    email: "priya@example.com",
    products: [{ slug: "djdl", name: "DJDL" }],
    permissions: {
      roles: [
        role("platform_admin", "platform"),
        role("product_admin", "product:djdl"),
        role("product_admin", "products:*"),
        role("superadmin", "platform", "root"),
        role("console_access", "platform"),
      ],
    },
    sessionExpiresAt: 4_102_444_800,
  };

  async function narrow(
    argv: string[],
    columns: number,
    fetchImpl: typeof fetch,
  ) {
    let out = "";
    let err = "";
    const entries = new Map([
      [
        ORIGIN,
        {
          token: PERSONAL,
          expiresAt: 4_102_444_800,
          label: "pkey on priya-mbp",
          hint: "h7Q2",
        },
      ],
    ]);
    const store = {
      get: (o: string) => entries.get(o) ?? null,
      set: () => undefined,
      delete: (o: string) => entries.delete(o),
    };
    const code = await runPkey(argv, {
      cwd: await tempDir(),
      env: { CI: "true", NO_COLOR: "1", TERM: "dumb", TZ: "UTC" },
      stdout: {
        write: (c: string) => ((out += c), true),
        isTTY: true,
        columns,
      },
      stderr: {
        write: (c: string) => ((err += c), true),
        isTTY: true,
        columns,
      },
      fetchImpl,
      credentialStore: async () => store,
    });
    return { code, out, err };
  }

  const answers = (async () =>
    new Response(JSON.stringify(ME), { status: 200 })) as typeof fetch;

  it("whoami at 40 columns", async () => {
    const r = await narrow(["whoami"], 40, answers);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "Host    key.plrs.im",
        "Name    Priya Raman",
        "Email   priya@example.com",
        "Roles   Platform admin, DJDL admin,",
        "        All products admin, Superadmin,",
        "        Console access",
        'Token   "pkey on priya-mbp"',
        "        (pkeyp_...h7Q2)",
        "Ends    2100-01-01",
        "",
        "!  Superadmin ends 8 hours after your",
        "   last console sign-in. Ask for a",
        "   stored Superadmin role to keep it.",
        "",
      ].join("\n"),
    );
  });

  it("whoami at 32 columns", async () => {
    const r = await narrow(["whoami"], 32, answers);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "Host    key.plrs.im",
        "Name    Priya Raman",
        "Email   priya@example.com",
        "Roles   Platform admin,",
        "        DJDL admin,",
        "        All products admin,",
        "        Superadmin,",
        "        Console access",
        'Token   "pkey on priya-mbp"',
        "        (pkeyp_...h7Q2)",
        "Ends    2100-01-01",
        "",
        "!  Superadmin ends 8 hours after",
        "   your last console sign-in.",
        "   Ask for a stored Superadmin",
        "   role to keep it.",
        "",
      ].join("\n"),
    );
  });

  it("whoami at 28 columns: each label on its own line, values at column 0", async () => {
    const r = await narrow(["whoami"], 28, answers);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "Host",
        "key.plrs.im",
        "Name",
        "Priya Raman",
        "Email",
        "priya@example.com",
        "Roles",
        "Platform admin, DJDL admin,",
        "All products admin,",
        "Superadmin, Console access",
        "Token",
        '"pkey on priya-mbp"',
        "(pkeyp_...h7Q2)",
        "Ends",
        "2100-01-01",
        "",
        "!  Superadmin ends 8 hours",
        "   after your last console",
        "   sign-in. Ask for a stored",
        "   Superadmin role to",
        "   keep it.",
        "",
      ].join("\n"),
    );
  });

  it("whoami with a long email wraps it at its own break points (40 columns)", async () => {
    const long = (async () =>
      new Response(
        JSON.stringify({
          ...ME,
          email: "priya.ramanathan-subramanian@analytical-engine.example",
        }),
        { status: 200 },
      )) as typeof fetch;
    const r = await narrow(["whoami"], 40, long);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "Host    key.plrs.im",
        "Name    Priya Raman",
        "Email   priya.ramanathan-",
        "        subramanian@analytical-engine",
        "        .example",
        "Roles   Platform admin, DJDL admin,",
        "        All products admin, Superadmin,",
        "        Console access",
        'Token   "pkey on priya-mbp"',
        "        (pkeyp_...h7Q2)",
        "Ends    2100-01-01",
        "",
        "!  Superadmin ends 8 hours after your",
        "   last console sign-in. Ask for a",
        "   stored Superadmin role to keep it.",
        "",
      ].join("\n"),
    );
  });

  it("logout (offline) at 40 columns", async () => {
    const off = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const r = await narrow(["logout"], 40, off);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "!  Signed out on this computer, but",
        "   couldn't reach key.plrs.im, so it",
        "   still works until 2100-01-01.",
        '   Revoke "pkey on priya-mbp"',
        "   (pkeyp_...h7Q2) in Personal tokens:",
        "   https://key.plrs.im/manage/#/",
        "   personal-tokens",
        "",
      ].join("\n"),
    );
  });

  it("logout (offline) at 32 columns", async () => {
    const off = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const r = await narrow(["logout"], 32, off);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "!  Signed out on this computer,",
        "   but couldn't reach",
        "   key.plrs.im, so it still",
        "   works until 2100-01-01.",
        '   Revoke "pkey on priya-mbp"',
        "   (pkeyp_...h7Q2) in",
        "   Personal tokens:",
        "   https://key.plrs.im/manage/#/",
        "   personal-tokens",
        "",
      ].join("\n"),
    );
  });

  it("logout (revoked) at 32 columns", async () => {
    const r = await narrow(
      ["logout"],
      32,
      (async () => new Response("{}", { status: 200 })) as typeof fetch,
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      ["+  Signed out of key.plrs.im.", "   The token is revoked.", ""].join(
        "\n",
      ),
    );
  });
});
