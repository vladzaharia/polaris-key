// Every UI-KITS.md §4.1 component as a `pk-*` element (layer b), the `<pk-gate>` drop-in (layer a)
// and `<pk-provider>`, the theme for a subtree (§3.2).

import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  viewOf,
  type ComponentName,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

import {
  drivenInput,
  gateScreen,
  AutoSignInRun,
  GateBinding,
  parseHandles,
  type GateConfig,
  type GateSeams,
  type GateSnapshot,
  type GateStep,
} from "./drive.js";
import type { AutoOutcome, SignInPrimitives } from "@polaris-key/ui-core";
import { linkOfferOutcome, primitivesOf } from "./auto.js";
import { PkElement, type PkActionDetail } from "./element.js";
import { TAGS } from "./layout.js";
import { actionOf, text, type RenderCtx } from "./render.js";
import { PkSignIn, STEP_ELEMENTS } from "./signin.js";
import type { ElementsTheme, ThemeHost } from "./theme.js";
import { renderView } from "./views.js";

/** A plain component element: its view, drawn. */
function componentClass(component: ComponentName): typeof PkElement {
  // An anonymous subclass per component: the same base, the component fixed.
  return class extends PkElement {
    readonly component = component;

    /** The key step is a blocking screen: it owns the window, as the gate's screens do (DL2). */
    protected override fillsWindow(): boolean {
      return component === "Activate";
    }
  } as unknown as typeof PkElement;
}

/**
 * `<pk-gate>`: the drop-in root (UI-KITS.md §4.2). It boots, gates and runs every screen the input
 * calls for; when the license holds it renders the app in its default slot, with the grace banner
 * over it when offline grace runs. It never flashes activation during a cached-session check
 * (the model keeps `booting`, Must not).
 *
 * Given a `config` (`<pk-gate config='{"product":"tidewater"}'>`) it starts itself: it builds the
 * browser client, reads the license and runs Welcome, the hosted sign-in, Use a license key, the
 * device limit, the blocking states with their fixes, the grace banner and the update prompt,
 * the way React's `<PolarisKeyGate>` does inside its provider. `config` wins over `input`; a
 * page that drives the gate itself sets `input` and no `config`. Actions only the host can
 * answer (a trial, restore, continue free, renew) draw when `handles` names them.
 */
export class PkGate extends PkElement {
  readonly component = "PolarisKeyGate" as const;

  static override properties = {
    ...PkElement.properties,
    config: {},
    handles: {},
    seams: { attribute: false },
    autoSignIn: { attribute: "auto-sign-in" },
  };

  /** The one config object, as the attribute's JSON or an object (`product` is required). */
  config?: string | GateConfig;
  /** Host actions this page answers: `trial`, `restore`, `continue-free`, `renew`. */
  handles?: string;
  /** Embedding and test seams: a built client, or the fetch and navigation the client uses. */
  seams?: GateSeams;
  /** `off` turns automatic sign-in off: no ladder at boot, Welcome opens the hosted sign-in. */
  autoSignIn?: string;

  private binding = new GateBinding(() => this.requestUpdate());
  private auto = new AutoSignInRun(() => this.requestUpdate());

  private get autoOn(): boolean {
    const v = String(this.autoSignIn ?? "")
      .trim()
      .toLowerCase();
    return v !== "off" && v !== "false";
  }
  /** The link offer after a redirect sign-in (identity.link): what to show, once per page. */
  private linkSeed: AutoOutcome | null = null;
  private linkChecked = false;
  private linkPrims: SignInPrimitives | null = null;
  private reported: string | null = null;
  private lastStep: GateStep = "home";

  /** True when the SDK drives the gate: a `config` is set. */
  get driven(): boolean {
    return (
      this.config !== undefined && this.config !== null && this.config !== ""
    );
  }

  /** The SDK's gate: its client's state mapped onto the input the models read. */
  private get snapshot(): GateSnapshot | null {
    return this.binding.driver?.snapshot() ?? null;
  }

  protected override get options(): ElementsTheme {
    const base = super.options;
    // The product's own name, accent and icon come from the SDK's presentation source.
    const source = this.binding.driver?.adapter.presentationSource();
    return source && !base.presentation
      ? { ...base, presentation: source }
      : base;
  }

  protected override baseInput(): UiInput {
    const snap = this.driven ? this.snapshot : null;
    if (!snap) return this.driven ? {} : super.baseInput();
    const input = drivenInput(snap, parseHandles(this.handles));
    // While automatic sign-in is out the gate keeps its checking screen.
    return this.auto.holds(this.autoOn)
      ? { ...input, gate: { checking: true, cached: false } }
      : input;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("pk-action", this.onAction);
    this.addEventListener("pk-input", this.onEdit);
    this.addEventListener("keydown", this.onKey);
    this.addEventListener("pk-close", this.onFormLeave);
    this.addEventListener("pk-done", this.onFormLeave);
    this.auto.start();
    this.binding.attach();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("pk-action", this.onAction);
    this.removeEventListener("pk-input", this.onEdit);
    this.removeEventListener("keydown", this.onKey);
    this.removeEventListener("pk-close", this.onFormLeave);
    this.removeEventListener("pk-done", this.onFormLeave);
    this.auto.stop();
    this.binding.detach();
  }

  /** Whether focus sat inside the gate's own screens before this update (see `updated`). */
  private hadFocus = false;
  private lastState: string | null = null;

  protected override willUpdate(changed: PropertyValues): void {
    this.hadFocus = this.matches(":focus-within");
    const before = this.binding.driver;
    this.binding.sync(
      this.driven ? this.config : undefined,
      this.seams,
      this.locale,
    );
    // The new client's presentation (the product's name, accent and icon) applies from here.
    if (this.binding.driver !== before) this.restartIdentity();
    this.auto.follow(this.driven ? this.binding.driver : null);
    this.auto.tick(this.autoOn);
    const error = this.binding.error;
    const code = error ? `${error.code}:${error.message}` : null;
    if (code !== this.reported) {
      this.reported = code;
      if (error)
        queueMicrotask(() =>
          this.dispatchEvent(
            new CustomEvent("pk-error", {
              detail: error,
              bubbles: true,
              composed: true,
            }),
          ),
        );
    }
    super.willUpdate(changed);
  }

  /** After a redirect sign-in landed and the app runs: ask for the link offer, once. */
  private checkLink(): void {
    const a = this.driven ? this.binding.driver?.adapter : null;
    if (!a || this.linkChecked || !a.link?.pending()) return;
    const state = this.view.state;
    if (state !== "licensed" && state !== "grace") return;
    this.linkChecked = true;
    void linkOfferOutcome(a).then((seed) => {
      if (!seed || !this.isConnected) return;
      // "Sign in again" on a stale offer is the gate's own sign-in.
      this.linkPrims = primitivesOf(
        a,
        () => void a.signInWithOidc().catch(() => undefined),
        () => false,
      );
      this.linkSeed = seed;
      this.requestUpdate();
    });
  }

  private onLinkClose = (): void => {
    void this.binding.driver?.adapter.link?.dismiss();
    this.linkSeed = null;
    this.requestUpdate();
  };

  /** The in-app form's own controls and fields belong to the form, not to the gate's driver. */
  private fromForm(e: Event): boolean {
    return e.composedPath().some((n) => n instanceof PkSignIn);
  }

  /** The form is done (Cancel, Done, Use of the gate's own sign-in): the gate draws its Welcome. */
  private onFormLeave = (e: Event): void => {
    if (this.fromForm(e)) this.closeForm();
  };

  /** The form closes for Welcome: its Sign in button, which opened it, takes focus back (the
   *  gate's view stays Welcome underneath, so the step-change focus rule never fires). */
  private closeForm(): void {
    this.auto.close();
    void this.updateComplete.then(() =>
      (this.renderRoot as ShadowRoot)
        .querySelector<HTMLElement>('[data-key="welcome.signIn"]')
        ?.focus({ preventScroll: true }),
    );
  }

  private onAction = (e: Event): void => {
    if (this.fromForm(e)) return;
    const d = (e as CustomEvent<PkActionDetail>).detail;
    const driver = this.binding.driver;
    if (!d || !driver) return;
    if (
      d.key === "welcome.signIn" &&
      this.autoOn &&
      this.snapshot?.step === "home" &&
      this.auto.openMethods()
    )
      return;
    if (d.component === "UpdatePrompt") driver.actUpdate(d.key);
    else driver.act(d.key);
  };

  private onEdit = (e: Event): void => {
    if (this.fromForm(e)) return;
    const d = (e as CustomEvent<{ field?: string; value?: unknown }>).detail;
    if (d?.field && typeof d.value === "string")
      this.binding.driver?.edit(d.field, d.value);
  };

  /** Escape backs out of a step. */
  private onKey = (e: KeyboardEvent): void => {
    const snap = this.snapshot;
    if (e.key === "Escape" && this.formShown) {
      e.preventDefault();
      this.closeForm();
      return;
    }
    if (e.key !== "Escape" || !snap || snap.step === "home") return;
    e.preventDefault();
    this.binding.driver?.act("common.back");
  };

  /** The in-app sign-in form replaces the gate's screens: automatic sign-in found something to
   *  show, or Welcome's Sign in opened the provider's methods. */
  private get formShown(): boolean {
    return (
      this.driven &&
      this.auto.formOpen &&
      this.view.state === "needs-activation" &&
      this.step === "home"
    );
  }

  protected override render(): unknown {
    if (!this.formShown) return super.render();
    const driver = this.binding.driver;
    const primitives = this.auto.primitives(() =>
      driver?.act("welcome.signIn"),
    );
    if (!primitives) return super.render();
    // The platform provider on the web is Google: the button names it.
    return html`<pk-sign-in
      embedded
      fill
      presentation="inline"
      replace="inline"
      .primitives=${primitives}
      .seed=${this.auto.seed ?? undefined}
      .input=${{ ...this.baseInput(), provider: "Google" }}
      .theme=${this.options}
    ></pk-sign-in>`;
  }

  /** The gate's step morphs the card between its screens (not into the app or the banner). */
  protected override morphKey(): string | null {
    const view = this.view;
    if (view.state !== "needs-activation" && view.state !== "blocked")
      return null;
    return `${view.state}.${gateScreen(view, this.driven ? this.step : "home")}`;
  }

  /** Booting, Welcome and the blocking screens own the window; the app and the banner do not. */
  protected override fillsWindow(state: string): boolean {
    return state !== "licensed" && state !== "grace";
  }

  /** The app, in the default slot, beside the root: it is the host's content, not the kit's; and
   *  the update prompt over it when the product offers one. */
  protected override renderProjected(view: View): unknown {
    if (view.state !== "licensed" && view.state !== "grace") return nothing;
    const offer = this.driven ? this.snapshot?.updateInput : null;
    const link =
      this.linkSeed && this.linkPrims
        ? html`<pk-sign-in
            presentation="sheet"
            replace="inline"
            .open=${true}
            .primitives=${this.linkPrims}
            .seed=${this.linkSeed}
            .input=${{ provider: "Google" }}
            .theme=${this.options}
            @pk-close=${this.onLinkClose}
          ></pk-sign-in>`
        : nothing;
    return html`<slot></slot>${link}${offer
        ? html`<pk-update-prompt
            .input=${offer}
            .theme=${this.options}
          ></pk-update-prompt>`
        : nothing}`;
  }

  protected override renderBody(c: RenderCtx): unknown {
    const { view } = c;
    const sub = (component: ComponentName) =>
      renderView({ ...c, view: viewOf(component, c.input) });
    // The gate's own state, announced once for assistive technology while the screen it hands
    // to (Welcome, StatusScreen, the grace banner) draws the paths.
    const announce = html`<p class="visually-hidden" role="status">
      ${view.copy
        .filter((k) => !k.startsWith("a11y.") && k !== "common.reconnect")
        .map((k) => html`<span data-key=${k}>${text(c, k)} </span>`)}
    </p>`;
    const screen = gateScreen(view, this.driven ? this.step : "home");
    switch (view.state) {
      case "licensed":
        return nothing;
      case "grace":
        return html`${announce}${sub("GraceBanner")}`;
      case "needs-activation":
      case "blocked":
        return html`${announce}${sub(screen ?? "Welcome")}`;
      default:
        return renderView(c);
    }
  }

  private get step(): GateStep {
    return this.snapshot?.step ?? "home";
  }

  /** The gate opens (UI-KITS "never lost across async work"): the screen that held focus is
   *  gone, so focus goes to the app's first focusable, else to the app's first h1 or main, else to the host. Only when focus was in
   *  the gate's own screens: an already-open gate on first render, or a person working elsewhere,
   *  keeps theirs. */
  private focusApp(): void {
    const state = this.view.state;
    const was = this.lastState;
    this.lastState = state;
    if (
      !this.hadFocus ||
      was === null ||
      was === state ||
      !this.fillsWindow(was) ||
      this.fillsWindow(state)
    )
      return;
    const first = this.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (first) {
      first.focus({ preventScroll: true });
      return;
    }
    const anchor = this.querySelector<HTMLElement>("h1, main") ?? this;
    if (!anchor.hasAttribute("tabindex")) anchor.tabIndex = -1;
    anchor.focus({ preventScroll: true });
  }

  /** Focus follows the step (DL9): a new screen takes its own target; Back returns to the
   *  control that opened the step. */
  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    // After the draw, so the view read is the one on screen (a phone's single update).
    this.checkLink();
    this.focusApp();
    const step = this.driven ? this.step : "home";
    if (step === this.lastStep) return;
    this.lastStep = step;
    const root = this.renderRoot as ShadowRoot;
    const heading = () => root.querySelector<HTMLElement>("h1");
    const byKey = (k: string) =>
      root.querySelector<HTMLElement>(
        `[data-key="${k.replace(/["\\]/g, "")}"]`,
      );
    if (step === "home") {
      const opener = this.snapshot?.opener;
      (opener ? byKey(opener) : null)?.focus({ preventScroll: true });
      return;
    }
    const screen = gateScreen(this.view, step);
    const target = screen
      ? viewOf(screen, this.modelInput()).decisions.focus
      : null;
    if (target === null) return;
    (target === "heading" ? heading() : (byKey(target) ?? heading()))?.focus({
      preventScroll: true,
    });
  }
}

/** States that own the window: an update the app cannot run without. Every other state is a
 *  dialog over the running app (DL2). */
const UPDATE_BLOCKING: ReadonlySet<string> = new Set([
  "mandatory",
  "blocked",
  "revoked-required-content",
]);

/**
 * `<pk-update-prompt>`: an optional update is a modal `<dialog>` over the host on the scrim (a
 * bottom sheet on a phone), with the host inert, Escape and the scrim answering Later, and focus
 * returning to what held it. A mandatory update owns the window as a screen; `presentation=
 * "window"` makes any state a screen.
 */
export class PkUpdatePrompt extends PkElement {
  readonly component = "UpdatePrompt" as const;

  static override properties = {
    ...PkElement.properties,
    presentation: { reflect: true },
  };

  presentation?: "dialog" | "window";
  /** The state the person dismissed: it stays closed until the state changes. */
  private dismissed: string | null = null;
  private opener: HTMLElement | null = null;

  private get asDialog(): boolean {
    return (
      this.presentation !== "window" && !UPDATE_BLOCKING.has(this.view.state)
    );
  }

  protected override isDialog(): boolean {
    return this.asDialog;
  }

  protected override renderBody(c: RenderCtx): unknown {
    const body = renderView(c);
    if (!this.asDialog) return body;
    if (this.dismissed === c.view.state) return nothing;
    return html`<dialog
      class="sheet"
      part="sheet"
      data-part="sheet"
      aria-labelledby="pk-title"
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.dismiss();
      }}
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) this.dismiss();
      }}
    >
      ${body}
    </dialog>`;
  }

  /** Later: the host hears it, and the dialog closes until the state changes. */
  private dismiss(): void {
    const view = this.view;
    if (view.copy.includes("update.later"))
      this.dispatchEvent(
        new CustomEvent("pk-action", {
          detail: {
            key: "update.later",
            action: actionOf("update.later"),
            component: view.component,
            state: view.state,
          },
          bubbles: true,
          composed: true,
        }),
      );
    else this.close();
  }

  /** Close the dialog until the state changes, and give focus back. */
  private close(): void {
    this.dismissed = this.view.state;
    this.requestUpdate();
    const o = this.opener;
    this.opener = null;
    if (o?.isConnected) queueMicrotask(() => o.focus({ preventScroll: true }));
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Later, from its button, Escape or the scrim, closes the dialog; the host also hears it.
    this.addEventListener("pk-action", this.onAction);
  }

  private onAction = (e: Event): void => {
    const d = (e as CustomEvent<{ key?: string }>).detail;
    if (d?.key === "update.later" && this.asDialog) this.close();
  };

  protected override updated(changed: PropertyValues): void {
    if (this.dismissed !== null && this.dismissed !== this.view.state)
      this.dismissed = null;
    const dialog =
      this.renderRoot.querySelector<HTMLDialogElement>("dialog.sheet");
    if (dialog && !dialog.open) {
      this.opener ??=
        document.activeElement && document.activeElement !== document.body
          ? (document.activeElement as HTMLElement)
          : null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    super.updated(changed);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("pk-action", this.onAction);
    this.dismissed = null;
  }
}

/** `<pk-provider theme='{…}'>`: the theme for every `pk-*` element inside it. */
export class PkProvider extends LitElement implements ThemeHost {
  static override properties = {
    theme: {
      converter: {
        fromAttribute: (v: string | null) => (v ? JSON.parse(v) : {}),
      },
    },
  };

  theme: ElementsTheme = {};
  private listeners = new Set<() => void>();

  get providedTheme(): ElementsTheme {
    return this.theme ?? {};
  }

  subscribeTheme(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  protected override updated(): void {
    for (const l of [...this.listeners]) l();
  }

  protected override render(): unknown {
    return html`<slot></slot>`;
  }

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    const root = super.createRenderRoot();
    return root;
  }

  static override styles = [];
}

/** Every component's element class, by component. */
export const ELEMENTS: Readonly<Record<ComponentName, typeof PkElement>> =
  Object.fromEntries(
    (Object.keys(TAGS) as ComponentName[]).map((c) => [
      c,
      c === "PolarisKeyGate"
        ? (PkGate as unknown as typeof PkElement)
        : c === "SignIn"
          ? (PkSignIn as unknown as typeof PkElement)
          : c === "UpdatePrompt"
            ? (PkUpdatePrompt as unknown as typeof PkElement)
            : componentClass(c),
    ]),
  ) as Record<ComponentName, typeof PkElement>;

/** Register every element (idempotent: a second copy of the module defines nothing). */
export function defineElements(
  registry: CustomElementRegistry = customElements,
): void {
  if (!registry.get("pk-provider")) registry.define("pk-provider", PkProvider);
  for (const [tag, cls] of Object.entries(STEP_ELEMENTS))
    if (!registry.get(tag))
      registry.define(tag, cls as unknown as CustomElementConstructor);
  for (const [component, tag] of Object.entries(TAGS) as [
    ComponentName,
    string,
  ][])
    if (!registry.get(tag))
      registry.define(
        tag,
        ELEMENTS[component] as unknown as CustomElementConstructor,
      );
}

export { nothing };
