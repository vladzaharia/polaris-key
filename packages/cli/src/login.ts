/**
 * `pkey login` (ST-34.8): sign in to the console from this terminal with the device flow.
 *
 *   start    POST /api/device-login/start {purpose:"cli", scope:"admin", client}. The answer's
 *            code is shown and its binding cookie is kept in memory.
 *   approve  The person opens <origin>/manage/device?code=… (built here from the origin and the
 *            code, never taken from the answer), checks the code matches, and approves.
 *   poll     GET /api/device-login/<id> with the cookie until approved, denied, expired or refused.
 *   store    The token goes to the OS credential store under the origin, read back to prove it.
 *            Only then is the token this sign-in replaces ended.
 *
 * Security properties (each has a test in test/login.test.ts):
 *   phishing   the code is shown in reverse video with "Check that the code in your browser
 *              matches", and the approval URL is built from the origin pkey itself resolved.
 *   cookie     held in memory, sent only to the origin it came from, never printed or stored.
 *   https      `originOf` (https, or http on loopback) runs before any request; every request is
 *              `redirect: "manual"` and a 3xx is refused.
 *   no echo    the token appears nowhere: not in output, `--json`, errors or the label. The hint
 *              is its last four characters.
 *   bounds     a response is read through a 64 KiB cap, the code lives at most 600 s and a request
 *              that has not answered in 15 s is a network failure.
 *   CI         refuses before the network or the credential store is touched.
 *   store      opened and probed BEFORE start, so an approval never mints a token that cannot be
 *              kept; a failed write revokes the new token; the write is read back.
 *   replace    the old token is revoked only after the new one is stored and read back, so a
 *              cancel, a denial, an expiry or a network failure leaves the old sign-in working.
 */

import { spawn } from "node:child_process";
import { hostname as osHostname, platform as osPlatform } from "node:os";
import {
  cellWidth,
  isCi,
  keyHints,
  layoutColumns,
  wrapSpans,
  type Line,
} from "@polaris-key/node/terminal";
import { ADMIN_TOKEN_ENV } from "./bundle.js";
import {
  block,
  call,
  day,
  envelope,
  Failure,
  guarded,
  hostOf,
  jsonLine,
  jsonOf,
  networkCode,
  originFor,
  plain,
  Redirected,
  REQUEST_TIMEOUT_MS,
  roleText,
  rowsText,
  shown,
  text,
  tokenLine,
  type AccountIo,
} from "./account.js";
import {
  hintOf,
  isCredentialShape,
  Refusal,
  type CredentialStore,
  type StoredCredential,
} from "./credentials.js";
import { Spinner, type Term, type TermFlags } from "./terminal.js";
import { CLI_VERSION } from "./version.js";

export const LOGIN_USAGE =
  "pkey login [--base-url url] [--no-browser] [--json]";

/** The shape of the code the server shows: eight letters of its alphabet in two groups. */
const CODE_SHAPE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const POLL_ID_SHAPE = /^dl_[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME = "__Host-pkey_device_login";
const COOKIE_VALUE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/** Consecutive network failures tolerated while polling. */
const NETWORK_FAILURES = 5;
const MAX_INTERVAL_MS = 30_000;
/** A code lives at most this long here, whatever the server says (N2). */
const MAX_EXPIRES_IN_S = 600;

/** The slice of a TTY stdin the keys use. */
export interface KeyInput {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", cb: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Everything `pkey login` does outside the network, as seams (tests pass fakes). */
export interface LoginSeams {
  /** Open a URL in the default browser. */
  openUrl?: (url: string) => Promise<void>;
  /** Put text on the clipboard; false when there is no clipboard here. */
  copyText?: (text: string) => Promise<boolean>;
  /** Keys: a TTY stdin, or undefined for none. */
  stdin?: KeyInput;
  /** Register a SIGINT handler; returns the remover. */
  onInterrupt?: (cb: () => void) => () => void;
  hostname?: () => string;
  platform?: NodeJS.Platform;
  /** Epoch milliseconds. */
  now?: () => number;
  /** The back-off seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoginIo extends AccountIo {
  noBrowser: boolean;
  flags: TermFlags;
  seams: LoginSeams;
}

function hasDisplay(env: AccountIo["env"], platform: NodeJS.Platform): boolean {
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"]);
}

/** Where a platform keeps the token: the real backend, not a guess. */
export function backendName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS Keychain";
  if (platform === "win32") return "Windows Credential Manager";
  return "Secret Service";
}

/** What to do about a store that would not save: the platform's own word for it. */
function unlockAdvice(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Unlock the keychain";
  if (platform === "win32") return "Check Windows Credential Manager";
  return "Unlock your keyring";
}

/** The default browser opener: no shell, the URL as one argument. */
function defaultOpen(url: string): Promise<void> {
  const platform = osPlatform();
  const [cmd, args]: [string, string[]] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function defaultCopy(text: string): Promise<boolean> {
  const platform = osPlatform();
  const [cmd, args]: [string, string[]] =
    platform === "darwin"
      ? ["pbcopy", []]
      : platform === "win32"
        ? ["clip", []]
        : ["xclip", ["-selection", "clipboard"]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => resolve(false));
    // A clipboard tool that exits before reading must not crash pkey with EPIPE.
    child.stdin.on("error", () => {});
    child.once("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

export function defaultSeams(): LoginSeams {
  return {
    openUrl: defaultOpen,
    copyText: defaultCopy,
    stdin: process.stdin.isTTY ? (process.stdin as KeyInput) : undefined,
    onInterrupt: (cb) => {
      process.on("SIGINT", cb);
      return () => void process.removeListener("SIGINT", cb);
    },
    hostname: osHostname,
    platform: osPlatform(),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function setCookieOf(res: Response): string | null {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const line of all) {
    const pair = line.split(";")[0]!.trim();
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) !== COOKIE_NAME) continue;
    const value = pair.slice(eq + 1);
    if (COOKIE_VALUE_SHAPE.test(value)) return value;
  }
  return null;
}

/** A request that never got an answer: its network error code (or null) is all that is kept. */
class Transport extends Error {
  constructor(readonly code: string | null) {
    super("transport");
  }
}

/** One request: no redirect followed, at most `REQUEST_TIMEOUT_MS`, and `abort` ends it early. */
async function send(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  abort: AbortSignal,
): Promise<Response> {
  try {
    return await f(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([abort, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (e) {
    throw new Transport(networkCode(e));
  }
}

/** `before` + `pkey login` as the person ran it (`--base-url` repeated) + `after`. */
function rerunLine(
  command: string,
  io: LoginIo,
  origin: string,
  before: string,
  after: string,
): Line {
  return [
    text(before),
    text(command),
    ...(io.baseUrlGiven
      ? [text(" --base-url "), text(origin, { break: "url" as const })]
      : []),
    text(after),
  ];
}

/** How a sign-in ended without a token: what to print, what to exit with, and the JSON code. */
interface Outcome {
  state: string;
  exit: number;
  kind: "warn" | "fail";
  lines: Line[];
  extra?: Record<string, unknown>;
}

const flat = (lines: Line[]): string =>
  lines.map((l) => l.map((s) => s.text).join("")).join(" ");

/**
 * What differs between the device flows that share `flow` (F-37.3 extracted it once): `pkey login`
 * (an `admin` token, approved in the console, stored in the credential store) and
 * `pkey feeds setup --write` (a `packages:read` token, approved in Polaris Locker, handed to the
 * caller and stored nowhere).
 */
export interface DeviceCopy {
  /** "Opening Polaris Key in your browser" (no ellipsis). */
  opening: string;
  rateLimited: { message: string; fix: string };
  /** Where an unsupported server sends the person. */
  unsupportedFix: string;
  /** The token limit: the sentences (the rerun line is added after them). */
  tokenLimit: (limit: string | undefined, origin: string) => Line[];
  /** What a 403 says: the sentence and the fix. */
  forbidden: [string, string];
  /** A request refused in the browser. */
  denied: (code: string) => string;
  /** After a network failure an approval may have gone through unseen. */
  maybeApproved: string;
}

export interface DeviceMode {
  /** The JSON `command` and the name `guarded` prints. */
  command: "login" | "feeds setup";
  /** The command as the person ran it, in "Run … to try again". */
  rerun: string;
  scope: "admin" | "packages:read";
  /** The heading above the code. */
  title: string;
  /** Where the person approves, built from the resolved origin and the code. */
  approvePath: (code: string) => string;
  /** Runs before the start. `replaces` says an existing sign-in ends once this one is kept. */
  begin: () => Promise<{
    replaces: boolean;
    /** A line under the heading (what will be set up). */
    note?: string;
    /** The approved answer's body; `gap` is the blank row to print before a result. */
    approved: (body: Record<string, unknown>, gap: string) => Promise<number>;
  }>;
  /** The words that differ between the flows. */
  copy: DeviceCopy;
  /** Refusals that must come before anything else, the CI one included. */
  guard?: () => void;
  /** Warn that `PKEY_ADMIN_TOKEN` outranks this sign-in (the console one only). */
  warnAdminEnv: boolean;
}

/** The seams `pkey login` and `--write` run with: the real ones, then the ones given. */
export function resolveSeams(io: LoginIo): LoginSeams {
  const given = Object.fromEntries(
    Object.entries(io.seams).filter(([, v]) => v !== undefined),
  );
  return { ...defaultSeams(), ...given };
}

export function cmdLogin(io: LoginIo): Promise<number> {
  return runDeviceFlow(io, {
    command: "login",
    rerun: "pkey login",
    scope: "admin",
    title: "Polaris Key console",
    copy: {
      opening: "Opening Polaris Key in your browser",
      rateLimited: {
        message: "Too many sign-in attempts from this network.",
        fix: "Wait a few minutes, then run pkey login again.",
      },
      unsupportedFix: `Set ${ADMIN_TOKEN_ENV} to a personal token instead.`,
      tokenLimit: (limit, origin) => {
        const url = `${origin}/manage/#/personal-tokens`;
        return [
          [
            text(
              limit
                ? `You already have ${limit} personal tokens, the most allowed.`
                : "You already have the most personal tokens allowed.",
            ),
          ],
          rerunLine(
            "pkey login",
            io,
            origin,
            "Revoke one in Personal tokens, then run ",
            " again.",
          ),
          [text(url, { break: "url", link: url })],
        ];
      },
      forbidden: [
        "This account can't sign in.",
        "Ask a Superadmin to check your access.",
      ],
      denied: (code) => `Code ${code} was canceled in the browser.`,
      maybeApproved:
        "If you approved it, the token may exist; check Personal tokens.",
    },
    approvePath: (code) => `/manage/device?code=${code}`,
    warnAdminEnv: true,
    // 3. Open and probe the store BEFORE start: an approval mints a 7-day admin token.
    begin: async () => {
      const store: CredentialStore = await io.store();
      const existing = store.get(originFor(io, "login"));
      const now = io.seams.now ?? Date.now;
      const replaces =
        existing !== null &&
        (existing.expiresAt === null || existing.expiresAt * 1000 > now());
      return {
        replaces,
        approved: (body, gap) =>
          approved(io, {
            origin: originFor(io, "login"),
            host: hostOf(originFor(io, "login")),
            platform: io.seams.platform ?? osPlatform(),
            store,
            previous: replaces ? existing : null,
            token: body["token"],
            expiresAt: body["expiresAt"],
            label: body["label"],
            gap,
          }),
      };
    },
  });
}

/** The device flow: start, show the code, poll; the mode says what is asked and what follows. */
export function runDeviceFlow(io: LoginIo, mode: DeviceMode): Promise<number> {
  const seams = resolveSeams(io);
  // A heading held back for the live region is printed after all if the sign-in fails before it.
  const deferred: { flush?: () => void } = {};
  return guarded(io, mode.command, async () => {
    try {
      return await flow(io, seams, deferred, mode);
    } catch (e) {
      deferred.flush?.();
      throw e;
    }
  });
}

async function flow(
  io: LoginIo,
  seams: LoginSeams,
  deferred: { flush?: () => void },
  mode: DeviceMode,
): Promise<number> {
  const rerun = (
    io: LoginIo,
    origin: string,
    before: string,
    after: string,
  ): Line => rerunLine(mode.rerun, io, origin, before, after);
  mode.guard?.();
  // 1. CI: before the network and before the credential store.
  if (isCi(io.env))
    throw new Refusal(
      `${mode.rerun} needs a person; in CI use ${ADMIN_TOKEN_ENV}.`,
    );

  // 2. The origin: https, or http on loopback; the one string every request and the store use.
  const origin = originFor(io, mode.command);
  const host = hostOf(origin);
  const platform = seams.platform ?? osPlatform();
  const now = seams.now ?? Date.now;
  const sleep = seams.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const f = io.fetchImpl ?? fetch;

  const { replaces, note, approved: settle } = await mode.begin();

  const out = io.term(io.stdout);
  const errTerm = io.term(io.stderr);
  const say = (s: string) => io.stdout.write(s);
  /** `line` wrapped to `columns` (`indent` in), one string per row. */
  const layout = (line: Line, columns: number, indent = 0): string[] =>
    wrapSpans(line, Math.max(1, columns - indent)).map(
      (l) => `${" ".repeat(indent)}${out.painter.line(l)}`,
    );
  const put = (t: Term, line: Line, indent = 0): string =>
    wrapSpans(line, Math.max(1, t.caps.columns - indent))
      .map((l) => `${" ".repeat(indent)}${t.painter.line(l)}\n`)
      .join("");

  // The heading, link and code are one live region with the spinner when stdout and stderr are
  // both a terminal, so a resize lays them out again; otherwise they are printed once.
  const spinner = new Spinner(io.stderr, io.env, io.flags);
  const live = !io.json && spinner.active && Boolean(io.stdout.isTTY);

  /** The title, the notice that a sign-in is replaced, and the blank rows around them. */
  const titleRows = (columns: number): string[] => {
    const title = mode.title;
    const sep = out.symbols.separator;
    // One line when it fits; else the separator stays at the end of the first and the host hangs.
    const fits = cellWidth(`${title} ${sep} ${host}`) <= columns;
    return [
      ...layout(
        fits
          ? [
              text(title, { style: ["strong"] }),
              text(` ${sep} ${host}`, { style: ["muted"] }),
            ]
          : [text(`${title} ${sep}`, { style: ["strong"] })],
        columns,
      ),
      ...(fits
        ? []
        : layout([text(host, { style: ["muted"], break: "url" })], columns)),
      "",
      ...(replaces
        ? [
            ...layout(
              [
                text(
                  "You're already signed in here. The old token ends once the new one is saved.",
                ),
              ],
              columns,
            ),
            "",
          ]
        : []),
      ...(note ? [...layout([text(note)], columns), ""] : []),
    ];
  };

  if (!io.json) {
    if (live)
      deferred.flush = () => say(`${titleRows(out.caps.columns).join("\n")}\n`);
    else say(`${titleRows(out.caps.columns).join("\n")}\n`);
    if (mode.warnAdminEnv && io.env[ADMIN_TOKEN_ENV]?.trim())
      io.stderr.write(
        block(
          errTerm,
          "warn",
          plain(
            `${ADMIN_TOKEN_ENV} is set and takes precedence over this sign-in.`,
            "Unset it to use the one pkey login saves.",
          ),
        ),
      );
  }

  const abort = new AbortController();
  let cancelled: "esc" | "interrupt" | null = null;
  let wake: (() => void) | undefined;
  const cancelSignal = new Promise<void>((resolve) => (wake = resolve));
  const cancel = (why: "esc" | "interrupt") => {
    if (cancelled) return;
    cancelled = why;
    abort.abort();
    wake?.();
  };
  const wait = (ms: number) =>
    Promise.race([sleep(ms), cancelSignal]) as Promise<void>;

  // 5. Start. The cookie is in memory only.
  let startRes: Response;
  try {
    startRes = await send(
      f,
      `${origin}/api/device-login/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          purpose: "cli",
          scope: mode.scope,
          client: {
            name: "pkey",
            version: CLI_VERSION,
            host: (seams.hostname ?? osHostname)(),
          },
        }),
      },
      abort.signal,
    );
  } catch (e) {
    if (!(e instanceof Transport)) throw e;
    throw new Failure(
      `Can't reach ${host}.`,
      "Check your network, or --base-url.",
      "network",
      { host, ...(e.code ? { cause: e.code } : {}) },
    );
  }
  if (startRes.status >= 300 && startRes.status < 400)
    throw new Redirected(host);
  if (startRes.status === 429)
    throw new Refusal(
      mode.copy.rateLimited.message,
      mode.copy.rateLimited.fix,
      "rate-limited",
    );
  if ([404, 405, 422, 501].includes(startRes.status))
    throw new Refusal(
      `${host} doesn't offer terminal sign-in.`,
      mode.copy.unsupportedFix,
      "unsupported",
    );
  if (startRes.status !== 201)
    throw new Failure(
      `${host} couldn't start a sign-in (HTTP ${startRes.status}).`,
      "Try again in a minute.",
      "server-error",
      { host, status: startRes.status },
    );
  const started = await jsonOf(startRes);
  const pollId = String(started["id"] ?? "");
  const userCode = String(started["code"] ?? "");
  const cookie = setCookieOf(startRes);
  if (!POLL_ID_SHAPE.test(pollId) || !CODE_SHAPE.test(userCode) || !cookie)
    throw new Failure(
      `${host} answered the sign-in start unexpectedly.`,
      "Check --base-url.",
      "unexpected-answer",
      { host },
    );
  const expiresIn = Math.min(
    typeof started["expiresIn"] === "number" && started["expiresIn"] > 0
      ? started["expiresIn"]
      : 300,
    MAX_EXPIRES_IN_S,
  );
  let interval = clampInterval(started["interval"], 3_000);
  const deadline = now() + expiresIn * 1000;
  // Built here, from the origin pkey resolved: a server cannot send the person elsewhere.
  const approveUrl = `${origin}${mode.approvePath(userCode)}`;
  let heading: (() => void) | undefined;

  // 6. Show the code and the link; open the browser when allowed.
  const remote = Boolean(io.env["SSH_CONNECTION"] || io.env["SSH_TTY"]);
  const mayOpen =
    !io.json && !io.noBrowser && !remote && hasDisplay(io.env, platform);
  // The remote clipboard is not this person's: over SSH there is no copy key.
  const mayCopy = !remote;
  const interactive = !io.json && Boolean(seams.stdin?.isTTY);
  const open = async (): Promise<boolean> => {
    try {
      await (seams.openUrl ?? defaultOpen)(approveUrl);
      return true;
    } catch {
      return false;
    }
  };
  if (io.json) {
    say(
      jsonLine({
        v: 1,
        command: mode.command,
        event: "started",
        host,
        code: userCode,
        url: approveUrl,
        expiresIn,
        ...(mode.scope === "admin" ? { replaces } : {}),
      }),
    );
  } else {
    const opened = mayOpen ? await open() : false;
    /** The opening line, the link, and the code with its prompt: laid out for `columns`. */
    const codeRows = (columns: number): string[] => {
      // Too narrow for the whole link: print it without the code, which shows right under it.
      const short = approveUrl.length >= columns;
      const shown = short
        ? `${origin}${mode.approvePath("").split("?")[0]}`
        : approveUrl;
      return [
        ...(opened
          ? layout(
              [text(`${mode.copy.opening}${out.symbols.ellipsis}`)],
              columns,
            )
          : []),
        ...layout(
          opened
            ? [text("Didn't open? Go to", { style: ["muted"] })]
            : [text("Open this link in a browser:")],
          columns,
        ),
        ...layout([text(shown, { break: "url", link: approveUrl })], columns),
        "",
        ...layout(
          [
            text(
              short
                ? "Enter this code in your browser:"
                : "Check that the code in your browser matches:",
            ),
          ],
          columns,
        ),
        out.painter.style(` ${userCode} `, ["code"]),
        "",
      ];
    };
    if (live) {
      // Held in the spinner's region; `finish` prints the last layout when the region closes.
      const rows = (columns: number): string[] => [
        ...titleRows(columns),
        ...codeRows(columns),
      ];
      deferred.flush = undefined;
      spinner.setHeader((columns) => ({
        head: titleRows(columns),
        body: codeRows(columns),
      }));
      heading = () =>
        say(
          `${rows(io.stdout.columns ? layoutColumns(io.stdout.columns) : out.caps.columns).join("\n")}\n`,
        );
    } else say(`${codeRows(out.caps.columns).join("\n")}\n`);
  }

  const wrapped = spinner.wrap(io.stdout);
  let cleanup: (() => void)[] = [];
  const finish = () => {
    spinner.stop();
    // The region took the heading with it: print what it last showed, once.
    heading?.();
    heading = undefined;
    for (const c of cleanup) c();
    cleanup = [];
  };
  /** The blank row before a result: already there under a live spinner, else written. */
  const gap = (): string => (spinner.active ? "" : "\n");

  cleanup.push(
    (seams.onInterrupt ?? (() => () => {}))(() => cancel("interrupt")),
  );

  // The key hints: one live region with the spinner, under it. The copy key says what it did.
  let copyVerb = "copy the code";
  const hintLines = (columns: number): string[] => {
    const keys = [
      mayOpen ? "Enter open again" : "",
      mayCopy ? `c ${copyVerb}` : "",
      "Esc cancel",
    ].filter(Boolean);
    return wrapSpans(
      keyHints(keys.join(` ${errTerm.symbols.separator} `), errTerm.symbols),
      Math.max(1, columns - 4),
    ).map((l) => `   ${errTerm.painter.line(l)}`);
  };

  if (interactive) {
    const stdin = seams.stdin!;
    const onData = (chunk: Buffer | string) => {
      const k = chunk.toString();
      if (k === "\x03") cancel("interrupt");
      else if (k === "\x1b" || k === "\x04") cancel("esc");
      else if ((k === "\r" || k === "\n") && mayOpen) void open();
      else if ((k === "c" || k === "C") && mayCopy)
        void (seams.copyText ?? defaultCopy)(userCode).then((ok) => {
          if (spinner.active) {
            copyVerb = ok ? "copied" : "no clipboard here";
            spinner.setFooter(hintLines);
          } else
            wrapped.write(
              block(
                out,
                ok ? "ok" : "warn",
                plain(ok ? `Copied ${userCode}.` : "No clipboard here."),
              ),
            );
        });
    };
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* not a raw-capable stream: keys still arrive line by line */
    }
    stdin.resume();
    stdin.on("data", onData);
    cleanup.push(() => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* nothing to restore */
      }
      stdin.pause();
    });
  }

  const waiting = "Waiting for approval";
  if (!io.json) {
    if (spinner.active) {
      if (interactive) spinner.setFooter(hintLines);
      spinner.stage(waiting);
    } else {
      say(`${waiting}${out.symbols.ellipsis}\n`);
      if (interactive) say(`${hintLines(out.caps.columns).join("\n")}\n`);
    }
  }

  const report = (o: Outcome): number => {
    finish();
    if (io.json)
      io.stdout.write(
        envelope(mode.command, o.exit, {
          error: o.state,
          message: flat(o.lines),
          host,
          code: userCode,
          ...o.extra,
        }),
      );
    else io.stderr.write(`${gap()}${block(errTerm, o.kind, o.lines)}`);
    return o.exit;
  };
  const cancelReport = (why: "esc" | "interrupt"): number =>
    report({
      state: why === "interrupt" ? "interrupted" : "cancelled",
      exit: why === "interrupt" ? 130 : 1,
      kind: "warn",
      lines: plain("Canceled. Nothing was saved."),
    });
  /** After a network failure an approval may have gone through unseen. */
  let sawFailure = false;
  const maybeApproved = (): Line[] =>
    sawFailure ? plain(mode.copy.maybeApproved) : [];
  const expired = (): number =>
    report({
      state: "expired",
      exit: 1,
      kind: "fail",
      lines: [
        [text(`Code ${userCode} expired before it was approved.`)],
        rerun(io, origin, "Run ", " to get a new one."),
        ...maybeApproved(),
      ],
    });

  // 7. Poll with the server's interval, backing off on 429 and on network failures.
  let failures = 0;
  while (true) {
    await wait(interval);
    if (cancelled) return cancelReport(cancelled);
    if (now() >= deadline) return expired();
    let res: Response;
    try {
      res = await send(
        f,
        `${origin}/api/device-login/${pollId}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            cookie: `${COOKIE_NAME}=${cookie}`,
          },
        },
        abort.signal,
      );
    } catch (e) {
      if (!(e instanceof Transport)) throw e;
      if (cancelled) return cancelReport(cancelled);
      sawFailure = true;
      if (++failures >= NETWORK_FAILURES)
        return report({
          state: "network",
          exit: 1,
          kind: "fail",
          lines: [
            [
              text(
                `Lost contact with ${host} while waiting for code ${userCode}.`,
              ),
            ],
            rerun(io, origin, "Run ", " to try again."),
            ...maybeApproved(),
          ],
          extra: e.code ? { cause: e.code } : {},
        });
      if (failures === 1 && !io.json) {
        if (spinner.active)
          spinner.stage(`Reconnecting to ${host}${out.symbols.ellipsis}`);
        else say(`Reconnecting to ${host}${out.symbols.ellipsis}\n`);
      }
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      finish();
      throw new Redirected(host);
    }
    if (res.status === 429 || res.status === 503) {
      sawFailure = true;
      if (++failures >= NETWORK_FAILURES)
        return report({
          state: "network",
          exit: 1,
          kind: "fail",
          lines: [
            [text(`${host} is not answering right now (HTTP ${res.status}).`)],
            rerun(io, origin, "Run ", " to try again."),
            ...maybeApproved(),
          ],
          extra: { status: res.status },
        });
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
      continue;
    }
    if (failures > 0 && !io.json && spinner.active) spinner.stage(waiting);
    failures = 0;
    if (res.status === 410) return expired();
    const body = await jsonOf(res);
    if (res.status === 409 && body["reason"] === "token_limit") {
      const limit = /at most (\d{1,3}) /.exec(
        String(body["message"] ?? ""),
      )?.[1];
      const lines = mode.copy.tokenLimit(limit, origin);
      return report({
        state: "token_limit",
        exit: 4,
        kind: "warn",
        lines,
        extra:
          mode.scope === "admin"
            ? { url: `${origin}/manage/#/personal-tokens` }
            : {},
      });
    }
    if (res.status === 403)
      return report({
        state: "refused",
        exit: 4,
        kind: "warn",
        lines: plain(...mode.copy.forbidden),
      });
    if (!res.ok)
      return report({
        state: "server-error",
        exit: 1,
        kind: "fail",
        lines: [
          [text(`${host} refused the sign-in (HTTP ${res.status}).`)],
          rerun(io, origin, "Run ", " to try again."),
        ],
        extra: { status: res.status },
      });
    const status = body["status"];
    if (status === "pending") {
      interval = clampInterval(body["interval"], interval);
      continue;
    }
    if (status === "denied")
      return report({
        state: "denied",
        exit: 1,
        kind: "warn",
        lines: [
          [text(mode.copy.denied(userCode))],
          rerun(io, origin, "Run ", " to try again."),
        ],
      });
    if (status !== "approved")
      return report({
        state: "unexpected-answer",
        exit: 1,
        kind: "fail",
        lines: [
          [text(`${host} answered the sign-in unexpectedly.`)],
          rerun(io, origin, "Run ", " to try again."),
        ],
      });
    finish();
    return settle(body, gap());
  }
}

function clampInterval(v: unknown, fallback: number): number {
  return typeof v === "number" && v > 0
    ? Math.min(Math.max(v * 1000, 1_000), MAX_INTERVAL_MS)
    : fallback;
}

/** True when the console accepted a revoke, or says the token had already ended. */
async function revoked(
  io: LoginIo,
  cred: Parameters<typeof call>[1],
): Promise<boolean> {
  try {
    const res = await call(io, cred, "DELETE", "/me/personal-tokens/current");
    if (res.ok || res.status === 401) return true;
    if (res.status === 404) {
      const body = await jsonOf(res);
      const err = body["error"] as { code?: unknown } | undefined;
      return err?.code === "not_found" || body["code"] === "not_found";
    }
    return false;
  } catch {
    return false;
  }
}

/** The approved path: validate, store, read back, end the old token, then say who is signed in. */
async function approved(
  io: LoginIo,
  a: {
    origin: string;
    host: string;
    platform: NodeJS.Platform;
    store: CredentialStore;
    previous: StoredCredential | null;
    token: unknown;
    expiresAt: unknown;
    label: unknown;
    gap: string;
  },
): Promise<number> {
  const { origin, host, store } = a;
  if (
    typeof a.token !== "string" ||
    !a.token.startsWith("pkeyp_") ||
    !isCredentialShape(a.token) ||
    typeof a.expiresAt !== "number" ||
    !Number.isInteger(a.expiresAt) ||
    a.expiresAt <= 0
  )
    throw new Failure(
      `${host} answered the sign-in unexpectedly.`,
      "Try again, or check --base-url.",
      "unexpected-answer",
      { host },
    );
  const token = a.token;
  const expiresAt = a.expiresAt;
  const label =
    typeof a.label === "string" && a.label.trim()
      ? shown(a.label, io.env).slice(0, 200)
      : null;
  const hint = token.slice(-4);
  const cred = {
    token,
    source: "store" as const,
    origin,
    expiresAt,
    label,
    hint,
  };
  const t = io.term(io.stdout);
  const personalTokens = `${origin}/manage/#/personal-tokens`;

  // Write, then read back. A store that cannot keep it gets the new token revoked.
  let kept = false;
  try {
    store.set(origin, { token, expiresAt, label, hint });
    kept = store.get(origin)?.token === token;
  } catch {
    kept = false;
  }
  if (!kept) {
    // The old sign-in still works on the server: put it back if the write displaced it.
    let restored = true;
    if (a.previous)
      try {
        store.set(origin, a.previous);
      } catch {
        restored = false;
      }
    const ended = await revoked(io, cred);
    const name = backendName(a.platform);
    const message = ended
      ? `${name} wouldn't save the sign-in, so pkey revoked it.`
      : `${name} wouldn't save the sign-in, and pkey couldn't revoke it.`;
    const quote = t.caps.unicode ? ["“", "”"] : ['"', '"'];
    throw new Failure(
      message,
      undefined,
      "store-failed",
      { host, revoked: ended },
      [
        [text(message)],
        ended
          ? [
              ...rerunLine(
                "pkey login",
                io,
                origin,
                `${unlockAdvice(a.platform)} and run `,
                " again, or make a token at ",
              ),
              text(personalTokens, { break: "url", link: personalTokens }),
              text(` and set ${ADMIN_TOKEN_ENV}.`),
            ]
          : [
              text(
                `Revoke ${label ? `${quote[0]}${label}${quote[1]} ` : ""}(pkeyp_${t.symbols.ellipsis}${hint}) at `,
              ),
              text(personalTokens, { break: "url", link: personalTokens }),
            ],
        ...(a.previous && !restored
          ? [
              rerunLine(
                "pkey login",
                io,
                origin,
                "Your old sign-in may need ",
                " again.",
              ),
            ]
          : []),
      ],
    );
  }

  // The new sign-in is kept: only now does the one it replaces end.
  let previous: "none" | "revoked" | "not-revoked" = "none";
  if (a.previous && a.previous.token !== token)
    previous = (await revoked(io, {
      token: a.previous.token,
      source: "store",
      origin,
      expiresAt: a.previous.expiresAt,
    }))
      ? "revoked"
      : "not-revoked";

  // Who is it? The new token reads its own identity; failing that, still signed in.
  let name = "";
  let email = "";
  let roles: { role: string; scope: string; areas?: unknown }[] = [];
  const products = new Map<string, string>();
  try {
    const res = await call(io, cred, "GET", "/me");
    if (res.ok) {
      const me = await jsonOf(res);
      name = shown(me["name"] ?? "", io.env);
      email = shown(me["email"] ?? "", io.env);
      if (Array.isArray(me["products"]))
        for (const p of me["products"] as { slug?: unknown; name?: unknown }[])
          if (typeof p?.slug === "string" && typeof p.name === "string")
            products.set(p.slug, shown(p.name, io.env));
      const perms = (me["permissions"] ?? {}) as {
        roles?: { role?: unknown; scope?: unknown; areas?: unknown }[];
      };
      roles = (Array.isArray(perms.roles) ? perms.roles : []).map((r) => ({
        role: shown(r.role, io.env),
        scope: shown(r.scope, io.env),
        areas: r.areas,
      }));
    }
  } catch {
    /* identity is a nicety; the sign-in stands */
  }

  const backend = backendName(a.platform);
  if (io.json) {
    io.stdout.write(
      envelope("login", 0, {
        host,
        name,
        email,
        roles: roles.map((r) => ({ role: r.role, scope: r.scope })),
        token: {
          type: "personal",
          scope: "admin",
          ...(label ? { label } : {}),
          hint,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        storedIn: backend,
        replaced: previous,
      }),
    );
    return 0;
  }

  const who: Line = name
    ? [
        text("Signed in as "),
        text(name, { style: ["strong"], keep: true }),
        ...(email ? [text(" "), text(`(${email})`, { keep: true })] : []),
      ]
    : email
      ? [text("Signed in as "), text(email, { keep: true })]
      : [text("Signed in.")];
  io.stdout.write(`${a.gap}${block(t, "ok", [who])}\n`);

  const roleNames = [
    ...new Set(
      roles.map((r) =>
        roleText(
          r.role,
          r.scope,
          r.areas,
          (slug) => products.get(slug) ?? slug,
          t.symbols.separator,
          io.env,
        ),
      ),
    ),
  ];
  io.stdout.write(
    rowsText(
      t,
      [
        [
          "Roles",
          roleNames.length
            ? roleNames.flatMap(
                (r, i): Line => [
                  ...(i ? [text(", ")] : []),
                  text(r, { unit: true }),
                ],
              )
            : [text("None")],
        ],
        ["Token", tokenLine(t, label, hint)],
        ["Ends", [text(day(expiresAt, io.env), { unit: true })]],
        ["Saved in", [text(backend, { unit: true })]],
      ],
      { indent: 3, label: 10 },
    ),
  );
  // Under the text after the glyph (3 columns in), as the rows are.
  io.stdout.write(
    `\n${t.caps.columns < 32 ? "" : "   "}End it with ${t.painter.style("pkey logout", ["strong"])}.\n`,
  );
  if (previous === "not-revoked") {
    const until = a.previous?.expiresAt
      ? ` until ${day(a.previous.expiresAt, io.env)}`
      : "";
    const errT = io.term(io.stderr);
    const old = a.previous ? shown(hintOf(a.previous), io.env) : "";
    io.stderr.write(
      `\n${block(errT, "warn", [
        [
          text(
            `Couldn't end your previous sign-in (pkeyp_${errT.symbols.ellipsis}${old}), so it still works${until}. Revoke it at `,
          ),
          text(personalTokens, { break: "url", link: personalTokens }),
        ],
      ])}`,
    );
  }
  return 0;
}
