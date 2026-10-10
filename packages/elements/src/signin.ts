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
  viewOf,
  type SignInPrimitives,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

import { PkElement } from "./element.js";
import { text, type RenderCtx } from "./render.js";
import { renderView } from "./views.js";

/** The form's input: ui-core's, plus the device picked in the Replace step (kit-side). */
export type FormInput = UiInput & { replacePick?: string };

/** The step the form's body draws for one snapshot, and the order of travel. */
export interface FormStep {
  /** The form's own view (SignIn): its state names the step. */
  form: View;
  /** The view whose body the card draws: SignIn's, or the step part's (handoff, license choice). */
  body: View;
  /** Keys the form announces without drawing (a desktop notification's words). */
  announce: string[];
}

/** Steps in order of travel: a step later in the list is forward (enters from the inline end). */
const ORDER = [
  "methods",
  "error",
  "handoff",
  "code",
  "expired",
  "finishing",
  "choose",
  "key",
  "replace",
  "done",
];

/** Merge the form's own keys into the step part's view (one title, one set of controls). */
function merged(form: View, part: View, extra: string[] = []): View {
  const copy = [
    ...extra,
    ...form.copy.filter(
      (k) => k !== "signin.desktop.notifyChoose" && !part.copy.includes(k),
    ),
    ...part.copy,
  ].filter((k, i, all) => all.indexOf(k) === i);
  return { ...part, copy };
}

/** The step the form shows for `input`. */
export function formStep(input: UiInput): FormStep {
  const form = viewOf("SignIn", input);
  const announce = form.copy.filter((k) => k === "signin.desktop.notifyChoose");
  switch (form.state) {
    case "code":
      // Step 2 by code: the handoff part draws the code view in the form's body.
      return { form, body: viewOf("SignInHandoff", input), announce };
    case "choose":
      return {
        form,
        body: merged(form, viewOf("LicenseChoice", input)),
        announce,
      };
    case "replace":
      // Step 3b: the license list morphs into the devices, under "Replace a device" (§3.7).
      return {
        form,
        body: merged(form, viewOf("LicenseChoice", input), [
          "deviceLimit.title",
        ]),
        announce,
      };
    default:
      return { form, body: form, announce };
  }
}

const reduced = (el: PkElement): boolean =>
  el.resolved.theme.motion !== "full" ||
  (typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches);

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
  };

  /** Where the form lives (D-79): in the page, in a modal sheet, or on the hosted card. */
  presentation?: "inline" | "sheet" | "browser";
  /** Where Replace a device runs: in the form, or on the card. */
  replace?: "inline" | "browser";
  /** `sheet` only: the dialog is open. */
  open = false;
  /** The SDK's sign-in primitives (plans/I-04.md §G.9); the form drives them itself. */
  primitives?: SignInPrimitives;

  private formModel: SignInModel | null = null;
  private stopForm: (() => void) | null = null;
  private replacePick: string | undefined;
  private lastStep: string | null = null;
  private morphFrom: { height: number; index: number } | null = null;

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
      case "signin.desktop.continue":
      case "signin.provider.continue":
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
      case "signInHandoff.newCode":
        return m.retry();
      case "common.cancel":
        if (s.session.outcome === undefined && this.sheet) return this.close();
        return m.cancel();
      case "signin.choice.continue":
        return m.continue();
      case "signin.choice.keyInstead":
        return m.haveKey();
      case "activate.submit":
        return m.submitKey(s.keyField?.text ?? "");
      case "signin.replace.open":
      case "signin.replace.openSystem": {
        const id = s.selected ?? s.choices?.preselected;
        return id ? m.openReplace(id) : undefined;
      }
      case "signin.replace.confirm":
        return d.deviceId ? m.confirmReplace(d.deviceId) : undefined;
      case "signin.replace.back":
        this.replacePick = undefined;
        return m.back();
      case "signin.done.start":
        this.dispatchEvent(
          new CustomEvent("pk-done", { bubbles: true, composed: true }),
        );
        if (this.sheet) this.open = false;
        return;
    }
  }

  /** The live form model (ui-core `SignInModel`), once `primitives` are set. */
  get signIn(): SignInModel | null {
    return this.formModel;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopForm?.();
    this.stopForm = null;
    // Stop following; the sign-in itself stays open on the server (SignInModel.dispose()).
    this.formModel?.dispose();
    this.formModel = null;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("primitives") || (this.primitives && !this.formModel))
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
    this.stopForm = this.formModel.subscribe(() => this.requestUpdate());
  }

  protected override baseInput(): FormInput {
    const base: FormInput = this.formModel
      ? { ...(this.input ?? {}), ...this.formModel.input() }
      : { ...(this.input ?? {}) };
    if (base.signIn && (this.presentation || this.replace))
      base.signIn = {
        ...base.signIn,
        ...(this.presentation ? { presentation: this.presentation } : {}),
        ...(this.replace ? { replace: this.replace } : {}),
      };
    if (this.replacePick !== undefined) base.replacePick = this.replacePick;
    return base;
  }

  /** True when the form lives in the modal sheet: the attribute, else the input's session. */
  get sheet(): boolean {
    return (
      (this.presentation ?? this.baseInput().signIn?.presentation) === "sheet"
    );
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
    const body = renderView({ ...c, view: step.body });
    const announce = step.announce.length
      ? html`<p class="visually-hidden" role="status">
          ${step.announce.map(
            (k) => html`<span data-key=${k}>${text(c, k)}</span>`,
          )}
        </p>`
      : nothing;
    if (this.sheet !== true) return html`${announce}${body}`;
    return html`<dialog
      class="sheet"
      part="sheet"
      data-part="sheet"
      aria-labelledby="pk-title"
      @cancel=${this.onDialogCancel}
      @close=${this.onDialogClose}
    >
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
    this.open = true;
  }

  /** `sheet`: close the dialog and cancel a sign-in in flight. */
  close(): void {
    if (this.formModel && this.formModel.snapshot.session.outcome !== undefined)
      void this.formModel.cancel();
    this.open = false;
    this.dispatchEvent(
      new CustomEvent("pk-close", { bubbles: true, composed: true }),
    );
  }

  protected override update(changed: PropertyValues): void {
    // Measure the card before the body changes, for the height morph (§3.18 morph).
    const step = this.step;
    const key = `${step.body.component}.${step.body.state}`;
    if (this.lastStep !== null && key !== this.lastStep && this.hasUpdated) {
      const card = this.renderRoot.querySelector<HTMLElement>(".card");
      const index = ORDER.indexOf(this.view.state);
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
    this.lastStep = key;
    this.syncDialog();
    if (moved) this.morph(from);
  }

  private syncDialog(): void {
    const dialog =
      this.renderRoot.querySelector<HTMLDialogElement>("dialog.sheet");
    if (!dialog) return;
    if (this.open && !dialog.open && typeof dialog.showModal === "function")
      dialog.showModal();
    else if (!this.open && dialog.open) dialog.close();
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
    const forward = ORDER.indexOf(this.view.state) >= from.index;
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
