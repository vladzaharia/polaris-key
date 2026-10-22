/**
 * `pkey whoami` and `pkey logout` (ST-34.7); `pkey login` is login.ts (ST-34.8), which shares
 * these helpers.
 *
 * A refusal is a ▲ line on stderr and exit 4 (D-6); a failure (network, server) is exit 1. The
 * token is never printed: not on a screen, in `--json`, in an error or under `PKEY_DEBUG`. Only
 * the credential's origin leaves this process with it, and a redirect is never followed, so the
 * Authorization header cannot be carried to another host.
 */

import { wrapSpans } from "@polaris-key/node/terminal";
import { ADMIN_TOKEN_ENV, request } from "./bundle.js";
import {
  adminCredential,
  originOf,
  Refusal,
  type CredentialStore,
  type ResolvedCredential,
} from "./credentials.js";
import type { Term, TermOut } from "./terminal.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

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

export const day = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

/** `▲  text` and an indented fix line, wrapped to the terminal. */
export function refusalText(r: Refusal, t: Term): string {
  const { painter, symbols, caps } = t;
  const width = Math.max(1, caps.columns - 3);
  const body = (text: string, first: boolean) =>
    wrapSpans([{ text }], width)
      .map(
        (l, i) =>
          `${first && i === 0 ? painter.style(symbols.warn, ["warning"]) + "  " : "   "}${painter.line(l)}`,
      )
      .join("\n");
  return `${[body(r.message, true), ...(r.fix ? [body(r.fix, false)] : [])].join("\n")}\n`;
}

export function note(text: string, t: Term, kind: "warn" | "ok"): string {
  const { painter, symbols, caps } = t;
  const glyph =
    kind === "warn"
      ? painter.style(symbols.warn, ["warning"])
      : painter.style(symbols.ok, ["success"]);
  return (
    wrapSpans([{ text }], Math.max(1, caps.columns - 3))
      .map((l, i) => `${i === 0 ? `${glyph}  ` : "   "}${painter.line(l)}`)
      .join("\n") + "\n"
  );
}

export const hostOf = (origin: string): string => new URL(origin).host;

/** A GET or DELETE to the console API with the credential; a redirect is a failure, not followed. */
export async function call(
  io: AccountIo,
  cred: ResolvedCredential,
  method: "GET" | "DELETE",
  path: string,
): Promise<Response> {
  const res = await request(
    io.fetchImpl ?? fetch,
    `${cred.origin}/manage/api${path}`,
    {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${cred.token}`,
        accept: "application/json",
      },
    },
  );
  if (res.status >= 300 && res.status < 400)
    throw new Refusal(
      `${hostOf(cred.origin)} answered with a redirect, so pkey sent nothing further.`,
      "Check --base-url.",
    );
  return res;
}

export async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Run an account command; a `Refusal` becomes ▲ on stderr and exit 4. */
export async function guarded(
  io: AccountIo,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Refusal) {
      io.stderr.write(refusalText(e, io.term(io.stderr)));
      return 4;
    }
    throw e;
  }
}

function endedRefusal(cred: ResolvedCredential): Refusal {
  return cred.source === "env"
    ? new Refusal(
        `${ADMIN_TOKEN_ENV} was refused. It may have ended or been revoked.`,
        "Set a current one, or unset it and run pkey login.",
      )
    : new Refusal(
        `Your sign-in to ${hostOf(cred.origin)} has ended.`,
        "Run pkey login.",
      );
}

export function cmdWhoami(io: AccountIo): Promise<number> {
  return guarded(io, async () => {
    const cred = await adminCredential({
      env: io.env,
      baseUrl: io.baseUrl,
      store: io.store,
    });
    if (cred.token.startsWith("pkeya_"))
      throw new Refusal(
        `${ADMIN_TOKEN_ENV} is an admin API token (pkeya_), which has no person behind it.`,
        "Run pkey login for a personal sign-in.",
      );
    const now = (io.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (cred.expiresAt !== null && cred.expiresAt <= now)
      throw endedRefusal(cred);

    const res = await call(io, cred, "GET", "/me");
    if (res.status === 401) throw endedRefusal(cred);
    if (res.status === 403)
      throw new Refusal(
        "The console refused this sign-in, usually because Superadmin access needs a recent console sign-in.",
        "Sign in to the console, then run pkey whoami again.",
      );
    if (!res.ok)
      throw new Error(
        `Could not read your identity from ${hostOf(cred.origin)} (HTTP ${res.status}).`,
      );
    const me = await jsonOf(res);
    const perms = (me["permissions"] ?? {}) as {
      roles?: { role?: unknown; scope?: unknown }[];
    };
    const roles = [
      ...new Set(
        (perms.roles ?? []).map(
          (r) => `${untrusted(r.role, io.env)} (${untrusted(r.scope, io.env)})`,
        ),
      ),
    ];
    const superadmin = (perms.roles ?? []).some((r) => r.role === "superadmin");
    const ends =
      typeof me["sessionExpiresAt"] === "number"
        ? (me["sessionExpiresAt"] as number)
        : cred.expiresAt;
    const name = untrusted(me["name"] ?? "", io.env);
    const email = untrusted(me["email"] ?? "", io.env);
    const host = hostOf(cred.origin);

    if (io.json) {
      io.stdout.write(
        `${JSON.stringify({
          v: 1,
          command: "whoami",
          ok: true,
          host,
          name,
          email,
          roles: (perms.roles ?? []).map((r) => ({
            role: untrusted(r.role, io.env),
            scope: untrusted(r.scope, io.env),
          })),
          token: {
            type: "personal",
            source: cred.source === "env" ? "environment" : "credential-store",
            scope: "admin",
            expiresAt:
              ends === null ? null : new Date(ends * 1000).toISOString(),
          },
        })}\n`,
      );
      return 0;
    }

    const t = io.term(io.stdout);
    const label = (s: string) => t.painter.style(s.padEnd(8), ["muted"]);
    const rows: [string, string][] = [
      ["Host", host],
      ["Name", name],
      ["Email", email],
      ["Roles", roles.length ? roles.join(", ") : "none"],
      [
        "Token",
        `personal (admin)${ends === null ? "" : `, ends ${day(ends)}`}${cred.source === "env" ? `, from ${ADMIN_TOKEN_ENV}` : ""}`,
      ],
    ];
    for (const [k, v] of rows) if (v) io.stdout.write(`${label(k)}${v}\n`);
    if (superadmin)
      io.stdout.write(
        note(
          "Superadmin access lapses without a recent console sign-in. Sign in to the console to keep it.",
          t,
          "warn",
        ),
      );
    return 0;
  });
}

export function cmdLogout(io: AccountIo): Promise<number> {
  return guarded(io, async () => {
    const t = io.term(io.stdout);
    const done = (
      code: number,
      host: string,
      state: { revoked: boolean; cleared: boolean },
      text: string,
      kind: "ok" | "warn" = "ok",
      fix?: string,
    ): number => {
      if (io.json)
        io.stdout.write(
          `${JSON.stringify({ v: 1, command: "logout", ok: kind === "ok", host, ...state })}\n`,
        );
      else
        (kind === "ok" ? io.stdout : io.stderr).write(
          kind === "ok"
            ? note(text, t, "ok")
            : refusalText(new Refusal(text, fix), io.term(io.stderr)),
        );
      return code;
    };

    if (io.env[ADMIN_TOKEN_ENV]?.trim())
      throw new Refusal(
        `${ADMIN_TOKEN_ENV} is set, and pkey only ends a sign-in it stored.`,
        "Revoke that token in the console, then unset it.",
      );
    const origin = originOf(io.baseUrl);
    const store = await io.store();
    const stored = store.get(origin);
    if (!stored)
      return done(
        0,
        hostOf(origin),
        { revoked: false, cleared: false },
        `Not signed in to ${hostOf(origin)}.`,
      );
    const cred: ResolvedCredential = {
      token: stored.token,
      source: "store",
      origin,
      expiresAt: stored.expiresAt,
    };
    const host = hostOf(origin);
    let outcome: "revoked" | "ended" | "unreached" = "revoked";
    try {
      const res = await call(io, cred, "DELETE", "/me/personal-tokens/current");
      // 401/404: the token had already ended, which is what logout wants.
      if (res.status === 401 || res.status === 404) outcome = "ended";
      else if (!res.ok) outcome = "unreached";
    } catch (e) {
      if (e instanceof Refusal) throw e;
      outcome = "unreached";
    }
    store.delete(cred.origin);

    if (outcome !== "unreached")
      return done(
        0,
        host,
        { revoked: outcome === "revoked", cleared: true },
        outcome === "revoked"
          ? `Signed out of ${host}. The token is revoked.`
          : `Signed out of ${host}. The token had already ended.`,
      );
    const until =
      cred.expiresAt !== null
        ? `until ${day(cred.expiresAt)}`
        : "until it ends";
    return done(
      1,
      host,
      { revoked: false, cleared: true },
      `Signed out here, but ${host} could not be reached to revoke the token. It stays valid ${until}.`,
      "warn",
      `Revoke it at ${cred.origin}/manage/#/personal-tokens.`,
    );
  });
}
