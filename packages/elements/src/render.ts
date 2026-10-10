// Layer (b): the styled parts and the one screen template every component draws through. A view
// (ui-core) says the state, the copy keys, the actions and the design decisions; `LAYOUTS` says
// where each key goes; the parts below draw them with stable `part` and `data-part` names, the
// DOM contract React shares (UI-KITS.md §3.2, §7.1).

import { html, nothing, svg, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { styleMap } from "lit/directives/style-map.js";
import {
  ACTION_KEYS,
  countdown,
  type Action,
  type Copy,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

import { encodeQr } from "@polaris-key/node/qr";

import { isTitleKey, LAYOUTS, type Layout } from "./layout.js";
import type { Resolved } from "./theme.js";

/** What a template needs to draw one view. */
export interface RenderCtx {
  view: View;
  copy: Copy;
  resolved: Resolved;
  input: UiInput;
  /** A control was pressed: the element turns it into a `pk-action` event. */
  act(key: string, detail?: Record<string, unknown>): void;
  /** The person typed in a field. */
  edit(field: string, value: string): void;
  /** The person picked a row. */
  pick(id: string): void;
}

/** The vocabulary action a control performs, or `null` (a kit-local control). */
export function actionOf(key: string): Action | null {
  for (const [action, keys] of Object.entries(ACTION_KEYS) as [
    Action,
    readonly string[],
  ][])
    if (keys.includes(key)) return action;
  return null;
}

const OPENS = new Set([
  ...ACTION_KEYS["open-card"],
  ...ACTION_KEYS["open-browser"],
  ...ACTION_KEYS["open-manage-url"],
  "status.renew",
  "status.update",
  "update.appStore",
  "update.googlePlay",
  "update.steam",
  "update.openStore",
  "paywall.portal",
  "signin.none.get",
  "common.manage",
  "about.licenses",
]);

// ── Text ─────────────────────────────────────────────────────────────────────────────────────

const OPEN = "";
const CLOSE = "";

/**
 * One catalog string, with each argument that carries someone's own text (`view.isolate`) in a
 * `<bdi>` run (plans/HA-12.md Q5). A missing argument stays visible as `{name}`.
 */
export function text(
  c: RenderCtx,
  key: string,
  extra: Record<string, string | number> = {},
): TemplateResult {
  const args: Record<string, string | number> = { ...c.view.args, ...extra };
  const isolated = new Set(c.view.isolate);
  const marked: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args))
    marked[k] =
      isolated.has(k) && typeof v === "string" ? `${OPEN}${v}${CLOSE}` : v;
  const s = c.copy.format(key, marked);
  if (!s.includes(OPEN)) return html`${s}`;
  const parts: (string | TemplateResult)[] = [];
  for (const chunk of s.split(OPEN)) {
    const end = chunk.indexOf(CLOSE);
    if (end === -1) parts.push(chunk);
    else {
      parts.push(html`<bdi>${chunk.slice(0, end)}</bdi>`);
      parts.push(chunk.slice(end + 1));
    }
  }
  return html`${parts}`;
}

/** A plain string, for an attribute (an aria-label). */
export function plain(
  c: RenderCtx,
  key: string,
  extra: Record<string, string | number> = {},
): string {
  return c.copy.format(key, { ...c.view.args, ...extra });
}

// ── Glyphs (decorative, aria-hidden) ─────────────────────────────────────────────────────────

const glyph = (d: TemplateResult, cls = "glyph") =>
  html`<svg
    class=${cls}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    ${d}
  </svg>`;

export const GLYPHS = {
  external: () =>
    glyph(
      svg`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
    ),
  check: (cls = "check") => glyph(svg`<path d="M20 6 9 17l-5-5"/>`, cls),
  copy: () =>
    glyph(
      svg`<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
    ),
  offline: (cls = "status-glyph") =>
    glyph(
      svg`<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M19 12.86a10 10 0 0 0-2-1.43"/><path d="M2 8.82a15 15 0 0 1 4.18-2.65"/><path d="M22 8.82a15 15 0 0 0-11.29-3.76"/><path d="m2 2 20 20"/>`,
      cls,
    ),
  warning: (cls = "status-glyph") =>
    glyph(
      svg`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
      cls,
    ),
  success: (cls = "status-glyph") =>
    glyph(svg`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`, cls),
  info: (cls = "status-glyph") =>
    glyph(
      svg`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,
      cls,
    ),
  lock: (cls = "glyph") =>
    glyph(
      svg`<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
      cls,
    ),
  device: (formFactor: string | null, cls = "row-glyph") =>
    formFactor === "iphone" || formFactor === "phone"
      ? glyph(
          svg`<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>`,
          cls,
        )
      : formFactor === "ipad" || formFactor === "tablet"
        ? glyph(
            svg`<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>`,
            cls,
          )
        : formFactor === "tv"
          ? glyph(
              svg`<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M7 21h10"/>`,
              cls,
            )
          : glyph(
              svg`<rect width="18" height="12" x="3" y="4" rx="2"/><path d="M2 20h20"/>`,
              cls,
            ),
};

// ── Parts ────────────────────────────────────────────────────────────────────────────────────

/** MonogramIcon / the product icon (DL5): the icon, else the initial on `surface-sunken`. */
export function productIcon(c: RenderCtx): TemplateResult {
  const name = c.resolved.identity.name || c.resolved.theme.name;
  const label = c.copy.has("a11y.productIcon")
    ? plain(c, "a11y.productIcon", { product: name })
    : "";
  if (c.resolved.iconUrl)
    return html`<img
      class="icon"
      part="icon"
      data-part="icon"
      src=${c.resolved.iconUrl}
      alt=${label}
    />`;
  const initial = [...name.trim()][0]?.toLocaleUpperCase() ?? "";
  return html`<span
    class="icon monogram"
    part="icon monogram"
    data-part="monogram"
    role="img"
    aria-label=${label}
    >${initial}</span
  >`;
}

/** ProductHeader: icon plus name (DL5); `by <Developer>` on the hero only. */
export function productHeader(
  c: RenderCtx,
  size: Layout["header"],
  options: { name?: boolean; developer?: boolean } = {},
): TemplateResult | typeof nothing {
  if (size === "none") return nothing;
  const name = c.resolved.identity.name || c.resolved.theme.name;
  const showName = options.name ?? true;
  return html`<div
    class="identity"
    part="header"
    data-part="header"
    data-size=${size}
  >
    ${productIcon(c)}
    ${showName
      ? html`<span class="name" data-part="name"><bdi>${name}</bdi></span>`
      : nothing}
    ${options.developer
      ? html`<span class="by" data-part="developer"
          >${text(c, "common.byDeveloper")}</span
        >`
      : nothing}
  </div>`;
}

/** A control. The view's primary is filled; a lone control is the primary too (DL4). */
export function button(
  c: RenderCtx,
  key: string,
  variant: "primary" | "secondary" | "link" | "danger",
  extra: {
    busy?: boolean;
    label?: string;
    args?: Record<string, string | number>;
  } = {},
): TemplateResult {
  const external = OPENS.has(key);
  const part =
    variant === "primary"
      ? "primary"
      : variant === "link"
        ? "link"
        : variant === "danger"
          ? "danger"
          : "secondary";
  return html`<button
    type="button"
    class="btn"
    part=${part}
    data-part=${part}
    data-variant=${variant}
    data-key=${key}
    aria-disabled=${ifDefined(extra.busy ? "true" : undefined)}
    aria-label=${ifDefined(extra.label)}
    @click=${() => {
      if (!extra.busy) c.act(key);
    }}
  >
    ${extra.busy
      ? html`<span class="ring" aria-hidden="true"></span>`
      : nothing}
    <span>${text(c, key, extra.args)}</span>
    ${external
      ? html`${GLYPHS.external()}<span class="visually-hidden"
            >${c.copy.has("a11y.externalLink")
              ? plain(c, "a11y.externalLink")
              : ""}</span
          >`
      : nothing}
  </button>`;
}

/** SeatMeter (§1.5 rule 9): neutral segments with "{used} of {limit} in use". */
export function seatMeter(
  c: RenderCtx,
  used: number,
  limit: number,
): TemplateResult {
  const segs = Array.from(
    { length: Math.max(1, Math.min(limit, 12)) },
    (_, i) => i < used,
  );
  return html`<div
    class="seats"
    part="seat-meter"
    data-part="seat-meter"
    role="meter"
    aria-valuemin="0"
    aria-valuemax=${limit}
    aria-valuenow=${used}
    aria-label=${c.copy.has("a11y.seatMeter")
      ? plain(c, "a11y.seatMeter", { used, limit })
      : ""}
  >
    <div class="seat-bar" aria-hidden="true">
      ${segs.map((on) => html`<span ?data-used=${on}></span>`)}
    </div>
    <span class="meta num"
      >${text(c, "part.seatMeter.caption", { used, limit })}</span
    >
  </div>`;
}

/** ProgressBar: determinate only for counted bytes (DL7). */
export function progressBar(c: RenderCtx, fraction: number): TemplateResult {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  // Named by a11y.progress, else by the state's own line (paused, queued).
  const own = c.view.copy.find(
    (k) => !k.startsWith("a11y.") && !k.startsWith("common."),
  );
  const label = c.view.copy.includes("a11y.progress")
    ? plain(c, "a11y.progress")
    : own
      ? plain(c, own)
      : undefined;
  return html`<div
    class="progress"
    part="progress"
    data-part="progress"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${pct}
    aria-label=${ifDefined(label)}
    data-key=${ifDefined(label ? "a11y.progress" : undefined)}
    style=${styleMap({ "--pk-fraction": String(pct / 100) })}
  >
    <span></span>
  </div>`;
}

/** LoadingIndicator: the 2 px shimmer along the container's top edge (§1.5 rule 4). */
export function shimmer(): TemplateResult {
  return html`<div
    class="shimmer"
    part="loading"
    data-part="loading"
    aria-hidden="true"
  ></div>`;
}

/** StatusPill: status as icon plus word (§1.5 rule 9). */
export function statusPill(
  c: RenderCtx,
  key: string,
  status: "success" | "warning" | "danger" | "neutral",
): TemplateResult {
  const g =
    status === "warning" || status === "danger"
      ? GLYPHS.warning("glyph")
      : status === "success"
        ? GLYPHS.success("glyph")
        : nothing;
  return html`<span
    class="pill"
    part="status"
    data-part="status"
    data-status=${status}
    >${g}${text(c, key)}</span
  >`;
}

/** KeyField: the license key, visible, private (no autocorrect, no spellcheck, no learning). */
export function keyField(
  c: RenderCtx,
  invalid: boolean,
  describedBy: string | null,
): TemplateResult {
  const value = c.input.keyField?.text ?? "";
  const keys = new Set(c.view.copy);
  return html`<div class="field" part="key-field" data-part="key-field">
    <label class="label" for="pk-key">${text(c, "part.keyField.label")}</label>
    <div class="field-row">
      <input
        id="pk-key"
        data-key="part.keyField.label"
        data-mono
        type="text"
        inputmode="text"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="go"
        .value=${value}
        placeholder=${keys.has("part.keyField.placeholder")
          ? plain(c, "part.keyField.placeholder")
          : ""}
        aria-invalid=${invalid ? "true" : "false"}
        aria-describedby=${ifDefined(describedBy ?? undefined)}
        @input=${(e: Event) =>
          c.edit("key", (e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") c.act("activate.submit");
        }}
      />
      ${keys.has("common.paste")
        ? button(c, "common.paste", "secondary")
        : nothing}
    </div>
  </div>`;
}

/** CodeDisplay: the user code, exactly as served, in the kit mono, with Copy. */
export function codeDisplay(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  if (!keys.has("a11y.code") && !keys.has("part.code.label")) return nothing;
  const code = c.input.deviceCode?.userCode ?? "";
  return html`<div class="field" part="code" data-part="code">
    ${keys.has("part.code.label")
      ? html`<span class="label">${text(c, "part.code.label")}</span>`
      : nothing}
    <span class="code-row">
      <span
        class="code"
        role="text"
        data-key="a11y.code"
        aria-label=${keys.has("a11y.code")
          ? plain(c, "a11y.code", { code })
          : code}
        >${code}</span
      >
      ${keys.has("a11y.copyCode")
        ? html`<button
            type="button"
            class="btn"
            data-variant="secondary"
            data-part="copy"
            data-key="a11y.copyCode"
            aria-label=${plain(c, "a11y.copyCode")}
            @click=${() => c.act("a11y.copyCode")}
          >
            ${GLYPHS.copy()}
          </button>`
        : nothing}
    </span>
  </div>`;
}

/** QrCode (DL14): only where the device cannot browse or for an offline request; black on a
 *  white tile with a quiet zone, the modules scaled by a whole factor, beside the text it encodes. */
export function qrCode(
  c: RenderCtx,
  data: string | null,
): TemplateResult | typeof nothing {
  if (!data || !c.view.copy.includes("a11y.qr")) return nothing;
  const q = encodeQr(data);
  if (!q) return nothing;
  const quiet = 4;
  const n = q.size + quiet * 2;
  let d = "";
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++)
      if (q.modules[y * q.size + x] === 1)
        d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return html`<figure class="qr" part="qr" data-part="qr" data-key="a11y.qr">
    <svg
      viewBox="0 0 ${n} ${n}"
      role="img"
      aria-label=${plain(c, "a11y.qr")}
      shape-rendering="crispEdges"
    >
      <rect width=${n} height=${n} fill="#ffffff"></rect>
      <path d=${d} fill="#000000"></path>
    </svg>
  </figure>`;
}

/** The view's accessible-only keys: a busy state's announcement, a timer's name. */
/** The address beside a code, with Copy (DL14: the text, Copy and a QR carry the same link). */
export function copyAddress(c: RenderCtx): TemplateResult | typeof nothing {
  if (!c.view.copy.includes("a11y.copyAddress")) return nothing;
  return html`<button
    type="button"
    class="btn"
    data-variant="secondary"
    data-part="copy-address"
    data-key="a11y.copyAddress"
    aria-label=${plain(c, "a11y.copyAddress")}
    @click=${() => c.act("a11y.copyAddress")}
  >
    ${GLYPHS.copy()}
  </button>`;
}

export function a11yOnly(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = c.view.copy.filter(
    (k) => k === "a11y.busy" || k === "a11y.toastTimer",
  );
  if (keys.length === 0) return nothing;
  return html`${keys.map(
    (k) =>
      html`<span
        class="visually-hidden"
        role=${k === "a11y.busy" ? "status" : "timer"}
        data-key=${k}
        >${text(c, k)}</span
      >`,
  )}`;
}

// ── The one screen template ──────────────────────────────────────────────────────────────────

/** Sort keys: the layout's order first, then core titles before the rest, then by name. */
function ordered(keys: string[], layout: Layout): string[] {
  const rank = (k: string) => {
    const i = layout.order?.indexOf(k) ?? -1;
    if (i >= 0) return i;
    if (k.endsWith(".title")) return 100;
    if (k.endsWith(".message")) return 101;
    return 200;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Split a view's copy into the places the layout gives each key. */
export function placeKeys(view: View, layout: Layout) {
  const all = view.copy.filter((k) => !k.startsWith("a11y."));
  const content = new Set(layout.content ?? []);
  // The view's primary is the one filled control (DL4), drawn even where the state's copy leaves
  // it out (a busy control keeps its label; a capability-limited Welcome keeps its one path).
  const primary = view.decisions.primary;
  const controls = layout.controls.filter(
    (k) => all.includes(k) || (k === primary && !content.has(k)),
  );
  const links = (layout.links ?? []).filter((k) => all.includes(k));
  const placed = new Set([...controls, ...links, ...content]);
  const rest = all.filter((k) => !placed.has(k));
  const titles = ordered(
    rest.filter((k) => isTitleKey(k, layout)),
    layout,
  );
  const meta = rest.filter((k) => layout.meta?.includes(k));
  const footnote = rest.filter((k) => layout.footnote?.includes(k));
  const body = ordered(
    rest.filter(
      (k) => !titles.includes(k) && !meta.includes(k) && !footnote.includes(k),
    ),
    layout,
  );
  return { controls, links, titles, meta, body, footnote };
}

/** The controls, the primary first on top in a card (§1.5 rule 10). */
export function actions(
  c: RenderCtx,
  controls: string[],
  layoutRow = false,
): TemplateResult | typeof nothing {
  if (controls.length === 0) return nothing;
  const primary = c.view.decisions.primary;
  const sorted = [...controls].sort(
    (a, b) => Number(b === primary) - Number(a === primary),
  );
  const busy = c.input.pending !== undefined;
  return html`<div
    class="actions"
    part="actions"
    data-part="actions"
    data-layout=${layoutRow ? "row" : "stack"}
  >
    ${sorted.map((k) =>
      button(c, k, k === primary ? "primary" : "secondary", {
        busy: busy && k === primary,
      }),
    )}
  </div>`;
}

export function links(
  c: RenderCtx,
  keys: string[],
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  return html`<div class="links" part="links" data-part="links">
    ${keys.map((k) => button(c, k, "link"))}
  </div>`;
}

/** The view's titles: the first is the screen's h1 (DL9's "heading"), the rest h2. */
export function titles(
  c: RenderCtx,
  keys: string[],
  size: "display" | "title" | "section" = "title",
  subtitles: readonly string[] = [],
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  const [first, ...more] = keys;
  return html`<h1
      class="title"
      part="title"
      data-part="title"
      data-key=${first!}
      data-size=${size}
      tabindex="-1"
    >
      ${text(c, first!)}
    </h1>
    ${more.map(
      (k) =>
        html`<h2
          class="title"
          data-size=${subtitles.includes(k) ? "sub" : "section"}
          part="heading"
          data-part="heading"
          data-key=${k}
        >
          ${text(c, k)}
        </h2>`,
    )}`;
}

export function paragraphs(
  c: RenderCtx,
  keys: string[],
  cls = "body",
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  return html`${keys.map(
    (k, i) =>
      html`<p
        class=${i === 0 && cls === "body" ? "lede" : cls}
        data-part=${cls === "body" ? (i === 0 ? "lede" : "body") : cls}
        data-key=${k}
      >
        ${text(c, k)}
      </p>`,
  )}`;
}

/** The message of a refusal (neutral, DL6) or an error (danger, DL7), under what caused it. */
export function callout(
  c: RenderCtx,
  keys: string[],
  id = "pk-message",
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  const tone = c.view.decisions.tone ?? "neutral";
  const [head, ...rest] = keys;
  const isTitle = head!.endsWith(".title");
  return html`<div
    class="callout"
    id=${id}
    part="callout"
    data-part="callout"
    data-tone=${tone}
    role=${tone === "danger" ? "alert" : "status"}
  >
    ${isTitle
      ? html`<span class="callout-title" data-key=${head!}
          >${text(c, head!)}</span
        >`
      : html`<span data-key=${head!}>${text(c, head!)}</span>`}
    ${rest.map((k) => html`<span data-key=${k}>${text(c, k)}</span>`)}
  </div>`;
}

export { LAYOUTS, countdown };
