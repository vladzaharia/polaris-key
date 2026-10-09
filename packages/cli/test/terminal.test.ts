/**
 * UK-14 — `pkey` on the shared terminal look: grouped help, per-command help that runs nothing,
 * `validate [path] [--json]`, shell completion, colour only on a colour terminal, and the spinner
 * that draws on stderr only when stderr is an interactive terminal.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SERVICE_SLUGS } from "@polaris-key/manifest";
import { cellWidth, stripAnsi, type Ticker } from "@polaris-key/node/terminal";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMANDS,
  COMPLETION_SHELLS,
  initManifest,
  runPkey,
  Spinner,
} from "../src/index.js";
import { GROUPS } from "../src/help.js";
import {
  CI_TOKEN,
  cleanup,
  fakeServer,
  instant,
  repo,
  SLUG,
} from "./publishFixture.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-term-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await cleanup();
});

/** A fake stream: a terminal (`isTTY`) or a pipe. */
function stream(tty = false, columns = 80) {
  let text = "";
  return {
    isTTY: tty,
    columns,
    rows: 24,
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
    text: () => text,
  };
}

/** Run pkey with plain (non-TTY) streams and an environment with no colour hints. */
async function run(
  argv: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    tty?: boolean;
    columns?: number;
  } = {},
) {
  const stdout = stream(opts.tty, opts.columns);
  const stderr = stream(opts.tty, opts.columns);
  const code = await runPkey(argv, {
    cwd: opts.cwd ?? (await tempDir()),
    stdout,
    stderr,
    env: opts.env ?? {},
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

const ESC = "\x1b";

// ── Grouped help ───────────────────────────────────────────────────────────────────────────

describe("grouped help", () => {
  it("pkey, pkey help, --help and -h print the same grouped overview", async () => {
    const outs = await Promise.all(
      [[], ["help"], ["--help"], ["-h"]].map((argv) => run(argv)),
    );
    for (const r of outs) {
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out).toBe(outs[0]!.out);
    }
    const out = outs[0]!.out;
    expect(out.split("\n")[0]).toBe("pkey · Polaris Key platform CLI");
    expect(out).toContain("Usage  pkey <command> [options]");
    for (const [, heading] of GROUPS)
      expect(out).toMatch(new RegExp(`^${heading}$`, "m"));
    expect(out).toMatch(/^Options$/m);
    // Every top-level command is listed.
    for (const c of COMMANDS)
      expect(out).toMatch(new RegExp(`^ {2}${c.name}\\b`, "m"));
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "Run pkey <command> --help for a command's options.",
    );
  });

  it("fits 80 columns, and 60 on a 60-column terminal, descriptions wrapping under their column", async () => {
    const wide = await run([]);
    for (const line of wide.out.split("\n"))
      expect(cellWidth(line)).toBeLessThanOrEqual(80);
    const narrow = await run([], {
      tty: true,
      columns: 60,
      env: { NO_COLOR: "1" },
    });
    for (const line of narrow.out.split("\n"))
      expect(cellWidth(line)).toBeLessThanOrEqual(60);
    // A term wider than the column takes a line of its own; its description sits under the column.
    const lines = wide.out.split("\n");
    const i = lines.indexOf("  distribution pause|resume|halt|complete");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toMatch(/^ {30}Pause, resume, halt or complete/);
  });

  it("fits 40 columns too: below 50 each command stacks above its description", async () => {
    const tiny = await run([], {
      tty: true,
      columns: 40,
      env: { NO_COLOR: "1" },
    });
    for (const line of tiny.out.split("\n"))
      expect(cellWidth(line), line).toBeLessThanOrEqual(40);
    const lines = tiny.out.split("\n").map(stripAnsi);
    const i = lines.indexOf("  init");
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toMatch(/^ {4}Scaffold \.pkey\/ in this directory/);
    // A term wider than the line wraps at its spaces, continued two cells further in.
    const j = lines.indexOf("  distribution");
    expect(lines[j + 1]).toBe("    pause|resume|halt|complete");
  });

  it("an unknown command prints only the error on stderr, and exits 2", async () => {
    const r = await run(["nope"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toBe(
      '✗  Unknown command "nope". Run pkey help to see every command.\n',
    );
    // Narrow, it wraps under its text; the hundred lines of help never push it out of view.
    const narrow = await run(["nope"], {
      tty: true,
      columns: 32,
      env: { NO_COLOR: "1" },
    });
    for (const line of narrow.err.split("\n"))
      expect(cellWidth(line)).toBeLessThanOrEqual(32);
    expect(narrow.err.split("\n").length).toBeLessThan(6);
  });
});

// ── Per-command help ───────────────────────────────────────────────────────────────────────

describe("per-command help", () => {
  it("pkey init --help prints the init usage and writes no files", async () => {
    for (const argv of [
      ["init", "--help"],
      ["init", "-h"],
      ["help", "init"],
      ["init", "--product", "acme", "--help"],
    ]) {
      const cwd = await tempDir();
      const r = await run(argv, { cwd });
      expect(r.code).toBe(0);
      expect(r.out).toContain(`[--modules ${SERVICE_SLUGS.join(",")}]`);
      expect(r.out).toContain("pkey init scaffolds .pkey/");
      expect(r.out).not.toContain("Created");
      expect(await readdir(cwd)).toEqual([]);
    }
  });

  it("--help anywhere before a bare -- runs nothing, network commands included", async () => {
    const server = fakeServer();
    const cwd = await tempDir();
    const stdout = stream();
    const code = await runPkey(
      ["release", "publish", "--product", SLUG, "--dir", "dist", "--help"],
      { cwd, stdout, stderr: stream(), env: {}, fetchImpl: server.fetchImpl },
    );
    expect(code).toBe(0);
    expect(server.calls).toEqual([]);
    expect(stdout.text()).toContain("pkey release publish --product slug");
    // validate --help in a directory with no .pkey/ is help, not a failed validation.
    const v = await run(["validate", "--help"], { cwd });
    expect(v.code).toBe(0);
    expect(v.out).toContain("pkey validate [path] [--json]");
  });

  it("a subcommand's help shows its usage lines and paragraphs only", async () => {
    const r = await run(["release", "publish", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(
      "pkey release publish · Publish an app or pack release from build output",
    );
    expect(r.out).toContain("pkey release publish --product slug --version v");
    expect(r.out).toContain("matches the files under --dir against");
    expect(r.out).toContain("PKEY_CI_TOKEN");
    expect(r.out).not.toContain("pkey release yank");
    expect(r.out).toMatch(/Note: .*--dry-run/s);

    const whole = await run(["help", "release"]);
    expect(whole.out).toContain("pkey release yank releaseId --reason text");
    expect(whole.out).toContain(
      "pkey release keys generate --content --out file",
    );

    const feeds = await run(["feeds", "-h"]);
    for (const sub of ["fdroid", "setup", "prune"])
      expect(feeds.out).toContain(`pkey feeds ${sub}`);

    const bundle = await run(["help", "bundle"]);
    expect(bundle.out).toContain("PKEY_ADMIN_COOKIE");
    expect(bundle.out).toContain("--no-config");
  });

  it("help for an unknown command exits 2", async () => {
    const r = await run(["help", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown command "nope".');
  });
});

// ── validate [path] [--json] ───────────────────────────────────────────────────────────────

async function productAt(dir: string): Promise<void> {
  await initManifest({
    cwd: dir,
    slug: "acme",
    name: "Acme",
    modules: ["license", "config"],
  });
}

describe("pkey validate [path]", () => {
  it("validates the .pkey/ under the path, relative to the working directory", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "game"));
    await productAt(path.join(cwd, "game"));
    const r = await run(["validate", "game"], { cwd });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Manifest: valid");
    expect(r.out).toContain("Modules: license, config");
    // The working directory itself has no .pkey/: without the path that is a failure.
    const here = await run(["validate"], { cwd });
    expect(here.code).toBe(1);
    expect(here.err).toContain("No .pkey/product manifest found");
  });

  it("points warnings and errors at the file under the path", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "game/.pkey"), { recursive: true });
    await writeFile(
      path.join(cwd, "game/.pkey/product.json"),
      JSON.stringify({ slug: "acme", name: "Acme" }),
    );
    const r = await run(["validate", "game"], { cwd });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗  Manifest: invalid");
    expect(r.out).toContain(
      "▲  warning product/slug (game/.pkey/product.json): ",
    );
    expect(r.out).toMatch(/^✗ {2}error schema\/: /m);
    expect(r.out).not.toContain(ESC);
  });

  it("--json prints one object in the kits' flattened envelope, before or after the path", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, "game"));
    await productAt(path.join(cwd, "game"));
    for (const argv of [
      ["validate", "game", "--json"],
      ["validate", "--json", "game"],
    ]) {
      const r = await run(argv, { cwd });
      expect(r.code).toBe(0);
      expect(r.out.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(r.out)).toEqual({
        v: 1,
        command: "validate",
        event: "result",
        ok: true,
        exit: 0,
        valid: true,
        modules: ["license", "config"],
        requiredSecrets: [],
        warnings: [],
        errors: [],
      });
    }
  });

  it("--json reports an invalid manifest with each message's code and place, and exits 1", async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, ".pkey"));
    await writeFile(
      path.join(cwd, ".pkey/product.json"),
      JSON.stringify({ slug: "acme", name: "Acme" }),
    );
    const r = await run(["validate", "--json"], { cwd });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      v: 1,
      command: "validate",
      event: "result",
      ok: false,
      exit: 1,
      valid: false,
      modules: expect.any(Array),
      requiredSecrets: expect.any(Array),
      warnings: expect.arrayContaining([
        {
          code: "deprecated_spelling",
          message: expect.any(String),
          at: "product/slug",
          file: ".pkey/product.json",
        },
      ]),
      errors: expect.arrayContaining([
        {
          code: "missing_schema",
          message: expect.any(String),
          at: "schema/",
          file: null,
        },
      ]),
    });
  });

  it("--json with no manifest is an error object, not a stack of text", async () => {
    const r = await run(["validate", "--json", "missing"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toEqual({
      v: 1,
      command: "validate",
      event: "result",
      ok: false,
      exit: 1,
      error: "no-manifest",
      message: expect.any(String),
    });
    // ASCII only, one line.
    expect(r.out).toMatch(/^[\x20-\x7e]+\n$/);
  });
});

// ── Completion ─────────────────────────────────────────────────────────────────────────────

describe("pkey completion", () => {
  it("prints a script for each shell, generated from the command table", async () => {
    for (const shell of COMPLETION_SHELLS) {
      const r = await run(["completion", shell]);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      for (const c of COMMANDS) expect(r.out).toContain(c.name);
      for (const sub of [
        "publish",
        "content-stamp",
        "revoke",
        "keys",
        "delegate",
        "promote",
        "pin",
        "unpin",
        "yank",
      ])
        expect(r.out).toContain(sub);
      // fish spells a long flag without its dashes (`-l release-key-file`).
      expect(r.out).toContain("release-key-file");
      expect(r.out).toContain("no-color");
    }
    const bash = (await run(["completion", "bash"])).out;
    expect(bash).toContain(
      '"release") words="publish content-stamp revoke keys delegate promote pin unpin yank" ;;',
    );
    expect(bash).toContain('"release keys") words="generate" ;;');
    expect(bash).toContain("complete -o default -F _pkey_complete pkey");
    const zsh = (await run(["completion", "zsh"])).out;
    expect(zsh.split("\n")[0]).toBe("#compdef pkey");
    expect(zsh).toContain(
      "'publish:Publish an app or pack release from build output'",
    );
    const fish = (await run(["completion", "fish"])).out;
    expect(fish).toContain(
      "complete -c pkey -n '__pkey_at release' -a 'publish' -d 'Publish an app or pack release from build output'",
    );
    expect(fish).toContain(
      "complete -c pkey -n '__pkey_at transport apple-ba' -a 'upload'",
    );
  });

  it("each script parses in its shell, where that shell is installed", async () => {
    for (const shell of COMPLETION_SHELLS) {
      const probe = spawnSync(shell, ["-c", "true"]);
      if (probe.error) continue; // not installed here
      const dir = await tempDir();
      const file = path.join(dir, `pkey.${shell}`);
      await writeFile(file, (await run(["completion", shell])).out);
      const check = spawnSync(shell, ["-n", file], { encoding: "utf8" });
      expect(check.status, `${shell} -n: ${check.stderr}`).toBe(0);
    }
  });

  it("an unknown or missing shell is a usage error on stderr", async () => {
    for (const argv of [["completion", "tcsh"], ["completion"]]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toBe("Usage: pkey completion bash|zsh|fish\n");
    }
  });
});

// ── Colour ─────────────────────────────────────────────────────────────────────────────────

describe("colour only on a colour terminal", () => {
  it("a pipe, NO_COLOR and --no-color give text with no escape sequences", async () => {
    const cwd = await tempDir();
    await productAt(cwd);
    for (const opts of [
      { tty: false, env: {} },
      { tty: false, env: { COLORTERM: "truecolor" } },
      { tty: true, env: { NO_COLOR: "1" } },
    ])
      for (const argv of [[], ["release", "--help"], ["validate"]]) {
        const r = await run(argv, { cwd, ...opts });
        // A pipe writes no escape at all; NO_COLOR on a terminal drops colour, not weight.
        if (opts.tty)
          expect(r.out).not.toMatch(
            /\x1b\[(?:3[0-79]|9[0-7]|4[0-79]|10[0-7]|[34]8)/,
          );
        else expect(r.out).not.toContain(ESC);
      }
    const flag = await run(["--no-color"], { tty: true });
    expect(flag.out).not.toMatch(
      /\x1b\[(?:3[0-79]|9[0-7]|4[0-79]|10[0-7]|[34]8)/,
    );
    // A terminal this size draws the logo header (logo.test.ts); the words are the same.
    expect(stripAnsi(flag.out)).toContain("Polaris Key platform CLI");
  });

  it("a colour terminal gets SGR roles: strong headings, muted descriptions, the verdict's role", async () => {
    const help = await run([], { tty: true, env: {} });
    expect(help.out).toContain(`${ESC}[1mManifest${ESC}[22m`);
    expect(help.out).toContain(`${ESC}[2m`);
    // The same words underneath, below the logo header (logo.test.ts).
    const body = (text: string) => text.slice(text.indexOf("Manifest"));
    expect(body(stripAnsi(help.out))).toBe(body((await run([])).out));

    const cwd = await tempDir();
    await productAt(cwd);
    const valid = await run(["validate"], { cwd, tty: true, env: {} });
    expect(valid.out).toContain(`${ESC}[32m✓${ESC}[39m`);
    await rm(path.join(cwd, ".pkey/schema.yaml"));
    const invalid = await run(["validate"], { cwd, tty: true, env: {} });
    expect(invalid.out).toContain(`${ESC}[31m✗${ESC}[39m`);
    expect(invalid.out).toContain(`${ESC}[31merror ${ESC}[39m`);
  });

  it("--ascii and TERM=dumb use the ASCII symbols", async () => {
    const cwd = await tempDir();
    await productAt(cwd);
    const r = await run(["validate", "--ascii"], { cwd });
    expect(r.out.split("\n")[0]).toBe("+  Manifest: valid");
    const dumb = await run(["validate"], { cwd, env: { TERM: "dumb" } });
    expect(dumb.out.split("\n")[0]).toBe("+  Manifest: valid");
  });
});

// ── The spinner ────────────────────────────────────────────────────────────────────────────

/** A ticker the test advances by hand. */
function manualTicker() {
  let fn: (() => void) | null = null;
  const ticker: Ticker = {
    setInterval: (f) => {
      fn = f;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
  };
  return { ticker, tick: () => fn?.(), running: () => fn !== null };
}

describe("the spinner", () => {
  it("draws one line per stage on a terminal, and erases it before other output", () => {
    const err = stream(true);
    const t = manualTicker();
    const s = new Spinner(err, {}, {}, t.ticker);
    expect(s.active).toBe(true);
    s.stage("Hashing 3 files");
    expect(stripAnsi(err.text())).toContain("⠋  Hashing 3 files");
    t.tick();
    expect(stripAnsi(err.text())).toContain("⠙  Hashing 3 files");
    s.advance(2, 3);
    expect(stripAnsi(err.text())).toMatch(/Hashing 3 files {2}━+─* 2\/3$/);
    const out = s.wrap(stream(false));
    const before = err.text().length;
    out.write("Matched 1 build\n");
    // The line is erased (carriage return, erase line) before the write.
    expect(err.text().slice(before)).toContain("\r\x1b[2K");
    s.stop();
    expect(t.running()).toBe(false);
    expect(err.text().endsWith("\x1b[?25h")).toBe(true);
  });

  it("is silent off a terminal and under CI", () => {
    for (const [tty, env] of [
      [false, {}],
      [true, { CI: "true" }],
      [true, { GITHUB_ACTIONS: "true" }],
      [true, { TERM: "dumb" }],
    ] as const) {
      const err = stream(tty);
      const t = manualTicker();
      const s = new Spinner(err, env, {}, t.ticker);
      expect(s.active).toBe(false);
      s.stage("Uploading 3 objects");
      s.advance(1, 3);
      t.tick();
      const out = stream(false);
      expect(s.wrap(out)).toBe(out);
      s.stop();
      expect(err.text()).toBe("");
    }
  });

  it("release publish: stages on a terminal's stderr, stdout byte for byte the same", async () => {
    const cwd = await repo();
    const argv = [
      "release",
      "publish",
      "--product",
      SLUG,
      "--tag",
      "v0.3.0",
      "--dir",
      "dist",
      "--base-url",
      "https://key.example.test",
    ];
    const publish = async (tty: boolean, env: Record<string, string>) => {
      const stdout = stream(false);
      const stderr = stream(tty);
      const code = await runPkey(argv, {
        cwd,
        stdout,
        stderr,
        env: { PKEY_CI_TOKEN: CI_TOKEN, ...env },
        fetchImpl: fakeServer().fetchImpl,
        sleep: instant,
      });
      return { code, out: stdout.text(), err: stderr.text() };
    };
    const piped = await publish(false, {});
    const terminal = await publish(true, {});
    const ci = await publish(true, { CI: "true" });
    for (const r of [piped, terminal, ci]) expect(r.code).toBe(0);
    expect(terminal.out).toBe(piped.out);
    expect(ci.out).toBe(piped.out);
    expect(piped.out).toContain("Published v0.3.0");
    for (const stage of [
      "Hashing 8 files",
      "Uploading 8 objects",
      "Submitting the release",
    ])
      expect(stripAnsi(terminal.err)).toContain(stage);
    // Erased at the end: the cursor is shown again and no stage is left on the screen.
    expect(terminal.err.endsWith("\x1b[?25h")).toBe(true);
    expect(piped.err).toBe("");
    expect(ci.err).toBe("");
  });
});
