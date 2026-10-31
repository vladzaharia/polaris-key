// Dialling several learned addresses for one device (WIRE-CONTRACT-V5 §15.4.1, RFC 8305): the
// addresses are tried in first-seen order, at most two attempts in flight, a new one every 250 ms
// (at once when one fails). The first connection that passes the verdict on its own addresses
// wins; every other socket closes before a byte is sent on it.

import { connect as netConnect, isIP, type Socket } from "node:net";
import { socketVerdict, textVerdict } from "./lanJudge.js";

export const DIAL_STAGGER_MS = 250;
export const DIAL_MAX_IN_FLIGHT = 2;
const DIAL_TIMEOUT_MS = 10_000;

export interface DialOptions {
  allowLoopback: boolean;
  /** Open a socket to one address. Default `net.connect`. */
  connect?: (host: string, port: number) => Socket;
  staggerMs?: number;
  timeoutMs?: number;
}

/**
 * The default connect: an IP literal only. A host that is not one is refused before a socket
 * exists, and the lookup would fail in any case, so a name never reaches a resolver.
 */
export function connectLiteral(host: string, port: number): Socket {
  if (isIP(host) === 0) throw new Error("not an IP literal");
  return netConnect({
    host,
    port,
    lookup: (_h, _o, cb) => cb(new Error("no resolver"), "", 0),
  });
}

/** Resolves with the winning connected socket; rejects with the last failure when none connects. */
export async function dialRace(
  hosts: readonly string[],
  port: number,
  o: DialOptions,
): Promise<Socket> {
  return (await dialRaceTo(hosts, port, o)).socket;
}

/** As `dialRace`, with the address that won (so a failed handshake can leave it out of the next race). */
export function dialRaceTo(
  hosts: readonly string[],
  port: number,
  o: DialOptions,
): Promise<{ socket: Socket; host: string }> {
  const open = o.connect ?? connectLiteral;
  return new Promise((resolve, reject) => {
    const live = new Set<Socket>();
    let next = 0;
    let over = false;
    let last: unknown = new Error("no address");
    let stagger: ReturnType<typeof setTimeout> | null = null;
    let overall: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
      over = true;
      if (stagger !== null) clearTimeout(stagger);
      if (overall !== null) clearTimeout(overall);
      stagger = overall = null;
    };
    const fail = (e: unknown): void => {
      if (over) return;
      stop();
      for (const s of live) s.destroy();
      live.clear();
      reject(e);
    };
    const launch = (): void => {
      if (stagger !== null) clearTimeout(stagger);
      stagger = null;
      while (!over && next < hosts.length && live.size < DIAL_MAX_IN_FLIGHT) {
        const host = hosts[next++]!;
        // The text is judged before a socket exists.
        if (!textVerdict(host, o.allowLoopback)) {
          last = new Error("address refused");
          continue;
        }
        let s: Socket;
        try {
          s = open(host, port);
        } catch (e) {
          last = e;
          continue;
        }
        live.add(s);
        const lose = (e: unknown): void => {
          if (!live.delete(s)) return;
          s.destroy();
          last = e;
          if (over) return;
          if (live.size === 0 && next >= hosts.length) fail(last);
          else launch();
        };
        s.once("error", lose);
        s.once("connect", () => {
          if (over) {
            s.destroy();
            return;
          }
          // The connected socket is judged on its own addresses before anything is written.
          if (
            !socketVerdict(s.remoteAddress, s.localAddress, o.allowLoopback)
              .dial
          )
            return lose(new Error("address refused"));
          stop();
          live.delete(s);
          for (const x of live) x.destroy();
          live.clear();
          s.removeAllListeners("error");
          resolve({ socket: s, host });
        });
        break; // one attempt per call; the timer or a failure starts the next
      }
      if (!over && next < hosts.length)
        stagger = setTimeout(launch, o.staggerMs ?? DIAL_STAGGER_MS);
      else if (!over && live.size === 0) fail(last);
    };
    overall = setTimeout(
      () => fail(new Error("timeout")),
      o.timeoutMs ?? DIAL_TIMEOUT_MS,
    );
    launch();
  });
}
