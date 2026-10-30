// Inter-account links, `client.cloudConnect.links` (CC-19.5; WIRE-CONTRACT-V5 §15.10): pair two
// devices of two accounts once, in person, and open sessions to the contact later without a new
// pairing, on the LAN first and then through the contact relay.
//
//   pair(opts)         open the pairing window: show each code, `confirm()` or `decline()`, and a
//                      link is stored on both devices. LAN only (mode `p`)
//   list()             the links this device holds
//   remove(id)         delete a link: its secret goes, open sessions with it hear `peer_revoked`,
//                      the other device finds the link "not reachable"
//   setReachable(id,b) advertise a link on the LAN and keep a relay room for it, or stop
//   open(id)           a session to the contact: LAN first, the contact relay after a failed or
//                      timed-out LAN attempt (unless the host turned the relay off)
//   onLink(fn)         called with each session a contact opened to this device
//
// Rules this module keeps:
//  - links are the developer's opt-in in every transport (D-12): `pair`, the adverts and the
//    mode-`c` answer need the cached discovery `interAccount` to be true. Without it `pair` and
//    `open` throw the typed N/A (`UnsupportedError`, code `connect_links_disabled`), nothing is
//    advertised and no mode `c` is answered; when a refresh says false the adverts and rooms are
//    withdrawn and the open contact sessions end with `peer_bye`;
//  - a link is a secret and a key on this device only. `ContactInfo` carries neither; a deleted
//    contact's secret is gone from the record before `remove` resolves;
//  - the order is LAN, then the contact relay, as for the person's own devices (cloudConnect.ts).

import { UnsupportedError } from "@polaris-key/client-core";
import { ErrorCode, Feature } from "../constants.generated.js";
import { printAs } from "../core/redact.js";
import type { ConnectClient } from "./client.js";
import type { ContactRelay } from "./contactRelay.js";
import { contactId, infoOf, type ContactInfo } from "./contacts.js";
import type { LanService } from "./lan.js";
import {
  LinkPairing,
  type LinkPairHandle,
  type LinkPairOptions,
} from "./pairing.js";
import { ConnectSession, LanError } from "./session.js";

export interface LinkOpenOptions {
  /** Do not fall back to the contact relay for this call. */
  relay?: boolean;
  /** How long a LAN attempt may take before the relay is tried (default 4000 ms). */
  lanAttemptMs?: number;
}

const LAN_ATTEMPT_MS = 4000;

export class CloudLinks {
  #lan: LanService | null = null;
  #relay: ContactRelay | null = null;
  #unsub: (() => void)[] = [];
  #sessions = new Set<ConnectSession>();
  #onLink = new Set<(s: ConnectSession) => void>();
  #pairing = new Set<LinkPairHandle>();
  #lanAttemptMs = LAN_ATTEMPT_MS;
  #relayOn = false;
  #follow: (() => void) | null = null;

  constructor(private readonly connect: ConnectClient) {
    printAs(this, () => ({ links: "CloudLinks" }));
  }

  /**
   * The cached discovery answer `services.connect.interAccount`: true only while the product's
   * setting, `launch.connectLinks` and the service are on (§15.9). False before discovery.
   */
  interAccount(): boolean {
    return this.connect.interAccount();
  }

  #requireOn(what: string): void {
    if (!this.connect.interAccount())
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.connectLinks,
          reason: "product",
          detail: `Links between accounts are off for this product (${what}).`,
        },
        ErrorCode.connectLinksDisabled,
      );
  }

  /** The links this device holds. */
  async list(): Promise<ContactInfo[]> {
    return infoOf(await this.connect.contactRows());
  }

  /**
   * Delete a link (and a re-pair waiting on it). Its secret is dropped from the record, and an open
   * session with that contact is closed with `peer_revoked`. False when `id` names no link.
   */
  async remove(id: string): Promise<boolean> {
    let found = false;
    await this.connect.updateContacts((rows) => {
      const next = rows.filter((r) => contactId(r.agreeKey) !== id);
      found = next.length !== rows.length;
      return found ? next : null;
    });
    if (found) await this.#reconcile();
    return found;
  }

  /** Advertise a link on the LAN and keep a relay room for it (at most 8 at once), or stop. False when `id` names no link. */
  async setReachable(id: string, reachable: boolean): Promise<boolean> {
    let found = false;
    await this.connect.updateContacts((rows) => {
      found = rows.some((r) => contactId(r.agreeKey) === id);
      return found
        ? rows.map((r) =>
            contactId(r.agreeKey) === id ? { ...r, reachable } : r,
          )
        : null;
    });
    return found;
  }

  /** Called with each session a contact opened to this device, on either path. Returns the unsubscribe. */
  onLink(fn: (s: ConnectSession) => void): () => void {
    this.#onLink.add(fn);
    return () => this.#onLink.delete(fn);
  }

  /**
   * Open the pairing window. Both people do it; each device advertises, finds the other and runs the
   * code. Throws the typed N/A while links are off, and what `identity()` throws. The returned handle
   * closes the window (`stop()`); it also closes by itself after `seconds` (at most 300) and once a
   * link is made.
   */
  async pair(o: LinkPairOptions): Promise<LinkPairHandle> {
    this.#requireOn("pair");
    await this.connect.identity();
    const h = await LinkPairing.start(this.connect.pairSource(), o);
    this.#pairing.add(h);
    return h;
  }

  /**
   * A session to a contact: LAN first when it was seen on the network, the contact relay after a
   * failed or timed-out LAN attempt (unless disabled). A pending contact (a re-pair) is tried
   * before the held one. Throws the typed N/A while links are off, `LanError` `not_started` before
   * `cloudConnect.start()`, and the last `LanError` or `RelayError` when no path works.
   */
  async open(id: string, o: LinkOpenOptions = {}): Promise<ConnectSession> {
    this.#requireOn("open");
    if (this.#lan === null && this.#relay === null)
      throw new LanError("not_started", "Cloud Connect is not started.");
    const rows = (await this.connect.contactRows()).filter(
      (r) => contactId(r.agreeKey) === id,
    );
    if (rows.length === 0)
      throw new LanError("unknown_peer", "That is not a link on this device.");
    // The newest secret first: the pending one of a re-pair, then the held one.
    const order = [
      ...rows.filter((r) => r.pendingSince !== undefined),
      ...rows.filter((r) => r.pendingSince === undefined),
    ].map((r) => r.pendingSince !== undefined);
    let last: Error | null = null;
    for (const pending of order) {
      const lan = this.#lan;
      if (
        lan !== null &&
        lan.contactPeers().some((p) => p.id === id && p.pending === pending)
      ) {
        try {
          return this.#track(
            await this.#bounded(
              lan.connectContact(id, pending),
              o.lanAttemptMs ?? this.#lanAttemptMs,
            ),
          );
        } catch (e) {
          last = e instanceof Error ? e : null;
        }
      }
      if (this.#relay !== null && o.relay !== false && this.#relayOn) {
        try {
          return this.#track(await this.#relay.dial(id, pending));
        } catch (e) {
          last = e instanceof Error ? e : null;
        }
      }
    }
    throw (
      last ??
      new LanError(
        "unknown_peer",
        "That contact was not found on this network, and the relay is off.",
      )
    );
  }

  // ── Wiring (CloudConnect.start and stop) ────────────────────────────────────────────────────

  /** @internal */
  attach(
    lan: LanService | null,
    relay: ContactRelay | null,
    o: { lanAttemptMs: number; relayOn: boolean },
  ): void {
    this.detach();
    this.#lan = lan;
    this.#relay = relay;
    this.#lanAttemptMs = o.lanAttemptMs;
    this.#relayOn = o.relayOn;
    if (lan !== null)
      this.#unsub.push(lan.onContactSession((s) => this.#inbound(s)));
    if (relay !== null)
      this.#unsub.push(relay.onSession((s) => this.#inbound(s)));
    // The list or the gate moved: end the sessions that no longer have a footing.
    this.#follow = this.connect.onContactsChanged(
      () => void this.#reconcile().catch(() => undefined),
    );
  }

  /** @internal Stops the pairing windows and the contact sessions; the transports are CloudConnect's. */
  async detach(): Promise<void> {
    for (const u of this.#unsub.splice(0)) u();
    this.#follow?.();
    this.#follow = null;
    this.#lan = null;
    this.#relay = null;
    const pairs = [...this.#pairing];
    this.#pairing.clear();
    await Promise.all([
      ...pairs.map((p) => p.stop().catch(() => undefined)),
      ...[...this.#sessions].map((s) => s.close().catch(() => undefined)),
    ]);
    this.#sessions.clear();
  }

  /** @internal */
  async closePairings(): Promise<void> {
    const pairs = [...this.#pairing];
    this.#pairing.clear();
    await Promise.all(pairs.map((p) => p.stop().catch(() => undefined)));
  }

  #inbound(s: ConnectSession): void {
    this.#track(s);
    for (const f of [...this.#onLink]) f(s);
  }

  #track(s: ConnectSession): ConnectSession {
    this.#sessions.add(s);
    s.onClose(() => this.#sessions.delete(s));
    return s;
  }

  /** The gate or the list moved: a closed gate ends every contact session (`peer_bye`), a deleted contact's ends `peer_revoked`. */
  async #reconcile(): Promise<void> {
    if (this.#sessions.size === 0) {
      if (!this.connect.interAccount()) await this.closePairings();
      return;
    }
    if (!this.connect.interAccount()) {
      await Promise.all(
        [...this.#sessions].map((s) =>
          s.close("peer_bye").catch(() => undefined),
        ),
      );
      await this.closePairings();
      return;
    }
    const have = new Set(
      (await this.connect.contactRows()).map((r) => contactId(r.agreeKey)),
    );
    await Promise.all(
      [...this.#sessions]
        .filter((s) => s.contact !== null && !have.has(s.contact.id))
        .map((s) => s.close("peer_revoked").catch(() => undefined)),
    );
  }

  #bounded(p: Promise<ConnectSession>, ms: number): Promise<ConnectSession> {
    return new Promise((resolve, reject) => {
      let late = false;
      const t = setTimeout(() => {
        late = true;
        reject(
          new LanError(
            "connect_failed",
            "The LAN attempt took too long; trying the relay.",
          ),
        );
      }, ms);
      p.then(
        (s) => {
          clearTimeout(t);
          if (late) void s.close().catch(() => undefined);
          else resolve(s);
        },
        (e: unknown) => {
          clearTimeout(t);
          if (!late) reject(e);
        },
      );
    });
  }
}
