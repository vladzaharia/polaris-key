// Direct Transfer in the browser, `adapter.cloudConnect.transfer` (CC-20.4; WIRE-CONTRACT-V5
// §15.11): mode `a` over the relay only (a page cannot pair, D-14). Loaded with the Connect
// engine on the first `start()`; `index.ts` holds the lean facade and the types.
//
// Rules this module keeps (as the Node host):
//  - consent is per transfer: with no offer handler every offer is declined, and so is one whose
//    handler throws, answers nothing or names an unusable sink. There is no default accept and
//    nothing downloads by itself;
//  - the peer's `name` and `type` are display data handed to the handler. Nothing here builds a
//    storage key from them: partials are named by the derived reference alone (xferStore.ts);
//  - content reaches the host's sink only after the machine has checked the hash, and as a whole;
//  - the six record types are read by the machine only (the session refuses them to `send`);
//  - sign-out and deactivation remove every partial and spooled stream;
//  - only the tab that owns the relay holds sessions, so only it transfers; another tab's `send`
//    is the typed `elsewhere`.

import {
  MAX_PEER_MESSAGE_BYTES,
  XFER_DEFAULT_CHUNK,
  XFER_MAX_CHUNK,
  XFER_MAX_SIZE,
  XferDeliveredMemory,
  XferEndpoint,
  XferHasher,
  isXferId,
  type XferAsk,
  type XferPartial,
  type XferPartialEffect,
  type XferResult,
} from "@polaris-key/client-core/peer";
import { ErrorCode, Feature } from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import { PolarisError } from "../../core/types.js";
import { b64urlEncode, hex } from "./bytes.js";
import { printAs } from "./redact.js";
import type { ConnectSession, XferPort } from "./session.js";
import { SPOOL_BLOCK, XferStoreError, type XferStore } from "./xferStore.js";
import {
  TransferError,
  type IncomingOffer,
  type OfferDecision,
  type OfferHandler,
  type SendOptions,
  type SentTransfer,
  type TransferEvent,
  type TransferPeer,
  type TransferSource,
} from "./xferTypes.js";

const HASH_STEP = 1024 * 1024;

type Sink =
  | { blob: (blob: Blob) => void | Promise<void> }
  | { stream: (data: AsyncIterable<Uint8Array>) => Promise<void> }
  | { file: NonNullable<Extract<OfferDecision, { file: unknown }>>["file"] };

export interface TransferDeps {
  /** The receiver's store; null when the page cannot keep one (every offer is declined). */
  store: XferStore | null;
  openDevice(deviceId: string): Promise<ConnectSession>;
  /** What the facade holds. */
  handler(): OfferHandler | null;
  maxSize(): number | null;
  emit(e: TransferEvent): void;
}

interface Out {
  read(offset: number, length: number): Promise<Uint8Array>;
  resolve(): void;
  reject(e: Error): void;
}

interface Incoming {
  to: Sink;
  type?: string;
  /** The content was handed over by a `finalize`. */
  done: boolean;
}

interface Wire {
  session: ConnectSession;
  ep: XferEndpoint;
  peerKey: Uint8Array;
  out: Map<string, Out>;
  inc: Map<string, Incoming>;
  asking: Set<string>;
  owned: Set<string>;
  /** Reservation keys this wire holds against the store's room, by transfer id. */
  reserved: Map<string, string>;
  no: number;
  /** Prefixes re-read and hashed, ready for the machine's resume (by partial). */
  hashed: Map<string, { offset: number; hasher: XferHasher }>;
  /** A purge ended this wire: no effect reaches the store any more. */
  dead: boolean;
  /** End the session after a port failed: the partials stay. */
  fail(): void;
  consent(id: string, answer: "accept" | "decline"): void;
  /** The room check failed at accept: `CANCEL` `quota` for this transfer. */
  noRoom(id: string): void;
}

const clock = (): number => performance.now() / 1000;

export class CloudTransfer {
  readonly #wires = new WeakMap<ConnectSession, Promise<Wire | null>>();
  readonly #open = new Set<Wire>();
  /** Partials a live transfer holds, and by whom. */
  readonly #live = new Map<string, Wire>();
  /** What this page delivered, per peer key: a re-offer is answered as done (CC-20.F). */
  readonly #delivered = new XferDeliveredMemory();
  /** Sessions this module opened for `send`, reused while they stay open. */
  readonly #sessions = new Map<string, ConnectSession>();
  /** The machine's clock (seconds) and timer; tests drive them. @internal */
  timing: {
    now: () => number;
    timer: (fn: () => void, ms: number) => () => void;
  } | null = null;

  #serial = 0;

  constructor(private readonly deps: TransferDeps) {
    printAs(this, () => ({ transfer: "CloudTransfer" }));
    // A partial a live transfer holds is never the one made room for another.
    deps.store?.protect((ref) => this.#live.has(ref));
    // Another tab removed the database (a sign-out): nothing of ours may write it back.
    deps.store?.onInvalidated(() => void this.#killWires());
  }

  /**
   * Remove every partial and spooled stream: the sign-out step. Open sessions end first and
   * nothing they still had queued reaches the store afterwards.
   */
  async purge(): Promise<void> {
    this.#delivered.clear();
    await this.#killWires();
    await this.deps.store?.purgeAll();
  }

  /** Remove the partials kept for one peer key (a device that left the roster). */
  async purgePeer(peerKey: Uint8Array): Promise<void> {
    this.#delivered.forget(peerKey);
    await this.deps.store?.purgePeer(peerKey);
  }

  async #killWires(): Promise<void> {
    const wires = [...this.#open];
    for (const w of wires) {
      w.dead = true;
      w.ep.closed();
      w.session.close().catch(() => undefined);
    }
    await Promise.all(wires.map((w) => w.ep.idle().catch(() => undefined)));
    this.#live.clear();
  }

  cancel(id: string): boolean {
    for (const w of this.#open) {
      if (w.out.has(id) || w.inc.has(id) || w.asking.has(id)) {
        w.ep.cancel(id);
        return true;
      }
    }
    return false;
  }

  // ── sending ────────────────────────────────────────────────────────────────

  async send(
    peer: TransferPeer,
    source: TransferSource,
    opts: SendOptions = {},
  ): Promise<SentTransfer> {
    if (opts.signal?.aborted === true) throw new TransferError("cancelled");
    const session = await this.#sessionFor(peer);
    const wire = await this.#wireOf(session);
    if (wire === null)
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.connectTransfer,
          reason: "runtime",
          detail: "The peer does not offer Direct Transfer.",
        },
        ErrorCode.connectUnavailable,
      );
    const src = await prepare(this.deps.store, source, opts);
    const peerMax = Math.max(
      1,
      Math.min(session.hello.maxMessage - 24, XFER_MAX_CHUNK),
    );
    const chunk = Math.min(opts.chunk ?? XFER_DEFAULT_CHUNK, peerMax);
    const id =
      opts.id ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    if (!isXferId(id)) {
      await src.close();
      throw new PolarisError(
        ErrorCode.invalidArgument,
        "The transfer id is not valid.",
      );
    }
    let abort: (() => void) | undefined;
    try {
      const done = new Promise<void>((resolve, reject) => {
        wire.out.set(id, { read: src.read, resolve, reject });
      });
      done.catch(() => undefined);
      opts.onStart?.({ id, size: src.size, sha256: src.sha256 });
      wire.ep.offer({
        id,
        size: src.size,
        chunk,
        sha256: src.sha256,
        ...(src.name !== undefined ? { name: src.name } : {}),
        ...(src.type !== undefined ? { type: src.type } : {}),
        seekable: true,
      });
      if (opts.signal !== undefined) {
        abort = () => wire.ep.cancel(id);
        opts.signal.addEventListener("abort", abort, { once: true });
      }
      await done;
      return { id, size: src.size, sha256: src.sha256 };
    } finally {
      if (abort !== undefined) opts.signal?.removeEventListener("abort", abort);
      wire.out.delete(id);
      await src.close();
    }
  }

  async #sessionFor(peer: TransferPeer): Promise<ConnectSession> {
    if (typeof peer !== "string") {
      if (peer.closed !== null)
        throw new PolarisError(ErrorCode.peerClosed, "The session is closed.");
      return peer;
    }
    const held = this.#sessions.get(peer);
    if (held !== undefined && held.closed === null) return held;
    const s = await this.deps.openDevice(peer);
    this.#sessions.set(peer, s);
    s.onClose(() => {
      if (this.#sessions.get(peer) === s) this.#sessions.delete(peer);
    });
    return s;
  }

  // ── receiving ──────────────────────────────────────────────────────────────

  /** Take a session into Direct Transfer. Called for every session the engine opens or accepts. */
  adopt(session: ConnectSession): void {
    if (this.#wires.has(session)) return;
    const port = session.xferPort();
    if (port === null) return;
    const p = this.#build(session, port).catch((): null => {
      // The store would not open: nothing is read from this peer.
      port.close("peer_bye");
      return null;
    });
    this.#wires.set(session, p);
  }

  #wireOf(session: ConnectSession): Promise<Wire | null> {
    if (!this.#wires.has(session)) this.adopt(session);
    return this.#wires.get(session) ?? Promise.resolve(null);
  }

  async #build(session: ConnectSession, port: XferPort): Promise<Wire> {
    const store = this.deps.store;
    const listed = store === null ? [] : await store.list(port.peerKey);
    const tick = this.timing?.now ?? clock;
    const now = tick();
    let wire!: Wire;
    const heldElsewhere = (ref: string): boolean => {
      const w = this.#live.get(ref);
      return w !== undefined && w !== wire;
    };
    // The machine asks for a re-hashed prefix synchronously, so it is computed before the first
    // record is read; a partial that cannot be read back whole starts again.
    const hashed = new Map<string, { offset: number; hasher: XferHasher }>();
    const partials: XferPartial[] = [];
    for (const { age, ...p } of listed) {
      let reread = 0;
      if (store !== null && !heldElsewhere(p.ref)) {
        try {
          const r = await store.reread(p.ref, p.chunk, p.bytes);
          hashed.set(p.ref, r);
          reread = r.offset;
        } catch {
          await store.remove(p.ref).catch(() => undefined);
          continue;
        }
      }
      partials.push({
        ...p,
        writtenAt: now - age,
        held: heldElsewhere(p.ref),
        reread,
      });
    }
    const fail = (): void => {
      // A port failed inside the machine: the session ends, the partials stay.
      port.close("peer_bye");
      wire.ep.closed();
    };
    const guard = (fn: () => void): void => {
      try {
        fn();
      } catch {
        fail();
      }
    };
    const serial = ++this.#serial;
    const ep = new XferEndpoint({
      machine: {
        mode: "a",
        caps: session.caps,
        maxMessage: MAX_PEER_MESSAGE_BYTES,
        hostLimit: this.deps.maxSize(),
        free: () => (store === null ? 0 : store.free()),
        // The host's answer comes later and is the person's; with no handler the machine declines.
        handler: () => (this.deps.handler() === null ? "decline" : "ask"),
        peerKey: port.peerKey,
        partials,
        delivered: this.#delivered.forPeer(port.peerKey),
        ...(store !== null
          ? {
              // The prefix was re-read before the first record. When it is not there (or is not
              // the length asked for) this throws, and the session ends with the partial kept.
              rehash: (ref: string, offset: number) => {
                const h = hashed.get(ref);
                hashed.delete(ref);
                if (h === undefined || h.offset !== offset)
                  throw new XferStoreError("the partial was not re-read");
                return h.hasher;
              },
            }
          : {}),
      },
      send: port.send,
      close: (code) =>
        port.close(code === "peer_busy" ? "peer_busy" : "peer_bye"),
      read: (id, offset, length) => {
        const o = wire.out.get(id);
        return o === undefined
          ? Promise.reject(new Error("unknown transfer"))
          : o.read(offset, length);
      },
      apply: (e) => this.#apply(wire, e),
      now: tick,
      ...(this.timing !== null ? { timer: this.timing.timer } : {}),
      events: {
        ask: (a) => void this.#ask(wire, a),
        withdraw: (id) => {
          wire.asking.delete(id);
          this.#unreserve(wire, id);
        },
        result: (r) => void this.#result(wire, r),
        refused: (id) => {
          const o = wire.out.get(id);
          o?.reject(new TransferError("busy"));
          this.deps.emit({
            id,
            direction: "out",
            outcome: "cancelled",
            reason: "busy",
          });
        },
        error: () => undefined,
      },
    });
    wire = {
      session,
      ep,
      peerKey: port.peerKey,
      out: new Map(),
      inc: new Map(),
      asking: new Set(),
      owned: new Set(),
      reserved: new Map(),
      no: serial,
      hashed,
      dead: false,
      fail,
      consent: (id, answer) => guard(() => wire.ep.consent(id, answer)),
      noRoom: (id) => guard(() => wire.ep.noRoom(id)),
    };
    this.#open.add(wire);
    session.onClose((c) => {
      ep.closed();
      // A device that was revoked takes its partial transfers with it.
      if (c.code === "peer_revoked")
        void this.purgePeer(port.peerKey).catch(() => undefined);
      void ep.idle().then(() => {
        this.#open.delete(wire);
        for (const ref of wire.owned) this.#release(wire, ref);
        for (const id of [...wire.reserved.keys()]) this.#unreserve(wire, id);
      });
    });
    port.bind((type, body) => guard(() => ep.receive(type, body)));
    return wire;
  }

  #release(wire: Wire, ref: string): void {
    wire.owned.delete(ref);
    if (this.#live.get(ref) === wire) this.#live.delete(ref);
  }

  #claim(wire: Wire, ref: string): void {
    const w = this.#live.get(ref);
    if (w !== undefined && w !== wire)
      throw new XferStoreError("a live transfer holds that partial");
    this.#live.set(ref, wire);
    wire.owned.add(ref);
  }

  async #apply(wire: Wire, e: XferPartialEffect): Promise<void> {
    const store = this.deps.store;
    if (store === null || wire.dead) throw new XferStoreError("no store");
    const mine = (ref: string): boolean => {
      const w = this.#live.get(ref);
      return w === undefined || w === wire;
    };
    // A write belongs to the wire that claimed the partial; a closed session's queued write
    // never lands after another session took it over.
    if ("write" in e) {
      if (this.#live.get(e.write) !== wire)
        throw new XferStoreError("a live transfer holds that partial");
      return store.write(e.write, e.offset, e.data);
    }
    if ("create" in e) {
      const p = wire.ep.machine.partials().find((x) => x.ref === e.create);
      if (p === undefined) throw new XferStoreError("unknown partial");
      this.#claim(wire, e.create);
      await store.create(e.create, wire.peerKey, p);
      this.#bind(wire, e.create, p.id);
      return;
    }
    if ("truncate" in e) {
      this.#claim(wire, e.truncate);
      await store.truncate(e.truncate, e.to);
      const p = wire.ep.machine.partials().find((x) => x.ref === e.truncate);
      if (p !== undefined) this.#bind(wire, e.truncate, p.id);
      return;
    }
    if ("keep" in e) {
      this.#release(wire, e.keep);
      await store.keep(e.keep);
      // The kept bytes are read back now, so a repeated offer in this session can resume from
      // them (the machine asks for the hash without waiting).
      const p = wire.ep.machine.partials().find((x) => x.ref === e.keep);
      if (p !== undefined && p.bytes > 0 && !wire.dead) {
        const r = await store
          .reread(e.keep, p.chunk, p.bytes)
          .catch(() => null);
        if (r !== null) wire.hashed.set(e.keep, r);
      }
      return;
    }
    const ref =
      "delete" in e
        ? e.delete
        : "discard" in e
          ? e.discard
          : "evict" in e
            ? e.evict
            : null;
    if (ref !== null) {
      // A partial another live session now holds is theirs to finish.
      if (!mine(ref)) return;
      this.#release(wire, ref);
      return store.remove(ref);
    }
    // finalize: the hash matched. The content goes where the host said, whole.
    if (!("finalize" in e)) return;
    const meta = store.metaOf(e.finalize);
    const inc = meta === null ? undefined : wire.inc.get(meta.id);
    if (inc === undefined) throw new XferStoreError("no destination");
    await deliver(store, e.finalize, inc);
    inc.done = true;
    this.#release(wire, e.finalize);
    await store.remove(e.finalize);
  }

  #key(wire: Wire, id: string): string {
    return `${wire.no}:${id}`;
  }

  #bind(wire: Wire, ref: string, id: string): void {
    this.deps.store?.bind(ref, this.#key(wire, id));
  }

  #unreserve(wire: Wire, id: string): void {
    if (wire.reserved.delete(id)) this.deps.store?.release(this.#key(wire, id));
  }

  async #ask(wire: Wire, a: XferAsk): Promise<void> {
    try {
      await this.#decide(wire, a);
    } catch {
      // The person's code or a port failed while the question was open: end the session.
      wire.asking.delete(a.id);
      this.#unreserve(wire, a.id);
      wire.fail();
    }
  }

  async #decide(wire: Wire, a: XferAsk): Promise<void> {
    const s = wire.session;
    wire.asking.add(a.id);
    const handler = this.deps.handler();
    let to: Sink | null = null;
    try {
      if (handler !== null) {
        const offer: IncomingOffer = {
          id: a.id,
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.type !== undefined ? { type: a.type } : {}),
          size: a.size,
          from: {
            kind: "device",
            deviceId: s.peerDeviceId,
            label: s.hello.label ?? null,
          },
          path: "relay",
        };
        to = sinkOf(await handler(offer));
      }
    } catch {
      to = null;
    }
    if (!wire.asking.delete(a.id)) return; // withdrawn while the person decided
    // The room is checked and set aside now, at the accept: four offers that each fitted when they
    // arrived do not all fit together.
    const store = this.deps.store;
    let full = false;
    if (to !== null) {
      if (store === null || wire.dead) to = null;
      else if (!store.reserve(this.#key(wire, a.id), a.size)) {
        to = null;
        full = true;
      } else wire.reserved.set(a.id, this.#key(wire, a.id));
    }
    if (to === null)
      return full ? wire.noRoom(a.id) : wire.consent(a.id, "decline");
    // A kept partial is read back now, at the accept, not when the session began.
    if (store !== null)
      for (const p of wire.ep.machine.partials())
        if (p.id === a.id && p.bytes > 0 && !p.held) {
          const r = await store
            .reread(p.ref, p.chunk, p.bytes)
            .catch(() => null);
          if (r !== null) wire.hashed.set(p.ref, r);
          else wire.hashed.delete(p.ref);
        }
    wire.inc.set(a.id, {
      to,
      ...(a.type !== undefined ? { type: a.type } : {}),
      done: false,
    });
    wire.consent(a.id, "accept");
  }

  async #result(wire: Wire, r: XferResult): Promise<void> {
    this.#unreserve(wire, r.id);
    // A re-offer of delivered content, answered as done: the host is told nothing.
    if (r.outcome === "delivered" && r.again === true) return;
    const out = wire.out.get(r.id);
    if (out !== undefined) {
      if (r.outcome === "delivered") out.resolve();
      else if (r.outcome === "cancelled")
        out.reject(new TransferError(r.reason));
      else
        out.reject(
          new PolarisError(ErrorCode.peerClosed, "The session closed."),
        );
      return this.deps.emit({
        id: r.id,
        direction: "out",
        outcome: r.outcome,
        ...(r.outcome === "cancelled" ? { reason: r.reason } : {}),
      });
    }
    const inc = wire.inc.get(r.id);
    wire.inc.delete(r.id);
    let outcome: TransferEvent["outcome"] = r.outcome;
    if (r.outcome === "delivered" && inc !== undefined && !inc.done) {
      // A transfer of size 0 has no partial: the empty content is delivered now.
      try {
        await give(inc, (async function* () {})(), () => new Blob([]));
      } catch {
        outcome = "failed";
      }
    }
    this.deps.emit({
      id: r.id,
      direction: "in",
      outcome,
      ...(r.outcome === "cancelled" ? { reason: r.reason } : {}),
    });
  }
}

// ── delivery ─────────────────────────────────────────────────────────────────

function sinkOf(d: OfferDecision): Sink | null {
  if (d === false || d === null || d === undefined || d === "decline")
    return null;
  if (typeof d !== "object") return null;
  if ("blob" in d)
    return typeof d.blob === "function" ? { blob: d.blob } : null;
  if ("stream" in d)
    return typeof d.stream === "function" ? { stream: d.stream } : null;
  if ("file" in d)
    return d.file !== null &&
      typeof d.file === "object" &&
      typeof d.file.createWritable === "function"
      ? { file: d.file }
      : null;
  return null;
}

async function deliver(
  store: XferStore,
  ref: string,
  inc: Incoming,
): Promise<void> {
  await give(inc, store.read(ref), () => store.blob(ref, inc.type));
}

/** Hand the verified content to the host's sink, as the sink asked: a Blob, chunks, or a file. */
async function give(
  inc: Incoming,
  data: AsyncIterable<Uint8Array>,
  whole: () => Blob | Promise<Blob>,
): Promise<void> {
  const to = inc.to;
  if ("blob" in to) return void (await to.blob(await whole()));
  if ("stream" in to) return to.stream(data);
  // File System Access: the browser keeps the old file until close() succeeds.
  const w = await to.file.createWritable();
  try {
    for await (const part of data) await w.write(part);
    await w.close();
  } catch (e) {
    await w.abort?.().catch(() => undefined);
    throw e;
  }
}

// ── sources ──────────────────────────────────────────────────────────────────

interface Prepared {
  size: number;
  sha256: string;
  name?: string;
  type?: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Cut to 255 UTF-8 bytes at a code-point boundary. */
function cutName(name: string): string {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= 255) return name;
  let out = "";
  let n = 0;
  for (const ch of name) {
    const b = enc.encode(ch).length;
    if (n + b > 255) break;
    out += ch;
    n += b;
  }
  return out;
}

async function* chunksOf(
  s: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (!("getReader" in s)) return yield* s;
  const reader = s.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function prepare(
  store: XferStore | null,
  source: TransferSource,
  opts: SendOptions,
): Promise<Prepared> {
  const label = (
    fallbackName?: string,
    fallbackType?: string,
  ): { name?: string; type?: string } => {
    const n = opts.name ?? fallbackName;
    const t = opts.type ?? fallbackType;
    return {
      ...(n === undefined || n === "" ? {} : { name: cutName(n) }),
      ...(t === undefined || t === "" ? {} : { type: t }),
    };
  };
  if (source instanceof Uint8Array) {
    const bytes = source.slice();
    return {
      size: bytes.length,
      sha256: hex(new XferHasher().update(bytes).digest()),
      ...label(),
      read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)),
      close: () => Promise.resolve(),
    };
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (source.size > XFER_MAX_SIZE)
      throw new PolarisError(
        ErrorCode.invalidArgument,
        "The source is too large.",
      );
    const hash = new XferHasher();
    for (let at = 0; at < source.size; at += HASH_STEP)
      hash.update(
        new Uint8Array(await source.slice(at, at + HASH_STEP).arrayBuffer()),
      );
    const fileName = (source as { name?: unknown }).name;
    return {
      size: source.size,
      sha256: hex(hash.digest()),
      ...label(
        typeof fileName === "string" ? fileName : undefined,
        source.type,
      ),
      read: async (o, l) => {
        const got = new Uint8Array(await source.slice(o, o + l).arrayBuffer());
        // A file that changed under the read is not the one that was hashed.
        if (got.length !== l) throw new Error("source length");
        return got;
      },
      close: () => Promise.resolve(),
    };
  }
  // A one-pass stream: the offer carries the hash, so spool and hash it first.
  if (store === null || !store.available)
    throw new UnsupportedError(
      {
        supported: false,
        feature: Feature.connectTransfer,
        reason: "runtime",
        detail: "This page cannot spool a stream; send a Blob instead.",
      },
      ErrorCode.connectUnavailable,
    );
  const ref = await store.spoolStart();
  const cleanup = (): Promise<void> =>
    store.spoolDrop(ref).catch(() => undefined);
  const hash = new XferHasher();
  let size = 0;
  let block = new Uint8Array(SPOOL_BLOCK);
  let fill = 0;
  let index = 0;
  try {
    for await (const part of chunksOf(
      source as ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    )) {
      if (size + part.length > XFER_MAX_SIZE)
        throw new PolarisError(
          ErrorCode.invalidArgument,
          "The source is too large.",
        );
      hash.update(part);
      size += part.length;
      let at = 0;
      while (at < part.length) {
        const n = Math.min(part.length - at, SPOOL_BLOCK - fill);
        block.set(part.subarray(at, at + n), fill);
        fill += n;
        at += n;
        if (fill === SPOOL_BLOCK) {
          await store.spoolWrite(ref, index++, block);
          block = new Uint8Array(SPOOL_BLOCK);
          fill = 0;
        }
      }
    }
    if (fill > 0) await store.spoolWrite(ref, index, block.subarray(0, fill));
  } catch (e) {
    await cleanup();
    throw e;
  }
  return {
    size,
    sha256: hex(hash.digest()),
    ...label(),
    read: (o, l) => store.spoolRead(ref, o, l),
    close: cleanup,
  };
}
