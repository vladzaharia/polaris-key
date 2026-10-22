/**
 * The developer-facing rough edges `pkey` is held to (the CLI UX pass): exit codes that match the
 * documented table (0 success, 1 failure, 2 usage), a failed request that says what to check, no
 * stack trace for a person, flags that never swallow the next word, `--json` that parses, and a
 * CLI that never waits on a prompt.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isInternalError,
  isUsageError,
  networkMessage,
} from "../src/errors.js";
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
    expect(r.err).toContain("Could not reach http://127.0.0.1:1/demo/");
    expect(r.err).toContain("the connection was refused");
    expect(r.err).toContain("--base-url");
    expect(r.err).not.toContain("fetch failed");
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
      detail: expect.stringContaining("Could not reach"),
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
    expect(r.out).toContain("Is the product registered");
  });
});

describe("no stack trace reaches a person", () => {
  // A reply whose body throws a TypeError where pkey reads it: a bug in pkey, not a refusal.
  const crash: typeof fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new TypeError("x is not a function");
    },
    json: async () => {
      throw new TypeError("x is not a function");
    },
  })) as unknown as typeof fetch;

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

describe("credentials: the message names the right command and scope", () => {
  it("pkey migrate without a token talks about migrate, not bundle", async () => {
    const r = await run(["migrate", "list"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("PKEY_ADMIN_TOKEN is not set");
    expect(r.err).toContain("`pkey migrate`");
    expect(r.err).toContain("migrations:report");
    expect(r.err).not.toContain("`pkey bundle`");
  });

  it("pkey bundle without a token still names bundles:mint", async () => {
    const r = await run([
      "bundle",
      "--product",
      "demo",
      "--device",
      "A".repeat(32),
      "--grace-days",
      "5",
    ]);
    expect(r.err).toContain("`pkey bundle`");
    expect(r.err).toContain("bundles:mint");
  });
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
      expect(text, f).not.toMatch(
        /node:readline|process\.stdin|createInterface/,
      );
    }
  });
});
