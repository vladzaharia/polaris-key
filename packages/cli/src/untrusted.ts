/**
 * Server text is data, never terminal control and never a workflow command (UK-14).
 *
 * Whatever a response carries (a refusal's message, a release id, a label, a URL, a pull
 * request's labels) reaches a terminal or a GitHub Actions log only through `untrusted()`:
 *
 *   escapes    every C0 control (LF included), DEL and C1 control is removed — `clean()` from
 *              `@polaris-key/node/terminal`, the terminal kit's one sanitiser — so a field cannot
 *              write the clipboard (OSC 52), clear the screen or start a new line;
 *   commands   inside an Actions job, a value whose `trimStart()` begins with `::` is led by
 *              U+200B, and every `##[` becomes `##<U+200B>[`. U+200B is neither whitespace to
 *              `trimStart()` nor to the runner's `TrimStart()`, so the runner never reads the
 *              line as `::add-mask::`, `::error`, `::stop-commands::` or a legacy `##[…]`
 *              command.
 *
 * `untrustedLines()` does the same per line for a message pkey built from several fields (an
 * error's message), keeping pkey's own line breaks. `guardOutput()` is the defence in depth
 * under Actions: the streams `runPkey` and `runAction` write to strip foreign controls and
 * defuse every command line but pkey's own `::add-mask::` and `::error` annotation.
 */

import { clean } from "@polaris-key/node/terminal";
import type { Out } from "./ci.js";

export type UntrustedEnv = Readonly<Record<string, string | undefined>>;

/** U+200B ZERO WIDTH SPACE: invisible, and not whitespace to any `trimStart`. */
export const COMMAND_BREAK = "\u200B";

/** True inside a GitHub Actions job (the kit's rule: set, and not "", "0" or "false"). */
export function underActions(env: UntrustedEnv): boolean {
  const v = env.GITHUB_ACTIONS;
  return (
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
  );
}

/** One line that is not a workflow command: `##[` broken, a leading `::` led by U+200B. */
function defuse(line: string): string {
  const s = line.replace(/##\[/g, `##${COMMAND_BREAK}[`);
  return s.trimStart().startsWith("::") ? `${COMMAND_BREAK}${s}` : s;
}

/** One server value as text a terminal or an Actions log shows and never obeys. */
export function untrusted(value: unknown, env: UntrustedEnv): string {
  const text = clean(String(value));
  return underActions(env) ? defuse(text) : text;
}

/** `untrusted()` per line of a message pkey built (an error), keeping its line breaks. */
export function untrustedLines(text: unknown, env: UntrustedEnv): string {
  return String(text)
    .split("\n")
    .map((line) => untrusted(line, env))
    .join("\n");
}

/**
 * `JSON.stringify(value, null, space)` for a terminal or a job log (a `--json` answer that quotes
 * the server): JSON escapes C0 already, and this escapes DEL, C1, U+2028, U+2029 and a legacy
 * `##[` as `\uXXXX` too. Lossless: the text parses to the same value.
 */
export function untrustedJson(value: unknown, space?: number): string {
  return (JSON.stringify(value, null, space) ?? "null")
    .replace(
      /[\u007f-\u009f\u2028\u2029]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(/##\[/g, "#\\u0023[");
}

/** Workflow-command escaping for a command's data (`%`, CR and LF), as `@actions/core` does. */
export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * The workflow commands pkey itself writes, at the start of a line: the mask (`oidc.ts`) and the
 * Action's failure annotation (`action.ts`). The output guard lets these through and nothing else.
 */
const OWN_COMMANDS = ["::add-mask::", "::error title=pkey "] as const;

/** pkey's own colour (an SGR sequence, drawn under FORCE_COLOR), or any other control but TAB. */
const GUARDED = /\x1b\[[0-9;]*m|[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** One complete output line under the guard. */
export function guardLine(line: string): string {
  const s = line.replace(GUARDED, (m) => (m.length > 1 ? m : ""));
  if (OWN_COMMANDS.some((c) => s.startsWith(c))) return s;
  return defuse(s);
}

/** A stream `runPkey` or `runAction` writes to: Node's, or a test's fake with the same fields. */
export type GuardedOut = Out & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};

export interface OutputGuard<T extends GuardedOut> {
  /** The stream to hand the commands: `out` itself outside Actions, else the guarded one. */
  stream: T;
  /** Write out a last line that had no line break (call it in a `finally`). */
  flush(): void;
}

/**
 * Under Actions, `out` behind the line guard: whole lines are cleaned (`guardLine`) as they
 * complete, and a trailing partial line waits for its break or `flush()`. Outside Actions `out`
 * comes back untouched. `isTTY`, `columns` and `rows` are read through, so the terminal
 * detection is unchanged (under Actions stdout is not a terminal, and pkey draws no spinner).
 */
export function guardOutput<T extends GuardedOut>(
  out: T,
  env: UntrustedEnv,
): OutputGuard<T> {
  if (!underActions(env)) return { stream: out, flush: () => undefined };
  const decoder = new TextDecoder();
  let pending = "";
  const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    pending +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    const cb = rest.find((r): r is () => void => typeof r === "function");
    const end = pending.lastIndexOf("\n");
    if (end < 0) {
      if (cb) queueMicrotask(cb);
      return true;
    }
    const complete = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const text = `${complete.split("\n").map(guardLine).join("\n")}\n`;
    return cb ? out.write(text, cb) : out.write(text);
  };
  const stream = {
    write,
    get isTTY() {
      return out.isTTY;
    },
    get columns() {
      return out.columns;
    },
    get rows() {
      return out.rows;
    },
  } as unknown as T;
  return {
    stream,
    flush() {
      pending += decoder.decode();
      if (!pending) return;
      const last = pending;
      pending = "";
      out.write(guardLine(last));
    },
  };
}
