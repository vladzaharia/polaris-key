// @pkey-feature ui.cli.contract
// @pkey-feature ui.cli.mount
// The mount, help and gate rows of the `cli` family in conformance/corpus/v2/ui-matrix.json
// (plans/UK-51.md), run against the commander adapter, `requireLicense` and the yargs adapter's
// mount: what registering the kit into a host CLI adds, the error and the skip when a host command
// collides, the help page's order, and what a gated host command does for every license status,
// terminal and entitlement. A row the adapter fails is a bug against the row or the adapter, never
// a reason to skip it (AGENTS.md rule 1).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import yargs from "yargs";
import { describe, expect, it } from "vitest";
import { requireLicense } from "../../src/cli/gate.js";
import { EXIT } from "../../src/cli/json.js";
import { CLI_VERBS } from "../../src/cli/kit.js";
import { VerbCollisionError, verbId } from "../../src/cli/mount.js";
import { TERMINAL_SYMBOLS } from "../../src/cli/tokens.generated.js";
import { registerPolarisCommands as registerYargs } from "../../src/cli/yargs.js";
import { registerPolarisCommands } from "../../src/cli/commander.js";
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
interface MountOptions {
  namespace?: string;
  verbs?: string[];
  onCollision?: "error" | "skip";
  config?: boolean;
}
interface MountExpect {
  mounted: string[];
  error: null | { code: string; words: string[]; fixes: string[] };
  skipped: string[];
  hidden: string[];
}
interface GateExpect {
  outcome: "run" | "flow" | "refuse" | "fail";
  mark?: string;
  exit?: number;
  error?: string;
  copy?: string[];
  fix?: string[];
  link?: "portal" | "contact";
  stream?: "stderr" | "stdout";
  result?: Record<string, unknown>;
}
const MATRIX = JSON.parse(
  readFileSync(
    join(HERE, "../../../../conformance/corpus/v2", "ui-matrix.json"),
    "utf8",
  ),
) as {
  cli: {
    mount: {
      name: string;
      input: { host: string[]; options: MountOptions };
      expect: MountExpect;
    }[];
    help: {
      name: string;
      input: {
        host: { heading: string; commands: string[] }[];
        options: MountOptions;
      };
      expect: {
        sections: { heading?: string; copy?: string; commands: string[] }[];
      };
    }[];
    gate: {
      name: string;
      input: {
        status: string;
        tty: boolean;
        json: boolean;
        entitled: boolean;
        command: string;
        mounted?: string[];
        portal?: false;
        check?: "throws" | "unknown-status";
      };
      expect: GateExpect;
    }[];
  };
};
const EN = KIT_COPY.en as Record<string, string>;
const plain = (t: string) =>
  t
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");

const CONFIG = {
  productSlug: "tidewater",
  baseUrl: "https://key.plrs.im",
  trust: { pinnedKeys: { k1: "A".repeat(43) } },
};

/** Every kit command as typed, below `program` (the namespace first). */
function typed(program: Command, host: ReadonlySet<string>): string[] {
  const walk = (c: Command, prefix: string[]): string[] =>
    c.commands.length
      ? c.commands.flatMap((s) => walk(s, [...prefix, s.name()]))
      : [prefix.join(" ")];
  return program.commands
    .filter((c) => !host.has(c.name()))
    .flatMap((c) => walk(c, [c.name()]))
    .sort();
}

function hostProgram(host: string[], helpGroups?: Map<string, string>) {
  const program = new Command("mytool");
  program.exitOverride();
  // The options a config replaces, declared by a host that had them before it had a config.
  program
    .option("--product <slug>")
    .option("--trust <keys>")
    .option("--base-url <url>");
  for (const w of host) {
    const c = program
      .command(w)
      .description(`Run ${w}`)
      .action(() => undefined);
    const g = helpGroups?.get(w);
    if (g) c.helpGroup(g);
  }
  return program;
}

const mountOptions = (o: MountOptions, warn?: (m: string) => void) => ({
  ...(o.namespace !== undefined ? { namespace: o.namespace } : {}),
  ...(o.verbs ? { verbs: o.verbs } : {}),
  ...(o.onCollision ? { onCollision: o.onCollision } : {}),
  ...(o.config
    ? { config: CONFIG }
    : { pinnedKeys: {}, productSlug: "tidewater" }),
  version: "2.4.1",
  ...(warn ? { warn } : {}),
  setExitCode: () => undefined,
});

describe("ui-matrix.json cli: mount", () => {
  for (const row of MATRIX.cli.mount)
    it(row.name, () => {
      const program = hostProgram(row.input.host);
      const warnings: string[] = [];
      const register = () =>
        registerPolarisCommands(
          program,
          async () => stubClient(),
          mountOptions(row.input.options, (m) => warnings.push(m)),
        );
      if (row.expect.error) {
        let caught: unknown;
        try {
          register();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(VerbCollisionError);
        const err = caught as VerbCollisionError;
        expect(err.code).toBe(row.expect.error.code);
        expect(err.words).toEqual(row.expect.error.words);
        expect([...err.fixes]).toEqual(row.expect.error.fixes);
        // The message names every word and both fixes, and nothing was mounted.
        for (const w of row.expect.error.words)
          expect(err.message).toContain(`"${w}"`);
        for (const f of row.expect.error.fixes)
          expect(err.message).toContain(f);
        expect(typed(program, new Set(row.input.host))).toEqual([]);
        return;
      }
      register();
      expect(typed(program, new Set(row.input.host))).toEqual(
        row.expect.mounted,
      );
      // The warning: once, naming every skipped verb.
      expect(warnings).toHaveLength(row.expect.skipped.length ? 1 : 0);
      for (const v of row.expect.skipped) expect(warnings[0]).toContain(v);
      // The host's commands are untouched.
      for (const w of row.input.host)
        expect(
          program.commands.find((c) => c.name() === w)?.description(),
        ).toBe(`Run ${w}`);
      const hidden = (
        program.options as unknown as { long?: string; hidden: boolean }[]
      )
        .filter((o) => o.hidden)
        .map((o) => o.long!)
        .sort();
      expect(hidden).toEqual(row.expect.hidden);
    });

  it("yargs mounts the same commands and raises the same error", () => {
    for (const row of MATRIX.cli.mount) {
      const y = yargs([]).exitProcess(false);
      const opts = {
        ...mountOptions(row.input.options),
        hostCommands: row.input.host,
      };
      if (row.expect.error) {
        expect(
          () => registerYargs(y, async () => stubClient(), opts),
          row.name,
        ).toThrow(VerbCollisionError);
        continue;
      }
      registerYargs(y, async () => stubClient(), opts);
    }
  });
});

describe("ui-matrix.json cli: help", () => {
  for (const row of MATRIX.cli.help)
    it(row.name, () => {
      const groups = new Map(
        row.input.host.flatMap((s) =>
          s.commands.map((c) => [c, s.heading] as const),
        ),
      );
      const program = hostProgram([...groups.keys()], groups);
      registerPolarisCommands(program, async () => stubClient(), {
        ...mountOptions(row.input.options),
        io: { stdout: new Screen({ tty: false, columns: 80 }), env: {} },
      });
      const text = program.helpInformation({ error: false });
      // Headings sit at column 0; a command is a two-space row's first words.
      const sections: { heading: string; commands: string[] }[] = [];
      for (const line of plain(text).split("\n")) {
        if (/^\S/.test(line) && !line.startsWith("Usage:"))
          sections.push({ heading: line.replace(/:$/, ""), commands: [] });
        else if (/^ {2}\S/.test(line) && sections.length) {
          const words = line
            .trim()
            .split(/\s{2,}/)[0]!
            .split(" ");
          const cmd = words
            .filter((w) => !/^[<[]/.test(w))
            .join(" ")
            .split("|")[0]!;
          if (cmd !== "help") sections.at(-1)!.commands.push(cmd);
        }
      }
      const got = sections
        .filter((s) => s.heading !== "Options" && s.commands.length)
        .map((s) => ({ heading: s.heading, commands: s.commands.sort() }));
      expect(got).toEqual(
        row.expect.sections.map((s) => ({
          heading: s.copy ? EN[s.copy] : s.heading,
          commands: s.commands,
        })),
      );
    });
});

// ── gate ────────────────────────────────────────────────────────────────────────────────────

const glyph = TERMINAL_SYMBOLS.unicode;
const USABLE = ["ok", "grace", "not-applicable"];

async function runGate(
  input: (typeof MATRIX.cli.gate)[number]["input"],
  entitlement = "export.pdf",
) {
  const stdout = new Screen({ tty: input.tty, columns: 80, rows: 30 });
  const stderr = new Screen({ tty: input.tty, columns: 80 });
  const stdin = new FakeStdin(input.tty);
  if (!input.tty) stdin.end();
  let current = input.status;
  // No product page: discovery says the product's portal is off (DISC-01).
  const stub = stubClient({
    ...(input.portal === false ? { portal: { enabled: false } } : {}),
    status: () => {
      if (input.check === "throws") throw new Error("the check failed");
      return { status: current };
    },
    entitlements: {
      has: () => input.entitled && USABLE.includes(current),
    },
    license: {
      // A key activates the license: the next status is ok.
      activateWithKey: async () => {
        current = "ok";
        return { kind: "ok", token: "pkeyt_secret", schemaVersion: 1 };
      },
    },
  });
  const client = stub;
  const program = new Command("tidewater");
  program.exitOverride();
  let ran = 0;
  let exit: number | null = null;
  registerPolarisCommands(program, async () => client as PolarisKeyClient, {
    ...mountOptions(input.mounted ? { verbs: input.mounted } : {}),
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
      platform: "linux",
      ticker: frozenTicker,
      now: () => NOW,
      openUrl: () => true,
    },
    setExitCode: (c) => (exit = c),
  });
  program
    .command(input.command)
    .option("--json")
    .action(
      requireLicense(
        () => {
          ran += 1;
        },
        { entitlement },
      ),
    );
  const done = program.parseAsync(
    [input.command, ...(input.json ? ["--json"] : [])],
    { from: "user" },
  );
  if (
    input.tty &&
    !input.json &&
    ["expired", "revoked", "needs-activation"].includes(input.status)
  ) {
    await settle();
    stdin.type(KEY);
    stdin.press("return", { sequence: "\r" });
  }
  await done;
  return { stdout, stderr, ran, exit: exit as number | null };
}

describe("ui-matrix.json cli: gate", () => {
  for (const row of MATRIX.cli.gate)
    it(row.name, async () => {
      const r = await runGate(row.input);
      const e = row.expect;
      if (e.outcome === "run") {
        expect(r.ran).toBe(1);
        expect(r.exit).toBeNull();
        expect(r.stderr.raw).toBe("");
        return;
      }
      if (e.outcome === "flow") {
        // The activate flow drew on stdout; then the action runs, unless the license still lacks
        // the entitlement (activating a key does not grant one): that refuses with 4.
        expect(plain(r.stdout.raw)).toContain("activate");
        expect(r.ran).toBe(row.input.entitled ? 1 : 0);
        expect(r.exit).toBe(row.input.entitled ? null : EXIT.licenseRequired);
        return;
      }
      expect(r.ran).toBe(0);
      expect(r.exit).toBe(EXIT.licenseRequired);
      expect(e.exit).toBe(EXIT.licenseRequired);
      if (e.stream === "stdout") {
        const lines = r.stdout.raw.trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toEqual(e.result);
        expect(r.stderr.raw).toBe("");
        return;
      }
      // Text: once, on stderr; a triangle for a refusal and a cross for a check that failed;
      // stdout stays empty.
      expect(r.stdout.raw).toBe("");
      const text = plain(r.stderr.raw);
      const flat = text.replace(/[│└]/g, " ").replace(/\s+/g, " ");
      const mark = e.outcome === "fail" ? glyph.fail : glyph.warn;
      const other = e.outcome === "fail" ? glyph.warn : glyph.fail;
      expect(text).toContain(mark);
      expect(text).not.toContain(other);
      const shown = e.copy!.map((k) =>
        EN[k]!.replace("{command}", row.input.command),
      );
      for (const line of shown) expect(flat).toContain(line);
      expect(flat.split(shown.at(-1)!).length - 1).toBe(1);
      // A refusal is its title: the rows that fix it follow, so no message line.
      if (e.outcome === "refuse") {
        expect(e.copy).toHaveLength(1);
        const status = e.copy![0]!.match(/^core\.gate\.(.+)\.title$/)?.[1];
        if (status)
          expect(flat).not.toContain(EN[`core.gate.${status}.message`]!);
      }
      // The link leads the fix rows: the product page, or the developer's name.
      if (e.link === "portal")
        expect(text).toContain("polaris.locker/activate?product=tidewater");
      else if (e.link === "contact") expect(text).toContain("Contact ");
      else {
        expect(text).not.toContain("polaris.locker/activate");
        expect(text).not.toContain("Contact ");
      }
      for (const v of ["activate", "login", "update apply", "status"])
        if (e.fix!.includes(v)) expect(text).toContain(`tidewater ${v}`);
        else expect(text).not.toContain(`tidewater ${v}`);
      // No escape off a terminal.
      if (!row.input.tty) expect(r.stderr.raw).not.toMatch(/\x1b/);
    });
});

describe("requireLicense", () => {
  it("is three lines or fewer to gate a host command", () => {
    // The adoption cost: the mount, the command and its gate (the brief's acceptance).
    const program = new Command("mytool");
    registerPolarisCommands(program, { config: CONFIG, version: "1.0.0" });
    program.command("export").action(requireLicense(() => undefined));
    expect(program.commands.map((c) => c.name())).toContain("export");
  });

  it("ends the process with 4 for polarisGate's refusal", async () => {
    // covered in cliGate.test.ts
    expect(CLI_VERBS.map(verbId)).toContain("status");
  });
});

describe("what the people using the host's program see", () => {
  it("a skipped verb is silent unless the developer asks (onSkip, warn or DEBUG=polaris)", () => {
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    const seen: string[][] = [];
    const saved = process.env.DEBUG;
    delete process.env.DEBUG;
    process.stderr.write = ((m: string) => void stderr.push(m)) as never;
    try {
      registerPolarisCommands(
        hostProgram(["status"]),
        async () => stubClient(),
        mountOptions({ onCollision: "skip" }) as never,
      );
      expect(stderr).toEqual([]);
      registerPolarisCommands(
        hostProgram(["status"]),
        async () => stubClient(),
        {
          ...mountOptions({ onCollision: "skip" }),
          onSkip: (s: readonly string[]) => void seen.push([...s]),
        } as never,
      );
      expect(seen).toEqual([["status"]]);
      process.env.DEBUG = "polaris";
      registerPolarisCommands(
        hostProgram(["status"]),
        async () => stubClient(),
        mountOptions({ onCollision: "skip" }) as never,
      );
      expect(stderr.join("")).toContain("skipped status");
    } finally {
      process.stderr.write = write;
      if (saved === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = saved;
    }
  });

  it("the collision error names every way out", () => {
    expect(() =>
      registerPolarisCommands(
        hostProgram(["status", "update"]),
        async () => stubClient(),
        mountOptions({}) as never,
      ),
    ).toThrow(
      /"status" and "update" are already commands\. Set namespace: "license" \(mytool license status\), leave them out of verbs, or set onCollision: "skip"\./,
    );
  });

  it("commander and yargs describe the verbs in the catalog's words, with no group tag", async () => {
    const program = hostProgram([]);
    registerPolarisCommands(
      program,
      async () => stubClient(),
      mountOptions({}) as never,
    );
    const desc = (n: string) =>
      program.commands.find((c) => c.name() === n)!.description();
    expect(desc("status")).toBe(EN["cli.verb.status"]);
    expect(desc("devices")).toBe(EN["cli.group.devices"]);
    expect(desc("update")).toBe(EN["cli.group.updates"]);
    const ns = hostProgram([]);
    registerPolarisCommands(
      ns,
      async () => stubClient(),
      mountOptions({ namespace: "license" }) as never,
    );
    expect(ns.commands.find((c) => c.name() === "license")!.description()).toBe(
      EN["cli.help.namespace"],
    );
    for (const c of program.commands)
      expect(c.description()).not.toMatch(/^\[/);
    const y = yargs([]).exitProcess(false);
    registerYargs(y, async () => stubClient(), {
      ...mountOptions({}),
      bin: "tidewater",
    } as never);
    const help = await y.getHelp();
    expect(help).toContain(EN["cli.verb.status"]);
    expect(help).not.toMatch(/\[license\]/);
  });
});
