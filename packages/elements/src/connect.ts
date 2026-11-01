// The inter-account screens as elements (CC-19.L): `<pk-link-pairing>` (two people pair their
// devices once, in person) and `<pk-transfer-offer>` (a contact offers to send something; consent
// per transfer, D-8). Both draw ui-core's `linkPairingView` and `transferOfferView` through the
// layout engine, and run its `LinkPairingModel` and `TransferOfferModel` the way the React kit
// does (sdk-react/src/kit/connect.tsx, connectHooks.ts):
//
//   - plain: set `input` (`linkPairing`, `transferOffer`) and hear `pk-action`; `pk-close` says
//     Done, Cancel, Decline or Escape was pressed and the host closes the screen;
//   - `<pk-link-pairing .driver=...>`: the host supplies the pairing driver (a desktop host's
//     `cloudConnect.links.pair` over its bridge). The browser runtime has no pairing; a driver
//     that rejects with `connect_links_disabled` draws the neutral "Pairing is off" state;
//   - `<pk-transfer-offer .transfer=... .receive=...>`: bound to the browser SDK's
//     `cloudConnect.transfer`. Every offer waits for the person's Accept or Decline; Accept hands
//     the content to `receive(blob, offer)` only after the hash matched. With no `receive` the
//     offer is declined without a prompt, as the SDK declines with no handler (D-8).
//     `.driver` + `name` + `device` draws one offer the host answers itself.
//
// `pk-linked` is the pairing's own event, when the link was made.

import {
  LinkPairingModel,
  TransferOfferModel,
  type LinkPairingDriver,
  type TransferOfferDriver,
  type UiInput,
} from "@polaris-key/ui-core";

import { PkElement } from "./element.js";
import type { RenderCtx } from "./render.js";

/** Tell the host the screen is finished with. */
function close(el: HTMLElement): void {
  el.dispatchEvent(
    new CustomEvent("pk-close", { bubbles: true, composed: true }),
  );
}

/** What both screens share: a press is answered here, and the screen follows the element in and
 *  out of the page. */
abstract class PkConnectElement extends PkElement {
  constructor() {
    super();
    this.addEventListener("pk-action", (e) =>
      this.answer((e as CustomEvent<{ key: string }>).detail.key),
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.attach();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.detach();
  }

  /** The element entered the page. */
  protected abstract attach(): void;
  /** The element left the page. */
  protected abstract detach(): void;
  /** A control was pressed. */
  protected abstract answer(key: string): void;
}

/** `<pk-link-pairing>`. */
export class PkLinkPairing extends PkConnectElement {
  readonly component = "LinkPairing" as const;

  static override properties = {
    ...PkElement.properties,
    driver: { attribute: false },
    categories: { attribute: false },
    categoryLabels: { attribute: false },
    label: {},
    seconds: { type: Number },
  };

  /** Drives the window. Without it the element draws `input.linkPairing` and the host does the rest. */
  driver?: LinkPairingDriver;
  /** The data categories this app asks both people to approve (ids, at most 8). */
  categories?: readonly string[];
  /** The name each category goes by on screen, by id; an id without one is drawn as words. */
  categoryLabels?: Readonly<Record<string, string>>;
  /** This device's label, sent to the other device. */
  label?: string;
  /** Seconds the window stays open (at most 300). */
  seconds?: number;

  private pairing: LinkPairingModel | null = null;
  private pairingDriver: LinkPairingDriver | undefined;
  private told = false;
  private unsub: (() => void) | null = null;

  protected attach(): void {
    // Re-attached: the window opens again.
    if (this.driver && !this.pairing) this.bind();
  }

  protected detach(): void {
    this.release();
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.isConnected && this.driver !== this.pairingDriver) this.bind();
    super.willUpdate(changed as never);
  }

  protected override baseInput(): UiInput {
    if (!this.pairing) return super.baseInput();
    this.pairing.base = this.input ?? {};
    return this.pairing.input();
  }

  protected override ctxExtra(): Partial<RenderCtx> {
    return this.categoryLabels ? { categoryLabels: this.categoryLabels } : {};
  }

  /** Open the window on the supplied driver. */
  private bind(): void {
    this.release();
    this.pairingDriver = this.driver;
    if (!this.driver) return;
    const model = new LinkPairingModel({
      driver: this.driver,
      categories: this.categories ?? [],
      label: this.label,
      seconds: this.seconds,
      base: this.input,
    });
    this.pairing = model;
    this.told = false;
    this.unsub = model.store.subscribe((s) => {
      this.requestUpdate();
      if (s.step === "linked" && !this.told) {
        this.told = true;
        this.dispatchEvent(
          new CustomEvent("pk-linked", { bubbles: true, composed: true }),
        );
      }
      if (s.step !== "linked") this.told = false;
    });
    void model.start();
  }

  private release(): void {
    this.unsub?.();
    this.unsub = null;
    const model = this.pairing;
    this.pairing = null;
    this.pairingDriver = undefined;
    if (model) void model.cancel();
  }

  protected answer(key: string): void {
    const model = this.pairing;
    switch (key) {
      case "linkPairing.confirm":
        void model?.confirm();
        return;
      case "linkPairing.decline":
        void model?.decline();
        return;
      case "common.tryAgain":
        void model?.start();
        return;
      case "common.cancel":
      case "common.done":
        if (model) void model.cancel().then(() => close(this));
        else close(this);
        return;
    }
  }
}

/** What the page needs of a transfer offer: the content of `IncomingOffer`, as far as it is drawn. */
export interface OfferInfo {
  id: string;
  name?: string;
  from: { label: string | null };
}

/** The handler's answer: decline, or take the content once it was verified. */
export type OfferAnswer =
  | "decline"
  | { blob: (blob: Blob) => void | Promise<void> };

/** The slice of the browser SDK's `cloudConnect.transfer` the element is bound to. */
export interface OfferSource {
  onOffer(
    handler: ((offer: OfferInfo) => Promise<OfferAnswer>) | null,
  ): () => void;
  onResult?(fn: (e: { id: string; outcome: string }) => void): () => void;
  cancel?(id: string): boolean;
}

interface Waiting {
  offer: OfferInfo;
  answer(a: OfferAnswer): void;
}

/** `<pk-transfer-offer>`. */
export class PkTransferOffer extends PkConnectElement {
  readonly component = "TransferOffer" as const;

  static override properties = {
    ...PkElement.properties,
    transfer: { attribute: false },
    receive: { attribute: false },
    driver: { attribute: false },
    device: {},
    name: {},
  };

  /** The browser SDK's `cloudConnect.transfer`: its offers are drawn here, one at a time. */
  transfer?: OfferSource;
  /** Takes what arrived, after its hash matched. Without it every offer is declined. */
  receive?: (blob: Blob, offer: OfferInfo) => void | Promise<void>;
  /** Answers one offer the host draws itself (with `name`, `device`). */
  driver?: TransferOfferDriver;
  /** The contact's label (text the contact chose). */
  device?: string;
  /** What the contact offers (text the contact chose). */
  name?: string;

  private session: TransferOfferModel | null = null;
  private sessionKey: unknown = null;
  private unsub: (() => void)[] = [];
  private queue: Waiting[] = [];
  private bound: OfferSource | undefined;
  private failCurrent: ((reason: Error) => void) | null = null;
  private currentId: string | null = null;

  protected attach(): void {
    this.bind();
  }

  protected detach(): void {
    this.unbind();
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (this.isConnected) this.bind();
    super.willUpdate(changed as never);
  }

  protected override baseInput(): UiInput {
    if (!this.session) return super.baseInput();
    this.session.base = this.input ?? {};
    return this.session.input();
  }

  /** Follow the properties: the SDK's offers, or the one offer the host answers. */
  private bind(): void {
    if (this.transfer !== this.bound) {
      this.unbind();
      this.bound = this.transfer;
      const source = this.transfer;
      if (source) {
        this.unsub.push(
          source.onOffer((offer) => this.arrives(offer)),
          ...(source.onResult
            ? [
                source.onResult((e) => {
                  if (e.id === this.currentId && e.outcome !== "delivered")
                    this.failCurrent?.(new Error(e.outcome));
                }),
              ]
            : []),
        );
      }
    }
    if (!this.transfer && this.driver && this.name) {
      const key = [this.driver, this.name, this.device];
      const same =
        Array.isArray(this.sessionKey) &&
        key.every((k, i) => k === (this.sessionKey as unknown[])[i]);
      if (!same) {
        this.sessionKey = key;
        this.open(
          new TransferOfferModel({
            driver: this.driver,
            device: this.device,
            name: this.name,
            base: this.input,
          }),
        );
      }
    }
  }

  /** An offer arrived: held until the person answers; declined at once with no `receive`. */
  private arrives(offer: OfferInfo): Promise<OfferAnswer> {
    if (!this.receive) return Promise.resolve("decline");
    return new Promise<OfferAnswer>((answer) => {
      this.queue.push({ offer, answer });
      this.next();
    });
  }

  /** Show the next waiting offer once the last one is finished with. */
  private next(): void {
    if (this.session) return;
    const w = this.queue.shift();
    if (!w) return;
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A transfer nobody awaits rejects quietly; the model reads the outcome.
    done.catch(() => undefined);
    const source = this.transfer;
    this.open(
      new TransferOfferModel({
        driver: {
          accept: () => {
            w.answer({
              blob: async (blob) => {
                try {
                  await this.receive?.(blob, w.offer);
                  resolve();
                } catch (e) {
                  reject(e instanceof Error ? e : new Error("sink"));
                }
              },
            });
            return done;
          },
          decline: async () => w.answer("decline"),
          cancel: async () => {
            source?.cancel?.(w.offer.id);
            reject(new Error("cancelled"));
          },
        },
        device: w.offer.from.label,
        name: w.offer.name ?? "",
        base: this.input,
      }),
    );
    // Set after `open`, which clears the last offer's.
    this.currentId = w.offer.id;
    this.failCurrent = reject;
  }

  private open(model: TransferOfferModel): void {
    this.dropSession();
    this.session = model;
    const off = model.store.subscribe((s) => {
      this.requestUpdate();
      if (s.step === "closed" && this.session === model) {
        this.dropSession();
        this.next();
        this.requestUpdate();
      }
    });
    this.sessionOff = off;
    this.requestUpdate();
  }

  private sessionOff: (() => void) | null = null;

  private dropSession(): void {
    this.sessionOff?.();
    this.sessionOff = null;
    this.session = null;
    this.currentId = null;
    this.failCurrent = null;
  }

  private unbind(): void {
    for (const u of this.unsub.splice(0)) u();
    const fromSdk = this.bound !== undefined;
    this.bound = undefined;
    // Everything still waiting is declined: consent is per transfer, and nobody can give it now.
    // (An offer the host answers itself stays the host's to answer.)
    const waiting = this.queue.splice(0);
    if (fromSdk) void this.session?.decline();
    this.dropSession();
    this.sessionKey = null;
    for (const w of waiting) w.answer("decline");
  }

  protected answer(key: string): void {
    const model = this.session;
    switch (key) {
      case "transferOffer.accept":
        void model?.accept();
        return;
      case "transferOffer.decline":
        if (model) void model.decline().then(() => close(this));
        else close(this);
        return;
      case "common.cancel":
        if (model) void model.cancel();
        else close(this);
        return;
      case "common.done":
        if (model) model.close();
        close(this);
        return;
    }
  }
}
