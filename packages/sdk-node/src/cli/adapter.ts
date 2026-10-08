// What the commander and yargs adapters share: run one verb's terminal flow with the flags every
// verb takes (`--json`, `--no-color`, `--ascii`) and its own (`--yes`, `--device-code`), print
// the `--json` envelope, and map the exit code. Both front ends call `runKitVerb`, so they render
// the same screens and the same JSON.

import type { PolarisKeyClient } from "../client.js";
import { createKitContext, type TerminalIO } from "./context.js";
import { envelope, EXIT, jsonLine, type FlowResult } from "./json.js";
import type { CliVerb, VerbFlags } from "./kit.js";
import { verbUsage } from "./help.js";
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

/**
 * The usage problem in what the parser handed over, or null: a required positional missing, or
 * an option the verb does not take (both adapters declare positionals optional and accept
 * unknown options, so an argument error reaches the kit and ends in a result line).
 */
/** A positional as optional (`<key>` → `[key]`, `<ids...>` → `[ids...]`). */
export function optionalArg(spec: string): string {
  return spec.startsWith("<") ? `[${spec.slice(1, -1)}]` : spec;
}

export function usageProblem(
  verb: CliVerb,
  positional: readonly unknown[],
  /** Every operand the parser saw (commander's `this.args`), when it hands them over. */
  operands?: readonly string[],
): boolean {
  const variadic = verb.args.at(-1)?.includes("...") ?? false;
  const excess =
    operands !== undefined && !variadic && operands.length > verb.args.length;
  const extra = operands ?? [];
  const missing = verb.args.some((spec, i) => {
    if (!spec.startsWith("<")) return false;
    const v = positional[i];
    return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });
  // An option the verb does not take (a negative number such as -1 is a value, not an option).
  const flagLike = (v: unknown) =>
    typeof v === "string" && /^--?[A-Za-z]/.test(v);
  const stray =
    extra.some(flagLike) ||
    positional.some((v) => (Array.isArray(v) ? v.some(flagLike) : flagLike(v)));
  return missing || stray || excess;
}

/** Run `verb`'s flow and return its exit code. Never throws. */
export async function runKitVerb(
  verb: CliVerb,
  args: unknown[],
  flags: ParsedVerbFlags,
  buildClient: () => Promise<PolarisKeyClient>,
  o: RunKitVerbOptions & { usage?: boolean },
): Promise<number> {
  const stdout: TerminalOutput =
    o.io?.stdout ?? (o.print ? lineSink(o.print) : process.stdout);
  const io: TerminalIO = { ...o.io, stdout };
  const command = verb.path.join(" ");
  let client: PolarisKeyClient | null = null;
  let clientError: unknown = null;
  if (!verb.clientless && !o.usage) {
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
  try {
    if (o.usage) {
      const usage = `${ctx.bin} ${verbUsage(verb)}`;
      // The Python kit's usage result: exit 2, "error": "usage", the usage line as "message".
      r = {
        exitCode: EXIT.usage,
        state: "error",
        result: { usage },
        error: {
          code: "usage",
          title: ctx.copy.t("cli.help.usage"),
          message: usage,
          showMessage: true,
        },
      };
      if (!ctx.caps.json)
        ctx.stderr.write(
          `${ctx
            .render([
              {
                mark: "fail",
                spans: [
                  { text: ctx.copy.t("cli.help.usage"), style: ["strong"] },
                  { text: `  ${usage}`, keep: true },
                ],
              },
            ])
            .join("\n")}\n`,
        );
    } else {
      if (clientError) throw clientError;
      r = await verb.flow(ctx, client, args, verbFlags);
    }
  } catch (e) {
    // A typed failure keeps its registry code; anything else is "internal" (exit 1).
    const code = (e as { code?: unknown })?.code;
    const typed = typeof code === "string";
    const c = typed ? code : "unknown";
    r = {
      exitCode: EXIT.failed,
      state: "error",
      error: {
        code: typed ? code : "internal",
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
  // The last line of every `--json` run is its result (progress lines may come before it).
  if (ctx.caps.json) ctx.stdout.write(`${jsonLine(envelope(command, r))}\n`);
  return r.exitCode;
}
