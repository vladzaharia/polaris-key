// Layer (b): the styled parts, as React. Each one draws exactly the DOM the elements' parts draw
// (`@polaris-key/elements` src/render.ts): the same `pk-*` classes and `data-part` names under the
// same shared stylesheet, so a state drawn here and by `<pk-*>` is the same pixels (UI-KITS.md
// §3.2, §7.1). Every string is a catalog key of the view (DL8).

import {
  Fragment,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { POWERED_BY } from "@polaris-key/brand";
import { markSvg } from "@polaris-key/brand/svg";
import type { Copy, UiInput, View } from "@polaris-key/ui-core";
import {
  encodeQr,
  monogramOf,
  OPENS,
  spellOut,
  type Resolved,
} from "./contract.js";

/** What the drop-in adds around a view's own controls: the step's Back, controls and links the
 *  state lacks (Use another key), and keys it drops (Sign out on a signed-out screen). */
export interface Chrome {
  /** Draw Back above the card's content, bound to `common.back`. */
  back?: boolean;
  controls?: string[];
  links?: string[];
  drop?: string[];
  /** A control's visible words, where the drop-in knows better than the catalog (Download 2.5.0). */
  labels?: Record<string, string>;
  /** Status lines under the text (the code step's "Waiting for you to sign in…"). */
  meta?: string[];
}

/** What a part needs to draw one view. */
export interface KitCtx {
  /** The heading level of the part's title (its sections take the next level down). */
  headingLevel?: number;
  /** True when the host handles `onInput`: settings rows draw as real controls. */
  interactive?: boolean;
  /** The part owns the window: its stage is the page's `main`. */
  fill?: boolean;
  /** The drop-in drives this part: lines with a missing argument are left out. */
  driven?: boolean;
  /** The license step's list; the parts that draw that step pass it (the gate does not). */
  licenseRows?: (c: KitCtx) => ReactNode;
  /** A screen-form component drawn as an embedded pane. */
  embedded?: boolean;
  chrome?: Chrome;
  view: View;
  copy: Copy;
  resolved: Resolved;
  input: UiInput;
  /** A control was pressed. */
  act(key: string, detail?: Record<string, unknown>): void;
  /** The person typed in a field. */
  edit(field: string, value: string): void;
  /** The person picked a row. */
  pick(id: string): void;
}

const OPEN = "\uE000";
const CLOSE = "\uE001";

/**
 * One catalog string, with each argument that carries someone's own text (`view.isolate`) in a
 * `<bdi>` run (plans/HA-12.md Q5). A missing argument stays visible as `{name}`.
 */
/** The view's arguments, plus what the kit knows that a message may name: `{thisDevice}` (the
 *  current device in the platform's own word, capitalised where it starts a sentence),
 *  `{device}` where the view names no device (this device), and `{developer}` (the identity's). */
function argsOf(
  c: KitCtx,
  key: string,
  extra: Record<string, string | number>,
): Record<string, string | number> {
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
  if (
    args.device === undefined &&
    raw.includes("{device}") &&
    c.copy.has("part.thisDevice")
  )
    args.device = c.copy.format("part.thisDevice", { formFactor });
  const developer = c.resolved.identity.developer;
  if (args.developer === undefined && developer) args.developer = developer;
  // The tier a paywall or a lock names, from the SDK result (as the elements read it).
  const tier = c.input.account?.tier ?? c.input.entitlement?.tier;
  if (args.tier === undefined && tier) args.tier = tier;
  return args;
}

/** An argument nothing filled, left as `{name}` by the formatter. */
const UNFILLED = /\{[A-Za-z]\w*\}/;

/** Never a brace on screen: a part of a line (the catalog joins parts with " · ") whose argument
 *  is missing is dropped, and a line left with nothing is empty. */
function withoutBraces(s: string, key: string): string {
  // The screen-reader labels (a11y.*) stay as the corpus lists them: they carry no visible text.
  if (key.startsWith("a11y.") || !UNFILLED.test(s)) return s;
  return s
    .split(" · ")
    .filter((part) => !UNFILLED.test(part))
    .join(" · ")
    .replace(UNFILLED, "")
    .trim();
}

/** One string. The installed version's line says the size of a download only when it knows one
 *  (the web prompt does not); there the line is just "You have 2.4.1". */
function formatKey(
  c: KitCtx,
  key: string,
  args: Record<string, string | number>,
): string {
  if (key !== "update.current" || args.size !== undefined)
    return withoutBraces(c.copy.format(key, args), key);
  return withoutBraces(
    c.copy
      .format(key, { ...args, size: "" })
      .split("·")[0]!
      .trim(),
    key,
  );
}

export function text(
  c: KitCtx,
  key: string,
  extra: Record<string, string | number> = {},
): ReactNode {
  const args = argsOf(c, key, extra);
  const isolated = new Set(c.view.isolate);
  const marked: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args))
    marked[k] =
      isolated.has(k) && typeof v === "string" ? `${OPEN}${v}${CLOSE}` : v;
  const s = formatKey(c, key, marked);
  if (!s.includes(OPEN)) return s;
  const parts: ReactNode[] = [];
  s.split(OPEN).forEach((chunk, i) => {
    const end = chunk.indexOf(CLOSE);
    if (end === -1) parts.push(chunk);
    else {
      parts.push(<bdi key={`b${i}`}>{chunk.slice(0, end)}</bdi>);
      parts.push(chunk.slice(end + 1));
    }
  });
  return <>{parts}</>;
}

/** True when the message draws nothing: every argument it names is missing. Its element stays
 *  (a host and a test find the key), hidden, and never leaves a separator beside it. */
export function silent(c: KitCtx, key: string): boolean {
  return !key.startsWith("a11y.") && plain(c, key) === "";
}

/** A plain string, for an attribute (an aria-label). */
export function plain(
  c: KitCtx,
  key: string,
  extra: Record<string, string | number> = {},
): string {
  return formatKey(c, key, argsOf(c, key, extra));
}

/** True when the string still holds a `{name}` argument nothing filled. */
export function unfilled(c: KitCtx, key: string): boolean {
  const args = argsOf(c, key, {});
  const raw =
    key === "update.current" && args.size === undefined
      ? c.copy
          .format(key, { ...args, size: "" })
          .split("·")[0]!
          .trim()
      : c.copy.format(key, args);
  return UNFILLED.test(raw);
}

// ── Glyphs (decorative, aria-hidden) ─────────────────────────────────────────────────────────

function Glyph({ d, cls }: { d: ReactNode; cls: string }) {
  return (
    <svg
      className={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d}
    </svg>
  );
}

export const GLYPHS = {
  external: () => (
    <Glyph
      cls="glyph"
      d={
        <>
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </>
      }
    />
  ),
  back: (cls = "glyph") => <Glyph cls={cls} d={<path d="m15 18-6-6 6-6" />} />,
  check: (cls = "check") => (
    <Glyph cls={cls} d={<path d="M20 6 9 17l-5-5" />} />
  ),
  copy: () => (
    <Glyph
      cls="glyph"
      d={
        <>
          <rect width="14" height="14" x="8" y="8" rx="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </>
      }
    />
  ),
  paste: () => (
    <Glyph
      cls="glyph"
      d={
        <>
          <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        </>
      }
    />
  ),
  offline: (cls = "status-glyph") => (
    <Glyph
      cls={cls}
      d={
        <>
          <path d="M12 20h.01" />
          <path d="M8.5 16.43a5 5 0 0 1 7 0" />
          <path d="M5 12.86a10 10 0 0 1 5.17-2.69" />
          <path d="M19 12.86a10 10 0 0 0-2-1.43" />
          <path d="M2 8.82a15 15 0 0 1 4.18-2.65" />
          <path d="M22 8.82a15 15 0 0 0-11.29-3.76" />
          <path d="m2 2 20 20" />
        </>
      }
    />
  ),
  warning: (cls = "status-glyph") => (
    <Glyph
      cls={cls}
      d={
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      }
    />
  ),
  success: (cls = "status-glyph") => (
    <Glyph
      cls={cls}
      d={
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </>
      }
    />
  ),
  info: (cls = "status-glyph") => (
    <Glyph
      cls={cls}
      d={
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </>
      }
    />
  ),
  lock: (cls = "glyph") => (
    <Glyph
      cls={cls}
      d={
        <>
          <rect width="18" height="11" x="3" y="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </>
      }
    />
  ),
  device: (formFactor: string | null, cls = "row-glyph") =>
    formFactor === "iphone" || formFactor === "phone" ? (
      <Glyph
        cls={cls}
        d={
          <>
            <rect width="14" height="20" x="5" y="2" rx="2" />
            <path d="M12 18h.01" />
          </>
        }
      />
    ) : formFactor === "ipad" || formFactor === "tablet" ? (
      <Glyph
        cls={cls}
        d={
          <>
            <rect width="16" height="20" x="4" y="2" rx="2" />
            <path d="M12 18h.01" />
          </>
        }
      />
    ) : formFactor === "tv" ? (
      <Glyph
        cls={cls}
        d={
          <>
            <rect width="20" height="14" x="2" y="3" rx="2" />
            <path d="M7 21h10" />
          </>
        }
      />
    ) : (
      <Glyph
        cls={cls}
        d={
          <>
            <rect width="18" height="12" x="3" y="4" rx="2" />
            <path d="M2 20h20" />
          </>
        }
      />
    ),
};

// ── Parts ────────────────────────────────────────────────────────────────────────────────────

/** MonogramIcon / the product icon (DL5): the icon, else the initial on `surface-sunken`. */
export function productIcon(c: KitCtx): ReactNode {
  // The name the title uses is the last resort ("Welcome to Tidewater Studio" from the bundle).
  const name =
    c.resolved.identity.name ||
    c.resolved.theme.name ||
    String(c.view.args?.product ?? "");
  const label = c.copy.has("a11y.productIcon")
    ? plain(c, "a11y.productIcon", { product: name })
    : "";
  if (c.resolved.iconUrl)
    return (
      <img
        className="icon"
        data-part="icon"
        src={c.resolved.iconUrl}
        alt={label}
      />
    );
  const initial = monogramOf(name);
  // No icon and no name to take an initial from: no tile (UI-KITS §1.2 never draws an empty one).
  if (initial === "") return null;
  return (
    <span
      className="icon monogram"
      data-part="monogram"
      role="img"
      aria-label={label}
    >
      {initial}
    </span>
  );
}

/** ProductHeader: icon plus name (DL5); `by <Developer>` on the hero only. */
export function productHeader(
  c: KitCtx,
  size: "hero" | "compact" | "medium" | "none",
  options: { name?: boolean; developer?: boolean } = {},
): ReactNode {
  if (size === "none") return null;
  const name = c.resolved.identity.name || c.resolved.theme.name;
  const showName = (options.name ?? true) && name !== "";
  // §1.2: once a key parses, the tier follows the name, and only on the server's answer.
  const tier =
    c.input.activation?.result === "ok" ? c.input.activation.tier : undefined;
  const icon = productIcon(c);
  if (icon === null && !showName && !options.developer) return null;
  return (
    <div className="identity" data-part="header" data-size={size}>
      {icon}
      {showName ? (
        <span className="name" data-part="name">
          <bdi>{name}</bdi>
        </span>
      ) : null}
      {showName && size !== "hero" && tier ? (
        <span className="tier" data-part="tier">
          · <bdi>{tier}</bdi>
        </span>
      ) : null}
      {options.developer ? (
        <span className="by" data-part="developer">
          {text(c, "common.byDeveloper")}
        </span>
      ) : null}
    </div>
  );
}

export type Variant = "primary" | "secondary" | "link" | "danger";

/** A control. The view's primary is filled; a lone control is the primary too (DL4). */
/** The Replace step's primary names the device it replaces ("Replace Work laptop and continue"). */
const NAMED_PRIMARY: ReadonlySet<string> = new Set([
  "signin.replace.confirm",
  "deviceLimit.primary",
]);

function pickedDevice(c: KitCtx): string | null {
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

/** A list that scrolls (past six devices) opens on its checked row, not the top. */
export function openOnChecked(list: HTMLElement | null): void {
  if (!list) return;
  const row = list.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!row || list.scrollTop !== 0 || list.scrollHeight <= list.clientHeight)
    return;
  const top = row.offsetTop - list.offsetTop;
  if (top + row.offsetHeight > list.clientHeight)
    list.scrollTop = top - list.clientHeight / 2 + row.offsetHeight / 2;
}

export function button(
  c: KitCtx,
  key: string,
  variant: Variant,
  extra: {
    busy?: boolean;
    label?: string;
    args?: Record<string, string | number>;
    /** Extra members of the `onAction` this control reports (a row's index). */
    detail?: Record<string, unknown>;
  } = {},
): ReactNode {
  const external = OPENS.has(key) || c.chrome?.labels?.[key] !== undefined;
  const device =
    NAMED_PRIMARY.has(key) && c.copy.has("signin.replace.confirmNamed")
      ? pickedDevice(c)
      : null;
  return (
    <button
      key={key}
      type="button"
      className="btn"
      data-part={variant}
      data-variant={variant}
      data-key={key}
      aria-disabled={extra.busy ? "true" : undefined}
      aria-label={extra.label}
      onClick={() => {
        if (!extra.busy) c.act(key, extra.detail);
      }}
    >
      {extra.busy ? <span className="ring" aria-hidden="true" /> : null}
      <span>
        {device !== null
          ? text(c, "signin.replace.confirmNamed", { device })
          : (c.chrome?.labels?.[key] ?? text(c, key, extra.args))}
      </span>
      {external ? (
        <>
          {GLYPHS.external()}
          <span className="visually-hidden">
            {c.copy.has("a11y.externalLink")
              ? plain(c, "a11y.externalLink")
              : ""}
          </span>
        </>
      ) : null}
    </button>
  );
}

/** Back (DL9): the same action as Escape, drawn on every step past Welcome. */
export function backButton(c: KitCtx): ReactNode {
  return (
    <div className="links" data-part="back">
      <button
        type="button"
        className="btn"
        data-variant="link"
        data-key="common.back"
        onClick={() => c.act("common.back")}
      >
        {GLYPHS.back()}
        <span>{text(c, "common.back")}</span>
      </button>
    </div>
  );
}

/** SeatMeter (§1.5 rule 9): neutral segments with "{used} of {limit} in use". */
export function seatMeter(
  c: KitCtx,
  used: number,
  limit: number,
  caption = true,
): ReactNode {
  const segs = Array.from(
    { length: Math.max(1, Math.min(limit, 12)) },
    (_, i) => i < used,
  );
  return (
    <div
      className="seats"
      data-part="seat-meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={used}
      aria-label={
        c.copy.has("a11y.seatMeter")
          ? plain(c, "a11y.seatMeter", { used, limit })
          : ""
      }
    >
      <div className="seat-bar" aria-hidden="true">
        {segs.map((on, i) => (
          <span key={i} data-used={on ? "" : undefined} />
        ))}
      </div>
      {caption ? (
        <span className="meta num">
          {text(c, "part.seatMeter.caption", { used, limit })}
        </span>
      ) : null}
    </div>
  );
}

/** ProgressBar: determinate only for counted bytes (DL7). */
export function progressBar(c: KitCtx, fraction: number): ReactNode {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const own = c.view.copy.find(
    (k) => !k.startsWith("a11y.") && !k.startsWith("common."),
  );
  const label = c.view.copy.includes("a11y.progress")
    ? plain(c, "a11y.progress")
    : own
      ? plain(c, own)
      : undefined;
  return (
    <div
      className="progress"
      data-part="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
      data-key={label ? "a11y.progress" : undefined}
      style={{ ["--pk-fraction" as string]: String(pct / 100) }}
    >
      <span />
    </div>
  );
}

/** The success mark (SIGN-IN.md §3.18 success): the check draws once; static under reduced
 *  motion. Decorative: the title says what happened. */
export function successMark(): ReactNode {
  return (
    <div className="success" aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="22" />
        <path d="m14 25 7 7 13-15" />
      </svg>
    </div>
  );
}

/** LoadingIndicator: the 2 px shimmer along the container's top edge (§1.5 rule 4). */
export function shimmer(): ReactNode {
  return <div className="shimmer" data-part="loading" aria-hidden="true" />;
}

/** KeyField: the license key, visible, private (no autocorrect, no spellcheck, no learning). */
export function keyField(
  c: KitCtx,
  invalid: boolean,
  describedBy: string | null,
): ReactNode {
  const value = c.input.keyField?.text ?? "";
  const keys = new Set(c.view.copy);
  return (
    <div className="field" data-part="key-field">
      <label className="label" htmlFor="pk-key">
        {text(c, "part.keyField.label")}
      </label>
      <div className="field-row field-paste">
        <input
          id="pk-key"
          data-key="part.keyField.label"
          data-mono=""
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={value}
          placeholder={
            keys.has("part.keyField.placeholder")
              ? plain(c, "part.keyField.placeholder")
              : ""
          }
          aria-invalid={invalid ? "true" : "false"}
          aria-describedby={describedBy ?? undefined}
          onChange={(e) => c.edit("key", e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") c.act("activate.submit");
          }}
        />
        {keys.has("common.paste") ? (
          <button
            type="button"
            className="btn paste"
            data-part="link"
            data-variant="link"
            data-key="common.paste"
            aria-label={plain(c, "common.paste")}
            title={plain(c, "common.paste")}
            onClick={() => c.act("common.paste")}
          >
            {GLYPHS.paste()}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** CodeDisplay: the user code, exactly as served, in the kit mono, with Copy. */
export function codeDisplay(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  if (!keys.has("a11y.code") && !keys.has("part.code.label")) return null;
  const code = c.input.deviceCode?.userCode ?? "";
  return (
    <div className="field" data-part="code">
      {keys.has("part.code.label") ? (
        <span className="label">{text(c, "part.code.label")}</span>
      ) : null}
      <span className="code-row">
        <span
          className="code"
          role="text"
          data-key="a11y.code"
          aria-label={
            keys.has("a11y.code")
              ? plain(c, "a11y.code", { code: spellOut(code) })
              : spellOut(code)
          }
        >
          {code}
        </span>
        {keys.has("a11y.copyCode") ? (
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-part="copy"
            data-key="a11y.copyCode"
            aria-label={plain(c, "a11y.copyCode")}
            onClick={() => c.act("a11y.copyCode")}
          >
            {GLYPHS.copy()}
          </button>
        ) : null}
      </span>
    </div>
  );
}

// DL14: a QR is black modules on a white tile in every theme and preset, so a scanner reads it.
const QR_TILE = "#ffffff"; // ui-lint: allow react-colour-literal (DL14 white tile)
const QR_INK = "#000000"; // ui-lint: allow react-colour-literal (DL14 black modules)

/** QrCode (DL14): only where the device cannot browse or for an offline request; black on a
 *  white tile with a quiet zone, the modules scaled by a whole factor, beside the text it encodes. */
export function qrCode(
  c: KitCtx,
  data: string | null,
  key: "a11y.qr" | "a11y.qrManage" | "a11y.qrRequest" = "a11y.qr",
): ReactNode {
  if (!data || !c.view.copy.includes(key)) return null;
  const q = encodeQr(data);
  if (!q) return null;
  const quiet = 4;
  const n = q.size + quiet * 2;
  let d = "";
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++)
      if (q.modules[y * q.size + x] === 1)
        d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return (
    <figure className="qr" data-part="qr" data-key={key}>
      <svg
        viewBox={`0 0 ${n} ${n}`}
        role="img"
        aria-label={plain(c, key)}
        shapeRendering="crispEdges"
      >
        <rect width={n} height={n} fill={QR_TILE} />
        <path d={d} fill={QR_INK} />
      </svg>
    </figure>
  );
}

/** The address beside a code, with Copy (DL14: the text and Copy carry the same link). */
export function copyAddress(c: KitCtx): ReactNode {
  if (!c.view.copy.includes("a11y.copyAddress")) return null;
  return (
    <button
      type="button"
      className="btn"
      data-variant="secondary"
      data-part="copy-address"
      data-key="a11y.copyAddress"
      aria-label={plain(c, "a11y.copyAddress")}
      onClick={() => c.act("a11y.copyAddress")}
    >
      {GLYPHS.copy()}
    </button>
  );
}

/** The view's accessible-only keys: a busy state's announcement, a timer's name. */
export function a11yOnly(c: KitCtx): ReactNode {
  const keys = c.view.copy.filter(
    (k) => k === "a11y.busy" || k === "a11y.toastTimer",
  );
  if (keys.length === 0) return null;
  return keys.map((k) => (
    <span
      key={k}
      className="visually-hidden"
      role={k === "a11y.busy" ? "status" : "timer"}
      data-key={k}
    >
      {text(c, k)}
    </span>
  ));
}

/** The controls, the primary first on top in a card (§1.5 rule 10). */
export function actions(
  c: KitCtx,
  controls: string[],
  layoutRow = false,
): ReactNode {
  if (controls.length === 0) return null;
  const primary = c.view.decisions.primary;
  const sorted = [...controls].sort(
    (a, b) => Number(b === primary) - Number(a === primary),
  );
  // Pressed once: while the work runs the primary is busy and ignores further presses.
  const busy =
    c.input.pending !== undefined || c.input.signIn?.redeeming === true;
  return (
    <div
      className="actions"
      data-part="actions"
      data-layout={layoutRow ? "row" : "stack"}
    >
      {sorted.map((k) =>
        button(c, k, k === primary ? "primary" : "secondary", {
          busy: busy && k === primary,
        }),
      )}
    </div>
  );
}

export function links(c: KitCtx, keys: string[]): ReactNode {
  if (keys.length === 0) return null;
  return (
    <div className="links" data-part="links">
      {keys.map((k) => button(c, k, "link"))}
    </div>
  );
}

/** The view's titles: the first is the part's heading (DL9's "heading"; h1 only on a screen that
 *  owns the page, else the level the host or the pane form gives), the rest one level below. */
export function titles(
  c: KitCtx,
  keys: string[],
  size: "display" | "title" | "section" = "title",
  subtitles: readonly string[] = [],
): ReactNode {
  if (keys.length === 0) return null;
  const [first, ...more] = keys;
  const level = Math.min(6, Math.max(1, c.headingLevel ?? 1));
  const H = `h${level}` as "h1";
  const Sub = `h${Math.min(6, level + 1)}` as "h2";
  return (
    <>
      <H
        id="pk-title"
        className="title"
        data-part="title"
        data-key={first}
        data-size={size}
        tabIndex={-1}
        hidden={silent(c, first!) || undefined}
      >
        {text(c, first!)}
      </H>
      {more.map((k) => (
        <Sub
          key={k}
          className="title"
          data-size={subtitles.includes(k) ? "sub" : "section"}
          data-part="heading"
          data-key={k}
        >
          {text(c, k)}
        </Sub>
      ))}
    </>
  );
}

export function paragraphs(c: KitCtx, keys: string[], cls = "body"): ReactNode {
  if (keys.length === 0) return null;
  return keys.map((k, i) => (
    <p
      key={k}
      hidden={silent(c, k) || undefined}
      className={i === 0 && cls === "body" ? "lede" : cls}
      data-part={cls === "body" ? (i === 0 ? "lede" : "body") : cls}
      data-key={k}
    >
      {text(c, k)}
    </p>
  ));
}

/** The message of a refusal (neutral, DL6) or an error (danger, DL7), under what caused it. */
export function callout(
  c: KitCtx,
  keys: string[],
  id = "pk-message",
): ReactNode {
  if (keys.length === 0) return null;
  const tone = c.view.decisions.tone ?? "neutral";
  const [head, ...rest] = keys;
  const isTitle = head!.endsWith(".title");
  return (
    <div
      className="callout"
      id={id}
      data-part="callout"
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
    >
      {isTitle ? (
        <span className="callout-title" data-key={head}>
          {text(c, head!)}
        </span>
      ) : (
        <span data-key={head}>{text(c, head!)}</span>
      )}
      {rest.map((k) => (
        <span key={k} data-key={k}>
          {text(c, k)}
        </span>
      ))}
    </div>
  );
}

/** The meta line of a screen or pane: its keys joined by a middle dot, announced politely. */
export function statusLine(c: KitCtx, keys: string[]): ReactNode {
  if (keys.length === 0) return null;
  // A ticking countdown is not a live region: a screen reader would read it every second.
  const ticking: string[] = keys.filter((k) => k === "signin.handoff.expires");
  const live = keys.filter((k) => !ticking.includes(k) && k !== POWERED_BY_KEY);
  return (
    <>
      {ticking.map((k) => (
        <p key={k} className="status-line" data-part="countdown">
          <span data-key={k}>{text(c, k)}</span>
        </p>
      ))}
      {live.length ? (
        <p
          className="status-line"
          data-part="status"
          role="status"
          hidden={live.every((k) => silent(c, k)) || undefined}
        >
          {live.map((k, i) => (
            <Fragment key={k}>
              {!silent(c, k) && live.slice(0, i).some((p) => !silent(c, p))
                ? " · "
                : ""}
              <span data-key={k} hidden={silent(c, k) || undefined}>
                {text(c, k)}
              </span>
            </Fragment>
          ))}
        </p>
      ) : null}
    </>
  );
}

const POWERED_BY_KEY = "part.poweredBy";

type BadgeSvg =
  typeof import("@polaris-key/brand/badge").poweredByTransparentSvg;
let badgeSvg: BadgeSvg | undefined;
let badgeLoad: Promise<void> | undefined;
/** Load the badge's artwork once (about 7 KB gzip a gate that never shows it need not carry). */
function loadBadge(): Promise<void> {
  return (badgeLoad ??= import("@polaris-key/brand/badge").then(
    (m) => {
      badgeSvg = m.poweredByTransparentSvg;
    },
    () => {
      // The badge is decoration: the line under it keeps the attribution.
    },
  ));
}

/** The 320 x 104 Locker badge (the same markup as `poweredBySvg`), drawn once its art has loaded. */
function PoweredByBadge(props: { scheme: "dark" | "light"; title: string }) {
  const [, load] = useState(badgeSvg !== undefined);
  useEffect(() => {
    if (!badgeSvg) void loadBadge().then(() => load(badgeSvg !== undefined));
  }, []);
  return (
    <div
      className="powered-by-badge"
      data-part="powered-by-badge"
      dangerouslySetInnerHTML={{
        __html: badgeSvg
          ? badgeSvg({ theme: props.scheme, title: props.title })
          : "",
      }}
    />
  );
}

/**
 * The optional attribution at the foot of a pane or screen (UI-KITS §1.6): the Locker micro mark and
 * the phrase in live text, or on About with `poweredBy: "badge"` the 320 x 104 badge where 320 px
 * are free (a container query), else the line. Out of the status live region.
 */
export function attribution(c: KitCtx, meta: string[]): ReactNode {
  if (!meta.includes(POWERED_BY_KEY)) return null;
  const scheme = c.resolved.theme.scheme;
  const badge =
    c.input.integrator?.poweredBy === "badge" && c.view.component === "About";
  const line = (
    <p className="status-line powered-by-line" data-part="powered-by">
      <span
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: markSvg({
            kind: "locker",
            size: POWERED_BY.markSize,
            theme: scheme,
            title: "",
          }),
        }}
      />
      <span data-key={POWERED_BY_KEY}>{text(c, POWERED_BY_KEY)}</span>
    </p>
  );
  if (!badge) return line;
  return (
    <div className="powered-by" data-variant="badge">
      <PoweredByBadge scheme={scheme} title={plain(c, POWERED_BY_KEY)} />
      {line}
    </div>
  );
}

/** Radio-group keys on a row list: arrows move and pick, Space and Enter pick. */
export function radioKeys(
  e: KeyboardEvent<HTMLElement>,
  c: KitCtx,
  i: number,
  n: number,
  idOf: (index: number) => string = String,
): void {
  const next =
    e.key === "ArrowDown" || e.key === "ArrowRight"
      ? (i + 1) % n
      : e.key === "ArrowUp" || e.key === "ArrowLeft"
        ? (i - 1 + n) % n
        : null;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    c.pick(idOf(i));
  } else if (next !== null) {
    e.preventDefault();
    c.pick(idOf(next));
    const host = e.currentTarget.parentElement;
    queueMicrotask(() =>
      (host?.children[next] as HTMLElement | undefined)?.focus(),
    );
  }
}
