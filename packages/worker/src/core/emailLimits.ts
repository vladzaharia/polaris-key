/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../env.js";
import { hashKey } from "../crypto.js";
import { clientIp, rateLimitOk, wideNetworkOf } from "./rateLimit.js";
import {
  artefactLocked,
  artefactRef,
  putArtefact,
  redeemArtefact,
  strikeArtefact,
  type ArtefactRef,
} from "./singleUse.js";

// Email sign-in limits (I-02), the reusable primitives the login card's email flows (I-07) and
// I-18's delivery operations (`emailDelivery.ts`) build on. S-16 §5.4 item 4 specifies the
// numbers; they are named constants here so I-07 and its tests import them rather than
// restating them.
//
// SEND SIDE (`checkEmailSend`): before a code or magic link is mailed, the request must pass,
// in order, per-IP, per-network, per-device (in-SDK starts only), and per-recipient hourly and
// daily; and the recipient must not be locked out. Every limit is product-scoped: one tenant's
// traffic can neither exhaust another tenant's budget nor lock a person out of another product's
// sign-in. The per-product DAILY CAP is not here: I-18 charges it at the one send choke point
// (`deliverEmail` in `emailDelivery.ts`), for passthrough mail only, after suppression, so it is
// charged last, only for mail that would really leave, and never for platform mail. A capped
// product answers `email_unavailable` there (a product-level fact that names no recipient).
//
// VERIFY SIDE (`issueEmailCode`, `verifyEmailCode`): a code is 6 digits, lives 10 minutes and
// dies after 5 wrong attempts; a new code for the same recipient and flow replaces (so
// invalidates) the old one; 10 wrong attempts across codes in an hour lock the recipient out of
// NEW codes for 15 minutes. With these numbers an attacker gets at most 5 guesses in a million
// per code and about 10 codes a day per victim.
//
// Enumeration safety (S-16 §5.4): `checkEmailSend` answers only `{ send }` and
// `verifyEmailCode` only `{ ok }` (plus the payload on success), with no reason, so a caller
// that echoes either cannot leak WHY. The caller (I-07) must answer a refused send — locked
// out, over a limit, or an unknown address — exactly as it answers a sent one.

/** Digits in an email one-time code. */
export const EMAIL_CODE_DIGITS = 6;
/** Seconds an email code (and a magic link) stays redeemable. */
export const EMAIL_CODE_TTL_SECONDS = 600;
/** Wrong attempts that kill one code. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Wrong attempts across codes, within `EMAIL_LOCKOUT_WINDOW_SECONDS`, that lock a recipient. */
export const EMAIL_LOCKOUT_THRESHOLD = 10;
/** The sliding window `EMAIL_LOCKOUT_THRESHOLD` is counted over. */
export const EMAIL_LOCKOUT_WINDOW_SECONDS = 3600;
/** How long a lockout refuses new codes. */
export const EMAIL_LOCKOUT_SECONDS = 900;

/** Sends to one recipient (hashed) per hour, per product. */
export const EMAIL_SEND_PER_RECIPIENT_HOUR = 5;
/** Sends to one recipient (hashed) per day, per product. */
export const EMAIL_SEND_PER_RECIPIENT_DAY = 20;
/** Send requests from one client address per hour, per product. */
export const EMAIL_SEND_PER_IP_HOUR = 10;
/** Send requests from one client network (IPv4 /24, IPv6 /48) per hour, per product. */
export const EMAIL_SEND_PER_NETWORK_HOUR = 30;
/** In-SDK email starts from one registered device per hour. */
export const EMAIL_SEND_PER_DEVICE_HOUR = 3;
/**
 * The operational per-product daily cap on passthrough sign-in mail (I-18), used when neither
 * the product's `email_product_caps` row nor the `EMAIL_PRODUCT_DAILY_CAP` var sets one
 * (`productDailyEmailCap`). One tenant cannot drain the shared sender: at 500 a product can
 * spend a tenth of a 5,000-a-day account quota (Cloudflare's documented example; the account's
 * real quota is read from `GET /accounts/{id}/email/sending/limits`, RUNBOOK "Sign-in email").
 * Platform mail is never counted against it.
 */
export const EMAIL_SEND_PRODUCT_DAILY_DEFAULT = 500;

const HOUR = 3600;
const DAY = 86_400;

/** The canonical form a recipient is hashed in: trimmed, lower-case. */
export function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

/** The peppered hash a recipient is keyed by; the address itself is never a key. */
export function recipientHash(env: Env, email: string): Promise<string> {
  return hashKey(`email:${normalizeRecipient(email)}`, env.KEY_HASH_PEPPER);
}

async function strikesRef(
  env: Env,
  product: string,
  email: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "email-strikes",
    `${product}:${await recipientHash(env, email)}`,
  );
}

async function codeRef(
  env: Env,
  product: string,
  email: string,
  flowId: string,
): Promise<ArtefactRef> {
  const recipient = await recipientHash(env, email);
  return artefactRef(
    "email-code",
    `${product}:${await hashKey(`${recipient}\n${flowId}`, env.KEY_HASH_PEPPER)}`,
  );
}

/** The hash a code is stored and compared as, bound to its address. */
function codeProof(env: Env, ref: ArtefactRef, code: string): Promise<string> {
  return hashKey(`${ref.id}\n${code}`, env.KEY_HASH_PEPPER);
}

export interface EmailSendRequest {
  product: string;
  /** The address the code or link would go to. */
  recipient: string;
  /** The requesting client: its address and wider network are derived from it. */
  req: Request;
  /** The registered device an in-SDK start came from; absent for the hosted page. */
  deviceId?: string;
}

/**
 * Whether a code or magic link may be sent now. Counts the request against every limit it
 * reaches (stopping at the first refusal, so a refused request spends no later budget; the
 * product cap follows at send time, in `deliverEmail`). A locked-out recipient is refused before anything is counted.
 * Fails closed: a limiter or store outage refuses.
 */
export async function checkEmailSend(
  env: Env,
  r: EmailSendRequest,
  now: number,
): Promise<{ send: boolean }> {
  if (await artefactLocked(env, await strikesRef(env, r.product, r.recipient)))
    return { send: false };
  const ip = clientIp(r.req);
  const recipient = await recipientHash(env, r.recipient);
  const checks = [
    {
      bucket: "emailSendIp",
      id: ip,
      limit: EMAIL_SEND_PER_IP_HOUR,
      windowSec: HOUR,
    },
    {
      bucket: "emailSendNetwork",
      id: wideNetworkOf(ip),
      limit: EMAIL_SEND_PER_NETWORK_HOUR,
      windowSec: HOUR,
    },
    ...(r.deviceId !== undefined
      ? [
          {
            bucket: "emailSendDevice",
            id: r.deviceId,
            limit: EMAIL_SEND_PER_DEVICE_HOUR,
            windowSec: HOUR,
          },
        ]
      : []),
    {
      bucket: "emailSendRecipientHour",
      id: recipient,
      limit: EMAIL_SEND_PER_RECIPIENT_HOUR,
      windowSec: HOUR,
    },
    {
      bucket: "emailSendRecipientDay",
      id: recipient,
      limit: EMAIL_SEND_PER_RECIPIENT_DAY,
      windowSec: DAY,
    },
  ];
  for (const rl of checks) {
    if (!(await rateLimitOk(env, r.product, rl, now))) return { send: false };
  }
  return { send: true };
}

/** A uniformly random `EMAIL_CODE_DIGITS`-digit code (leading zeros kept). Rejection sampling
 *  over 32-bit draws keeps it unbiased. */
export function generateEmailCode(): string {
  const space = 10 ** EMAIL_CODE_DIGITS;
  const limit = Math.floor(0x1_0000_0000 / space) * space;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0]! < limit)
      return String(draw[0]! % space).padStart(EMAIL_CODE_DIGITS, "0");
  }
}

/** A code as typed → its canonical digits, or null. Spaces and hyphens are dropped. */
export function normalizeEmailCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, "");
  return code.length === EMAIL_CODE_DIGITS && /^\d+$/.test(code) ? code : null;
}

export interface EmailCodeAddress {
  product: string;
  recipient: string;
  /** The opaque flow the code is bound to (S-16 §5.4 "Binding"). */
  flowId: string;
}

/**
 * Mint a code for (product, recipient, flow) and store it single-use with `payload` (whatever
 * the flow needs back on success). Replaces any live code for the same address, so the old one
 * stops working. The caller sends `code` and never stores it. Throws if the store is
 * unreachable (no code is handed out that could not be recorded).
 */
export async function issueEmailCode(
  env: Env,
  addr: EmailCodeAddress,
  payload: string,
): Promise<{ code: string }> {
  const code = generateEmailCode();
  const ref = await codeRef(env, addr.product, addr.recipient, addr.flowId);
  await putArtefact(env, ref, payload, EMAIL_CODE_TTL_SECONDS, {
    maxAttempts: EMAIL_CODE_MAX_ATTEMPTS,
    proof: await codeProof(env, ref, code),
  });
  return { code };
}

/**
 * Redeem a code atomically. A match consumes it (it can never verify twice) and returns the
 * payload. Anything else — wrong, malformed, expired, superseded or dead — counts one attempt
 * against the code (killing it at `EMAIL_CODE_MAX_ATTEMPTS`) and one strike against the
 * recipient (locking new codes at `EMAIL_LOCKOUT_THRESHOLD` in the window), and answers the
 * same `{ ok: false }`.
 */
export async function verifyEmailCode(
  env: Env,
  addr: EmailCodeAddress & { code: string },
): Promise<{ ok: true; payload: string } | { ok: false }> {
  const ref = await codeRef(env, addr.product, addr.recipient, addr.flowId);
  const code = normalizeEmailCode(addr.code);
  // A malformed code still spends an attempt: it is a guess like any other.
  const result = await redeemArtefact(
    env,
    ref,
    await codeProof(env, ref, code ?? addr.code),
  );
  if (result.ok) return result;
  await strikeArtefact(
    env,
    await strikesRef(env, addr.product, addr.recipient),
    {
      windowSec: EMAIL_LOCKOUT_WINDOW_SECONDS,
      threshold: EMAIL_LOCKOUT_THRESHOLD,
      lockSec: EMAIL_LOCKOUT_SECONDS,
    },
  );
  return { ok: false };
}

/** Whether a recipient is currently locked out of new codes (fails closed: unreachable reads as
 *  locked). For callers that gate something other than a send. */
export async function emailRecipientLocked(
  env: Env,
  product: string,
  recipient: string,
): Promise<boolean> {
  return artefactLocked(env, await strikesRef(env, product, recipient));
}
