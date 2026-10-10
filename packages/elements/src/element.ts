// The base of every `pk-*` component element: layer (b) over layer (c). It holds the component's
// ui-core `ViewModel` (DL7's loading delay included), resolves the theme and the product's
// identity, adopts the shared stylesheet, draws the view, moves focus where the view decides
// (DL9) and turns every control into a `pk-action` DOM event.

import { LitElement, nothing, type PropertyValues } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { html } from "lit";
import {
  ViewModel,
  type ComponentName,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";
import type { ResolvedIdentity } from "@polaris-key/ui-core/theme";
import { resolveProductIdentity } from "@polaris-key/ui-core/theme";

import { copyFor, onCopyLoaded } from "./copy.js";
import { installFonts } from "./fonts.js";
import { actionOf, type RenderCtx } from "./render.js";
import { sharedSheet, stylesCss } from "./styles.js";
import {
  decodeIcon,
  findProvider,
  getTheme,
  inputWithIdentity,
  mergeThemes,
  onThemeChange,
  resolveFor,
  themeVars,
  watchProductIdentity,
  type ElementsTheme,
  type Resolved,
  type ThemeHost,
} from "./theme.js";
import { renderView } from "./views.js";

/** DL9: the ring shows only after a key was pressed since load (no ring at rest on a cold start). */
let keyboard = false;
const roots = new Set<PkElement>();
if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!keyboard) {
        keyboard = true;
        for (const r of roots) r.requestUpdate();
      }
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      if (keyboard) {
        keyboard = false;
        for (const r of roots) r.requestUpdate();
      }
    },
    true,
  );
}

/** The detail of `pk-action`: the control's copy key and the vocabulary action it performs. */
export interface PkActionDetail {
  key: string;
  action: string | null;
  component: ComponentName;
  state: string;
  [k: string]: unknown;
}

/** Shared by every component element: a ViewModel for one component, drawn in the kit's look. */
export abstract class PkElement extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    input: { attribute: false },
    theme: {
      converter: {
        fromAttribute: (v: string | null) => (v ? JSON.parse(v) : undefined),
      },
    },
    locale: { reflect: false },
    colorScheme: { attribute: "color-scheme" },
    preset: {},
    bare: { type: Boolean, reflect: true },
  };

  /** The headless input (ui-core `UiInput`): what the SDK adapter or the host knows now. */
  input: UiInput = {};
  /** This element's theme layer, over the provider's and the global one. */
  theme?: ElementsTheme;
  locale?: string;
  colorScheme?: "system" | "dark" | "light";
  preset?: "polaris-key" | "native";
  /** Drop the pane's own frame (DL2). */
  bare = false;

  /** The component this element draws. */
  abstract readonly component: ComponentName;

  private model: ViewModel | null = null;
  private provider: ThemeHost | null = null;
  private unsubs: (() => void)[] = [];
  private stopIdentity: (() => void) | null = null;
  private identity: ResolvedIdentity | null = null;
  private iconUrl: string | null = null;
  private lastSource: unknown = undefined;
  private lastFocusState: string | null = null;
  private shape: "landscape" | "portrait" | "short" = "portrait";
  private resize: ResizeObserver | null = null;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    const root = super.createRenderRoot() as ShadowRoot;
    const sheet = sharedSheet();
    if (sheet && "adoptedStyleSheets" in root)
      root.adoptedStyleSheets = [sheet];
    else {
      const style = document.createElement("style");
      style.textContent = stylesCss();
      root.append(style);
    }
    return root;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    installFonts();
    roots.add(this);
    this.provider = findProvider(this);
    const refresh = () => {
      this.restartIdentity();
      this.requestUpdate();
    };
    this.unsubs.push(onThemeChange(refresh));
    if (this.provider) this.unsubs.push(this.provider.subscribeTheme(refresh));
    this.unsubs.push(onCopyLoaded(() => this.requestUpdate()));
    for (const q of [
      "(prefers-color-scheme: light)",
      "(prefers-reduced-motion: reduce)",
    ]) {
      const m = typeof matchMedia === "function" ? matchMedia(q) : null;
      if (m?.addEventListener) {
        const l = () => this.requestUpdate();
        m.addEventListener("change", l);
        this.unsubs.push(() => m.removeEventListener("change", l));
      }
    }
    if (typeof ResizeObserver === "function") {
      this.resize = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const { inlineSize: w, blockSize: h } = entry.contentBoxSize[0] ?? {
          inlineSize: entry.contentRect.width,
          blockSize: entry.contentRect.height,
        };
        const rem =
          Number.parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          ) || 16;
        // DL1: two panes from 52.5rem in a landscape box (1.4:1); under 30rem tall is short.
        const next =
          h > 0 && h / rem < 30 && w > h
            ? "short"
            : w / rem >= 52.5 && h > 0 && w / h >= 1.4
              ? "landscape"
              : "portrait";
        if (next !== this.shape) {
          this.shape = next;
          this.requestUpdate();
        }
      });
      this.resize.observe(this);
    }
    this.restartIdentity();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    roots.delete(this);
    for (const u of this.unsubs.splice(0)) u();
    this.stopIdentity?.();
    this.stopIdentity = null;
    this.resize?.disconnect();
    this.model?.dispose();
    this.model = null;
    if (this.iconUrl?.startsWith("blob:")) URL.revokeObjectURL(this.iconUrl);
  }

  /** The theme layers merged: global, the nearest provider, this element. */
  protected get options(): ElementsTheme {
    return mergeThemes(getTheme(), this.provider?.providedTheme, this.theme, {
      ...(this.locale ? { locale: this.locale } : {}),
      ...(this.colorScheme ? { colorScheme: this.colorScheme } : {}),
      ...(this.preset ? { preset: this.preset } : {}),
    });
  }

  /** §1.2: integrator → the SDK's PresentationSource → bundle → the icon's accent → ink. */
  private restartIdentity(): void {
    const o = this.options;
    const source = o.presentation ?? null;
    if (this.stopIdentity && source === this.lastSource) {
      this.identity = resolveProductIdentity({
        integrator: o.product,
        accent: o.accent,
        preset: o.preset,
        source,
        bundle: o.bundle,
      });
      return;
    }
    this.stopIdentity?.();
    this.lastSource = source;
    this.stopIdentity = watchProductIdentity(
      {
        integrator: {
          ...(o.product ?? {}),
          ...(o.iconSrc ? { icon: true } : {}),
        },
        accent: o.accent,
        preset: o.preset,
        source,
        bundle: o.bundle,
        decodeIcon,
        iconPx: 96,
        iconScale: typeof devicePixelRatio === "number" ? devicePixelRatio : 2,
      },
      (id) => {
        this.identity = id;
        this.requestUpdate();
      },
    );
    if (source) {
      void source
        .icon(96, typeof devicePixelRatio === "number" ? devicePixelRatio : 2)
        .then((bytes) => {
          if (!bytes || this.lastSource !== source) return;
          if (this.iconUrl?.startsWith("blob:"))
            URL.revokeObjectURL(this.iconUrl);
          this.iconUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
          this.requestUpdate();
        })
        .catch(() => {
          // A failed icon leaves the monogram: never an error state.
        });
    }
  }

  /** The theme as it stands now. */
  get resolved(): Resolved {
    const o = this.options;
    const identity =
      this.identity ??
      resolveProductIdentity({
        integrator: o.product,
        accent: o.accent,
        preset: o.preset,
      });
    const iconUrl = o.iconSrc ?? this.iconUrl;
    return resolveFor(this, o, identity, iconUrl);
  }

  /** The view this element draws now. */
  get view(): View {
    return this.ensureModel().view;
  }

  private ensureModel(): ViewModel {
    if (!this.model) {
      this.model = new ViewModel(this.component, this.modelInput());
      this.model.subscribe(() => this.requestUpdate());
    }
    return this.model;
  }

  private modelInput(): UiInput {
    return inputWithIdentity(this.input ?? {}, this.resolved);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const model = this.ensureModel();
    model.update(() => this.modelInput());
  }

  /** Update the input from inside (a typed key, a picked row) and tell the host. */
  protected patchInput(
    patch: Partial<UiInput>,
    event: string,
    detail: object,
  ): void {
    this.input = { ...this.input, ...patch };
    this.dispatchEvent(
      new CustomEvent(event, { detail, bubbles: true, composed: true }),
    );
  }

  protected ctx(view: View, resolved: Resolved): RenderCtx {
    const copy = copyFor(
      resolved.locale,
      resolved.options.copy ?? {},
      resolved.theme.platform,
    );
    return {
      view,
      copy,
      resolved,
      input: this.modelInput(),
      act: (key, extra = {}) => {
        const detail: PkActionDetail = {
          key,
          action: actionOf(key),
          component: view.component,
          state: view.state,
          ...extra,
        };
        if (key === "activate.submit")
          this.input = {
            ...this.input,
            keyField: {
              text: this.input.keyField?.text ?? "",
              submitted: true,
            },
          };
        this.dispatchEvent(
          new CustomEvent<PkActionDetail>("pk-action", {
            detail,
            bubbles: true,
            composed: true,
          }),
        );
      },
      edit: (field, value) =>
        this.patchInput(
          field === "key" ? { keyField: { text: value } } : {},
          "pk-input",
          { field, value },
        ),
      pick: (id) => this.patchInput({ selected: id }, "pk-select", { id }),
    };
  }

  /** The body of the kit root; a subclass may draw more around the view (the gate's app slot). */
  protected renderBody(c: RenderCtx): unknown {
    return renderView(c);
  }

  protected override render(): unknown {
    const view = this.view;
    if (view.state === "hidden") return nothing;
    const r = this.resolved;
    const c = this.ctx(view, r);
    return html`<div
      class="pk-root"
      part="root"
      data-pk-kit
      data-component=${view.component}
      data-state=${view.state}
      data-theme=${r.theme.scheme}
      data-preset=${r.theme.preset}
      data-density=${r.theme.density}
      data-motion=${r.theme.motion}
      data-shape=${this.shape}
      data-pk-platform=${r.theme.platform ?? "web"}
      ?data-keyboard=${keyboard}
      lang=${c.copy.locale}
      style=${styleMap(themeVars(r))}
    >
      ${this.renderBody(c)}
    </div>`;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const view = this.view;
    const key = `${view.component}.${view.state}`;
    if (key === this.lastFocusState) return;
    this.lastFocusState = key;
    this.moveFocus(view);
  }

  /** DL9: focus what the view says, but only when the kit already holds focus or was asked to. */
  private moveFocus(view: View): void {
    const target = view.decisions.focus;
    if (target === null) return;
    const holds =
      this.autofocus ||
      this.matches(":focus-within") ||
      document.activeElement === document.body;
    if (!holds) return;
    const root = this.renderRoot as ShadowRoot;
    const el =
      target === "heading"
        ? root.querySelector<HTMLElement>("h1")
        : (root.querySelector<HTMLElement>(
            `[data-key="${target.replace(/["\\]/g, "")}"]`,
          ) ?? root.querySelector<HTMLElement>("h1"));
    el?.focus({ preventScroll: true });
  }
}
