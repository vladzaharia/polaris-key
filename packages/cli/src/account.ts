/**
 * `pkey whoami` and `pkey logout` (ST-34.7), and the `pkey login` stub until ST-34.8.
 *
 * A refusal is a ▲ block on stderr and exit 4 (D-6); a failure (network, server, a host that is
 * not a console) is ✗ and exit 1. `--json` always writes one line to stdout in the validate and
 * doctor envelope, `{"v":1,"command","event":"result","ok","exit","error","message",…}`, and
 * nothing to stderr. The token is never printed: not on a screen, in `--json`, in an error or
 * under `PKEY_DEBUG`; only a label and its last four characters are. Only the credential's origin
 * leaves this process with it, and a redirect is never followed, so the Authorization header
 * cannot be carried to another host.
 */

import { wrapSpans, type Line, type Span } from "@polaris-key/node/terminal";
import { ADMIN_TOKEN_ENV } from "./bundle.js";
import {
  adminCredential,
  hintOf,
  originOf,
  Refusal,
  type CredentialStore,
  type ResolvedCredential,
} from "./credentials.js";
import type { Term, TermOut } from "./terminal.js";
import { untrusted, untrustedJson, type UntrustedEnv } from "./untrusted.js";

export const WHOAMI_USAGE = "pkey whoami [--base-url url] [--json]";
export const LOGOUT_USAGE = "pkey logout [--base-url url] [--json]";

export interface AccountIo {
  baseUrl: string;
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
type Command = keyof typeof COMMAND;

/** A failure (exit 1): the sentence, the one fix, and the `--json` error code. */
class Failure extends Error {
  constructor(
    message: string,
    readonly fix: string | undefined,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "Failure";
  }
}

/** The host did not answer (offline, refused, timed out). `cause` is the network error's code. */
class Unreachable extends Failure {
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
class Redirected extends Refusal {
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
function day(epochSeconds: number, env: UntrustedEnv): string {
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
const shown = (value: unknown, env: UntrustedEnv): string =>
  untrusted(value, env).replace(/pkey[ap]_[A-Za-z0-9_-]{20,}/g, "[token]");

const hostOf = (origin: string): string => new URL(origin).host;

const text = (t: string, extra: Partial<Span> = {}): Span => ({
  text: t,
  ...extra,
});

/**
 * `▲  text` and the lines after it, each paragraph wrapped to the terminal with the continuation
 * hung under the text (3 columns in).
 */
function block(
  t: Term,
  kind: "ok" | "warn" | "fail",
  paragraphs: Line[],
): string {
  const { painter, symbols, caps } = t;
  const glyph =
    kind === "ok"
      ? painter.style(symbols.ok, ["success"])
      : kind === "warn"
        ? painter.style(symbols.warn, ["warning"])
        : painter.style(symbols.fail, ["error"]);
  const width = Math.max(1, caps.columns - 3);
  const out: string[] = [];
  for (const para of paragraphs)
    for (const l of wrapSpans(para, width))
      out.push(`${out.length === 0 ? `${glyph}  ` : "   "}${painter.line(l)}`);
  return `${out.join("\n")}\n`;
}

const plain = (...lines: (string | undefined)[]): Line[] =>
  lines.filter((l): l is string => !!l).map((l) => [text(l)]);

/** The single `--json` line: ASCII only, no token. */
function envelope(
  command: Command,
  exit: number,
  fields: Record<string, unknown>,
): string {
  return `${untrustedJson({ v: 1, command, event: "result", ok: exit === 0, exit, ...fields }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

function networkCode(e: unknown): string | null {
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
    ? code
    : null;
}

/**
 * A GET or DELETE to the console API with the credential. A redirect is not followed (`Redirected`)
 * and a host that does not answer is `Unreachable`.
 */
async function call(
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

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Run an account command; a `Refusal` is ▲ and exit 4, a `Failure` is ✗ and exit 1. */
async function guarded(
  io: AccountIo,
  command: Command,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (e) {
    const refusal = e instanceof Refusal;
    if (!refusal && !(e instanceof Failure)) throw e;
    const exit = refusal ? 4 : 1;
    const fix = e.fix;
    if (io.json)
      io.stdout.write(
        envelope(command, exit, {
          error: e.code,
          message: [e.message, fix].filter(Boolean).join(" "),
          ...(e instanceof Failure ? e.extra : {}),
        }),
      );
    else
      io.stderr.write(
        block(
          io.term(io.stderr),
          refusal ? "warn" : "fail",
          plain(e.message, fix),
        ),
      );
    return exit;
  }
}

function endedRefusal(cred: ResolvedCredential): Refusal {
  return cred.source === "env"
    ? new Refusal(
        `${ADMIN_TOKEN_ENV} was refused. It may have ended, been revoked, or isn't an admin token.`,
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
function roleName(
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

export function cmdWhoami(io: AccountIo): Promise<number> {
  return guarded(io, "whoami", async () => {
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
        "sign-in-ended",
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
      cred.source === "store"
        ? shown(cred.label ?? `pkey on ${host}`, io.env)
        : null;

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
            ...(label ? { label, hint: shown(hintOf(cred), io.env) } : {}),
            expiresAt:
              ends === null ? null : new Date(ends * 1000).toISOString(),
          },
        }),
      );
      return 0;
    }

    const t = io.term(io.stdout);
    const labelWidth = 8;
    const quote = t.caps.unicode ? ["“", "”"] : ['"', '"'];
    const ellipsis = t.symbols.ellipsis;
    const tokenLine: Line = [
      text(
        label
          ? `${quote[0]}${label}${quote[1]} (${ellipsis}${shown(hintOf(cred), io.env)})`
          : `personal token from ${ADMIN_TOKEN_ENV}`,
        { unit: true },
      ),
      ...(ends === null
        ? []
        : [text(", "), text(`ends ${day(ends, io.env)}`, { unit: true })]),
    ];
    const rolesLine: Line = roleNames.length
      ? roleNames.flatMap((r, i): Span[] => [
          ...(i ? [text(", ")] : []),
          text(r, { unit: true }),
        ])
      : [text("none")];
    const rows: [string, Line][] = [
      ["Host", [text(host, { keep: true })]],
      ["Name", name ? [text(name, { unit: true })] : []],
      ["Email", email ? [text(email, { keep: true })] : []],
      ["Roles", rolesLine],
      ["Token", tokenLine],
    ];
    const room = Math.max(1, t.caps.columns - labelWidth);
    for (const [k, v] of rows) {
      if (!v.length) continue;
      wrapSpans(v, room).forEach((l, i) => {
        const head =
          i === 0
            ? t.painter.style(k.padEnd(labelWidth), ["muted"])
            : " ".repeat(labelWidth);
        io.stdout.write(`${head}${t.painter.line(l)}\n`);
      });
    }
    if (rootOnly)
      io.stdout.write(
        block(
          t,
          "warn",
          plain(
            "Superadmin from your identity provider lasts 8 hours after a console sign-in. Ask for a stored Superadmin role to keep it in pkey.",
          ),
        ),
      );
    return 0;
  });
}

export function cmdLogout(io: AccountIo): Promise<number> {
  return guarded(io, "logout", async () => {
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
              why: `${host} refused to revoke the token (HTTP ${res.status})`,
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
        "Run pkey logout again.",
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
    const message = `Signed out on this computer, but ${outcome.why}, so the token still works ${until}.`;
    const revokeUrl = `${origin}/manage/#/personal-tokens`;
    const label = shown(stored.label ?? `pkey on ${host}`, io.env);
    const quote = t.caps.unicode ? ["“", "”"] : ['"', '"'];
    const revokeLine = `Revoke ${quote[0]}${label}${quote[1]} (${t.symbols.ellipsis}${shown(hintOf(stored), io.env)}) in Personal tokens:`;
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

export function cmdLogin(io: AccountIo): Promise<number> {
  return guarded(io, "login", async () => {
    throw new Refusal(
      "pkey login is not available in this build yet.",
      undefined,
      "not-available",
    );
  });
}
