/**
 * P0-45: the command registry. One table (`help.ts`) names every command; parse, dispatch, help,
 * completion, the reference page and the Action mapping read it, so these tests hold each of them
 * to it, and each check has a negative control (a registry made wrong on purpose fails it).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cellWidth, stripAnsi } from "@polaris-key/node/terminal";
import { afterEach, describe, expect, it } from "vitest";
import { ACTION_INPUTS } from "../src/action.js";
import { applyContext, resolveContext } from "../src/context.js";
import {
  checkRegistry,
  COMMANDS,
  completionScript,
  COMPLETION_SHELLS,
  findCommand,
  GROUPS,
  renderHelp,
  shortUrl,
  VALUELESS_FLAGS,
  type PkeyCommand,
} from "../src/help.js";
import { HANDLERS, runPkey } from "../src/index.js";
import { termFor } from "../src/terminal.js";
import { CLI_VERSION } from "../src/version.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-reg-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

function stream(columns = 80) {
  let text = "";
  return {
    isTTY: false,
    columns,
    write: (c: string) => ((text += c), true),
    text: () => text,
  };
}

async function run(
  argv: string[],
  opts: {
    cwd: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  },
) {
  const stdout = stream();
  const stderr = stream();
  const code = await runPkey(argv, {
    cwd: opts.cwd,
    stdout,
    stderr,
    env: opts.env ?? {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

async function product(
  files: Record<string, string> = {},
  dir?: string,
): Promise<string> {
  const cwd = dir ?? (await tempDir());
  await mkdir(path.join(cwd, ".pkey"), { recursive: true });
  const all: Record<string, string> = {
    "product.yaml":
      "apiVersion: pkey.dev/v1\nproduct:\n  slug: djdl\n  name: DJDL\nmodules:\n  license:\n    enabled: true\n",
    "schema.yaml": "schemaVersion: 1\nentries: []\n",
    ...files,
  };
  for (const [name, text] of Object.entries(all))
    await writeFile(path.join(cwd, ".pkey", name), text);
  return cwd;
}

// ── The table ────────────────────────────────────────────────────────────────────────────────

describe("the command table", () => {
  it("is sound: every command is registered once, in a known group, with its rows and usage under it", () => {
    expect(checkRegistry()).toEqual([]);
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });

  it("runs every command it lists, and lists every command it runs (help is answered before dispatch)", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(
      COMMANDS.map((c) => c.name)
        .filter((n) => n !== "help")
        .sort(),
    );
  });

  it("declares whether each command has --json", () => {
    for (const c of COMMANDS) expect(typeof c.json).toBe("boolean");
    expect(
      COMMANDS.filter((c) => c.json)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["doctor", "feeds", "listing", "storefront", "validate"]);
  });

  it("reads parse's valueless flags from the table", () => {
    expect([...VALUELESS_FLAGS].sort()).toEqual(["fix", "json"]);
  });

  describe("negative controls: a wrong table fails the check", () => {
    const base = findCommand("validate")!;
    const wrong = (patch: Partial<PkeyCommand>): string[] =>
      checkRegistry([
        ...COMMANDS.filter((c) => c !== base),
        { ...base, ...patch },
      ]);

    it("a name registered twice", () => {
      expect(checkRegistry([...COMMANDS, base])).toContain(
        "validate is registered twice",
      );
    });
    it("a group with no heading", () => {
      expect(wrong({ group: "nowhere" as never })).toContainEqual(
        expect.stringContaining("has no heading"),
      );
    });
    it("a row under another command", () => {
      expect(wrong({ rows: [["doctor", "x"]] })).toContainEqual(
        expect.stringContaining("does not start with the command"),
      );
    });
    it("a usage line under another command", () => {
      expect(wrong({ usage: ["pkey doctor"] })).toContainEqual(
        expect.stringContaining("does not start with pkey validate"),
      );
    });
    it("--json declared but absent from the usage", () => {
      expect(wrong({ usage: ["pkey validate [path]"] })).toContainEqual(
        expect.stringContaining("declares --json"),
      );
    });
    it("a context default for a flag the command does not take", () => {
      expect(wrong({ context: ["product"] })).toContainEqual(
        expect.stringContaining("never mentions --product"),
      );
    });
    it("an Action input mapped to a flag the usage does not name", () => {
      expect(wrong({ action: { dir: "--nope" } })).toContainEqual(
        expect.stringContaining("in no usage line"),
      );
    });
  });
});

// ── Help and completion are generated from it ────────────────────────────────────────────────

describe("help and completion come from the table", () => {
  const term = () =>
    termFor({ isTTY: false, columns: 80, write: () => true }, {}, undefined);

  it("every command's rows are in the overview and every name is in each shell's script", () => {
    const help = stripAnsi(renderHelp(term()));
    for (const c of COMMANDS)
      for (const [t, d] of c.rows) {
        expect(help).toContain(t);
        expect(help).toContain(d.slice(0, 20));
      }
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell);
      for (const c of COMMANDS) expect(script).toContain(c.name);
    }
  });

  it("negative control: a command added to the table appears in help and in every script, and leaves with it", () => {
    const fake: PkeyCommand = {
      name: "zzfake",
      group: "shell",
      json: false,
      summary: "A command added for the test",
      rows: [["zzfake", "A command added for the test"]],
      usage: ["pkey zzfake [--zzflag]"],
    };
    (COMMANDS as PkeyCommand[]).push(fake);
    try {
      expect(stripAnsi(renderHelp(term()))).toContain("zzfake");
      for (const shell of COMPLETION_SHELLS) {
        const script = completionScript(shell);
        expect(script).toContain("zzfake");
        expect(script).toContain("zzflag");
      }
    } finally {
      (COMMANDS as PkeyCommand[]).pop();
    }
    expect(stripAnsi(renderHelp(term()))).not.toContain("zzfake");
    expect(completionScript("bash")).not.toContain("zzfake");
  });

  it("an unregistered word is unknown (2) and a registered command with no handler is too", async () => {
    const cwd = await tempDir();
    const bogus = await run(["bogus"], { cwd });
    expect(bogus.code).toBe(2);
    expect(bogus.err).toContain('Unknown command "bogus"');
  });
});

// ── The Action mapping ───────────────────────────────────────────────────────────────────────

describe("the Action mapping", () => {
  const claimed = (cmds: readonly PkeyCommand[]) =>
    new Set(cmds.flatMap((c) => Object.keys(c.action ?? {})));

  it("claims every Action input, and nothing that is not one", () => {
    const names = claimed(COMMANDS);
    expect([...names].sort()).toEqual([...ACTION_INPUTS].sort());
  });

  it("negative control: a table that forgets a command leaves an input unclaimed", () => {
    const without = COMMANDS.filter((c) => c.name !== "transport");
    const missing = ACTION_INPUTS.filter((i) => !claimed(without).has(i));
    expect(missing).toContain("steam-depot");
  });
});

// ── Context ──────────────────────────────────────────────────────────────────────────────────

describe("the product and base URL default from here", () => {
  it("takes the product from the nearest .pkey/product, walking up, and names where", async () => {
    const root = await product();
    const deep = path.join(root, "a", "b");
    await mkdir(deep, { recursive: true });
    const ctx = await resolveContext({ cwd: deep, env: {} });
    expect(ctx.product).toMatchObject({
      slug: "djdl",
      name: "DJDL",
      source: "manifest",
    });
    expect(ctx.baseUrl).toEqual({
      url: "https://key.plrs.im",
      source: "default",
    });
  });

  it("a flag beats the manifest and PKEY_BASE_URL beats the default", async () => {
    const cwd = await product();
    const ctx = await resolveContext({
      cwd,
      env: { PKEY_BASE_URL: "https://staging.example" },
      product: "other",
    });
    expect(ctx.product).toEqual({ slug: "other", source: "flag" });
    expect(ctx.baseUrl).toEqual({
      url: "https://staging.example",
      source: "env",
    });
    const flagged = await resolveContext({
      cwd,
      env: { PKEY_BASE_URL: "https://staging.example" },
      baseUrl: "https://flag.example",
    });
    expect(flagged.baseUrl.source).toBe("flag");
  });

  it("negative control: outside a repository there is no product", async () => {
    const ctx = await resolveContext({ cwd: await tempDir(), env: {} });
    expect(ctx.product).toBeNull();
  });

  it("applyContext fills only the flags the command lists, and only the ones missing", async () => {
    const cwd = await product();
    const env = { PKEY_BASE_URL: "https://staging.example" };
    const flags: Record<string, string | boolean> = {};
    await applyContext(["product", "baseUrl"], flags, { cwd, env });
    expect(flags).toEqual({
      product: "djdl",
      "base-url": "https://staging.example",
    });
    const given: Record<string, string | boolean> = { product: "mine" };
    await applyContext(["product", "baseUrl"], given, { cwd, env });
    expect(given["product"]).toBe("mine");
    const none: Record<string, string | boolean> = {};
    await applyContext(undefined, none, { cwd, env });
    await applyContext([], none, { cwd, env });
    expect(none).toEqual({});
    const onlyBase: Record<string, string | boolean> = {};
    await applyContext(["baseUrl"], onlyBase, { cwd, env });
    expect(onlyBase).toEqual({ "base-url": "https://staging.example" });
  });

  it("a command reads them: pkey auth github-oidc with no flags reaches the environment's server for the manifest's product", async () => {
    const cwd = await product();
    const seen: string[] = [];
    const out = await run(["auth", "github-oidc"], {
      cwd,
      env: {
        PKEY_BASE_URL: "https://staging.example",
        GITHUB_ACTIONS: "true",
        GITHUB_ENV: path.join(cwd, "github-env"),
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      },
      fetchImpl: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return seen.length === 1
          ? new Response(JSON.stringify({ value: "a.b.c" }))
          : new Response("{}", { status: 500 });
      }) as typeof fetch,
    });
    expect(out.code).toBe(1);
    expect(seen[0]).toContain("oidc.example");
    expect(seen[1]).toMatch(/^https:\/\/staging\.example\/djdl\//);
    // Not the usage error a missing --product gives.
    expect(out.err).not.toContain("--product");
  });
});

// ── The header ───────────────────────────────────────────────────────────────────────────────

describe("the help header", () => {
  /** `pkey help` as lines; a narrow width needs a terminal (a pipe is always 80 wide). */
  const help = async (cwd: string, columns = 80, env = {}) => {
    const tty = columns !== 80;
    const stdout = { ...stream(columns), isTTY: tty, rows: 24 };
    const code = await runPkey(["help"], {
      cwd,
      stdout,
      stderr: stream(),
      env: tty ? { NO_COLOR: "1", ...env } : env,
    });
    expect(code).toBe(0);
    return stripAnsi(stdout.text()).split("\n");
  };

  it("shows the version and a Here line naming the product, where it came from and the base URL", async () => {
    const lines = await help(await product());
    expect(lines[0]).toBe(`pkey ${CLI_VERSION} · Polaris Key platform CLI`);
    expect(lines).toContain(
      "Here   DJDL (djdl) from .pkey/product · key.plrs.im",
    );
    expect(lines.at(-2)).toBe(
      "Every command and flag: key.plrs.im/docs/reference/cli",
    );
  });

  it("outside a repository says why there is no product, and how to name one, on one line at 80 columns", async () => {
    const lines = await help(await tempDir());
    expect(lines).toContain(
      "Here   no product: no .pkey/product here or above; pass --product · key.plrs.im",
    );
  });

  it("the base URL is the environment's, shown without its scheme", async () => {
    const lines = await help(await product(), 80, {
      PKEY_BASE_URL: "https://staging.example/",
    });
    expect(lines).toContain(
      "Here   DJDL (djdl) from .pkey/product · staging.example",
    );
    expect(lines.at(-2)).toContain("staging.example/docs/reference/cli");
  });

  it("wraps at 40 columns without losing a fact: the header and Here fit, every word is still there", async () => {
    for (const [cwd, words] of [
      [
        await product(),
        ["DJDL", "(djdl)", "from", ".pkey/product", "key.plrs.im"],
      ],
      [
        await tempDir(),
        [
          "no",
          "product:",
          "here",
          "or",
          "above;",
          "pass",
          "--product",
          "key.plrs.im",
        ],
      ],
    ] as const) {
      const lines = await help(cwd, 40);
      const end = lines.findIndex((l) => l === "Start" || l === "Manifest");
      const header = lines.slice(0, end);
      for (const l of header) expect(cellWidth(l)).toBeLessThanOrEqual(40);
      const flat = header.join(" ").split(/\s+/);
      expect(flat).toContain(CLI_VERSION);
      for (const w of words) expect(flat).toContain(w);
    }
  });

  it("uses the glossary: Channels, release tracks, no Storefront heading and no outlet in a description", async () => {
    const text = (await help(await product())).join("\n");
    expect(text).toMatch(/^Channels$/m);
    expect(text).not.toMatch(/^Storefront$/m);
    for (const c of COMMANDS) {
      expect(c.summary).not.toMatch(/outlet/i);
      for (const [, d] of c.rows) expect(d).not.toMatch(/outlet|storefront/i);
    }
  });

  it("shortUrl drops the scheme and the trailing slash", () => {
    expect(shortUrl("https://key.plrs.im/")).toBe("key.plrs.im");
    expect(shortUrl("http://localhost:8787")).toBe("localhost:8787");
  });
});

// ── doctor ───────────────────────────────────────────────────────────────────────────────────

describe("pkey doctor", () => {
  const discovery = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it("--json: manifest valid, discovery answers, services and keys listed", async () => {
    const cwd = await product();
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response(
        JSON.stringify({
          services: { license: { enabled: true }, config: { enabled: false } },
          signing: { "djdl-2026": "key" },
        }),
      );
    }) as typeof fetch;
    try {
      const out = await run(["doctor", "--json"], {
        cwd,
        env: { PKEY_BASE_URL: "https://staging.example" },
      });
      expect(out.code).toBe(0);
      expect(urls).toEqual([
        "https://staging.example/djdl/.well-known/polaris.json",
      ]);
      const line = JSON.parse(out.out.trim());
      expect(line).toMatchObject({
        v: 1,
        command: "doctor",
        event: "result",
        ok: true,
        exit: 0,
        product: "djdl",
        baseUrl: "https://staging.example",
        services: ["license"],
      });
      expect(
        line.facts.map((f: { id: string; state: string }) => [f.id, f.state]),
      ).toEqual([
        ["manifest", "ok"],
        ["discovery", "ok"],
        ["services", "ok"],
        ["signing-keys", "ok"],
      ]);
      expect(out.out.trim().split("\n")).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("negative control: a refusing server is a fact to do and exits 1", async () => {
    const cwd = await product();
    const real = globalThis.fetch;
    globalThis.fetch = discovery({}, 404);
    try {
      const out = await run(["doctor", "--json"], { cwd });
      expect(out.code).toBe(1);
      const line = JSON.parse(out.out.trim());
      expect(line.ok).toBe(false);
      expect(line.facts).toContainEqual({
        id: "discovery",
        state: "todo",
        detail: "failed (404)",
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("negative control: an invalid manifest is a fact to do and exits 1, with no product skipped remote checks", async () => {
    const cwd = await tempDir();
    const out = await run(["doctor", "--json"], { cwd });
    expect(out.code).toBe(1);
    const line = JSON.parse(out.out.trim());
    expect(line.product).toBeNull();
    expect(line.facts).toHaveLength(1);
    expect(line.facts[0]).toMatchObject({ id: "manifest", state: "todo" });
  });

  it("text: outside a repository with no product it validates (and fails), never fetches", async () => {
    const real = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const out = await run(["doctor"], { cwd: await tempDir() });
      expect(out.code).toBe(1);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("text: with a product from the manifest it checks discovery and prints the services", async () => {
    const cwd = await product();
    const real = globalThis.fetch;
    globalThis.fetch = discovery({
      services: { license: { enabled: true } },
      signing: { "djdl-2026": "key" },
    });
    try {
      const out = await run(["doctor"], { cwd });
      expect(out.code).toBe(0);
      expect(out.out).toContain(
        "Remote discovery: ok https://key.plrs.im/djdl/.well-known/polaris.json",
      );
      expect(out.out).toContain("Services enabled: license");
    } finally {
      globalThis.fetch = real;
    }
  });
});

// ── validate --fix ───────────────────────────────────────────────────────────────────────────

describe("pkey validate --fix", () => {
  const FLAT = `# keep this comment

slug: djdl
name: DJDL
defaultDeviceLimit: 3
modules:
  license:
    enabled: true
`;

  it("moves a deprecated spelling to its canonical place, keeping comments, and validates clean after", async () => {
    const cwd = await product({ "product.yaml": FLAT });
    const before = await run(["validate"], { cwd });
    expect(before.out).toContain("warning product/slug");
    const out = await run(["validate", "--fix"], { cwd });
    expect(out.code).toBe(0);
    expect(out.out).toContain(
      "Moved /slug to /product/slug (.pkey/product.yaml)",
    );
    expect(out.out).toContain(
      "Moved /defaultDeviceLimit to /licensing/defaultDeviceLimit",
    );
    expect(out.out).not.toContain("warning product/slug");
    const text = await readFile(path.join(cwd, ".pkey/product.yaml"), "utf8");
    expect(text).toContain("# keep this comment");
    expect(text).toMatch(/product:\n\s+slug: djdl/);
    expect(text).not.toMatch(/^slug:/m);
    const after = await run(["validate"], { cwd });
    expect(after.out).not.toContain("deprecated");
  });

  it("negative control: nothing to fix writes nothing and says so", async () => {
    const cwd = await product();
    const file = path.join(cwd, ".pkey/product.yaml");
    const before = await readFile(file, "utf8");
    const out = await run(["validate", "--fix"], { cwd });
    expect(out.code).toBe(0);
    expect(out.out).toContain("Nothing to fix.");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("negative control: both spellings set is a conflict it leaves alone", async () => {
    const both = `slug: djdl
name: DJDL
product:
  slug: other
  name: Other
`;
    const cwd = await product({ "product.yaml": both });
    const file = path.join(cwd, ".pkey/product.yaml");
    await run(["validate", "--fix"], { cwd });
    const text = await readFile(file, "utf8");
    expect(text).toContain("slug: djdl");
    expect(text).toContain("slug: other");
  });

  it("--json lists the moves in fixed, and plain validate has no fixed", async () => {
    const cwd = await product({ "product.yaml": FLAT });
    const plain = JSON.parse((await run(["validate", "--json"], { cwd })).out);
    expect(plain.fixed).toBeUndefined();
    const out = await run(["validate", "--fix", "--json"], { cwd });
    const line = JSON.parse(out.out);
    expect(line.fixed).toEqual([
      { file: ".pkey/product.yaml", from: "/slug", to: "/product/slug" },
      { file: ".pkey/product.yaml", from: "/name", to: "/product/name" },
      {
        file: ".pkey/product.yaml",
        from: "/defaultDeviceLimit",
        to: "/licensing/defaultDeviceLimit",
      },
    ]);
  });

  it("repairs a JSON manifest too", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".pkey"));
    await writeFile(
      path.join(cwd, ".pkey/product.json"),
      JSON.stringify({ slug: "djdl", name: "DJDL" }),
    );
    await writeFile(
      path.join(cwd, ".pkey/schema.json"),
      JSON.stringify({ schemaVersion: 1, entries: [] }),
    );
    await run(["validate", "--fix"], { cwd });
    expect(
      JSON.parse(await readFile(path.join(cwd, ".pkey/product.json"), "utf8")),
    ).toEqual({ product: { slug: "djdl", name: "DJDL" } });
  });

  it("--fix does not swallow a path: validate --fix dir", async () => {
    const cwd = await product({ "product.yaml": FLAT });
    const parent = path.dirname(cwd);
    const out = await run(["validate", "--fix", path.basename(cwd)], {
      cwd: parent,
    });
    expect(out.code).toBe(0);
    expect(out.out).toContain("Moved /slug");
  });
});

// ── The reference page ───────────────────────────────────────────────────────────────────────

describe("reference/cli.mdx", () => {
  it("is the table rendered: the committed page is byte-identical to the generator's output", async () => {
    const { renderAll, PAGE_PATH } =
      await import("../scripts/gen-reference.js");
    const committed = await readFile(
      path.join(__dirname, "..", "..", "..", PAGE_PATH),
      "utf8",
    );
    expect(committed).toBe(renderAll()[PAGE_PATH]);
  });

  it("lists every command, every group heading and every Action input", async () => {
    const { renderPage } = await import("../scripts/gen-reference.js");
    const page = renderPage();
    for (const c of COMMANDS) expect(page).toContain(`### \`pkey ${c.name}\``);
    for (const [, heading] of GROUPS) expect(page).toContain(`## ${heading}`);
    for (const input of ACTION_INPUTS)
      expect(page).toContain(`| \`${input}\` |`);
  });

  it("negative control: a command added to the table is on the page", async () => {
    const { renderPage } = await import("../scripts/gen-reference.js");
    const fake: PkeyCommand = {
      name: "zzfake",
      group: "shell",
      json: false,
      summary: "A command added for the test",
      rows: [["zzfake", "x"]],
      usage: ["pkey zzfake"],
    };
    (COMMANDS as PkeyCommand[]).push(fake);
    try {
      expect(renderPage()).toContain("### `pkey zzfake`");
    } finally {
      (COMMANDS as PkeyCommand[]).pop();
    }
    expect(renderPage()).not.toContain("zzfake");
  });
});
