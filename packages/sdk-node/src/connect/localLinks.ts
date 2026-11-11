// Pairing with a code, with no account, `client.cloudConnect.localLinks` (CC-29.7; WIRE-CONTRACT-V5
// §15.12): two devices of one app on one LAN pair by an 8-digit code or a QR. One device shows
// (`pair`, the responder: `localShower.ts`), the other types or scans (`join`, the initiator:
// `localJoiner.ts`). CPace turns the code into a key, mode `q` runs Noise over it, both people
// confirm, and each side stores a link in `pkey.connect.local.v1` (`localState.ts`).
//
// Nothing here needs a signed-in device: no identity, no K_disc, no certificate. Pairing needs no
// `start()` either; the later sessions (CC-29.8, mode `l`) ride the LAN service `cloudConnect.start()`
// runs, which with no account serves local links alone (§15.5, §15.12 "Mode l"):
//
//   list()             the links this device holds
//   rename(id, label)  change the label on this device only; it is never sent
//   remove(id)         forget a link: its keys and secret go, open sessions hear `peer_revoked`
//   setReachable(id,b) advertise the link's `m=l` name on the LAN (at most 8), or stop
//   open(id)           a session to the peer, found by its advert on the LAN (no relay)
//   onLink(fn)         called with each session a local link opened to this device
//
// Rules this module keeps:
//  - `pair`, `join` and every accept and dial need the cached discovery answer `localPairing: true`
//    (§15.12 "Gates"); without it they throw the typed N/A `local-pairing-off`, and a read that
//    clears it closes the window and every join;
//  - one window per device and product, and a device that holds `MAX_LOCAL_LINKS` answers
//    `local-links-full` before anything is advertised or dialled;
//  - `open`, the `m=l` adverts and the mode-`l` answer need the same cached answer; a read that
//    clears it withdraws the adverts and ends the open sessions with `peer_bye`, and the links stay
//    on disk, inert. Managing links (`list`, `rename`, `remove`, `setReachable`, `onChange`) is
//    never gated, with the gate off and with no cached document;
//  - the joiner's dials are counted per typed nameplate across joins, in memory, and so are the
//    nameplates the shower's windows closed with in the last 300 s (a renewed window skips them).

import {
  DialBudget,
  MAX_LIVE_LOCAL_ADVERTS,
  MAX_LOCAL_LINKS,
  NameplateMemory,
  cleanLabel,
  dialsLeft,
} from "@polaris-key/client-core/peer";
import { printAs } from "../core/redact.js";
import {
  LocalPairingError,
  cancelled,
  checkOptions,
  full,
  off,
  reachableFull,
  type LocalCode,
  type LocalJoinOptions,
  type LocalPairHandle,
  type LocalPairOptions,
  type LocalPaired,
  type LocalSource,
} from "./localCommon.js";
import { Joiner } from "./localJoiner.js";
import { Shower } from "./localShower.js";
import type { LanService } from "./lan.js";
import {
  infoOfLocal,
  localTag,
  type LocalLinkInfo,
  type LocalLinkRow,
} from "./localState.js";
import { ConnectSession, LanError } from "./session.js";

/** A dial to one link is not repeated sooner than this (seconds): a base, with jitter, doubled after each failure up to the cap. */
const DIAL_COOLDOWN_S = 3;
const DIAL_COOLDOWN_JITTER_S = 2;
const DIAL_BACKOFF_CAP_S = 60;
import { base64UrlDecode } from "@polaris-key/jws";

export { LocalPairingError } from "./localCommon.js";
export type {
  LocalCode,
  LocalJoinOptions,
  LocalOffer,
  LocalOptions,
  LocalPairFailure,
  LocalPairHandle,
  LocalPairOptions,
  LocalPaired,
  LocalSource,
} from "./localCommon.js";

/**
 * The joiner's dial budgets, one per product for the whole process: an app that makes a new client
 * per screen or per retry meets the same budget, so retries cannot multiply a fake advert's guesses.
 * In memory only (a restart resets it, as §15.12 allows).
 */
const BUDGETS = new Map<string, DialBudget>();
const budgetOf = (slug: string): DialBudget => {
  let b = BUDGETS.get(slug);
  if (b === undefined) BUDGETS.set(slug, (b = new DialBudget()));
  return b;
};

/**
 * The nameplates the shower's windows of a product closed with, one memory per product for the whole
 * process, like the dial budgets: a window that closes and the next one that opens, even through a
 * new client, never share a nameplate within 300 s.
 */
const NAMEPLATES = new Map<string, NameplateMemory>();
const memoryOf = (slug: string): NameplateMemory => {
  let m = NAMEPLATES.get(slug);
  if (m === undefined) NAMEPLATES.set(slug, (m = new NameplateMemory()));
  return m;
};

/** Forget every dial budget and every remembered nameplate. For tests. @internal */
export const resetLocalBudgets = (): void => {
  BUDGETS.clear();
  NAMEPLATES.clear();
};

/**
 * What `pair` returns: it follows the window that is current, so `renew()` can replace it. It
 * holds no secret of its own.
 */
class PairHandle implements LocalPairHandle {
  #cur: Shower;
  #renewing: Promise<LocalCode> | null = null;

  constructor(
    first: Shower,
    private readonly again: (cur: Shower) => Promise<Shower>,
  ) {
    this.#cur = first;
    printAs(this, () => ({ service: "LocalPairing", open: this.open }));
  }

  get open(): boolean {
    return this.#cur.open;
  }

  code(): LocalCode | null {
    return this.#cur.code();
  }

  stop(): Promise<void> {
    return this.#cur.stop();
  }

  /** Two calls at once share one new window. */
  renew(): Promise<LocalCode> {
    this.#renewing ??= (async () => {
      try {
        const next = await this.again(this.#cur);
        this.#cur = next;
        const c = next.code();
        if (c === null) throw new LanError("closed", "The window closed.");
        return c;
      } finally {
        this.#renewing = null;
      }
    })();
    return this.#renewing;
  }
}

export class LocalLinks {
  readonly #src: LocalSource;
  readonly #budget: DialBudget;
  readonly #memory: NameplateMemory;
  #lan: LanService | null = null;
  #unsub: (() => void)[] = [];
  readonly #sessions = new Set<ConnectSession>();
  readonly #onLink = new Set<(s: ConnectSession) => void>();
  #shower: Shower | null = null;
  /** The window that is being opened: the slot is taken before the first await. */
  #starting: Promise<Shower> | null = null;
  /** Bumped by `closeAll`: a window that began opening before it must not outlive it. */
  #epoch = 0;
  readonly #joins = new Set<{ cancel(why?: "cancelled" | "closed"): void }>();
  /** One dial per link at a time: a second `open` for the same link joins it. */
  readonly #dials = new Map<string, Promise<ConnectSession>>();
  /** Per link: no dial before `until` (monotonic seconds), and the failures in a row. */
  readonly #cool = new Map<string, { until: number; fails: number }>();

  constructor(
    src: LocalSource,
    private readonly hooks: {
      /** A session the links opened or accepted (Direct Transfer takes it). */
      adopt?: (s: ConnectSession) => void;
      /** Links were forgotten: their peers' link keys (32 raw bytes each). */
      removed?: (peerKeys: Uint8Array[]) => Promise<void>;
      /** Monotonic seconds, for the dial cooldown. Default `performance.now() / 1000`. */
      mono?: () => number;
      /** A number in [0, 1) for the cooldown's jitter. Default `Math.random`. */
      random?: () => number;
    } = {},
  ) {
    this.#src = src;
    this.#budget = budgetOf(src.slug);
    this.#memory = memoryOf(src.slug);
    // The gate moved or a link was forgotten: sessions that no longer have a footing end.
    this.#src.onChange(() => void this.#reconcile().catch(() => undefined));
    printAs(this, () => ({ links: "LocalLinks" }));
  }

  /** The cached discovery answer `services.connect.localPairing` (§15.9, §15.12). False before discovery. */
  localPairing(): boolean {
    return this.#src.allowed();
  }

  #requireOn(what: string): void {
    if (!this.#src.allowed())
      throw off(`Pairing with a code is off for this product (${what}).`);
  }

  /**
   * Called after the links or the gate changed: a pairing was stored, a link was renamed, forgotten,
   * re-marked or seen, or the `localPairing` answer flipped. It carries no data: read `list()` and
   * `localPairing()` again. Returns the unsubscribe. Never gated.
   */
  onChange(fn: () => void): () => void {
    return this.#src.onView(fn);
  }

  /**
   * How many dials a join of the code typed so far may still make: 2, 1 or 0, from the first two
   * digits alone; null until the text (spaces and hyphens ignored) starts with two digits. It reads
   * those two digits, keeps nothing and spends nothing.
   */
  dialsLeft(text: string): number | null {
    if (typeof text !== "string") return null;
    const mono = this.hooks.mono ?? ((): number => performance.now() / 1000);
    return dialsLeft(this.#budget, text, mono());
  }

  /** The local links this device holds. Listing is not gated. */
  async list(): Promise<LocalLinkInfo[]> {
    return infoOfLocal(await this.#src.store.rows());
  }

  /**
   * Show a code and a QR and wait for the other device (the responder). Throws the typed N/A
   * `local-pairing-off` while the gate is off, `local-links-full` (`cap: "stored"`) at the cap, and
   * `LanError` `bad_input` for options that break a rule or when this product already has a window
   * open. The handle closes the window (`stop()`) and makes the next one (`renew()`); the window
   * also closes by itself after `seconds` (at most 300), after the fifth failed guess, once a link
   * is made and when the gate goes off, and `onEnd` says which.
   */
  async pair(o: LocalPairOptions): Promise<LocalPairHandle> {
    this.#requireOn("pair");
    checkOptions(o);
    if (typeof o.onCode !== "function")
      throw new LanError("bad_input", "onCode is required.");
    if (
      o.seconds !== undefined &&
      (typeof o.seconds !== "number" || !(o.seconds > 0))
    )
      throw new LanError("bad_input", "seconds must be above 0.");
    const first = await this.#window(o, null);
    return new PairHandle(first, (cur) => this.#window(o, cur));
  }

  /**
   * Open a window; `replacing` is the one a renewal closes first (it makes no `onEnd`). The slot is
   * taken before the first await and kept across the replacement.
   */
  async #window(
    o: LocalPairOptions,
    replacing: Shower | null,
  ): Promise<Shower> {
    this.#requireOn("pair");
    if (
      this.#starting !== null ||
      (this.#shower?.open === true && this.#shower !== replacing)
    )
      throw new LanError("bad_input", "A pairing window is already open.");
    const epoch = this.#epoch;
    const start = (async (): Promise<Shower> => {
      if ((await this.#src.store.count()) >= MAX_LOCAL_LINKS) throw full();
      await replacing?.close(null).catch(() => undefined);
      let mine: Shower | undefined;
      mine = await Shower.start(this.#src, o, this.#memory, () => {
        if (this.#shower === mine) this.#shower = null;
      });
      this.#shower = mine;
      // The gate was cleared while the window was opening: it closes before anyone sees a code.
      if (epoch !== this.#epoch || !this.#src.allowed()) {
        await mine.close("off").catch(() => undefined);
        throw off("Pairing with a code was turned off (pair).");
      }
      return mine;
    })();
    this.#starting = start;
    try {
      return await start;
    } finally {
      if (this.#starting === start) this.#starting = null;
    }
  }

  /**
   * Type or scan the other device's code (the initiator). Resolves with the link when both people
   * confirmed and both devices stored it. Rejects with a `LocalPairingError`:
   *  - `pairing-code-failed`, reason `invalid` (the code did not parse), `other-app` (the QR was not
   *    this app's), `spent` (the dials for this code are spent) or `wrong` (an attempt failed after
   *    the other device answered);
   *  - `pairing-not-found` (no matching advert in 15 s, or every attempt ended before an answer);
   *  - `peer-closed`, reason `declined` (the other device said no), `timeout`, `closed` or
   *    `cancelled` (the `signal` aborted).
   * The typed N/A `local-pairing-off` and `local-links-full` (`cap: "stored"`) are thrown before
   * anything is browsed. A cancel refunds no dial.
   */
  async join(o: LocalJoinOptions): Promise<LocalPaired> {
    this.#requireOn("join");
    checkOptions(o);
    if ((o.code === undefined) === (o.qr === undefined))
      throw new LanError("bad_input", "Give exactly one of code and qr.");
    if (
      o.browseSeconds !== undefined &&
      (typeof o.browseSeconds !== "number" || !(o.browseSeconds > 0))
    )
      throw new LanError("bad_input", "browseSeconds must be above 0.");
    if (o.signal !== undefined && !(o.signal instanceof globalThis.AbortSignal))
      throw new LanError("bad_input", "signal must be an AbortSignal.");
    if (o.signal?.aborted === true) throw cancelled();
    // Registered before the first await, so a gate-clearing read or an abort can cancel it.
    let stopped: "cancelled" | "closed" | null = null;
    let j: Joiner | null = null;
    const handle = {
      cancel: (why: "cancelled" | "closed" = "closed") => {
        stopped ??= why;
        j?.cancel(why);
      },
    };
    const onAbort = (): void => handle.cancel("cancelled");
    this.#joins.add(handle);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if ((await this.#src.store.count()) >= MAX_LOCAL_LINKS) throw full();
      if (stopped === "cancelled") throw cancelled();
      if (stopped !== null || !this.#src.allowed())
        throw off("Pairing with a code was turned off (join).");
      j = new Joiner(this.#src, this.#budget, o);
      return await j.run();
    } finally {
      o.signal?.removeEventListener("abort", onAbort);
      this.#joins.delete(handle);
    }
  }

  /**
   * Change a link's label on this device only; it is never sent. False when `id` names no link.
   * Never gated.
   * Throws `LanError` `bad_input` for a label that is empty once cleaned or longer than 64.
   */
  async rename(id: string, label: string): Promise<boolean> {
    const clean = typeof label === "string" ? cleanLabel(label) : null;
    if (clean === null || clean.length > 64)
      throw new LanError("bad_input", "The label is not valid.");
    return this.#change(id, (r) => ({ ...r, label: clean }));
  }

  /**
   * Advertise a link's `m=l` name on the LAN (at most 8 at once), or stop. False when `id` names no
   * link. A new link is reachable already; turning a ninth on throws `local-links-full` with
   * `cap: "reachable"`. The adverts run while `cloudConnect.start()` does and the gate is on;
   * the choice itself is kept either way (never gated).
   */
  async setReachable(id: string, reachable: boolean): Promise<boolean> {
    if (typeof reachable !== "boolean")
      throw new LanError("bad_input", "reachable must be a boolean.");
    let refused = false;
    const found = await this.#change(id, (r, rows) => {
      // At most `MAX_LIVE_LOCAL_ADVERTS` links are advertised: a ninth is refused, not left
      // silently unadvertised (§15.12, "Reachable by default").
      if (
        reachable &&
        !r.reachable &&
        rows.filter((x) => x.reachable).length >= MAX_LIVE_LOCAL_ADVERTS
      ) {
        refused = true;
        return r;
      }
      return { ...r, reachable };
    });
    if (refused) throw reachableFull();
    return found;
  }

  async #change(
    id: string,
    f: (r: LocalLinkRow, rows: LocalLinkRow[]) => LocalLinkRow,
  ): Promise<boolean> {
    let found = false;
    await this.#src.store.update((rows) => {
      found = rows.some((r) => r.id === id);
      return found ? rows.map((r) => (r.id === id ? f(r, rows) : r)) : null;
    });
    if (found) this.#src.notify();
    return found;
  }

  /**
   * Forget a link: its keys and secret leave the record before this resolves, an open session under
   * it is closed `peer_revoked`, a handshake in progress under it is closed before the host sees
   * it, and the partial files kept for its peer are deleted. False when `id` names no link. Never
   * gated: with the gate off a host can still forget a link.
   */
  async remove(id: string): Promise<boolean> {
    const gone: Uint8Array[] = [];
    await this.#src.store.update((rows) => {
      const hit = rows.find((r) => r.id === id);
      if (hit === undefined) return null;
      gone.push(base64UrlDecode(hit.peerKey));
      return rows.filter((r) => r.id !== id);
    });
    if (gone.length === 0) return false;
    // The listener drops the link before this resolves: a dial or a handshake that starts after
    // `await remove()` cannot use it.
    await this.#lan?.forgetLocal(id).catch(() => undefined);
    this.#src.notify();
    await this.#reconcile();
    await this.hooks.removed?.(gone).catch(() => undefined);
    return true;
  }

  /** Called with each session a local link opened to this device. Returns the unsubscribe. */
  onLink(fn: (s: ConnectSession) => void): () => void {
    this.#onLink.add(fn);
    return () => this.#onLink.delete(fn);
  }

  /**
   * A session to the peer of a link, found by its `m=l` advert on the LAN (mode `l`; the relay is
   * never used). Throws the typed N/A `local-pairing-off` while the gate is off, `LanError`
   * `not_started` before `cloudConnect.start()`, `unknown_peer` for an id that is no link or a peer
   * not seen on this network, and `peer_cert_invalid` (`handshake_failed`) when the peer does not
   * answer under the link (it forgot it: "Not reachable").
   */
  open(id: string): Promise<ConnectSession> {
    // One dial per link at a time; a caller that comes while one runs gets the same session.
    const live = this.#dials.get(id);
    if (live !== undefined) return live;
    const run = this.#dial(id);
    this.#dials.set(id, run);
    const done = (): void => {
      if (this.#dials.get(id) === run) this.#dials.delete(id);
    };
    run.then(done, done);
    return run;
  }

  async #dial(id: string): Promise<ConnectSession> {
    this.#requireOn("open");
    const lan = this.#lan;
    if (lan === null)
      throw new LanError("not_started", "Cloud Connect is not started.");
    if (!(await this.#src.store.rows()).some((r) => r.id === id))
      throw new LanError(
        "unknown_peer",
        "That is not a local link on this device.",
      );
    // A dial that failed is not repeated at once, and the wait grows with each failure in a row:
    // a peer that closes on a message 1 (it is busy, or it forgot the link) is not hammered.
    const mono = this.hooks.mono ?? ((): number => performance.now() / 1000);
    const cool = this.#cool.get(id);
    if (cool !== undefined && mono() < cool.until)
      throw new LanError(
        "busy",
        "That device did not answer a moment ago; try again shortly.",
      );
    let s: ConnectSession;
    try {
      s = await lan.connectLocal(id);
    } catch (e) {
      // The gate was cleared while the dial ran.
      if (!this.#src.allowed())
        throw off("Pairing with a code was turned off (open).");
      // Only a dial that reached the network is held off: "not seen yet" is no attempt.
      const reached =
        !(e instanceof LanError) ||
        (e.reason !== "unknown_peer" && e.reason !== "not_started");
      if (!reached) throw e;
      const fails = (cool?.fails ?? 0) + 1;
      const base =
        DIAL_COOLDOWN_S +
        DIAL_COOLDOWN_JITTER_S * (this.hooks.random ?? Math.random)();
      this.#cool.set(id, {
        fails,
        until: mono() + Math.min(DIAL_BACKOFF_CAP_S, base * 2 ** (fails - 1)),
      });
      throw e;
    }
    this.#cool.delete(id);
    // Adopted (Direct Transfer takes it) and tracked only once the link is known to be held.
    if (!(await this.#stillHeld(s))) {
      if (!this.#src.allowed())
        throw off("Pairing with a code was turned off (open).");
      throw new LanError("unknown_peer", "That link was removed.");
    }
    this.hooks.adopt?.(s);
    this.#sessions.add(s);
    s.onClose(() => this.#sessions.delete(s));
    return s;
  }

  /** Whether a link is held, and found on the network now. @internal */
  async has(id: string): Promise<boolean> {
    return (await this.#src.store.rows()).some((r) => r.id === id);
  }

  // ── Wiring (CloudConnect.start and stop) ────────────────────────────────────────────────────

  /** @internal The LAN service the sessions come from. The previous one's sessions are ended first. */
  async attach(lan: LanService): Promise<void> {
    await this.detach();
    this.#lan = lan;
    this.#unsub.push(lan.onLocalSession((s) => this.#inbound(s)));
  }

  /** @internal Ends the sessions; the transport is CloudConnect's. */
  async detach(): Promise<void> {
    for (const u of this.#unsub.splice(0)) u();
    this.#lan = null;
    const mine = [...this.#sessions];
    await Promise.all(
      mine.map((s) => s.close("peer_bye").catch(() => undefined)),
    );
    // Only what this call ended: a session of a newer attach is left alone.
    for (const s of mine) this.#sessions.delete(s);
  }

  #inbound(s: ConnectSession): void {
    // The handshake may have begun before the link was forgotten or the gate went off: the session
    // is delivered only while the link (same secret) is held and the gate is on.
    void this.#stillHeld(s).then((ok) => {
      if (!ok) return;
      this.hooks.adopt?.(s);
      this.#sessions.add(s);
      s.onClose(() => this.#sessions.delete(s));
      for (const f of [...this.#onLink]) f(s);
    });
  }

  /** Close `s` (`peer_revoked`, or `peer_bye` when the gate is off) unless its link is still held. */
  async #stillHeld(s: ConnectSession): Promise<boolean> {
    const ref = s.local;
    if (ref === null) return true;
    const on = this.#src.allowed();
    const held =
      on &&
      (await this.#src.store.rows().catch(() => [])).some(
        (r) =>
          r.id === ref.id && localTag(base64UrlDecode(r.secret)) === ref.tag,
      );
    if (held) return true;
    await s.close(on ? "peer_revoked" : "peer_bye").catch(() => undefined);
    return false;
  }

  /** The gate or the list moved: a closed gate ends every session (`peer_bye`), a forgotten link's ends `peer_revoked`. */
  async #reconcile(): Promise<void> {
    if (this.#sessions.size === 0) return;
    if (!this.#src.allowed()) {
      await Promise.all(
        [...this.#sessions].map((s) =>
          s.close("peer_bye").catch(() => undefined),
        ),
      );
      return;
    }
    const held = new Set(
      (await this.#src.store.rows().catch(() => [])).map(
        (r) => `${r.id}|${localTag(base64UrlDecode(r.secret))}`,
      ),
    );
    await Promise.all(
      [...this.#sessions]
        .filter(
          (s) => s.local !== null && !held.has(`${s.local.id}|${s.local.tag}`),
        )
        .map((s) => s.close("peer_revoked").catch(() => undefined)),
    );
  }

  /**
   * The gate was cleared by a discovery read: close the window and every join, and end every open
   * session with `peer_bye` (§15.12 "Gates"). The adverts are withdrawn by the LAN service, which
   * the client tells at the same time. @internal
   */
  async closeAll(): Promise<void> {
    this.#epoch++;
    for (const j of [...this.#joins]) j.cancel();
    await this.#shower?.close("off").catch(() => undefined);
    // A window still opening is stopped by its own start, which sees the new epoch.
    await this.#starting?.catch(() => undefined);
    await Promise.all(
      [...this.#sessions].map((s) =>
        s.close("peer_bye").catch(() => undefined),
      ),
    );
  }
}
