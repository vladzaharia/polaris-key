/**
 * What a connection's verified ID token says, as the sign-in uses it (I-30; plans/I-27.md §2.3
 * "Fields", "Links", "Trust in `email_verified`").
 *
 * Only claims the connection's claim map names are read, and only from an ID token the one
 * relying-party client verified (`core/oidc/client.ts`):
 *
 *   - **groups**: the mapped claim, an array of strings; at most `LINK_GROUPS_MAX` names, each
 *     matching `GROUP_NAME_RE`, de-duplicated. Anything else is dropped, never coerced. Kept on
 *     the link (`account_links.groups_json`).
 *   - **claims[]**: the claims access rules may name (LX-36, ST-32); each a string, number or
 *     boolean, stored as a string of at most `LINK_CLAIM_VALUE_MAX` characters. Kept on the link
 *     (`account_links.claims_json`).
 *   - **name, picture, birthdate**: the sign-in's imported profile only. The birth date never
 *     reaches the link; it rides in the gate record as FinishStep's offer (I-33).
 *
 * The address counts as verified only where the connection vouches for it
 * (`connectionVouchesForEmail`): a platform connection inside its verified domains, never a
 * product connection.
 */

import type { JWTPayload } from "jose";
import type { Connection } from "../../../core/oidc/connections.js";
import { connectionVouchesForEmail } from "../providers/vouch.js";

/** At most this many group names are kept per link. */
export const LINK_GROUPS_MAX = 100;
/** A group name: 1–200 printable characters, no control characters. */
export const GROUP_NAME_RE = /^[^\u0000-\u001f\u007f-\u009f]{1,200}$/u;
/** A kept access-rule claim value is cut to this many characters. */
export const LINK_CLAIM_VALUE_MAX = 256;

/** The claim map of the env-seeded platform connection (Pocket ID's claims). */
export const DEFAULT_PLATFORM_CLAIM_MAP = {
  groups: "groups",
  name: "name",
  picture: "picture",
} as const;

export interface ConnectionIdentity {
  sub: string;
  /** Lower-cased, or `null` when absent or not an address. */
  email: string | null;
  /** The connection vouches for `email` (see the module comment). */
  emailVerified: boolean;
  displayName: string | null;
  pictureUrl: string | null;
  /** `null`: the claim map names no groups claim, or the token did not carry it. */
  groups: string[] | null;
  /** `null`: the claim map names no claims, or the token carried none of them. */
  claims: Record<string, string> | null;
  /** Untrusted: FinishStep's offer only. */
  birthdate: string | null;
}

/** The mapped groups, sanitised; `null` when the claim is absent or not an array. */
export function mappedGroups(
  payload: Record<string, unknown>,
  claim: string | undefined,
): string[] | null {
  if (!claim) return null;
  const raw = payload[claim];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const g of raw) {
    if (typeof g !== "string" || !GROUP_NAME_RE.test(g)) continue;
    if (out.includes(g)) continue;
    out.push(g);
    if (out.length >= LINK_GROUPS_MAX) break;
  }
  return out;
}

/** The mapped access-rule claims, as strings; `null` when none is present. */
export function mappedClaims(
  payload: Record<string, unknown>,
  names: readonly string[] | undefined,
): Record<string, string> | null {
  if (!names?.length) return null;
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = payload[name];
    if (
      typeof v === "string" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      typeof v === "boolean"
    ) {
      out[name] = String(v).slice(0, LINK_CLAIM_VALUE_MAX);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** The sign-in's view of a verified ID token through `conn`. */
export function connectionIdentity(
  conn: Connection,
  payload: JWTPayload,
  verifiedDomains: readonly string[],
): ConnectionIdentity {
  const p = payload as Record<string, unknown>;
  const map = conn.claimMap;
  const rawEmail = typeof p.email === "string" ? p.email.trim() : null;
  const email = rawEmail && rawEmail.includes("@") ? rawEmail : null;
  const emailVerified = connectionVouchesForEmail(
    conn,
    { email, emailVerified: p.email_verified === true },
    verifiedDomains,
  );
  const name =
    str(map.name ? p[map.name] : undefined) ??
    str(
      [p.given_name, p.family_name]
        .filter((s) => typeof s === "string")
        .join(" "),
    );
  const picture = map.picture ? str(p[map.picture], 2048) : null;
  return {
    sub: typeof p.sub === "string" ? p.sub : "",
    email: email ? email.toLowerCase() : null,
    emailVerified,
    displayName: name,
    pictureUrl: picture && /^https:\/\//i.test(picture) ? picture : null,
    groups: mappedGroups(p, map.groups),
    claims: mappedClaims(p, map.claims),
    birthdate: map.birthdate ? str(p[map.birthdate], 32) : null,
  };
}
