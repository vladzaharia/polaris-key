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
//    on disk, inert. Managing links (`list`, `rename`, `remove`, `setReachable`) is never gated;
//  - the joiner's dials are counted per typed nameplate across joins, in memory.

import {
  DialBudget,
  MAX_LOCAL_LINKS,
  cleanLabel,
} from "@polaris-key/client-core/peer";
import { printAs } from "../core/redact.js";
import {
  checkOptions,
  full,
  off,
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
import { base64UrlDecode } from "@polaris-key/jws";

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

/** Forget every dial budget. For tests. @internal */
export const resetLocalBudgets = (): void => BUDGETS.clear();

export class LocalLinks {
  readonly #src: LocalSource;
  readonly #budget: DialBudget;
  #lan: LanService | null = null;
  #unsub: (() => void)[] = [];
  readonly #sessions = new Set<ConnectSession>();
  readonly #onLink = new Set<(s: ConnectSession) => void>();
  #shower: Shower | null = null;
  /** The window that is being opened: the slot is taken before the first await. */
  #starting: Promise<Shower> | null = null;
  /** Bumped by `closeAll`: a window that began opening before it must not outlive it. */
  #epoch = 0;
  readonly #joins = new Set<{ cancel(): void }>();

  constructor(
    src: LocalSource,
    private readonly hooks: {
      /** A session the links opened or accepted (Direct Transfer takes it). */
      adopt?: (s: ConnectSession) => void;
      /** Links were forgotten: their peers' link keys (32 raw bytes each). */
      removed?: (peerKeys: Uint8Array[]) => Promise<void>;
    } = {},
  ) {
    this.#src = src;
    this.#budget = budgetOf(src.slug);
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

  /** The local links this device holds. Listing is not gated. */
  async list(): Promise<LocalLinkInfo[]> {
    return infoOfLocal(await this.#src.store.rows());
  }

  /**
   * Show a code and a QR and wait for the other device (the responder). Throws the typed N/A
   * `local-pairing-off` while the gate is off, `local-links-full` at the cap, and `LanError`
   * `bad_input` for options that break a rule or when this product already has a window open. The
   * handle closes the window (`stop()`); it also closes by itself after `seconds` (at most 300),
   * after the fifth failed guess and once a link is made.
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
    if (this.#shower?.open === true || this.#starting !== null)
      throw new LanError("bad_input", "A pairing window is already open.");
    const epoch = this.#epoch;
    const start = (async (): Promise<Shower> => {
      if ((await this.#src.store.count()) >= MAX_LOCAL_LINKS) throw full();
      let mine: Shower | undefined;
      mine = await Shower.start(this.#src, o, () => {
        if (this.#shower === mine) this.#shower = null;
      });
      this.#shower = mine;
      // The gate was cleared while the window was opening: it closes before anyone sees a code.
      if (epoch !== this.#epoch || !this.#src.allowed()) {
        await mine.stop().catch(() => undefined);
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
   * confirmed and both devices stored it. Rejects with `pairing-code-failed` (the code did not
   * parse, the QR was not this app's, the dial budget for this code is spent, or an attempt failed
   * after the other device answered), `pairing-not-found` (no matching advert in 15 s, or every
   * attempt ended before an answer) and `peer-closed` (the session ended first); the typed N/A
   * `local-pairing-off` and `local-links-full` are thrown before anything is browsed.
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
    // Registered before the first await, so a gate-clearing read can cancel it.
    let cancelled = false;
    let j: Joiner | null = null;
    const handle = {
      cancel: () => {
        cancelled = true;
        j?.cancel();
      },
    };
    this.#joins.add(handle);
    try {
      if ((await this.#src.store.count()) >= MAX_LOCAL_LINKS) throw full();
      if (cancelled || !this.#src.allowed())
        throw off("Pairing with a code was turned off (join).");
      j = new Joiner(this.#src, this.#budget, o);
      return await j.run();
    } finally {
      this.#joins.delete(handle);
    }
  }

  /**
   * Change a link's label on this device only; it is never sent. False when `id` names no link.
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
   * link. The adverts run while `cloudConnect.start()` does and the gate is on.
   */
  setReachable(id: string, reachable: boolean): Promise<boolean> {
    if (typeof reachable !== "boolean")
      throw new LanError("bad_input", "reachable must be a boolean.");
    return this.#change(id, (r) => ({ ...r, reachable }));
  }

  async #change(
    id: string,
    f: (r: LocalLinkRow) => LocalLinkRow,
  ): Promise<boolean> {
    let found = false;
    await this.#src.store.update((rows) => {
      found = rows.some((r) => r.id === id);
      return found ? rows.map((r) => (r.id === id ? f(r) : r)) : null;
    });
    if (found) this.#src.notify();
    return found;
  }

  /**
   * Forget a link: its keys and secret leave the record before this resolves, an open session under
   * it is closed `peer_revoked`, a handshake in progress under it is closed before the host sees
   * it, and the partial files kept for its peer are deleted. False when `id` names no link.
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
  async open(id: string): Promise<ConnectSession> {
    this.#requireOn("open");
    const lan = this.#lan;
    if (lan === null)
      throw new LanError("not_started", "Cloud Connect is not started.");
    if (!(await this.#src.store.rows()).some((r) => r.id === id))
      throw new LanError(
        "unknown_peer",
        "That is not a local link on this device.",
      );
    let s: ConnectSession;
    try {
      s = await lan.connectLocal(id);
    } catch (e) {
      // The gate was cleared while the dial ran.
      if (!this.#src.allowed())
        throw off("Pairing with a code was turned off (open).");
      throw e;
    }
    this.hooks.adopt?.(s);
    this.#sessions.add(s);
    s.onClose(() => this.#sessions.delete(s));
    if (await this.#stillHeld(s)) return s;
    throw new LanError("unknown_peer", "That link was removed.");
  }

  /** Whether a link is held, and found on the network now. @internal */
  async has(id: string): Promise<boolean> {
    return (await this.#src.store.rows()).some((r) => r.id === id);
  }

  // ── Wiring (CloudConnect.start and stop) ────────────────────────────────────────────────────

  /** @internal The LAN service the sessions come from. */
  attach(lan: LanService): void {
    void this.detach();
    this.#lan = lan;
    this.#unsub.push(lan.onLocalSession((s) => this.#inbound(s)));
  }

  /** @internal Ends the sessions; the transport is CloudConnect's. */
  async detach(): Promise<void> {
    for (const u of this.#unsub.splice(0)) u();
    this.#lan = null;
    await Promise.all(
      [...this.#sessions].map((s) =>
        s.close("peer_bye").catch(() => undefined),
      ),
    );
    this.#sessions.clear();
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
    await this.#shower?.stop().catch(() => undefined);
    // A window still opening is stopped by its own start, which sees the new epoch.
    await this.#starting?.catch(() => undefined);
    await Promise.all(
      [...this.#sessions].map((s) =>
        s.close("peer_bye").catch(() => undefined),
      ),
    );
  }
}
