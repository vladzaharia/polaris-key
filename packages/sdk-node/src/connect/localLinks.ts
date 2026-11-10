// Pairing with a code, with no account, `client.cloudConnect.localLinks` (CC-29.7; WIRE-CONTRACT-V5
// §15.12): two devices of one app on one LAN pair by an 8-digit code or a QR. One device shows
// (`pair`, the responder: `localShower.ts`), the other types or scans (`join`, the initiator:
// `localJoiner.ts`). CPace turns the code into a key, mode `q` runs Noise over it, both people
// confirm, and each side stores a link in `pkey.connect.local.v1` (`localState.ts`).
//
// Nothing here needs a signed-in device: no identity, no K_disc, no certificate, no `start()`.
//
// Rules this module keeps:
//  - `pair`, `join` and every accept and dial need the cached discovery answer `localPairing: true`
//    (§15.12 "Gates"); without it they throw the typed N/A `local-pairing-off`, and a read that
//    clears it closes the window and every join;
//  - one window per device and product, and a device that holds `MAX_LOCAL_LINKS` answers
//    `local-links-full` before anything is advertised or dialled;
//  - the joiner's dials are counted per typed nameplate across joins, in memory.

import { DialBudget, MAX_LOCAL_LINKS } from "@polaris-key/client-core/peer";
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
import { infoOfLocal, type LocalLinkInfo } from "./localState.js";
import { LanError } from "./session.js";

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

export class LocalLinks {
  readonly #src: LocalSource;
  readonly #budget = new DialBudget();
  #shower: Shower | null = null;
  readonly #joins = new Set<{ cancel(): void }>();

  constructor(src: LocalSource) {
    this.#src = src;
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
    if (this.#shower?.open === true)
      throw new LanError("bad_input", "A pairing window is already open.");
    if ((await this.#src.store.count()) >= MAX_LOCAL_LINKS) throw full();
    let mine: Shower | undefined;
    mine = await Shower.start(this.#src, o, () => {
      if (this.#shower === mine) this.#shower = null;
    });
    this.#shower = mine;
    return mine;
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
    if ((await this.#src.store.count()) >= MAX_LOCAL_LINKS) throw full();
    const j = new Joiner(this.#src, this.#budget, o);
    const handle = { cancel: () => j.cancel() };
    this.#joins.add(handle);
    try {
      return await j.run();
    } finally {
      this.#joins.delete(handle);
    }
  }

  /** The gate was cleared by a discovery read: close the window and every join (§15.12 "Gates"). @internal */
  async closeAll(): Promise<void> {
    for (const j of [...this.#joins]) j.cancel();
    await this.#shower?.stop().catch(() => undefined);
  }
}
