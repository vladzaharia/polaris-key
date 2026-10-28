/**
 * The admission the upgrade route (CC-07.3) hands the relay room after it consumed the single-use
 * ticket: who connects, the person's roster, the resolved quota and the product's state. It
 * travels in one request header between the Worker and its own Durable Object, never from a
 * client (the route strips any client copy). `decodeAdmission` is strict and total: anything
 * malformed is `null`, and the room then answers 400.
 */

import { CLOUD_CONNECT_CEILINGS } from "@polaris-key/catalog";
import {
  b64urlDecodeStrict,
  hexDecode,
  hexEncode,
} from "../../../platform/bytes.js";
import type { RelayTicket } from "../relay/engine.js";

export const ADMISSION_HEADER = "x-pkey-relay-admission";
export const RELAY_PROTOCOL = "pkey-relay.1";

export interface Admission {
  product: string;
  subject: string;
  ticket: RelayTicket;
  /** The product's relay bytes per UTC month, clamped to the 500 GiB ceiling. */
  monthCeiling: number;
  /** The licence service is on: the roster counts only devices that hold a seat (the principal rule). */
  seatsHeld: boolean;
}

const PRODUCT_RE = /^[a-z0-9-]+$/;
const SUBJECT_RE = /^[A-Za-z0-9_-]+$/;
const HEX48 = /^[0-9a-f]{48}$/;

const toHex = hexEncode;
const fromHex = (h: string): Uint8Array => hexDecode(h) ?? new Uint8Array(0);

/** A device id as the room names it: its 24 decoded bytes, or null when it is not one. */
export function deviceIdBytes(id: string): Uint8Array | null {
  const b = b64urlDecodeStrict(id);
  return b !== null && b.length === 24 ? b : null;
}

/** The room's name for one person on one product: the one place a relay object is named. */
export function relayObjectName(product: string, subject: string): string {
  if (!PRODUCT_RE.test(product) || !SUBJECT_RE.test(subject))
    throw new Error("relay: a name outside the product and subject grammars");
  return `${product}:${subject}`;
}

export function encodeAdmission(a: Admission): string {
  return JSON.stringify({
    product: a.product,
    subject: a.subject,
    device: toHex(a.ticket.device),
    members: a.ticket.members.map(toHex),
    dayBytes: a.ticket.dayBytes,
    paused: a.ticket.paused,
    productOver: a.ticket.productOver,
    expiresAt: a.ticket.expiresAt,
    monthCeiling: a.monthCeiling,
    seatsHeld: a.seatsHeld,
  });
}

export function decodeAdmission(raw: string | null): Admission | null {
  if (!raw || raw.length > 16_384) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const { product, subject, device, members } = j;
  if (typeof product !== "string" || !PRODUCT_RE.test(product)) return null;
  if (typeof subject !== "string" || !SUBJECT_RE.test(subject)) return null;
  if (typeof device !== "string" || !HEX48.test(device)) return null;
  if (
    !Array.isArray(members) ||
    members.length > 255 ||
    !members.every((m) => typeof m === "string" && HEX48.test(m))
  )
    return null;
  const num = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!num(j.dayBytes) || !num(j.expiresAt) || !num(j.monthCeiling))
    return null;
  if (typeof j.seatsHeld !== "boolean") return null;
  if (typeof j.paused !== "boolean" || typeof j.productOver !== "boolean")
    return null;
  return {
    product,
    subject,
    seatsHeld: j.seatsHeld,
    monthCeiling: Math.min(
      Math.floor(j.monthCeiling),
      CLOUD_CONNECT_CEILINGS.perProduct.relayBytesPerMonth,
    ),
    ticket: {
      device: fromHex(device),
      members: (members as string[]).map(fromHex),
      dayBytes: j.dayBytes,
      paused: j.paused,
      productOver: j.productOver,
      expiresAt: j.expiresAt,
    },
  };
}
