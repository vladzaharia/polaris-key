/**
 * The one namer of `ConnectRelayDO` (CC-07.2): nothing else in `src/` touches the `CONNECT_RELAY`
 * binding or calls `idFromName`. The object is one person on one product, named from the pair
 * the upgrade route resolved from the consumed ticket. The route (CC-07.3) checks the
 * `launch.relay` gate before it gets here, and the object checks it again.
 */

import type { Env } from "../../../platform/env.js";
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
