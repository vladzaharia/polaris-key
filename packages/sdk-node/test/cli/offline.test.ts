// @pkey-feature ui.cli
// A product the client could not reach is offline, not "Not available" (the Python kit's `network`):
// with no discovery document, `login` and `update check` report `network`, never `identity_disabled`
// or `service-unavailable`.

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPolarisCommands } from "../../src/cli/index.js";
import { frozenTicker, NOW, stubClient } from "./harness.js";
import { Screen } from "./screen.js";

async function run(argv: string[], discovered: boolean) {
  const unavailable = Object.assign(new Error("off"), {
    code: "service-unavailable",
  });
  const client = stubClient({
    capabilities: {
      license: { enabled: true },
      config: { enabled: true },
    },
    update: {
      decide: async () => {
        throw unavailable;
      },
    },
    extra: {
      servicesPinned: false,
      discovery: () => (discovered ? { kind: "ok" } : null),
      discover: async () => {
        throw new Error("offline");
      },
    },
  });
  const screen = new Screen();
  const program = new Command();
  program.exitOverride();
  registerPolarisCommands(program, async () => client, {
    pinnedKeys: {},
    verbs: "all",
    productSlug: "tidewater",
    io: {
      stdout: screen,
      stderr: new Screen(),
      env: {},
      ticker: frozenTicker,
      now: () => NOW,
    },
    setExitCode: () => undefined,
  });
  await program.parseAsync([...argv, "--json"], { from: "user" });
  return JSON.parse(screen.raw.trim().split("\n").at(-1)!) as {
    error?: string;
    exit: number;
  };
}

describe("offline, nothing discovered", () => {
  it("login says network", async () => {
    expect(await run(["login"], false)).toMatchObject({
      exit: 1,
      error: "network",
    });
  });
  it("update check says network", async () => {
    expect(await run(["update", "check"], false)).toMatchObject({
      exit: 1,
      error: "network",
    });
  });
  it("a product that really runs without Identity still says so", async () => {
    expect(await run(["login"], true)).toMatchObject({
      error: "identity_disabled",
    });
    expect(await run(["update", "check"], true)).toMatchObject({
      error: "service-unavailable",
    });
  });
});

describe("register, server unreachable", () => {
  it("answers network-error like the Python kit, not unknown", async () => {
    const client = stubClient({
      extra: {
        devices: {
          register: async () => ({
            kind: "error",
            code: "network-error",
            message: "fetch failed",
          }),
        },
      },
    });
    const screen = new Screen();
    const program = new Command();
    program.exitOverride();
    registerPolarisCommands(program, async () => client, {
      pinnedKeys: {},
      verbs: "all",
      productSlug: "tidewater",
      io: {
        stdout: screen,
        stderr: new Screen(),
        env: {},
        ticker: frozenTicker,
        now: () => NOW,
      },
      setExitCode: () => undefined,
    });
    await program.parseAsync(["register", "--json"], { from: "user" });
    const last = JSON.parse(screen.raw.trim().split("\n").at(-1)!);
    expect(last).toMatchObject({
      ok: false,
      exit: 1,
      error: "network-error",
    });
  });
});
