/**
 * Connections, read side (I-30; plans/I-27.md §2.3, §6 "Table owners").
 *
 * A connection is an upstream OpenID Connect provider at platform or product scope, with
 * DNS-verified email domains (each optionally enforced), an audience and a claim map. Identity
 * owns `identity_connections` and `identity_connection_domains` and is their only writer; every
 * other reader goes through this Core accessor (rule 6): the operator pages (I-31, ST-32), access
 * rules (LX-36) and the router never query the tables themselves.
 *
 * The domain rules every reader relies on live here too, so there is one definition of each:
 *
 *   - **ASCII first.** A domain, or an address's domain, is refused unless it is plain ASCII
 *     BEFORE it is lower-cased: `toLowerCase` folds some non-ASCII letters into ASCII ones (the
 *     Kelvin sign `K` becomes `k`), so a lookalike would otherwise collapse onto a verified domain.
 *   - **Exact domains.** A verified `example.com` never covers `sub.example.com` or
 *     `evil-example.com`; each needs its own proof.
 *   - **Fail closed.** Only a domain with `verified_at` set counts, and only on an active
 *     connection whose audience covers the surface.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { open, type SealContext } from "../../platform/keyvault.js";
import { connectionHosts, type RelyingParty } from "./client.js";

export const CONNECTION_AUDIENCES = ["customers", "operators", "both"] as const;
export type ConnectionAudience = (typeof CONNECTION_AUDIENCES)[number];
export type ConnectionSource = "env" | "console" | "manifest";
export type ConnectionStatus = "active" | "disabled";
/** Who is signing in: an app's customers on the card, or an operator in the console UI. */
export type SignInSurface = "customers" | "operators";

/** A connection id: also the `<id>` of `connection:<id>` in `amr` and in a birth date's source. */
export const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Which ID-token claim feeds what (plans/I-27.md §2.3 "Fields"). Each value is a claim name. */
export interface ClaimMap {
  /** The claim holding the groups, kept on the link (`groups_json`). */
  groups?: string;
  /** The claims access rules may name, kept on the link (`claims_json`). */
  claims?: string[];
  /** The sign-in's imported profile only: never stored on the link. */
  name?: string;
  picture?: string;
  birthdate?: string;
}

export interface Connection {
  id: string;
  /** `platform`, or `product:<slug>` (I-32). */
  scope: string;
  label: string;
  issuer: string;
  clientId: string;
  jwksUri: string | null;
  audience: ConnectionAudience;
  claimMap: ClaimMap;
  exchange: boolean;
  status: ConnectionStatus;
  source: ConnectionSource;
  /** A sealed platform secret is stored (its value never leaves `openConnectionSecret`). */
  hasSealedSecret: boolean;
  /** A product connection names a product secret instead (I-32). */
  clientSecretRef: string | null;
}

interface ConnectionRow {
  id: string;
  scope: string;
  label: string;
  issuer: string;
  client_id: string;
  client_secret_sealed: string | null;
  client_secret_ref: string | null;
  jwks_uri: string | null;
  audience: string;
  claim_map_json: string;
  exchange: number;
  status: string;
  source: string;
}

const CLAIM_NAME_RE = /^[A-Za-z0-9_:.\-/]{1,64}$/;
/** At most this many access-rule claims per connection. */
export const CLAIM_MAP_MAX_CLAIMS = 20;

/** A stored claim map, keeping only well-formed claim names (anything else is dropped). */
export function parseClaimMap(raw: string | null | undefined): ClaimMap {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const one = (x: unknown): string | undefined =>
    typeof x === "string" && CLAIM_NAME_RE.test(x) ? x : undefined;
  const out: ClaimMap = {};
  for (const k of ["groups", "name", "picture", "birthdate"] as const) {
    const name = one(o[k]);
    if (name) out[k] = name;
  }
  if (Array.isArray(o.claims)) {
    const claims = [
      ...new Set(
        o.claims.map(one).filter((x): x is string => x !== undefined),
      ),
    ].slice(0, CLAIM_MAP_MAX_CLAIMS);
    if (claims.length > 0) out.claims = claims;
  }
  return out;
}

const COLUMNS = `id, scope, label, issuer, client_id, client_secret_sealed, client_secret_ref,
  jwks_uri, audience, claim_map_json, exchange, status, source`;

function toConnection(r: ConnectionRow): Connection {
  return {
    id: r.id,
    scope: r.scope,
    label: r.label,
    issuer: r.issuer,
    clientId: r.client_id,
    jwksUri: r.jwks_uri,
    audience: (CONNECTION_AUDIENCES as readonly string[]).includes(r.audience)
      ? (r.audience as ConnectionAudience)
      : "customers",
    claimMap: parseClaimMap(r.claim_map_json),
    exchange: r.exchange === 1,
    status: r.status === "active" ? "active" : "disabled",
    source: r.source as ConnectionSource,
    hasSealedSecret: Boolean(r.client_secret_sealed),
    clientSecretRef: r.client_secret_ref,
  };
}

/** One connection by id, or `null`. Disabled rows are returned; callers check `status`. */
export async function resolveConnection(
  db: Db,
  id: string,
): Promise<Connection | null> {
  if (!CONNECTION_ID_RE.test(id)) return null;
  const row = await db.first<ConnectionRow>(
    `SELECT ${COLUMNS} FROM identity_connections WHERE id = ?`,
    id,
  );
  return row ? toConnection(row) : null;
}

/** Every connection of `scope`, in a stable order (label, then id). */
export async function listConnections(
  db: Db,
  scope: string,
): Promise<Connection[]> {
  const rows = await db.all<ConnectionRow>(
    `SELECT ${COLUMNS} FROM identity_connections WHERE scope = ?
      ORDER BY label, id`,
    scope,
  );
  return rows.map(toConnection);
}

/** Whether a connection with `audience` signs people in on `surface`. */
export function audienceCovers(
  audience: ConnectionAudience,
  surface: SignInSurface,
): boolean {
  return audience === "both" || audience === surface;
}

/** The active platform connections whose audience covers `surface`: the card's buttons. */
export async function activePlatformConnections(
  db: Db,
  surface: SignInSurface,
): Promise<Connection[]> {
  return (await listConnections(db, "platform")).filter(
    (c) => c.status === "active" && audienceCovers(c.audience, surface),
  );
}

// ── secrets ──────────────────────────────────────────────────────────────────────────────────

/** The AAD slot of a platform connection's client secret. */
export function connectionSecretContext(id: string): SealContext {
  return { product: "_platform", kind: "identity-connection", id };
}

/**
 * A platform connection's client secret, opened, or `null` when none is stored or it will not
 * open (a wrong slot, an unknown KEK: fail closed). Named only by the sign-in paths that redeem a
 * code through the connection.
 */
export async function openConnectionSecret(
  env: Env,
  db: Db,
  id: string,
): Promise<string | null> {
  const row = await db.first<{ client_secret_sealed: string | null }>(
    "SELECT client_secret_sealed FROM identity_connections WHERE id = ?",
    id,
  );
  if (!row?.client_secret_sealed) return null;
  try {
    const plain = (
      await open(env, row.client_secret_sealed, connectionSecretContext(id))
    ).trim();
    return plain || null;
  } catch {
    return null;
  }
}

/** The relying party the one client drives for `conn`. */
export function connectionRelyingParty(
  conn: Connection,
  clientSecret: string | null,
): RelyingParty {
  return {
    label: `connection:${conn.id}`,
    issuer: conn.issuer,
    clientId: conn.clientId,
    clientSecret,
    allowedHosts: connectionHosts(conn.issuer, conn.jwksUri),
    jwksUri: conn.jwksUri,
  };
}

// ── domains ──────────────────────────────────────────────────────────────────────────────────

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

/**
 * A domain as connections store and compare it, or `null`: plain ASCII checked BEFORE lower-
 * casing (see the module comment), then lower case, letters, digits and hyphens in dot-separated
 * labels, at least two labels. No trailing dot, no wildcard, no IP literal.
 */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;
  const d = trimmed.toLowerCase();
  if (!DOMAIN_RE.test(d)) return null;
  // The last label of a real domain is never all digits (that would be an IPv4 literal).
  if (/^\d+$/.test(d.slice(d.lastIndexOf(".") + 1))) return null;
  return d;
}

/** The domain of an email address, under `normalizeDomain`'s rules, or `null`. */
export function emailDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return null;
  return normalizeDomain(trimmed.slice(at + 1));
}

export interface DomainRoute {
  connection: Connection;
  domain: string;
  enforced: boolean;
}

/**
 * Where an address's domain routes on `surface`: the active connection, in `scopes` order (a
 * product's own scope first, then `platform`), that holds a VERIFIED proof of exactly this
 * domain and whose audience covers the surface. `null` when none does. Depends on the domain
 * only, never on any account.
 */
export async function routeForDomain(
  db: Db,
  domain: string,
  scopes: readonly string[],
  surface: SignInSurface,
): Promise<DomainRoute | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  for (const scope of scopes) {
    const row = await db.first<ConnectionRow & { enforce: number }>(
      `SELECT ${COLUMNS
        .split(",")
        .map((c) => `c.${c.trim()}`)
        .join(", ")}, d.enforce
         FROM identity_connection_domains d
         JOIN identity_connections c ON c.id = d.connection_id
        WHERE d.scope = ? AND d.domain = ? AND d.verified_at IS NOT NULL
          AND c.scope = d.scope`,
      scope,
      d,
    );
    if (!row) continue;
    const connection = toConnection(row);
    if (connection.status !== "active") continue;
    if (!audienceCovers(connection.audience, surface)) continue;
    return { connection, domain: d, enforced: row.enforce === 1 };
  }
  return null;
}

/** The verified domains of one connection (exact names, lower case). */
export async function verifiedDomains(
  db: Db,
  connectionId: string,
): Promise<string[]> {
  const rows = await db.all<{ domain: string }>(
    `SELECT domain FROM identity_connection_domains
      WHERE connection_id = ? AND verified_at IS NOT NULL ORDER BY domain`,
    connectionId,
  );
  return rows.map((r) => r.domain);
}

/**
 * Whether `domain` is verified AND enforced by some active connection in `scopes` whose
 * audience covers `surface`: the card then sends that domain's addresses no email code and no
 * magic link.
 */
export async function domainEnforced(
  db: Db,
  domain: string,
  scopes: readonly string[],
  surface: SignInSurface,
): Promise<boolean> {
  const route = await routeForDomain(db, domain, scopes, surface);
  return route?.enforced === true;
}
