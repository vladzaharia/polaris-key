// WIRE-CONTRACT-V5 §15.11: runs an `XferMachine` over a `PeerSession`. The machine decides; this
// layer performs what it asks, in order: effects on the partial files, then the records, then the
// events for the host. It reads the sender's bytes and stores the receiver's through ports. The
// host API (`cloudConnect.transfer.*`) is the SDK's, on top of this.

import type { PeerSession } from "./session.js";
import type { PeerCloseCode } from "./record.js";
import {
  XFER,
  XferMachine,
  isXferType,
  xferCancelBody,
  xferChunkBody,
  xferDoneBody,
  xferOfferBody,
  xferOffsetBody,
  type XferAsk,
  type XferMachineOptions,
  type XferOfferArgs,
  type XferOut,
  type XferPartialEffect,
  type XferResult,
  type XferSend,
} from "./xfer.js";

/** What the host sees of a transfer. */
export interface XferEvents {
  /** The host is asked about an `OFFER`; it answers with `consent`. */
  ask(a: XferAsk): void;
  /** The question for this id is withdrawn (the peer or a timer ended the transfer). */
  withdraw(id: string): void;
  result(r: XferResult): void;
  /** The host's own `offer` was refused locally: too many live transfers. */
  refused(id: string): void;
  /** A port failed; the session is being closed and the partials are kept. */
  error(err: unknown): void;
}

export interface XferEndpointOptions {
  /** The machine's options other than the ones the session supplies. */
  machine: XferMachineOptions;
  /** The writer `session.attachXfer` returned. */
  send: (type: number, body: Uint8Array) => Promise<void>;
  /** Close the session with a code (`session.close`). */
  close: (code: PeerCloseCode) => void;
  /** The sender's source: bytes `[offset, offset + length)` of the transfer `id`. */
  read: (id: string, offset: number, length: number) => Promise<Uint8Array>;
  /** The receiver's store: an effect on the partial files, or a write into one. */
  apply: (e: XferPartialEffect) => Promise<void>;
  events: XferEvents;
  /** A monotonic clock in seconds. Default `performance.now() / 1000`. */
  now?: () => number;
  /** Schedule `fn` after `ms`; returns the cancel. Default `setTimeout`. */
  timer?: (fn: () => void, ms: number) => () => void;
}

export class XferEndpoint {
  readonly machine: XferMachine;
  private chain: Promise<void> = Promise.resolve();
  private chunk = new Map<string, number>();
  private cancelTimer: (() => void) | null = null;
  private dead = false;
  private readonly now: () => number;
  private readonly timer: (fn: () => void, ms: number) => () => void;

  constructor(private readonly o: XferEndpointOptions) {
    this.machine = new XferMachine(o.machine);
    this.now = o.now ?? ((): number => performance.now() / 1000);
    this.timer =
      o.timer ??
      ((fn, ms): (() => void) => {
        const h = setTimeout(fn, ms);
        (h as { unref?: () => void }).unref?.();
        return (): void => clearTimeout(h);
      });
  }

  /** Attach to an open session whose capabilities include `xfer/1`. */
  static attach(
    session: PeerSession,
    o: Omit<XferEndpointOptions, "send" | "close">,
  ): XferEndpoint {
    let ep: XferEndpoint | null = null;
    const send = session.attachXfer((type, body) => ep?.receive(type, body));
    ep = new XferEndpoint({
      ...o,
      send,
      close: (code) => void session.close(code),
    });
    return ep;
  }

  /** A record of the session: one of the six types. */
  receive(type: number, body: Uint8Array): void {
    if (this.dead || !isXferType(type)) return;
    this.handle(this.machine.receive(this.now(), type, body));
  }

  offer(a: XferOfferArgs): void {
    const out = this.machine.offer(this.now(), a);
    if (out.refused === undefined) this.chunk.set(a.id, a.chunk);
    this.handle(out, a.id);
  }

  consent(id: string, answer: "accept" | "decline"): void {
    this.handle(this.machine.consent(this.now(), id, answer));
  }

  cancel(id: string): void {
    this.handle(this.machine.cancel(this.now(), id));
  }

  /** The session closed: every live transfer ends `closed` and the partials stay. */
  closed(): void {
    if (this.dead) return;
    this.handle(this.machine.abandon(this.now()));
    this.dead = true;
    this.cancelTimer?.();
  }

  /** Resolves when everything queued so far has been performed. */
  idle(): Promise<void> {
    return this.chain;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private handle(out: XferOut, offered?: string): void {
    const failed = new Set<string>();
    this.chain = this.chain.then(async () => {
      try {
        for (const e of out.partial) await this.o.apply(e);
        // Remembered only once the host's delivery succeeded.
        for (const d of out.delivered ?? [])
          this.o.machine.delivered?.add(d.id, d.sha256, d.size, this.now());
        for (const s of out.send) await this.perform(s, failed);
      } catch (err) {
        this.o.events.error(err);
        this.o.close("peer_bye");
        return;
      }
      for (const id of out.withdraw) this.o.events.withdraw(id);
      if (out.ask !== undefined) this.o.events.ask(out.ask);
      if (out.refused !== undefined && offered !== undefined)
        this.o.events.refused(offered);
      for (const r of out.results) this.o.events.result(r);
      for (const id of failed) this.handle(this.machine.fail(this.now(), id));
    });
    if (out.close !== undefined) {
      this.o.close(out.close);
      this.handle(this.machine.abandon(this.now()));
      this.dead = true;
    }
    this.arm();
  }

  private async perform(s: XferSend, failed: Set<string>): Promise<void> {
    if ((s.t === "CHUNKS" || s.t === "DONE") && failed.has(s.id)) return;
    switch (s.t) {
      case "OFFER":
        return this.o.send(XFER.OFFER, xferOfferBody(s));
      case "ACCEPT":
        return this.o.send(XFER.ACCEPT, xferOffsetBody(s.id, s.offset));
      case "ACK":
        return this.o.send(XFER.ACK, xferOffsetBody(s.id, s.offset));
      case "DONE":
        return this.o.send(XFER.DONE, xferDoneBody(s.id, s.sha256));
      case "CANCEL":
        return this.o.send(XFER.CANCEL, xferCancelBody(s.id, s.reason));
      case "CHUNKS": {
        const chunk = this.chunk.get(s.id)!;
        for (let at = s.offset; at < s.offset + s.bytes; at += chunk) {
          const len = Math.min(chunk, s.offset + s.bytes - at);
          let data: Uint8Array;
          try {
            data = await this.o.read(s.id, at, len);
            if (data.length !== len) throw new Error("source length");
          } catch {
            // The source failed: the transfer ends here, and its `DONE` never goes out.
            failed.add(s.id);
            return;
          }
          await this.o.send(XFER.CHUNK, xferChunkBody(s.id, at, data));
        }
      }
    }
  }

  /** One timer, set for the machine's next wait. */
  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (this.dead) return;
    const at = this.machine.nextDeadline();
    if (at === null) return;
    this.cancelTimer = this.timer(
      () => {
        this.cancelTimer = null;
        if (!this.dead) this.handle(this.machine.tick(this.now()));
      },
      Math.max(0, at - this.now()) * 1000,
    );
  }
}
