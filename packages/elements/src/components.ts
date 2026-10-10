// Every UI-KITS.md §4.1 component as a `pk-*` element (layer b), the `<pk-gate>` drop-in (layer a)
// and `<pk-provider>`, the theme for a subtree (§3.2).

import { html, LitElement, nothing } from "lit";
import { viewOf, type ComponentName } from "@polaris-key/ui-core";

import { PkElement } from "./element.js";
import { TAGS } from "./layout.js";
import { text, type RenderCtx } from "./render.js";
import { PkSignIn, STEP_ELEMENTS } from "./signin.js";
import type { ElementsTheme, ThemeHost } from "./theme.js";
import { renderView } from "./views.js";

/** A plain component element: its view, drawn. */
function componentClass(component: ComponentName): typeof PkElement {
  // An anonymous subclass per component: the same base, the component fixed.
  return class extends PkElement {
    readonly component = component;
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
