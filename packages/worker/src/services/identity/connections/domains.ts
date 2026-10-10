/**
 * Connection domains, write side (I-30; plans/I-27.md §2.3 "Domains"). Identity is the only
 * writer of `identity_connection_domains`; every reader goes through `core/oidc/connections.ts`.
 *
 * ── THE PROOF ───────────────────────────────────────────────────────────────────────────────
 *
 * A TXT record at `_pkey-challenge.<domain>` must hold `pkey-domain-verification=<token>`, with
 * one random token per connection and domain, so one connection's record never proves another's
 * claim. The Worker reads it over DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`, the
 * JSON API) through the one gated fetch (`core/oidc/client.ts`), whose allowlist here is exactly
 * that host (`DOH_HOSTS`): no other code dials it, and this module dials nothing else.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────
 *
 *   - **Exact domains.** `example.com` and `sub.example.com` are two claims with two records.
 *   - **One verified owner.** Each `(scope, domain)` has at most one verified connection: a
 *     second connection's proof is refused as `taken` (and the partial unique index backs it).
 *   - **Fail closed.** A conclusive answer without the token unverifies at once. A resolver
 *     error keeps the current state for `DOMAIN_LAPSE_SECONDS` (72 h) after the last conclusive
 *     answer, then unverifies. An unverified domain does not route, vouch or enforce.
 */

import type { Db } from "../../../db/types.js";
import { randomToken } from "../../../platform/random.js";
import { gatedJson, type OidcFetch } from "../../../core/oidc/client.js";
import {
  normalizeDomain,
  resolveConnection,
} from "../../../core/oidc/connections.js";

/** The DNS-over-HTTPS resolver: the gated fetch's only host for domain proofs. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const DOH_HOSTS: readonly string[] = ["cloudflare-dns.com"];

/** The TXT record's name prefix and value prefix. */
export const DOMAIN_CHALLENGE_PREFIX = "_pkey-challenge.";
export const DOMAIN_TOKEN_PREFIX = "pkey-domain-verification=";

/** How long resolver errors keep a verified domain verified. */
export const DOMAIN_LAPSE_SECONDS = 72 * 60 * 60;

/** DNS RCODEs as the JSON API reports them. */
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;
const TYPE_TXT = 16;

export type DomainProof = "present" | "absent" | "error";

export interface ConnectionDomainRow {
  connection_id: string;
  scope: string;
  domain: string;
  token: string;
  verified_at: number | null;
  checked_at: number | null;
  enforce: number;
}

/** The name the TXT record lives at. */
export function challengeName(domain: string): string {
  return `${DOMAIN_CHALLENGE_PREFIX}${domain}`;
}

/** The TXT record's exact value for `token`. */
export function challengeValue(token: string): string {
  return `${DOMAIN_TOKEN_PREFIX}${token}`;
}

/**
 * One TXT record's `data` as the JSON API writes it (one or more quoted character-strings,
 * `"abc" "def"`), joined into the record's value. Unquoted data is taken as it is.
 */
export function txtValue(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  if (parts.length === 0) return data.trim();
  return parts.map((m) => m[1]!.replace(/\\(.)/g, "$1")).join("");
}

/**
 * Ask the resolver whether `domain`'s challenge record holds exactly `token`. `present` and
 * `absent` are conclusive answers; anything else (a SERVFAIL, a refused or failed fetch, a
 * malformed answer) is `error`, which the caller treats as "no new information".
 */
export async function lookupDomainProof(
  domain: string,
  token: string,
  opts: { fetch?: OidcFetch } = {},
): Promise<DomainProof> {
  const url = new URL(DOH_URL);
  url.searchParams.set("name", challengeName(domain));
  url.searchParams.set("type", "TXT");
  let doc: Record<string, unknown>;
  try {
    doc = await gatedJson(
      "dns-over-https",
      url.toString(),
      { headers: { accept: "application/dns-json" } },
      DOH_HOSTS,
      opts.fetch,
    );
  } catch {
    // A refused URL, a redirect, a timeout, a non-2xx or a malformed answer: no information.
    return "error";
  }
  const status = doc.Status;
  if (status === RCODE_NXDOMAIN) return "absent";
  if (status !== RCODE_NOERROR) return "error";
  const expected = challengeValue(token);
  const answers = Array.isArray(doc.Answer) ? doc.Answer : [];
  for (const a of answers) {
    if (typeof a !== "object" || a === null) continue;
    const rec = a as Record<string, unknown>;
    if (rec.type !== TYPE_TXT || typeof rec.data !== "string") continue;
    if (txtValue(rec.data) === expected) return "present";
  }
  return "absent";
}

async function domainRow(
  db: Db,
  connectionId: string,
  domain: string,
): Promise<ConnectionDomainRow | null> {
  return db.first<ConnectionDomainRow>(
    `SELECT connection_id, scope, domain, token, verified_at, checked_at, enforce
       FROM identity_connection_domains WHERE connection_id = ? AND domain = ?`,
    connectionId,
    domain,
  );
}

export type AddDomainResult =
  | { ok: true; domain: string; token: string; record: string; value: string }
  | { ok: false; reason: "invalid_domain" | "no_connection" };

/**
 * Claim `domain` for a connection: a pending (unverified) row with a fresh token, or the existing
 * row's token when the claim is already there (idempotent, so a retry never invalidates the
 * record someone already published). Answers the record to publish.
 */
export async function addConnectionDomain(
  db: Db,
  input: { connectionId: string; domain: string },
  now: number,
): Promise<AddDomainResult> {
  const domain = normalizeDomain(input.domain);
  if (!domain) return { ok: false, reason: "invalid_domain" };
  const conn = await resolveConnection(db, input.connectionId);
  if (!conn) return { ok: false, reason: "no_connection" };
  await db.run(
    `INSERT INTO identity_connection_domains (connection_id, scope, domain, token, verified_at,
       checked_at, enforce)
     VALUES (?, ?, ?, ?, NULL, NULL, 0)
     ON CONFLICT (connection_id, domain) DO NOTHING`,
    conn.id,
    conn.scope,
    domain,
    randomToken(32),
  );
  void now;
  const row = await domainRow(db, conn.id, domain);
  if (!row) return { ok: false, reason: "no_connection" };
  return {
    ok: true,
    domain,
    token: row.token,
    record: challengeName(domain),
    value: challengeValue(row.token),
  };
}

/** Drop a connection's claim on `domain` (verified or not). Answers whether a row went. */
export async function removeConnectionDomain(
  db: Db,
  connectionId: string,
  domain: string,
): Promise<boolean> {
  const d = normalizeDomain(domain);
  if (!d) return false;
  const before = await domainRow(db, connectionId, d);
  if (!before) return false;
  await db.run(
    "DELETE FROM identity_connection_domains WHERE connection_id = ? AND domain = ?",
    connectionId,
    d,
  );
  return true;
}

/**
 * Turn enforcement on or off for a claimed domain. Storing it on an unverified domain is
 * harmless: every reader requires `verified_at`, so it takes effect only once (and while) the
 * domain is verified.
 */
export async function setDomainEnforce(
  db: Db,
  connectionId: string,
  domain: string,
  enforce: boolean,
): Promise<boolean> {
  const d = normalizeDomain(domain);
  if (!d) return false;
  if (!(await domainRow(db, connectionId, d))) return false;
  await db.run(
    "UPDATE identity_connection_domains SET enforce = ? WHERE connection_id = ? AND domain = ?",
    enforce ? 1 : 0,
    connectionId,
    d,
  );
  return true;
}

export type VerifyDomainResult =
  | { status: "verified"; verifiedAt: number }
  | { status: "absent" }
  | { status: "error" }
  | { status: "taken" }
  | { status: "unknown_domain" };

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/** Another connection of the same scope already holds a verified proof of `domain`. */
async function verifiedElsewhere(
  db: Db,
  row: ConnectionDomainRow,
): Promise<boolean> {
  const other = await db.first<{ connection_id: string }>(
    `SELECT connection_id FROM identity_connection_domains
      WHERE scope = ? AND domain = ? AND verified_at IS NOT NULL AND connection_id != ?`,
    row.scope,
    row.domain,
    row.connection_id,
  );
  return other !== null;
}

/**
 * Check one claimed domain now (the console's "Verify", I-31). `present` verifies it (keeping
 * the first `verified_at`), unless another connection of the scope already owns it (`taken`);
 * `absent` leaves or makes it unverified; a resolver error changes nothing.
 */
export async function verifyConnectionDomain(
  db: Db,
  connectionId: string,
  domain: string,
  now: number,
  opts: { fetch?: OidcFetch } = {},
): Promise<VerifyDomainResult> {
  const d = normalizeDomain(domain);
  const row = d ? await domainRow(db, connectionId, d) : null;
  if (!row) return { status: "unknown_domain" };
  const proof = await lookupDomainProof(row.domain, row.token, opts);
  if (proof === "error") return { status: "error" };
  if (proof === "absent") {
    await db.run(
      `UPDATE identity_connection_domains SET verified_at = NULL, checked_at = ?
        WHERE connection_id = ? AND domain = ?`,
      now,
      row.connection_id,
      row.domain,
    );
    return { status: "absent" };
  }
  if (row.verified_at === null && (await verifiedElsewhere(db, row))) {
    return { status: "taken" };
  }
  const verifiedAt = row.verified_at ?? now;
  try {
    await db.run(
      `UPDATE identity_connection_domains SET verified_at = ?, checked_at = ?
        WHERE connection_id = ? AND domain = ?`,
      verifiedAt,
      now,
      row.connection_id,
      row.domain,
    );
  } catch (e) {
    // A racing verification of the same (scope, domain) by another connection won.
    if (isUniqueViolation(e)) return { status: "taken" };
    throw e;
  }
  return { status: "verified", verifiedAt };
}

export interface DomainRecheckReport {
  checked: number;
  kept: number;
  unverified: number;
  errors: number;
}

/**
 * The daily re-check (the maintenance cron's `connectionDomains` step): every verified domain is
 * asked again. An answer without the token unverifies it at once; a resolver error keeps it
 * until `DOMAIN_LAPSE_SECONDS` after the last conclusive answer, then unverifies it.
 */
export async function recheckConnectionDomains(
  db: Db,
  now: number,
  opts: { fetch?: OidcFetch } = {},
): Promise<DomainRecheckReport> {
  const rows = await db.all<ConnectionDomainRow>(
    `SELECT connection_id, scope, domain, token, verified_at, checked_at, enforce
       FROM identity_connection_domains WHERE verified_at IS NOT NULL
      ORDER BY scope, domain, connection_id`,
  );
  const report: DomainRecheckReport = {
    checked: 0,
    kept: 0,
    unverified: 0,
    errors: 0,
  };
  for (const row of rows) {
    report.checked++;
    const proof = await lookupDomainProof(row.domain, row.token, opts);
    if (proof === "present") {
      await db.run(
        `UPDATE identity_connection_domains SET checked_at = ?
          WHERE connection_id = ? AND domain = ?`,
        now,
        row.connection_id,
        row.domain,
      );
      report.kept++;
      continue;
    }
    if (proof === "error") {
      report.errors++;
      const last = row.checked_at ?? 0;
      if (now - last < DOMAIN_LAPSE_SECONDS) {
        report.kept++;
        continue;
      }
      // Fall through: 72 h without a conclusive answer unverifies.
      await db.run(
        `UPDATE identity_connection_domains SET verified_at = NULL
          WHERE connection_id = ? AND domain = ?`,
        row.connection_id,
        row.domain,
      );
      report.unverified++;
      continue;
    }
    await db.run(
      `UPDATE identity_connection_domains SET verified_at = NULL, checked_at = ?
        WHERE connection_id = ? AND domain = ?`,
      now,
      row.connection_id,
      row.domain,
    );
    report.unverified++;
  }
  return report;
}
