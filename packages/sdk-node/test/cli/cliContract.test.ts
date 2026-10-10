// @pkey-feature ui.cli.contract
// The Node terminal kit against the `cli` family of conformance/corpus/v2/ui-matrix.json
// (plans/UK-51.md): every row of its `exit`, `capabilities`, `stdin` and `outcomes` sections. The
// `mount`, `help` and `gate` rows are the adapters' (UK-46 runs them when it mounts the verbs into
// a host CLI and gates its commands). A row the kit fails is a bug against the row or the kit,
// never a reason to skip it (AGENTS.md rule 1).

import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { UI_MATRIX_VERSION } from "../../src/constants.generated.js";
import { runKitVerb } from "../../src/cli/adapter.js";
import { createKitContext } from "../../src/cli/context.js";
import { activateFlow } from "../../src/cli/flows.js";
import { envelope, EXIT, type FlowResult } from "../../src/cli/json.js";
import { CLI_VERBS, type CliVerb } from "../../src/cli/kit.js";
import { detectTerminal } from "../../src/cli/term/caps.js";
import { TERMINAL_SYMBOLS } from "../../src/cli/tokens.generated.js";
import { KIT_COPY } from "../../src/kitCopy.generated.js";
import type { PolarisKeyClient } from "../../src/client.js";
import {
  FakeStdin,
  frozenTicker,
  KEY,
  NOW,
  settle,
  stubClient,
} from "./harness.js";
import { Screen } from "./screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(
  readFileSync(
    join(HERE, "../../../../conformance/corpus/v2", "ui-matrix.json"),
    "utf8",
  ),
) as { uiMatrixVersion: number; cli: Cli };

interface Row<I, E> {
  name: string;
  input: I;
  expect: E;
}
interface Cli {
  exit: Record<string, number>;
  capabilities: Row<
    {
      env: Record<string, string>;
      stdout: "tty" | "pipe";
      stdin: "tty" | "pipe";
      flags: { color?: boolean; ascii?: boolean; json?: boolean };
    },
    Record<string, unknown>
  >[];
  stdin: Row<
    { stdin: string; lines: string[] | null },
    {
      read: "prompt" | "key" | "none";
      key?: string;
      exit?: number;
      error?: string;
      copy?: string[];
      withinMs?: number;
    }
  >[];
  outcomes: Row<
    { verb: string; situation: string; json: boolean },
    {
      exit: number;
      mark?: "ok" | "fail" | "warn";
      error?: string | null;
      code?: string;
      stdout?: "empty" | "screen" | "result";
      fix?: string[];
    }
  >[];
}
const CLI = MATRIX.cli;
const EN = KIT_COPY.en as Record<string, string>;
const glyph = (mark: "ok" | "fail" | "warn") => TERMINAL_SYMBOLS.unicode[mark];
const plain = (t: string) =>
  t
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");

/** The terminal of every row: TTY streams at 80 columns, Unicode, no colour (the marks read as
 *  glyphs), a pinned clock and a browser opener that succeeds. */
function terminalIO(o: {
  interactive?: boolean;
  piped?: string;
  env?: Record<string, string>;
}) {
  const stdout = new Screen({ tty: true, columns: 80, rows: 30 });
  const stderr = new Screen({ tty: true, columns: 80 });
  const stdin = new FakeStdin(o.interactive === true);
  if (!o.interactive) {
    if (o.piped !== undefined) stdin.end(o.piped);
    else stdin.end();
  }
  const io = {
    stdout,
    stderr,
    stdin,
    env: {
      TERM: "xterm-256color",
      NO_COLOR: "1",
      PKEY_THEME: "dark",
      DISPLAY: ":0",
      ...o.env,
    },
    platform: "linux" as const,
    ticker: frozenTicker,
    now: () => NOW,
    openUrl: () => true,
  };
  return { io, stdout, stderr, stdin };
}

describe("ui-matrix.json cli: the version and the exit table", () => {
  it("is the version this SDK's constants carry", () => {
    expect(MATRIX.uiMatrixVersion).toBe(UI_MATRIX_VERSION);
  });

  it("is EXIT, with a refused gate at 4", () => {
    expect({ ...EXIT }).toEqual(CLI.exit);
    expect(EXIT.licenseRequired).toBe(4);
  });
});

describe("ui-matrix.json cli: capabilities", () => {
  it.each(CLI.capabilities.map((r) => [r.name, r] as const))("%s", (_n, r) => {
    const caps = detectTerminal({
      env: r.input.env,
      stdout:
        r.input.stdout === "tty"
          ? { isTTY: true, columns: 100, rows: 30, write: () => true }
          : { isTTY: false, write: () => true },
      stdin: { isTTY: r.input.stdin === "tty" },
      flags: r.input.flags,
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

// ── stdin ────────────────────────────────────────────────────────────────────────────────────

const TSX = join(HERE, "../../../../node_modules/.bin/tsx");
const FLOW = join(HERE, "stdin-flow.ts");

interface Ran {
  code: number | null;
  exit: number;
  error: string;
  got: string;
  ms: number;
  wallMs: number;
  out: string;
  killed: boolean;
}

/** Run stdin-flow.ts with `stdin` (a descriptor, or "pipe": a socket in Node) as its stdin.
 *  `feed` writes the row's lines; the writer stays open until the process has exited. */
function runFlow(
  stdin: number | "pipe",
  expectKey: string,
  feed: (child: ReturnType<typeof spawn>) => void = () => undefined,
): Promise<Ran> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(TSX, [FLOW], {
      stdio: [stdin, "pipe", "pipe"],
      env: { ...process.env, PKEY_EXPECT_KEY: expectKey },
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    let killed = false;
    const guard = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 15_000);
    feed(child);
    child.on("close", (code) => {
      clearTimeout(guard);
      child.stdin?.destroy();
      const m = /RESULT (\d+) (\S+) (\S+) (\S+) (\d+)/.exec(out);
      resolve({
        code,
        exit: m ? Number(m[1]) : -1,
        error: m?.[3] ?? "",
        got: m?.[4] ?? "",
        ms: m ? Number(m[5]) : -1,
        wallMs: Date.now() - t0,
        out: plain(out),
        killed,
      });
    });
  });
}

const text = (lines: readonly string[]) => lines.map((l) => `${l}\n`).join("");

/** One stdin row in a real process, on the descriptor kind it names. */
async function runStdinRow(r: Cli["stdin"][number]): Promise<Ran> {
  const lines = r.input.lines;
  const expectKey = r.expect.key ?? "";
  switch (r.input.stdin) {
    case "file": {
      const dir = mkdtempSync(join(tmpdir(), "uk51-"));
      const file = join(dir, "key");
      writeFileSync(file, text(lines ?? []));
      const fd = openSync(file, "r");
      try {
        return await runFlow(fd, expectKey);
      } finally {
        closeSync(fd);
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "fifo": {
      // A FIFO whose writer this test holds open: the read end opens without blocking, then the
      // write end (a reader exists), and the lines go in; the writer closes after the run.
      const dir = mkdtempSync(join(tmpdir(), "uk51-"));
      const fifo = join(dir, "stdin");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const rd = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const wr = openSync(fifo, fsConstants.O_WRONLY);
      try {
        if (lines !== null) writeSync(wr, text(lines));
        return await runFlow(rd, expectKey);
      } finally {
        closeSync(wr);
        closeSync(rd);
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "socket":
      // Node gives a child's "pipe" stdio a socketpair: what a Node parent's pipe is.
      return runFlow("pipe", expectKey, (child) => {
        if (lines !== null) child.stdin!.write(text(lines));
      });
    case "char-device": {
      const fd = openSync("/dev/null", "r");
      try {
        return await runFlow(fd, expectKey);
      } finally {
        closeSync(fd);
      }
    }
    default:
      throw new Error(`no real-process run for stdin ${r.input.stdin}`);
  }
}

describe("ui-matrix.json cli: stdin", () => {
  const inProcess = (kind: string) =>
    kind === "tty" || kind === "tty-noninteractive";

  it.each(
    CLI.stdin
      .filter((r) => inProcess(r.input.stdin))
      .map((r) => [r.name, r] as const),
  )("%s", async (_n, r) => {
    const t = terminalIO({
      interactive: true,
      env: r.input.stdin === "tty-noninteractive" ? { CI: "true" } : {},
    });
    const ctx = await createKitContext({
      slug: "tidewater",
      bin: "tidewater",
      io: t.io,
      presentation: null,
      queryScheme: false,
    });
    let asked = "";
    try {
      const done = activateFlow(ctx, stubClient());
      await settle();
      asked = plain(t.stdout.text());
      if (r.expect.read === "prompt") t.stdin.press("escape");
      const result = await done;
      if (r.expect.read === "prompt") {
        // The masked entry asked for the key; Esc left it with nothing changed.
        expect(asked).toContain(EN["part.keyField.label"]);
        expect(result.state).toBe("cancelled");
      } else {
        expect(result.exitCode).toBe(r.expect.exit);
        expect(result.error?.code).toBe(r.expect.error);
        for (const k of r.expect.copy ?? [])
          expect(plain(t.stdout.text())).toContain(
            EN[k]!.replace("{command}", "tidewater activate"),
          );
      }
    } finally {
      ctx.close();
    }
  });

  it.each(
    CLI.stdin
      .filter((r) => !inProcess(r.input.stdin))
      .map((r) => [r.name, r] as const),
  )(
    "%s",
    async (_n, r) => {
      const ran = await runStdinRow(r);
      expect(ran.killed, "the process ended by itself").toBe(false);
      if (r.expect.read === "key") {
        expect(ran.got).toBe("key");
        expect(ran.code).toBe(EXIT.ok);
        // The line was read without waiting for the writer to close.
        expect(ran.wallMs).toBeLessThan(10_000);
      } else {
        expect(ran.got).toBe("none");
        expect(ran.code).toBe(r.expect.exit);
        expect(ran.exit).toBe(r.expect.exit);
        expect(ran.error).toBe(r.expect.error);
        for (const k of r.expect.copy ?? []) expect(ran.out).toContain(EN[k]);
        if (r.expect.withinMs !== undefined)
          expect(ran.ms).toBeLessThan(r.expect.withinMs + 1_000);
      }
    },
    30_000,
  );
});

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────

interface Setup {
  args?: unknown[];
  client?: PolarisKeyClient;
  interactive?: boolean;
  piped?: string;
  usage?: boolean;
  /** Keys pressed once the flow waits. */
  drive?: (stdin: FakeStdin) => void;
}

const offline = () => Object.assign(new Error("offline"), { code: "network" });
const refuse = (r: unknown) =>
  stubClient({ license: { activateWithKey: async () => r } });

/** The stub client and the input of each situation (vocabulary.cli.situations). */
const SITUATIONS: Record<string, () => Setup> = {
  "status-revoked": () => ({
    client: stubClient({ status: () => ({ status: "revoked" }) }),
  }),
  "status-expired": () => ({
    client: stubClient({ status: () => ({ status: "expired" }) }),
  }),
  "status-version-too-old": () => ({
    client: stubClient({ status: () => ({ status: "version-too-old" }) }),
  }),
  "status-version-too-new": () => ({
    client: stubClient({ status: () => ({ status: "version-too-new" }) }),
  }),
  network: () => ({
    client: stubClient({
      listDevices: async () => {
        throw offline();
      },
    }),
  }),
  "key-refused": () => ({
    piped: `${KEY}\n`,
    client: refuse({ kind: "unauthorized", code: "unauthorized" }),
  }),
  "device-limit": () => ({
    piped: `${KEY}\n`,
    client: refuse({
      kind: "device-limit",
      code: "device_limit",
      limit: 3,
      deviceCount: 3,
      manageUrl: "https://key.plrs.im/portal/tidewater/devices",
    }),
  }),
  "secret-hidden": () => ({
    args: ["api_key"],
    client: stubClient({ config: { getSecret: () => "s3cr3t" } }),
  }),
  "mint-hidden": () => ({
    args: ["cdn"],
    client: stubClient({
      config: { mintToken: async () => ({ token: "tok_live", expiresAt: 1 }) },
    }),
  }),
  usage: () => ({ usage: true }),
  interrupt: () => ({
    interactive: true,
    drive: (s) => s.press("c", { ctrl: true, sequence: "\x03" }),
  }),
  "sign-in-cancelled": () => ({
    interactive: true,
    client: stubClient({
      identity: {
        waitForSignIn: (_p: unknown, o: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            o.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      },
    }),
    drive: (s) => s.press("escape"),
  }),
};

const verbOf = (id: string): CliVerb => {
  const v = CLI_VERBS.find((x) => x.path.join(" ") === id);
  if (!v) throw new Error(`no kit verb ${id}`);
  return v;
};

/** The verb ids of the command rows drawn (`tidewater <verb>`, then the description). */
function fixVerbs(screen: string): string[] {
  const ids = CLI_VERBS.map((v) => v.path.join(" ")).sort(
    (a, b) => b.length - a.length,
  );
  const found = new Set<string>();
  for (const line of screen.split("\n")) {
    const m = /tidewater ([a-z-]+(?: [a-z-]+)?)(?:\s{2,}|$)/.exec(line);
    if (!m) continue;
    const id = ids.find((v) => m[1] === v || m[1]!.startsWith(`${v} `));
    if (id) found.add(id);
  }
  return [...found].sort();
}

describe("ui-matrix.json cli: outcomes", () => {
  it.each(CLI.outcomes.map((r) => [r.name, r] as const))(
    "%s",
    async (_n, r) => {
      const setup = SITUATIONS[r.input.situation];
      expect(setup, `a setup for ${r.input.situation}`).toBeDefined();
      const s = setup!();
      const verb = verbOf(r.input.verb);
      const t = terminalIO({
        ...(s.interactive ? { interactive: true } : {}),
        ...(s.piped !== undefined ? { piped: s.piped } : {}),
      });
      let result: FlowResult | null = null;
      // The real adapter path, with the flow's result kept for the fields a row pins.
      const kept: CliVerb = {
        ...verb,
        flow: async (...a) => (result = await verb.flow(...a)),
      };
      const run = runKitVerb(
        kept,
        s.args ?? [],
        { ...(r.input.json ? { json: true } : {}) },
        async () => s.client ?? stubClient(),
        {
          slug: "tidewater",
          bin: "tidewater",
          io: t.io,
          ...(s.usage ? { usage: true } : {}),
        },
      );
      if (s.drive) {
        await settle();
        s.drive(t.stdin);
      }
      const exit = await run;
      const e = r.expect;
      expect(exit).toBe(e.exit);
      const stdout = t.stdout.text();
      const shown = plain(`${stdout}\n${t.stderr.text()}`);
      if (e.mark) {
        expect(shown).toContain(glyph(e.mark));
        if (e.mark === "warn") expect(shown).not.toContain(glyph("fail"));
        if (e.mark === "fail") expect(shown).not.toContain(glyph("warn"));
      }
      // The result's fields: the --json run's result line, or the flow's own result.
      const lines = t.stdout.raw.split("\n").filter((l) => l.trim() !== "");
      const fields: Record<string, unknown> = r.input.json
        ? (JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>)
        : result
          ? (envelope(r.input.verb, result) as Record<string, unknown>)
          : {};
      if (e.error !== undefined) expect(fields.error ?? null).toBe(e.error);
      if (e.code !== undefined) expect(fields.code).toBe(e.code);
      if (e.stdout === "empty") expect(t.stdout.raw).toBe("");
      if (e.stdout === "screen") expect(plain(stdout).trim()).not.toBe("");
      if (e.stdout === "result") {
        for (const l of lines) expect(JSON.parse(l)).toMatchObject({ v: 1 });
        expect(fields).toMatchObject({
          event: "result",
          exit: e.exit,
          ok: e.exit === 0,
        });
      }
      if (e.fix) expect(fixVerbs(plain(stdout))).toEqual([...e.fix].sort());
    },
  );
});
