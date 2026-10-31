/**
 * The one namer of `ConnectRelayDO` (CC-07.2): nothing else in `src/` touches the `CONNECT_RELAY`
 * binding or calls `idFromName`. The object is one person on one product, named from the pair
 * the upgrade route resolved from the consumed ticket. The route (CC-07.3) checks the
 * `launch.relay` gate before it gets here, and the object checks it again.
 */

import { D1Db } from "../../../db/d1.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { platformSetting } from "../../../core/settings/platformRead.js";
import type { RelayPoke } from "../relayPoke.js";
import {
  ADMISSION_HEADER,
  contactObjectName,
  encodeAdmission,
  relayObjectName,
  type Admission,
} from "./admission.js";

/**
 * Forward a WebSocket upgrade to the room the admission names: the person's account room, or the
 * contact room it is bound to (`<p>:c:<rid>`). `null` when the relay is unbound.
 */
export async function forwardToRelay(
  env: Pick<Env, "CONNECT_RELAY">,
  admission: Admission,
  request: Request,
): Promise<Response | null> {
  const ns = env.CONNECT_RELAY as DurableObjectNamespace | undefined;
  if (!ns) return null;
  const name = admission.contact
    ? contactObjectName(admission.product, admission.contact.rid)
    : relayObjectName(admission.product, admission.subject);
  const stub = ns.get(ns.idFromName(name));
  const headers = new Headers(request.headers);
  headers.set(ADMISSION_HEADER, encodeAdmission(admission));
  return stub.fetch(
    new Request("https://connect-relay.do/", { method: "GET", headers }),
  );
}

/**
 * Erase a person's room (account deletion or merge). Not gated: erasure works whatever
 * `launch.relay` says. An unbound relay has nothing to erase.
 */
export async function purgeRelay(
  env: Pick<Env, "CONNECT_RELAY">,
  product: string,
  subject: string,
): Promise<void> {
  const ns = env.CONNECT_RELAY as DurableObjectNamespace | undefined;
  if (!ns) return;
  const res = await ns
    .get(ns.idFromName(relayObjectName(product, subject)))
    .fetch(
      new Request("https://connect-relay.do/", {
        method: "POST",
        body: JSON.stringify({ product, subject }),
      }),
    );
  if (!res.ok) throw new Error(`relay purge answered ${res.status}`);
}

/** What the account room says to a request to count a contact room (V5 §15.7). */
export type ContactRoomCount = "counted" | "full" | "unavailable";

/**
 * Count a contact room against the person's 64 (V5 §15.7), in the person's account room: a rid it
 * already holds is refreshed, a new one takes a slot or is refused when the 64 are held. Total and
 * fail closed: an unbound relay, a failed or slow call and an unreadable answer are `unavailable`,
 * and the route issues no ticket. The room keeps only a per-person keyed hash of the rid.
 */
export async function countContactRoom(
  env: Pick<Env, "CONNECT_RELAY">,
  product: string,
  subject: string,
  rid: string,
): Promise<ContactRoomCount> {
  const ns = env.CONNECT_RELAY as DurableObjectNamespace | undefined;
  if (!ns) return "unavailable";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ns.get(ns.idFromName(relayObjectName(product, subject))).fetch(
      new Request("https://connect-relay.do/rooms", {
        method: "POST",
        body: JSON.stringify({ product, subject, rid }),
      }),
    );
    const res = await Promise.race([
      call,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("count timeout")),
          COUNT_TIMEOUT_MS,
        );
      }),
    ]);
    if (res.status === 204) return "counted";
    if (res.status === 429) return "full";
    return "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

const COUNT_TIMEOUT_MS = 3_000;
const POKE_TIMEOUT_MS = 3_000;
const LEASE_TIMEOUT_MS = 5_000;

/** What a person's room answers a lease request: the bytes granted and, short of the ask, why. */
export interface LeaseGrant {
  granted: number;
  /** 0 the ask was granted in full; else the LIMIT reason: 2 person, 3 product, 4 paused. */
  reason: 0 | 2 | 3 | 4;
}

/**
 * Take a lease for a contact room's sender from the sender's account room (V5 §15.7): the room adds
 * the grant to the person's day, so every contact room a person opens draws on the one meter.
 * Total and fail closed: an unbound relay, a gate that is off, a failed or slow call and an
 * unreadable answer all grant nothing, with reason 4.
 */
export async function leaseBytes(
  env: Pick<Env, "CONNECT_RELAY">,
  req: {
    product: string;
    subject: string;
    bytes: number;
    dayBytes: number;
    monthCeiling: number;
    seatsHeld: boolean;
  },
): Promise<LeaseGrant> {
  const none: LeaseGrant = { granted: 0, reason: 4 };
  const ns = env.CONNECT_RELAY as DurableObjectNamespace | undefined;
  if (!ns) return none;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ns
      .get(ns.idFromName(relayObjectName(req.product, req.subject)))
      .fetch(
        new Request("https://connect-relay.do/lease", {
          method: "POST",
          body: JSON.stringify({
            product: req.product,
            subject: req.subject,
            n: req.bytes,
            dayBytes: req.dayBytes,
            monthCeiling: req.monthCeiling,
            seatsHeld: req.seatsHeld,
          }),
        }),
      );
    const res = await Promise.race([
      call,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("lease timeout")),
          LEASE_TIMEOUT_MS,
        );
      }),
    ]);
    if (res.status !== 200) return none;
    const j = (await res.json()) as Partial<LeaseGrant>;
    if (
      typeof j.granted !== "number" ||
      !Number.isSafeInteger(j.granted) ||
      j.granted < 0 ||
      j.granted > req.bytes ||
      (j.reason !== 0 && j.reason !== 2 && j.reason !== 3 && j.reason !== 4)
    )
      return none;
    return { granted: j.granted, reason: j.reason };
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell a person's room that their roster moved (CC-07.4). Gated: with `launch.relay` off, or an
 * unreadable gate, there is nothing to poke. Total: an unbound relay, a failed call or a slow
 * room is ignored, because the poke is bookkeeping and the room's alarm re-derives the roster
 * anyway. Never throws, so it cannot fail the device write that caused it.
 */
export async function pokeRelayRoom(
  env: Env,
  poke: RelayPoke,
  db: Db = new D1Db(env.DB),
): Promise<void> {
  const ns = env.CONNECT_RELAY as DurableObjectNamespace | undefined;
  if (!ns) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if ((await platformSetting(env, db, "launch.relay")) !== "on") return;
    const call = ns
      .get(ns.idFromName(relayObjectName(poke.product, poke.subject)))
      .fetch(
        new Request("https://connect-relay.do/", {
          method: "PUT",
          body: JSON.stringify(poke),
        }),
      );
    await Promise.race([
      call,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error("poke timeout")),
          POKE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    // Bookkeeping only.
  } finally {
    clearTimeout(timer);
  }
}
