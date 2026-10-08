// `--json` on every verb (docs/design/UI-KITS.md §1.4 "Terminal": the one envelope both terminal
// kits print; the Python kit's, UK-13, is the reference). NDJSON on stdout, never a prompt and
// never an escape, ASCII only. Every line is an object with `"v": 1` and `"command"`; progress
// lines carry an `"event"` (`pending` for a sign-in code, `progress` for a download), and the LAST
// line of every run, including an unexpected exception and an argument error, is the result:
//
//   {"v":1,"command":"status","event":"result","ok":true,"exit":0,"status":"ok","usable":true,…}
//   {"v":1,"command":"activate","event":"result","ok":false,"exit":1,"kind":"device-limit",…}
//
// The verb's fields sit at the top level beside `v`, `command`, `event`, `ok` and `exit`.
// `error` is present on a failure that has a code: a registry code (`device_limit`, `network`),
// `usage` for an argument error (exit 2, with a `message`), `internal` for an unexpected
// exception, `interrupted` for Ctrl-C (exit 130). `message` appears only where the Python kit
// prints one: a usage error and an import-bundle failure.
//
// Exit codes: 0 success; 1 a refusal, an unusable license, a cancelled or declined step, any
// failure; 2 usage; 130 interrupted (Ctrl-C).

/** The `--json` schema version. Bumped only for a breaking change to the envelope. */
export const CLI_JSON_VERSION = 1;

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  interrupted: 130,
} as const;

/** A failure, for the screen (title and message) and the result line (code). */
export interface CliJsonError {
  /** The registry code (`device_limit`, `network`), `usage`, `internal`, `interrupted`… */
  code: string | null;
  title: string;
  message: string;
  /** Put `message` on the result line (usage errors and import-bundle, as the Python kit). */
  showMessage?: boolean;
}

/** The fields every line carries, and the result line's own; a verb's fields never replace them. */
const RESERVED = new Set(["v", "command", "event", "ok", "exit"]);

export interface CliJson {
  v: typeof CLI_JSON_VERSION;
  command: string;
  event: "result";
  ok: boolean;
  exit: number;
  error?: string;
  message?: string;
  [field: string]: unknown;
}

/** What a flow hands back: the exit code, the verb's fields, and a failure when there is one. */
export interface FlowResult {
  exitCode: number;
  /** The view's state (components.json); on the result line only when `result` names it. */
  state?: string;
  /** The verb's fields, flattened onto the result line. */
  result?: Record<string, unknown>;
  error?: CliJsonError;
}

/** The result line for a run. */
export function envelope(command: string, r: FlowResult): CliJson {
  const fields = Object.fromEntries(
    Object.entries(r.result ?? {}).filter(([k]) => !RESERVED.has(k)),
  );
  const ok = r.exitCode === EXIT.ok;
  return {
    v: CLI_JSON_VERSION,
    command,
    event: "result",
    ok,
    exit: r.exitCode,
    ...fields,
    ...(!ok && r.error?.code ? { error: r.error.code } : {}),
    ...(!ok && r.error?.showMessage ? { message: r.error.message } : {}),
  };
}

/** A progress line (`pending`, `progress`, …) for `command`. */
export function eventLine(
  command: string,
  event: string,
  fields: Record<string, unknown> = {},
): string {
  return jsonLine({ v: CLI_JSON_VERSION, command, event, ...fields });
}

/**
 * One JSON line, ASCII only (every non-ASCII character as a \u escape, so a C1 control or any
 * other byte of server text never reaches a terminal raw), with the sign-in poll credential
 * (`deviceCode`) and any `licenseKey` dropped.
 */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value, (k, v) =>
    k === "deviceCode" || k === "licenseKey" ? undefined : v,
  ).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
