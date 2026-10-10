// @pkey-feature ui.cli
// The Node terminal kit's 0.8.x fixes (UK-45): what a real client's status and roster read as, the
// key-held login question, discovery before a capability is decided, the update apply next steps,
// the terminal capability table, a bounded piped key, and the catalog-only strings.

import { closeSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateFlow,
  changelogFlow,
  devicesListFlow,
  enrollFlow,
  ensureDiscovery,
  loginFlow,
  PIPED_KEY_WAIT_MS,
  statusFlow,
  updateApplyFlow,
} from "../../src/cli/flows.js";
import { createKitContext } from "../../src/cli/context.js";
import { statusView, tierName } from "../../src/cli/models.js";
import { detectTerminal } from "../../src/cli/term/caps.js";
import { KIT_COPY } from "../../src/kitCopy.generated.js";
import {
  FakeStdin,
  frozenTicker,
  KEY,
  KEY_SECRET,
  NOW,
  settle,
  stubClient,
  VARIANTS,
  render,
} from "./harness.js";
import { Screen } from "./screen.js";
import { Command } from "commander";
import yargs from "yargs";
import {
  registerPolarisCommands,
  registerYargsCommands,
} from "../../src/cli/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400;
const plain = (t: string) =>
  t
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");
const flat = (t: string) => plain(t).replace(/\s+[│└┌|`+]?\s*/g, " ");
const variant = VARIANTS.find((v) => v.id === "no-color-80")!;

describe("what a real client reports", () => {
  it("reads the roster's last seen in seconds for the other devices, whatever this device's own milliseconds say", async () => {
    const { text } = await render({ variant }, (h) =>
      devicesListFlow(
        h.ctx,
        stubClient({
          listDevices: async () => [
            // A real client's current device: ms `lastVerifiedAt`, and the roster's seconds.
            {
              id: "dev_a",
              current: true,
              status: "ok",
              label: "Work laptop",
              platform: "macos",
              arch: "arm64",
              lastVerifiedAt: NOW - 3 * DAY * 1000,
              lastSeen: NOW / 1000 - 2 * DAY,
            },
            // Another device: only the roster knows when it was seen.
            {
              id: "dev_b",
              current: false,
              status: "ok",
              label: "Mara's iPad",
              platform: "ios",
              lastSeen: NOW / 1000 - 5 * DAY,
            },
            // Nothing known: no time at all, never a huge number of days.
            { id: "dev_c", current: false, status: "ok", label: "Desk" },
          ],
        }),
      ),
    );
    const t = plain(text);
    expect(t).toContain("macOS arm64 · dev_a");
    expect(t).not.toContain("2 days ago");
    expect(t).toContain("iOS · last seen 5 days ago");
    expect(t).not.toMatch(/\d{3},\d{3}/);
    expect(t).not.toContain("macos");
  });

  it("leaves out last seen for this device, a zero and a time ahead; dates an old one; names no raw platform", async () => {
    const { text } = await render({ variant }, (h) =>
      devicesListFlow(
        h.ctx,
        stubClient({
          listDevices: async () => [
            {
              id: "dev_a",
              current: true,
              status: "ok",
              label: "Work laptop",
              platform: "linux",
              lastVerifiedAt: NOW - 3 * DAY * 1000,
              lastSeen: NOW / 1000 - 3 * DAY,
            },
            {
              id: "dev_z",
              current: false,
              status: "ok",
              label: "Zero",
              platform: "macos",
              lastSeen: 0,
            },
            {
              id: "dev_f",
              current: false,
              status: "ok",
              label: "Ahead",
              platform: "macos",
              lastSeen: NOW / 1000 + 2 * DAY,
            },
            {
              id: "dev_o",
              current: false,
              status: "ok",
              label: "Old",
              platform: "macos",
              lastSeen: NOW / 1000 - 400 * DAY,
            },
            {
              id: "dev_b",
              current: false,
              status: "ok",
              label: "Bsd",
              platform: "freebsd",
              arch: "x64",
            },
          ],
        }),
      ),
    );
    const t = plain(text);
    // This device: "This computer", no time; a zero: no time at all.
    expect(t).toMatch(/Linux · dev_a · This computer/);
    expect(t).not.toMatch(/20,\d{3}|days ago.*Zero/);
    expect(t).toMatch(/macOS · dev_z\b/);
    expect(t).toContain("macOS · last seen today · dev_f");
    expect(t).toMatch(/macOS · last seen Aug 2025 · dev_o/);
    // Not a raw id: the architecture alone.
    expect(t).toMatch(/\n.*x64 · dev_b/);
    expect(t).not.toContain("freebsd");
  });

  it("names the holder from a name or an email, an empty one counting as absent", () => {
    const view = (identity: unknown, profile: unknown, tier = "pro") =>
      statusView({
        status: "ok",
        info: { tier, profile } as never,
        identity: identity as never,
        now: 0,
      });
    const holder = (v: ReturnType<typeof view>) =>
      v.component === "AccountAndLicense" ? v.holder : "n/a";
    expect(holder(view({ name: "", email: "" }, { name: "", email: "" }))).toBe(
      null,
    );
    expect(holder(view({ name: "Mara", email: "" }, null))).toBe("Mara");
    expect(holder(view({ email: "m@x.co" }, null))).toBe("m@x.co");
    // A key only device shows no holder: that email is the purchaser's, not a signed-in account.
    expect(holder(view(null, { name: "Mara", email: "" }))).toBe(null);
    // Signed in comes from the account on the device, never from the license profile.
    expect(view(null, { name: "Mara", email: "m@x.co" }).state).toBe(
      "key-only",
    );
    expect(view({ name: "", email: "" }, null).state).toBe("signed-in");
    expect(tierName({ tier: "pro" })).toBe("Pro");
    expect(tierName({ tier: "pro", tierLabel: "Studio" })).toBe("Studio");
    expect(tierName({ tier: "", tierLabel: "" })).toBe(null);
  });

  it("status with an empty-email profile never ends in a dangling separator", async () => {
    const { text } = await render({ variant }, (h) =>
      statusFlow(
        h.ctx,
        stubClient({
          licenseInfo: {
            licenseId: "l",
            tier: "pro",
            tierLabel: "",
            deviceLimit: 3,
            profile: { name: "", email: "" },
            entitledChannels: [],
            status: "ok",
          },
          identity: { current: async () => null },
        }),
      ),
    );
    expect(plain(text)).toMatch(/License\s+Pro · Activated with a license key/);
    expect(plain(text)).not.toMatch(/·\s*$/m);
  });
});

describe("login on a device that holds a key license", () => {
  /** A login whose wait asks `confirm` the way the SDK does, with `attachable`. */
  async function login(
    answer: (stdin: FakeStdin) => void,
    opts: { attachable?: boolean; interactive?: boolean; json?: boolean } = {},
  ) {
    const asked: Array<[unknown, boolean]> = [];
    let attached: boolean | null = null;
    let question = "";
    const { text } = await render(
      {
        variant,
        interactive: opts.interactive ?? true,
        ...(opts.json ? { json: true } : {}),
      },
      async (h) => {
        const done = loginFlow(
          h.ctx,
          stubClient({
            identity: {
              waitForSignIn: async (
                _p: unknown,
                o: {
                  confirm?: (w: unknown, a: boolean) => Promise<boolean>;
                },
              ) => {
                const who = { name: "Mara Fennick", email: "m@fennick.studio" };
                asked.push([who, opts.attachable ?? true]);
                attached = o.confirm
                  ? await o.confirm(who, opts.attachable ?? true)
                  : null;
                return {
                  status: "ready",
                  identity: who,
                  ...(attached ? { attached: "claimed" } : {}),
                };
              },
            },
          }),
        );
        await settle();
        question = h.screen.text();
        answer(h.stdin);
        const r = await done;
        h.screen.write(`\nexit ${r.exitCode} ${JSON.stringify(r.result)}`);
      },
    );
    return { text, asked, attached, question };
  }

  it("asks, and Enter keeps the key license (the default is No)", async () => {
    const r = await login((stdin) => stdin.press("return"));
    expect(r.attached).toBe(false);
    expect(plain(r.text)).toContain("Signed in as Mara Fennick");
    expect(r.text).toContain('"attached":null');
  });

  it("shows the account as found, not as signed in, until the sign-in finishes", async () => {
    const r = await login((stdin) => stdin.press("return"));
    const q = plain(r.question);
    expect(q).toContain("Mara Fennick");
    expect(q).toContain("(y/N)");
    expect(q).not.toContain("✓");
    expect(q).not.toContain("Signed in");
    expect(q).toContain("Esc cancel sign-in");
    // Only the finished sign-in ticks, and a no leaves no "on your account" line.
    expect(plain(r.text)).toContain("✓  Signed in as");
    expect(plain(r.text)).not.toContain("now on your account");
  });

  it("says when the key license is on the account, so a yes and a no read differently", async () => {
    const yes = await login((s) => s.press("y"));
    expect(plain(yes.text)).toContain(
      "The license key is now on your account.",
    );
  });

  it("Esc at the question ends as a cancelled sign-in", async () => {
    const asked = await login((s) => s.press("escape"));
    expect(asked.attached).toBe(false);
    expect(plain(asked.text)).toContain("Sign-in cancelled");
    expect(plain(asked.text)).not.toContain("✓  Signed in");
  });

  it("n keeps it; y adds it to the account", async () => {
    expect((await login((s) => s.press("n"))).attached).toBe(false);
    const yes = await login((s) => s.press("y"));
    expect(yes.attached).toBe(true);
    expect(yes.text).toContain('"attached":"claimed"');
  });

  it("Esc ends the wait with the question open", async () => {
    const r = await login((s) => s.press("escape"));
    expect(r.attached).toBe(false);
  });

  it("asks nothing when there is no key license to add, or nobody to answer", async () => {
    const none = await login((s) => s.press("y"), { attachable: false });
    expect(none.attached).toBe(false);
    expect(none.text).not.toContain("license key on your account");
    // A pipe: no keys, so the default stands without a question.
    const piped = await login(() => undefined, { interactive: false });
    expect(piped.attached).toBe(false);
    expect(piped.text).not.toContain("(y/N)");
    const json = await login(() => undefined, {
      interactive: false,
      json: true,
    });
    expect(json.attached).toBe(false);
  });
});

describe("every flow ensures discovery before deciding a capability is off", () => {
  /** A client that believes only License and Config until it has discovered (a fresh install). */
  function undiscovered(over: Record<string, unknown> = {}) {
    const state = { discovered: 0 };
    const caps = () =>
      state.discovered
        ? {
            license: { enabled: true },
            config: { enabled: true },
            identity: { enabled: true },
            release: { enabled: true },
            update: { enabled: true },
            sync: { enabled: false },
          }
        : { license: { enabled: true }, config: { enabled: true } };
    const client = stubClient({
      capabilities: caps() as never,
      ...over,
      extra: {
        servicesPinned: false,
        discovery: () => (state.discovered ? {} : null),
        capabilities: caps,
        discover: async () => {
          state.discovered++;
          return { kind: "ok" };
        },
      },
    });
    return { client, state };
  }

  it("login works from the documented factory without a manual discover()", async () => {
    const { client, state } = undiscovered();
    const { text } = await render({ variant }, (h) => loginFlow(h.ctx, client));
    expect(state.discovered).toBe(1);
    expect(text).not.toContain("account sign-in");
    expect(plain(text)).toContain("Signed in as");
  });

  it("every flow that reads a capability discovers first", async () => {
    const flows: Array<
      [
        string,
        (
          h: Parameters<typeof render>[1] extends (h: infer H) => unknown
            ? H
            : never,
          c: ReturnType<typeof stubClient>,
        ) => Promise<unknown>,
      ]
    > = [
      ["status", (h, c) => statusFlow(h.ctx, c)],
      ["login", (h, c) => loginFlow(h.ctx, c)],
      ["enroll", (h, c) => enrollFlow(h.ctx, c)],
      ["changelog", (h, c) => changelogFlow(h.ctx, c)],
      ["devices", (h, c) => devicesListFlow(h.ctx, c)],
      ["update apply", (h, c) => updateApplyFlow(h.ctx, c)],
    ];
    for (const [name, run] of flows) {
      const { client, state } = undiscovered();
      await render({ variant }, (h) => run(h, client));
      expect(state.discovered, name).toBe(1);
    }
  });

  it("skips the round trip when discovery is loaded or the build pinned its services", async () => {
    let calls = 0;
    const base = { discover: async () => void calls++ };
    await ensureDiscovery({ ...base, servicesPinned: true } as never);
    await ensureDiscovery({
      ...base,
      servicesPinned: false,
      discovery: () => ({}),
    } as never);
    expect(calls).toBe(0);
    await ensureDiscovery({
      ...base,
      servicesPinned: false,
      discovery: () => null,
    } as never);
    expect(calls).toBe(1);
    // Offline: the flow goes on with what the client believes.
    await expect(
      ensureDiscovery({
        servicesPinned: false,
        discovery: () => null,
        discover: async () => {
          throw new Error("offline");
        },
      } as never),
    ).resolves.toBeUndefined();
  });
});

describe("update apply ends in an actionable line", () => {
  const binary = {
    action: "binary",
    method: "full",
    release: { version: "2.5.0", seq: 7 },
    build: "b",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  };
  const platform = {
    action: "platform",
    release: { version: "2.5.0", seq: 7 },
    mandatory: false,
    critical: false,
    discardStaged: false,
  };
  const apply = (update: Record<string, unknown>) =>
    render({ variant }, async (h) => {
      const r = await updateApplyFlow(h.ctx, stubClient({ update }));
      h.screen.write(`\nexit ${r.exitCode} ${r.state} ${r.error?.code ?? ""}`);
    });

  it.each([
    ["npm", "npm install -g tidewater-cli@latest"],
    ["pnpm", "pnpm add -g tidewater-cli@latest"],
    ["homebrew", "brew upgrade tidewater"],
    ["npx", "npx tidewater-cli@latest"],
  ])("%s names the command that upgrades it", async (subkind, command) => {
    const r = await apply({
      outlet: { id: subkind, kind: "direct", subkind },
      packageName: "tidewater-cli",
      decide: async () => ({ decision: platform }),
    });
    expect(flat(r.text)).toContain(command);
    expect(r.text).toContain("exit 0 platform");
  });

  it("names the program when the product set no package name", async () => {
    const r = await apply({
      detected: { kind: "direct", subkind: "npm" },
      decide: async () => ({ decision: platform }),
    });
    expect(flat(r.text)).toContain("npm install -g tidewater@latest");
  });

  it("an install with no driver gives the download link and exits non-zero", async () => {
    const r = await apply({
      driver: null,
      check: async () => ({
        updateAvailable: true,
        version: "2.5.0",
        url: "https://key.plrs.im/tidewater/download",
      }),
      decide: async () => ({ decision: binary }),
    });
    expect(flat(r.text)).toContain(
      "Download it here: key.plrs.im/tidewater/download",
    );
    expect(r.text).toContain("exit 1 blocked unsupported");
  });

  it("a build with no update feed names the command that still works", async () => {
    const r = await apply({ decidable: false });
    expect(flat(r.text)).toContain("Updates aren't set up");
    expect(flat(r.text)).toContain(
      "tidewater update check Check for a newer version",
    );
    expect(r.text).toContain("exit 1 not-configured not-configured");
  });

  it("a finished download verifies, then reads ready; never 100% or up to date", async () => {
    const frames: string[] = [];
    const { text } = await render(
      {
        variant: VARIANTS.find((v) => v.id === "truecolor-80-dark")!,
        interactive: true,
      },
      async (h) => {
        let release!: (v: unknown) => void;
        const gate = new Promise((r) => (release = r));
        const done = updateApplyFlow(
          h.ctx,
          stubClient({
            update: {
              decide: async () => ({ decision: binary }),
              install: async (
                _d: unknown,
                o: { onProgress(a: number, b: number): void },
              ) => {
                o.onProgress(30_000_000, 61_000_000);
                frames.push(h.screen.text());
                o.onProgress(61_000_000, 61_000_000);
                await settle();
                frames.push(h.screen.text());
                await gate;
                return { kind: "restartRequired", version: "2.5.0" };
              },
            },
          }),
        );
        await settle();
        release(undefined);
        await done;
      },
    );
    expect(plain(frames[0]!)).toContain("38 of 61 MB".replace("38", "30"));
    expect(plain(frames[1]!)).toContain("Verifying…");
    expect(plain(frames[1]!)).not.toContain("100%");
    expect(plain(frames[1]!)).not.toContain("Up to date");
    expect(flat(text)).toContain("2.5.0 is ready · Restart to finish");
  });
});

describe("the terminal capability table", () => {
  const tty = { isTTY: true, columns: 100, rows: 30, write: () => true };
  const pipe = { isTTY: false, write: () => true };
  const term = { TERM: "xterm-256color" };

  /** Environment × streams × flags → colour, unicode, interactive, animate, links (the
   *  cross-kit table; the Python kit must match each row). */
  const rows: Array<{
    name: string;
    env: Record<string, string>;
    out: typeof tty | typeof pipe;
    stdin?: boolean;
    flags?: { color?: boolean; ascii?: boolean; json?: boolean };
    expect: {
      color: string;
      unicode: boolean;
      interactive: boolean;
      animate: boolean;
      links: boolean;
    };
  }> = [
    {
      name: "a terminal",
      env: term,
      out: tty,
      stdin: true,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: true,
        animate: true,
        links: true,
      },
    },
    {
      name: "CI=true",
      env: { ...term, CI: "true" },
      out: tty,
      stdin: true,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: false,
        animate: false,
        links: false,
      },
    },
    {
      name: "CI=0 is not CI",
      env: { ...term, CI: "0" },
      out: tty,
      stdin: true,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: true,
        animate: true,
        links: true,
      },
    },
    {
      name: "CI=false is not CI",
      env: { ...term, CI: "false" },
      out: tty,
      stdin: true,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: true,
        animate: true,
        links: true,
      },
    },
    {
      name: "GITHUB_ACTIONS",
      env: { ...term, GITHUB_ACTIONS: "true" },
      out: tty,
      stdin: true,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: false,
        animate: false,
        links: false,
      },
    },
    {
      name: "BUILDKITE",
      env: { ...term, BUILDKITE: "true" },
      out: tty,
      stdin: true,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: false,
        animate: false,
        links: false,
      },
    },
    {
      name: "NO_COLOR keeps links on a terminal",
      env: { ...term, NO_COLOR: "1" },
      out: tty,
      stdin: true,
      expect: {
        color: "none",
        unicode: true,
        interactive: true,
        animate: true,
        links: true,
      },
    },
    {
      name: "--no-color",
      env: term,
      out: tty,
      stdin: true,
      flags: { color: false },
      expect: {
        color: "none",
        unicode: true,
        interactive: true,
        animate: true,
        links: true,
      },
    },
    {
      name: "a pipe",
      env: term,
      out: pipe,
      stdin: false,
      expect: {
        color: "none",
        unicode: true,
        interactive: false,
        animate: false,
        links: false,
      },
    },
    {
      name: "FORCE_COLOR on a pipe: colour, never links",
      env: { ...term, FORCE_COLOR: "1" },
      out: pipe,
      stdin: false,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: false,
        animate: false,
        links: false,
      },
    },
    {
      name: "animation follows stdout, not stdin",
      env: term,
      out: tty,
      stdin: false,
      expect: {
        color: "ansi16",
        unicode: true,
        interactive: false,
        animate: true,
        links: true,
      },
    },
    {
      name: "TERM=dumb",
      env: { TERM: "dumb" },
      out: tty,
      stdin: true,
      expect: {
        color: "none",
        unicode: false,
        interactive: false,
        animate: false,
        links: false,
      },
    },
    {
      name: "--ascii",
      env: term,
      out: tty,
      stdin: true,
      flags: { ascii: true },
      expect: {
        color: "ansi16",
        unicode: false,
        interactive: true,
        animate: true,
        links: true,
      },
    },
    {
      name: "--json",
      env: term,
      out: tty,
      stdin: true,
      flags: { json: true },
      expect: {
        color: "none",
        unicode: true,
        interactive: false,
        animate: false,
        links: false,
      },
    },
  ];

  it.each(rows)("$name", (r) => {
    const caps = detectTerminal({
      env: r.env,
      stdout: r.out,
      stdin: { isTTY: r.stdin ?? false },
      flags: r.flags ?? {},
      platform: "linux",
    });
    expect({
      color: caps.color,
      unicode: caps.unicode,
      interactive: caps.interactive,
      animate: caps.animate,
      links: caps.links,
    }).toEqual(r.expect);
  });
});

describe("OSC 11 is asked only when nothing has decided the theme", () => {
  /** A truecolor, interactive terminal; returns what was written to it. */
  async function written(env: Record<string, string>): Promise<string> {
    const out = new Screen({ tty: true, columns: 80 });
    const stdin = new FakeStdin(true);
    const ctx = await createKitContext({
      slug: "tidewater",
      io: {
        stdout: out,
        stderr: new Screen({ tty: true }),
        stdin,
        env: { TERM: "xterm-256color", COLORTERM: "truecolor", ...env },
        platform: "linux",
        now: () => NOW,
      },
      presentation: null,
    });
    ctx.close();
    return out.raw;
  }
  const asks = (raw: string) => raw.includes("\x1b]11;?");

  it("asks on a guess, and nowhere else", async () => {
    expect(asks(await written({}))).toBe(true);
    expect(asks(await written({ PKEY_THEME: "light" }))).toBe(false);
    expect(asks(await written({ COLORFGBG: "0;15" }))).toBe(false);
    expect(asks(await written({ NO_COLOR: "1" }))).toBe(false);
  });
});

describe("activate reads a piped key within a bound", () => {
  afterEach(() => vi.useRealTimers());

  /** A context whose stdin is `stdin` (not a terminal), and the flow's screen. */
  async function ctxWith(stdin: object) {
    const out = new Screen({ tty: true, columns: 80 });
    const ctx = await createKitContext({
      slug: "tidewater",
      bin: "tidewater",
      io: {
        stdout: out,
        stderr: new Screen({ tty: true }),
        stdin: stdin as never,
        env: { TERM: "xterm-256color", NO_COLOR: "1" },
        platform: "linux",
        ticker: frozenTicker,
        now: () => NOW,
      },
      presentation: null,
      queryScheme: false,
    });
    return { ctx, out };
  }

  it("an open, silent stdin ends in no key (exit 2) within the bound", async () => {
    vi.useFakeTimers();
    const { ctx, out } = await ctxWith(new FakeStdin(false)); // never written, never closed
    let result: { exitCode: number; state?: string } | null = null;
    const done = activateFlow(ctx, stubClient()).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(PIPED_KEY_WAIT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(result).toMatchObject({ exitCode: 2, state: "rejected" });
    expect(plain(out.text())).toContain("No license key");
  });

  it("echo key | activate still works, without waiting for the writer to close", async () => {
    const stdin = new FakeStdin(false);
    stdin.write(`${KEY}\n`); // the stream stays open
    const { ctx, out } = await ctxWith(stdin);
    const r = await activateFlow(ctx, stubClient());
    expect(r.exitCode).toBe(0);
    expect(plain(out.text())).not.toContain("No license key");
    expect(out.raw).not.toContain(KEY_SECRET);
  });

  it("stops at the first non-empty line", async () => {
    const stdin = new FakeStdin(false);
    stdin.write(`\n\n${KEY}\nsecond line\n`);
    const { ctx } = await ctxWith(stdin);
    const r = await activateFlow(ctx, stubClient());
    expect(r.exitCode).toBe(0);
  });

  it("does not read a device (a character device is neither a file nor a FIFO)", async () => {
    const fd = openSync("/dev/null", "r");
    try {
      const stdin = new FakeStdin(false) as FakeStdin & { fd?: number };
      stdin.fd = fd;
      stdin.write(`${KEY}\n`);
      const { ctx } = await ctxWith(stdin);
      const r = await activateFlow(ctx, stubClient());
      expect(r.exitCode).toBe(2);
    } finally {
      closeSync(fd);
    }
  });
});

describe("no kit string names Polaris Key where the product fits", () => {
  const SRC = join(HERE, "../../src/cli");
  /** Catalog keys the kit may show with the service's name: the footer line is the service's
   *  own credit, and a failure to reach it names what could not be reached. */
  const BRAND_ALLOWED = new Set(["part.poweredBy"]);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? sources(join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.includes(".generated")
          ? [join(dir, e.name)]
          : [],
    );
  }

  it("the catalog strings the kit uses", () => {
    const used = new Set<string>();
    for (const f of sources(SRC))
      for (const m of readFileSync(f, "utf8").matchAll(
        /["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+)["'`]/g,
      ))
        used.add(m[1]!);
    const en = KIT_COPY.en as Record<string, string>;
    const hits = [...used]
      .filter((k) => k in en && !BRAND_ALLOWED.has(k))
      .filter((k) => /Polaris Key/i.test(en[k]!));
    expect(hits).toEqual([]);
  });

  it("the string literals in the kit's source", () => {
    const hits: string[] = [];
    for (const f of sources(SRC))
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
          if (/(["'`])[^"'`\n]*Polaris Key[^"'`\n]*\1/.test(code))
            hits.push(`${f.replace(SRC, "src/cli")}:${i + 1}: ${line.trim()}`);
        });
    expect(hits).toEqual([]);
  });

  it("one spelling of license in the kit's strings", () => {
    const en = KIT_COPY.en as Record<string, string>;
    expect(
      Object.entries(en).filter(
        ([, v]) => /licen[cs]e/i.test(v) && /licence/i.test(v),
      ),
    ).toEqual([]);
    for (const f of sources(SRC))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/licence/i);
  });
});

describe("activate on a real process's stdin", () => {
  const tsx = join(HERE, "../../../../node_modules/.bin/tsx");
  const flow = join(HERE, "stdin-flow.ts");
  const key = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";

  interface Ran {
    code: number | null;
    out: string;
    ms: number;
    killed: boolean;
  }
  /** Run the program with `stdin` as its stdin; `feed` writes to it. Killed at 15 s. */
  function run(
    stdin: "pipe" | number,
    feed: (w: NodeJS.WritableStream | null) => void = () => undefined,
  ): Promise<Ran> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(tsx, [flow], { stdio: [stdin, "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (d) => (out += d));
      let killed = false;
      const guard = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, 15_000);
      feed(child.stdin);
      child.on("close", (code) => {
        clearTimeout(guard);
        resolve({ code, out, ms: Date.now() - t0, killed });
      });
    });
  }

  it.skipIf(!existsSync(tsx))(
    "an open, silent pipe ends in no key (exit 2) and the process exits by itself",
    async () => {
      // The writer holds its end open and never writes: only the bound can end the wait.
      const r = await run("pipe");
      expect(r.killed).toBe(false);
      expect(r.code).toBe(2);
      expect(r.out).toContain("No license key arrived on stdin");
    },
    30_000,
  );

  it.skipIf(!existsSync(tsx))(
    "a key written by a Node parent (a socket) is read, without the writer closing",
    async () => {
      const r = await run("pipe", (w) => w!.write(`${key}\n`));
      expect(r.killed).toBe(false);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("7Q2Mx9cLr4TbV0aZ3WPLDA");
    },
    30_000,
  );

  it.skipIf(!existsSync(tsx))(
    "a key on a file, and on a shell pipe, is read",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "uk45-"));
      const file = join(dir, "key");
      writeFileSync(file, `${key}\n`);
      const viaFile = spawnSync(tsx, [flow], {
        input: undefined,
        stdio: [openSync(file, "r"), "pipe", "pipe"],
        encoding: "utf8",
      });
      expect(viaFile.status).toBe(0);
      const viaShell = spawnSync(
        "sh",
        ["-c", `printf '%s\\n' '${key}' | '${tsx}' '${flow}'`],
        { encoding: "utf8" },
      );
      expect(viaShell.status).toBe(0);
    },
    30_000,
  );
});

describe("the pre-kit output (kit: false) prints a value only with --reveal", () => {
  const factory = async () =>
    stubClient({
      config: {
        getSecret: () => "s3cr3t",
        mintToken: async () => ({ token: "tok_live", expiresAt: 1 }),
      },
    });
  const options = (lines: string[], codes: number[]) => ({
    pinnedKeys: {},
    productSlug: "tidewater",
    kit: false,
    print: (l: string) => lines.push(l),
    setExitCode: (c: number) => codes.push(c),
  });

  it.each([
    [
      "commander",
      ["secret", "api.key"],
      ["secret", "api.key", "--reveal"],
      "s3cr3t",
    ],
    ["commander", ["mint", "cdn"], ["mint", "cdn", "--reveal"], "tok_live"],
    [
      "yargs",
      ["secret", "api.key"],
      ["secret", "api.key", "--reveal"],
      "s3cr3t",
    ],
    ["yargs", ["mint", "cdn"], ["mint", "cdn", "--reveal"], "tok_live"],
  ])("%s %j", async (front, hidden, revealed, value) => {
    const run = async (argv: string[]) => {
      const lines: string[] = [];
      const codes: number[] = [];
      if (front === "commander") {
        const program = new Command();
        program.exitOverride();
        registerPolarisCommands(program, factory, options(lines, codes));
        await program.parseAsync(argv, { from: "user" });
      } else {
        const y = yargs([]).exitProcess(false);
        registerYargsCommands(y, factory, options(lines, codes));
        await y.parseAsync(["polaris-key", ...argv]);
      }
      return { out: lines.join("\n"), codes };
    };
    const without = await run(hidden);
    expect(without.out).not.toContain(value);
    expect(without.out).toContain("--reveal");
    expect(without.codes).toEqual([1]);
    const withFlag = await run(revealed);
    expect(withFlag.out).toBe(value);
  });
});
