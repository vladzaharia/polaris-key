// `LinkPairingModel` and `TransferOfferModel` (CC-19.9): the state machines behind LinkPairing and
// TransferOffer (models/connect.ts). They run over narrow drivers any SDK can implement, so a kit
// binds `cloudConnect.links.pair` without ui-core importing an SDK.
//
//   LinkPairingModel   open → code → confirm → linked | failed        (unavailable: links are off)
//
//   - the window opens with `start()`; a device that reached the code shows its code, label and the
//     categories; one offer at a time: a second device that reaches the code meanwhile is declined;
//   - `confirm()` waits for the other person; `decline()` closes that session and the window stays
//     open for the next device; `cancel()` closes the window;
//   - a failure of a session this person never saw (no code shown) changes nothing on screen.
//
//   TransferOfferModel ask → receiving → done | failed
//
//   - consent per transfer (D-8): `accept()` and `decline()` each answer the host's offer once; a
//     second answer is ignored.

import { contextOf, type UiInput } from "./input.js";
import { linkPairingView, transferOfferView } from "./models/connect.js";
import { createStore, type Deliver, type Store } from "./store.js";
import type { View } from "./view.js";

// ── LinkPairingModel ───────────────────────────────────────────────────────────────────────────

/** A nearby device at the code stage (`LinkOffer` of `cloudConnect.links.pair`). */
export interface LinkPairingOffer {
  readonly label: string | null;
  readonly code: string;
  readonly categories: readonly string[];
  confirm(): Promise<void>;
  decline(): Promise<void>;
}

export interface LinkPairingDriver {
  /** Open the pairing window; rejects with the typed N/A while links are off (see `isUnavailable`). */
  pair(o: {
    categories: readonly string[];
    label?: string;
    seconds?: number;
    onCode(offer: LinkPairingOffer): void;
    onLinked(link: {
      label: string | null;
      categories: readonly string[];
    }): void;
    onFailed(f: { reason: "declined" | "timeout" | "full" | "closed" }): void;
  }): Promise<{ stop(): Promise<void> }>;
  /** True for the error that means links are off for this product (`connect_links_disabled`). */
  isUnavailable?(error: unknown): boolean;
}

export type LinkPairingStep =
  | "idle"
  | "open"
  | "code"
  | "confirm"
  | "linked"
  | "failed"
  | "unavailable";

export interface LinkPairingSnapshot {
  step: LinkPairingStep;
  device?: string;
  code?: string;
  categories: readonly string[];
  reason?: "declined" | "timeout" | "full" | "closed";
}

export interface LinkPairingOptions {
  driver: LinkPairingDriver;
  /** The data categories this app asks both people to approve. */
  categories: readonly string[];
  /** This device's label, sent to the other device. */
  label?: string;
  /** Seconds the window stays open. */
  seconds?: number;
  /** Everything else the views read (identity, platform, services). */
  base?: UiInput;
  deliver?: Deliver;
}

export class LinkPairingModel {
  readonly store: Store<LinkPairingSnapshot>;
  base: UiInput;
  private readonly o: LinkPairingOptions;
  private handle: { stop(): Promise<void> } | null = null;
  private offer: LinkPairingOffer | null = null;
  /** Bumped when a window ends, so a late callback from an old one is dropped. */
  private epoch = 0;

  constructor(options: LinkPairingOptions) {
    this.o = options;
    this.base = options.base ?? {};
    this.store = createStore<LinkPairingSnapshot>(
      { step: "idle", categories: [...options.categories] },
      { deliver: options.deliver },
    );
  }

  get snapshot(): LinkPairingSnapshot {
    return this.store.get();
  }

  /** The views' input: the base with the step on top. Idle has no pairing, so the view is hidden. */
  input(): UiInput {
    const { step, device, code, categories, reason } = this.store.get();
    if (step === "idle") return this.base;
    return {
      ...this.base,
      linkPairing: {
        step,
        categories,
        ...(device !== undefined ? { device } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }

  view(): View<"LinkPairing"> {
    return linkPairingView(contextOf(this.input()));
  }

  /** Open the pairing session (also Try again). */
  async start(): Promise<void> {
    await this.close();
    const epoch = ++this.epoch;
    const live = (): boolean => epoch === this.epoch;
    this.store.set((s) => ({
      step: "open",
      categories: s.categories,
    }));
    try {
      const handle = await this.o.driver.pair({
        categories: this.o.categories,
        label: this.o.label,
        seconds: this.o.seconds,
        onCode: (offer) => {
          if (!live()) return;
          if (this.offer) {
            // One device at a time: the next one is declined, not left waiting.
            void offer.decline().catch(() => {});
            return;
          }
          this.offer = offer;
          this.store.set((s) => ({
            step: "code",
            categories: s.categories,
            code: offer.code,
            ...(offer.label ? { device: offer.label } : {}),
          }));
        },
        onLinked: (link) => {
          if (!live()) return;
          this.offer = null;
          this.store.set({
            step: "linked",
            categories: [...link.categories],
            ...(link.label ? { device: link.label } : {}),
          });
        },
        onFailed: (f) => {
          // A session nobody saw (no code shown) fails silently.
          if (!live() || !this.offer) return;
          this.offer = null;
          this.store.set((s) => ({
            step: "failed",
            categories: s.categories,
            reason: f.reason,
          }));
        },
      });
      if (!live()) {
        await handle.stop().catch(() => {});
        return;
      }
      this.handle = handle;
    } catch (e) {
      if (!live()) return;
      const off = this.o.driver.isUnavailable?.(e) === true;
      this.store.set((s) => ({
        step: off ? "unavailable" : "failed",
        categories: s.categories,
        ...(off ? {} : { reason: "closed" as const }),
      }));
    }
  }

  /** Codes match: confirm on this device. The link is made when the other person does too. */
  async confirm(): Promise<void> {
    const offer = this.offer;
    if (!offer || this.store.get().step !== "code") return;
    this.store.set((s) => ({ ...s, step: "confirm" }));
    try {
      await offer.confirm();
    } catch {
      if (this.offer === offer) {
        this.offer = null;
        this.store.set((s) => ({
          step: "failed",
          categories: s.categories,
          reason: "closed",
        }));
      }
    }
  }

  /** Not a match: close that session; the window stays open for the next device. */
  async decline(): Promise<void> {
    const offer = this.offer;
    if (!offer || this.store.get().step !== "code") return;
    this.offer = null;
    this.store.set((s) => ({ step: "open", categories: s.categories }));
    await offer.decline().catch(() => {});
  }

  /** Close the window and let go of any session. */
  async cancel(): Promise<void> {
    await this.close();
    this.store.set((s) => ({ step: "idle", categories: s.categories }));
  }

  private async close(): Promise<void> {
    this.epoch++;
    const offer = this.offer;
    const handle = this.handle;
    this.offer = null;
    this.handle = null;
    if (offer) await offer.decline().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
  }
}

// ── TransferOfferModel ─────────────────────────────────────────────────────────────────────────

export interface TransferOfferDriver {
  /** Accept: resolves when everything arrived and was saved; rejects when it did not. */
  accept(): Promise<void>;
  /** Decline: nothing is received. */
  decline(): Promise<void>;
  /** Stop a transfer in flight. */
  cancel?(): Promise<void>;
}

export type TransferOfferStep = "ask" | "receiving" | "done" | "failed";

export interface TransferOfferSnapshot {
  step: TransferOfferStep | "closed";
  device?: string;
  name: string;
  size?: number;
  type?: string;
}

export interface TransferOfferOptions {
  driver: TransferOfferDriver;
  /** The contact's label (text the contact chose). */
  device?: string | null;
  /** What it offers (text the contact chose). */
  name: string;
  /** The size in bytes and the media type, when the contact said. */
  size?: number;
  type?: string;
  base?: UiInput;
  deliver?: Deliver;
}

export class TransferOfferModel {
  readonly store: Store<TransferOfferSnapshot>;
  base: UiInput;
  private readonly driver: TransferOfferDriver;
  private answered = false;

  constructor(options: TransferOfferOptions) {
    this.driver = options.driver;
    this.base = options.base ?? {};
    this.store = createStore<TransferOfferSnapshot>(
      {
        step: "ask",
        name: options.name,
        ...(options.device ? { device: options.device } : {}),
        ...(options.size !== undefined ? { size: options.size } : {}),
        ...(options.type ? { type: options.type } : {}),
      },
      { deliver: options.deliver },
    );
  }

  get snapshot(): TransferOfferSnapshot {
    return this.store.get();
  }

  input(): UiInput {
    const { step, device, name, size, type } = this.store.get();
    if (step === "closed") return this.base;
    return {
      ...this.base,
      transferOffer: {
        step,
        name,
        ...(device ? { device } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(type ? { type } : {}),
      },
    };
  }

  view(): View<"TransferOffer"> {
    return transferOfferView(contextOf(this.input()));
  }

  /** Accept the offer. Answered once: a second press does nothing. */
  async accept(): Promise<void> {
    if (this.answered || this.store.get().step !== "ask") return;
    this.answered = true;
    this.store.set((s) => ({ ...s, step: "receiving" }));
    try {
      await this.driver.accept();
      this.set("done");
    } catch {
      this.set("failed");
    }
  }

  /** Decline the offer, and close. */
  async decline(): Promise<void> {
    if (this.answered || this.store.get().step !== "ask") return;
    this.answered = true;
    this.store.set((s) => ({ ...s, step: "closed" }));
    await this.driver.decline().catch(() => {});
  }

  /** Stop the transfer in flight: it ends as failed, nothing kept. */
  async cancel(): Promise<void> {
    if (this.store.get().step !== "receiving") return;
    this.set("failed");
    await this.driver.cancel?.().catch(() => {});
  }

  /** Done: close the prompt. */
  close(): void {
    this.store.set((s) => ({ ...s, step: "closed" }));
  }

  private set(step: TransferOfferStep): void {
    this.store.set((s) => (s.step === "receiving" ? { ...s, step } : s));
  }
}
