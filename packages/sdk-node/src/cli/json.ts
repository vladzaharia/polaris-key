// `--json` on every verb (docs/design/UI-KITS.md §1.4; SIGN-IN.md D-68), the same envelope as
// the Python terminal kit (UK-13): NDJSON on stdout, never a prompt and never an escape. Every
// line is an object with `"v": 1` and `"command"`; progress lines carry an `"event"` (`pending`
// for a sign-in code, `progress` for a download), and the LAST line of every run, including an
// unexpected exception or an argument error, is the result:
//
//   {"v":1,"command":"status","event":"result","ok":true,"exit":0,
//    "state":"signed-in","result":{…}}
//   {"v":1,"command":"activate","event":"result","ok":false,"exit":3,
//    "state":"device-limit","result":{…},"error":"device_limit","message":"…"}
//
// `state` is the kit's view state (components.json); `result` is the verb's data; `error` is the
// registry code (stable; `usage` for an argument error, `failed` for a local failure) and
// `message` the sentence people read, in the active locale (it may change; scripts read `error`).
// Every non-ASCII character is written as a \u escape, so no byte of server text can reach a
// terminal raw.
//
// Exit codes: 0 done (and a usable license for `status`), 1 failed, 2 usage, 3 the license is
// not usable or a device limit was hit, 4 the service could not be reached, 130 cancelled.

/** The `--json` schema version. Bumped only for a breaking change to the envelope. */
export const CLI_JSON_VERSION = 1;

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  blocked: 3,
  network: 4,
  cancelled: 130,
} as const;

export interface CliJsonError {
  /** The registry code (`device_limit`, `network`), or null for a local failure. */
  code: string | null;
  title: string;
  message: string;
}

export interface CliJson {
  v: typeof CLI_JSON_VERSION;
  command: string;
  event: "result";
  ok: boolean;
  exit: number;
  state?: string;
  result?: unknown;
  /** The registry code, `usage` or `failed`; present only when `ok` is false. */
  error?: string;
  /** The localised sentence for people; present only when `ok` is false. */
  message?: string;
}

/** What a flow hands back: the exit code and the result line's fields. */
export interface FlowResult {
  exitCode: number;
  state?: string;
  result?: unknown;
  error?: CliJsonError;
}

/** The result line for a run. */
export function envelope(command: string, r: FlowResult): CliJson {
  const ok = r.exitCode === EXIT.ok;
  return {
    v: CLI_JSON_VERSION,
    command,
    event: "result",
    ok,
    exit: r.exitCode,
    ...(r.state !== undefined ? { state: r.state } : {}),
    ...(r.result !== undefined ? { result: r.result } : {}),
    ...(!ok
      ? {
          error:
            r.error?.code ??
            (r.exitCode === EXIT.usage
              ? "usage"
              : r.exitCode === EXIT.cancelled
                ? "cancelled"
                : "failed"),
          ...(r.error ? { message: r.error.message } : {}),
        }
      : {}),
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
