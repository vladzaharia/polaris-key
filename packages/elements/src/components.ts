// Every UI-KITS.md §4.1 component as a `pk-*` element (layer b), the `<pk-gate>` drop-in (layer a)
// and `<pk-provider>`, the theme for a subtree (§3.2).

import { html, LitElement, nothing, type PropertyValues } from "lit";
import { viewOf, type ComponentName } from "@polaris-key/ui-core";

import { PkElement } from "./element.js";
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
 */
export class PkGate extends PkElement {
  readonly component = "PolarisKeyGate" as const;

  /** Booting, Welcome and the blocking screens own the window; the app and the banner do not. */
  protected override fillsWindow(state: string): boolean {
    return state !== "licensed" && state !== "grace";
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
    switch (view.state) {
      case "licensed":
        return html`<slot></slot>`;
      case "grace":
        return html`${announce}${sub("GraceBanner")}<slot></slot>`;
      case "needs-activation":
        return html`${announce}${sub("Welcome")}`;
      case "blocked":
        return html`${announce}${sub("StatusScreen")}`;
      default:
        return renderView(c);
    }
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
