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
  type AutoSignInInput,
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
import { activationFromOutcome } from "./errors.js";
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

/** What `choice.complete()` answers: signed in, or a race or a lapsed grant to recover from.
 *  `choose`: the account holds licenses and none was named (the list to choose from).
 *  `deviceLimit`: every seat is taken; `view` is the fresh list when the Worker sent one. */
export type ChoiceComplete =
  | { outcome: "signedIn"; issuedNow: boolean }
  | { outcome: "raced" }
  | { outcome: "expired" }
  | { outcome: "choose"; choices: LicenseChoiceView }
  | { outcome: "deviceLimit"; view?: LicenseChoiceView; manageUrl?: string };

/** How automatic sign-in ended, in the form's terms (the SDK's result mapped by the kit). A
 *  grant is the credential: it lives in the model, never in the views' input. */
export type AutoOutcome =
  | {
      kind: "confirm";
      grant: string;
      expiresIn?: number;
      /** The claims Continue grants: the consent view's profile claims. */
      claims: readonly string[];
      /** The confirm step's input (`step` is always `confirm`). */
      input: Omit<AutoSignInInput, "step">;
    }
  | {
      kind: "choose";
      grant: string;
      expiresIn?: number;
      choices: LicenseChoiceView;
    }
  | { kind: "deviceLimit"; view?: LicenseChoiceView; manageUrl?: string }
  | { kind: "signedIn"; issuedNow?: boolean }
  /** After a redirect sign-in: offer to link the platform account (identity.link). */
  | { kind: "linkOffer"; input: Omit<AutoSignInInput, "step"> }
  /** The ladder found no account to continue with: the methods step stays. */
  | { kind: "needsSignIn" };

/** Hints that only prefill the sign-in page (WIRE-CONTRACT-V4 §12.4): they verify nothing and
 *  never make the page send a code. `purpose: "attach"` asks for the account to hold the license. */
export interface SignInHintsInput {
  loginHint?: string;
  nameHint?: string;
  purpose?: "signin" | "attach";
}

/** What `attach()` answers (identity.attach). A refusal is a result, not a throw; `code` is the
 *  server's (`account_required`, `license_owned`, `license_email_bound`, ...). The request carries
 *  no address: the server compares the license's email with the account's. */
export type AttachOutcome = { kind: "ok" } | { kind: "refused"; code: string };

/** The SDK primitives the form drives (Node first; I-10a fixes each language's spelling). */
export interface SignInPrimitives {
  start(options: {
    channel: SignInChannel;
    licenseChoice: "app" | "card";
    provider?: string;
    hints?: SignInHintsInput;
  }): Promise<SignInSessionHandle>;
  /** Put this device's license in the signed-in account (`attach({confirm: true})`). */
  attach?(): Promise<AttachOutcome>;
  choice?: {
    licenses(grant: string): Promise<LicenseChoiceView>;
    devices(grant: string, licenseId: string): Promise<ReplaceView>;
    complete(
      grant: string,
      choice: LicenseChoiceInput | undefined,
      options?: { consent?: { claims: readonly string[] } },
    ): Promise<ChoiceComplete>;
    cancel(grant: string): Promise<void>;
  };
  /** The key step: `activate(key)`, answered as the activation result. */
  activate?(key: string): Promise<ActivationInput>;
  /**
   * Automatic sign-in with the platform provider, shown its chooser (`prompt: "optional"`). The
   * person pressed the provider's button, so it also lifts a sign-out on this device. Absent: the
   * button starts the browser sign-in as before.
   */
  autoSignIn?(): Promise<AutoOutcome | null>;
  /** The link offer's two answers (identity.link). `stale`: the sign-in is too old to link (sign
   *  in again); `failed`: this device or the proof was refused (retrying cannot help); `network`:
   *  the connection (Link tries again); `none`: nothing happened (the person dismissed the
   *  provider's chooser), and the offer stays as it was. */
  link?: {
    accept(): Promise<
      "linked" | "conflict" | "stale" | "failed" | "network" | "none"
    >;
    decline(): Promise<void>;
  };
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
  /** Automatic sign-in's step (confirm), drawn in the form's body. */
  autoSignIn?: AutoSignInInput;
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

/** Cancel a session the form no longer follows; its failure is nobody's to show. */
function release(handle: SignInSessionHandle | null): void {
  if (!handle) return;
  void Promise.resolve()
    .then(() => handle.cancel())
    .catch(() => {});
}

export class SignInModel {
  readonly store: Store<SignInSnapshot>;
  private base: UiInput;
  private readonly primitives: SignInPrimitives | undefined;
  private readonly schedule: Schedule;
  private handle: SignInSessionHandle | null = null;
  private grant: string | null = null;
  /** The claims Continue grants on a confirm step. */
  private claims: readonly string[] = [];
  private cancelGrantTimer: (() => void) | null = null;
  /** Bumped whenever a session ends, so a late answer from an old one is dropped. */
  private epoch = 0;
  /** False for a model restored from an input with no sign-in session (Identity off). */
  private live = true;
  /** The device limit's `manageUrl`, kept for a Replace on a row with no link of its own. */
  private manage: string | null = null;
  /** Replace a device opened the browser; the next return runs the provider sign-in again. */
  private awaitingReturn = false;

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
      "autoSignIn",
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
    // A second start (Retry, another provider, a double click) ends the first request too.
    const previous = this.handle;
    this.endSession();
    release(previous);
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
    if (epoch !== this.epoch) {
      // The form moved on while the request started: nobody follows it now.
      release(handle);
      return;
    }
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
      channel === "device-code"
        ? { deviceCode: { phase: "ok" }, autoSignIn: undefined }
        : { autoSignIn: undefined },
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
    // The epoch moves first, so the browser session's late "cancelled" never shows.
    const previous = this.handle;
    this.endSession();
    release(previous);
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
    const epoch = this.epoch;
    let result: ActivationInput;
    try {
      result = await p.activate(key);
    } catch (e) {
      // A refusal the SDK typed is mapped (D3); any other failed call is an error under the
      // key field (DL7), never a silent stop.
      result = activationFromOutcome(e);
    }
    if (epoch !== this.epoch) return;
    // An ok result stays in the snapshot: its key entries are the toast's words.
    this.patch({ activation: result });
    if (result.result === "ok") this.finish(true);
  }

  /** Use a different key (from a refusal no key can fix): the empty field, the refusal gone. */
  differentKey(): void {
    this.patch(
      { keyField: { text: "" }, activation: undefined },
      { event: "have-key" },
    );
  }

  /** Replace a device on a full license: the device list in place, or the card's Replace. */
  async openReplace(licenseId: string): Promise<void> {
    const s = this.store.get();
    const choice = this.primitives?.choice;
    if (s.session.replace === "browser" || !this.grant || !choice) {
      // The card's Replace: the kit opens the row's freeDeviceUrl (replace-in-browser).
      this.patch({}, { event: "open-replace" });
      return;
    }
    const epoch = this.epoch;
    let view: ReplaceView;
    try {
      view = await choice.devices(this.grant, licenseId);
    } catch {
      if (epoch === this.epoch) this.patch({}, { raced: true });
      return;
    }
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

  private async complete(
    choice: LicenseChoiceInput | undefined,
    consent?: { claims: readonly string[] },
  ): Promise<void> {
    const p = this.requirePrimitives();
    const grant = this.grant;
    if (!grant || !p.choice) return;
    const epoch = this.epoch;
    this.patch({ error: undefined }, { redeeming: true });
    let r: ChoiceComplete;
    try {
      r = await p.choice.complete(
        grant,
        choice,
        consent ? { consent } : undefined,
      );
    } catch {
      if (epoch === this.epoch)
        // The confirm stays, its grant is still good: the failure reads as a network one under
        // Continue, which retries. Elsewhere the methods step shows the sign-in failure.
        this.patch(
          { error: { code: consent ? "network" : "sign-in-failed" } },
          { redeeming: false },
        );
      return;
    }
    if (epoch !== this.epoch) return;
    this.patch({ error: undefined }, { redeeming: false });
    if (r.outcome === "signedIn") {
      this.finish(r.issuedNow || choice?.kind === "create");
      return;
    }
    if (r.outcome === "expired") {
      this.patch({}, { grantExpired: true });
      // The confirm has no "try again" step: it asks the provider for a fresh grant itself.
      if (consent) await this.renew();
      return;
    }
    if (r.outcome === "choose") {
      // The person consented and the account holds licenses: choose one (the list is fresh).
      this.patch(
        { choices: r.choices, loading: false, autoSignIn: undefined },
        { outcome: "choose", event: undefined, raced: false },
      );
      return;
    }
    if (r.outcome === "deviceLimit") {
      this.showDeviceLimit(r.view, r.manageUrl);
      return;
    }
    // Raced: the seat was taken since the view loaded. Re-read the view and say so.
    this.patch({}, { raced: true });
    try {
      const fresh = await p.choice.licenses(grant);
      if (epoch === this.epoch) this.patch({ choices: fresh });
    } catch {
      // The race message stays over the last list; Continue tries again.
    }
  }

  // ── Automatic sign-in ───────────────────────────────────────────────────────────────────────

  /** Show how automatic sign-in ended: the confirm step, the license list, the device limit, or
   *  (signed in) the end of the form. `needsSignIn` leaves the methods step as it is. */
  presentAuto(o: AutoOutcome): void {
    this.live = true;
    switch (o.kind) {
      case "confirm":
        this.grant = o.grant;
        this.claims = o.claims;
        this.armGrantTimer(o.expiresIn ?? GRANT_SECONDS, this.epoch);
        this.patch(
          { autoSignIn: { ...o.input, step: "confirm" } },
          { outcome: undefined, event: undefined, grantExpired: false },
        );
        return;
      case "choose":
        this.grant = o.grant;
        this.armGrantTimer(o.expiresIn ?? GRANT_SECONDS, this.epoch);
        this.patch(
          { choices: o.choices, loading: false, autoSignIn: undefined },
          {
            outcome: "choose",
            event: undefined,
            raced: false,
            grantExpired: false,
          },
        );
        return;
      case "deviceLimit":
        this.showDeviceLimit(o.view, o.manageUrl);
        return;
      case "signedIn":
        this.finish(o.issuedNow === true);
        return;
      case "linkOffer":
        this.patch(
          { autoSignIn: { ...o.input, step: "link-offer" } },
          { outcome: undefined, event: undefined, grantExpired: false },
        );
        return;
      case "needsSignIn":
        return;
    }
  }

  /** Link on the offer step: one request (the handle, or one provider prompt), then Done or the
   *  conflict. The offer stays, with its network line, when the answer is not one of those. */
  async linkAccept(): Promise<void> {
    const link = this.primitives?.link;
    const auto = this.store.get().autoSignIn;
    if (!link || auto?.step !== "link-offer") return;
    if (this.store.get().session.redeeming) return;
    const epoch = this.epoch;
    this.patch({ error: undefined }, { redeeming: true });
    let r: Awaited<ReturnType<typeof link.accept>>;
    try {
      r = await link.accept();
    } catch {
      r = "network";
    }
    if (epoch !== this.epoch) return;
    this.patch({}, { redeeming: false });
    if (r === "linked" || r === "conflict")
      this.patch({
        error: undefined,
        autoSignIn: {
          ...auto,
          step: r === "linked" ? "link-done" : "link-conflict",
        },
      });
    else if (r !== "none")
      this.patch({
        error: {
          code:
            r === "stale"
              ? "link-stale"
              : r === "failed"
                ? "link-failed"
                : "network",
        },
      });
  }

  /** No thanks: remembered on this device, so the offer is not made again for this account. */
  async linkDecline(): Promise<void> {
    // Link is in flight: a decline now could be stored beside a link that goes through.
    if (this.store.get().session.redeeming) return;
    await this.primitives?.link?.decline().catch(() => undefined);
    this.patch({ autoSignIn: undefined, error: undefined });
  }

  /** Every seat is taken. With the list, the license step opens with the card's Replace (there
   *  is no grant to replace with here); without it, the device-limit step of the form (never the
   *  key screen): the words, Replace a device (the refusal's `manageUrl`), Use another account. */
  private showDeviceLimit(
    view: LicenseChoiceView | undefined,
    manageUrl: string | undefined,
  ): void {
    this.grant = null;
    this.manage = manageUrl ?? null;
    if (view) {
      this.patch(
        { choices: view, loading: false, autoSignIn: undefined },
        {
          outcome: "choose",
          replace: "browser",
          event: undefined,
          raced: false,
        },
      );
      return;
    }
    this.patch(
      {
        autoSignIn: {
          step: "device-limit",
          ...(manageUrl ? { manageUrl } : {}),
        },
        activation: undefined,
        keyField: undefined,
        choices: undefined,
        loading: false,
      },
      {
        outcome: undefined,
        event: undefined,
        raced: false,
        grantExpired: false,
      },
    );
  }

  /** The refusal's `manageUrl` of the device limit last shown: where a device is replaced when a
   *  row has no link of its own. */
  get manageUrl(): string | null {
    return this.manage;
  }

  /** The kit opened the browser to replace a device: when the person comes back (`returned()`),
   *  the provider sign-in runs once more. */
  leftToReplace(): void {
    this.awaitingReturn = true;
  }

  /** The person is back from the browser. After a Replace it runs the provider sign-in once
   *  more, so they do not start again by hand (a no-op otherwise, and only once per Replace). */
  async returned(): Promise<void> {
    if (!this.awaitingReturn) return;
    this.awaitingReturn = false;
    await this.signInWithProvider(undefined, true);
  }

  /** Continue on the confirm step: the person consents to what it listed. */
  async confirm(): Promise<void> {
    if (this.store.get().session.redeeming) return;
    if (this.store.get().session.grantExpired) return this.renew();
    await this.complete(undefined, { claims: this.claims });
  }

  /** The confirm's grant ran out: the provider's ladder runs again for a fresh one, with the
   *  step's busy state meanwhile. A provider with no account to offer leaves the methods step. */
  private async renew(): Promise<void> {
    const epoch = this.epoch;
    this.patch({ error: undefined }, { redeeming: true });
    try {
      await this.signInWithProvider(undefined, true);
    } finally {
      if (epoch === this.epoch) this.patch({}, { redeeming: false });
    }
  }

  /** Use another account: the confirm's grant is given up and the methods step shows. */
  async useAnother(): Promise<void> {
    const grant = this.grant;
    this.endSession();
    this.store.set((s) => ({
      session: {
        presentation: s.session.presentation,
        replace: s.session.replace,
        channel: s.session.channel,
      },
    }));
    if (grant) await this.primitives?.choice?.cancel(grant).catch(() => {});
  }

  /** Back to the methods step, nothing else kept (the confirm's grant, if any, is given up). */
  private async toMethods(): Promise<void> {
    await this.useAnother();
  }

  /** The provider's button: the platform provider with its chooser, then what the ladder found.
   *  Where there is none (or it found no account), the browser sign-in starts as before. */
  async signInWithProvider(
    provider?: string,
    noAccountShowsMethods = false,
  ): Promise<void> {
    const p = this.requirePrimitives();
    // A return from the browser (or a renewed grant) is not the person's press: with no account
    // found it lands on the methods step instead of opening the hosted sign-in by itself.
    const browser = (): Promise<void> | void =>
      noAccountShowsMethods
        ? this.toMethods()
        : this.start({ channel: "browser", ...(provider ? { provider } : {}) });
    if (!p.autoSignIn) return browser();
    const epoch = this.epoch;
    let o: AutoOutcome | null;
    try {
      o = await p.autoSignIn();
    } catch {
      o = null;
    }
    if (epoch !== this.epoch) return;
    if (o === null || o.kind === "needsSignIn") return browser();
    this.presentAuto(o);
  }

  /**
   * Stop following the session: no answer is applied after this, and that is all. The request
   * and any license-choice grant stay open on the server, so a binding that re-mounts (React's
   * StrictMode, a Lit element moved in the DOM) can follow the same sign-in again with a new
   * model. Call it when a view unmounts. To end the sign-in itself (the person cancelled, or the
   * host closes the form for good), call `cancel()`, which cancels the request and the grant.
   */
  dispose(): void {
    this.endSession();
  }
}
