/**
 * Download tickets (PX-W3, plans/PX-W3.md §2 and §6.1; portal gap G3).
 *
 * A download ticket is a short-lived capability for ONE release file on the bytes host. The
 * portal's `/download/<token>` redemption (Identity) mints one after every check it already runs
 * (portal and releases on, account active, an owned licence, the deliverable's access, the
 * single-use token), and 302s the browser to the file's canonical bytes-host URL with
 * `?ticket=<t>` appended. Distribution's `files` route accepts a valid ticket in place of a
 * device bearer, on the bytes host only. Both sides import this module, which is why it is
 * Core's (AGENTS.md rule 6).
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────────────────────
 *
 *     v1.<kid>.<exp>.<mac>
 *
 *   - `kid`: base64url of the first 6 bytes of SHA-256 over the key material (8 chars). It
 *     fingerprints the key itself, so a ticket minted just before a rotation still names the
 *     key that signed it once that key has moved to `DOWNLOAD_TICKET_KEY_PREVIOUS`.
 *   - `exp`: Unix seconds; at most `DOWNLOAD_TICKET_TTL_SECONDS` ahead of the verifier's clock.
 *   - `mac`: base64url HMAC-SHA256 over
 *     `pkey-download-ticket/1\n<bytes host>\n<product>\n<releaseId>\n<name>\n<sha256>\n<exp>`,
 *     `<name>` being the DECODED path segment.
 *
 * A ticket carries no account id and no subject (I-04 §6.2): the account was judged at
 * redemption, and the ticket only says "this one file, for the next two minutes". It may be
 * reused inside its window, so `Range`, resume and `HEAD` work (Q2).
 *
 * ── KEYS ────────────────────────────────────────────────────────────────────────────────────
 *
 * `DOWNLOAD_TICKET_KEY` signs; it and `DOWNLOAD_TICKET_KEY_PREVIOUS` verify (the
 * `REGISTRY_TOKEN_KEY` pattern). The value is used as string HMAC material, as the registry's
 * key is. With `DOWNLOAD_TICKET_KEY` or `BLOB_ORIGIN` unset nothing is minted, so files stay
 * `not_hosted` and a presented ticket verifies against nothing: deleting the key is the kill
 * switch.
 *
 * The label `pkey-download-ticket/1` covers release files only. Any other short-lived link takes
 * its own label and never reuses this one. A ticket is never logged (THREAT-MODEL R12).
 */

import type { Env } from "../env.js";
import { secret } from "../env.js";
import { bytesHostname, normalizeHostname } from "./bytesHostname.js";

/** The MAC's domain-separation label (S-19 decision 18). */
export const DOWNLOAD_TICKET_LABEL = "pkey-download-ticket/1";

/** How long a ticket lives. A security bound, so a code constant, not a setting (S-18 §5.6). */
export const DOWNLOAD_TICKET_TTL_SECONDS = 120;

/** The query parameter the bytes host reads. */
export const DOWNLOAD_TICKET_PARAM = "ticket";

const VERSION = "v1";
/** Far longer than any ticket (`v1.` + 8 + `.` + 10 + `.` + 43); refuses junk before parsing. */
const MAX_TICKET_LENGTH = 128;
const KID_RE = /^[A-Za-z0-9_-]{8}$/;
const EXP_RE = /^[1-9][0-9]{0,11}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;

/** What a ticket is bound to: one file of one release of one product, by content. */
export interface DownloadTicketFile {
  product: string;
  releaseId: string;
  /** The decoded file name, exactly as the `files` route's path segment decodes. */
  name: string;
  /** The artifact's SHA-256, lowercase hex. */
  sha256: string;
}

function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const enc = (s: string) => toBuffer(new TextEncoder().encode(s));

async function keyId(material: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc(material)),
  );
  return b64url(digest.subarray(0, 6));
}

function hmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The signed message, or `null` when a field could make it ambiguous (a newline would let one
 * binding pass for another) or is empty.
 */
function message(
  host: string,
  file: DownloadTicketFile,
  exp: number,
): string | null {
  const fields = [host, file.product, file.releaseId, file.name, file.sha256];
  if (fields.some((f) => f === "" || f.includes("\n"))) return null;
  return [DOWNLOAD_TICKET_LABEL, ...fields, String(exp)].join("\n");
}

/** Is ticket minting configured here (a signing key and a bytes host)? */
export function downloadTicketsEnabled(env: Env): boolean {
  return !!secret(env, "DOWNLOAD_TICKET_KEY") && bytesHostname(env) !== null;
}

/**
 * Mint a ticket for `file` on this deployment's bytes host, valid for
 * `DOWNLOAD_TICKET_TTL_SECONDS` from `now`. `null` when `DOWNLOAD_TICKET_KEY` or `BLOB_ORIGIN`
 * is unset, or a field cannot be bound unambiguously.
 */
export async function mintDownloadTicket(
  env: Env,
  file: DownloadTicketFile,
  now: number,
): Promise<string | null> {
  const material = secret(env, "DOWNLOAD_TICKET_KEY");
  const host = bytesHostname(env);
  if (!material || !host) return null;
  const exp = Math.floor(now) + DOWNLOAD_TICKET_TTL_SECONDS;
  const msg = message(host, file, exp);
  if (msg === null) return null;
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(material), enc(msg)),
  );
  return `${VERSION}.${await keyId(material)}.${exp}.${b64url(mac)}`;
}

/**
 * Does `ticket` authorise `at.host`'s copy of the file `at` names, at `now`? The key is chosen by the ticket's `kid`
 * among `DOWNLOAD_TICKET_KEY` and `DOWNLOAD_TICKET_KEY_PREVIOUS`, and the MAC is checked with
 * `crypto.subtle.verify`. Refused: a malformed ticket, an unknown `kid`, `exp <= now`, and
 * `exp > now + DOWNLOAD_TICKET_TTL_SECONDS` (no long-lived ticket, even from a leaked key).
 * The caller treats `false` exactly like an absent ticket, so a probe cannot tell the two apart.
 */
export async function verifyDownloadTicket(
  env: Env,
  ticket: string,
  at: DownloadTicketFile & {
    /** The request's hostname (already known to be the bytes host). */
    host: string;
  },
  now: number,
): Promise<boolean> {
  if (ticket.length > MAX_TICKET_LENGTH) return false;
  const parts = ticket.split(".");
  if (parts.length !== 4) return false;
  const [version, kid, expRaw, macRaw] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (
    version !== VERSION ||
    !KID_RE.test(kid) ||
    !EXP_RE.test(expRaw) ||
    !MAC_RE.test(macRaw)
  )
    return false;
  const exp = Number(expRaw);
  const t = Math.floor(now);
  if (exp <= t || exp > t + DOWNLOAD_TICKET_TTL_SECONDS) return false;
  const mac = b64urlDecode(macRaw);
  if (!mac || mac.length !== 32) return false;
  const msg = message(normalizeHostname(at.host), at, exp);
  if (msg === null) return false;
  for (const name of ["DOWNLOAD_TICKET_KEY", "DOWNLOAD_TICKET_KEY_PREVIOUS"]) {
    const material = secret(env, name);
    if (!material || (await keyId(material)) !== kid) continue;
    return crypto.subtle.verify(
      "HMAC",
      await hmacKey(material),
      toBuffer(mac),
      enc(msg),
    );
  }
  return false;
}
