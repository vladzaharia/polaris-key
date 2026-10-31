// The accept gate and the listener the LAN transports share (CC-08.2, CC-15.N2; WIRE-CONTRACT-V5
// §15.4.1, §15.6.1 rule 2): mode a (lan.ts) and the mode-v approver (nearbyApprover.ts) admit an
// inbound socket by the same rule, written once.
//
// Rules this module keeps:
//  - an accepted socket is judged (client-core's `lanVerdict` on its own addresses, lanJudge.ts)
//    before a byte is read; one that fails, or one refused for capacity, is closed at once and
//    costs no slot;
//  - unauthenticated sockets are bounded in number, per address, per group and in time (the
//    limiter in lanJudge.ts); a slot lives until `settle()` or the socket closes;
//  - the handshake window ends at `established()`; a socket past it lives on, a socket that never
//    reaches it is destroyed when the window lapses;
//  - one TCP port serves both families: a dual-stack `::` listener, falling back to 0.0.0.0.

import { createServer, type Server, type Socket } from "node:net";
import {
  PendingLimiter,
  limiterKeys,
  socketVerdict,
  textVerdict,
} from "./lanJudge.js";

export { textVerdict };

export interface AcceptGateOptions {
  /** Accept loopback peers. For tests and same-host use only. */
  allowLoopback?: boolean;
  /** Unauthenticated sockets at once (default 32), per source address (default 4) and per group
   *  (a link, an IPv4 /24 or an IPv6 /64; default 16). */
  maxPending?: number;
  maxPendingPerAddress?: number;
  maxPendingPer64?: number;
  /** The handshake window (default 30 s). */
  handshakeMs?: number;
}

/** What `admit` hands back for an admitted socket. */
export interface GateSlot {
  /** The judged source address (a link-local one keeps its zone). */
  readonly address: string;
  /** The transport is up: the handshake window ends, the slot is kept. */
  established(): void;
  /** Release the slot and end the window. Also runs when the socket closes. */
  settle(): void;
}

export class AcceptGate {
  readonly #pending = new Set<Socket>();
  /** Sockets past `established()`. */
  readonly #up = new WeakSet<Socket>();
  readonly #limit: PendingLimiter;

  constructor(private readonly o: AcceptGateOptions = {}) {
    this.#limit = new PendingLimiter(
      o.maxPending ?? 32,
      o.maxPendingPerAddress ?? 4,
      o.maxPendingPer64 ?? 16,
    );
  }

  /** Sockets that hold a slot. */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * Judge, limit and time a new inbound socket. Null means it was closed: its source is off the
   * LAN, `refuse` is set (stopped, or no room for a session), or a limit is met.
   */
  admit(socket: Socket, refuse = false): GateSlot | null {
    // Judged first, on the socket's own addresses and before a byte is read: a source off the LAN
    // is closed at once and costs no slot.
    const v = socketVerdict(
      socket.remoteAddress ?? "",
      socket.localAddress,
      this.o.allowLoopback === true,
    );
    if (!v.dial || v.key === null || refuse) {
      socket.destroy();
      return null;
    }
    const release = this.#limit.take(socket, limiterKeys(v.key));
    if (release === null) {
      socket.destroy();
      return null;
    }
    this.#pending.add(socket);
    // An unauthenticated socket lives for the handshake window and no longer.
    const deadline = setTimeout(
      () => socket.destroy(),
      this.o.handshakeMs ?? 30_000,
    );
    deadline.unref();
    const settle = (): void => {
      clearTimeout(deadline);
      if (!this.#pending.delete(socket)) return;
      release();
    };
    socket.once("close", settle);
    return {
      address: v.key,
      established: () => {
        clearTimeout(deadline);
        this.#up.add(socket);
      },
      settle,
    };
  }

  /** Destroy every socket that still holds a slot; `keepUp` spares those past `established()`. */
  destroyPending(o: { keepUp?: boolean } = {}): void {
    for (const s of [...this.#pending])
      if (o.keepUp !== true || !this.#up.has(s)) s.destroy();
  }
}

/**
 * Listen with `pauseOnConnect`. `host` unset: a dual-stack `::` listener, or 0.0.0.0 where IPv6 is
 * unavailable. `port` 0 is a random port (§15.4).
 */
export async function listenTcp(
  host: string | undefined,
  port: number,
  onSocket: (s: Socket) => void,
): Promise<Server> {
  const on = (h: string): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer(
        { noDelay: true, pauseOnConnect: true },
        (s) => onSocket(s),
      );
      server.once("error", reject);
      // `ipv6Only: false` is the dual-stack `::`; it is ignored for an IPv4 address.
      server.listen({ port, host: h, ipv6Only: false }, () => {
        server.removeListener("error", reject);
        server.on("error", () => undefined);
        resolve(server);
      });
    });
  if (host !== undefined) return on(host);
  try {
    return await on("::");
  } catch {
    // No IPv6 here: IPv4 only, on the same single port.
    return on("0.0.0.0");
  }
}
