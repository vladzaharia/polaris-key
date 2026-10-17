// @pkey-feature ui.cli.contract
// The gate beyond the corpus rows (cliMount.test.ts): polarisGate over a commander program, a yargs
// handler, an explicit client, frame: false, the namespace in the fix line, and the compile check
// for a project that has commander and not yargs.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import ts from "typescript";
import yargs from "yargs";
import { describe, expect, it } from "vitest";
import { registerPolarisCommands } from "../../src/cli/commander.js";
import { polarisGate, requireLicense, runGate } from "../../src/cli/gate.js";
import { EXIT } from "../../src/cli/json.js";
import { registerPolarisCommands as registerYargs } from "../../src/cli/yargs.js";
import type { PolarisKeyClient } from "../../src/client.js";
import { updateApplyFlow } from "../../src/cli/flows.js";
import {
  FakeStdin,
  frozenTicker,
  NOW,
  render,
  settle,
  stubClient,
  VARIANTS,
} from "./harness.js";
import { Screen } from "./screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

function terminal(tty = false) {
  const stdout = new Screen({ tty, columns: 80, rows: 30 });
  const stderr = new Screen({ tty, columns: 80 });
  const stdin = new FakeStdin(tty);
  if (!tty) stdin.end();
  return {
    stdout,
    stderr,
    stdin,
    io: {
      stdout,
      stderr,
      stdin,
      env: {
        TERM: "xterm-256color",
        NO_COLOR: "1",
        PKEY_THEME: "dark",
        DISPLAY: ":0",
      },
      platform: "linux" as const,
      ticker: frozenTicker,
      now: () => NOW,
      openUrl: () => true,
    },
  };
}

const revoked = () =>
  stubClient({ status: () => ({ status: "revoked" }) }) as PolarisKeyClient;

describe("polarisGate", () => {
  it("gates every host command and leaves the kit's own verbs alone", async () => {
    const t = terminal();
    const program = new Command("mytool");
    program.exitOverride();
    let exited: number | null = null;
    const ran: string[] = [];
    registerPolarisCommands(program, async () => revoked(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      version: "1.0.0",
      io: t.io,
      setExitCode: () => undefined,
    });
    program.command("export").action(() => void ran.push("export"));
    program.command("version").action(() => void ran.push("version"));
    polarisGate(program, {
      except: ["version"],
      exit: (c) => {
        exited = c;
        throw new Error("exit");
      },
    });
    await expect(
      program.parseAsync(["export"], { from: "user" }),
    ).rejects.toThrow("exit");
    expect(exited).toBe(EXIT.licenseRequired);
    expect(ran).toEqual([]);
    expect(plain(t.stderr.raw)).toContain("mytool activate");
    // An excepted command runs; so do the kit's own verbs (status on a revoked license).
    await program.parseAsync(["version"], { from: "user" });
    expect(ran).toEqual(["version"]);
    await program.parseAsync(["status"], { from: "user" });
    expect(exited).toBe(EXIT.licenseRequired);
  });
});

describe("requireLicense", () => {
  it("names the namespace in the fix line", async () => {
    const t = terminal();
    const program = new Command("mytool");
    program.exitOverride();
    let code = 0;
    registerPolarisCommands(program, async () => revoked(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      version: "1.0.0",
      namespace: "license",
      io: t.io,
      setExitCode: (c) => (code = c),
    });
    program.command("export").action(requireLicense(() => undefined));
    await program.parseAsync(["export"], { from: "user" });
    expect(code).toBe(EXIT.licenseRequired);
    expect(plain(t.stderr.raw)).toContain("mytool license activate");
    expect(plain(t.stderr.raw)).toContain("mytool license login");
  });

  it("leaves out a fix whose verb the mount does not offer", async () => {
    const t = terminal();
    const program = new Command("mytool");
    registerPolarisCommands(program, async () => revoked(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      version: "1.0.0",
      verbs: ["activate", "status"],
      io: t.io,
      setExitCode: () => undefined,
    });
    program.command("export").action(requireLicense(() => undefined));
    await program.parseAsync(["export"], { from: "user" });
    expect(plain(t.stderr.raw)).toContain("mytool activate");
    expect(plain(t.stderr.raw)).not.toContain("mytool login");
  });

  it("takes an explicit client when nothing is mounted", async () => {
    const t = terminal();
    let code = 0;
    let ran = 0;
    const gated = requireLicense(() => void (ran += 1), {
      client: revoked(),
      io: t.io,
      slug: "tidewater",
      bin: "mytool",
      setExitCode: (c) => (code = c),
    });
    await gated();
    expect([ran, code]).toEqual([0, EXIT.licenseRequired]);
    const ok = requireLicense(() => void (ran += 1), {
      client: stubClient() as PolarisKeyClient,
      io: t.io,
      setExitCode: (c) => (code = c),
    });
    await ok();
    expect(ran).toBe(1);
  });

  it("works as a yargs handler", async () => {
    const t = terminal();
    const y = yargs([]).exitProcess(false);
    let code = 0;
    let ran = 0;
    registerYargs(y, async () => revoked(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      version: "1.0.0",
      io: t.io,
      bin: "mytool",
      setExitCode: (c) => (code = c),
    });
    y.command(
      "export",
      "Export",
      {},
      requireLicense(() => void (ran += 1)),
    );
    await y.parseAsync(["export", "--json"]);
    expect([ran, code]).toEqual([0, EXIT.licenseRequired]);
    expect(JSON.parse(t.stdout.raw)).toMatchObject({
      command: "export",
      exit: 4,
      error: "license_required",
    });
  });
});

describe("frame: false", () => {
  it("a kit flow draws no product chip and no closing row", async () => {
    const run = async (frame: boolean) => {
      const t = terminal();
      const program = new Command("mytool");
      program.exitOverride();
      registerPolarisCommands(program, async () => stubClient(), {
        pinnedKeys: {},
        productSlug: "tidewater",
        version: "1.0.0",
        io: t.io,
        ...(frame ? {} : { frame: false }),
        setExitCode: () => undefined,
      });
      await program.parseAsync(["status"], { from: "user" });
      return plain(t.stdout.raw);
    };
    const framed = await run(true);
    const bare = await run(false);
    expect(framed).toContain("· status");
    expect(bare).not.toContain("· status");
    expect(bare).toContain("Pro");
    expect(bare.split("\n").length).toBeLessThan(framed.split("\n").length);
  });
});

describe("frame: false refusal", () => {
  it("the refusal is the kit's own screen, so it still closes", async () => {
    const t = terminal();
    await runGate({
      client: revoked(),
      command: "export",
      slug: "tidewater",
      bin: "mytool",
      frame: false,
      io: t.io,
    });
    const lines = plain(t.stderr.raw).trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/^└/);
  });
});

describe("the inline gate flow", () => {
  it("says which command needs a license, and on Esc shows the refusal and the way back", async () => {
    const t = terminal(true);
    const done = runGate({
      client: revoked(),
      command: "export",
      slug: "tidewater",
      bin: "mytool",
      mounted: ["activate", "login"],
      io: t.io,
    });
    await settle();
    expect(plain(t.stdout.raw)).toContain("export needs a license");
    t.stdin.press("escape", { sequence: "\x1b" });
    const code = await done;
    expect(code).not.toBe(0);
    const err = plain(t.stderr.raw);
    expect(err).toContain("mytool activate");
    expect(err).toContain("mytool login");
  });

  it("shows nothing on a quick check and Checking your license on a slow one", async () => {
    const check = async (syncMs: number) => {
      const t = terminal(true);
      const stdin = new FakeStdin(false);
      stdin.end();
      await runGate({
        client: stubClient({
          status: () => ({ status: "revoked" }),
          extra: {
            sync: () => new Promise<void>((r) => setTimeout(r, syncMs)),
          },
        }) as PolarisKeyClient,
        command: "export",
        slug: "tidewater",
        bin: "mytool",
        io: { ...t.io, stdin },
      });
      return plain(t.stderr.raw);
    };
    expect(await check(0)).not.toContain("Checking your license");
    expect(await check(700)).toContain("Checking your license");
  });
});

describe("types", () => {
  it("the kit's entry compiles with skipLibCheck: false and pulls in no yargs types", () => {
    const program = ts.createProgram([join(HERE, "../../src/cli/index.ts")], {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2023,
      // The DOM lib stands in for the globals (CryptoKey, WebAssembly) that @polaris-key/jws's and
      // zstd-wasm's declarations name; a project without it fails on those two files whatever
      // parser it uses (follow-up in the UK-46 report).
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      types: ["node"],
    });
    const files = program.getSourceFiles().map((f) => f.fileName);
    expect(files.filter((f) => /\/yargs\//.test(f))).toEqual([]);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);
  }, 120_000);
});

describe("update apply's hand-off exit", () => {
  const release = { version: "2.5.0", seq: 7 };
  const exitFor = async (decision: unknown, driver?: null) => {
    let code = -1;
    await render({ variant: VARIANTS[3]! }, async (h) => {
      const r = await updateApplyFlow(
        h.ctx,
        stubClient({
          update: { decide: async () => ({ decision }), driver },
        }),
      );
      code = r.exitCode;
    });
    return code;
  };

  it("is 0 when a package manager takes the upgrade", async () => {
    expect(
      await exitFor({
        action: "platform",
        release,
        mandatory: false,
        critical: false,
        discardStaged: false,
      }),
    ).toBe(EXIT.ok);
  });

  it("is 1 when the build has no way to install it", async () => {
    expect(
      await exitFor(
        {
          action: "binary",
          method: "full",
          release,
          build: "b",
          mandatory: false,
          critical: false,
          prestage: [],
          discardStaged: false,
        },
        null,
      ),
    ).toBe(EXIT.failed);
  });
});
