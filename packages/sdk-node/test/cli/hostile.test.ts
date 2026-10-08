// @pkey-feature ui.cli
// Hostile text and the terminal (UK-13's review, applied to the Node kit): server and product
// text (device labels, names, emails, developer names, changelog summaries, URLs, the
// verification URI) never reaches a terminal as an escape; OSC 8 links only for https (or
// loopback http) with no control or whitespace; TERM=dumb gets plain lines with no cursor
// control; and every `--json` run, including an exception or an argument error, ends with a
// result line.

import { describe, expect, it } from "vitest";
import { Command } from "commander";
import yargs from "yargs";
import {
  CLI_VERBS,
  registerPolarisCommands,
  registerYargsCommands,
} from "../../src/cli/index.js";
import {
  activateFlow,
  changelogFlow,
  devicesListFlow,
  loginFlow,
  statusFlow,
} from "../../src/cli/flows.js";
import { clean, safeLink } from "../../src/cli/term/sanitize.js";
import { osc8 } from "../../src/cli/term/osc.js";
import { runKitVerb } from "../../src/cli/adapter.js";
import {
  FakeStdin,
  frozenTicker,
  KEY,
  KEY_SECRET,
  NOW,
  render,
  settle,
  stubClient,
  VARIANTS,
} from "./harness.js";
import { Screen } from "./screen.js";

/** An OSC 52 clipboard write, a screen clear, a C1 CSI and a BEL, as a server might send them. */
const EVIL = "\x1b]52;c;cGF5bG9hZA==\x07\x1b[2J\u009b31m\u0007\x00";

/** What remains of a stream once the kit's own sequences are taken out. */
function foreign(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\[\?25[hl]/g, "")
    .replace(/\x1b\[2K|\x1b\[1A/g, "")
    .replace(/\x1b\]8;;https:\/\/[^\x1b\x07\s]*\x1b\\/g, "")
    .replace(/\x1b\]8;;\x1b\\/g, "")
    .replace(/\r/g, "");
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

const hostile = stubClient({
  status: () => ({ status: "ok", graceUntil: NOW / 1000 + 86_400 * 9 }),
  licenseInfo: {
    licenseId: "l",
    tier: "pro",
    tierLabel: `Pro${EVIL}`,
    deviceLimit: 3,
    profile: { name: `Mara${EVIL}`, email: `mara${EVIL}@fennick.studio` },
    entitledChannels: [],
    status: "ok",
  },
  listDevices: async () => [
    {
      id: `dev_1${EVIL}`,
      current: true,
      status: "ok",
      label: `Work${EVIL} laptop`,
      platform: `linux${EVIL}`,
    },
  ],
  release: {
    changelog: async () => [
      {
        version: `2.5${EVIL}`,
        date: "2026-10-02T00:00:00Z",
        summary: `Stems${EVIL} export`,
      },
    ],
  },
  identity: {
    beginSignIn: async () => ({
      deviceCode: "dc_secret",
      userCode: `WDJB${EVIL}-MJHT`,
      verificationUri: `https://key.plrs.im/device${EVIL}`,
      verificationUriComplete: `https://key.plrs.im/device?code=X${EVIL}`,
      expiresIn: 600,
      interval: 5,
      expiresAt: NOW / 1000 + 300,
      deviceName: null,
    }),
    waitForSignIn: async () => ({
      status: "ready",
      identity: { name: `Mara${EVIL}`, email: `m${EVIL}@x.test` },
    }),
  },
});
const evilPresentation = {
  name: `Tidewater${EVIL} Studio`,
  developerName: `Harbor${EVIL}`,
  accent: "#369186",
};

describe("server and product text never reaches the terminal as an escape", () => {
  const flows: Array<
    [
      string,
      (h: Parameters<Parameters<typeof render>[1]>[0]) => Promise<unknown>,
    ]
  > = [
    ["status", (h) => statusFlow(h.ctx, hostile)],
    ["devices list", (h) => devicesListFlow(h.ctx, hostile)],
    ["changelog", (h) => changelogFlow(h.ctx, hostile)],
    ["login (code)", (h) => loginFlow(h.ctx, hostile, { deviceCode: true })],
    ["login (browser)", (h) => loginFlow(h.ctx, hostile)],
  ];
  for (const [name, run] of flows)
    it(`${name}: no foreign ESC, BEL or C1 in any variant, and none at all under --json`, async () => {
      for (const v of VARIANTS) {
        const r = await render(
          { variant: v, presentation: evilPresentation },
          run,
        );
        const left = foreign(`${r.raw}${r.stderr}`);
        expect(
          CONTROL.test(left),
          `${name} ${v.id}: ${JSON.stringify(left.match(CONTROL))}`,
        ).toBe(false);
        expect(r.raw).not.toContain("\x1b]52;");
        expect(r.raw).not.toContain("\x1b[2J");
      }
      const j = await render(
        { variant: VARIANTS[0]!, presentation: evilPresentation, json: true },
        run,
      );
      expect(CONTROL.test(j.raw.replace(/\n/g, ""))).toBe(false);
      for (const line of j.raw.trim().split("\n").filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(/^[\x20-\x7e]*$/.test(line), "a --json line is ASCII only").toBe(
          true,
        );
      }
    });

  it("cleans C0, DEL and C1 and nothing else", () => {
    expect(clean(`a${EVIL}b`)).toBe("a]52;c;cGF5bG9hZA==[2J31mb");
    expect(clean("Mara’s iPad · ライセンス")).toBe("Mara’s iPad · ライセンス");
  });
});

describe("OSC 8 links only for safe targets", () => {
  it("links https and loopback http, nothing else", () => {
    expect(safeLink("https://key.plrs.im/portal/tidewater")).toBe(
      "https://key.plrs.im/portal/tidewater",
    );
    expect(safeLink("http://127.0.0.1:53111/pkey/callback")).not.toBeNull();
    expect(safeLink("http://localhost:8080/x")).not.toBeNull();
    for (const bad of [
      "http://key.plrs.im/portal",
      "https://key.plrs.im/a b",
      "https://user:pw@key.plrs.im/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://key.plrs.im/\x1b]52;c;x\x07",
      "https://key.plrs.im/\u009b",
      "",
    ])
      expect(safeLink(bad), bad).toBeNull();
    expect(osc8("http://evil.example/", "text")).toBe("text");
  });

  it("draws an unsafe manage URL as text without a link", async () => {
    const r = await render({ variant: VARIANTS[0]!, piped: `${KEY}\n` }, (h) =>
      activateFlow(
        h.ctx,
        stubClient({
          license: {
            activateWithKey: async () => ({
              kind: "device-limit",
              code: "device_limit",
              limit: 3,
              deviceCount: 3,
              manageUrl: "http://evil.example/free",
            }),
          },
        }),
      ),
    );
    expect(r.raw).toContain("evil.example/free");
    expect(r.raw).not.toContain("\x1b]8;;http://evil");
  });
});

describe("TERM=dumb: plain lines, no cursor control (SIGN-IN.md D-77)", () => {
  async function dumb(
    run: (h: Parameters<Parameters<typeof render>[1]>[0]) => Promise<unknown>,
    interactive = false,
  ) {
    const screen = new Screen({ tty: true });
    const stdin = new FakeStdin(interactive);
    if (!interactive) stdin.end();
    const { createKitContext } = await import("../../src/cli/context.js");
    const ctx = await createKitContext({
      slug: "tidewater",
      bin: "tidewater",
      io: {
        stdout: screen,
        stderr: screen,
        stdin,
        env: { TERM: "dumb", DISPLAY: ":0" },
        platform: "linux",
        ticker: frozenTicker,
        now: () => NOW,
        openUrl: () => false,
      },
      presentation: {
        presentation: () => ({ name: "Tidewater Studio", accent: "#369186" }),
      },
      bundle: {},
    });
    try {
      await run({ ctx, screen, stdin, snap: () => undefined, opened: [] });
    } finally {
      ctx.close();
    }
    return screen.raw;
  }

  it("prints the headless code view as plain lines", async () => {
    const raw = await dumb(({ ctx }) =>
      loginFlow(ctx, stubClient(), { deviceCode: true }),
    );
    expect(raw).toContain("WDJB-MJHT");
    expect(raw).toContain("key.plrs.im/device");
    expect(raw).not.toMatch(/\x1b/);
  });

  it("asks for the key without echoing a character of it, and without cursor control", async () => {
    const raw = await dumb(async (h) => {
      const done = activateFlow(h.ctx, stubClient());
      await settle();
      h.stdin.type(KEY);
      h.stdin.press("return", { sequence: "\r" });
      await done;
    }, true);
    expect(raw).toContain("License key:");
    expect(raw).not.toContain(KEY_SECRET);
    expect(raw).not.toMatch(/\x1b/);
    expect(raw).toContain("Activated");
  });

  it("asks the sign-out question as a plain line", async () => {
    const raw = await dumb(async (h) => {
      const { logoutFlow } = await import("../../src/cli/flows.js");
      const done = logoutFlow(h.ctx, stubClient());
      await settle();
      h.stdin.press("n");
      await done;
    }, true);
    expect(raw).toContain("(y/N)");
    expect(raw).toContain("Nothing changed.");
    expect(raw).not.toMatch(/\x1b/);
  });
});

describe("--json: the last line of every run is the result", () => {
  const io = (screen: Screen) => ({
    stdout: screen,
    stderr: new Screen(),
    env: {},
    ticker: frozenTicker,
    now: () => NOW,
  });
  const last = (screen: Screen) =>
    JSON.parse(screen.raw.trim().split("\n").at(-1)!) as Record<
      string,
      unknown
    >;

  it("after an unexpected exception (the client cannot be built)", async () => {
    const screen = new Screen();
    const status = CLI_VERBS.find((v) => v.path[0] === "status")!;
    const code = await runKitVerb(
      status,
      [],
      { json: true },
      async () =>
        Promise.reject(Object.assign(new Error("boom"), { code: "network" })),
      { slug: "tidewater", io: io(screen) },
    );
    expect(code).toBe(1);
    expect(last(screen)).toMatchObject({
      v: 1,
      command: "status",
      event: "result",
      ok: false,
      exit: 1,
      error: "network",
    });
  });

  it("after an argument error, through commander (a missing positional, an unknown option)", async () => {
    for (const argv of [
      ["config", "get", "--json"],
      ["status", "--bogus", "--json"],
    ]) {
      const screen = new Screen();
      const program = new Command();
      program.exitOverride();
      let exit = -1;
      registerPolarisCommands(program, async () => stubClient(), {
        pinnedKeys: {},
        productSlug: "tidewater",
        io: io(screen),
        setExitCode: (c) => (exit = c),
      });
      await program.parseAsync(argv, { from: "user" });
      expect(exit, argv.join(" ")).toBe(2);
      expect(last(screen)).toMatchObject({
        v: 1,
        event: "result",
        ok: false,
        exit: 2,
        error: "usage",
      });
    }
  });

  it("after an argument error, through yargs", async () => {
    const screen = new Screen();
    const y = yargs([]).exitProcess(false);
    let exit = -1;
    registerYargsCommands(y, async () => stubClient(), {
      pinnedKeys: {},
      productSlug: "tidewater",
      io: io(screen),
      setExitCode: (c) => (exit = c),
    });
    await y.parseAsync(["polaris-key", "config", "get", "--json"]);
    expect(exit).toBe(2);
    expect(last(screen)).toMatchObject({
      v: 1,
      command: "config get",
      event: "result",
      ok: false,
      exit: 2,
      error: "usage",
    });
  });

  it("after progress lines (update apply)", async () => {
    const screen = new Screen();
    const apply = CLI_VERBS.find((v) => v.path.join(" ") === "update apply")!;
    await runKitVerb(
      apply,
      [],
      { json: true },
      async () =>
        stubClient({
          update: {
            decide: async () => ({
              decision: {
                action: "binary",
                method: "full",
                release: { version: "2.5.0", seq: 7 },
                build: "b",
                mandatory: false,
                critical: false,
                prestage: [],
                discardStaged: false,
              },
            }),
            install: async (
              _d: unknown,
              o: { onProgress(done: number, total: number): void },
            ) => {
              o.onProgress(30, 100);
              o.onProgress(30, 100);
              o.onProgress(100, 100);
              return { kind: "restartRequired", version: "2.5.0" };
            },
          },
        }),
      { slug: "tidewater", io: io(screen) },
    );
    const lines = screen.raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; percent?: number });
    expect(lines.map((l) => l.event)).toEqual([
      "progress",
      "progress",
      "result",
    ]);
    expect(lines.map((l) => l.percent).slice(0, 2)).toEqual([30, 100]);
  });
});

describe("opening the browser", () => {
  it("uses rundll32 on Windows, the URL as one argument (a & never reaches cmd.exe)", async () => {
    const { openInBrowser } = await import("../../src/identity/client.js");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fake = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {
        once: (event: string, fn: () => void) => {
          if (event === "spawn") queueMicrotask(fn);
        },
        unref: () => undefined,
      };
    };
    const url = "https://key.plrs.im/device?code=WDJB-MJHT&next=a|b^c";
    expect(await openInBrowser(url, "win32", fake)).toBe(true);
    expect(calls).toEqual([
      { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] },
    ]);
    calls.length = 0;
    await openInBrowser(url, "darwin", fake);
    await openInBrowser(url, "linux", fake);
    expect(calls.map((c) => c.cmd)).toEqual(["open", "xdg-open"]);
    calls.length = 0;
    for (const bad of [
      "file:///etc/passwd",
      "https://key.plrs.im/a b",
      "https://key.plrs.im/\x1b]52;c;x\x07",
    ])
      expect(await openInBrowser(bad, "win32", fake)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("hands the opener only a safe link", async () => {
    const opened: string[] = [];
    const { createKitContext } = await import("../../src/cli/context.js");
    const ctx = await createKitContext({
      slug: "tidewater",
      io: {
        stdout: new Screen({ tty: false }),
        env: {},
        openUrl: (u) => {
          opened.push(u);
          return true;
        },
      },
      bundle: {},
    });
    expect(await ctx.openUrl("https://key.plrs.im/device?code=X")).toBe(true);
    expect(await ctx.openUrl("http://evil.example/")).toBe(false);
    expect(await ctx.openUrl("https://key.plrs.im/\x07")).toBe(false);
    expect(opened).toEqual(["https://key.plrs.im/device?code=X"]);
  });
});
