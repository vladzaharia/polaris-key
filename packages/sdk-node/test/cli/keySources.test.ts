// @pkey-feature ui.cli
// Where `activate` gets its key (the Python kit's names and precedence): `--key-file`, `--key-stdin`,
// `$POLARIS_KEY_ACTIVATION_KEY`, then the positional (which warns), then the prompt or a pipe.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPolarisCommands } from "../../src/cli/index.js";
import { KEY_ENV_VAR } from "../../src/cli/flows.js";
import { frozenTicker, NOW, stubClient } from "./harness.js";
import { Screen } from "./screen.js";

const A = "pkey_tidewater_AAAAAAAAAAAAAAAAAAAAAA";
const B = "pkey_tidewater_BBBBBBBBBBBBBBBBBBBBBB";
const C = "pkey_tidewater_CCCCCCCCCCCCCCCCCCCCCC";
const D = "pkey_tidewater_DDDDDDDDDDDDDDDDDDDDDD";

async function run(
  argv: string[],
  o: { env?: Record<string, string>; stdin?: string } = {},
) {
  const seen: string[] = [];
  const client = stubClient({
    license: {
      activateWithKey: async (key: string) => {
        seen.push(key);
        return { kind: "ok", token: "pkeyt_secret", schemaVersion: 1 };
      },
    },
  });
  const screen = new Screen();
  const err = new Screen();
  const stdin = new PassThrough();
  stdin.end(o.stdin ?? "");
  let exit = 0;
  const program = new Command();
  program.exitOverride();
  registerPolarisCommands(program, async () => client, {
    pinnedKeys: {},
    verbs: "all",
    productSlug: "tidewater",
    io: {
      stdout: screen,
      stderr: err,
      stdin: Object.assign(stdin, { isTTY: false }) as never,
      env: { TERM: "xterm-256color", ...o.env },
      ticker: frozenTicker,
      now: () => NOW,
    },
    setExitCode: (c: number) => {
      exit = c;
    },
  });
  await program.parseAsync(["activate", ...argv, "--json"], { from: "user" });
  const last = screen.raw.trim().split("\n").at(-1)!;
  return { seen, exit, result: JSON.parse(last) as Record<string, unknown> };
}

const file = (text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "pkey-keyfile-")), "key");
  writeFileSync(p, text);
  return p;
};

describe("activate: where the key comes from", () => {
  it("reads --key-file, trimmed", async () => {
    const r = await run(["--key-file", file(`${A}\n`)]);
    expect(r.seen).toEqual([A]);
    expect(r.exit).toBe(0);
  });

  it("reads --key-stdin", async () => {
    const r = await run(["--key-stdin"], { stdin: `${B}\n` });
    expect(r.seen).toEqual([B]);
  });

  it("reads the environment variable", async () => {
    expect(KEY_ENV_VAR).toBe("POLARIS_KEY_ACTIVATION_KEY");
    const r = await run([], { env: { [KEY_ENV_VAR]: ` ${C} ` } });
    expect(r.seen).toEqual([C]);
  });

  it("takes them in order: file, stdin, environment, then the positional", async () => {
    const env = { [KEY_ENV_VAR]: C };
    expect(
      (
        await run([D, "--key-file", file(A), "--key-stdin"], {
          env,
          stdin: `${B}\n`,
        })
      ).seen,
    ).toEqual([A]);
    expect(
      (await run([D, "--key-stdin"], { env, stdin: `${B}\n` })).seen,
    ).toEqual([B]);
    expect((await run([D], { env })).seen).toEqual([C]);
    expect((await run([D])).seen).toEqual([D]);
  });

  it("ends an empty or unreadable --key-file in a usage result, with no request", async () => {
    const empty = await run(["--key-file", file("  \n")]);
    expect(empty.seen).toEqual([]);
    expect(empty.exit).toBe(2);
    expect(empty.result).toMatchObject({ ok: false, exit: 2, error: "usage" });
    expect(empty.result.file).toBeTypeOf("string");
    const gone = await run(["--key-file", "/nonexistent/pkey-key"]);
    expect(gone.exit).toBe(2);
    expect(gone.result).toMatchObject({ error: "usage" });
  });

  it("ends --key-stdin with nothing on stdin in a usage result", async () => {
    const r = await run(["--key-stdin"], { stdin: "" });
    expect(r.seen).toEqual([]);
    expect(r.exit).toBe(2);
    expect(r.result).toMatchObject({ error: "usage" });
    expect(String(r.result.message)).toContain("--key-stdin");
  });
});
