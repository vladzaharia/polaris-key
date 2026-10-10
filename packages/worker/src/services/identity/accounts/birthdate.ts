/**
 * The account's optional birth date (I-33; plans/I-27.md §2.4): `accounts.birthdate`
 * (`YYYY-MM-DD`) and `accounts.birthdate_source` (`user` or `connection:<id>`).
 *
 * ── WHERE A VALUE COMES FROM ────────────────────────────────────────────────────────────────
 *
 *   - A connection's mapped `birthdate` claim rides ONLY in the sign-in's gate record (I-02's
 *     store, 15 minutes), as FinishStep's offer (`card/gate.ts`). It is written to the account
 *     only when the person accepts it there; edited first, its source becomes `user`.
 *   - Account → Profile adds, changes or removes it (`PATCH /api/me/profile`, source `user`).
 *   - Nothing else stores it: not `account_links`, not the audit, not a log line, not the sign-in
 *     flow once it ends.
 *
 * ── WHERE IT NEVER GOES ─────────────────────────────────────────────────────────────────────
 *
 * No consent item, device response, developer API, Users page, developer export or `id_token`
 * carries it. The person's own profile (`GET /api/me/profile`) is the one route that answers it
 * (and their full export, I-11). Age booleans, `minimumAge` and `identity.minimumAge` are not
 * built until a product gates content.
 */

import type { DbStatement } from "../../../db/types.js";

/** `YYYY-MM-DD`, the stored form and OpenID Connect Core §5.1's full form of the claim. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The earliest birth date accepted. */
export const BIRTHDATE_MIN = "1900-01-01";

/** A connection id inside `connection:<id>` (the identity_connections row's id, I-30). */
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type BirthdateSource = "user" | `connection:${string}`;

/** A birth date the person accepted, with where it came from. */
export interface BirthdateChoice {
  value: string;
  source: BirthdateSource;
}

/** What the profile API answers for the source (no connection label until I-30's rows exist). */
export type BirthdateSourceView =
  | { kind: "user" }
  | { kind: "connection"; connectionId: string };

/** The UTC calendar day of `now` (epoch seconds), plus `days`, as `YYYY-MM-DD`. */
function utcDay(now: number, days = 0): string {
  return new Date((now + days * 86_400) * 1000).toISOString().slice(0, 10);
}

/**
 * A real calendar date from {@link BIRTHDATE_MIN} to tomorrow in UTC (somewhere east of UTC it is
 * already tomorrow), or `null`. Strict: exactly `YYYY-MM-DD`, no time, no week or ordinal form, no
 * partial date. `now` is epoch seconds.
 */
export function parseBirthdate(raw: unknown, now: number): string | null {
  if (typeof raw !== "string") return null;
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  // Day 0 of the next month is the last day of this one (leap years included).
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  if (raw < BIRTHDATE_MIN || raw > utcDay(now, 1)) return null;
  return raw;
}

/**
 * A connection's `birthdate` claim as FinishStep's offer, or `null`. OpenID Connect Core §5.1
 * lets a provider withhold the year (`0000-MM-DD`) or send the year alone (`YYYY`); only a full
 * date is offered, so neither is.
 */
export function claimBirthdate(raw: unknown, now: number): string | null {
  return parseBirthdate(raw, now);
}

/** The `connection:<id>` source of a claim, or `null` for an id that cannot be one. */
export function connectionSource(id: unknown): BirthdateSource | null {
  return typeof id === "string" && CONNECTION_ID_RE.test(id)
    ? `connection:${id}`
    : null;
}

/** The stored source as the profile API shows it; `null` for none or an unknown spelling. */
export function birthdateSourceView(
  stored: string | null | undefined,
): BirthdateSourceView | null {
  if (stored === "user") return { kind: "user" };
  if (typeof stored === "string" && stored.startsWith("connection:")) {
    const id = stored.slice("connection:".length);
    if (CONNECTION_ID_RE.test(id))
      return { kind: "connection", connectionId: id };
  }
  return null;
}

/** Set (or, with `null`, remove) the account's birth date and its source together. */
export function stmtSetBirthdate(
  accountId: string,
  choice: BirthdateChoice | null,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE accounts SET birthdate = ?, birthdate_source = ?, modified_at = ?
           WHERE id = ?`,
    params: [choice?.value ?? null, choice?.source ?? null, now, accountId],
  };
}

/**
 * FinishStep's write: the accepted birth date, only onto an account that has none. A new account
 * never has one; an existing account that passes the gate keeps the one it chose before (Account
 * → Profile is where it changes).
 */
export function stmtFillBirthdate(
  accountId: string,
  choice: BirthdateChoice,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE accounts SET birthdate = ?, birthdate_source = ?, modified_at = ?
           WHERE id = ? AND birthdate IS NULL`,
    params: [choice.value, choice.source, now, accountId],
  };
}
