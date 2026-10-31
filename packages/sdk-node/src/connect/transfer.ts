// Direct Transfer, `client.cloudConnect.transfer` (CC-20.3; WIRE-CONTRACT-V5 §15.11): send a file
// or a stream of bytes to one of the person's devices or to a link, and decide what to do with an
// offer that arrives.
//
//   send(peer, source, opts)   offer `source` (a file path, bytes, or a stream) and resolve when the
//                              peer has verified and delivered it; reject with `transfer-cancelled`
//                              (carries `reason`) or `peer-closed`
//   onOffer(handler)           called for each offer that arrives; the handler answers, per transfer,
//                              with where the content goes, or declines
//   onResult(fn)               called when a transfer, either way, ends
//
// Rules this module keeps (R-9b):
//  - consent is per transfer: with no offer handler every offer is declined, and so is one whose
//    handler throws, answers nothing or names an unusable destination. There is no default accept;
//  - the peer's `name`, `type` and `category` are display data handed to the handler. Nothing here
//    builds a path from them: the partial files are named by the derived reference alone (the
//    store), and a delivered file goes only where the handler said;
//  - content reaches the handler's destination only after the machine has checked the hash, and as
//    a whole: written beside the destination under a random name, synced and moved into place;
//  - the six record types are read by the machine only (the session refuses them to `send`);
//  - sign-out and deactivation remove every partial file and spooled stream; deleting a link removes
//    that peer's partials;
//  - a peer key never leaves the store's files in the clear but as the derived reference and the
//    peer's own (public) key in the partial's record.

import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { PolarisError, UnsupportedError } from "@polaris-key/client-core";
import {
  MAX_PEER_MESSAGE_BYTES,
  XFER_DEFAULT_CHUNK,
  XFER_MAX_CHUNK,
  XFER_MAX_SIZE,
  XferEndpoint,
  isXferId,
  type XferAsk,
  type XferPartial,
  type XferPartialEffect,
  type XferReason,
  type XferResult,
} from "@polaris-key/client-core/peer";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { ErrorCode, Feature } from "../constants.generated.js";
import { printAs } from "../core/redact.js";
import { ConnectSession, type XferPort } from "./session.js";
import {
  PartialStore,
  TransferStoreError,
  writeFileAtomic,
  type DeliverTo,
} from "./transferStore.js";

/** A device of the person's, a link (`cloudConnect.links.list()[i].id`), or an open session. */
export type TransferPeer = string | { link: string } | ConnectSession;

/** What to send: a file path, bytes already in memory, or a stream (spooled to disk and hashed first). */
export type TransferSource =
  | string
  | Uint8Array
  | AsyncIterable<Uint8Array>
  | { path: string };

export interface SendOptions {
  /** Display data for the receiver, at most 255 UTF-8 bytes. Defaults to a file's base name. */
  name?: string;
  /** A media type, display data only. */
  type?: string;
  /** The data category (§15.10); a link's receiver refuses an offer without one it approved. */
  category?: string;
  /** Bytes per record, at most what the peer accepts (default 61,440). */
  chunk?: number;
  /** Aborting cancels the transfer (the reason the receiver sees is `cancelled`). */
  signal?: AbortSignal;
  /**
   * The id to offer under (22 base64url characters). Offer the same id and content again after an
   * interrupted send and the receiver resumes from the bytes it kept (§15.11, "Resume").
   */
  id?: string;
  /** Called with the id once the source is ready and just before the offer goes out. */
  onStart?: (t: { id: string; size: number; sha256: string }) => void;
}

export interface SentTransfer {
  id: string;
  size: number;
  /** Lowercase hex SHA-256 of the content. */
  sha256: string;
}

/** What the offer handler is shown. All text is the peer's: display data, never a path. */
export interface IncomingOffer {
  id: string;
  /** Cleaned display name, at most 255 bytes. */
  name?: string;
  type?: string;
  size: number;
  category?: string;
  from:
    | { kind: "device"; deviceId: string; label: string | null }
    | { kind: "link"; linkId: string; label: string | null };
  path: "lan" | "relay";
}

/**
 * The handler's answer. A file: `saveTo` is an absolute path chosen by the host, in a folder that
 * exists; an existing file is kept and the transfer is declined unless `overwrite` is true. A
 * stream: `stream` receives the verified content. Anything else declines.
 */
export type OfferDecision =
  | false
  | null
  | undefined
  | "decline"
  | { saveTo: string; overwrite?: boolean }
  | { stream: (data: AsyncIterable<Uint8Array>) => Promise<void> };

export type OfferHandler = (
  offer: IncomingOffer,
) => OfferDecision | Promise<OfferDecision>;

export interface TransferEvent {
  id: string;
  direction: "in" | "out";
  outcome: "delivered" | "cancelled" | "closed" | "failed";
  reason?: XferReason;
}

/** A transfer ended without its content delivered (`transfer-cancelled`). */
export class TransferError extends PolarisError {
  constructor(
    readonly reason: XferReason,
    message?: string,
  ) {
    super(
      ErrorCode.transferCancelled,
      message ?? `The transfer ended: ${reason}.`,
    );
    this.name = "TransferError";
  }
}

export interface TransferDeps {
  /** The receiver's store; null when this client has no state directory (every offer is declined). */
  store: PartialStore | null;
  openDevice(deviceId: string): Promise<ConnectSession>;
  openLink(linkId: string): Promise<ConnectSession>;
  hasLink(linkId: string): Promise<boolean>;
}

interface Out {
  read(offset: number, length: number): Promise<Uint8Array>;
  resolve(): void;
  reject(e: Error): void;
}

interface Incoming {
  size: number;
  to: DeliverTo;
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
  /** The store's generation when the session was taken in. */
  gen: number;
  seq: number;
  /** Set when the peer's link or device went: no partial may be made for it any more. */
  dead: boolean;
  /** Reservation tokens this wire holds, by transfer id. */
  tokens: Map<string, string>;
}

let wireSeq = 0;

const clock = (): number => performance.now() / 1000;

export class CloudTransfer {
  #handler: OfferHandler | null = null;
  readonly #results = new Set<(e: TransferEvent) => void>();
  readonly #wires = new WeakMap<ConnectSession, Promise<Wire | null>>();
  readonly #open = new Set<Wire>();
  /** Partials a live transfer holds, and by whom. */
  readonly #live = new Map<string, Wire>();
  /** Sessions this module opened for `send`, reused while they stay open. */
  readonly #sessions = new Map<string, ConnectSession>();
  #maxSize: number | null = null;
  /** The machine's clock (seconds) and timer; tests drive them. @internal */
  timing: {
    now: () => number;
    timer: (fn: () => void, ms: number) => () => void;
  } | null = null;

  constructor(private readonly deps: TransferDeps) {
    printAs(this, () => ({ transfer: "CloudTransfer" }));
  }

  /** The largest transfer this device accepts; null (default) for the protocol's own limit. */
  set maxSize(bytes: number | null) {
    this.#maxSize = bytes;
  }
  get maxSize(): number | null {
    return this.#maxSize;
  }

  /** The most bytes partial files may take together (default 4 GiB). */
  set quotaBytes(bytes: number) {
    this.deps.store?.setQuota(bytes);
  }

  /**
   * Decide each offer that arrives. One handler at a time (a new one replaces the old); `null`
   * removes it, and without one every offer is declined. Returns a function that removes this
   * handler.
   */
  onOffer(handler: OfferHandler | null): () => void {
    this.#handler = handler;
    return () => {
      if (this.#handler === handler) this.#handler = null;
    };
  }

  /** Called when a transfer ends, whichever way it was going. Returns the unsubscribe. */
  onResult(fn: (e: TransferEvent) => void): () => void {
    this.#results.add(fn);
    return () => this.#results.delete(fn);
  }

  /**
   * Cancel a transfer by id, either direction: the peer is told `cancelled`, an incoming transfer's
   * partial file is deleted. False when no live transfer has that id.
   */
  cancel(id: string): boolean {
    for (const w of this.#open) {
      if (w.out.has(id) || w.inc.has(id) || w.asking.has(id)) {
        w.ep.cancel(id);
        return true;
      }
    }
    return false;
  }

  /** Remove every partial file and spooled stream: the sign-out step. */
  async purge(): Promise<void> {
    await this.deps.store?.purgeAll();
  }

  /** Remove the partials kept for one peer key (a deleted link). @internal */
  async purgePeer(peerKey: Uint8Array): Promise<void> {
    // Sessions of that peer make no more partials (a late `create` would bring one back).
    const hex = Buffer.from(peerKey).toString("hex");
    for (const w of this.#open)
      if (Buffer.from(w.peerKey).toString("hex") === hex) w.dead = true;
    await this.deps.store?.purgePeer(peerKey);
  }

  // ── sending ────────────────────────────────────────────────────────────────

  async send(
    peer: TransferPeer,
    source: TransferSource,
    opts: SendOptions = {},
  ): Promise<SentTransfer> {
    const store = this.deps.store;
    if (store === null)
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.connectTransfer,
          reason: "runtime",
          detail: "This client has no state directory to transfer through.",
        },
        ErrorCode.connectUnavailable,
      );
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
    const src = await prepare(store, source, opts);
    const peerMax = Math.max(
      1,
      Math.min(session.hello.maxMessage - 24, XFER_MAX_CHUNK),
    );
    const chunk = Math.min(opts.chunk ?? XFER_DEFAULT_CHUNK, peerMax);
    const id = opts.id ?? base64UrlEncodeBytes(randomBytes(16));
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
        ...(opts.category !== undefined ? { cat: opts.category } : {}),
        ...(src.name !== undefined ? { name: src.name } : {}),
        ...(opts.type !== undefined ? { type: opts.type } : {}),
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
    if (peer instanceof ConnectSession) {
      if (peer.closed !== null)
        throw new PolarisError(ErrorCode.peerClosed, "The session is closed.");
      return peer;
    }
    const isLink = typeof peer !== "string";
    const key = isLink ? `l:${peer.link}` : `d:${peer}`;
    const held = this.#sessions.get(key);
    if (held !== undefined && held.closed === null) return held;
    let s: ConnectSession;
    if (isLink) {
      if (!(await this.deps.hasLink(peer.link)))
        throw new PolarisError(
          ErrorCode.linkUnknown,
          "That is not a link on this device.",
        );
      s = await this.deps.openLink(peer.link);
    } else s = await this.deps.openDevice(peer);
    this.#sessions.set(key, s);
    s.onClose(() => {
      if (this.#sessions.get(key) === s) this.#sessions.delete(key);
    });
    return s;
  }

  // ── receiving ──────────────────────────────────────────────────────────────

  /** Take a session into Direct Transfer. Called for every session this client opens or accepts. @internal */
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
    store?.startSweeper();
    const tick = this.timing?.now ?? clock;
    const now = tick();
    let wire!: Wire;
    const heldElsewhere = (ref: string): boolean => {
      const w = this.#live.get(ref);
      return w !== undefined && w !== wire && w.session.closed === null;
    };
    const partials: XferPartial[] = listed.map(({ age, ...p }) => ({
      ...p,
      writtenAt: now - age,
      held: heldElsewhere(p.ref),
    }));
    const guard = (fn: () => void): void => {
      try {
        fn();
      } catch {
        // A port failed inside the machine: the session ends, the partials stay.
        port.close("peer_bye");
        wire.ep.closed();
      }
    };
    const ep = new XferEndpoint({
      machine: {
        mode: session.contact !== null ? "c" : "a",
        caps: session.caps,
        maxMessage: MAX_PEER_MESSAGE_BYTES,
        hostLimit: this.#maxSize,
        free: () => (store === null ? 0 : store.free()),
        // The host's answer comes later and is the person's; with no handler the machine declines.
        handler: () => (this.#handler === null ? "decline" : "ask"),
        ...(session.contact !== null
          ? { categories: session.contact.categories }
          : {}),
        peerKey: port.peerKey,
        partials,
        ...(store !== null
          ? {
              // The partial is claimed before it is read, so no other session can change the
              // bytes between the re-read and the truncate. A failure is a fresh start.
              rehash: (ref: string, offset: number) => {
                this.#claim(wire, ref);
                try {
                  return store.rehash(ref, offset);
                } catch (e) {
                  this.#release(wire, ref);
                  throw e;
                }
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
        ask: (a) => void this.#ask(wire, a).catch(() => this.#abort(wire)),
        withdraw: (id) => wire.asking.delete(id),
        result: (r) => void this.#result(wire, r),
        refused: (id) => {
          const o = wire.out.get(id);
          o?.reject(new TransferError("busy"));
          this.#emit({
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
      gen: store?.generation ?? 0,
      seq: ++wireSeq,
      dead: false,
      tokens: new Map(),
    };
    this.#open.add(wire);
    session.onClose(() => {
      ep.closed();
      void ep.idle().then(() => {
        this.#open.delete(wire);
        for (const ref of [...wire.owned]) this.#release(wire, ref);
        for (const t of wire.tokens.values()) this.deps.store?.release(t);
        wire.tokens.clear();
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
    // A session that has closed only has its `keep` left to do: its partial may be taken over.
    if (w !== undefined && w !== wire && w.session.closed === null)
      throw new TransferStoreError("a live transfer holds that partial");
    if (w !== undefined && w !== wire) w.owned.delete(ref);
    this.#live.set(ref, wire);
    wire.owned.add(ref);
  }

  async #apply(wire: Wire, e: XferPartialEffect): Promise<void> {
    const store = this.deps.store;
    if (store === null) throw new TransferStoreError("no store");
    const mine = (ref: string): boolean => {
      const w = this.#live.get(ref);
      return w === undefined || w === wire || w.session.closed !== null;
    };
    // After a purge (sign-out, a deleted link) a session that was already running makes nothing.
    const live = (): void => {
      if (wire.dead || wire.gen !== store.generation)
        throw new TransferStoreError("the store was purged");
    };
    if ("write" in e) {
      live();
      // A session that has closed may have effects still queued. Once a new session has taken
      // its partial over (`#claim`), they land nowhere: the new session re-read and truncated it.
      if (this.#live.get(e.write) !== wire) return;
      return store.write(e.write, e.offset, e.data);
    }
    if ("create" in e) {
      live();
      const p = wire.ep.machine.partials().find((x) => x.ref === e.create);
      if (p === undefined) throw new TransferStoreError("unknown partial");
      this.#claim(wire, e.create);
      const tok = wire.tokens.get(p.id);
      if (tok !== undefined) store.bind(tok, e.create);
      return store.create(e.create, wire.peerKey, p);
    }
    if ("truncate" in e) {
      live();
      this.#claim(wire, e.truncate);
      const id = wire.ep.machine
        .partials()
        .find((x) => x.ref === e.truncate)?.id;
      const tok = id === undefined ? undefined : wire.tokens.get(id);
      if (tok !== undefined) store.bind(tok, e.truncate);
      return store.truncate(e.truncate, e.to);
    }
    if ("keep" in e) {
      if (!mine(e.keep)) return;
      this.#release(wire, e.keep);
      return store.keep(e.keep);
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
    const meta = await store.metaOf(e.finalize);
    const inc = meta === null ? undefined : wire.inc.get(meta.id);
    if (inc === undefined) throw new TransferStoreError("no destination");
    await store.deliver(e.finalize, inc.to);
    inc.done = true;
    this.#release(wire, e.finalize);
  }

  async #ask(wire: Wire, a: XferAsk): Promise<void> {
    const s = wire.session;
    wire.asking.add(a.id);
    const handler = this.#handler;
    let to: DeliverTo | null = null;
    try {
      if (handler !== null) {
        const offer: IncomingOffer = {
          id: a.id,
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.type !== undefined ? { type: a.type } : {}),
          size: a.size,
          ...(a.cat !== undefined ? { category: a.cat } : {}),
          from:
            s.contact !== null
              ? { kind: "link", linkId: s.contact.id, label: s.contact.label }
              : {
                  kind: "device",
                  deviceId: s.peerDeviceId,
                  label: s.hello.label ?? null,
                },
          path: s.path,
        };
        to = await destination(await handler(offer));
      }
    } catch {
      to = null;
    }
    if (!wire.asking.delete(a.id)) return; // withdrawn while the person decided
    this.#consent(wire, a.id, to === null ? "decline" : "accept", to, a.size);
  }

  /** Answer the machine; a throw inside it ends the session (the partials stay), never the process. */
  #consent(
    wire: Wire,
    id: string,
    answer: "accept" | "decline",
    to: DeliverTo | null,
    size: number,
  ): void {
    const store = this.deps.store;
    const token = `${wire.seq}:${id}`;
    try {
      if (answer === "accept" && to !== null) {
        wire.inc.set(id, { size, to, done: false });
        // The bytes are promised from now on: the next offer sees them as taken.
        if (store !== null) {
          store.reserve(token, size);
          wire.tokens.set(id, token);
        }
      }
      wire.ep.consent(id, answer);
    } catch {
      this.#abort(wire);
    }
  }

  #abort(wire: Wire): void {
    wire.session.close("peer_bye").catch(() => undefined);
    wire.ep.closed();
  }

  async #result(wire: Wire, r: XferResult): Promise<void> {
    const tok = wire.tokens.get(r.id);
    if (tok !== undefined) {
      this.deps.store?.release(tok);
      wire.tokens.delete(r.id);
    }
    const out = wire.out.get(r.id);
    if (out !== undefined) {
      if (r.outcome === "delivered") out.resolve();
      else if (r.outcome === "cancelled")
        out.reject(new TransferError(r.reason));
      else
        out.reject(
          new PolarisError(ErrorCode.peerClosed, "The session closed."),
        );
      return this.#emit({
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
      // A transfer of size 0 has no partial file: the empty content is delivered now.
      try {
        if ("stream" in inc.to) await inc.to.stream(emptyStream());
        else
          await writeFileAtomic(
            inc.to.saveTo,
            inc.to.overwrite,
            async (tmp) => {
              const fh = await open(tmp, "wx", 0o600);
              await fh.close();
            },
          );
      } catch {
        outcome = "failed";
      }
    }
    this.#emit({
      id: r.id,
      direction: "in",
      outcome,
      ...(r.outcome === "cancelled" ? { reason: r.reason } : {}),
    });
  }

  #emit(e: TransferEvent): void {
    for (const f of [...this.#results]) {
      try {
        f(e);
      } catch {
        // The host's bug is the host's.
      }
    }
  }
}

async function destination(d: OfferDecision): Promise<DeliverTo | null> {
  if (d === false || d === null || d === undefined || d === "decline")
    return null;
  if (typeof d !== "object") return null;
  if ("stream" in d)
    return typeof d.stream === "function" ? { stream: d.stream } : null;
  if (typeof d.saveTo !== "string") return null;
  const to = { saveTo: d.saveTo, overwrite: d.overwrite === true };
  // The folder must exist and the file must be free, or the person is not asked to wait for nothing.
  if (!isAbsolute(to.saveTo) || to.saveTo.endsWith("/")) return null;
  const dir = await stat(dirname(to.saveTo)).catch(() => null);
  if (dir === null || !dir.isDirectory()) return null;
  if (!to.overwrite && (await stat(to.saveTo).catch(() => null)) !== null)
    return null;
  return to;
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {
  // no chunks
}

interface Prepared {
  size: number;
  sha256: string;
  name?: string;
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

async function prepare(
  store: PartialStore,
  source: TransferSource,
  opts: SendOptions,
): Promise<Prepared> {
  const named = (fallback?: string): { name?: string } => {
    const n = opts.name ?? fallback;
    return n === undefined ? {} : { name: cutName(n) };
  };
  if (source instanceof Uint8Array) {
    const bytes = source.slice();
    return {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...named(),
      read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)),
      close: () => Promise.resolve(),
    };
  }
  if (typeof source === "string" || "path" in source) {
    const path = typeof source === "string" ? source : source.path;
    const fh = await open(path, "r");
    try {
      const st = await fh.stat();
      if (!st.isFile())
        throw new PolarisError(
          ErrorCode.invalidArgument,
          "The source is not a file.",
        );
      if (st.size > XFER_MAX_SIZE)
        throw new PolarisError(
          ErrorCode.invalidArgument,
          "The source is too large.",
        );
      return await fromHandle(
        fh,
        st.size,
        async () => undefined,
        named(basename(path)),
      );
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  }
  // A one-pass stream: the offer carries the hash, so spool and hash it first.
  const { path, fh } = await store.spool();
  const hash = createHash("sha256");
  let size = 0;
  const cleanup = async (): Promise<void> => {
    await fh.close().catch(() => undefined);
    await rm(path, { force: true });
  };
  try {
    for await (const part of source) {
      if (size + part.length > XFER_MAX_SIZE)
        throw new PolarisError(
          ErrorCode.invalidArgument,
          "The source is too large.",
        );
      hash.update(part);
      let at = 0;
      while (at < part.length) {
        const { bytesWritten } = await fh.write(
          part,
          at,
          part.length - at,
          size + at,
        );
        at += bytesWritten;
      }
      size += part.length;
    }
  } catch (e) {
    await cleanup();
    throw e;
  }
  const p = await fromHandle(fh, size, cleanup, named());
  return { ...p, sha256: hash.digest("hex") };
}

async function fromHandle(
  fh: FileHandle,
  size: number,
  after: () => Promise<void>,
  extra: { name?: string },
): Promise<Prepared> {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  for (let at = 0; at < size; ) {
    const { bytesRead } = await fh.read(
      buf,
      0,
      Math.min(buf.length, size - at),
      at,
    );
    if (bytesRead === 0)
      throw new PolarisError(
        ErrorCode.invalidArgument,
        "The source changed while it was read.",
      );
    hash.update(buf.subarray(0, bytesRead));
    at += bytesRead;
  }
  return {
    size,
    sha256: hash.digest("hex"),
    ...extra,
    read: async (offset, length) => {
      const out = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await fh.read(
          out,
          got,
          length - got,
          offset + got,
        );
        if (bytesRead === 0) throw new Error("source length");
        got += bytesRead;
      }
      return out;
    },
    close: async () => {
      await fh.close().catch(() => undefined);
      await after();
    },
  };
}
