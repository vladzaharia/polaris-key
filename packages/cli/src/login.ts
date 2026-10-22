/**
 * `pkey login` (ST-34.8): sign in to the console from this terminal with the device flow.
 *
 *   start    POST /api/device-login/start {purpose:"cli", scope:"admin", client}. The answer's
 *            code is shown and its binding cookie is kept in memory.
 *   approve  The person opens <origin>/manage/device?code=… (built here from the origin and the
 *            code, never taken from the answer), checks the code matches, and approves.
 *   poll     GET /api/device-login/<id> with the cookie until approved, denied, expired or refused.
 *   store    The token goes to the OS credential store under the origin, read back to prove it.
 *
 * Security properties (each has a test in test/login.test.ts):
 *   phishing   the code is shown in reverse video with "Check that the code in your browser
 *              matches", and the approval URL is built from the origin pkey itself resolved.
 *   cookie     held in memory, sent only to the origin it came from, never printed or stored.
 *   https      `originOf` (https, or http on loopback) runs before any request; every request is
 *              `redirect: "manual"` and a 3xx is refused.
 *   no echo    the token appears nowhere: not in output, `--json`, errors or the label. The hint
 *              is its last four characters.
 *   CI         refuses before the network or the credential store is touched.
 *   store      opened and probed BEFORE start, so an approval never mints a token that cannot be
 *              kept; a failed write revokes the new token; the write is read back.
 */

import { spawn } from "node:child_process";
import { hostname as osHostname, platform as osPlatform } from "node:os";
import { ADMIN_TOKEN_ENV, request } from "./bundle.js";
import {
  call,
  guarded,
  hostOf,
  jsonOf,
  note,
  type AccountIo,
} from "./account.js";
import {
  isCredentialShape,
  originOf,
  Refusal,
  type CredentialStore,
} from "./credentials.js";
import { Spinner, type Term, type TermFlags } from "./terminal.js";
import { untrusted } from "./untrusted.js";
import { CLI_VERSION } from "./version.js";
import { wrapSpans } from "@polaris-key/node/terminal";

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

type Painted = (s: string) => string;

/** True under a CI system: `CI` set to anything but empty, 0 or false. */
function underCi(env: AccountIo["env"]): boolean {
  const v = env["CI"]?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
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

/** A terminal state of the flow: the JSON line, the human text and the exit code. */
interface Outcome {
  /** The `error` code in --json. */
  state: string;
  exit: number;
  /** ▲ for a refusal or a decision, ✗ for a failure. */
  kind: "warn" | "fail";
  text: string;
  /** Lines under the message; a bare URL is never wrapped. */
  fix?: string[];
  extra?: Record<string, unknown>;
}

/** `▲  text` or `✗  text`, then the fix lines indented under it. */
function outcomeText(
  o: Pick<Outcome, "kind" | "text" | "fix">,
  t: Term,
): string {
  const { painter, symbols, caps } = t;
  const width = Math.max(1, caps.columns - 3);
  const glyph =
    o.kind === "warn"
      ? painter.style(symbols.warn, ["warning"])
      : painter.style(symbols.fail, ["danger"]);
  const wrap = (text: string, first: boolean) =>
    /^https?:\/\/\S+$/.test(text)
      ? `   ${text}`
      : wrapSpans([{ text }], width)
          .map(
            (l, i) =>
              `${first && i === 0 ? `${glyph}  ` : "   "}${painter.line(l)}`,
          )
          .join("\n");
  return `${[wrap(o.text, true), ...(o.fix ?? []).map((f) => wrap(f, false))].join("\n")}\n`;
}

/** Local calendar date, `2026-10-29`. */
function localDay(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A role as a person reads it: "Admin (djdl)", "Superadmin (platform)". */
function roleLabel(role: string, scope: string): string {
  const name = role.charAt(0).toUpperCase() + role.slice(1);
  const where = scope.startsWith("product:") ? scope.slice(8) : scope;
  return where ? `${name} (${where})` : name;
}

export function cmdLogin(io: LoginIo): Promise<number> {
  const given = Object.fromEntries(
    Object.entries(io.seams).filter(([, v]) => v !== undefined),
  );
  const seams: LoginSeams = { ...defaultSeams(), ...given };
  let code = 0;
  return guarded(io, async () => {
    try {
      code = await flow(io, seams);
    } catch (e) {
      // A refusal before or after the flow: in --json it is one line on stdout, not text on stderr.
      if (io.json && e instanceof Refusal) {
        io.stdout.write(
          `${JSON.stringify({ v: 1, command: "login", event: "result", ok: false, exit: 4, error: "refused", message: e.message, ...(e.fix ? { fix: e.fix } : {}) })}\n`,
        );
        return 4;
      }
      throw e;
    }
    return code;
  });
}

async function flow(io: LoginIo, seams: LoginSeams): Promise<number> {
  // 1. CI: before the network and before the credential store.
  if (underCi(io.env))
    throw new Refusal(
      `pkey login needs a person; in CI use ${ADMIN_TOKEN_ENV}.`,
    );

  // 2. The origin: https, or http on loopback; the one string every request and the store use.
  const origin = originOf(io.baseUrl);
  const host = hostOf(origin);
  const platform = seams.platform ?? osPlatform();
  const now = seams.now ?? Date.now;
  const sleep = seams.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const f = io.fetchImpl ?? fetch;

  // 3. Open and probe the store BEFORE start: an approval mints a 7-day admin token.
  const store: CredentialStore = await io.store();
  const existing = store.get(origin);

  const out = io.term(io.stdout);
  const errTerm = io.term(io.stderr);
  const say = (s: string) => io.stdout.write(s);
  const lines = (text: string, indent = ""): string =>
    wrapSpans([{ text }], Math.max(1, out.caps.columns - indent.length))
      .map((l) => `${indent}${out.painter.line(l)}\n`)
      .join("");

  // 4. A second login first ends the token it replaces (best-effort, to its own origin).
  if (
    existing &&
    (existing.expiresAt === null || existing.expiresAt * 1000 > now())
  ) {
    try {
      await call(
        io,
        {
          token: existing.token,
          source: "store",
          origin,
          expiresAt: existing.expiresAt,
        },
        "DELETE",
        "/me/personal-tokens/current",
      );
    } catch {
      /* best-effort: a token that cannot be reached ends on its own date */
    }
  }

  if (!io.json) {
    say(`${lines(`Polaris Key console ${out.symbols.separator} ${host}`)}\n`);
    if (io.env[ADMIN_TOKEN_ENV]?.trim())
      io.stderr.write(
        note(
          `${ADMIN_TOKEN_ENV} is set and takes precedence over this sign-in. Unset it to use the one pkey login saves.`,
          errTerm,
          "warn",
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
  const startRes = await request(f, `${origin}/api/device-login/start`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      purpose: "cli",
      scope: "admin",
      client: {
        name: "pkey",
        version: CLI_VERSION,
        host: (seams.hostname ?? osHostname)(),
      },
    }),
    signal: abort.signal,
  });
  refuseRedirect(startRes, host);
  if (startRes.status === 429)
    throw new Refusal(
      "Too many sign-in attempts from this network.",
      "Wait a few minutes, then run pkey login again.",
    );
  if ([404, 405, 422, 501].includes(startRes.status))
    throw new Refusal(
      `${host} doesn't offer terminal sign-in; use ${ADMIN_TOKEN_ENV}.`,
    );
  if (startRes.status !== 201)
    throw new Error(
      `${host} did not start a sign-in (HTTP ${startRes.status}).`,
    );
  const started = await jsonOf(startRes);
  const pollId = String(started["id"] ?? "");
  const userCode = String(started["code"] ?? "");
  const cookie = setCookieOf(startRes);
  if (!POLL_ID_SHAPE.test(pollId) || !CODE_SHAPE.test(userCode) || !cookie)
    throw new Error(`${host} answered the sign-in start unexpectedly.`);
  const expiresIn =
    typeof started["expiresIn"] === "number" ? started["expiresIn"] : 300;
  let interval = clampInterval(started["interval"], 3_000);
  const deadline = now() + expiresIn * 1000;
  // Built here, from the origin pkey resolved: a server cannot send the person elsewhere.
  const approveUrl = `${origin}/manage/device?code=${userCode}`;

  // 6. Show the code and the link; open the browser when allowed.
  const mayOpen =
    !io.json &&
    !io.noBrowser &&
    !io.env["SSH_CONNECTION"] &&
    !io.env["SSH_TTY"] &&
    hasDisplay(io.env, platform);
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
      `${JSON.stringify({ v: 1, command: "login", event: "started", host, code: userCode, url: approveUrl, expiresIn })}\n`,
    );
  } else {
    const opened = mayOpen ? await open() : false;
    if (opened)
      say(lines(`Opening Polaris Key in your browser${out.symbols.ellipsis}`));
    say(lines(opened ? "Didn't open? Go to" : "Open this link in a browser:"));
    say(`${approveUrl}\n\n`);
    say(lines("Check that the code in your browser matches:"));
    say(`${out.painter.style(` ${userCode} `, ["code"])}\n\n`);
  }

  const spinner = new Spinner(io.stderr, io.env, io.flags);
  const wrapped = spinner.wrap(io.stdout);
  const wsay = (s: string) => wrapped.write(s);
  let cleanup: (() => void)[] = [];
  const finish = <T>(v: T): T => {
    spinner.stop();
    for (const c of cleanup) c();
    cleanup = [];
    return v;
  };

  const removeInterrupt = (seams.onInterrupt ?? (() => () => {}))(() =>
    cancel("interrupt"),
  );
  cleanup.push(removeInterrupt);

  if (interactive) {
    const stdin = seams.stdin!;
    const keys = [
      mayOpen ? "Enter open again" : "",
      "c copy the code",
      "Esc cancel",
    ].filter(Boolean);
    say(
      `${wrapSpans(
        [{ text: keys.join(` ${out.symbols.separator} `) }],
        Math.max(1, out.caps.columns - 2),
      )
        .map((l) => `  ${out.painter.style(out.painter.line(l), ["muted"])}\n`)
        .join("")}\n`,
    );
    const onData = (chunk: Buffer | string) => {
      const k = chunk.toString();
      if (k === "\x03") cancel("interrupt");
      else if (k === "\x1b") cancel("esc");
      else if ((k === "\r" || k === "\n") && mayOpen) void open();
      else if (k === "c" || k === "C")
        void (seams.copyText ?? defaultCopy)(userCode).then((ok) =>
          wsay(
            ok
              ? note(`Copied ${userCode}.`, out, "ok")
              : note("No clipboard here.", out, "warn"),
          ),
        );
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

  if (!io.json) {
    if (spinner.active)
      spinner.stage("Waiting for you to approve in the browser");
    else
      say(
        lines(
          `Waiting for you to approve in the browser${out.symbols.ellipsis}`,
        ),
      );
  }

  const report = (o: Outcome): number => {
    finish(undefined);
    if (io.json)
      io.stdout.write(
        `${JSON.stringify({ v: 1, command: "login", event: "result", ok: false, exit: o.exit, error: o.state, message: o.text, host, code: userCode, ...o.extra })}\n`,
      );
    else io.stderr.write(outcomeText(o, errTerm));
    return o.exit;
  };
  const rerun = ["Run pkey login to try again."];

  // 7. Poll with the server's interval, backing off on 429 and on network failures.
  let failures = 0;
  while (true) {
    await wait(interval);
    if (cancelled) return cancelOutcome(finish, io, cancelled, errTerm, host);
    if (now() >= deadline)
      return report({
        state: "expired",
        exit: 1,
        kind: "fail",
        text: `Code ${userCode} expired before it was approved.`,
        fix: ["Run pkey login to get a new one."],
      });
    let res: Response;
    try {
      res = await request(f, `${origin}/api/device-login/${pollId}`, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/json",
          cookie: `${COOKIE_NAME}=${cookie}`,
        },
        signal: abort.signal,
      });
    } catch {
      if (cancelled) return cancelOutcome(finish, io, cancelled, errTerm, host);
      if (++failures >= NETWORK_FAILURES)
        return report({
          state: "error",
          exit: 1,
          kind: "fail",
          text: `Lost contact with ${host} while waiting for code ${userCode}.`,
          fix: rerun,
        });
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      finish(undefined);
      refuseRedirect(res, host);
    }
    if (res.status === 429 || res.status === 503) {
      if (++failures >= NETWORK_FAILURES)
        return report({
          state: "error",
          exit: 1,
          kind: "fail",
          text: `${host} is not answering right now (HTTP ${res.status}).`,
          fix: rerun,
        });
      interval = Math.min(interval * 2, MAX_INTERVAL_MS);
      continue;
    }
    failures = 0;
    if (res.status === 410)
      return report({
        state: "expired",
        exit: 1,
        kind: "fail",
        text: `Code ${userCode} expired before it was approved.`,
        fix: ["Run pkey login to get a new one."],
      });
    const body = await jsonOf(res);
    if (res.status === 409 && body["reason"] === "token_limit") {
      const limit = /at most (\d{1,3}) /.exec(
        String(body["message"] ?? ""),
      )?.[1];
      return report({
        state: "token_limit",
        exit: 4,
        kind: "warn",
        text: limit
          ? `You already have ${limit} personal tokens, the most allowed.`
          : "You already have the most personal tokens allowed.",
        fix: [
          "Revoke one in Personal tokens, then run pkey login again.",
          `${origin}/manage/#/personal-tokens`,
        ],
        extra: { url: `${origin}/manage/#/personal-tokens` },
      });
    }
    if (res.status === 403)
      return report({
        state: "refused",
        exit: 4,
        kind: "warn",
        text: "This account can't sign in.",
        fix: ["Ask a Superadmin to check your access."],
      });
    if (!res.ok)
      return report({
        state: "error",
        exit: 1,
        kind: "fail",
        text: `${host} refused the sign-in (HTTP ${res.status}).`,
        fix: rerun,
      });
    const status = body["status"];
    if (status === "pending") {
      interval = clampInterval(body["interval"], interval);
      continue;
    }
    if (status === "denied")
      return report({
        state: "denied",
        exit: 4,
        kind: "warn",
        text: `Code ${userCode} was denied in the browser.`,
        fix: rerun,
      });
    if (status !== "approved")
      return report({
        state: "error",
        exit: 1,
        kind: "fail",
        text: `${host} answered the sign-in unexpectedly.`,
        fix: rerun,
      });
    finish(undefined);
    return approved(io, {
      origin,
      host,
      platform,
      store,
      token: body["token"],
      expiresAt: body["expiresAt"],
    });
  }
}

function refuseRedirect(res: Response, host: string): void {
  if (res.status >= 300 && res.status < 400)
    throw new Refusal(
      `${host} answered with a redirect, so pkey sent nothing further.`,
      "Check --base-url.",
    );
}

function clampInterval(v: unknown, fallback: number): number {
  return typeof v === "number" && v > 0
    ? Math.min(Math.max(v * 1000, 1_000), MAX_INTERVAL_MS)
    : fallback;
}

function cancelOutcome(
  finish: <T>(v: T) => T,
  io: LoginIo,
  _why: "esc" | "interrupt",
  errTerm: ReturnType<LoginIo["term"]>,
  host: string,
): number {
  finish(undefined);
  const exit = 130;
  if (io.json)
    io.stdout.write(
      `${JSON.stringify({ v: 1, command: "login", event: "result", ok: false, exit, error: "cancelled", message: "Cancelled.", host })}\n`,
    );
  else io.stderr.write(note("Cancelled. Nothing was saved.", errTerm, "warn"));
  return exit;
}

/** The approved path: validate, store, read back, then say who is signed in. */
async function approved(
  io: LoginIo,
  a: {
    origin: string;
    host: string;
    platform: NodeJS.Platform;
    store: CredentialStore;
    token: unknown;
    expiresAt: unknown;
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
    throw new Error(`${host} answered the sign-in unexpectedly.`);
  const token = a.token;
  const expiresAt = a.expiresAt;
  const cred = {
    token,
    source: "store" as const,
    origin,
    expiresAt,
  };

  // Write, then read back. A store that cannot keep it gets the new token revoked.
  let kept = false;
  try {
    store.set(origin, { token, expiresAt });
    kept = store.get(origin)?.token === token;
  } catch {
    kept = false;
  }
  if (!kept) {
    try {
      await call(io, cred, "DELETE", "/me/personal-tokens/current");
    } catch {
      /* best-effort: the token ends on its own date */
    }
    throw new Refusal(
      "The credential store wouldn't keep the token, so pkey ended it.",
      `Fix the ${backendName(a.platform)}, or set ${ADMIN_TOKEN_ENV} instead.`,
    );
  }

  // Who is it? The new token reads its own identity; failing that, still signed in.
  let name = "";
  let email = "";
  let roles: { role: string; scope: string }[] = [];
  try {
    const res = await call(io, cred, "GET", "/me");
    if (res.ok) {
      const me = await jsonOf(res);
      name = untrusted(me["name"] ?? "", io.env);
      email = untrusted(me["email"] ?? "", io.env);
      const perms = (me["permissions"] ?? {}) as {
        roles?: { role?: unknown; scope?: unknown }[];
      };
      roles = (perms.roles ?? []).map((r) => ({
        role: untrusted(r.role, io.env),
        scope: untrusted(r.scope, io.env),
      }));
    }
  } catch {
    /* identity is a nicety; the sign-in stands */
  }

  const backend = backendName(a.platform);
  const t = io.term(io.stdout);
  const hint = `pkeyp_${t.symbols.ellipsis}${token.slice(-4)}`;
  if (io.json) {
    io.stdout.write(
      `${JSON.stringify({
        v: 1,
        command: "login",
        event: "result",
        ok: true,
        exit: 0,
        host,
        name,
        email,
        roles,
        token: {
          type: "personal",
          scope: "admin",
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        storedIn: backend,
      })}\n`,
    );
    return 0;
  }
  const who = name ? `${name}${email ? ` (${email})` : ""}` : email;
  io.stdout.write(
    `\n${note(who ? `Signed in to ${host} as ${who}` : `Signed in to ${host}`, t, "ok")}\n`,
  );
  const label = (k: string) => t.painter.style(k.padEnd(10), ["muted"]);
  const width = Math.max(1, t.caps.columns - 12);
  const rows: [string, string][] = [];
  if (roles.length)
    rows.push([
      "Roles",
      [...new Set(roles.map((r) => roleLabel(r.role, r.scope)))].join(", "),
    ]);
  const dot = ` ${t.symbols.separator} `;
  rows.push([
    "Token",
    [hint, "admin", `ends ${localDay(expiresAt)}`].join(dot),
  ]);
  rows.push(["Saved in", backend]);
  for (const [k, v] of rows)
    wrapSpans([{ text: v }], width).forEach((l, i) =>
      io.stdout.write(
        `  ${i === 0 ? label(k) : " ".repeat(10)}${t.painter.line(l)}\n`,
      ),
    );
  io.stdout.write(`\n  End it with pkey logout.\n`);
  return 0;
}
