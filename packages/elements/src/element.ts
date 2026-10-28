// The base of every `pk-*` component element: layer (b) over layer (c). It holds the component's
// ui-core `ViewModel` (DL7's loading delay included), resolves the theme and the product's
// identity, adopts the shared stylesheet, draws the view, moves focus where the view decides
// (DL9) and turns every control into a `pk-action` DOM event.

import { LitElement, nothing, type PropertyValues } from "lit";
import { html } from "lit";
import {
  focusOnMount,
  renewTarget,
  ViewModel,
  type ComponentName,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";
import type { ResolvedIdentity } from "@polaris-key/ui-core/theme";
import {
  platformVariant,
  resolveProductIdentity,
} from "@polaris-key/ui-core/theme";

import { copyFor, onCopyLoaded, preloadCopy } from "./copy.js";
import { installFonts } from "./fonts.js";
import { actionOf, type RenderCtx } from "./render.js";
import { canMorph, morph, sharedSheet, stylesCss } from "./styles.js";
import {
  decodeIcon,
  findProvider,
  getTheme,
  groundPrefersDark,
  inputWithIdentity,
  mergeThemes,
  onThemeChange,
  resolveFor,
  themeVars,
  watchGround,
  watchProductIdentity,
  type ElementsTheme,
  type Resolved,
  type ThemeHost,
} from "./theme.js";
import { LAYOUTS } from "./layout.js";
import { SYNC_LAYOUTS } from "./syncLayouts.js";
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

/** How long the Start over confirm ignores presses after the warning appears. */
const ARM_MS = 500;

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
    fill: { type: Boolean, reflect: true },
    code: { attribute: false },
    handles: {},
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
  /** Own the window (DL2): the React kit's `fill`, for a screen the host mounts as the page. */
  fill = false;
  /** RecoveryCode only: the new recovery code, handed over once by the host. It is held here, in
   *  no input or view, and drawn as text; it is never an attribute or an input's value. */
  code?: string;
  /** The host actions this page answers, space separated: `unlock` and `review` (the sync status's
   *  Unlock sync and Review). A control only a
   *  host can act on is not drawn otherwise (a dev-mode warning says so). */
  handles?: string;

  /** The component this element draws. */
  abstract readonly component: ComponentName;

  private model: ViewModel | null = null;
  private lastSyncStep = "";
  private copied = false;
  private armUntil = 0;
  /** Where Cancel on the Start over warning goes back to. */
  private unlockFrom: "code" | "no-code" = "code";
  private provider: ThemeHost | null = null;
  private unsubs: (() => void)[] = [];
  private stopIdentity: (() => void) | null = null;
  private identity: ResolvedIdentity | null = null;
  private iconUrl: string | null = null;
  private lastSource: unknown = undefined;
  private lastFocusState: string | null = null;
  private shape: "landscape" | "portrait" | "short" = "portrait";
  private wide = false;
  private tight = false;
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
    preloadCopy();
    roots.add(this);
    this.provider = findProvider(this);
    const refresh = () => {
      this.restartIdentity();
      this.requestUpdate();
    };
    this.unsubs.push(onThemeChange(refresh));
    if (this.provider) this.unsubs.push(this.provider.subscribeTheme(refresh));
    this.unsubs.push(onCopyLoaded(() => this.requestUpdate()));
    // Under the native preset the "system" scheme follows the host page's own ground: a theme
    // toggle on the root or body, not only the OS preference.
    this.unsubs.push(
      watchGround(() => {
        if (this.options.preset !== "native") return;
        const dark = groundPrefersDark(this);
        if (dark === this.groundDark) return;
        this.groundDark = dark;
        this.requestUpdate();
      }),
    );
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
      this.resize = new ResizeObserver(() => this.measure());
      this.resize.observe(this);
    }
    // The box a screen can use is the window's, not the host's own: a host whose minimum height
    // is the window grows to fit its content, which would never read as a short landscape.
    const vv = typeof visualViewport !== "undefined" ? visualViewport : null;
    if (vv) {
      const l = () => this.measure();
      vv.addEventListener("resize", l);
      this.unsubs.push(() => vv.removeEventListener("resize", l));
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

  /** DL1: two panes from 52.5rem in a landscape box (1.4:1); under 30rem tall is short. */
  private measure(): void {
    const box = this.getBoundingClientRect();
    const vv = typeof visualViewport !== "undefined" ? visualViewport : null;
    const w = Math.min(box.width, vv?.width ?? Number.POSITIVE_INFINITY);
    // The window's height, never the host's own: a host sized by its content is as tall as the
    // screen it draws, which would read as a short window whenever the screen is short.
    const h =
      vv?.height ??
      (typeof innerHeight === "number" ? innerHeight : box.height);
    const rem =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      16;
    // A sheet is a dialog over the page, not a screen that owns the window: always one column.
    const next = this.isSheet()
      ? "portrait"
      : h > 0 && h / rem < 30 && w > h
        ? "short"
        : w / rem >= 52.5 && h > 0 && w / h >= 1.4
          ? "landscape"
          : "portrait";
    // Under 34 rem of window (large text on a phone) a docked bar would cover the text it
    // docks under: it scrolls with the content instead.
    // A short window (landscape phone) docks its one-row bar, unless large text leaves under 18 rem
    // of height: the bar would then take a third of it.
    const tight = h > 0 && h / rem < 34 && (next !== "short" || h / rem < 18);
    const wide = w / rem > 35;
    if (wide !== this.wide) {
      this.wide = wide;
      this.requestUpdate();
    }
    if (next !== this.shape || tight !== this.tight)
      // After this frame's layout: a shape change never re-enters the observer's loop.
      requestAnimationFrame(() => {
        if (next === this.shape && tight === this.tight) return;
        this.shape = next;
        this.tight = tight;
        this.requestUpdate();
      });
  }

  private groundDark: boolean | undefined;

  /** The theme layers merged: global, the nearest provider, this element. */
  protected get options(): ElementsTheme {
    return mergeThemes(getTheme(), this.provider?.providedTheme, this.theme, {
      ...(this.locale ? { locale: this.locale } : {}),
      ...(this.colorScheme ? { colorScheme: this.colorScheme } : {}),
      ...(this.preset ? { preset: this.preset } : {}),
    });
  }

  /** §1.2: integrator → the SDK's PresentationSource → bundle → the icon's accent → ink. */
  protected restartIdentity(): void {
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
          const made = URL.createObjectURL(new Blob([bytes as BlobPart]));
          // Bytes that do not decode as an image leave the monogram, not a broken picture.
          const probe = new Image();
          probe.src = made;
          const shown = () => {
            if (this.lastSource !== source) return URL.revokeObjectURL(made);
            if (this.iconUrl?.startsWith("blob:"))
              URL.revokeObjectURL(this.iconUrl);
            this.iconUrl = made;
            this.requestUpdate();
          };
          if (typeof probe.decode === "function")
            probe.decode().then(shown, () => URL.revokeObjectURL(made));
          else shown();
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
    return resolveFor(this, o, identity, iconUrl, this.input?.platform);
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

  /** What the view model reads before the identity is applied: the host's input, or (the sign-in
   *  form, driven live) the form model's. */
  protected baseInput(): UiInput {
    return this.input ?? {};
  }

  protected modelInput(): UiInput {
    return inputWithIdentity(this.baseInput(), this.resolved);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const model = this.ensureModel();
    model.update(() => this.modelInput());
    // The Start over confirm waits half a second before it takes a press.
    const step = `${model.view.component}.${model.view.state}`;
    if (step !== this.lastSyncStep) {
      this.lastSyncStep = step;
      if (step === "UnlockSync.start-over") {
        this.armUntil = Date.now() + ARM_MS;
        setTimeout(() => this.requestUpdate(), ARM_MS + 10);
      }
    }
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

  /** Extra detail for a control's `pk-action` (the sign-in form adds the picked row). */
  protected actionDetail(_key: string): Record<string, unknown> {
    return {};
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
      fill: this.fill || this.fillsWindow(view.state),
      dialog: this.isDialog(),
      shape: this.shape,
      wide: this.wide,
      input: this.modelInput(),
      ...(this.code ? { code: this.code } : {}),
      copied: this.copied,
      markCopied: () => {
        this.copied = true;
        this.requestUpdate();
        setTimeout(() => {
          this.copied = false;
          this.requestUpdate();
        }, 2000);
      },
      handles: (this.handles ?? "").split(/[\s,]+/).filter(Boolean),
      ...(view.component === "UnlockSync" && view.state === "start-over"
        ? { armed: Date.now() >= this.armUntil }
        : {}),
      act: (key, extra = {}) => {
        const detail: PkActionDetail = {
          key,
          action: actionOf(key),
          component: view.component,
          state: view.state,
          ...this.actionDetail(key),
          ...extra,
        };
        if (key === "activate.submit") {
          detail.value = this.input.keyField?.text ?? "";
          this.input = {
            ...this.input,
            keyField: {
              text: this.input.keyField?.text ?? "",
              submitted: true,
            },
          };
        }
        // The Start over confirm ignores a press until it is armed (a double-click on Start over).
        if (key === "unlockSync.startOverConfirm" && Date.now() < this.armUntil)
          return;
        // The typed recovery code leaves only here, with the press that unlocks (S13). An empty
        // field sends nothing and keeps focus in it.
        if (key === "unlockSync.unlock") {
          const field = this.renderRoot.querySelector<HTMLTextAreaElement>(
            '[data-key="unlockSync.field"]',
          );
          detail.value = field?.value.replace(/\s+/g, " ").trim() ?? "";
          if (detail.value === "") {
            field?.focus();
            return;
          }
        }
        this.unlockStep(key, view);
        if (key === "ringChange.accept" && this.input.ringChange?.served)
          detail.served = this.input.ringChange.served;
        if (this.localAction(key, detail, view)) return;
        this.dispatchEvent(
          new CustomEvent<PkActionDetail>("pk-action", {
            detail,
            bubbles: true,
            composed: true,
          }),
        );
      },
      edit: (field, value, extra = {}) =>
        this.patchInput(this.editPatch(field, value, extra), "pk-input", {
          field,
          value,
          ...extra,
        }),
      pick: (id) => this.pickRow(id),
    };
  }

  /** What a typed value, a switch or a choice changes in the input the view reads. */
  private editPatch(
    field: string,
    value: string | number | boolean,
    extra: Record<string, unknown>,
  ): Partial<UiInput> {
    const input = this.input as UiInput & { drafts?: Record<string, unknown> };
    const draft = (d: Record<string, unknown>) => ({
      drafts: { ...input.drafts, ...d },
    });
    switch (field) {
      case "key": {
        // Editing the key clears a refusal of the old one.
        const a = input.activation;
        const stale = a && a.result !== "ok" && a.result !== "device-limit";
        return {
          keyField: { text: String(value) },
          ...(stale ? { activation: undefined } : {}),
        };
      }
      case "recoverySaved":
        return { recoveryCode: { saved: value === true } };
      case "recoveryEdited":
        // Editing the code clears "That code isn't right".
        return input.unlockSync?.step === "invalid"
          ? { unlockSync: { ...input.unlockSync, step: "code" } }
          : {};
      case "setting":
        return {
          config: (input.config ?? []).map((r) =>
            r.key === extra.key ? { ...r, value } : r,
          ),
          edit: { kind: "value" },
        };
      case "autoUpdate":
        return {
          account: {
            ...(input.account ?? { signedIn: true }),
            autoUpdate: value === true,
          },
        };
      case "channel":
        return {
          channel: { locked: false, ...input.channel, current: String(value) },
        };
      case "response":
        return {
          offline: {
            ...input.offline,
            response: String(value),
            file: String(value) !== "",
          },
        };
      case "deviceName":
        return draft({ deviceName: String(value) }) as Partial<UiInput>;
      default:
        return {};
    }
  }

  /** Controls the element answers itself (Devices renames and removes in the row): true when the
   *  press only moved the pane's own state and the host has nothing to do yet. */
  private localAction(
    key: string,
    detail: PkActionDetail,
    view: View,
  ): boolean {
    const input = this.input as UiInput & { drafts?: Record<string, unknown> };
    const drafts = input.drafts ?? {};
    if (key === "offlineActivation.submit")
      detail.response = input.offline?.response ?? "";
    if (key === "paywall.upgrade" || key === "paywall.portal") {
      const id = input.selected ?? input.offers?.items?.[0]?.id;
      if (id) detail.offerId = id;
      if (input.offers?.url) detail.url = input.offers.url;
    }
    if (key === "status.renew") {
      const url = renewTarget(input);
      if (url) detail.url = url;
    }
    if (view.component === "Settings" && key === "common.save")
      detail.values = Object.fromEntries(
        (input.config ?? []).map((r) => [r.key, r.value]),
      );
    if (key === "signin.key.differentKey" && view.component === "Activate") {
      // Another key: the refusal goes, the field keeps what was typed.
      this.input = { ...input, activation: undefined } as UiInput;
      return true;
    }
    if (key === "settings.advanced") {
      this.input = {
        ...input,
        drafts: { ...drafts, advanced: drafts.advanced !== true },
      } as UiInput;
      return true;
    }
    if (view.component !== "Devices") return false;
    const list = input.devices ?? [];
    const named = (id: unknown) => list.find((d) => d.id === id);
    if (key === "devices.rename" && detail.deviceId) {
      const d = named(detail.deviceId);
      this.input = {
        ...input,
        edit: { kind: "rename", device: d?.name ?? "" },
        drafts: {
          ...drafts,
          deviceId: detail.deviceId,
          deviceName: d?.name ?? "",
        },
      } as UiInput;
      return true;
    }
    if (
      key === "devices.remove" &&
      view.state !== "confirming" &&
      detail.deviceId
    ) {
      const d = named(detail.deviceId);
      this.input = {
        ...input,
        edit: { kind: "remove", device: d?.name ?? "" },
        drafts: { ...drafts, deviceId: detail.deviceId },
      } as UiInput;
      return true;
    }
    if (key === "common.cancel" && input.edit) {
      this.input = { ...input, edit: undefined, drafts: {} } as UiInput;
      return true;
    }
    if (key === "devices.remove" || key === "common.save") {
      detail.deviceId = drafts.deviceId;
      if (key === "common.save")
        detail.name =
          (drafts.deviceName as string | undefined) ??
          named(drafts.deviceId)?.name ??
          "";
      // The host answers; the pane returns to its list (a failure sets `error`).
      queueMicrotask(() => {
        this.input = { ...this.input, edit: undefined, drafts: {} } as UiInput;
      });
    }
    return false;
  }

  /** A row was picked (a device, a license): the input's `selected`, and `pk-select`. */
  protected pickRow(id: string): void {
    this.patchInput({ selected: id }, "pk-select", { id });
  }

  /** The body of the kit root; a subclass may draw more around the view (the gate's app slot). */
  protected renderBody(c: RenderCtx): unknown {
    return renderView(c);
  }

  /** The view is drawn in a modal dialog: the sign-in sheet, or the update prompt's dialog. */
  protected isDialog(): boolean {
    return this.isSheet();
  }

  /** True where the element draws in a modal sheet (the sign-in form's `presentation`). */
  protected isSheet(): boolean {
    return false;
  }

  /** True where the element's screen owns the window (DL2, DL18): the drop-in gate's own. */
  protected fillsWindow(_state: string): boolean {
    return false;
  }

  /** Light-DOM content the element projects after its root: outside `.pk-root`, so the host's
   *  own content never inherits the kit's font, colour or line height. */
  protected renderProjected(_view: View): unknown {
    return nothing;
  }

  /** The step this element is on, when changing it morphs the card (a gate's screens); else null. */
  protected morphKey(): string | null {
    return null;
  }

  private lastMorph: string | null = null;

  /** A step change redraws inside a View Transition on the card; focus moves in `updated`, which
   *  runs in the same pass, exactly as without it. Without the API: the plain update. */
  protected override scheduleUpdate(): void | Promise<unknown> {
    // The model learns the new input in willUpdate, after this: read the step it is moving to.
    if (this.hasUpdated) this.ensureModel().update(() => this.modelInput());
    const key = this.morphKey();
    const was = this.lastMorph;
    this.lastMorph = key;
    const root = this.renderRoot?.querySelector?.(".pk-root");
    if (key === null || was === null || key === was || !root || !canMorph())
      return super.scheduleUpdate();
    return new Promise<void>((done) =>
      morph(
        root,
        () => {
          super.scheduleUpdate();
          done();
        },
        this,
      ),
    );
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
        ?data-tight=${this.tight}
        ?data-fill=${this.fill || this.fillsWindow(view.state)}
        data-pk-platform=${platformVariant(r.theme)}
        ?data-keyboard=${keyboard}
        lang=${c.copy.locale}
        @keydown=${(e: KeyboardEvent) => this.escapes(e, c)}
      >
        ${this.renderBody(c)}
      </div>
      ${this.renderProjected(view)}`;
  }

  /** The steps of UnlockSync that only move the screen (Start over to its warning, Cancel back,
   *  Try again to the field) are answered here, and still reported to the host. */
  private unlockStep(key: string, view: View): void {
    if (view.component !== "UnlockSync") return;
    const input = this.input;
    const to = (step: NonNullable<UiInput["unlockSync"]>["step"]) => {
      this.input = { ...input, unlockSync: { ...input.unlockSync, step } };
    };
    if (key === "unlockSync.startOver") {
      this.unlockFrom = view.state === "no-code" ? "no-code" : "code";
      to("start-over");
    } else if (key === "common.cancel" && view.state === "start-over")
      to(this.unlockFrom);
    else if (key === "common.tryAgain" && view.state === "failed")
      // Back to the field. After a failed Start over, Try again repeats it: the host's to run.
      to("code");
  }

  /** Escape leaves a Cloud Sync screen by its Cancel (DL9), where it has one. */
  private escapes(e: KeyboardEvent, c: RenderCtx): void {
    const v = c.view;
    if (
      e.key !== "Escape" ||
      e.defaultPrevented ||
      !(v.component in SYNC_LAYOUTS) ||
      !v.copy.includes("common.cancel")
    )
      return;
    e.preventDefault();
    c.act("common.cancel");
  }

  private appliedVars = new Set<string>();

  /** The resolved theme's custom properties, set through the CSSOM: a `style` attribute binding
   *  is a `style-src-attr` violation under a strict CSP (UI-KITS §3.2). */
  private applyThemeVars(): void {
    const node = (this.renderRoot as ShadowRoot).querySelector<HTMLElement>(
      ".pk-root",
    );
    if (!node) {
      this.appliedVars.clear();
      return;
    }
    const vars = themeVars(this.resolved);
    for (const name of this.appliedVars)
      if (!(name in vars)) node.style.removeProperty(name);
    for (const [name, value] of Object.entries(vars))
      node.style.setProperty(name, value);
    this.appliedVars = new Set(Object.keys(vars));
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const view = this.view;
    this.applyThemeVars();
    // A list that scrolls (past six devices) opens on its checked row, not the top of the list.
    for (const list of (
      this.renderRoot as ShadowRoot
    ).querySelectorAll<HTMLElement>(".list[data-scroll]")) {
      const row = list.querySelector<HTMLElement>('[aria-checked="true"]');
      if (
        !row ||
        list.scrollTop !== 0 ||
        list.scrollHeight <= list.clientHeight
      )
        continue;
      const top = row.offsetTop - list.offsetTop;
      if (top + row.offsetHeight > list.clientHeight)
        list.scrollTop = top - list.clientHeight / 2 + row.offsetHeight / 2;
    }
    const key = `${view.component}.${view.state}`;
    if (key === this.lastFocusState) return;
    this.lastFocusState = key;
    this.moveFocus(view);
  }

  /** DL9: focus what the view says, by ui-core's one focus-on-mount rule. */
  private moveFocus(view: View): void {
    const target = view.decisions.focus;
    if (target === null) return;
    const root = this.renderRoot as ShadowRoot;
    const heading = () => root.querySelector<HTMLElement>("h1");
    const field =
      target === "heading"
        ? null
        : root.querySelector<HTMLElement>(
            `[data-key="${target.replace(/["\\]/g, "")}"]`,
          );
    const where = focusOnMount(target, {
      owns: LAYOUTS[view.component].kind === "screen",
      asked: this.autofocus,
      within: this.matches(":focus-within"),
      coldStart:
        (this.fill || this.fillsWindow(view.state)) &&
        document.activeElement === document.body,
      coarse:
        typeof matchMedia === "function" &&
        matchMedia("(pointer: coarse)").matches,
      targetIsField: field instanceof HTMLInputElement,
    });
    if (where === "none") return;
    // The license list: the checked row takes focus, then Tab reaches Continue (DL9).
    const checked = root.querySelector<HTMLElement>(
      '[data-part="license-list"] [role="radio"][aria-checked="true"]',
    );
    if (checked && target === "signin.choice.continue") {
      checked.focus({ preventScroll: true });
      return;
    }
    (where === "heading" ? heading() : (field ?? heading()))?.focus({
      preventScroll: true,
    });
  }
}
