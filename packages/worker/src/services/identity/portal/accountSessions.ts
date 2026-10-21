/**
 * Account sessions (I-07; S-16 §5.1 `account_sessions`, §5.4 items 7 and 17): the browser
 * sessions of the Polaris Key account on key.plrs.im, revocable, listable, and ended all at once
 * by "sign out everywhere".
 *
 * The cookie keeps its signed form (`session.ts`: realm-tagged HMAC, CSRF token inside), and now
 * also names a row of `account_sessions` by a random `sid`. The row is the authority: the portal
 * accepts a cookie only while its row exists, is not revoked and has not expired, and belongs to
 * the account the cookie names (or, after a merge, to the survivor its tombstone points at; the
 * merge moved the row). The row's key is the peppered hash of `sid`, so a table dump cannot be
 * replayed as cookies, and the signature means a guessed `sid` alone is not a cookie either.
 *
 * A cookie signed before I-07 carries no `sid` and is refused: every portal visitor signs in once
 * after the deploy, which is the price of making old sessions revocable (the same trade the
 * `__Host-` rename made, R1-08).
 *
 * The cookie is host-only (`__Host-`, `Path=/`), `HttpOnly`, `Secure`, `SameSite=Lax`, and never
 * reaches a product route: the dispatcher strips it (`core/accounts/accountCookies.ts`).
 */

import { hashKey } from "../../../platform/crypto.js";
import { parseJsonStringList } from "../../../platform/json.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import type { Env } from "../../../platform/env.js";
import { getPortalAccount } from "./repo.js";
import {
  buildPortalSessionCookie,
  issuePortalSession,
  SESSION_TTL_SECONDS,
  type PortalSession,
} from "./session.js";

/** A row's `last_seen_at` is refreshed at most this often, so reads stay reads. */
export const SESSION_TOUCH_SECONDS = 5 * 60;
/** Ended (revoked or expired) rows are pruned this long after they end. */
export const SESSION_PRUNE_AFTER_SECONDS = 30 * 86_400;
/**
 * The coarse label a session keeps instead of the browser's identification string: the browser
 * family and the operating system ("Firefox on Windows"), enough for a person to recognise a
 * session in the list, and nothing that fingerprints them (no versions, builds or devices).
 */
export function browserLabel(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? null;
}

export interface AccountSessionRow {
  id_hash: string;
  account_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  user_agent: string | null;
  amr_json: string | null;
}

/** The row key for a cookie's `sid`. */
export function sessionIdHash(env: Env, sid: string): Promise<string> {
  return hashKey(`account-session:${sid}`, env.KEY_HASH_PEPPER);
}

export interface StartedSession {
  /** The `Set-Cookie` value. */
  cookie: string;
  session: PortalSession;
  /** The row key, for a caller that lists sessions and marks the current one. */
  idHash: string;
}

/**
 * One `account_sessions` row for `accountId` that lives `ttlSeconds`, and the random `sid` that
 * names it. The portal cookie (`startAccountSession`) and the console cookie (ST-30,
 * `consoleAccount.ts`) both open their sessions here, so "sign out everywhere" ends both and one
 * table says what is live. Ended rows of the account are pruned as a new one opens.
 */
export async function openAccountSessionRow(
  env: Env,
  db: Db,
  input: {
    accountId: string;
    req?: Request;
    amr: readonly string[];
    ttlSeconds: number;
  },
  now: number,
): Promise<{ sid: string; idHash: string }> {
  const sid = randomToken(32);
  const idHash = await sessionIdHash(env, sid);
  const label = browserLabel(input.req?.headers.get("user-agent"));
  await db.run(
    `INSERT INTO account_sessions
       (id_hash, account_id, created_at, last_seen_at, expires_at, revoked_at, user_agent, amr_json)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    idHash,
    input.accountId,
    now,
    now,
    now + input.ttlSeconds,
    label,
    JSON.stringify(input.amr),
  );
  // Ended rows of this account are pruned as new ones open: the table holds live sessions plus a
  // month of history, never an unbounded log.
  await db.run(
    `DELETE FROM account_sessions
      WHERE account_id = ?
        AND (expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?))`,
    input.accountId,
    now - SESSION_PRUNE_AFTER_SECONDS,
    now - SESSION_PRUNE_AFTER_SECONDS,
  );
  return { sid, idHash };
}

/**
 * Open an account session after a completed sign-in: one row, one signed cookie naming it.
 * `amr` records how the person signed in (`email`, `google`, `passkey`, …), shown on the sessions
 * list and read by step-up checks. `authenticatedAt` is for a session opened WITHOUT a sign-in of
 * its own (PX-W14: a device signed in by another device's approval): the cookie then carries the
 * approver's sign-in time, so it is never fresher than the proof behind it (`issuePortalSession`).
 */
export async function startAccountSession(
  env: Env,
  db: Db,
  input: {
    account: {
      id: string;
      display_name: string | null;
      primary_email: string | null;
    };
    req?: Request;
    amr: readonly string[];
    authenticatedAt?: number;
  },
  now: number,
): Promise<StartedSession> {
  const { sid, idHash } = await openAccountSessionRow(
    env,
    db,
    {
      accountId: input.account.id,
      ...(input.req ? { req: input.req } : {}),
      amr: input.amr,
      ttlSeconds: SESSION_TTL_SECONDS,
    },
    now,
  );
  const { token, session } = await issuePortalSession(
    env,
    {
      accountId: input.account.id,
      name: input.account.display_name,
      email: input.account.primary_email,
      sid,
    },
    now,
    input.authenticatedAt === undefined
      ? {}
      : { authenticatedAt: input.authenticatedAt },
  );
  return { cookie: buildPortalSessionCookie(token), session, idHash };
}

/** What a verified cookie is worth. */
export type AccountSessionCheck =
  /** A live session of an active account; `accountId` is the one the cookie resolves to today. */
  | { status: "live"; accountId: string; idHash: string }
  /** No session: no row, revoked, expired, held by another account, the account not active, or
   *  erased (the erasure ledger holds it). The caller answers 401. */
  | { status: "refused" }
  /** The erasure ledger could not be read, so nothing is granted and nothing is ended. The caller
   *  answers 503 and the browser keeps its cookie. */
  | { status: "unavailable" };

/**
 * The account a verified cookie may act as. The cookie's signature was checked by
 * `verifyPortalSession`; this checks the row: present, not revoked, not expired, held by the
 * account the cookie's id resolves to today, and that account not on the erasure ledger (a D1
 * restore rewinds `accounts` and `account_sessions` to before an erasure; the ledger is what a
 * restore does not touch). Refreshes `last_seen_at` at most every five minutes.
 */
export async function checkAccountSession(
  env: Env,
  db: Db,
  session: PortalSession,
  now: number,
): Promise<AccountSessionCheck> {
  if (typeof session.sid !== "string" || session.sid === "")
    return { status: "refused" };
  const idHash = await sessionIdHash(env, session.sid);
  const row = await db.first<AccountSessionRow>(
    "SELECT * FROM account_sessions WHERE id_hash = ?",
    idHash,
  );
  if (!row || row.revoked_at !== null || row.expires_at <= now)
    return { status: "refused" };
  // The cookie's own account is asked about before `getPortalAccount`, which can resolve it
  // through a merge or copy a legacy row across: nothing is read or written for an erased one.
  const named = await erasureVerdict(env, now, session.accountId);
  if (named !== "clear")
    return { status: named === "erased" ? "refused" : "unavailable" };
  const account = await getPortalAccount(db, session.accountId, now);
  if (!account || account.status !== "active") return { status: "refused" };
  if (row.account_id !== account.id) return { status: "refused" };
  // A cookie of an absorbed account acts as the survivor (the merge moved its rows): that is the
  // account the request would act as, so it is asked about too.
  if (account.id !== session.accountId) {
    const resolved = await erasureVerdict(env, now, account.id);
    if (resolved !== "clear")
      return { status: resolved === "erased" ? "refused" : "unavailable" };
  }
  if (now - row.last_seen_at >= SESSION_TOUCH_SECONDS) {
    await db.run(
      "UPDATE account_sessions SET last_seen_at = ? WHERE id_hash = ?",
      now,
      idHash,
    );
  }
  return { status: "live", accountId: account.id, idHash };
}

export interface AccountSessionView {
  /** The row key (a hash: it cannot be presented as a cookie). */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** The browser family and operating system ("Firefox on Windows"), when known. */
  browser: string | null;
  /** How the person signed in: `email`, `google`, `passkey`, … */
  methods: string[];
  /** The session this request came from. */
  current: boolean;
}

/** The account's live sessions, newest first. */
export async function listAccountSessions(
  db: Db,
  accountId: string,
  currentIdHash: string | null,
  now: number,
): Promise<AccountSessionView[]> {
  const rows = await db.all<AccountSessionRow>(
    `SELECT * FROM account_sessions
      WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id_hash`,
    accountId,
    now,
  );
  return rows.map((r) => ({
    id: r.id_hash,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    browser: r.user_agent,
    methods: parseJsonStringList(r.amr_json),
    current: r.id_hash === currentIdHash,
  }));
}

/** End one of the account's sessions. False when it is not this account's live session. */
export async function revokeAccountSession(
  db: Db,
  accountId: string,
  idHash: string,
  now: number,
): Promise<boolean> {
  const changed = await db.runChanges(
    `UPDATE account_sessions SET revoked_at = ?
      WHERE id_hash = ? AND account_id = ? AND revoked_at IS NULL`,
    now,
    idHash,
    accountId,
  );
  return changed > 0;
}

/** "Sign out everywhere": end every live session of the account (the current one too, unless
 *  `exceptIdHash` names it). Answers how many ended. */
export async function revokeAllAccountSessions(
  db: Db,
  accountId: string,
  now: number,
  exceptIdHash: string | null = null,
): Promise<number> {
  return db.runChanges(
    `UPDATE account_sessions SET revoked_at = ?
      WHERE account_id = ? AND revoked_at IS NULL AND (? IS NULL OR id_hash != ?)`,
    now,
    accountId,
    exceptIdHash,
    exceptIdHash,
  );
}

/** End the session a cookie names, whoever holds it now (sign-out; a merge may have moved it). */
export async function revokeSessionByHash(
  db: Db,
  idHash: string,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE account_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
    now,
    idHash,
  );
}
