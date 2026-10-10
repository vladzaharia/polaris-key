// One template per component form (screen, pane, banner, toast, inline) over `placeKeys`, plus the
// content a few components draw themselves: the key field, the user code, device and license
// rows, progress, release notes and settings rows. Every string is a key of the view (DL8).

import { html, nothing, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { countdown, type View } from "@polaris-key/ui-core";

import { LAYOUTS, type Layout } from "./layout.js";
import { platformLabel } from "./platforms.js";
import {
  actions,
  button,
  callout,
  a11yOnly,
  codeDisplay,
  copyAddress,
  GLYPHS,
  qrCode,
  keyField,
  links,
  paragraphs,
  placeKeys,
  plain,
  productHeader,
  progressBar,
  seatMeter,
  shimmer,
  successMark,
  text,
  titles,
  type RenderCtx,
} from "./render.js";

const ERROR_PREFIXES = ["core.codes.", "core.activation."];
const isErrorKey = (k: string) =>
  ERROR_PREFIXES.some((p) => k.startsWith(p)) ||
  /(Failed|\.failed|methodError|\.error)$/.test(k);

/** Keys the content of a component draws itself. */
function contentFor(c: RenderCtx): TemplateResult | typeof nothing {
  const { view, input } = c;
  const keys = new Set(view.copy);
  switch (view.component) {
    case "Activate": {
      const verdict = [
        "part.keyField.verdict",
        "part.keyField.cutShort",
        "part.keyField.malformed",
        "part.keyField.empty",
        "part.keyField.forProduct",
      ].filter((k) => keys.has(k));
      const invalid = verdict.some(
        (k) =>
          k !== "part.keyField.verdict" && k !== "part.keyField.forProduct",
      );
      const editing = [
        "empty",
        "typing",
        "parsed",
        "cut-short",
        "rejected",
      ].includes(view.state);
      const used = input.activation?.deviceCount;
      const limit = input.activation?.limit;
      return html`${editing
        ? keyField(c, invalid, verdict.length ? "pk-verdict" : null)
        : nothing}
      ${keys.has("part.seatMeter.caption") &&
      used !== undefined &&
      limit !== undefined
        ? seatMeter(c, used, limit)
        : nothing}
      ${verdict.length
        ? html`<p
            id="pk-verdict"
            class=${invalid ? "message" : "meta"}
            data-tone=${ifDefined(invalid ? "danger" : undefined)}
            data-part="verdict"
            aria-live="polite"
          >
            ${verdict.map(
              (k) => html`<span data-key=${k}>${text(c, k)}</span>`,
            )}
          </p>`
        : nothing}`;
    }
    case "SignIn":
    case "SignInHandoff": {
      const code = codeDisplay(c);
      const url = c.view.decisions.link;
      const showUrl = keys.has("signin.handoff.url") && url?.display;
      return html`${code} ${qrCode(c, url?.qr ? url.url : null)}
      ${showUrl
        ? html`<p class="body" data-key="signin.handoff.url">
            ${text(c, "signin.handoff.url", { url: url!.display! })}
            ${copyAddress(c)}
          </p>`
        : keys.has("signin.handoff.url")
          ? html`<p class="body" data-key="signin.handoff.url">
              ${text(c, "signin.handoff.url")}
            </p>`
          : copyAddress(c)}
      ${keys.has("part.keyField.label") ? keyField(c, false, null) : nothing}`;
    }
    case "DeviceLimit":
      return deviceLimitContent(c);
    case "LicenseChoice":
      return c.view.state === "replace-open" ? replaceRows(c) : licenseRows(c);
    case "Devices":
      return deviceRows(c);
    case "ReleaseNotes":
      return releaseNotes(c);
    case "Settings":
      return settingsRows(c);
    case "OfflineActivation":
      return keys.has("offlineActivation.paste")
        ? html`<div class="field" data-part="response">
            <label class="label" for="pk-response"
              >${text(c, "offlineActivation.paste")}</label
            >
            <textarea
              id="pk-response"
              rows="3"
              spellcheck="false"
              data-mono
            ></textarea>
            ${keys.has("offlineActivation.dropHint")
              ? html`<span class="meta" data-key="offlineActivation.dropHint"
                  >${text(c, "offlineActivation.dropHint")}</span
                >`
              : nothing}
          </div>`
        : nothing;
    case "AccountAndLicense":
      return accountRows(c);
    default:
      return nothing;
  }
}

function progressFor(c: RenderCtx): TemplateResult | typeof nothing {
  const { view, input } = c;
  if (view.component === "Boot" && view.state === "fetching") {
    const e = input.stage?.emit;
    if (
      e?.type === "fetch_progress" &&
      typeof e.done === "number" &&
      typeof e.total === "number" &&
      e.total > 0
    )
      return progressBar(c, e.done / e.total);
  }
  const p = input.update?.progress;
  if (
    (view.component === "UpdatePrompt" && view.state === "downloading") ||
    (view.component === "UpdateProgress" &&
      (view.state === "downloading" || view.state === "paused"))
  )
    return progressBar(c, p?.fraction ?? 0);
  if (view.copy.includes("a11y.progress"))
    return progressBar(c, p?.fraction ?? 0);
  return nothing;
}

/** A locked value (ChannelPicker, a managed setting): the lock glyph, named. */
function locked(c: RenderCtx): TemplateResult | typeof nothing {
  if (!c.view.copy.includes("a11y.locked")) return nothing;
  // Settings name the lock on the locked row itself.
  if (c.view.component === "Settings" && c.input.config?.some((r) => r.locked))
    return nothing;
  return html`<span
    role="img"
    data-key="a11y.locked"
    aria-label=${plain(c, "a11y.locked")}
    >${GLYPHS.lock()}</span
  >`;
}

const LOADING: Record<string, readonly string[]> = {
  PolarisKeyGate: ["booting"],
  Boot: ["progress", "fetching"],
  LicenseChoice: ["loading"],
  Devices: ["loading"],
  ReleaseNotes: ["loading"],
  AccountAndLicense: ["loading"],
  Settings: ["loading"],
  Paywall: ["loading", "purchasing"],
  EntitlementGate: ["loading"],
  SignInHandoff: ["starting", "finishing"],
  SignIn: ["finishing"],
};

function isLoading(view: View): boolean {
  return LOADING[view.component]?.includes(view.state) ?? false;
}

/** A blocking step: the card on the product ambient (DL1, DL2, DL5). */
function screen(c: RenderCtx, layout: Layout): TemplateResult {
  const { view } = c;
  const p = placeKeys(view, layout);
  const errorKeys = p.body.filter(isErrorKey);
  const body = p.body.filter((k) => !isErrorKey(k));
  const heroTitle = layout.header === "hero";
  const ambient = c.resolved.theme.ambient;
  const showIdentity = layout.header !== "none";
  // DL5: the product's name appears once: in the title when the title names it.
  const name = c.resolved.identity.name || c.resolved.theme.name;
  const titleNames =
    p.titles.length > 0 && name !== "" && plain(c, p.titles[0]!).includes(name);
  const loading = isLoading(view);
  // Refusals (DL6) and errors (DL7) whose message is the screen: the title reads as the message.
  return html`<section
    class="stage"
    part="stage"
    data-part="stage"
    data-kind="screen"
    ?data-split=${layout.split === true}
  >
    ${ambient
      ? html`<div class="ambient" aria-hidden="true">
          ${c.resolved.iconUrl
            ? html`<img src=${c.resolved.iconUrl} alt="" />`
            : nothing}
        </div>`
      : nothing}
    <div
      class="card step"
      part="card"
      data-part="card"
      data-align=${heroTitle ? "center" : "start"}
      aria-busy=${ifDefined(loading ? "true" : undefined)}
    >
      ${loading ? shimmer() : nothing}
      <div class="split passport">
        ${layout.split && c.resolved.iconUrl
          ? html`<div class="passport-ambient" aria-hidden="true">
              <img src=${c.resolved.iconUrl} alt="" />
            </div>`
          : nothing}
        ${showIdentity
          ? productHeader(c, layout.header, {
              name: !titleNames,
              developer: view.copy.includes("common.byDeveloper"),
            })
          : nothing}
      </div>
      ${view.component === "SignIn" && view.state === "done"
        ? successMark()
        : nothing}
      <div class="texts" data-part="texts">
        ${titles(
          c,
          p.titles,
          heroTitle ? "display" : "title",
          layout.subtitles,
        )}
        ${paragraphs(
          c,
          body.filter((k) => k !== "common.byDeveloper"),
        )}
        ${p.meta.length
          ? html`<p class="status-line" data-part="status" role="status">
              ${p.meta.map(
                (k, i) =>
                  html`${i ? " · " : ""}<span data-key=${k}
                      >${text(c, k)}</span
                    >`,
              )}
            </p>`
          : nothing}
      </div>
      ${contentFor(c)} ${progressFor(c)} ${callout(c, errorKeys)}
      ${actions(c, p.controls)} ${links(c, p.links)} ${a11yOnly(c)}
      ${p.footnote.length ? paragraphs(c, p.footnote, "footnote") : nothing}
    </div>
  </section>`;
}

/** An embedded pane (DL2): start edge, at most 40rem, its own frame unless `bare`. */
function pane(c: RenderCtx, layout: Layout): TemplateResult {
  const p = placeKeys(c.view, layout);
  const errorKeys = p.body.filter(isErrorKey);
  const body = p.body.filter((k) => !isErrorKey(k));
  const loading = isLoading(c.view);
  return html`<section
    class="pane step"
    part="pane"
    data-part="pane"
    aria-busy=${ifDefined(loading ? "true" : undefined)}
  >
    ${loading ? shimmer() : nothing}
    ${productHeader(c, layout.header === "none" ? "none" : "compact")}
    <div class="texts" data-part="texts">
      ${titles(c, p.titles, "section")} ${paragraphs(c, body)}
      ${p.meta.length
        ? html`<p class="status-line" data-part="status" role="status">
            ${p.meta.map(
              (k, i) =>
                html`${i ? " · " : ""}<span data-key=${k}>${text(c, k)}</span>`,
            )}
          </p>`
        : nothing}
    </div>
    ${loading
      ? html`<div class="skeleton" aria-hidden="true">
          <span></span><span data-short></span>
        </div>`
      : nothing}
    ${locked(c)} ${contentFor(c)} ${progressFor(c)} ${callout(c, errorKeys)}
    ${actions(c, p.controls, true)} ${links(c, p.links)} ${a11yOnly(c)}
  </section>`;
}

function statusGlyph(view: View): TemplateResult | typeof nothing {
  const s = view.state;
  if (view.component === "Toast")
    return s === "success"
      ? GLYPHS.success()
      : s === "warning"
        ? GLYPHS.warning()
        : s === "error"
          ? GLYPHS.warning()
          : GLYPHS.info();
  if (view.component === "GraceBanner") return GLYPHS.offline();
  if (view.component === "CloudSyncStatus")
    return s === "offline"
      ? GLYPHS.offline()
      : s === "synced"
        ? GLYPHS.success()
        : s === "syncing"
          ? nothing
          : GLYPHS.warning();
  return nothing;
}

function statusOf(view: View): string {
  if (view.component === "Toast")
    return view.state === "error"
      ? "danger"
      : view.state === "warning"
        ? "warning"
        : view.state === "success"
          ? "success"
          : "neutral";
  if (view.component === "CloudSyncStatus")
    return view.state === "conflict" || view.state === "error"
      ? "warning"
      : view.state === "synced"
        ? "success"
        : "neutral";
  return "neutral";
}

/** A banner or a toast: one line plus its consequence, at most two actions. */
function strip(
  c: RenderCtx,
  layout: Layout,
  kind: "banner" | "toast",
): TemplateResult {
  const p = placeKeys(c.view, layout);
  const lines = [...p.titles, ...p.body, ...p.meta];
  const role = c.view.decisions.tone === "danger" ? "alert" : "status";
  return html`<div
    class=${kind}
    part=${kind}
    data-part=${kind}
    data-status=${statusOf(c.view)}
    role=${role}
  >
    ${statusGlyph(c.view)}
    <div class="texts">
      ${lines.map(
        (k, i) =>
          html`<span class=${i === 0 ? "label" : "meta"} data-key=${k}
            >${text(c, k)}</span
          >`,
      )}
      ${progressFor(c)}
    </div>
    ${p.controls.length
      ? html`<div class="actions" data-layout="row" data-part="actions">
          ${p.controls.map((k) =>
            button(
              c,
              k,
              k === c.view.decisions.primary ? "primary" : "secondary",
            ),
          )}
        </div>`
      : nothing}
    ${kind === "toast" && c.view.copy.includes("a11y.toastTimer")
      ? html`<span class="timer" aria-hidden="true"></span>`
      : nothing}
    ${a11yOnly(c)}
  </div>`;
}

/** A small status inside the host's layout. */
function inline(c: RenderCtx, layout: Layout): TemplateResult {
  const p = placeKeys(c.view, layout);
  const lines = [...p.titles, ...p.meta, ...p.body];
  return html`<div
    class="inline-status"
    part="status"
    data-part="status"
    data-status=${statusOf(c.view)}
    role="status"
  >
    ${statusGlyph(c.view)}
    ${lines.map(
      (k) =>
        html`<span class=${p.titles.includes(k) ? "label" : ""} data-key=${k}
          >${text(c, k)}</span
        >`,
    )}
    ${progressFor(c)} ${a11yOnly(c)}
    ${p.controls.map((k) =>
      button(c, k, k === c.view.decisions.primary ? "primary" : "secondary"),
    )}
    ${links(c, p.links)}
  </div>`;
}

/** Draw one view in its component's form; `hidden` draws nothing. */
export function renderView(c: RenderCtx): TemplateResult | typeof nothing {
  if (c.view.state === "hidden") return nothing;
  const layout = LAYOUTS[c.view.component];
  switch (layout.kind) {
    case "screen":
      return screen(c, layout);
    case "pane":
      return pane(c, layout);
    case "banner":
      return strip(c, layout, "banner");
    case "toast":
      return strip(c, layout, "toast");
    case "inline":
      return inline(c, layout);
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

function deviceLimitContent(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  const used =
    c.input.activation?.deviceCount ?? c.input.replaceView?.seats.used;
  const limit =
    c.input.activation?.limit ?? c.input.replaceView?.seats.limit ?? undefined;
  const devices = c.input.devices ?? [];
  const link = c.view.decisions.link;
  const qr = qrCode(c, link?.qr ? link.url : null);
  if (!keys.has("signin.replace.meta") && !keys.has("part.seatMeter.caption"))
    return qr;
  // Least recent preselected (SIGN-IN.md §3.7).
  const order = devices
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (b.d.lastSeenDays ?? 0) - (a.d.lastSeenDays ?? 0));
  const leastRecent = order[0]?.i;
  const selected =
    c.input.selected !== undefined ? Number(c.input.selected) : leastRecent;
  const pick = selected !== undefined ? devices[selected] : undefined;
  return html`${qr}${keys.has("part.seatMeter.caption") &&
  used !== undefined &&
  limit != null
    ? seatMeter(c, used, limit)
    : nothing}
  ${keys.has("signin.replace.meta")
    ? html`<div
        class="list"
        role="radiogroup"
        aria-labelledby="pk-title"
        data-part="device-list"
      >
        ${devices.map(
          (d, i) =>
            html`<div
              class="row"
              role="radio"
              part="device-row"
              data-part="device-row"
              tabindex=${i === selected ? "0" : "-1"}
              aria-checked=${i === selected ? "true" : "false"}
              @click=${() => c.pick(String(i))}
              @keydown=${(e: KeyboardEvent) =>
                radioKeys(e, c, i, devices.length)}
            >
              <span
                aria-label=${keys.has("a11y.formFactor")
                  ? plain(c, "a11y.formFactor", {
                      formFactor: d.formFactor ?? "other",
                    })
                  : ""}
                role="img"
              >
                ${GLYPHS.device(d.formFactor)}
              </span>
              <span>
                <span class="row-title"><bdi>${d.name ?? ""}</bdi></span
                ><br />
                <span class="meta">
                  ${text(c, "signin.replace.meta", {
                    platform: platformLabel(d.platform),
                    when: days(d.lastSeenDays),
                  })}
                  ${i === leastRecent && keys.has("signin.replace.leastRecent")
                    ? html` · ${text(c, "signin.replace.leastRecent")}`
                    : nothing}
                </span>
              </span>
              ${i === selected ? GLYPHS.check() : html`<span></span>`}
            </div>`,
        )}
      </div>`
    : nothing}
  ${keys.has("deviceLimit.confirmTitle") && pick
    ? html`<div class="callout" data-part="confirm">
        <span class="callout-title"
          >${text(c, "deviceLimit.confirmTitle", {
            device: pick.name ?? "",
          })}</span
        >
        ${keys.has("deviceLimit.consequence")
          ? html`<span
              >${text(c, "deviceLimit.consequence", {
                device: pick.name ?? "",
                thisDevice: plain(c, "part.thisDevice", {
                  formFactor: c.input.platform?.formFactor ?? "computer",
                }),
              })}</span
            >`
          : nothing}
      </div>`
    : nothing}`;
}

function radioKeys(
  e: KeyboardEvent,
  c: RenderCtx,
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
    const host = (e.currentTarget as HTMLElement).parentElement;
    queueMicrotask(() =>
      (host?.children[next] as HTMLElement | undefined)?.focus(),
    );
  }
}

/** "today", "yesterday", "3 days ago": passed to the copy as text (dates are the caller's). */
function days(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  return rtf.format(-n, "day");
}

const ORIGIN_KEY: Readonly<Record<string, string>> = {
  store: "signin.choice.origin.store",
  key: "signin.choice.origin.keyAdded",
  free: "signin.choice.origin.free",
  developer: "signin.choice.origin.developer",
  signin: "signin.choice.origin.signIn",
};

function licenseRows(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  const view = c.input.choices;
  const rows = view?.choices ?? [];
  const selected = c.input.selected ?? view?.preselected ?? null;
  // A row of its own for keep, create and a first automatic license (never blurred, Must not).
  const special = (
    key: string,
    meta: string | null,
    tag: string | null,
    id: string,
  ) =>
    html`<div
      class="row"
      role="radio"
      data-part="license-row"
      tabindex="0"
      aria-checked=${selected === id || c.view.state === "new"
        ? "true"
        : "false"}
      @click=${() => c.pick(id)}
    >
      <span></span>
      <span>
        <span class="row-title" data-key=${key}>${text(c, key)}</span>
        ${tag && keys.has(tag)
          ? html` <span class="pill" data-key=${tag}>${text(c, tag)}</span>`
          : nothing}
        ${meta && keys.has(meta)
          ? html`<br /><span class="meta" data-key=${meta}
                >${text(c, meta)}</span
              >`
          : nothing}
      </span>
      ${GLYPHS.check()}
    </div>`;
  if (c.view.state === "keep")
    return html`<div class="list" role="radiogroup">
      ${special("signin.choice.keep", "signin.choice.keepMeta", null, "keep")}
    </div>`;
  if (c.view.state === "create")
    return html`<div class="list" role="radiogroup">
      ${special(
        "signin.choice.create",
        "signin.choice.createMeta",
        null,
        "create",
      )}
    </div>`;
  if (c.view.state === "new")
    return html`<div class="list" role="radiogroup">
      <div
        class="row"
        role="radio"
        aria-checked="true"
        data-part="license-row"
        tabindex="0"
      >
        <span class="pill">${String(c.view.args.tier ?? "")}</span>
        <span>
          <span class="row-title" data-key="signin.choice.metaNew"
            >${text(c, "signin.choice.metaNew")}</span
          >
          <span class="pill" data-key="signin.choice.tag.new"
            >${text(c, "signin.choice.tag.new")}</span
          >
        </span>
        ${GLYPHS.check()}
      </div>
    </div>`;
  const tagged = ["signin.choice.tag.current", "signin.choice.tag.full"].filter(
    (k) => keys.has(k),
  );
  if (!keys.has("signin.choice.group") && tagged.length === 0) return nothing;
  const shownRows = keys.has("signin.choice.group")
    ? rows
    : rows.filter(
        (r) =>
          (keys.has("signin.choice.tag.current") && r.current) ||
          (keys.has("signin.choice.tag.full") && r.state !== "free"),
      );
  return html`<div
    class="list pk-stagger"
    role="radiogroup"
    aria-label=${keys.has("signin.choice.group")
      ? plain(c, "signin.choice.group")
      : ""}
    data-part="license-list"
    data-key=${ifDefined(
      keys.has("signin.choice.group") ? "signin.choice.group" : undefined,
    )}
  >
    ${shownRows.map((r, i) => {
      const full = r.state !== "free";
      const on = r.id === selected || (selected === null && i === 0 && !full);
      const origin = ORIGIN_KEY[r.origin];
      const term =
        r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until";
      const date = r.expiresAt
        ? new Date(r.expiresAt * 1000).toLocaleDateString(c.copy.locale)
        : "";
      const metaArgs = {
        origin: origin && keys.has(origin) ? plain(c, origin) : "",
        term: keys.has(term) ? plain(c, term, { date }) : "",
      };
      return html`<div
        class="row"
        role=${full ? "group" : "radio"}
        data-part="license-row"
        tabindex=${full ? "-1" : on ? "0" : "-1"}
        aria-checked=${ifDefined(full ? undefined : on ? "true" : "false")}
        @click=${() => (full ? undefined : c.pick(r.id))}
      >
        <span class="pill">${r.tierName}</span>
        <span>
          ${keys.has("signin.choice.devices") && r.seats.limit !== null
            ? html`<span class="row-title num"
                  >${text(c, "signin.choice.devices", {
                    used: r.seats.used,
                    limit: r.seats.limit,
                  })}</span
                ><br />`
            : nothing}
          ${keys.has("signin.choice.meta")
            ? html`<span class="meta"
                >${metaArgs.origin
                  ? text(c, "signin.choice.meta", metaArgs)
                  : metaArgs.term}</span
              >`
            : nothing}
          ${full && keys.has("signin.choice.tag.full")
            ? html` <span class="pill" data-key="signin.choice.tag.full"
                >${text(c, "signin.choice.tag.full")}</span
              >`
            : nothing}
          ${r.current && keys.has("signin.choice.tag.current")
            ? html` <span class="pill" data-key="signin.choice.tag.current"
                >${text(c, "signin.choice.tag.current")}</span
              >`
            : nothing}
        </span>
        ${on ? GLYPHS.check() : html`<span></span>`}
      </div>`;
    })}
  </div>`;
}

/** "3 days ago", "last month": a relative time from epoch seconds (the server's `lastSeen`). */
function since(epochSeconds: number, locale: string): string {
  const days = Math.max(
    0,
    Math.floor((Date.now() - epochSeconds * 1000) / 86_400_000),
  );
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (days < 45) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}

/** The Replace step (SIGN-IN.md §3.7): the license's devices, the least recent preselected, and
 *  the one confirm under the list that names the picked device. */
function replaceRows(c: RenderCtx): TemplateResult | typeof nothing {
  const rv = c.input.replaceView;
  if (!rv) return nothing;
  const keys = new Set(c.view.copy);
  const pickId = (c.input as { replacePick?: string }).replacePick;
  const devices = rv.devices;
  const pick =
    devices.find((d) => d.id === pickId) ??
    devices.find((d) => d.leastRecent) ??
    devices[0];
  const name = (d: (typeof devices)[number]) =>
    d.label ?? plain(c, "devices.unnamed");
  const thisDevice = plain(c, "part.thisDevice", {
    formFactor: c.input.platform?.formFactor ?? "computer",
  });
  const tag = (k: string) =>
    html` <span class="pill" data-key=${k}>${text(c, k)}</span>`;
  return html`<div
      class="list pk-stagger"
      role="radiogroup"
      aria-labelledby="pk-title"
      data-part="device-list"
    >
      ${devices.map(
        (d, i) =>
          html`<div
            class="row"
            role="radio"
            part="device-row"
            data-part="device-row"
            tabindex=${d === pick ? "0" : "-1"}
            aria-checked=${d === pick ? "true" : "false"}
            @click=${() => c.pick(d.id)}
            @keydown=${(e: KeyboardEvent) =>
              radioKeys(e, c, i, devices.length, (n) => devices[n]!.id)}
          >
            <span
              role="img"
              aria-label=${plain(c, "a11y.formFactor", {
                formFactor: d.deviceType ?? "other",
              })}
              >${GLYPHS.device(d.deviceType)}</span
            >
            <span>
              <span class="row-title"><bdi>${name(d)}</bdi></span
              >${d.leastRecent
                ? tag("signin.replace.leastRecent")
                : nothing}${d.activeNow
                ? tag("signin.replace.activeNow")
                : nothing}${d.thisBrowser
                ? tag("signin.replace.thisBrowser")
                : nothing}<br />
              <span class="meta"
                >${text(c, "signin.replace.meta", {
                  platform: platformLabel(d.platform),
                  when: since(d.lastSeen, c.copy.locale),
                })}</span
              >
            </span>
            ${d === pick ? GLYPHS.check() : html`<span></span>`}
          </div>`,
      )}
    </div>
    ${pick && keys.has("signin.replace.title")
      ? html`<div class="callout" data-part="confirm" role="status">
          <span class="callout-title" data-key="signin.replace.title"
            >${text(c, "signin.replace.title", { device: name(pick) })}</span
          >
          ${keys.has("signin.replace.consequence")
            ? html`<span data-key="signin.replace.consequence"
                >${text(c, "signin.replace.consequence", {
                  device: name(pick),
                  thisDevice,
                })}</span
              >`
            : nothing}
          ${pick.activeNow
            ? html`<span class="message" data-tone="warning"
                >${text(c, "signin.replace.inUse", {
                  device: name(pick),
                })}</span
              >`
            : nothing}
        </div>`
      : nothing}`;
}

function deviceRows(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  if (keys.has("devices.renameLabel")) {
    const device = String(c.view.args.device ?? "");
    return html`<div class="field" data-part="rename">
      <label class="label" for="pk-rename"
        >${text(c, "devices.renameLabel")}</label
      >
      <div class="field-row">
        <input
          id="pk-rename"
          .value=${device}
          data-key="devices.renameLabel"
          autocomplete="off"
        />
        ${keys.has("common.save")
          ? button(
              c,
              "common.save",
              c.view.decisions.primary === "common.save"
                ? "primary"
                : "secondary",
            )
          : nothing}
        ${keys.has("common.cancel")
          ? button(c, "common.cancel", "secondary")
          : nothing}
      </div>
    </div>`;
  }
  if (keys.has("devices.removeConfirm"))
    return html`<div class="callout" data-part="confirm">
      <span>${text(c, "devices.removeConfirm")}</span>
      <div class="actions" data-layout="row">
        ${button(c, "devices.remove", "danger")}
        ${button(c, "common.cancel", "secondary")}
      </div>
    </div>`;
  if (!keys.has("devices.meta")) return nothing;
  const list = c.input.devices ?? [];
  return html`<ul class="list" data-part="device-list">
    ${list.map(
      (d) =>
        html`<li class="row" part="device-row" data-part="device-row">
          <span
            role="img"
            aria-label=${plain(c, "a11y.formFactor", {
              formFactor: d.formFactor ?? "other",
            })}
            >${GLYPHS.device(d.formFactor)}</span
          >
          <span>
            <span class="row-title"
              >${d.name
                ? html`<bdi>${d.name}</bdi>`
                : text(c, "devices.unnamed")}</span
            ><br />
            <span class="meta">
              ${d.current && keys.has("part.thisDeviceTitle")
                ? html`${text(c, "part.thisDeviceTitle", {
                    formFactor: d.formFactor ?? "other",
                  })}
                  · `
                : nothing}
              ${text(c, "devices.meta", {
                platform: platformLabel(d.platform),
                when: days(d.lastSeenDays),
              })}
            </span>
          </span>
          <span class="row-actions">
            ${button(c, "devices.rename", "link", {
              label: plain(c, "a11y.renameDevice", { device: d.name ?? "" }),
            })}
            ${d.current
              ? nothing
              : button(c, "devices.remove", "link", {
                  label: plain(c, "a11y.removeDevice", {
                    device: d.name ?? "",
                  }),
                })}
          </span>
        </li>`,
    )}
  </ul>`;
}

function releaseNotes(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  if (!keys.has("releaseNotes.version")) return nothing;
  return html`<div class="texts" data-part="notes">
    ${(c.input.releaseNotes ?? []).map(
      (n) =>
        html`<article class="texts" data-part="note">
          <h2 class="title" data-size="section">
            ${text(c, "releaseNotes.version", { version: n.version })}
          </h2>
          ${keys.has("releaseNotes.released")
            ? html`<span class="meta"
                >${text(c, "releaseNotes.released", { date: n.date })}</span
              >`
            : nothing}
          ${n.notes
            .split(/\n+/)
            .map((line) => html`<p class="body">${line}</p>`)}
        </article>`,
    )}
  </div>`;
}

/** A config row as the kit takes it: ui-core's row plus the catalog entry's `label`, when the
 *  adapter passes it (every product catalog entry has one). */
type SettingsRow = NonNullable<RenderCtx["input"]["config"]>[number] & {
  label?: string;
};

/** A setting's name: the catalog entry's label, else its key read as words (`audio.volume` →
 *  "Audio volume"), never the raw key (DL8). */
export function settingLabel(row: SettingsRow): string {
  if (row.label?.trim()) return row.label.trim();
  const phrase = row.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._\-\s/:]+/)
    .filter(Boolean)
    .map((w) => w.toLocaleLowerCase())
    .join(" ");
  return phrase ? phrase[0]!.toLocaleUpperCase() + phrase.slice(1) : row.key;
}

function settingsRows(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  const rows = (c.input.config ?? []) as SettingsRow[];
  const used = new Set<string>();
  const use = (k: string) => (keys.has(k) ? (used.add(k), true) : false);
  // Each row: its name, where its value comes from (or who set it), and the value at the end.
  const drawn = rows.map((r) => {
    const meta: TemplateResult[] = [];
    const from = r.locked
      ? r.org
        ? "settings.setBy"
        : "settings.setByGuardian"
      : `settings.source.${r.source}`;
    if (use(from))
      meta.push(
        html`<span data-key=${from}
          >${text(c, from, { org: r.org ?? "" })}</span
        >`,
      );
    if (
      r.type === "number" &&
      typeof r.min === "number" &&
      typeof r.max === "number" &&
      use("settings.range")
    )
      meta.push(
        html`<span data-key="settings.range"
          >${text(c, "settings.range", { min: r.min, max: r.max })}</span
        >`,
      );
    let value: unknown = nothing;
    if (typeof r.value === "boolean") {
      const k = r.value ? "settings.on" : "settings.off";
      use(k);
      value = html`<span data-key=${k}>${text(c, k)}</span>`;
    } else if (r.value !== undefined && r.value !== null)
      value = html`<bdi>${String(r.value)}</bdi>`;
    return html`<li class="row" part="settings-row" data-part="settings-row">
      <span class="row-text">
        <span class="row-title"><bdi>${settingLabel(r)}</bdi></span>
        ${meta.length
          ? html`<span class="meta"
              >${meta.map((m, i) => html`${i ? " · " : ""}${m}`)}</span
            >`
          : nothing}
      </span>
      <span class="row-value"
        >${r.locked && keys.has("a11y.locked")
          ? html`<span
              role="img"
              data-key="a11y.locked"
              aria-label=${plain(c, "a11y.locked")}
              >${GLYPHS.lock()}</span
            >`
          : nothing}${value}</span
      >
    </li>`;
  });
  // The provenance group's heading (B10: "From <Developer>" for what the person can change).
  const group = use("settings.fromDeveloper")
    ? html`<h2 class="label group-label" data-key="settings.fromDeveloper">
        ${text(c, "settings.fromDeveloper")}
      </h2>`
    : nothing;
  const search = use("settings.search")
    ? html`<div class="field" data-part="search">
        <input
          type="search"
          data-key="settings.search"
          aria-label=${plain(c, "settings.search")}
          placeholder=${plain(c, "settings.search")}
          autocomplete="off"
          @input=${(e: Event) =>
            c.edit("search", (e.target as HTMLInputElement).value)}
        />
      </div>`
    : nothing;
  // A key of the state no row carried (an "On" with no boolean row) still shows, once.
  const rest = [...keys].filter(
    (k) =>
      !used.has(k) &&
      (k.startsWith("settings.source.") ||
        k === "settings.on" ||
        k === "settings.off" ||
        k === "settings.setBy" ||
        k === "settings.setByGuardian" ||
        k === "settings.range"),
  );
  if (rows.length === 0 && rest.length === 0)
    return group === nothing && search === nothing
      ? nothing
      : html`${search}${group}`;
  return html`${search}
    <div class="group" data-part="settings-group">
      ${group}
      <ul class="list" data-part="settings-list">
        ${drawn}
      </ul>
      ${rest.length
        ? html`<p class="meta">
            ${rest.map(
              (k, i) =>
                html`${i ? " · " : ""}<span data-key=${k}>${text(c, k)}</span>`,
            )}
          </p>`
        : nothing}
    </div>`;
}

function accountRows(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = [
    "account.tier",
    "account.devices",
    "account.cloudSync",
    "account.updates",
    "account.autoUpdate",
    "account.channel",
    "account.version",
    "account.managedSettings",
  ].filter((k) => c.view.copy.includes(k));
  if (keys.length === 0) return nothing;
  return html`<ul class="list" data-part="account-list">
    ${keys.map(
      (k) =>
        html`<li class="row" data-part="settings-row">
          <span></span><span class="row-title" data-key=${k}>${text(c, k)}</span
          ><span></span>
        </li>`,
    )}
  </ul>`;
}

export { countdown };
