// The product page link (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md): discovery's unsigned
// `core.portal` member, and the one customer link a terminal kit draws.
//
// Pure functions: no I/O. `parsePortal` reads the member as a whole; `portalLink` picks the link
// (the response's own, then discovery's, then the legacy guess against a Worker that sends no
// member). A link that is not valid under §5.3 rule 4 is no link, never repaired and never
// replaced by a guess once the Worker has answered. A client never adds `#key=` to it.

import { CUSTOMER_ORIGIN_DEFAULT, ISSUER } from "@polaris-key/protocol/core";
import { isManageUrl } from "./manage.js";

/** `core.portal`, normalised: the portal is off, or on with the usable link (or none). */
export type ParsedPortal =
  | { enabled: false }
  | { enabled: true; activate: string | null };

/**
 * `core.portal` of a discovery document's `core` block, or `null` when it says nothing usable
 * (an older Worker, or a malformed member): "unknown", which is not "off".
 */
export function parsePortal(core: unknown): ParsedPortal | null {
  if (core === null || typeof core !== "object" || Array.isArray(core))
    return null;
  const p = (core as Record<string, unknown>).portal;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
  const { enabled, activate } = p as Record<string, unknown>;
  if (typeof enabled !== "boolean") return null;
  if (!enabled) return { enabled: false };
  return { enabled: true, activate: isManageUrl(activate) ? activate : null };
}

/** RFC 3986 unreserved characters stay; every other UTF-8 byte is `%XX`. */
function encodeSlug(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(c)
      ? c
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The product page link, or `null` (no link: the kit draws "Contact {developer}"). First match:
 * a valid `served` link; the discovered member (off or no usable link is `null`, never the
 * guess); the legacy `<origin>/activate?product=<slug>` where the Worker said nothing.
 */
export function portalLink(args: {
  /** The response's own link (a refusal's `manageUrl`). */
  served?: string | null;
  portal: ParsedPortal | null;
  baseUrl: string;
  product: string;
}): string | null {
  if (isManageUrl(args.served)) return args.served;
  if (args.portal !== null)
    return args.portal.enabled ? args.portal.activate : null;
  if (args.product === "") return null;
  const base = args.baseUrl.replace(/\/+$/, "");
  const origin = base === `https://${ISSUER}` ? CUSTOMER_ORIGIN_DEFAULT : base;
  const link = `${origin}/activate?product=${encodeSlug(args.product)}`;
  return isManageUrl(link) ? link : null;
}
