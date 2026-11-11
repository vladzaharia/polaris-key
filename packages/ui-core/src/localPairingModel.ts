// `LocalPairingModel` (CC-29K): the state machine behind Pair with a Code, over a narrow driver any
// SDK can implement (`cloudConnect.localLinks`, through a host's bridge). It holds what no view
// may: the stale-code guard, the 30-second wait after Too many tries and its second-time warning,
// the "someone may be guessing" notice, and the order of the two roles.
//
//   choose → show (closed) | enter (joining, waiting) → confirm → paired | failed
//
//   - show: the window runs from `expiresAt`; a wrong guess changes the code (the changed digits
//     are lit, the new code announced); an end of `too-many-tries` closes it and a new code waits
//     30 s (`COOLDOWN_SECONDS`; the SDK enforces the same floor and rejects `cooldown`, which this
//     handles by waiting out the rest); a window that ran out waits for nothing;
//   - the second `too-many-tries` in a row, or 5 wrong codes over renewed windows with no pairing,
//     warns that someone nearby may be guessing (D4);
//   - enter: Pair is unavailable (aria-disabled) with fewer than 8 digits, a prefix with no dial
//     left, or the very code that just failed; pressing it answers its reason under the field. After
//     `wrong` the first two digits stay and the rest clears; after `spent` the field is empty and
//     editable. The failed code is held only while the screen is up and never shown or logged;
//   - Pair is the joiner's consent: the other device's prompt is confirmed at once and the
//     screen waits for the other person; Cancel stops the join at any point.
//
// Clocks and timers are injected (`now` in seconds since the epoch, `timer`): tests drive them.

import {
  ErrorCode,
  LocalLinksCap,
  LocalPairFailure,
  LocalWindowEnd,
  LocalCodeReason,
  PairingCodeFailedReason,
} from "./browser/sdk/constants.generated.js";
import { contextOf, type LocalPairingInput, type UiInput } from "./input.js";
import {
  COOLDOWN_SECONDS,
  MAX_CONNECTABLE,
  MAX_PAIRED,
  localPairingView,
} from "./models/local.js";
import { createStore, type Deliver, type Store } from "./store.js";
import type { View } from "./view.js";

// ── The driver ──────────────────────────────────────────────────────────────────────────────────

/** The code a shower shows now (`LocalCode` of `localLinks.pair`). */
export interface LocalCodeLike {
  readonly code: string;
  /** The QR's text (`PKP1:<SLUG>:<INSTANCE>:<SECRET>`). */
  readonly qr: string;
  readonly reason: string;
  readonly expiresAt: number;
  readonly failures: number;
}

/** The other device at consent (`LocalOffer`). */
export interface LocalOfferLike {
  readonly label: string | null;
  readonly categories: readonly string[];
  confirm(): Promise<void>;
  decline(): Promise<void>;
}

/** A pairing that was stored (`LocalPaired`). */
export interface LocalPairedLike {
  readonly id: string;
  readonly label: string | null;
  readonly categories: readonly string[];
}

/** A paired device (`LocalLinkInfo`). */
export interface LocalLinkLike {
  readonly id: string;
  readonly label: string | null;
  readonly lastSeen: number | null;
  readonly reachable: boolean;
  readonly platform?: string | null;
}

/** What `localLinks.pair` returns. */
export interface LocalWindowLike {
  stop(): Promise<void>;
  renew(): Promise<LocalCodeLike>;
  code(): LocalCodeLike | null;
  readonly open: boolean;
}

/** `client.cloudConnect.localLinks` as far as these models need it. */
export interface LocalLinksLike {
  /** The cached discovery answer: false while pairing is off for this app. */
  localPairing(): boolean;
  list(): Promise<readonly LocalLinkLike[]>;
  rename(id: string, label: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  setReachable(id: string, reachable: boolean): Promise<boolean>;
  /** Fires after any change to the links or the gate; read `list()` and `localPairing()` again. */
  onChange(fn: () => void): () => void;
  /** Dials left for the typed code's first two digits: 0, 1 or 2; null until two are typed. */
  dialsLeft(text: string): number | null;
  pair(o: {
    categories: readonly string[];
    label?: string;
    onCode(c: LocalCodeLike): void;
    onConfirm(offer: LocalOfferLike): void;
    onLinked(link: LocalPairedLike): void;
    onFailed(f: { reason: string }): void;
    onInterrupted(n: number): void;
    onEnd(e: { reason: string }): void;
  }): Promise<LocalWindowLike>;
  join(o: {
    code: string;
    categories: readonly string[];
    label?: string;
    onConfirm(offer: LocalOfferLike): void;
    signal: AbortSignal;
  }): Promise<LocalPairedLike>;
}

/** Any rejection, read by what a typed error carries: `code`, `reason`, `cap`. */
function detail(e: unknown): { code?: string; reason?: string; cap?: string } {
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<
    string,
    unknown
  >;
  const s = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return { code: s(o.code), reason: s(o.reason), cap: s(o.cap) };
}

// ── The model ───────────────────────────────────────────────────────────────────────────────────

export interface LocalPairingSnapshot extends LocalPairingInput {
  /** show: the digit positions (0-8, spaces counted) that changed in the last rotation. */
  changed: readonly number[];
  /** show: bumps with each new code, so a renderer can restart its highlight. */
  rotation: number;
  /** paired: the name field's text; `Done` renames when it changed. */
  name: string;
  /** paired: the pairing's id. */
  id?: string;
  /** The person left (Cancel on choose, Close, Done): the host closes the screen. */
  left: boolean;
}

export interface LocalPairingOptions {
  driver: LocalLinksLike;
  /** The data categories this app asks both people to approve (ids, at most 8). */
  categories: readonly string[];
  /** This device's label, sent to the other device. */
  label?: string;
  /** The system has not asked about the local network yet (macOS 15+, Windows Firewall). */
  prePrompt?: boolean;
  /** The platform can open its settings from the network-blocked answer. */
  canOpenSettings?: boolean;
  /** Seconds since the epoch. Default `Date.now() / 1000`. */
  now?: () => number;
  /** Run `fn` after `ms`; returns the cancel. Default `setTimeout`. */
  timer?: (fn: () => void, ms: number) => () => void;
  base?: UiInput;
  deliver?: Deliver;
}

const TOO_MANY_WRONG = 5;

const digitsOf = (text: string): string => text.replace(/\D/g, "").slice(0, 8);
const grouped = (d: string): string =>
  d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d;

export class LocalPairingModel {
  readonly store: Store<LocalPairingSnapshot>;
  base: UiInput;
  private readonly o: LocalPairingOptions;
  private readonly now: () => number;
  private readonly timer: (fn: () => void, ms: number) => () => void;
  private shower: LocalWindowLike | null = null;
  private offer: LocalOfferLike | null = null;
  private abort: AbortController | null = null;
  private stopTick: (() => void) | null = null;
  private expiresAt = 0;
  private cooldownUntil = 0;
  private tooMany = 0;
  private wrong = 0;
  private failedCode: string | null = null;
  /** The label of the last device that reached the prompt, for "Not paired with …". */
  private lastDevice: string | null = null;
  /** Bumped when a screen's session ends, so a late callback from an old one is dropped. */
  private epoch = 0;

  constructor(options: LocalPairingOptions) {
    this.o = options;
    this.base = options.base ?? {};
    this.now = options.now ?? (() => Date.now() / 1000);
    this.timer =
      options.timer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.store = createStore<LocalPairingSnapshot>(
      {
        step: "choose",
        categories: [...options.categories],
        changed: [],
        rotation: 0,
        name: "",
        left: false,
        max: MAX_CONNECTABLE,
        ...(options.prePrompt ? { prePrompt: true } : {}),
      },
      { deliver: options.deliver },
    );
  }

  get snapshot(): LocalPairingSnapshot {
    return this.store.get();
  }

  /** The views' input: the base with the step on top. */
  input(): UiInput {
    const {
      changed: _changed,
      rotation: _rotation,
      name: _name,
      id: _id,
      left: _left,
      ...pairing
    } = this.store.get();
    return { ...this.base, localPairing: pairing };
  }

  view(): View<"LocalPairing"> {
    return localPairingView(contextOf(this.input())) as View<"LocalPairing">;
  }

  /** Read the gate and the cap: the entry screen says so before either button. */
  async start(): Promise<void> {
    await this.close();
    if (!this.o.driver.localPairing()) {
      this.go({ step: "off" });
      return;
    }
    let full = false;
    try {
      full = (await this.o.driver.list()).length >= MAX_PAIRED;
    } catch {
      // An unreadable store is the list's to say; pairing then fails with its own answer.
    }
    this.go({ ...this.entry(), ...(full ? { full: true } : {}) });
  }

  // ── Show ──────────────────────────────────────────────────────────────────────────────────────

  /** This device shows the code (and again for Show a new code). */
  async show(): Promise<void> {
    if (this.store.get().full) return;
    await this.openWindow();
  }

  /** Show a new code: closes the window and opens one with new first two digits. Waits out the
   *  30 seconds after Too many tries. */
  async showNew(): Promise<void> {
    if (this.cooldownLeft() > 0) return;
    await this.openWindow(true);
  }

  private async openWindow(renew = false): Promise<void> {
    const epoch = renew && this.shower ? this.epoch : ++this.epoch;
    const live = (): boolean => epoch === this.epoch;
    const driver = this.o.driver;
    try {
      if (renew && this.shower) {
        this.rotate(await this.shower.renew());
        return;
      }
      await this.close(false);
      this.epoch = epoch;
      this.shower = await driver.pair({
        categories: this.o.categories,
        label: this.o.label,
        onCode: (c) => live() && this.rotate(c),
        onConfirm: (offer) => live() && this.confirmPrompt(offer),
        onLinked: (link) => live() && this.linked(link),
        onFailed: () => undefined,
        onInterrupted: (n) => {
          if (!live() || n < 3) return;
          if (this.store.get().step === "show") this.set({ notice: "blocked" });
        },
        onEnd: (e) => live() && this.ended(e.reason),
      });
      if (!live()) await this.shower.stop().catch(() => {});
    } catch (e) {
      if (live()) this.fail(e, "show");
    }
  }

  /** A new code on show: an opened one starts the window, any other is a rotation. */
  private rotate(c: LocalCodeLike): void {
    const prev = this.store.get();
    this.expiresAt = c.expiresAt;
    const opened = c.reason === LocalCodeReason.opened;
    const wrongCode = c.reason === LocalCodeReason.wrongCode;
    if (wrongCode) this.wrong++;
    const changed =
      !opened && prev.code
        ? [...c.code].flatMap((ch, i) => (ch !== prev.code![i] ? [i] : []))
        : [];
    const notice: LocalPairingInput["notice"] = opened
      ? undefined
      : wrongCode
        ? this.wrong >= TOO_MANY_WRONG
          ? "guessing"
          : "rotated"
        : "declined";
    this.go(
      {
        step: "show",
        code: c.code,
        qr: c.qr,
        secondsLeft: Math.max(0, Math.ceil(c.expiresAt - this.now())),
        ...(notice ? { notice } : {}),
        ...(notice === "declined" && this.lastDevice
          ? { device: this.lastDevice }
          : {}),
      },
      { changed, rotation: prev.rotation + 1 },
    );
    this.tick();
  }

  /** The window ended: Too many tries closes it for 30 s; time running out, for nothing. */
  private ended(reason: string): void {
    this.offer = null;
    this.shower = null;
    this.cancelTick();
    switch (reason) {
      case LocalWindowEnd.tooManyTries:
        this.tooMany++;
        this.cooldownUntil = this.now() + COOLDOWN_SECONDS;
        this.go({
          step: "closed",
          closedBy: "too-many-tries",
          cooldownLeft: COOLDOWN_SECONDS,
          ...(this.tooMany >= 2 ? { warn: true } : {}),
        });
        this.tick();
        break;
      case LocalWindowEnd.expired:
        this.go({
          step: "closed",
          closedBy: "expired",
          ...(this.tooMany >= 2 ? { warn: true } : {}),
        });
        break;
      case LocalWindowEnd.off:
        this.go({ step: "off" });
        break;
      case LocalWindowEnd.stored:
        break; // `onLinked` took the screen to paired
      default:
        // The person's own stop: back to the entry, nothing kept.
        this.go(this.entry());
    }
  }

  // ── Confirm ───────────────────────────────────────────────────────────────────────────────────

  private confirmPrompt(offer: LocalOfferLike): void {
    if (this.offer) {
      // One device at a time: the next one is declined, not left waiting.
      void offer.decline().catch(() => {});
      return;
    }
    this.offer = offer;
    this.lastDevice = offer.label;
    this.go({
      step: "confirm",
      categories: [...offer.categories],
      ...(offer.label ? { device: offer.label } : {}),
    });
  }

  /** Pair: the person's yes. The link exists once the other person agrees too. */
  async confirm(): Promise<void> {
    const offer = this.offer;
    if (!offer || this.store.get().step !== "confirm") return;
    try {
      await offer.confirm();
    } catch {
      /* the session's end is reported by the window */
    }
  }

  /** Not now: nothing is stored; the shower stays on its changed code. */
  async notNow(): Promise<void> {
    const offer = this.offer;
    if (!offer || this.store.get().step !== "confirm") return;
    this.offer = null;
    await offer.decline().catch(() => {});
  }

  private linked(link: LocalPairedLike): void {
    this.shower = null;
    this.cancelTick();
    this.stored(link);
  }

  /** A pairing was stored, from either role: the paired screen, and a clean slate for the next. */
  private stored(link: LocalPairedLike): void {
    this.offer = null;
    this.abort = null;
    this.tooMany = this.wrong = 0;
    this.failedCode = this.lastDevice = null;
    const device = link.label ? { device: link.label } : {};
    this.go(
      { step: "paired", ...device },
      { name: link.label ?? "", id: link.id },
    );
    void this.checkReachable(link.id);
  }

  /** A pairing kept with Can connect off because 8 already are says so. */
  private async checkReachable(id: string): Promise<void> {
    const epoch = this.epoch;
    try {
      const mine = (await this.o.driver.list()).find((l) => l.id === id);
      if (mine && !mine.reachable && epoch === this.epoch)
        this.set({ cantConnect: true });
    } catch {
      /* a note, not an answer */
    }
  }

  /** The name field of the paired screen. */
  setName(text: string): void {
    if (this.store.get().step === "paired")
      this.store.set((s) => ({ ...s, name: text }));
  }

  /** Done: a changed name is saved on this device, then the screen is left. */
  async done(): Promise<void> {
    const s = this.store.get();
    if (s.step === "paired" && s.id && s.name.trim() && s.name !== s.device)
      await this.o.driver.rename(s.id, s.name.trim()).catch(() => false);
    this.leave();
  }

  // ── Enter ─────────────────────────────────────────────────────────────────────────────────────

  /** This device types the code. */
  async enter(): Promise<void> {
    if (this.store.get().full) return;
    await this.close();
    this.failedCode = null;
    this.go({ step: "enter", entry: "" });
    this.refreshEntry();
  }

  /** The field changed. Spaces and hyphens in a paste are dropped; at most 8 digits are kept. */
  setEntry(text: string): void {
    const s = this.store.get();
    if (s.step !== "enter") return;
    const d = digitsOf(text);
    const prev = digitsOf(s.entry ?? "");
    // The old answer goes with the change; a wrong code's line stays until the person types past
    // the two digits the shower proved.
    const keepWrong = s.error === "wrong" && d.length <= 2;
    this.store.set((x) => ({
      ...x,
      entry: grouped(d),
      error: keepWrong ? "wrong" : undefined,
    }));
    if (d !== prev) this.refreshEntry();
  }

  /** `triesLeft` and `pairDisabled` follow the field and the failed code. */
  private refreshEntry(): void {
    const s = this.store.get();
    if (s.step !== "enter") return;
    const d = digitsOf(s.entry ?? "");
    const left = this.o.driver.dialsLeft(d);
    const stale = this.failedCode !== null && d === this.failedCode;
    this.store.set((x) => ({
      ...x,
      triesLeft: left,
      pairDisabled: d.length < 8 || left === 0 || stale,
    }));
  }

  /** Pair. Unavailable, it answers its reason under the field and sends nothing. */
  async pair(): Promise<void> {
    const s = this.store.get();
    if (s.step !== "enter") return;
    if (s.pairDisabled) {
      const d = digitsOf(s.entry ?? "");
      const reason =
        this.failedCode !== null && d === this.failedCode
          ? "wrong"
          : s.triesLeft === 0
            ? "spent"
            : "not-a-code";
      this.store.set((x) => ({ ...x, error: reason }));
      return;
    }
    const code = digitsOf(s.entry ?? "");
    const epoch = ++this.epoch;
    const live = (): boolean => epoch === this.epoch;
    const abort = (this.abort = new AbortController());
    this.store.set((x) => ({ ...x, step: "joining", error: undefined }));
    try {
      const link = await this.o.driver.join({
        code,
        categories: this.o.categories,
        label: this.o.label,
        onConfirm: (offer) => {
          if (!live()) return;
          this.offer = offer;
          // Pair was the yes: confirm at once and wait for the other person.
          this.store.set((x) => ({
            ...x,
            step: "waiting",
            categories: [...offer.categories],
            ...(offer.label ? { device: offer.label } : {}),
          }));
          void offer.confirm().catch(() => {});
        },
        signal: abort.signal,
      });
      if (!live()) return;
      this.stored(link);
    } catch (e) {
      if (live()) this.joinFailed(e, code);
    }
  }

  private joinFailed(e: unknown, code: string): void {
    this.abort = null;
    this.offer = null;
    const { code: c, reason } = detail(e);
    if (c === ErrorCode.pairingCodeFailed) {
      if (reason === PairingCodeFailedReason.spent) {
        // B2: the field is empty and editable; Pair waits for first two digits that differ.
        this.failedCode = null;
        this.back({ entry: "", error: "too-many" });
        return;
      }
      if (reason === PairingCodeFailedReason.invalid) {
        this.back({ entry: grouped(code), error: "not-a-code" });
        return;
      }
      // B1: `wrong` and another app's QR read alike. The first two digits stay.
      this.failedCode = code;
      this.back({ entry: code.slice(0, 2), error: "wrong" });
      return;
    }
    if (c === ErrorCode.pairingNotFound) {
      this.back({ entry: grouped(code), error: "not-found" });
      return;
    }
    if (c === ErrorCode.peerClosed) {
      if (reason === LocalPairFailure.cancelled) {
        this.back({ entry: grouped(code) });
        return;
      }
      const r =
        reason === LocalPairFailure.declined ||
        reason === LocalPairFailure.timeout
          ? reason
          : "closed";
      this.go({ step: "failed", reason: r });
      return;
    }
    this.fail(e, "enter");
  }

  /** Back to the field with the answer; Pair's state follows the field. */
  private back(over: {
    entry: string;
    error?: LocalPairingInput["error"];
  }): void {
    this.go({ step: "enter", entry: over.entry, error: over.error });
    this.refreshEntry();
  }

  /** Show a code instead, from the field. */
  async toShow(): Promise<void> {
    await this.openWindow();
  }

  /** Enter a code instead, from a shown code: the window is withdrawn at once. */
  async toEnter(): Promise<void> {
    await this.enter();
  }

  // ── Leaving ───────────────────────────────────────────────────────────────────────────────────

  /** Cancel: withdraws the code, stops a join or declines a prompt, and returns one step. */
  async cancel(): Promise<void> {
    const step = this.store.get().step;
    switch (step) {
      case "joining":
      case "waiting": {
        const offer = this.offer;
        this.abort?.abort();
        this.epoch++;
        this.abort = null;
        this.offer = null;
        if (offer) await offer.decline().catch(() => {});
        this.failedCode = null;
        this.go({ step: "enter", entry: "" });
        this.refreshEntry();
        return;
      }
      case "show":
      case "confirm":
        await this.close();
        this.go(this.entry());
        return;
      default:
        this.leave();
    }
  }

  /** Back, from the field: to the entry. */
  async backToChoose(): Promise<void> {
    await this.close();
    this.go(this.entry());
  }

  /** Close, Done or Cancel on the entry: the host closes the screen. */
  async close(withLeave = false): Promise<void> {
    this.epoch++;
    this.cancelTick();
    const { offer, shower, abort } = this;
    this.offer = null;
    this.shower = null;
    this.abort = null;
    abort?.abort();
    if (offer) await offer.decline().catch(() => {});
    if (shower) await shower.stop().catch(() => {});
    if (withLeave) this.leave();
  }

  /** Try again, from a failed pairing. */
  async retry(): Promise<void> {
    await this.enter();
  }

  /** The person left: the host closes the screen. */
  private leave(): void {
    void this.close();
    this.store.set((s) => ({ ...s, left: true }));
  }

  // ── Time ──────────────────────────────────────────────────────────────────────────────────────

  private cooldownLeft(): number {
    return Math.max(0, Math.ceil(this.cooldownUntil - this.now()));
  }

  /** One second passed: the ring and the wait follow the clock. Public so a test drives it. */
  tick(): void {
    this.cancelTick();
    const s = this.store.get();
    if (s.step === "show") {
      this.store.set((x) => ({
        ...x,
        secondsLeft: Math.max(0, Math.ceil(this.expiresAt - this.now())),
      }));
    } else if (s.step === "closed" && (s.cooldownLeft ?? 0) > 0) {
      const left = this.cooldownLeft();
      this.store.set((x) => ({ ...x, cooldownLeft: left }));
      if (left === 0) return;
    } else return;
    this.stopTick = this.timer(() => this.tick(), 1000);
  }

  private cancelTick(): void {
    this.stopTick?.();
    this.stopTick = null;
  }

  // ── Errors ────────────────────────────────────────────────────────────────────────────────────

  /** A rejection no screen of the flow names: the gate, the cap, the network, or the shower. */
  private fail(e: unknown, where: "show" | "enter"): void {
    const { code, reason, cap } = detail(e);
    if (code === ErrorCode.localPairingOff) this.go({ step: "off" });
    else if (code === ErrorCode.nearbyPermissionDenied)
      this.go({
        step: "network-blocked",
        ...(this.o.canOpenSettings ? { canOpenSettings: true } : {}),
      });
    else if (code === ErrorCode.localLinksFull && cap === LocalLinksCap.stored)
      this.go({
        step: where === "show" ? "choose" : "failed",
        full: true,
        reason: "full",
      });
    else if (
      code === ErrorCode.peerClosed &&
      reason === LocalPairFailure.cooldown
    ) {
      // The SDK's floor is on: wait out the rest of the 30 s on the closed screen.
      this.cooldownUntil = Math.max(
        this.cooldownUntil,
        this.now() + COOLDOWN_SECONDS,
      );
      this.go({
        step: "closed",
        closedBy: "too-many-tries",
        cooldownLeft: this.cooldownLeft(),
      });
      this.tick();
    } else this.go({ step: "failed", reason: "closed" });
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────────────────────────

  /** The entry screen's input. */
  private entry(): LocalPairingInput {
    return { step: "choose", ...(this.o.prePrompt ? { prePrompt: true } : {}) };
  }

  /** Replace the screen: only what is named survives, with the form and the flags kept apart. */
  private go(
    next: LocalPairingInput,
    extra: Partial<LocalPairingSnapshot> = {},
  ): void {
    this.store.set((s) => ({
      categories: s.categories,
      max: s.max,
      changed: [],
      rotation: s.rotation,
      name: "",
      left: s.left,
      ...next,
      ...extra,
    }));
  }

  private set(over: Partial<LocalPairingSnapshot>): void {
    this.store.set((s) => ({ ...s, ...over }));
  }
}
