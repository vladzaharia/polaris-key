// `SignInModel`: the state machine of the one sign-in form (SIGN-IN.md §3.17, plans/I-04.md §G,
// UI-KITS.md §1.3 "Sign-in and activation in three layers"). Its body morphs in place:
//
//   methods → handoff | code → finishing → choose ↔ replace | key → done
//                                    plus error, expired, cancelled (back to methods)
//
// It drives the SDK primitives of plans/I-04.md §G.9 (`signIn.start`, `session.wait()`,
// `session.reopen()`, `session.cancel()`, `choice.licenses / devices / complete / cancel`,
// `activate`), which I-10a and I-10b implement per SDK; this module only names their shape. The
// form's steps are views of the pure models in ./models/signIn.ts (SignIn, SignInHandoff,
// LicenseChoice) and ./models/activate.ts (the key step), so a kit that draws its own form on
// the snapshot gets the same steps, states and copy keys as the drop-in.
//
// `presentation` and `replace` are inputs: `inline` and `sheet` choose the license in the app
// (`licenseChoice: "app"`), `browser` leaves it to the card (`"card"`); a device-code sign-in
// always chooses on the card and never issues a grant (D4). `replace: "browser"` opens the card's
// Replace instead of the device list.

import {
  contextOf,
  type ActivationInput,
  type DeviceCodeInput,
  type LicenseChoiceView,
  type ReplaceView,
  type SignInSession,
  type UiInput,
} from "./input.js";
import {
  licenseChoiceView,
  signInHandoffView,
  signInView,
} from "./models/signIn.js";
import { createStore, type Deliver, type Store } from "./store.js";
import { defaultSchedule, type Schedule } from "./loading.js";
import type { View } from "./view.js";
import type {
  ReplaceMode,
  SignInChannel,
  SignInPresentation,
} from "./vocabulary.js";

/** What `session.wait()` answers (plans/I-04.md §G.9), with the device-code poll's phase. */
export type SignInWait =
  | { outcome: "pending"; deviceCode?: DeviceCodeInput }
  | {
      outcome: "choose";
      grant: string;
      choices: LicenseChoiceView;
      /** Seconds until the grant lapses (300 by default). */
      expiresIn?: number;
    }
  | { outcome: "signedIn"; issuedNow?: boolean }
  | { outcome: "cancelled" }
  | { outcome: "expired"; deviceCode?: DeviceCodeInput };

/** One sign-in in flight (`signIn.start()`'s answer). */
export interface SignInSessionHandle {
  /** False when the browser could not be opened (DL14: the screen stays with Copy link). */
  browserOpened?: boolean;
  /** The device code to show, for a device-code session. */
  deviceCode?: DeviceCodeInput;
  /** The next outcome; called again while it answers `pending`. */
  wait(): Promise<SignInWait>;
  /** Open the browser on the same request again (never a second request). */
  reopen(): Promise<boolean> | boolean;
  cancel(): Promise<void> | void;
}

/** I-04's `LicenseChoiceInput`. */
export type LicenseChoiceInput =
  | { kind: "license"; licenseId: string; replaceDeviceId?: string }
  | { kind: "keep" }
  | { kind: "create" };

/** What `choice.complete()` answers: signed in, or a race or a lapsed grant to recover from. */
export type ChoiceComplete =
  | { outcome: "signedIn"; issuedNow: boolean }
  | { outcome: "raced" }
  | { outcome: "expired" };

/** The SDK primitives the form drives (Node first; I-10a fixes each language's spelling). */
export interface SignInPrimitives {
  start(options: {
    channel: SignInChannel;
    licenseChoice: "app" | "card";
    provider?: string;
  }): Promise<SignInSessionHandle>;
  choice?: {
    licenses(grant: string): Promise<LicenseChoiceView>;
    devices(grant: string, licenseId: string): Promise<ReplaceView>;
    complete(
      grant: string,
      choice: LicenseChoiceInput,
    ): Promise<ChoiceComplete>;
    cancel(grant: string): Promise<void>;
  };
  /** The key step: `activate(key)`, answered as the activation result. */
  activate?(key: string): Promise<ActivationInput>;
}

/** The form's state: the inputs of the three step views. */
export interface SignInSnapshot {
  session: SignInSession;
  deviceCode?: DeviceCodeInput;
  choices?: LicenseChoiceView;
  replaceView?: ReplaceView;
  selected?: string;
  loading?: boolean;
  activation?: ActivationInput;
  keyField?: { text: string; submitted?: boolean };
  error?: { code: string };
}

export interface SignInModelOptions {
  primitives?: SignInPrimitives;
  presentation?: SignInPresentation;
  replace?: ReplaceMode;
  channel?: SignInChannel;
  /** Everything else the views read: identity, platform, capabilities, services. */
  base?: UiInput;
  /** The UI-thread hook (UI-KITS.md §5.2). */
  deliver?: Deliver;
  schedule?: Schedule;
}

/** The three step views of the form. */
export interface SignInViews {
  signIn: View<"SignIn">;
  handoff: View<"SignInHandoff">;
  licenseChoice: View<"LicenseChoice">;
}

const GRANT_SECONDS = 300;

export class SignInModel {
  readonly store: Store<SignInSnapshot>;
  private base: UiInput;
  private readonly primitives: SignInPrimitives | undefined;
  private readonly schedule: Schedule;
  private handle: SignInSessionHandle | null = null;
  private grant: string | null = null;
  private cancelGrantTimer: (() => void) | null = null;
  /** Bumped whenever a session ends, so a late answer from an old one is dropped. */
  private epoch = 0;
  /** False for a model restored from an input with no sign-in session (Identity off). */
  private live = true;

  constructor(options: SignInModelOptions = {}) {
    this.primitives = options.primitives;
    this.base = options.base ?? {};
    this.schedule = options.schedule ?? defaultSchedule;
    this.store = createStore<SignInSnapshot>(
      {
        session: {
          presentation: options.presentation ?? "inline",
          replace: options.replace ?? "inline",
          channel: options.channel ?? "browser",
        },
      },
      { deliver: options.deliver },
    );
  }

  /** A model holding `input`'s sign-in state as it stands, with no primitives behind it: how a
   *  runner (or a test) asks what the form shows for one snapshot. */
  static restore(
    input: UiInput,
    options: Omit<SignInModelOptions, "base"> = {},
  ): SignInModel {
    const m = new SignInModel({ ...options, base: input });
    m.live = input.signIn !== undefined;
    if (input.signIn) {
      const snap: SignInSnapshot = { session: { ...input.signIn } };
      if (input.deviceCode) snap.deviceCode = input.deviceCode;
      if (input.choices) snap.choices = input.choices;
      if (input.replaceView) snap.replaceView = input.replaceView;
      if (input.selected !== undefined) snap.selected = input.selected;
      if (input.loading !== undefined) snap.loading = input.loading;
      if (input.activation) snap.activation = input.activation;
      if (input.keyField) snap.keyField = input.keyField;
      if (input.error) snap.error = input.error;
      m.store.set(snap);
    }
    return m;
  }

  /** The snapshot. */
  get snapshot(): SignInSnapshot {
    return this.store.get();
  }

  /** Called with each new snapshot (through the UI-thread hook). */
  subscribe(listener: (snapshot: SignInSnapshot) => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Change what the views read besides the form's own state (identity, platform, …). */
  setBase(base: UiInput): void {
    this.base = base;
    this.store.set((s) => ({ ...s }));
  }

  /** The views' input: the base with the form's state on top. Drops the sign-in members when
   *  Identity is off, the way the SDK reports it (no session can exist). */
  input(): UiInput {
    const s = this.store.get();
    const out: UiInput = { ...this.base, signIn: s.session };
    for (const k of [
      "deviceCode",
      "choices",
      "replaceView",
      "selected",
      "loading",
      "activation",
      "keyField",
      "error",
    ] as const) {
      const v = s[k];
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    if (
      !this.live ||
      (this.base.services && !this.base.services.includes("identity"))
    ) {
      delete out.signIn;
      delete out.deviceCode;
    }
    return out;
  }

  /** The form's three step views for the current snapshot. */
  views(): SignInViews {
    const ctx = contextOf(this.input());
    return {
      signIn: signInView(ctx),
      handoff: signInHandoffView(ctx),
      licenseChoice: licenseChoiceView(ctx),
    };
  }

  /** One step's view, by component name. */
  view(component: "SignIn" | "SignInHandoff" | "LicenseChoice"): View {
    const v = this.views();
    return component === "SignIn"
      ? v.signIn
      : component === "SignInHandoff"
        ? v.handoff
        : v.licenseChoice;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────

  private patch(
    p: Partial<SignInSnapshot>,
    session?: Partial<SignInSession>,
  ): void {
    this.store.set((s) => ({
      ...s,
      ...p,
      session: { ...s.session, ...(session ?? {}) },
    }));
  }

  private requirePrimitives(): SignInPrimitives {
    if (!this.primitives)
      throw new Error("ui-core SignInModel: no SDK primitives to drive");
    return this.primitives;
  }

  /** Step 1 → 2: start a sign-in on `channel` (Continue in browser, a provider, Use a code). */
  async start(
    options: { channel?: SignInChannel; provider?: string } = {},
  ): Promise<void> {
    const p = this.requirePrimitives();
    const channel = options.channel ?? this.store.get().session.channel;
    const presentation = this.store.get().session.presentation;
    this.endSession();
    this.live = true;
    const epoch = this.epoch;
    this.store.set((s) => ({
      session: {
        presentation: s.session.presentation,
        replace: s.session.replace,
        channel,
        ...(channel === "browser" ? { outcome: "pending" as const } : {}),
      },
      ...(channel === "device-code"
        ? { deviceCode: { phase: "starting" as const } }
        : {}),
    }));
    let handle: SignInSessionHandle;
    try {
      handle = await p.start({
        channel,
        // Device code always chooses on the card (§G.2); browser presentation leaves it there.
        licenseChoice:
          channel === "device-code" || presentation === "browser"
            ? "card"
            : "app",
        ...(options.provider ? { provider: options.provider } : {}),
      });
    } catch {
      if (epoch === this.epoch)
        this.patch(
          { error: { code: "sign-in-failed" } },
          { outcome: undefined },
        );
      return;
    }
    if (epoch !== this.epoch) return;
    this.handle = handle;
    if (channel === "device-code")
      this.patch({ deviceCode: handle.deviceCode ?? { phase: "waiting" } });
    else if (handle.browserOpened === false)
      this.patch({}, { browserOpened: false });
    void this.pump(epoch);
  }

  /** Wait on the session until it settles, applying each answer. */
  private async pump(epoch: number): Promise<void> {
    for (;;) {
      const h = this.handle;
      if (!h || epoch !== this.epoch) return;
      let r: SignInWait;
      try {
        r = await h.wait();
      } catch {
        if (epoch === this.epoch)
          this.patch({ error: { code: "sign-in-failed" } });
        return;
      }
      if (epoch !== this.epoch) return;
      switch (r.outcome) {
        case "pending":
          // The poll's phase and countdown change; the code and the address stay.
          if (r.deviceCode)
            this.patch({
              deviceCode: { ...this.store.get().deviceCode, ...r.deviceCode },
            });
          continue;
        case "choose":
          this.grant = r.grant;
          this.armGrantTimer(r.expiresIn ?? GRANT_SECONDS, epoch);
          this.patch(
            { choices: r.choices, loading: false },
            {
              outcome: "choose",
              event: undefined,
              raced: false,
              grantExpired: false,
            },
          );
          return;
        case "signedIn":
          this.finish(r.issuedNow === true);
          return;
        case "expired":
          this.patch(
            r.deviceCode
              ? {
                  deviceCode: {
                    ...this.store.get().deviceCode,
                    ...r.deviceCode,
                  },
                }
              : {},
            this.store.get().session.channel === "device-code"
              ? {}
              : { outcome: "expired" },
          );
          if (
            r.deviceCode === undefined &&
            this.store.get().session.channel === "device-code"
          )
            this.patch({ deviceCode: { phase: "expired" } });
          return;
        case "cancelled":
          this.cancelled();
          return;
      }
    }
  }

  private armGrantTimer(seconds: number, epoch: number): void {
    this.cancelGrantTimer?.();
    this.cancelGrantTimer = this.schedule(() => {
      if (epoch === this.epoch) this.patch({}, { grantExpired: true });
    }, seconds * 1000);
  }

  private finish(issuedNow: boolean): void {
    this.cancelGrantTimer?.();
    const channel = this.store.get().session.channel;
    this.patch(
      channel === "device-code" ? { deviceCode: { phase: "ok" } } : {},
      { outcome: "signedIn", issuedNow, event: undefined },
    );
  }

  private cancelled(): void {
    // Cancelling is not an error: the form goes back to step 1 with nothing else lost (DL7).
    this.endSession();
    this.store.set((s) => ({
      session: {
        presentation: s.session.presentation,
        replace: s.session.replace,
        channel:
          s.session.channel === "device-code" ? "browser" : s.session.channel,
        outcome: "cancelled",
      },
    }));
  }

  private endSession(): void {
    this.epoch++;
    this.cancelGrantTimer?.();
    this.cancelGrantTimer = null;
    this.handle = null;
    this.grant = null;
  }

  /** Open browser again: the same request, never a second one. */
  async reopen(): Promise<void> {
    const h = this.handle;
    if (!h) return;
    const opened = await h.reopen();
    this.patch({}, { event: "reopen", browserOpened: opened });
  }

  /** The opener failed and the person copied the link instead. */
  copyLink(): void {
    this.patch({}, { event: "copy-link" });
  }

  /** Use a code instead: the device-code channel, in the same form. */
  async useCode(): Promise<void> {
    await this.handle?.cancel();
    await this.start({ channel: "device-code" });
  }

  /** Cancel: back to step 1. */
  async cancel(): Promise<void> {
    const h = this.handle;
    const grant = this.grant;
    this.cancelled();
    await h?.cancel();
    if (grant) await this.primitives?.choice?.cancel(grant);
  }

  /** Start again after an expired code, link or grant. */
  async retry(): Promise<void> {
    await this.start();
  }

  /** Pick a row of the license choice (a license id, `keep` or `create`). */
  select(id: string): void {
    this.patch({ selected: id });
  }

  /** Use a license key instead: the key step, keeping the account (Must not). */
  haveKey(): void {
    this.patch({ keyField: { text: "" } }, { event: "have-key" });
  }

  /** Back from the key or Replace step to the license choice. */
  back(): void {
    this.patch(
      { replaceView: undefined, activation: undefined, keyField: undefined },
      { event: undefined, raced: false },
    );
  }

  /** Submit the key step. */
  async submitKey(key: string): Promise<void> {
    const p = this.requirePrimitives();
    if (!p.activate)
      throw new Error("ui-core SignInModel: no activate primitive");
    this.patch({
      keyField: { text: key, submitted: true },
      activation: undefined,
    });
    const result = await p.activate(key);
    if (result.result === "ok") this.finish(true);
    else this.patch({ activation: result });
  }

  /** Replace a device on a full license: the device list in place, or the card's Replace. */
  async openReplace(licenseId: string): Promise<void> {
    const s = this.store.get();
    if (s.session.replace === "browser" || !this.grant) {
      this.patch({}, { event: "open-replace" });
      return;
    }
    const p = this.requirePrimitives();
    const epoch = this.epoch;
    const view = await p.choice!.devices(this.grant, licenseId);
    if (epoch === this.epoch)
      this.patch({ replaceView: view }, { event: "open-replace" });
  }

  /** Replace and continue. */
  async confirmReplace(deviceId: string): Promise<void> {
    const s = this.store.get();
    const licenseId = s.replaceView?.licenseId;
    if (!licenseId) return;
    this.patch({}, { event: "confirm-replace" });
    await this.complete({
      kind: "license",
      licenseId,
      replaceDeviceId: deviceId,
    });
  }

  /** Continue with the selected row (or the preselected one). */
  async continue(): Promise<void> {
    const s = this.store.get();
    const pick = s.selected ?? s.choices?.preselected ?? null;
    if (!pick) return;
    await this.complete(
      pick === "keep"
        ? { kind: "keep" }
        : pick === "create"
          ? { kind: "create" }
          : { kind: "license", licenseId: pick },
    );
  }

  private async complete(choice: LicenseChoiceInput): Promise<void> {
    const p = this.requirePrimitives();
    const grant = this.grant;
    if (!grant || !p.choice) return;
    const epoch = this.epoch;
    this.patch({}, { redeeming: true });
    const r = await p.choice.complete(grant, choice);
    if (epoch !== this.epoch) return;
    this.patch({}, { redeeming: false });
    if (r.outcome === "signedIn") {
      this.finish(r.issuedNow || choice.kind === "create");
      return;
    }
    if (r.outcome === "expired") {
      this.patch({}, { grantExpired: true });
      return;
    }
    // Raced: the seat was taken since the view loaded. Re-read the view and say so.
    this.patch({}, { raced: true });
    const fresh = await p.choice.licenses(grant);
    if (epoch === this.epoch) this.patch({ choices: fresh });
  }

  /** Stop: no answer from the session is applied after this. */
  dispose(): void {
    this.endSession();
  }
}
