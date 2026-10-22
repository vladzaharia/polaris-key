/**
 * `pkey whoami` and `pkey logout` (ST-34.7); `pkey login` is login.ts (ST-34.8), which shares
 * these helpers.
 *
 * A refusal is a ▲ block on stderr and exit 4 (D-6); a failure (network, server, a host that is
 * not a console) is ✗ and exit 1. `--json` always writes one line to stdout in the validate and
 * doctor envelope, `{"v":1,"command","event":"result","ok","exit","error","message",…}`, and
 * nothing to stderr. The token is never printed: not on a screen, in `--json`, in an error or
 * under `PKEY_DEBUG`; only a label and its last four characters are. Only the credential's origin
 * leaves this process with it, and a redirect is never followed, so the Authorization header
 * cannot be carried to another host.
 */

import {
  cellWidth,
  wrapSpans,
  type Line,
  type Role,
  type Span,
} from "@polaris-key/node/terminal";
import { ADMIN_TOKEN_ENV, DEFAULT_BASE_URL, maskTokens } from "./bundle.js";
import { UsageError } from "./errors.js";
import {
  adminCredential,
  hintOf,
  originOf,
  Refusal,
  COMMAND_AGAIN,
  type CredentialStore,
  type ResolvedCredential,
} from "./credentials.js";
import type { Term, TermOut } from "./terminal.js";
import { untrusted, untrustedJson, type UntrustedEnv } from "./untrusted.js";

export const WHOAMI_USAGE = "pkey whoami [--base-url url] [--json]";
export const LOGOUT_USAGE = "pkey logout [--base-url url] [--json]";

export interface AccountIo {
  baseUrl: string;
  /** True when `--base-url` was given (a rerun line repeats it). */
  baseUrlGiven?: boolean;
  json: boolean;
  env: UntrustedEnv;
  stdout: TermOut;
  stderr: TermOut;
  term: (out: TermOut) => Term;
  store: () => Promise<CredentialStore>;
  fetchImpl?: typeof fetch;
  /** Epoch seconds; a test seam. */
  now?: () => number;
}

const COMMAND = { whoami: "whoami", logout: "logout", login: "login" } as const;
export type Command = keyof typeof COMMAND;

/** A failure (exit 1): the sentence, the one fix, and the `--json` error code. */
export class Failure extends Error {
  constructor(
    message: string,
    readonly fix: string | undefined,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    /** The lines as styled spans, when a URL in them must stay whole. */
    readonly lines?: Line[],
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** Bad input to a command (exit 2): a ▲ with the sentence and the one fix. */
export class Usage extends Refusal {
  constructor(
    message: string,
    fix?: string,
    /** The lines as styled spans, when a URL in them must stay whole. */
    readonly lines?: Line[],
  ) {
    super(message, fix, "usage");
    this.name = "Usage";
  }
}

/** The host did not answer (offline, refused, timed out). `cause` is the network error's code. */
export class Unreachable extends Failure {
  constructor(host: string, cause: string | null) {
    super(
      `Can't reach ${host}.`,
      "Check your network, or --base-url.",
      "unreachable",
      cause ? { cause } : {},
    );
    this.name = "Unreachable";
  }
}

/** A 3xx: pkey sent nothing further. */
export class Redirected extends Refusal {
  constructor(host: string) {
    super(
      `${host} answered with a redirect, so pkey sent nothing further.`,
      "Check --base-url.",
      "redirect",
    );
    this.name = "Redirected";
  }
}

/**
 * A local calendar date, `2026-10-26`: the one the person's clock shows. `TZ` from the CLI's own
 * environment is honoured (the tests set it); an unknown zone falls back to the process's.
 */
export function day(epochSeconds: number, env: UntrustedEnv): string {
  const when = new Date(epochSeconds * 1000);
  const parts = (timeZone: string | undefined) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(when)
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
  let p: Record<string, string>;
  try {
    p = parts(env.TZ || undefined);
  } catch {
    p = parts(undefined);
  }
  return `${p["year"]}-${p["month"]}-${p["day"]}`;
}

/** Server text as a screen shows it: cleaned, and a token anywhere in it (an echo) masked. */
export const shown = (value: unknown, env: UntrustedEnv): string =>
  maskTokens(untrusted(value, env));

export const hostOf = (origin: string): string => new URL(origin).host;

export const text = (t: string, extra: Partial<Span> = {}): Span => ({
  text: t,
  ...extra,
});

/** The role each glyph is drawn in: typed, so a name the painter does not know cannot compile. */
const GLYPH_ROLE: Record<"ok" | "warn" | "fail", readonly Role[]> = {
  ok: ["success"],
  warn: ["warning"],
  fail: ["danger"],
};

/**
 * `▲  text` and the lines after it, each paragraph wrapped to the terminal with the continuation
 * hung under the text (3 columns in).
 */
export function block(
  t: Term,
  kind: "ok" | "warn" | "fail",
  paragraphs: Line[],
): string {
  const { painter, symbols, caps } = t;
  const glyph =
    kind === "ok"
      ? painter.style(symbols.ok, GLYPH_ROLE.ok)
      : kind === "warn"
        ? painter.style(symbols.warn, GLYPH_ROLE.warn)
        : painter.style(symbols.fail, GLYPH_ROLE.fail);
  const width = Math.max(1, caps.columns - 3);
  const out: string[] = [];
  for (const para of paragraphs)
    for (const l of wrapSpans(fit(para, width), width))
      out.push(`${out.length === 0 ? `${glyph}  ` : "   "}${painter.line(l)}`);
  return `${out.join("\n")}\n`;
}

export const plain = (...lines: (string | undefined)[]): Line[] =>
  lines.filter((l): l is string => !!l).map((l) => [text(l)]);

/** One `--json` line: ASCII only, no token. */
export function jsonLine(value: Record<string, unknown>): string {
  return `${untrustedJson(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

/** The single `--json` result line: ASCII only, no token. */
export function envelope(
  command: Command,
  exit: number,
  fields: Record<string, unknown>,
): string {
  return jsonLine({
    v: 1,
    command,
    event: "result",
    ok: exit === 0,
    exit,
    ...fields,
  });
}

/** A request that has not answered in this long is a network failure (N3). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The most of a response pkey reads as JSON (N1). */
export const MAX_JSON_BYTES = 64 * 1024;

export function networkCode(e: unknown): string | null {
  if ((e as { name?: unknown } | null)?.name === "TimeoutError")
    return "TIMEOUT";
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? code
    : null;
}

/**
 * A GET or DELETE to the console API with the credential. A redirect is not followed (`Redirected`)
 * and a host that does not answer is `Unreachable`.
 */
export async function call(
  io: AccountIo,
  cred: ResolvedCredential,
  method: "GET" | "DELETE",
  path: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await (io.fetchImpl ?? fetch)(`${cred.origin}/manage/api${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${cred.token}`,
        accept: "application/json",
      },
    });
  } catch (e) {
    throw new Unreachable(hostOf(cred.origin), networkCode(e));
  }
  if (res.status >= 300 && res.status < 400)
    throw new Redirected(hostOf(cred.origin));
  return res;
}

/**
 * A response body as a JSON object, read through a size cap: a body past `MAX_JSON_BYTES` (a host
 * that streams without end, or a proxy's error page) is `{}` and the rest is never read.
 */
export async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
      void res.body?.cancel().catch(() => undefined);
      return {};
    }
    const reader = res.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        void reader.cancel().catch(() => undefined);
        return {};
      }
      chunks.push(value);
    }
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Run an account command. A `Refusal` is ▲ and exit 4 (a `Usage` is exit 2), a `Failure` is ✗ and
 * exit 1. Under `--json` every exit, an unexpected error included, is the one envelope line on
 * stdout; without it an unexpected error is left to the caller's own one-line report.
 */
export async function guarded(
  io: AccountIo,
  command: Command,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (e) {
    const refusal = e instanceof Refusal;
    if (!refusal && !(e instanceof Failure)) {
      if (!io.json) throw e;
      io.stdout.write(
        envelope(command, 1, {
          error: networkCode(e) ? "network" : "internal",
          message: shown(
            e instanceof Error ? e.message : "pkey hit an unexpected error.",
            io.env,
          ),
        }),
      );
      return 1;
    }
    const exit = e instanceof Usage ? 2 : refusal ? 4 : 1;
    const fix = e.fix?.replace(COMMAND_AGAIN, `run pkey ${command} again`);
    const extra = (e as { extra?: Record<string, unknown> }).extra ?? {};
    if (io.json)
      io.stdout.write(
        envelope(command, exit, {
          error: e.code,
          message: [e.message, fix].filter(Boolean).join(" "),
          ...extra,
        }),
      );
    else
      io.stderr.write(
        block(
          io.term(io.stderr),
          refusal ? "warn" : "fail",
          (e as { lines?: Line[] }).lines ?? plain(e.message, fix),
        ),
      );
    return exit;
  }
}

/**
 * The origin `--base-url` names, or a ▲ usage line when it is not https (http works on localhost):
 * the credential's name never appears in it, since a signed-in person sets none.
 */
export function originFor(io: AccountIo, command: Command): string {
  try {
    return originOf(io.baseUrl);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const message = `pkey ${command} needs an https address.`;
    const use = text(DEFAULT_BASE_URL, { keep: true });
    throw new Usage(
      message,
      `Use ${DEFAULT_BASE_URL}; http works only on localhost.`,
      [
        [text(message)],
        [text("Use "), use, text("; http works only on localhost.")],
      ],
    );
  }
}

function endedRefusal(cred: ResolvedCredential): Refusal {
  return cred.source === "env"
    ? new Refusal(
        `${ADMIN_TOKEN_ENV} was refused. It may have ended, been revoked, or not be an admin token.`,
        "Set a current one, or unset it and run pkey login.",
        "env-token-refused",
      )
    : new Refusal(
        `Your sign-in to ${hostOf(cred.origin)} has ended.`,
        "Run pkey login.",
        "sign-in-ended",
      );
}

/** The console's role names (`roleLabel` in the admin SPA's access/can.ts), by role id. */
export function roleName(
  role: string,
  scope: string,
  productName: (slug: string) => string,
): string {
  switch (role) {
    case "superadmin":
      return "Superadmin";
    case "platform_admin":
      return "Platform admin";
    case "console_access":
      return "Console access";
    case "product_admin":
      return scope.startsWith("product:")
        ? `${productName(scope.slice("product:".length))} admin`
        : "All products admin";
    default:
      return role;
  }
}

interface RawRole {
  role?: unknown;
  scope?: unknown;
  source?: unknown;
}

/**
 * The token as one value: `“label” (pkeyp_…h7Q2)` (the form the console's Personal tokens page
 * lists), or the hint alone when no label was stored. A label is never invented.
 */
export function tokenLine(t: Term, label: string | null, hint: string): Line {
  const quote = t.caps.unicode ? ["“", "”"] : ['"', '"'];
  const masked = `(pkeyp_${t.symbols.ellipsis}${hint})`;
  return label
    ? [
        text(`${quote[0]}${label}${quote[1]}`, { unit: true }),
        text(" "),
        text(masked, { unit: true }),
      ]
    : [text(masked.slice(1, -1), { unit: true })];
}

/**
 * Break a space-free word wider than `width` where it can: a word that is too wide for the row
 * wraps at its own break points (after `-`, before `.`) and then in runs, so nothing overflows.
 */
export function fit(line: Line, width: number): Line {
  return line.flatMap((span): Span[] => {
    // A `keep` span is cut in the middle when it cannot fit a line: wider than the row, it wraps
    // at its own spaces instead (and then at break points), never losing a character.
    const loose: Span =
      cellWidth(span.text) > width ? { ...span, keep: false } : span;
    const parts = loose.text.split(/(\s+)/);
    if (!parts.some((w) => cellWidth(w) > width))
      return [loose === span ? span : loose];
    return parts
      .filter((w) => w !== "")
      .map((w) =>
        cellWidth(w) > width
          ? {
              ...loose,
              text: w,
              keep: false,
              unit: false,
              break: "url" as const,
            }
          : { ...loose, text: w },
      );
  });
}

/**
 * Label and value rows. From 32 columns the labels sit in a gutter (`label` cells after `indent`)
 * and a wrapped value hangs under its first line; below 32 each label is a line of its own with
 * the value at column 0 under it. An empty value is left out.
 */
export function rowsText(
  t: Term,
  rows: readonly [string, Line][],
  opts: { indent: number; label: number },
): string {
  const { caps, painter } = t;
  const stacked = caps.columns < 32;
  const lead = stacked ? 0 : opts.indent + opts.label;
  const room = Math.max(1, caps.columns - lead);
  const out: string[] = [];
  for (const [k, v] of rows) {
    if (!v.length) continue;
    const lines = wrapSpans(fit(v, room), room);
    if (stacked) {
      out.push(painter.style(k, ["muted"]));
      for (const l of lines) out.push(painter.line(l));
      continue;
    }
    lines.forEach((l, i) =>
      out.push(
        `${" ".repeat(opts.indent)}${
          i === 0
            ? painter.style(k.padEnd(opts.label), ["muted"])
            : " ".repeat(opts.label)
        }${painter.line(l)}`,
      ),
    );
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

export function cmdWhoami(io: AccountIo): Promise<number> {
  return guarded(io, "whoami", async () => {
    originFor(io, "whoami");
    const cred = await adminCredential({
      env: io.env,
      baseUrl: io.baseUrl,
      store: io.store,
    });
    const host = hostOf(cred.origin);
    if (cred.token.startsWith("pkeya_"))
      throw new Refusal(
        `${ADMIN_TOKEN_ENV} is an admin API token, not a person's sign-in.`,
        "Unset it, then run pkey login.",
        "admin-api-token",
      );
    const now = (io.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (cred.expiresAt !== null && cred.expiresAt <= now)
      throw endedRefusal(cred);

    const res = await call(io, cred, "GET", "/me");
    if (res.status === 401) throw endedRefusal(cred);
    if (res.status === 403)
      throw new Refusal(
        "The console refused this sign-in.",
        "Run pkey login again, or ask an admin for access.",
        "sign-in-refused",
      );
    if (!res.ok)
      throw new Failure(
        `${host} answered ${res.status}.`,
        "Try again in a minute.",
        "server-error",
        { status: res.status },
      );
    const me = await jsonOf(res);
    if (
      !(typeof me["email"] === "string" && me["email"]) &&
      !(typeof me["sub"] === "string" && me["sub"])
    )
      throw new Failure(
        `${host} didn't answer as a Polaris Key console.`,
        "Check --base-url.",
        "not-a-console",
      );

    const perms = (me["permissions"] ?? {}) as { roles?: RawRole[] };
    const rawRoles = Array.isArray(perms.roles) ? perms.roles : [];
    const products = new Map<string, string>();
    if (Array.isArray(me["products"]))
      for (const p of me["products"] as { slug?: unknown; name?: unknown }[])
        if (typeof p?.slug === "string" && typeof p.name === "string")
          products.set(p.slug, p.name);
    const roleNames = [
      ...new Set(
        rawRoles.map((r) =>
          shown(
            roleName(String(r.role), String(r.scope), (slug) => {
              return products.get(slug) ?? slug;
            }),
            io.env,
          ),
        ),
      ),
    ];
    const supers = rawRoles.filter((r) => r.role === "superadmin");
    const rootOnly =
      supers.length > 0 && supers.every((r) => r.source === "root");
    const ends =
      typeof me["sessionExpiresAt"] === "number"
        ? (me["sessionExpiresAt"] as number)
        : cred.expiresAt;
    const name = shown(me["name"] ?? "", io.env);
    const email = shown(me["email"] ?? "", io.env);
    const label =
      cred.source === "store" && cred.label ? shown(cred.label, io.env) : null;
    const hint = cred.source === "store" ? shown(hintOf(cred), io.env) : null;

    if (io.json) {
      io.stdout.write(
        envelope("whoami", 0, {
          host,
          name,
          email,
          roles: rawRoles.map((r) => ({
            role: shown(r.role, io.env),
            scope: shown(r.scope, io.env),
          })),
          token: {
            type: "personal",
            source: cred.source === "env" ? "environment" : "credential-store",
            scope: "admin",
            ...(label ? { label } : {}),
            ...(hint ? { hint } : {}),
            expiresAt:
              ends === null ? null : new Date(ends * 1000).toISOString(),
          },
        }),
      );
      return 0;
    }

    const t = io.term(io.stdout);
    const rolesLine: Line = roleNames.length
      ? roleNames.flatMap((r, i): Span[] => [
          ...(i ? [text(", ")] : []),
          text(r, { unit: true }),
        ])
      : [text("none")];
    const rows: [string, Line][] = [
      ["Host", [text(host, { break: "url" })]],
      ["Name", name ? [text(name, { unit: true })] : []],
      ["Email", email ? [text(email, { break: "url" })] : []],
      ["Roles", rolesLine],
      [
        "Token",
        cred.source === "store"
          ? tokenLine(t, label, hint ?? "")
          : [text(`personal token from ${ADMIN_TOKEN_ENV}`, { unit: true })],
      ],
      ["Ends", ends === null ? [] : [text(day(ends, io.env), { unit: true })]],
    ];
    io.stdout.write(rowsText(t, rows, { indent: 0, label: 8 }));
    if (rootOnly)
      io.stdout.write(
        `\n${block(
          t,
          "warn",
          plain(
            "Superadmin ends 8 hours after your last console sign-in. Ask for a stored Superadmin role to keep it.",
          ),
        )}`,
      );
    return 0;
  });
}

export function cmdLogout(io: AccountIo): Promise<number> {
  return guarded(io, "logout", async () => {
    originFor(io, "logout");
    const t = io.term(io.stdout);
    const ok = (
      host: string,
      state: { revoked: boolean; cleared: boolean },
      message: string,
    ): number => {
      if (io.json)
        io.stdout.write(envelope("logout", 0, { host, ...state, message }));
      else io.stdout.write(block(t, "ok", plain(message)));
      return 0;
    };

    if (io.env[ADMIN_TOKEN_ENV]?.trim())
      throw new Refusal(
        `pkey is using ${ADMIN_TOKEN_ENV}, which pkey logout doesn't end.`,
        `Unset it, then run pkey logout.`,
        "env-token-refused",
      );
    const origin = originOf(io.baseUrl);
    const host = hostOf(origin);
    const store = await io.store();
    const stored = store.get(origin);
    if (!stored)
      return ok(
        host,
        { revoked: false, cleared: false },
        `Already signed out of ${host}.`,
      );
    const cred: ResolvedCredential = {
      token: stored.token,
      source: "store",
      origin,
      expiresAt: stored.expiresAt,
      label: stored.label ?? null,
      hint: hintOf(stored),
    };
    const now = (io.now ?? (() => Math.floor(Date.now() / 1000)))();

    // What the server did: it revoked, the token had already ended, or it still works (`why`).
    let outcome:
      | { kind: "revoked" }
      | { kind: "ended" }
      | { kind: "live"; why: string; code: string };
    if (cred.expiresAt !== null && cred.expiresAt <= now)
      outcome = { kind: "ended" };
    else {
      try {
        const res = await call(
          io,
          cred,
          "DELETE",
          "/me/personal-tokens/current",
        );
        if (res.ok) outcome = { kind: "revoked" };
        else if (res.status === 401) outcome = { kind: "ended" };
        else {
          const body = await jsonOf(res);
          const err = body["error"] as { code?: unknown } | undefined;
          const notFound =
            res.status === 404 &&
            (err?.code === "not_found" || body["code"] === "not_found");
          if (notFound) outcome = { kind: "ended" };
          else if (
            res.status === 403 ||
            res.status === 409 ||
            res.status === 429
          )
            outcome = {
              kind: "live",
              why: `${host} refused to revoke it (HTTP ${res.status})`,
              code: "revoke-refused",
            };
          else
            outcome = {
              kind: "live",
              why: `${host} didn't revoke it (HTTP ${res.status})`,
              code: res.status >= 500 ? "server-error" : "revoke-refused",
            };
        }
      } catch (e) {
        if (e instanceof Redirected)
          outcome = {
            kind: "live",
            why: `${host} redirected the request`,
            code: "redirect",
          };
        else if (e instanceof Unreachable)
          outcome = {
            kind: "live",
            why: `couldn't reach ${host}`,
            code: "unreachable",
          };
        else throw e;
      }
    }

    // The local copy goes whether or not the revoke was confirmed.
    try {
      store.delete(origin);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      const gone = outcome.kind !== "live";
      throw new Failure(
        gone
          ? "The token is revoked, but pkey couldn't remove it from the credential store."
          : "pkey couldn't remove the sign-in from the credential store.",
        e.code === "keychain-refused"
          ? "Allow pkey access to the credential store, then run pkey logout again."
          : "Run pkey logout again.",
        e.code,
        { host, revoked: gone, cleared: false },
      );
    }

    if (outcome.kind === "revoked")
      return ok(
        host,
        { revoked: true, cleared: true },
        `Signed out of ${host}. The token is revoked.`,
      );
    if (outcome.kind === "ended")
      return ok(
        host,
        { revoked: false, cleared: true },
        `Signed out of ${host}. The token had already ended.`,
      );

    const until =
      cred.expiresAt !== null
        ? `until ${day(cred.expiresAt, io.env)}`
        : "until it ends";
    const message = `Signed out on this computer, but ${outcome.why}, so it still works ${until}.`;
    const revokeUrl = `${origin}/manage/#/personal-tokens`;
    const quote = t.caps.unicode ? ["“", "”"] : ['"', '"'];
    const hint = `pkeyp_${t.symbols.ellipsis}${shown(hintOf(stored), io.env)}`;
    const revokeLine = stored.label
      ? `Revoke ${quote[0]}${shown(stored.label, io.env)}${quote[1]} (${hint}) in Personal tokens:`
      : `Revoke ${hint} in Personal tokens:`;
    if (io.json) {
      io.stdout.write(
        envelope("logout", 1, {
          error: outcome.code,
          message: `${message} ${revokeLine} ${revokeUrl}`,
          host,
          revoked: false,
          cleared: true,
          tokenEndsAt:
            cred.expiresAt === null
              ? null
              : new Date(cred.expiresAt * 1000).toISOString(),
          revokeUrl,
        }),
      );
    } else {
      io.stderr.write(
        block(io.term(io.stderr), "warn", [
          [text(message)],
          [text(revokeLine)],
          [text(revokeUrl, { break: "url" })],
        ]),
      );
    }
    return 1;
  });
}
