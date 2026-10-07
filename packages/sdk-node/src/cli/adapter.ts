// What the commander and yargs adapters share: run one verb's terminal flow with the flags every
// verb takes (`--json`, `--no-color`, `--ascii`) and its own (`--yes`, `--device-code`), print
// the `--json` envelope, and map the exit code. Both front ends call `runKitVerb`, so they render
// the same screens and the same JSON.

import type { PolarisKeyClient } from "../client.js";
import { createKitContext, type TerminalIO } from "./context.js";
import { envelope, EXIT, jsonLine, type FlowResult } from "./json.js";
import type { CliVerb, VerbFlags } from "./kit.js";
import type { TerminalOutput } from "./term/caps.js";
import {
  presentationSourceOf,
  type PolarisKeyTerminalTheme,
  type PresentationSource,
} from "./theme.js";

/** The terminal kit's options, shared by both adapters. */
export interface KitAdapterOptions {
  /** The terminal theme (UI-KITS §3.1; see theme.ts for what each field does here). */
  theme?: PolarisKeyTerminalTheme;
  /** Streams, environment and the browser opener (default: the process's own). */
  io?: TerminalIO;
  /** The command name help and "Run … again" lines use (default: the program's name). */
  bin?: string;
  /** The SDK's presentation accessor (default: `client.presentation()` when it exists). */
  presentation?: PresentationSource;
  /**
   * `false` keeps the pre-kit output: each verb's plain `CommandResult` message through
   * `print`, with no rail, no prompts and no `--json`.
   */
  kit?: boolean;
}

/** Flags as either parser hands them over. */
export interface ParsedVerbFlags {
  json?: boolean;
  /** commander's and yargs' spelling of `--no-color`: false when given. */
  color?: boolean;
  ascii?: boolean;
  yes?: boolean;
  deviceCode?: boolean;
}

/** A stream that hands each complete line to `print` (the adapters' legacy sink). */
export function lineSink(print: (line: string) => void): TerminalOutput {
  let buf = "";
  return {
    isTTY: false,
    write(chunk: string) {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        print(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      return true;
    },
  };
}

export interface RunKitVerbOptions extends KitAdapterOptions {
  slug: string;
  print?: (line: string) => void;
}

/** Run `verb`'s flow and return its exit code. Never throws. */
export async function runKitVerb(
  verb: CliVerb,
  args: unknown[],
  flags: ParsedVerbFlags,
  buildClient: () => Promise<PolarisKeyClient>,
  o: RunKitVerbOptions,
): Promise<number> {
  const base: TerminalOutput =
    o.io?.stdout ?? (o.print ? lineSink(o.print) : process.stdout);
  // `login --json` streams its own lines; when it fails before its first one, the envelope
  // below is the only line, so a script always reads exactly one final state.
  let wrote = false;
  const stdout: TerminalOutput = {
    get isTTY() {
      return base.isTTY;
    },
    get columns() {
      return base.columns;
    },
    get rows() {
      return base.rows;
    },
    write(chunk: string) {
      wrote = true;
      return base.write(chunk);
    },
  };
  const io: TerminalIO = { ...o.io, stdout };
  let client: PolarisKeyClient | null = null;
  let clientError: unknown = null;
  if (!verb.clientless) {
    try {
      client = await buildClient();
    } catch (e) {
      clientError = e;
    }
  }
  const ctx = await createKitContext({
    slug: client?.product ?? o.slug,
    bin: o.bin ?? o.slug,
    flags: {
      ...(flags.json ? { json: true } : {}),
      ...(flags.color === false ? { color: false } : {}),
      ...(flags.ascii ? { ascii: true } : {}),
    },
    io,
    ...(o.theme ? { theme: o.theme } : {}),
    presentation: o.presentation ?? presentationSourceOf(client),
  });
  const verbFlags: VerbFlags = {
    ...(flags.yes ? { yes: true } : {}),
    ...(flags.deviceCode ? { deviceCode: true } : {}),
  };
  let r: FlowResult;
  let thrown = false;
  try {
    if (clientError) throw clientError;
    r = await verb.flow(ctx, client, args, verbFlags);
  } catch (e) {
    thrown = true;
    const code = (e as { code?: unknown })?.code;
    const c = typeof code === "string" ? code : "unknown";
    r = {
      exitCode: c === "network" ? EXIT.network : EXIT.failed,
      state: "error",
      error: {
        code: typeof code === "string" ? code : null,
        title: ctx.copy.code(c, "title"),
        message: ctx.copy.code(c, "message"),
      },
    };
    if (!ctx.caps.json)
      ctx.rows([
        { mark: "fail", spans: [{ text: r.error!.title, style: ["strong"] }] },
        { mark: "end", spans: [{ text: r.error!.message }] },
      ]);
  } finally {
    ctx.close();
  }
  // `login` streams its own JSON lines (SIGN-IN.md D-68); every other verb prints one object.
  if (ctx.caps.json && (verb.path[0] !== "login" || thrown || !wrote))
    ctx.stdout.write(`${jsonLine(envelope(verb.path.join(" "), r))}\n`);
  return r.exitCode;
}
