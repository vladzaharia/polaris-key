// `--json` on every verb (docs/design/UI-KITS.md §1.4; SIGN-IN.md D-68): one JSON object on
// stdout per command, never a prompt and never an escape sequence. The shape is versioned and
// documented (packages/docs/src/content/docs/build/ui/frameworks/terminal-node.mdx):
//
//   { "version": 1, "command": "status", "ok": true, "exitCode": 0,
//     "state": "signed-in", "result": { … }, "error": { "code", "title", "message" } }
//
// `state` is the kit's view state (components.json); `result` is the verb's data; `error` is
// present only when `ok` is false, with the registry `code` (stable) and the `title` and
// `message` people read (in the active locale). `login` is the one streaming verb: it prints one
// object per line (NDJSON) as the sign-in moves, `pending` first, then the final state.
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
  version: typeof CLI_JSON_VERSION;
  command: string;
  ok: boolean;
  exitCode: number;
  state?: string;
  result?: unknown;
  error?: CliJsonError;
}

/** What a flow hands back: the exit code and the JSON envelope's fields. */
export interface FlowResult {
  exitCode: number;
  state?: string;
  result?: unknown;
  error?: CliJsonError;
}

export function envelope(command: string, r: FlowResult): CliJson {
  return {
    version: CLI_JSON_VERSION,
    command,
    ok: r.exitCode === EXIT.ok,
    exitCode: r.exitCode,
    ...(r.state !== undefined ? { state: r.state } : {}),
    ...(r.result !== undefined ? { result: r.result } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
}

/** One line of JSON with the sign-in poll credential (`deviceCode`) and any `licenseKey` dropped. */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value, (k, v) =>
    k === "deviceCode" || k === "licenseKey" ? undefined : v,
  );
}
