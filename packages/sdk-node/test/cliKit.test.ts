// @pkey-feature identity.devicecode devices.manage config.list config.secret config.mint release.changelog update.check packs.state
// SDK parity pass SP-N14: the full CLI kit. Each verb's core function gets one test; both
// adapters build every verb from CLI_VERBS, so their command trees are compared verb for verb.

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import yargs from "yargs";
import {
  CLI_VERBS,
  changelog,
  configList,
  configReset,
  configSet,
  devicesDeauthorize,
  devicesList,
  devicesRename,
  doctor,
  mint,
  offlineRequest,
  packsEnsure,
  packsStatus,
  parseCliValue,
  progressBar,
  registerPolarisCommands,
  registerYargsCommands,
  secret,
  signIn,
  signOut,
  updateApply,
  updateCheck,
  type CliIO,
} from "../src/cli/index.js";
import { DEVICE, json, seededClient, signedLicense } from "./parityFixtures.js";

const ALL = [
  "license",
  "config",
  "identity",
  "release",
  "update",
  "devices",
] as never;

function io(): CliIO & { lines: string[]; bars: string[] } {
  const lines: string[] = [];
  const bars: string[] = [];
  return {
    lines,
    bars,
    print: (l) => lines.push(l),
    progress: (l) => bars.push(l),
  };
}

async function client(routes = {}, token: string | null = "pkeyt_seed") {
  return seededClient({
    license: await signedLicense({ pro: true }),
    token,
    extra: { expectedServices: ALL },
    routes,
  });
}

describe("identity verbs", () => {
  it("sign-in prints the code, the URL and a QR, then waits for ready", async () => {
    const licence = await signedLicense({ pro: true });
    const { client: c } = await client({
      "POST /djdl/identity/auth/device/start": () =>
        json({
          deviceCode: "dc",
          userCode: "WDJB-MJHT",
          verificationUri: "https://k.test/djdl/identity/auth/device",
          verificationUriComplete:
            "https://k.test/djdl/identity/auth/device?user_code=WDJB-MJHT",
          expiresIn: 600,
          interval: 1,
        }),
      "POST /djdl/identity/auth/device/poll": () =>
        json({
          status: "ready",
          token: "pkeyt_signed",
          identity: { email: "ada@example.com" },
        }),
      "GET /djdl/license/document": () => new Response(licence),
      "GET /djdl/config/document": () => new Response("", { status: 404 }),
      "POST /djdl/devices/report": () => json({}),
    });
    const out = io();
    const r = await signIn(c, out);
    expect(out.lines[0]).toContain("WDJB-MJHT");
    expect(out.lines[1]).toMatch(/[█▀▄]/);
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toContain("ada@example.com");
  });

  it("sign-out wipes the credential", async () => {
    const { client: c } = await client();
    expect((await signOut(c)).ok).toBe(true);
    expect(c.license.activation()).toBeNull();
  });
});

describe("license verbs", () => {
  it("offline-request prints the product and the device id with a QR", async () => {
    const { client: c } = await client();
    const out = io();
    const r = offlineRequest(c, out);
    expect(r.message).toContain(`Request code: ${DEVICE}`);
    expect(r.message).toContain("Product: djdl");
    expect(out.lines).toHaveLength(1);
  });
});

describe("devices verbs", () => {
  it("lists, renames and deauthorizes, and reports refusals through the copy catalog", async () => {
    const { client: c, seen } = await client({
      "GET /djdl/devices": () =>
        json({
          devices: [
            { id: DEVICE, current: true, status: "active", label: "Studio" },
            {
              id: "dev_other",
              current: false,
              status: "active",
              platform: "macos",
            },
          ],
        }),
      "PATCH /djdl/devices/dev_other": () => json({}),
      "DELETE /djdl/devices/dev_other": () => json({}),
    });
    const list = await devicesList(c);
    expect(list.message).toContain("* Studio");
    expect(list.message).toContain("dev_other  macos");
    expect((await devicesRename(c, "dev_other", "Laptop")).message).toContain(
      '"Laptop"',
    );
    expect((await devicesDeauthorize(c, "dev_other")).ok).toBe(true);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(
      expect.arrayContaining([
        "PATCH /djdl/devices/dev_other",
        "DELETE /djdl/devices/dev_other",
      ]),
    );
    const { client: anon } = await client({}, null);
    const refused = await devicesRename(anon, "dev_other", "x");
    expect(refused.ok).toBe(false);
  });
});

describe("config verbs", () => {
  it("set parses JSON, list shows the source, reset removes the override", async () => {
    const { client: c } = await client();
    expect(parseCliValue("3")).toBe(3);
    expect(parseCliValue("fast")).toBe("fast");
    const set = await configSet(c, "run.mode", '"slow"');
    expect(set.ok).toBe(true);
    expect(c.config.getConfig("run.mode", null)).toBe("slow");
    expect(configList(c).ok).toBe(true);
    await configReset(c, "run.mode");
    expect(c.config.getConfig("run.mode", null)).toBeNull();
  });

  it("secret refuses a key that is not delivered; mint prints the token", async () => {
    const { client: c } = await client({
      "GET /djdl/config/mint/maps/token": () =>
        json({
          token: "tok_live",
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }),
    });
    expect(secret(c, "api.key").ok).toBe(false);
    const m = await mint(c, "maps");
    expect(m).toMatchObject({ ok: true, message: "tok_live" });
  });
});

describe("update and release verbs", () => {
  it("update check falls back to the version check; changelog lists releases", async () => {
    const { client: c } = await client({
      "GET /djdl/update/version": () =>
        json({ version: "2.0.0", tag: "v2.0.0", url: "https://k.test/dl" }),
      "GET /djdl/release/changelog": () =>
        json({
          entries: [
            {
              version: "2.0.0",
              tag: "v2.0.0",
              date: "2026-10-01T00:00:00Z",
              summary: "Faster",
              url: "u",
            },
          ],
        }),
    });
    const check = await updateCheck(c);
    expect(check.message).toContain("2.0.0 is available");
    const log = await changelog(c);
    expect(log.message).toContain("2.0.0  2026-10-01");
    expect(log.message).toContain("Faster");
  });

  it("update apply without release keys fails with the copy catalog's sentence and code", async () => {
    const { client: c } = await client();
    const r = await updateApply(c, io());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\[[a-z-]+\]$/);
  });
});

describe("packs verbs", () => {
  it("status and ensure answer with nothing installed", async () => {
    const { client: c } = await client();
    expect((await packsStatus(c)).message).toBe("No packs installed.");
    const r = await packsEnsure(c, [], io());
    expect(r.message).toBe("Everything is already installed.");
    expect(progressBar(50, 100)).toContain(" 50%");
  });
});

describe("doctor", () => {
  it("names the SDK, the store, discovery and the unsupported features", async () => {
    const { client: c } = await client();
    const r = await doctor(c);
    expect(r.message).toContain("@polaris-key/node");
    expect(r.message).toContain("Token store: memory");
    expect(r.message).toContain("Discovery:");
    expect(r.ok).toBe(false); // the stub has no discovery document
  });
});

describe("the adapters build every verb from CLI_VERBS", () => {
  const leaves = (cmd: Command, prefix: string[] = []): string[] =>
    cmd.commands.flatMap((c) =>
      c.commands.length
        ? leaves(c, [...prefix, c.name()])
        : [[...prefix, c.name()].join(" ")],
    );

  it("commander has every verb and dispatches a nested one", async () => {
    const { client: c } = await client({
      "GET /djdl/devices": () => json({ devices: [] }),
    });
    const lines: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerPolarisCommands(program, async () => c, {
      pinnedKeys: {},
      productSlug: "djdl",
      version: "1.2.3",
      print: (l) => lines.push(l),
      setExitCode: () => undefined,
    });
    expect(leaves(program).sort()).toEqual(
      CLI_VERBS.map((v) => v.path.join(" ")).sort(),
    );
    await program.parseAsync(["devices", "list"], { from: "user" });
    expect(lines.join("\n")).toContain("0 device(s)");
    await program.parseAsync(["config", "get", "missing.key"], {
      from: "user",
    });
    expect(lines.at(-1)).toContain("missing.key is not set");
  });

  it("yargs dispatches the same nested verbs", async () => {
    const { client: c } = await client({
      "GET /djdl/devices": () => json({ devices: [] }),
    });
    const lines: string[] = [];
    const y = yargs([]).exitProcess(false);
    registerYargsCommands(y, async () => c, {
      pinnedKeys: {},
      productSlug: "djdl",
      version: "1.2.3",
      print: (l) => lines.push(l),
      setExitCode: () => undefined,
    });
    await y.parseAsync(["polaris-key", "devices", "list"]);
    expect(lines.join("\n")).toContain("0 device(s)");
    await y.parseAsync(["polaris-key", "config", "get", "missing.key"]);
    expect(lines.at(-1)).toContain("missing.key is not set");
  });
});
