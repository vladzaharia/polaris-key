// Layer (b): the styled parts and the one screen template every component draws through. A view
// (ui-core) says the state, the copy keys, the actions and the design decisions; `LAYOUTS` says
// where each key goes; the parts below draw them with stable `part` and `data-part` names, the
// DOM contract React shares (UI-KITS.md §3.2, §7.1).

import { outOfRange } from "./settings.js";
import { html, nothing, svg, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { ref } from "lit/directives/ref.js";
import {
  countdown,
  renewTarget,
  type Copy,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";
import { platformVariant } from "@polaris-key/ui-core/theme";

import { GOOGLE_G_GRID, GOOGLE_G_PATHS, KIT_GLYPHS } from "@polaris-key/brand";
import { encodeQr } from "@polaris-key/node/qr";

import { actionOf, OPENS, placeKeys } from "./contract.js";
import { LAYOUTS, type Layout } from "./layout.js";
import type { Resolved } from "./theme.js";
import { monogramOf } from "./monogram.js";
import { spellOut } from "./spell.js";

/** What a template needs to draw one view. */
export interface RenderCtx {
  view: View;
  copy: Copy;
  resolved: Resolved;
  input: UiInput;
  /** True where the screen owns the window: it is the page's main landmark. */
  fill?: boolean;
  /** The step is the sign-in form's body: every step shares one card width (the split). */
  form?: boolean;
  /** The view is drawn inside a modal dialog (the sign-in sheet, the update prompt). */
  dialog?: boolean;
  /** The arrangement of the box (DL1): GNOME lays two responses in a row unless it is portrait. */
  shape?: "landscape" | "portrait" | "short";
  /** The window is wider than a docked sheet (35 rem). */
  wide?: boolean;
  /** The recovery code the host handed RecoveryCode: held by the element, in no input or view. */
  code?: string;
  /** RecoveryCode: Copy code was pressed in the last two seconds (the label says "Copied"). */
  copied?: boolean;
  /** RecoveryCode: the code was copied; the element shows "Copied" for two seconds. */
  markCopied?: () => void;
  /** UnlockSync's Start over confirm ignores presses until it has been on screen a moment, so a
   *  double-click on Start over cannot also confirm it. `undefined` outside that step. */
  armed?: boolean;
  /** The host actions this page answers (`handles`): a control that only a host can act on
   *  (Unlock sync, Review, Use recovery code) is drawn when it is named. */
  handles?: readonly string[];
  /** A control was pressed: the element turns it into a `pk-action` event. */
  act(key: string, detail?: Record<string, unknown>): void;
  /** The person typed in a field, flipped a switch or chose an option. */
  edit(
    field: string,
    value: string | number | boolean,
    extra?: Record<string, unknown>,
  ): void;
  /** The person picked a row. */
  pick(id: string): void;
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────

const OPEN = "";
const CLOSE = "";

/**
 * One catalog string, with each argument that carries someone's own text (`view.isolate`) in a
 * `<bdi>` run (plans/HA-12.md Q5). A missing argument stays visible as `{name}`.
 */
/** The view's arguments, plus what the kit knows that a message may name: `{thisDevice}` (the
 *  current device in the platform's own word, capitalised where it starts a sentence),
 *  `{device}` where the view names no device (this device), and `{developer}` (the identity's). */
function argsOf(
  c: RenderCtx,
  key: string,
  extra: Record<string, string | number>,
): Record<string, string | number> {
  // A key a state gives its own arguments (`View.keyArgs`) takes only those.
  const args: Record<string, string | number> = {
    ...(c.view.keyArgs?.[key] ?? c.view.args),
    ...extra,
  };
  const raw = c.copy.raw(key) ?? "";
  const formFactor = c.input.platform?.formFactor ?? "other";
  if (args.thisDevice === undefined && raw.includes("{thisDevice}")) {
    const initial = /(^|[.!?]\s+)\{thisDevice\}/.test(raw);
    const k = initial ? "part.thisDeviceTitle" : "part.thisDevice";
    if (c.copy.has(k)) args.thisDevice = c.copy.format(k, { formFactor });
  }
  // The approver names the device that asked, never itself: with no name it is "the new device".
  if (
    args.device === undefined &&
    c.view.component === "NearbyApproval" &&
    raw.includes("{device}")
  ) {
    const initial = /(^|[.!?]\s+)\{device\}/.test(raw);
    const k = initial ? "part.newDeviceTitle" : "part.newDevice";
    if (c.copy.has(k)) args.device = c.copy.format(k);
  }
  if (
    args.device === undefined &&
    raw.includes("{device}") &&
    c.copy.has("part.thisDevice")
  )
    args.device = c.copy.format("part.thisDevice", { formFactor });
  // The seat counts the SDK's result carries, for a message that names them.
  const seats = c.input.replaceView?.seats;
  const used = c.input.activation?.deviceCount ?? seats?.used;
  const limit = c.input.activation?.limit ?? seats?.limit ?? undefined;
  if (args.used === undefined && used !== undefined) args.used = used;
  if (args.limit === undefined && limit !== undefined) args.limit = limit;
  const developer = c.resolved.identity.developer;
  if (args.developer === undefined && developer) args.developer = developer;
  fillFromInput(c, key, args);
  return args;
}

/** The key to draw: the installed version's line names a download size only when the decision
 *  carries one; otherwise it is the catalog's "You have {version}". */
function drawnKey(
  c: RenderCtx,
  key: string,
  args: Record<string, string | number>,
): string {
  return key === "update.current" &&
    args.size === undefined &&
    c.copy.has("common.updateCurrentNoSize")
    ? "common.updateCurrentNoSize"
    : key;
}

/** One string of the catalog. */
function formatKey(
  c: RenderCtx,
  key: string,
  args: Record<string, string | number>,
): string {
  return c.copy.format(drawnKey(c, key, args), args);
}

/** The names of a message's own arguments (`{name}`, `{n, plural, …}`), not those nested in a
 *  plural's or select's branches. */
export function argNames(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") {
      if (depth === 0) {
        const m = /^\{\s*([A-Za-z_][\w]*)\s*(,\s*(\w+))?\s*[,}]/.exec(
          raw.slice(i),
        );
        // A select always has an `other` branch: a missing value takes it.
        if (m && m[3] !== "select") out.push(m[1]!);
      }
      depth++;
    } else if (ch === "}") depth--;
  }
  return out;
}

/** The arguments of `key` the view, the identity and `extra` leave unfilled. */
export function missingArgs(
  c: RenderCtx,
  key: string,
  extra: Record<string, string | number> = {},
): string[] {
  const args = argsOf(c, key, extra);
  const raw = c.copy.raw(drawnKey(c, key, args));
  if (!raw) return [];
  return argNames(raw).filter((n) => args[n] === undefined || args[n] === null);
}

const warned = new Set<string>();
/** Forget which missing arguments were warned of (tests). */
export function resetMissingWarnings(): void {
  warned.clear();
}
/** True when `key` has every argument it names; otherwise warns (development) and says no. */
export function usable(
  c: RenderCtx,
  key: string,
  extra: Record<string, string | number> = {},
): boolean {
  const lost = missingArgs(c, key, extra);
  if (lost.length) warnMissing(key, lost);
  return lost.length === 0;
}

export function warnMissing(key: string, names: string[]): void {
  const id = `${key}:${names.join(",")}`;
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[pk] ${key} has no value for ${names.join(", ")}; not drawn`);
}

/** The facts the SDK result carries that a message may name and the view left out: the holder,
 *  the tier, the date grace ends, the download's figures, a list's count. */
function fillFromInput(
  c: RenderCtx,
  key: string,
  args: Record<string, string | number>,
): void {
  const i = c.input;
  const set = (name: string, v: string | number | undefined | null) => {
    if (args[name] === undefined && v !== undefined && v !== null && v !== "")
      args[name] = v;
  };
  const offer = i.offers?.items?.find((o) => o.id === i.selected);
  set("name", i.account?.holder);
  set(
    "tier",
    i.account?.tier ??
      i.entitlement?.tier ??
      offer?.name ??
      i.offers?.items?.[0]?.name,
  );
  set("date", i.gate?.graceDate);
  set("store", i.channel?.store ?? i.update?.store);
  if (key.endsWith(".downloading")) {
    set("size", i.update?.progress?.size);
    set("total", i.update?.progress?.total);
  }
  set("size", i.update?.size);
  set("time", i.update?.progress?.timeLeft ?? i.cloudSync?.lastSynced);
  set("count", i.devices?.length);
}

export function text(
  c: RenderCtx,
  key: string,
  extra: Record<string, string | number> = {},
): TemplateResult {
  const lost = missingArgs(c, key, extra);
  // Never paint braces: a line whose fact is missing is not drawn (development warns).
  if (lost.length) {
    warnMissing(key, lost);
    return html``;
  }
  const args = argsOf(c, key, extra);
  const isolated = new Set(c.view.isolate);
  const marked: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args))
    marked[k] =
      isolated.has(k) && typeof v === "string" ? `${OPEN}${v}${CLOSE}` : v;
  const s = formatKey(c, key, marked);
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
  const lost = missingArgs(c, key, extra);
  if (lost.length) {
    warnMissing(key, lost);
    return "";
  }
  return formatKey(c, key, argsOf(c, key, extra));
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
  close: (cls = "glyph") =>
    glyph(svg`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, cls),
  external: () =>
    glyph(svg`${KIT_GLYPHS.newWindow.paths.map((d) => svg`<path d=${d} />`)}`),
  check: (cls = "check") => glyph(svg`<path d="M20 6 9 17l-5-5"/>`, cls),
  copy: () =>
    glyph(
      svg`<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
    ),
  paste: () =>
    glyph(
      svg`<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>`,
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
export function productIcon(c: RenderCtx): TemplateResult | typeof nothing {
  // The name the title uses is the last resort ("Welcome to Tidewater Studio" from the bundle).
  const name =
    c.resolved.identity.name ||
    c.resolved.theme.name ||
    String(c.view.args?.product ?? "");
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
  const initial = monogramOf(name);
  // No icon and no name to take an initial from: no tile (UI-KITS §1.2 never draws an empty one).
  if (initial === "") return nothing;
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
  const showName = (options.name ?? true) && name !== "";
  // §1.2: once a key parses, the tier follows the name, and only on the server's answer.
  const tier =
    c.input.activation?.result === "ok" ? c.input.activation.tier : undefined;
  const icon = productIcon(c);
  if (icon === nothing && !showName && !options.developer) return nothing;
  return html`<div
    class="identity"
    part="header"
    data-part="header"
    data-size=${size}
  >
    ${icon}
    ${showName
      ? html`<span class="name" data-part="name"><bdi>${name}</bdi></span>`
      : nothing}
    ${showName && size !== "hero" && tier
      ? html`<span class="tier" data-part="tier">· <bdi>${tier}</bdi></span>`
      : nothing}
    ${options.developer
      ? html`<span class="by" data-part="developer"
          >${text(c, "common.byDeveloper")}</span
        >`
      : nothing}
  </div>`;
}

/** A control. The view's primary is filled; a lone control is the primary too (DL4). */
/** The device the Replace step has picked (the least recent until the person picks), by name. */
function pickedDevice(c: RenderCtx): string | null {
  const unnamed = () => plain(c, "devices.unnamed");
  const rv = c.input.replaceView;
  if (rv && rv.devices.length) {
    const pickId = (c.input as { replacePick?: string }).replacePick;
    const d =
      rv.devices.find((x) => x.id === pickId) ??
      rv.devices.find((x) => x.leastRecent) ??
      rv.devices[0]!;
    return d.label?.trim() || unnamed();
  }
  const list = c.input.devices ?? [];
  if (!list.length) return null;
  const least = list.reduce(
    (best, d, i) =>
      (d.lastSeenDays ?? 0) > (list[best]!.lastSeenDays ?? 0) ? i : best,
    0,
  );
  const picked =
    c.input.selected !== undefined ? Number(c.input.selected) : least;
  return list[picked]?.name?.trim() || unnamed();
}

/** The Replace step's primary names the device it replaces ("Replace Work laptop and continue"). */
const NAMED_PRIMARY: ReadonlySet<string> = new Set([
  "signin.replace.confirm",
  "deviceLimit.primary",
]);

export function button(
  c: RenderCtx,
  key: string,
  variant: "primary" | "secondary" | "link" | "danger",
  extra: {
    busy?: boolean;
    label?: string;
    args?: Record<string, string | number>;
    /** Extra detail for the `pk-action` this control sends (a row's id). */
    detail?: Record<string, unknown>;
    /** Not available now (a Save over a value out of range): announced, and ignores presses. */
    disabled?: boolean;
    /** The control leaves the app (a Replace that runs in the browser): the new-window glyph. */
    external?: boolean;
  } = {},
): TemplateResult {
  const device =
    NAMED_PRIMARY.has(key) && c.copy.has("signin.replace.confirmNamed")
      ? pickedDevice(c)
      : null;
  // The web page cannot install an update: its one action downloads the new version.
  const version = c.input.update?.version;
  const download =
    key === "update.install" &&
    c.view.component === "UpdatePrompt" &&
    c.view.state === "available" &&
    c.input.platform?.os === "web" &&
    version &&
    c.copy.has("common.updateDownload")
      ? c.copy.format("common.updateDownload", { version })
      : null;
  // Renew opens a page only when the host gave one; otherwise the host handles the press.
  const external =
    (key === "status.renew" ? renewTarget(c.input) != null : OPENS.has(key)) ||
    extra.external === true ||
    download !== null;
  const label =
    device !== null
      ? text(c, "signin.replace.confirmNamed", { device })
      : download !== null
        ? html`${download}`
        : text(c, key, extra.args);
  // The provider's button is Google's when the view names Google: its mark and fills (UI-KITS §3.6).
  const google =
    key === "signin.provider.continue" &&
    /^google$/i.test(String(c.view.args.provider ?? c.input.provider ?? ""));
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
    data-provider=${ifDefined(google ? "google" : undefined)}
    aria-disabled=${ifDefined(
      extra.busy || extra.disabled ? "true" : undefined,
    )}
    aria-label=${ifDefined(extra.label)}
    @click=${() => {
      if (!extra.busy && !extra.disabled) c.act(key, extra.detail);
    }}
  >
    ${extra.busy
      ? html`<span class="ring" aria-hidden="true"></span>`
      : google
        ? svg`<svg
            class="mark"
            viewBox="0 0 ${GOOGLE_G_GRID} ${GOOGLE_G_GRID}"
            aria-hidden="true"
            focusable="false"
          >
            ${GOOGLE_G_PATHS.map((p) => svg`<path fill=${p.fill} d=${p.d} />`)}
          </svg>`
        : nothing}
    <span>${label}</span>
    ${external
      ? html`${GLYPHS.external()}<span class="visually-hidden"
            >${c.copy.has(KIT_GLYPHS.newWindow.copyKey)
              ? plain(c, KIT_GLYPHS.newWindow.copyKey)
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
  caption = true,
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
    ${caption
      ? html`<span class="meta num"
          >${text(c, "part.seatMeter.caption", { used, limit })}</span
        >`
      : nothing}
  </div>`;
}

/** ProgressBar: determinate only for counted bytes (DL7). */
export function progressBar(c: RenderCtx, fraction: number): TemplateResult {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  // Named by a11y.progress, else by the state's own line (paused, queued).
  const own = c.view.copy.find(
    (k) => !k.startsWith("a11y.") && !k.startsWith("common."),
  );
  const named = c.view.copy.includes("a11y.progress")
    ? plain(c, "a11y.progress")
    : "";
  const label =
    named ||
    (own && plain(c, own)) ||
    (c.copy.has("common.loading") && plain(c, "common.loading")) ||
    undefined;
  return html`<div
    class="progress"
    part="progress"
    data-part="progress"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow=${pct}
    aria-label=${ifDefined(label)}
    data-key=${ifDefined(named ? "a11y.progress" : undefined)}
    ${ref((el) =>
      (el as HTMLElement | undefined)?.style.setProperty(
        "--pk-fraction",
        String(pct / 100),
      ),
    )}
  >
    <span></span>
  </div>`;
}

/** The success mark (SIGN-IN.md §3.18 success): the check draws once; static under reduced
 *  motion. Decorative: the title says what happened. */
export function successMark(): TemplateResult {
  return html`<div class="success" part="success" aria-hidden="true">
    <svg viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="22"></circle>
      <path d="m14 25 7 7 13-15"></path>
    </svg>
  </div>`;
}

/** Google's own "G", unmodified, above the link offer's title: the offer is about Google, so the
 *  step names it before the words do. Decorative: the title says it. */
export function providerMark(): TemplateResult {
  return html`<div
    class="provider-mark"
    part="provider-mark"
    aria-hidden="true"
  >
    <svg viewBox="0 0 ${GOOGLE_G_GRID} ${GOOGLE_G_GRID}" focusable="false">
      ${GOOGLE_G_PATHS.map((p) => svg`<path fill=${p.fill} d=${p.d} />`)}
    </svg>
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
    <div class="field-row field-paste">
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
        ? html`<button
            type="button"
            class="btn paste"
            part="link"
            data-part="link"
            data-variant="link"
            data-key="common.paste"
            aria-label=${plain(c, "common.paste")}
            title=${plain(c, "common.paste")}
            @click=${() => c.act("common.paste")}
          >
            ${GLYPHS.paste()}
          </button>`
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
          ? plain(c, "a11y.code", { code: spellOut(code) })
          : spellOut(code)}
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

/** The code the waiting device shows during nearby sign-in, for the person to tap on the approving
 *  device (number matching). Read digit by digit. */
export function nearbyCode(c: RenderCtx): TemplateResult | typeof nothing {
  const code = c.view.args.code;
  if (code === undefined || !c.view.copy.includes("a11y.nearbyCode"))
    return nothing;
  return html`<div class="field" part="code" data-part="code">
    <span class="code-row">
      <span
        class="code"
        role="text"
        data-key="a11y.nearbyCode"
        aria-label=${plain(c, "a11y.nearbyCode", {
          code: spellOut(String(code)),
        })}
        >${code}</span
      >
    </span>
  </div>`;
}

/** QrCode (DL14): only where the device cannot browse or for an offline request; black on a
 *  white tile with a quiet zone, the modules scaled by a whole factor, beside the text it encodes. */
export function qrCode(
  c: RenderCtx,
  data: string | null,
  key:
    | "a11y.qr"
    | "a11y.qrManage"
    | "a11y.qrAddKey"
    | "a11y.qrRequest" = "a11y.qr",
): TemplateResult | typeof nothing {
  if (!data || !c.view.copy.includes(key)) return nothing;
  const q = encodeQr(data);
  if (!q) return nothing;
  const quiet = 4;
  const n = q.size + quiet * 2;
  let d = "";
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++)
      if (q.modules[y * q.size + x] === 1)
        d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return html`<figure class="qr" part="qr" data-part="qr" data-key=${key}>
    <svg
      viewBox="0 0 ${n} ${n}"
      role="img"
      aria-label=${plain(c, key)}
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
  const keys = c.view.copy.filter((k) => {
    if (k !== "a11y.busy" && k !== "a11y.toastTimer") return false;
    const lost = missingArgs(c, k);
    if (lost.length) warnMissing(k, lost);
    return lost.length === 0;
  });
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

/** The controls, the primary first on top in a card (§1.5 rule 10). */
export { outOfRange };

function settingsInvalid(input: RenderCtx["input"]): boolean {
  return (input.config ?? []).some((r) => outOfRange(r));
}

export function actions(
  c: RenderCtx,
  controls: string[],
  layoutRow = false,
  primaryLast = false,
  group?: "choices",
): TemplateResult | typeof nothing {
  if (controls.length === 0) return nothing;
  const primary = c.view.decisions.primary;
  // GNOME: two responses in a row (landscape or short boxes) put the suggested action last, at
  // the trailing end, in the DOM too so Tab follows the eye; stacked (portrait, or three or more)
  // it is first, on top. A group of choices keeps its order. No CSS reordering either way.
  // A Mac row reads Cancel then the default, the default last in the DOM too.
  const last =
    primaryLast ||
    (layoutRow && platformVariant(c.resolved.theme) === "macos") ||
    (group !== "choices" &&
      controls.length === 2 &&
      c.view.component !== "StatusScreen" &&
      c.view.component !== "Boot" &&
      // A dialog floats (a row) in a window wider than a docked sheet; a page follows its shape.
      (c.dialog
        ? c.wide === true
        : c.shape !== undefined && c.shape !== "portrait") &&
      platformVariant(c.resolved.theme) === "gnome");
  const sorted = [...controls].sort((a, b) =>
    last
      ? Number(a === primary) - Number(b === primary)
      : Number(b === primary) - Number(a === primary),
  );
  // Pressed once: while the work runs the primary is busy and ignores further presses.
  const busy =
    c.input.pending !== undefined || c.input.signIn?.redeeming === true;
  return html`<div
    class="actions"
    part="actions"
    data-part="actions"
    data-layout=${layoutRow ? "row" : "stack"}
    data-group=${ifDefined(group)}
    data-primary=${ifDefined(last ? "last" : undefined)}
  >
    ${sorted.map((k) =>
      button(
        c,
        k,
        // Sign out is a quiet secondary button, as in the native kits.
        k === primary ? "primary" : "secondary",
        {
          busy: busy && k === primary,
          disabled: k === "common.save" && settingsInvalid(c.input),
        },
      ),
    )}
  </div>`;
}

export function links(
  c: RenderCtx,
  keys: string[],
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  return html`<div class="links" part="links" data-part="links">
    ${keys.map((k) =>
      button(c, k, "link", {
        disabled:
          k === "signin.linkOffer.decline" &&
          c.input.signIn?.redeeming === true,
      }),
    )}
  </div>`;
}

/** The view's titles: the first is the screen's h1 (DL9's "heading"), the rest h2. */
export function titles(
  c: RenderCtx,
  keys: string[],
  size: "display" | "title" | "section" = "title",
  subtitles: readonly string[] = [],
  level: 1 | 2 = 1,
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  const [first, ...more] = keys;
  // An embedded pane heads at h2 (its host page owns the h1); the rest nest one level below.
  const top = unsafeStatic(`h${level}`);
  const sub = unsafeStatic(`h${level + 1}`);
  return staticHtml`<${top}
      id="pk-title"
      class="title"
      part="title"
      data-part="title"
      data-key=${first!}
      data-size=${size}
      tabindex="-1"
    >
      ${text(c, first!)}
    </${top}>
    ${more.map(
      (k) =>
        staticHtml`<${sub}
          class="title"
          data-size=${subtitles.includes(k) ? "sub" : "section"}
          part="heading"
          data-part="heading"
          data-key=${k}
        >
          ${text(c, k)}
        </${sub}>`,
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

export { LAYOUTS, actionOf, countdown, placeKeys };
