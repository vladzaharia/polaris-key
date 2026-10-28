// Outgoing pacing for the relay socket (decision D-9; WIRE-CONTRACT-V5 §15.7). The room allows a
// client 200 messages a second with a burst of 400 and answers a client that exceeds it with
// LIMIT 1; this client stays under it:
//  - a token bucket on every outgoing envelope: 180 a second, burst 360 (0.9 of the room's numbers);
//  - LIMIT 1 halves the rate for 10 seconds;
//  - the queue behind the socket holds at most 8 MiB. A session message that would pass it is
//    refused (`push` answers false) and the caller closes that session `peer_busy`; handshake and
//    control envelopes are forced, since refusing one would stall a session without a word.
// Bookkeeping over an injected clock and timer: nothing here touches a socket.

import { encodeRelay } from "./relay.js";

export const RELAY_RATE = 180;
export const RELAY_BURST = 360;
export const RELAY_HALVED_MS = 10_000;
export const RELAY_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export class RelayPacer {
  #tokens: number;
  #at: number;
  #halvedUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly baseRate: number = RELAY_RATE,
    private readonly burst: number = RELAY_BURST,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.#tokens = burst;
    this.#at = clock();
  }

  /** Messages a second in force now: half the base rate while a LIMIT 1 is honoured. */
  get rate(): number {
    return this.clock() < this.#halvedUntil ? this.baseRate / 2 : this.baseRate;
  }

  /** LIMIT 1: send at half the rate for `ms`. */
  halve(ms: number = RELAY_HALVED_MS): void {
    this.#refill();
    this.#halvedUntil = this.clock() + ms;
    this.#tokens = Math.min(this.#tokens, this.burst / 2);
  }

  #refill(): void {
    const now = this.clock();
    if (now > this.#at)
      this.#tokens = Math.min(
        this.burst,
        this.#tokens + ((now - this.#at) / 1000) * this.rate,
      );
    this.#at = now;
  }

  /** 0 when a token was taken; else the milliseconds until one is available. */
  tryTake(): number {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return ((1 - this.#tokens) / this.rate) * 1000;
  }
}

export interface RelayOutboxOptions {
  pacer?: RelayPacer;
  maxBytes?: number;
  /** Schedule `fn` after `ms`; returns the cancel. Default `setTimeout`, unref'd where it can be. */
  timer?: (fn: () => void, ms: number) => () => void;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms) as unknown as { unref?: () => void };
  t.unref?.();
  return () => clearTimeout(t as unknown as number);
};

/** The envelopes waiting for the socket: paced out through `write`, bounded in bytes. */
export class RelayOutbox {
  readonly pacer: RelayPacer;
  readonly maxBytes: number;
  #q: Uint8Array[] = [];
  #bytes = 0;
  #cancel: (() => void) | null = null;
  readonly #timer: (fn: () => void, ms: number) => () => void;

  constructor(
    private readonly write: (data: Uint8Array) => void,
    o: RelayOutboxOptions = {},
  ) {
    this.pacer = o.pacer ?? new RelayPacer();
    this.maxBytes = o.maxBytes ?? RELAY_MAX_QUEUED_BYTES;
    this.#timer = o.timer ?? defaultTimer;
  }

  get queued(): number {
    return this.#bytes;
  }

  get length(): number {
    return this.#q.length;
  }

  /** Queue one envelope. False (nothing queued) for a non-forced one that would pass the cap. */
  push(data: Uint8Array, force = false): boolean {
    if (!force && this.#bytes + data.length > this.maxBytes) return false;
    this.#q.push(data);
    this.#bytes += data.length;
    this.#drain();
    return true;
  }

  /** Queue one envelope (encoded here). Control envelopes are forced; see `push`. */
  send(m: Parameters<typeof encodeRelay>[0], force = true): boolean {
    return this.push(encodeRelay(m), force);
  }

  /** LIMIT 1 from the room. */
  halve(): void {
    this.pacer.halve();
  }

  /** Write everything queued now, past the pacer (a closing socket's last words). */
  flush(): void {
    this.#cancel?.();
    this.#cancel = null;
    for (const data of this.#q.splice(0)) {
      try {
        this.write(data);
      } catch {
        // the close event follows
      }
    }
    this.#bytes = 0;
  }

  /** Drop everything queued and stop the timer (the socket is gone). */
  clear(): void {
    this.#cancel?.();
    this.#cancel = null;
    this.#q = [];
    this.#bytes = 0;
  }

  #drain(): void {
    if (this.#cancel !== null) return;
    while (this.#q.length > 0) {
      const wait = this.pacer.tryTake();
      if (wait > 0) {
        this.#cancel = this.#timer(
          () => {
            this.#cancel = null;
            this.#drain();
          },
          Math.max(1, Math.ceil(wait)),
        );
        return;
      }
      const data = this.#q.shift()!;
      this.#bytes -= data.length;
      try {
        this.write(data);
      } catch {
        // the close event follows
      }
    }
  }
}

/** The sign-out bound (decision D-12): run `stop`, never failing; true when `boundMs` passed first
 *  and the caller must force-cancel what `stop` was closing. */
export async function stopWithin(
  stop: () => Promise<unknown>,
  boundMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([
    stop().then(
      () => false,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), boundMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  clearTimeout(timer);
  return late;
}
