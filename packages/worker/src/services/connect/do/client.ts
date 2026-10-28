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
  encodeAdmission,
  relayObjectName,
  type Admission,
} from "./admission.js";

/** Forward a WebSocket upgrade to the person's room. `null` when the relay is unbound. */
export async function forwardToRelay(
  env: Pick<Env, "CONNECT_RELAY">,
  admission: Admission,
  request: Request,
): Promise<Response | null> {
  const ns = env.CONNECT_RELAY as DurableObjectNamespace | undefined;
  if (!ns) return null;
  const stub = ns.get(
    ns.idFromName(relayObjectName(admission.product, admission.subject)),
  );
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

const POKE_TIMEOUT_MS = 3_000;

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
