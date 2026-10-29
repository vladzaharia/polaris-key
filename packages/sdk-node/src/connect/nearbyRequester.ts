// The requester half of nearby approval (CC-15.N3; WIRE-CONTRACT-V5 §15.6.1): a device with no
// sign-in (D) browses for approvers, dials a few, lists them by their `HELLO` and lets its person
// tap one. Only then does the code run on that session; the others close `peer_bye` before any
// code record, so no other approver ever prompts. D shows its code, sends `VOUCH_REQ` and reads
// `VOUCH_RESULT`. It calls no route: the host holds the request from `nearby/start` and polls.
//
// Rules this module keeps:
//  - D connects out and never listens; it browses `_pkeypeer._tcp` for `m=v` with the product tag
//    of the current or the previous epoch, judged by the mode-a address rule (lanJudge.ts);
//  - at most 4 approvers are dialled at once, picked at random and never in arrival order, each
//    with a one-time X25519 key that is wiped when the handshake ends; a session that ends before
//    the choice is replaced while the request lives (a bounded number of times per advert);
//  - every session stops after `HELLO` (`holdSas`); the list has at most 8 entries, shows the
//    reported label and platform only, and is never chosen from for the person;
//  - the code on D's screen is D's confirmation, then `VOUCH_REQ` goes out;
//  - `0x0030` to `0x003F` are held, 16 records and 16 KiB, until the person confirms the signed-in
//    account (`confirmAccount`, rule 12); a decline or a close drops them all;
//  - the browse and the wait for `VOUCH_RESULT` end at `expiresIn` (300 s), then every session
//    closes `peer_bye`; the request handle, `sig`, `h` and the nonces are in no message.

import {
  RECORD,
  advertEpoch,
  buildVouchRequest,
  parseTxt,
  parseVouchResult,
  productTag,
  sasDisplay,
  type PeerHello,
  type SessionEvent,
  type VouchFlow,
  type VouchStatus,
} from "@polaris-key/client-core/peer";
import type { DeviceKeyPort } from "@polaris-key/client-core";
import { printAs } from "../core/redact.js";
import { defaultTimer } from "./channel.js";
import { dialRaceTo } from "./dial.js";
import { textVerdict } from "./lanGate.js";
import {
  MulticastDnsAdapter,
  type MdnsAdapter,
  type MdnsFound,
  type MdnsHandle,
} from "./mdns.js";
import {
  LanError,
  SocketLink,
  nearbyHello,
  type SessionClosed,
} from "./session.js";

/** What the requester reads of the client. */
export interface RequesterSource {
  slug: string;
  /** Seconds since the epoch. */
  now(): number;
  /** D's device keys (made when none exist) and its `X-PKey-Device` value. */
  signer(): Promise<{ port: DeviceKeyPort; deviceId: string }>;
}

export interface NearbyRequestOptions {
  /** The handle from `nearby/start` (`nr_…`). */
  request: string;
  /** This device's label in `HELLO` and `VOUCH_REQ` (display data; optional). */
  label?: string;
  /** Aborting closes the request. */
  signal?: AbortSignal;
  /** Seconds the request lives (default 300, from `nearby/start`'s `expiresIn`). */
  expiresIn?: number;
  mdns?: MdnsAdapter;
  allowLoopback?: boolean;
  handshakeMs?: number;
  timer?: (fn: () => void, ms: number) => () => void;
  random?: (n: number) => Uint8Array;
}

/** One approver in the list. Unauthenticated display data: any device on the LAN can be listed. */
export interface NearbyApproverInfo {
  id: string;
  label: string | null;
  platform: string;
}

export interface NearbyRecord {
  /** A Sync record type, `0x0030` to `0x003F`. */
  type: number;
  body: Uint8Array;
}

export type NearbyCloseCode = SessionClosed["code"] | "expired";

export interface NearbyRequest {
  /** The approvers that said `HELLO`, at most 8. */
  readonly approvers: readonly NearbyApproverInfo[];
  /** What `VOUCH_RESULT` said. For display only: the host's poll is the authority. */
  readonly result: VouchStatus | null;
  readonly closed: boolean;
  onApprovers(fn: (list: readonly NearbyApproverInfo[]) => void): () => void;
  onResult(fn: (status: VouchStatus) => void): () => void;
  /** Sync records, once the person confirmed the account. */
  onRecord(fn: (r: NearbyRecord) => void): () => void;
  /** The chosen session ended (or the request expired); with why. */
  onClose(fn: (code: NearbyCloseCode) => void): () => void;
  /**
   * The person tapped this approver. Starts the code on that session only and closes the others
   * `peer_bye`; answers D's code to show, and sends `VOUCH_REQ` once it is shown.
   */
  choose(id: string): Promise<{ code: string }>;
  /** The person confirmed that the signed-in account is theirs: held records go to `onRecord`. */
  confirmAccount(): Promise<void>;
  /** The person declined, or the screen timed out: every held record is dropped and the session closes. */
  declineAccount(): Promise<void>;
  /** End the request: the browse stops and every session closes `peer_bye`. */
  close(): Promise<void>;
}

const MAX_DIALS = 4;
const MAX_LIST = 8;
const EXPIRES_S = 300;
const TRIES_PER_ADVERT = 3;
const REDIAL_MS = 250;

const systemRandom = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

interface Candidate {
  instance: string;
  hosts: string[];
  port: number;
  tries: number;
}

interface Entry {
  id: string;
  instance: string;
  link: SocketLink;
  key: Uint8Array;
  hello: PeerHello | null;
  code: number | null;
  codeWait: {
    resolve(n: number): void;
    reject(e: LanError): void;
  } | null;
  closed: boolean;
}

export class NearbyRequester implements NearbyRequest {
  readonly #src: RequesterSource;
  readonly #o: NearbyRequestOptions;
  readonly #mdns: MdnsAdapter;
  readonly #random: (n: number) => Uint8Array;
  readonly #timer: (fn: () => void, ms: number) => () => void;
  readonly #candidates = new Map<string, Candidate>();
  readonly #entries = new Map<string, Entry>();
  /** Instances with a dial or a session in flight. */
  readonly #active = new Set<string>();
  #browse: MdnsHandle | null = null;
  #chosen: Entry | null = null;
  #flow: VouchFlow | null = null;
  #result: VouchStatus | null = null;
  #ended = false;
  #cancels: (() => void)[] = [];
  readonly #onApprovers = new Set<
    (list: readonly NearbyApproverInfo[]) => void
  >();
  readonly #onResult = new Set<(s: VouchStatus) => void>();
  readonly #onRecord = new Set<(r: NearbyRecord) => void>();
  readonly #onClose = new Set<(c: NearbyCloseCode) => void>();

  private constructor(src: RequesterSource, o: NearbyRequestOptions) {
    this.#src = src;
    this.#o = o;
    this.#random = o.random ?? systemRandom;
    this.#timer = o.timer ?? defaultTimer;
    this.#mdns =
      o.mdns ?? new MulticastDnsAdapter({ allowLoopback: o.allowLoopback });
    printAs(this, () => ({ service: "NearbyRequest" }));
  }

  /** Start browsing and dialling. The caller holds the request from `nearby/start`. */
  static async start(
    src: RequesterSource,
    o: NearbyRequestOptions,
  ): Promise<NearbyRequest> {
    const r = new NearbyRequester(src, o);
    const signer = await src.signer();
    r.#signer = signer;
    r.#cancels.push(
      r.#timer(() => void r.#expire(), (o.expiresIn ?? EXPIRES_S) * 1000),
    );
    if (o.signal !== undefined) {
      if (o.signal.aborted) {
        await r.close();
        return r;
      }
      const stop = (): void => void r.close();
      o.signal.addEventListener("abort", stop, { once: true });
      r.#cancels.push(() => o.signal!.removeEventListener("abort", stop));
    }
    try {
      r.#browse = await r.#mdns.browse(
        (f) => void r.#found(f).catch(() => undefined),
        (instance) => r.#gone(instance),
        () => true,
      );
    } catch (e) {
      await r.close();
      throw e;
    }
    return r;
  }

  #signer: { port: DeviceKeyPort; deviceId: string } | null = null;

  get approvers(): readonly NearbyApproverInfo[] {
    // Once the person chose, the list is over.
    if (this.#chosen !== null) return [];
    return [...this.#entries.values()]
      .filter((e) => e.hello !== null && !e.closed)
      .slice(0, MAX_LIST)
      .map((e) => ({
        id: e.id,
        label: e.hello?.label ?? null,
        platform: e.hello?.platform ?? "",
      }));
  }

  get result(): VouchStatus | null {
    return this.#result;
  }

  get closed(): boolean {
    return this.#ended;
  }

  onApprovers(fn: (list: readonly NearbyApproverInfo[]) => void): () => void {
    this.#onApprovers.add(fn);
    return () => this.#onApprovers.delete(fn);
  }
  onResult(fn: (s: VouchStatus) => void): () => void {
    this.#onResult.add(fn);
    return () => this.#onResult.delete(fn);
  }
  onRecord(fn: (r: NearbyRecord) => void): () => void {
    this.#onRecord.add(fn);
    return () => this.#onRecord.delete(fn);
  }
  onClose(fn: (c: NearbyCloseCode) => void): () => void {
    this.#onClose.add(fn);
    return () => this.#onClose.delete(fn);
  }

  // ── Browse and dial ─────────────────────────────────────────────────────────────────────────

  async #found(f: MdnsFound): Promise<void> {
    if (this.#ended || this.#chosen !== null) return;
    const txt = parseTxt(f.txt);
    if (!txt.ok || txt.mode !== "v") return;
    // The product tag of this epoch or the last: an advert of another product is not ours.
    const epoch = advertEpoch(this.#src.now());
    const tags = await Promise.all(
      [epoch, epoch - 1].map((e) => productTag(this.#src.slug, e)),
    );
    if (txt.h === undefined || !tags.includes(txt.h)) return;
    const hosts = f.hosts.filter((h) =>
      textVerdict(h, this.#o.allowLoopback === true),
    );
    if (hosts.length === 0) return;
    const had = this.#candidates.get(f.instance);
    this.#candidates.set(f.instance, {
      instance: f.instance,
      hosts,
      port: f.port,
      tries: had?.tries ?? 0,
    });
    this.#pump();
  }

  #gone(instance: string): void {
    this.#candidates.delete(instance);
  }

  /** Uniform in [0, n) by rejection sampling over 32-bit draws. */
  #below(n: number): number {
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const b = this.#random(4);
      const x = new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
      if (x < limit) return x % n;
    }
  }

  /** Dial candidates at random until 4 are in flight. */
  #pump(): void {
    while (
      !this.#ended &&
      this.#chosen === null &&
      this.#active.size < MAX_DIALS
    ) {
      const free = [...this.#candidates.values()].filter(
        (c) => !this.#active.has(c.instance) && c.tries < TRIES_PER_ADVERT,
      );
      if (free.length === 0) return;
      const c = free[this.#below(free.length)]!;
      c.tries++;
      this.#active.add(c.instance);
      void this.#dial(c);
    }
  }

  async #dial(c: Candidate): Promise<void> {
    let socket;
    try {
      ({ socket } = await dialRaceTo(c.hosts, c.port, {
        allowLoopback: this.#o.allowLoopback === true,
      }));
    } catch {
      this.#active.delete(c.instance);
      this.#later();
      return;
    }
    if (this.#ended || this.#chosen !== null) {
      socket.destroy();
      this.#active.delete(c.instance);
      return;
    }
    const key = this.#random(32);
    const id = `ap_${Buffer.from(this.#random(6)).toString("hex")}`;
    const ref: { e: Entry | null } = { e: null };
    const link: SocketLink = new SocketLink({
      socket,
      handshakeMs: this.#o.handshakeMs,
      channel: {
        mode: "v",
        role: "initiator",
        slug: this.#src.slug,
        staticKey: key,
        holdSas: true,
        hello: nearbyHello(this.#src.slug, this.#o.label),
        timer: this.#timer,
      },
      onEvent: (e) => {
        if (ref.e !== null) this.#event(ref.e, e);
      },
      onClosed: (cl) => {
        if (ref.e !== null) this.#ended_(ref.e, cl);
      },
    });
    const e: Entry = {
      id,
      instance: c.instance,
      link,
      key,
      hello: null,
      code: null,
      codeWait: null,
      closed: false,
    };
    ref.e = e;
    this.#entries.set(id, e);
    await link.channel.start().catch(() => undefined);
  }

  /** A short pause before a replacement dial, so a refusing approver is not hammered. */
  #later(): void {
    this.#cancels.push(this.#timer(() => this.#pump(), REDIAL_MS));
  }

  #list(): void {
    const list = this.approvers;
    for (const f of [...this.#onApprovers]) f(list);
  }

  // ── A session's events ──────────────────────────────────────────────────────────────────────

  #event(e: Entry, ev: SessionEvent): void {
    switch (ev.type) {
      case "established":
        // The one-time static key has done its work.
        e.key.fill(0);
        e.hello = ev.hello;
        this.#list();
        break;
      case "sas":
        e.code = ev.code;
        e.codeWait?.resolve(ev.code);
        e.codeWait = null;
        break;
      case "record":
        if (e === this.#chosen) this.#record(ev.recordType, ev.body);
        break;
      default:
        break;
    }
  }

  #record(type: number, body: Uint8Array): void {
    const flow = this.#flow;
    if (flow === null) return;
    const v = flow.receive({ type, body });
    if (!v.ok) {
      void this.#chosen?.link.channel.close(v.close);
      return;
    }
    for (const r of v.deliver) this.#deliver(r);
  }

  #deliver(r: { type: number; body: Uint8Array }): void {
    if (r.type === RECORD.VOUCH_RESULT) {
      // Display only: an unknown status reads as `denied` (rule 6).
      const got = parseVouchResult(r.body);
      if ("refuse" in got) return;
      this.#result = got.status;
      for (const f of [...this.#onResult]) f(got.status);
    } else if (r.type >= 0x0030 && r.type <= 0x003f) {
      for (const f of [...this.#onRecord]) f({ type: r.type, body: r.body });
    }
  }

  #ended_(e: Entry, c: SessionClosed): void {
    if (e.closed) return;
    e.closed = true;
    e.key.fill(0);
    this.#entries.delete(e.id);
    this.#active.delete(e.instance);
    e.codeWait?.reject(new LanError("closed", "The session is closed."));
    e.codeWait = null;
    if (e === this.#chosen) {
      // The chosen session is over. Without an answer the request goes on: the person may choose
      // again from a fresh list.
      this.#chosen = null;
      this.#flow = null;
      if (!this.#ended) {
        for (const f of [...this.#onClose]) f(c.code);
        if (this.#result === null) this.#later();
      }
    } else {
      this.#list();
      if (!this.#ended) this.#later();
    }
  }

  // ── The person's choices ────────────────────────────────────────────────────────────────────

  async choose(id: string): Promise<{ code: string }> {
    if (this.#ended) throw new LanError("closed", "The request is closed.");
    if (this.#chosen !== null)
      throw new LanError("not_started", "An approver is already chosen.");
    const e = this.#entries.get(id);
    if (e === undefined || e.hello === null || e.closed)
      throw new LanError(
        "unknown_peer",
        "That approver is no longer on the list.",
      );
    const signer = this.#signer;
    if (signer === null) throw new LanError("not_started", "Not started.");
    this.#chosen = e;
    const flow = e.link.channel.vouch;
    if (flow === null) throw new LanError("closed", "The session is closed.");
    this.#flow = flow;
    // The others close before any code record is sent on them: no other approver ever prompts.
    for (const o of [...this.#entries.values()])
      if (o !== e) void o.link.channel.close("peer_bye").catch(() => undefined);
    this.#list();
    const wait =
      e.code !== null
        ? Promise.resolve(e.code)
        : new Promise<number>((resolve, reject) => {
            e.codeWait = { resolve, reject };
          });
    await e.link.channel.startSas();
    const code = await wait;
    // Showing the code is D's confirmation; then the request goes to the chosen approver.
    flow.codeShown();
    await e.link.channel.confirmSas();
    const body = await buildVouchRequest({
      port: signer.port,
      slug: this.#src.slug,
      h: e.link.channel.handshakeHash(),
      request: this.#o.request,
      deviceId: signer.deviceId,
      hello: {
        ...(this.#o.label !== undefined ? { label: this.#o.label } : {}),
        platform: process.platform,
      },
    });
    const v = flow.send({ type: RECORD.VOUCH_REQ, body });
    if (!v.ok) {
      await e.link.channel.close(v.close);
      throw new LanError("closed", "The session is closed.");
    }
    await e.link.channel.sendRecord(RECORD.VOUCH_REQ, body).catch(() => {
      throw new LanError("closed", "The session is closed.");
    });
    return { code: sasDisplay(code) };
  }

  async confirmAccount(): Promise<void> {
    const flow = this.#flow;
    if (flow === null) throw new LanError("not_started", "Nobody is chosen.");
    const v = flow.confirmAccount();
    if (!v.ok) {
      await this.#chosen?.link.channel.close(v.close);
      return;
    }
    for (const r of v.deliver) this.#deliver(r);
  }

  async declineAccount(): Promise<void> {
    const flow = this.#flow;
    if (flow === null) return;
    const v = flow.declineAccount();
    await this.#chosen?.link.channel.close(v.ok ? "peer_bye" : v.close);
  }

  // ── The end ─────────────────────────────────────────────────────────────────────────────────

  async #expire(): Promise<void> {
    await this.#stop("expired");
  }

  close(): Promise<void> {
    return this.#stop(null);
  }

  async #stop(why: "expired" | null): Promise<void> {
    if (this.#ended) return;
    const chosen = this.#chosen !== null;
    this.#ended = true;
    for (const c of this.#cancels.splice(0)) c();
    if (why !== null || chosen)
      for (const f of [...this.#onClose]) f(why ?? "peer_bye");
    const browse = this.#browse;
    this.#browse = null;
    await browse?.stop().catch(() => undefined);
    await Promise.all(
      [...this.#entries.values()].map((e) =>
        e.link.channel.close("peer_bye").catch(() => undefined),
      ),
    );
  }
}
