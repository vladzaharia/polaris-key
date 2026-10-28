// The one sign-in form (SIGN-IN.md §3.17, UI-KITS.md §1.3): `<pk-sign-in>` owns every in-app step
// and morphs its body in place (methods → handoff | code → finishing → choose ↔ replace | key →
// done). The step elements draw one step each, for an app that lays out its own form:
// `<pk-sign-in-methods>`, `<pk-replace-device>` and `<pk-sign-in-done>`, beside the existing
// `<pk-sign-in-handoff>`, `<pk-license-choice>` and `<pk-activate>`.
//
// Inputs: the host's `input` (a snapshot, the fixtures' way), or `primitives` (the SDK's sign-in
// primitives, plans/I-04.md §G.9), which the form drives through ui-core's `SignInModel` from its
// own controls. `presentation="inline|sheet|browser"` and `replace="inline|browser"` are the same
// option in every kit (D-79); `sheet` puts the form in a modal `<dialog>` over the scrim (DL2).
//
// Motion (SIGN-IN.md §3.18): the card's height morphs between steps and the new body enters from
// the side of travel, through the Web Animations API (CSP-safe: no style attribute, no injected
// sheet). Reduced motion, or `theme.motion: "none"`, swaps instantly. Focus follows the morph to
// the new step's h1.

import { html, nothing, type PropertyValues } from "lit";
import {
  SignInModel,
  type AutoOutcome,
  type SignInPrimitives,
  type View,
} from "@polaris-key/ui-core";
import { openLink, openManage, safeLink } from "@polaris-key/ui-core/browser";
import { JOIN_ACCOUNTS_URL } from "@polaris-key/ui-core/browser/sdk/linkOffer.js";

import { PkElement } from "./element.js";
import { GLYPHS, text, type RenderCtx } from "./render.js";
import { renderView } from "./views.js";
import { FORM_ORDER, formStep, type FormInput, type FormStep } from "./form.js";

export { formStep, type FormInput, type FormStep } from "./form.js";

/** The last pointer target outside any shadow tree: a sheet's opener when focus never moved. */
let lastPointer: EventTarget | null = null;
if (typeof document !== "undefined")
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = e.composedPath()[0] ?? null;
    },
    true,
  );

const reduced = (el: PkElement): boolean =>
  el.resolved.theme.motion !== "full" ||
  (typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches);

/** The existing-license line's words, from the kit's own copy: the term as the license rows say
 *  it, and this device by its platform. The model supplies the license and the seat. */
function confirmWords(view: View, c: RenderCtx): View {
  const anchor = c.input.autoSignIn?.anchor;
  if (view.state !== "confirm" || !anchor) return view;
  const lifetime = anchor.term === "perpetual";
  const key = lifetime ? "signin.term.lifetime" : "signin.term.until";
  const date = lifetime
    ? ""
    : new Date((anchor.term as number) * 1000).toLocaleDateString(
        c.copy.locale,
      );
  return {
    ...view,
    args: {
      ...view.args,
      term: c.copy.has(key) ? c.copy.format(key, { date }) : "",
      // The line reads on after a separator: the lower-case phrase ("this Mac"), never the
      // capitalised one.
      device:
        view.args.device ??
        (c.copy.has("part.thisDevice")
          ? c.copy.format("part.thisDevice", {
              formFactor: c.input.platform?.formFactor ?? "other",
            })
          : "this device"),
    },
  };
}

/**
 * `<pk-sign-in>`: the one sign-in form. With `primitives` it runs the sign-in itself; with only
 * `input` it draws the snapshot it is given and reports every control as `pk-action`.
 */
export class PkSignIn extends PkElement {
  readonly component = "SignIn" as const;

  static override properties = {
    ...PkElement.properties,
    presentation: { reflect: true },
    replace: { reflect: true },
    open: { type: Boolean, reflect: true },
    primitives: { attribute: false },
    seed: { attribute: false },
    embedded: { type: Boolean, reflect: true },
  };

  /** Where the form lives (D-79): in the page, in a modal sheet, or on the hosted card. */
  presentation?: "inline" | "sheet" | "browser";
  /** Where Replace a device runs: in the form, or on the card. */
  replace?: "inline" | "browser";
  /** `sheet` only: the dialog is open. */
  open = false;
  /** The SDK's sign-in primitives (plans/I-04.md §G.9); the form drives them itself. */
  primitives?: SignInPrimitives;
  /** What automatic sign-in found, shown first (a confirm, the license list, the device limit). */
  seed?: AutoOutcome;
  /** The gate's own in-app form: Cancel on the methods step, and Done, leave it (`pk-close`). */
  embedded = false;

  private formModel: SignInModel | null = null;
  private stopForm: (() => void) | null = null;
  private replacePick: string | undefined;
  /** The tier of the license the person chose, for the Done line ("Pro license"). */
  private pickedTier: string | undefined;
  private doneSent = false;
  private opener: HTMLElement | null = null;
  private pushed = false;
  private lastStep: string | null = null;
  private morphFrom: { height: number; index: number } | null = null;
  /** The code step's countdown: the seconds the code had when first seen, and when. */
  private countFrom: { left: number; at: number } | null = null;
  private countTimer: ReturnType<typeof setInterval> | null = null;
  /** The toast an existing license leaves behind when its sheet closes: the line's key, and who. */
  private toast: { key: string; args: Record<string, string> } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    // Live: the form's own controls drive the model (the host still hears every pk-action).
    this.addEventListener("pk-action", (e) => {
      if (this.formModel) void this.drive((e as CustomEvent).detail);
    });
    this.addEventListener("pk-input", (e) => {
      const d = (e as CustomEvent<{ field: string; value: string }>).detail;
      if (this.formModel && d.field === "key")
        this.formModel.store.set((s) => ({
          ...s,
          keyField: { text: d.value },
        }));
    });
  }

  /** One control of the form, applied to the live model (plans/I-04.md §G.9's primitives). */
  private async drive(d: {
    key: string;
    deviceId?: string;
    [k: string]: unknown;
  }): Promise<void> {
    const m = this.formModel!;
    const s = m.snapshot;
    switch (d.key) {
      case "signin.provider.continue":
        // The provider's account chooser first, then what the ladder found (this press lifts a
        // sign-out); without a platform provider it starts the browser sign-in.
        return m.signInWithProvider();
      case "signin.auto.confirm.primary":
        return m.confirm();
      case "signin.auto.confirm.other":
        return m.useAnother();
      case "signin.linkOffer.primary":
        return m.linkAccept();
      case "signin.linkOffer.decline":
        return m.linkDecline().then(() => this.endLink());
      case "signin.linkOffer.join":
        openLink(JOIN_ACCOUNTS_URL);
        return;
      case "common.done":
        // The link offer's conflict ends the form (its done closes with a toast).
        if (
          s.autoSignIn?.step === "link-done" ||
          s.autoSignIn?.step === "link-conflict"
        )
          return this.endLink();
        return;
      case "signin.desktop.continue":
      case "signin.email.continue":
      case "signin.passkey":
        return m.start({ channel: "browser" });
      case "signin.link.deviceCode":
      case "signin.handoff.useCode":
        return m.useCode();
      case "signin.handoff.again":
      case "signin.handoff.openBrowser":
        return m.reopen();
      case "signin.handoff.copyLink":
        return m.copyLink();
      case "signin.again":
        // On the link offer: Sign in again, the regular sign-in.
        if (s.autoSignIn?.step === "link-offer")
          return m.start({ channel: "browser" });
        return m.retry();
      case "signInHandoff.newCode":
        return m.retry();
      case "common.cancel":
        // In a sheet, Cancel leaves it (and drops a sign-in in flight); in the page it backs out.
        if (this.sheet) return this.close();
        // An automatic sign-in's step (the confirm, the device limit) leaves the form for the
        // gate's Welcome, Escape included; so does Cancel on the methods step in the gate.
        if (
          s.autoSignIn ||
          (this.embedded &&
            (this.step.form.state === "methods" ||
              s.session.outcome === "choose"))
        )
          return this.leave();
        return m.cancel();
      case "signin.choice.continue": {
        // Pressed once: a second press while the license is redeemed does nothing.
        if (s.session.redeeming) return;
        const id = s.selected ?? s.choices?.preselected ?? null;
        this.pickedTier = this.tierOf(id);
        return m.continue();
      }
      case "signin.choice.keyInstead":
        return m.haveKey();
      case "activate.submit":
        return m.submitKey(s.keyField?.text ?? "");
      case "signin.deviceLimit.replace": {
        // The device limit with no license rows: the refusal's link, then back to the provider
        // sign-in once the person returns (`returned()`).
        const url = s.autoSignIn?.manageUrl ?? m.manageUrl;
        if (url) {
          m.leftToReplace();
          openManage(url, window.location.href);
        }
        return;
      }
      case "signin.replace.open":
      case "signin.replace.openSystem": {
        // A full license names itself; else the pick, the preselected, or the only full one.
        const full = (s.choices?.choices ?? []).filter(
          (r) => r.state !== "free",
        );
        const id =
          (typeof d.licenseId === "string" ? d.licenseId : undefined) ??
          s.selected ??
          s.choices?.preselected ??
          (full.length === 1 ? full[0]!.id : undefined);
        if (!id) return undefined;
        // Replace runs in the browser (no grant to replace with here): the row's own link, else
        // the refusal's, and the provider sign-in runs again on return.
        if (s.session.replace === "browser") {
          const url =
            safeLink(
              s.choices?.choices.find((r) => r.id === id)?.freeDeviceUrl,
            ) ?? m.manageUrl;
          if (url) {
            m.leftToReplace();
            openManage(url, window.location.href);
          }
        }
        const opened = m.openReplace(id);
        // In the browser the row redraws with its new-window glyph: the pressed button keeps focus.
        if (this.formModel?.snapshot.session.replace === "browser")
          void this.updateComplete.then(() => this.refocusRowReplace(id));
        return opened;
      }
      case "signin.replace.confirm": {
        if (s.session.redeeming) return;
        this.pickedTier = this.tierOf(s.replaceView?.licenseId ?? null);
        return d.deviceId ? m.confirmReplace(d.deviceId) : undefined;
      }
      case "signin.replace.back":
        this.replacePick = undefined;
        return m.back();
      case "signin.done.start":
        this.finish();
        if (this.sheet) this.close();
        else if (this.embedded) this.leave();
        return;
    }
  }

  /** The row's Replace button after a redraw of its row (focus fell to the page). */
  private refocusRowReplace(id: string | undefined): void {
    const root = this.renderRoot as ShadowRoot;
    if (root.activeElement) return;
    const rows = [
      ...root.querySelectorAll<HTMLElement>('[data-part="license-row"]'),
    ];
    const row = rows.find((r) => r.dataset.id === id) ?? rows[0];
    row
      ?.querySelector<HTMLElement>('[data-key="signin.replace.open"]')
      ?.focus({ preventScroll: true });
  }

  private tierOf(id: string | null): string | undefined {
    const s = this.formModel?.snapshot;
    if (!id || !s) return undefined;
    if (id === "create" || id === "new") return s.choices?.create?.tierName;
    return s.choices?.choices.find((r) => r.id === id)?.tierName;
  }

  /** The host hears the sign-in finished, once per sign-in (it can finish its own task). */
  private finish(): void {
    if (this.doneSent) return;
    this.doneSent = true;
    this.dispatchEvent(
      new CustomEvent("pk-done", { bubbles: true, composed: true }),
    );
  }

  /** The link offer is answered: a sheet closes, the gate's own form hands back. */
  private endLink(): void {
    if (this.sheet) this.close();
    else this.leave();
  }

  /** The gate's own form is done with: the host (the gate) draws its Welcome again. */
  private leave(): void {
    this.dispatchEvent(
      new CustomEvent("pk-close", { bubbles: true, composed: true }),
    );
  }

  /** Back from the browser after Replace a device: the model runs the provider sign-in again. */
  private back = (): void => {
    if (document.visibilityState !== "hidden") void this.formModel?.returned();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.back);
    document.addEventListener("visibilitychange", this.back);
  }

  /** The live form model (ui-core `SignInModel`), once `primitives` are set. */
  get signIn(): SignInModel | null {
    return this.formModel;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.back);
    document.removeEventListener("visibilitychange", this.back);
    this.stopForm?.();
    this.stopForm = null;
    if (this.countTimer !== null) clearInterval(this.countTimer);
    this.countTimer = null;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    // Stop following; the sign-in itself stays open on the server (SignInModel.dispose()).
    this.formModel?.dispose();
    this.formModel = null;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (
      changed.has("primitives") ||
      changed.has("seed") ||
      (this.primitives && !this.formModel)
    )
      this.restartForm();
    else if (this.formModel && changed.has("input"))
      this.formModel.setBase(this.input ?? {});
    super.willUpdate(changed);
  }

  private restartForm(): void {
    this.stopForm?.();
    this.formModel?.dispose();
    this.formModel = null;
    if (!this.primitives) return;
    this.formModel = new SignInModel({
      primitives: this.primitives,
      presentation: this.presentation ?? "inline",
      replace: this.replace ?? "inline",
      base: this.input ?? {},
    });
    if (this.seed) this.formModel.presentAuto(this.seed);
    this.stopForm = this.formModel.subscribe(() => this.requestUpdate());
  }

  protected override baseInput(): FormInput {
    const base: FormInput = this.formModel
      ? { ...(this.input ?? {}), ...this.formModel.input() }
      : { ...(this.input ?? {}) };
    if (!this.formModel && base.signIn && (this.presentation || this.replace))
      base.signIn = {
        ...base.signIn,
        ...(this.presentation ? { presentation: this.presentation } : {}),
        ...(this.replace ? { replace: this.replace } : {}),
      };
    if (this.replacePick !== undefined) base.replacePick = this.replacePick;
    // The code step counts down on its own (at 0:00 the view goes to expired, DL14).
    const dc = base.deviceCode;
    if (dc?.secondsLeft !== undefined && dc.phase === "waiting") {
      if (this.countFrom === null || this.countFrom.left !== dc.secondsLeft)
        this.countFrom = { left: dc.secondsLeft, at: Date.now() };
      const secondsLeft = Math.max(
        0,
        Math.ceil(
          this.countFrom.left - (Date.now() - this.countFrom.at) / 1000,
        ),
      );
      base.deviceCode = { ...dc, secondsLeft };
    } else this.countFrom = null;
    // The Done line names the license that was chosen, and the holder the host gave.
    if (base.signIn?.outcome === "signedIn" && this.pickedTier)
      base.account = {
        signedIn: true,
        ...(base.account ?? {}),
        tier: base.account?.tier ?? this.pickedTier,
      };
    return base;
  }

  /** True when the form lives in the modal sheet: the attribute, else the input's session. */
  get sheet(): boolean {
    return (
      (this.presentation ?? this.baseInput().signIn?.presentation) === "sheet"
    );
  }

  protected override isSheet(): boolean {
    return this.sheet;
  }

  /** The step drawn now. */
  get step(): FormStep {
    return formStep(this.modelInput());
  }

  protected override actionDetail(key: string): Record<string, unknown> {
    const input = this.modelInput() as FormInput;
    if (key === "signin.replace.confirm") {
      const devices = input.replaceView?.devices ?? [];
      const pick =
        devices.find((d) => d.id === input.replacePick) ??
        devices.find((d) => d.leastRecent) ??
        devices[0];
      return pick ? { deviceId: pick.id } : {};
    }
    if (key === "signin.choice.continue") {
      const id = input.selected ?? input.choices?.preselected ?? null;
      return id ? { licenseId: id } : {};
    }
    return {};
  }

  protected override pickRow(id: string): void {
    if (this.step.body.state === "replace-open") {
      this.replacePick = id;
      this.dispatchEvent(
        new CustomEvent("pk-select", {
          detail: { id, kind: "device" },
          bubbles: true,
          composed: true,
        }),
      );
      this.requestUpdate();
      return;
    }
    this.formModel?.select(id);
    super.pickRow(id);
  }

  protected override renderBody(c: RenderCtx): unknown {
    const step = formStep(c.input);
    const body = renderView({
      ...c,
      view: confirmWords(step.body, c),
      form: true,
    });
    const announce = step.announce.length
      ? html`<p class="visually-hidden" role="status">
          ${step.announce.map(
            (k) => html`<span data-key=${k}>${text(c, k)}</span>`,
          )}
        </p>`
      : nothing;
    if (this.sheet !== true) return html`${announce}${body}`;
    const toast = this.toast;
    return html`${toast
        ? html`<div
            class="toast pk-flash"
            role="status"
            part="toast"
            data-part="toast"
            data-key=${toast.key}
            data-status="success"
          >
            ${GLYPHS.success()}
            <span class="texts"
              ><span>${text(c, toast.key, toast.args)}</span></span
            >
          </div>`
        : nothing}
      <dialog
        class="sheet"
        part="sheet"
        data-part="sheet"
        aria-labelledby="pk-title"
        @cancel=${this.onDialogCancel}
        @close=${this.onDialogClose}
        @click=${(e: MouseEvent) => {
          // A click on the scrim lands on the dialog itself: it backs out like Escape.
          if (e.target === e.currentTarget) this.close();
        }}
      >
        <button
          type="button"
          class="sheet-close"
          data-part="close"
          aria-label=${c.copy.has("common.close")
            ? c.copy.format("common.close", {})
            : "Close"}
          @click=${() => this.close()}
        >
          ${GLYPHS.close()}
        </button>
        ${announce}${body}
      </dialog>`;
  }

  private onDialogCancel = (e: Event): void => {
    // Escape backs out (DL2): the form cancels its sign-in and the sheet closes.
    e.preventDefault();
    this.close();
  };

  private onDialogClose = (): void => {
    if (this.open) {
      this.open = false;
      this.dispatchEvent(
        new CustomEvent("pk-close", { bubbles: true, composed: true }),
      );
    }
  };

  /** `sheet`: open the dialog (the opener gets focus back when it closes). */
  show(): void {
    // Safari does not focus a button on click: the opener is the last pointer target then.
    const active = (this.getRootNode() as Document | ShadowRoot).activeElement;
    this.opener =
      (document.activeElement && document.activeElement !== document.body
        ? (document.activeElement as HTMLElement)
        : null) ??
      (active as HTMLElement | null) ??
      (lastPointer as HTMLElement | null);
    this.open = true;
  }

  /** `sheet`: close the dialog and cancel a sign-in in flight. */
  close(): void {
    // Idempotent: a host that calls close() inside its pk-close handler must not re-enter.
    if (!this.open) return;
    if (this.formModel && this.formModel.snapshot.session.outcome !== undefined)
      void this.formModel.cancel();
    this.open = false;
    // `toast`: a line stays on after the sheet, so the host keeps this element mounted for it.
    const toast = this.toast !== null;
    this.dispatchEvent(
      new CustomEvent("pk-close", {
        bubbles: true,
        composed: true,
        detail: { toast },
      }),
    );
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const o = this.opener;
    this.opener = null;
    if (o?.isConnected) queueMicrotask(() => o.focus({ preventScroll: true }));
    if (this.pushed) {
      this.pushed = false;
      if (history.state?.pkSheet) history.back();
    }
  }

  private onPop = (): void => {
    // Back on a phone closes the sheet (there is no Escape key there).
    this.pushed = false;
    if (this.open) this.close();
  };

  protected override update(changed: PropertyValues): void {
    // Measure the card before the body changes, for the height morph (§3.18 morph).
    const step = this.step;
    const key = `${step.body.component}.${step.body.state}`;
    if (this.lastStep !== null && key !== this.lastStep && this.hasUpdated) {
      const card = this.renderRoot.querySelector<HTMLElement>(".card");
      const index = FORM_ORDER.indexOf(this.view.state);
      this.morphFrom = card
        ? { height: card.getBoundingClientRect().height, index }
        : null;
    }
    super.update(changed);
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const step = this.step;
    const key = `${step.body.component}.${step.body.state}`;
    const from = this.morphFrom;
    this.morphFrom = null;
    const moved = this.lastStep !== null && key !== this.lastStep;
    // The gate opened straight on the license list (automatic sign-in): the step's h1 takes
    // focus, as the confirm's and the device limit's do (the list has no radio to take it).
    if (
      this.lastStep === null &&
      this.embedded &&
      step.body.component === "LicenseChoice"
    )
      (this.renderRoot as ShadowRoot)
        .querySelector<HTMLElement>("h1")
        ?.focus({ preventScroll: true });
    this.lastStep = key;
    const out = this.baseInput().signIn?.outcome;
    // The sign-in finished: the host hears it once, and the person gets Done (their way out).
    if (out === "signedIn") {
      this.finish();
      // An existing license opens the app with a toast: its sheet closes by itself; a new one
      // ends on Done.
      if (this.sheet && this.open && !this.baseInput().signIn?.issuedNow)
        this.closeWithToast();
    } else this.doneSent = false;
    // A linked account closes the sheet with the toast, not a second tap.
    if (
      this.formModel &&
      this.sheet &&
      this.open &&
      this.baseInput().autoSignIn?.step === "link-done"
    )
      this.closeWithToast({
        key: "signin.linkOffer.done",
        args: { provider: this.baseInput().provider ?? "Google" },
      });
    this.syncDialog();
    if (this.countFrom !== null && this.countTimer === null)
      this.countTimer = setInterval(() => this.requestUpdate(), 1000);
    else if (this.countFrom === null && this.countTimer !== null) {
      clearInterval(this.countTimer);
      this.countTimer = null;
    }
    if (moved) this.morph(from);
  }

  /** Close the sheet and say who signed in, for a few seconds, in the page. */
  private closeWithToast(line?: {
    key: string;
    args: Record<string, string>;
  }): void {
    const input = this.baseInput();
    const holder = input.account?.holder?.trim();
    const tier = input.account?.tier ?? this.pickedTier;
    this.toast =
      line ??
      (holder && tier
        ? { key: "signin.desktop.toast", args: { name: holder, tier } }
        : { key: "signin.return.signedInShort", args: {} });
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastTimer = null;
      this.requestUpdate();
    }, 6000);
    this.close();
  }

  private syncDialog(): void {
    const dialog =
      this.renderRoot.querySelector<HTMLDialogElement>("dialog.sheet");
    if (!dialog) return;
    if (this.open && !dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
      // Focus the heading, not the close button, so the first thing read is the step.
      this.renderRoot
        .querySelector<HTMLElement>("h1")
        ?.focus({ preventScroll: true });
      if (!this.pushed && typeof history !== "undefined") {
        history.pushState({ pkSheet: true }, "");
        this.pushed = true;
        window.addEventListener("popstate", this.onPop, { once: true });
      }
    } else if (!this.open && dialog.open) dialog.close();
  }

  /** The step morph: the card's height from the old step's to the new, the body entering from
   *  the side of travel; focus to the new h1 when it lands (at once under reduced motion). */
  private morph(from: { height: number; index: number } | null): void {
    const root = this.renderRoot as ShadowRoot;
    const card = root.querySelector<HTMLElement>(".card");
    const h1 = root.querySelector<HTMLElement>("h1");
    const focusHeading = () => {
      if (this.matches(":focus-within") || this.open)
        h1?.focus({ preventScroll: true });
    };
    if (!card || !from || reduced(this) || typeof card.animate !== "function") {
      focusHeading();
      return;
    }
    const forward = FORM_ORDER.indexOf(this.view.state) >= from.index;
    const to = card.getBoundingClientRect().height;
    const css = getComputedStyle(card);
    const ms = (name: string, fallback: number) =>
      Number.parseFloat(css.getPropertyValue(name)) || fallback;
    const moderate = ms("--pk-duration-moderate", 260);
    const base = ms("--pk-duration-base", 200);
    const micro = ms("--pk-duration-micro", 80);
    const standard =
      css.getPropertyValue("--pk-ease-standard").trim() || "ease-out";
    const enter = css.getPropertyValue("--pk-ease-enter").trim() || "ease-out";
    const distance = css.getPropertyValue("--pk-motion-distance-lg").trim();
    const shift = distance || "12px";
    const rtl = getComputedStyle(this).direction === "rtl";
    // Forward enters from the inline end, Back from the inline start (mirrored in RTL).
    const sign = (forward ? 1 : -1) * (rtl ? -1 : 1);
    if (Math.abs(to - from.height) > 1)
      card.animate(
        [{ blockSize: `${from.height}px` }, { blockSize: `${to}px` }],
        { duration: moderate, easing: standard },
      );
    const parts = [...card.children].filter(
      (n) => !n.classList.contains("split") && !n.classList.contains("shimmer"),
    );
    let last: Animation | null = null;
    for (const n of parts)
      last = n.animate(
        [
          {
            opacity: 0,
            translate: `calc(${sign} * ${shift}) 0`,
          },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: base, delay: micro, easing: enter, fill: "backwards" },
      );
    if (last) void last.finished.then(focusHeading, focusHeading);
    else focusHeading();
  }
}

/** A step of the form as its own element: draws the form's body only in its steps. */
function stepClass(steps: readonly string[]): typeof PkSignIn {
  return class extends PkSignIn {
    protected override renderBody(c: RenderCtx): unknown {
      return steps.includes(this.view.state) ? super.renderBody(c) : nothing;
    }
  } as unknown as typeof PkSignIn;
}

/** The step elements (layer b of the form, UI-KITS.md §1.3), by tag. */
export const STEP_ELEMENTS: Readonly<Record<string, typeof PkSignIn>> = {
  "pk-sign-in-methods": stepClass(["methods", "error"]),
  "pk-replace-device": stepClass(["replace"]),
  "pk-sign-in-done": stepClass(["done"]),
};
