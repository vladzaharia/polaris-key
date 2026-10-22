// @pkey-feature ui.cli.mount
// What a developer meets when adding the verbs to a host CLI: a config that names the command
// that fixes it, a bare group that runs its default action, a strict yargs host whose unknown
// option still ends in the kit's usage result, and the cause of an internal failure on request.

import { Command } from "commander";
import yargs from "yargs";
import { describe, expect, it } from "vitest";
import { registerPolarisCommands } from "../../src/cli/commander.js";
import { CliConfigError, checkCliConfig } from "../../src/cli/mount.js";
import { registerPolarisCommands as registerYargs } from "../../src/cli/yargs.js";
import type { PolarisKeyClient } from "../../src/client.js";
import { FakeStdin, frozenTicker, NOW, stubClient } from "./harness.js";
import { Screen } from "./screen.js";

const PIN = "A".repeat(43);
const GOOD = {
  productSlug: "tidewater",
  baseUrl: "https://key.plrs.im",
  trust: { pinnedKeys: { k1: PIN } },
};

function terminal(env: Record<string, string> = {}) {
  const stdout = new Screen({ tty: false, columns: 80, rows: 30 });
  const stderr = new Screen({ tty: false, columns: 80 });
  const stdin = new FakeStdin(false);
  stdin.end();
  return {
    stdout,
    stderr,
    io: {
      stdout,
      stderr,
      stdin,
      env: {
        TERM: "xterm-256color",
        NO_COLOR: "1",
        PKEY_THEME: "dark",
        ...env,
      },
      platform: "linux" as const,
      ticker: frozenTicker,
      now: () => NOW,
      openUrl: () => true,
    },
  };
}
const lines = (s: Screen) =>
  s.raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("a config the CLI cannot work from", () => {
  const FIX = "pkey sdk --lang node --write";
  const cases: [string, unknown, string][] = [
    ["no config", undefined, "config is missing"],
    ["no slug", { ...GOOD, productSlug: "" }, "productSlug is missing"],
    ["no trust", { productSlug: "tw" }, "no trust.pinnedKeys"],
    [
      "no pins",
      { ...GOOD, trust: { pinnedKeys: {} } },
      "no license could verify",
    ],
    [
      "a placeholder pin",
      { ...GOOD, trust: { pinnedKeys: { "<your-signing-key-id>": "<x>" } } },
      "not a raw Ed25519 public key",
    ],
    ["a bad base URL", { ...GOOD, baseUrl: "nope" }, "not an http(s) origin"],
  ];
  for (const [name, config, says] of cases)
    it(`${name} says what to run`, () => {
      let err: unknown;
      try {
        checkCliConfig(config);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliConfigError);
      expect((err as CliConfigError).code).toBe("polaris-bad-config");
      expect((err as Error).message).toContain(says);
      expect((err as Error).message).toContain(FIX);
    });

  it("passes the generated shape", () => {
    expect(() => checkCliConfig(GOOD)).not.toThrow();
    expect(() => checkCliConfig({ ...GOOD, baseUrl: undefined })).not.toThrow();
  });

  it("fails the registration, not the first verb", () => {
    expect(() =>
      registerPolarisCommands(new Command("tidewater"), {
        config: { productSlug: "tw" } as never,
        version: "1.0.0",
      }),
    ).toThrow(/pkey sdk --lang node --write/);
    expect(() =>
      registerYargs(yargs([]).exitProcess(false), {
        config: { ...GOOD, trust: { pinnedKeys: {} } },
        version: "1.0.0",
      }),
    ).toThrow(/polaris-bad-config/);
  });
});

describe("a bare group runs its default action", () => {
  const devices = () =>
    stubClient({
      listDevices: async () => [
        { id: "dev_1", label: "Studio", platform: "linux" },
      ],
    }) as PolarisKeyClient;

  it("commander: devices lists", async () => {
    const t = terminal();
    const program = new Command("tidewater");
    program.exitOverride();
    let code = -1;
    registerPolarisCommands(program, async () => devices(), {
      productSlug: "tidewater",
      pinnedKeys: {},
      version: "1.0.0",
      io: t.io,
      setExitCode: (c) => (code = c),
    });
    await program.parseAsync(["devices", "--json"], { from: "user" });
    const last = lines(t.stdout).at(-1)!;
    expect(last.command).toBe("devices list");
    expect(last.ok).toBe(true);
    expect(code).toBe(0);
  });

  it("yargs: devices lists, and a strict host still gets the usage result", async () => {
    const t = terminal();
    let code = -1;
    const run = async (argv: string[]) => {
      t.stdout.raw = "";
      const y = yargs([]).exitProcess(false).strict().fail(false);
      registerYargs(y, async () => devices(), {
        productSlug: "tidewater",
        pinnedKeys: {},
        version: "1.0.0",
        bin: "tidewater",
        io: t.io,
        setExitCode: (c) => (code = c),
      });
      await y.parseAsync(argv);
    };
    await run(["devices", "--json"]);
    expect(lines(t.stdout).at(-1)).toMatchObject({
      command: "devices list",
      ok: true,
    });
    await run(["status", "--bogus", "--json"]);
    expect(lines(t.stdout).at(-1)).toMatchObject({
      command: "status",
      ok: false,
      exit: 2,
      error: "usage",
    });
    expect(code).toBe(2);
  });
});

describe("an internal failure", () => {
  const boom = async () => {
    throw new TypeError("boom from the host's factory");
  };
  const run = async (env: Record<string, string>) => {
    const t = terminal(env);
    const program = new Command("tidewater");
    registerPolarisCommands(program, boom as never, {
      productSlug: "tidewater",
      pinnedKeys: {},
      version: "1.0.0",
      io: t.io,
      setExitCode: () => undefined,
    });
    await program.parseAsync(["status"], { from: "user" });
    return t;
  };

  it("keeps the screen generic and the cause to DEBUG=polaris", async () => {
    const quiet = await run({});
    expect(quiet.stderr.raw).not.toContain("boom");
    expect(quiet.stdout.raw).not.toContain("boom");
    const loud = await run({ DEBUG: "polaris" });
    expect(loud.stderr.raw).toContain("boom from the host's factory");
  });
});
