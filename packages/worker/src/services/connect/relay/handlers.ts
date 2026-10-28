/// <reference types="@cloudflare/workers-types" />

/**
 * The relay's two HTTP routes (CC-07.3; plans/CC-01-cloud-connect.md §2.7, C11; WIRE-CONTRACT-V5
 * §15.7):
 *
 *   POST /<p>/connect/relay/ticket   (device bearer, `X-PKey-Device`)
 *        → {ticket: "pkeyrt_…", url, protocol: "pkey-relay.1", expiresAt}
 *   GET  /<p>/connect/relay          (WebSocket upgrade; `Sec-WebSocket-Protocol: pkey-relay.1, pkeyrt_…`)
 *
 * A browser WebSocket cannot send `Authorization`, so the bearer buys a single-use ticket and the
 * ticket rides the subprotocol list. The ticket is 256 random bits, stored only as a peppered hash
 * in the `relay-ticket` single-use kind for 60 s, bound to (product, subject, device) and the
 * resolved day quota. The upgrade consumes it atomically, so one ticket opens at most one socket.
 *
 * Both routes check `launch.relay` themselves (gate off is the registry's not-found), and both ask
 * the same questions in the same order: the product's relay switch (`relay_disabled`), the
 * deployment's pause (`relay_paused`), the quota (`relay_quota_exceeded`, scope `person` or
 * `product`). The upgrade re-asks them because a ticket outlives the answer by up to a minute.
 *
 * What the room trusts. `forwardToRelay` overwrites the admission header, and the room believes it
 * completely, so everything in it is derived here, never from the client: the product from the
 * route, the subject and device from the consumed ticket re-checked against the device's current
 * binding, the roster from a fresh read of the ring members (the principal rule), and the quota
 * from the ticket. The client's `Sec-WebSocket-Protocol` is replaced by the bare `pkey-relay.1`,
 * so the ticket value never reaches the room; `Authorization` and `Cookie` are dropped.
 */

import {
  hashKey,
  isRelayTicket,
  mintRelayTicket,
} from "../../../platform/crypto.js";
import { b64urlDecodeStrict } from "../../../platform/bytes.js";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { resolveSyncPrincipal } from "../../../core/accounts/accountSubjects.js";
import { accountDeviceKeys } from "../../../core/devices/keys.js";
import { getDevice } from "../../../core/devices/store.js";
import { ErrorCode, json, notFound, wireError } from "../../../core/errors.js";
import type { ServiceContext } from "../../../core/registry.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
} from "../../../core/singleUse.js";
import { authenticate } from "../identity.js";
import { RELAY_PROTOCOL, type Admission } from "../do/admission.js";
import { forwardToRelay } from "../do/client.js";
import {
  RELAY_PAUSED_RETRY_AFTER_SECONDS,
  RELAY_TICKET_TTL_SECONDS,
  relayDayBytes,
  relayProductState,
  type RelayProductState,
} from "./access.js";

const NO_STORE = { "cache-control": "no-store" } as const;
const DEVICE_ID_BYTES = 24;

/** What the single-use store holds for a ticket. */
interface TicketRecord {
  product: string;
  subject: string;
  device: string;
  dayBytes: number;
  /** Epoch seconds. */
  exp: number;
}

const relayBound = (ctx: ServiceContext): boolean =>
  ctx.env.CONNECT_RELAY !== undefined;

/** A device id as the room names it: its 24 decoded bytes, or null when it is not one. */
function deviceBytes(id: string): Uint8Array | null {
  const b = b64urlDecodeStrict(id);
  return b !== null && b.length === DEVICE_ID_BYTES ? b : null;
}

/** The refusals both routes share, in order; `refused` is null when the relay may admit the caller. */
async function check(
  ctx: ServiceContext,
  dayBytes: number,
): Promise<{ refused: Response | null; state: RelayProductState }> {
  const state = await relayProductState(ctx);
  const no = (res: Response) => ({ refused: res, state });
  if (!state.enabled) return no(wireError(403, ErrorCode.RelayDisabled));
  if (state.paused) {
    const res = wireError(503, ErrorCode.RelayPaused);
    res.headers.set("retry-after", String(RELAY_PAUSED_RETRY_AFTER_SECONDS));
    return no(res);
  }
  if (state.productOver)
    return no(
      wireError(429, ErrorCode.RelayQuotaExceeded, { scope: "product" }),
    );
  if (dayBytes <= 0)
    return no(
      wireError(429, ErrorCode.RelayQuotaExceeded, { scope: "person" }),
    );
  return { refused: null, state };
}

const ticketAddress = async (
  ctx: ServiceContext,
  ticket: string,
): Promise<ReturnType<typeof artefactRef>> =>
  artefactRef(
    "relay-ticket",
    `${ctx.product.slug}:${await hashKey(ticket, ctx.env.KEY_HASH_PEPPER)}`,
  );

export async function handleRelayTicket(
  ctx: ServiceContext,
): Promise<Response | null> {
  if (ctx.req.method !== "POST") return null;
  const { env, db, product, now } = ctx;
  if (!(await launchGateOn(env, db, "launch.relay")) || !relayBound(ctx))
    return notFound();
  const caller = await authenticate(ctx);
  if (caller instanceof Response) return caller;
  if (deviceBytes(caller.deviceId) === null)
    return wireError(409, ErrorCode.DeviceKeysRequired);
  // The caller must be in its own person's roster: a device whose seat was released has no room.
  const roster = await accountDeviceKeys(db, product.slug, caller.subject, {
    seatsHeld: caller.seatsHeld,
    now,
  });
  if (!roster.some((m) => m.deviceId === caller.deviceId))
    return wireError(409, ErrorCode.DeviceKeysRequired);
  const dayBytes = await relayDayBytes(ctx, caller.device);
  const { refused } = await check(ctx, dayBytes);
  if (refused) return refused;

  const ticket = mintRelayTicket();
  const exp = now + RELAY_TICKET_TTL_SECONDS;
  const record: TicketRecord = {
    product: product.slug,
    subject: caller.subject,
    device: caller.deviceId,
    dayBytes,
    exp,
  };
  await putArtefact(
    env,
    await ticketAddress(ctx, ticket),
    JSON.stringify(record),
    RELAY_TICKET_TTL_SECONDS,
  );
  const url = new URL(ctx.req.url);
  url.protocol = "wss:";
  url.pathname = `/${product.slug}/connect/relay`;
  url.search = "";
  return json(
    { ticket, url: url.toString(), protocol: RELAY_PROTOCOL, expiresAt: exp },
    { headers: NO_STORE },
  );
}

/** The ticket in a `Sec-WebSocket-Protocol` list that also names `pkey-relay.1`, else null. */
export function ticketFromProtocols(header: string | null): string | null {
  if (header === null || header.length > 512) return null;
  const offered = header.split(",").map((p) => p.trim());
  if (!offered.includes(RELAY_PROTOCOL)) return null;
  const tickets = offered.filter((p) => p.startsWith("pkeyrt_"));
  return tickets.length === 1 && isRelayTicket(tickets[0]!)
    ? tickets[0]!
    : null;
}

const badTicket = (): Response => wireError(401, ErrorCode.RelayTicketInvalid);

export async function handleRelayUpgrade(
  ctx: ServiceContext,
): Promise<Response | null> {
  if (ctx.req.method !== "GET") return null;
  const { req, env, db, product, now } = ctx;
  if (!(await launchGateOn(env, db, "launch.relay")) || !relayBound(ctx))
    return notFound();
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return wireError(426, ErrorCode.BadRequest);
  const ticket = ticketFromProtocols(req.headers.get("sec-websocket-protocol"));
  if (ticket === null) return badTicket();

  // Single use: the first caller takes the record, every other (and every replay) gets none.
  const raw = await consumeArtefact(env, await ticketAddress(ctx, ticket));
  const rec = parseRecord(raw);
  if (rec === null || rec.product !== product.slug || rec.exp <= now)
    return badTicket();

  // The binding is re-read, not trusted: the device must still be this person's.
  const device = await getDevice(db, product.slug, rec.device);
  const principal = device ? await resolveSyncPrincipal(db, device) : null;
  if (
    !device ||
    !principal ||
    principal.product !== product.slug ||
    principal.subject !== rec.subject
  )
    return badTicket();
  const seatsHeld = product.services.license.enabled;
  const roster = await accountDeviceKeys(db, product.slug, rec.subject, {
    seatsHeld,
    now,
  });
  const self = deviceBytes(rec.device);
  if (self === null || !roster.some((m) => m.deviceId === rec.device))
    return badTicket();

  const { refused, state } = await check(ctx, rec.dayBytes);
  if (refused) return refused;

  const members = roster
    .map((m) => deviceBytes(m.deviceId))
    .filter((b): b is Uint8Array => b !== null);
  const admission: Admission = {
    product: product.slug,
    subject: rec.subject,
    monthCeiling: state.monthCeiling,
    ticket: {
      device: self,
      members,
      dayBytes: rec.dayBytes,
      paused: false,
      productOver: false,
      expiresAt: rec.exp * 1000,
    },
  };
  // A clean copy: the room sees the bare subprotocol and no credential of the client's.
  const headers = new Headers(req.headers);
  for (const h of ["authorization", "cookie", HEADER_DEVICE.toLowerCase()])
    headers.delete(h);
  headers.set("sec-websocket-protocol", RELAY_PROTOCOL);
  const forwarded = new Request(req.url, { method: "GET", headers });
  return (await forwardToRelay(env, admission, forwarded)) ?? notFound();
}

function parseRecord(raw: string | null): TicketRecord | null {
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof j.product === "string" &&
      typeof j.subject === "string" &&
      typeof j.device === "string" &&
      typeof j.dayBytes === "number" &&
      Number.isFinite(j.dayBytes) &&
      typeof j.exp === "number" &&
      Number.isFinite(j.exp)
    )
      return j as unknown as TicketRecord;
  } catch {
    /* fall through: a malformed record is no ticket */
  }
  return null;
}
