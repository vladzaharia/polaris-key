// One template per component form (screen, pane, banner, toast, inline) over `placeKeys`, plus the
// content a few components draw themselves: the key field, the user code, device and license
// rows, progress, release notes and settings rows. Every string is a key of the view (DL8).

import { html, nothing, type TemplateResult } from "lit";
import {
  settingKind,
  settingLabel,
  settingText,
  sliderStep,
  type SettingsRow,
} from "./settings.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { markSvg, poweredBySvg } from "@polaris-key/brand/svg";
import { platformVariant } from "@polaris-key/ui-core/theme";
import { POWERED_BY } from "@polaris-key/brand";
import {
  countdown,
  withRenew,
  type LicenseChoiceRow,
  type View,
} from "@polaris-key/ui-core";

import { copyPending } from "./copy.js";
import { LAYOUTS, dialogControls, type Layout } from "./layout.js";
import { platformLabel } from "./platforms.js";
import {
  actions,
  button,
  callout,
  a11yOnly,
  codeDisplay,
  nearbyCode,
  copyAddress,
  GLYPHS,
  qrCode,
  keyField,
  outOfRange,
  links,
  missingArgs,
  warnMissing,
  usable,
  paragraphs,
  placeKeys,
  plain,
  productHeader,
  productIcon,
  progressBar,
  seatMeter,
  shimmer,
  providerMark,
  successMark,
  text,
  titles,
  type RenderCtx,
} from "./render.js";

const ERROR_PREFIXES = ["core.codes.", "core.activation."];
const isErrorKey = (k: string) =>
  ERROR_PREFIXES.some((p) => k.startsWith(p)) ||
  /(Failed|\.failed|\.stale|methodError|\.error)$/.test(k);

/** Keys the content of a component draws itself. */
/** What scanning the key refusal's QR does, under the QR. */
function scanCaption(c: RenderCtx): TemplateResult | typeof nothing {
  return c.view.copy.includes("signin.key.scan")
    ? html`<p class="body" data-key="signin.key.scan">
        ${text(c, "signin.key.scan")}
      </p>`
    : nothing;
}

/** The automatic sign-in steps that end on their own button, so no Cancel beside it. */
const OWN_EXIT: ReadonlySet<string> = new Set([
  // The confirm ends on Continue and Use another account (ui-matrix v7, no Cancel); Escape is
  // its way out. The device limit lists its own Cancel.
  "confirm",
  "device-limit",
  "link-offer",
  "link-done",
  "link-conflict",
  "nearby-prompt",
  "nearby-done",
]);

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
      ].filter((k) => keys.has(k) && usable(c, k));
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
        "busy",
      ].includes(view.state);
      const used = input.activation?.deviceCount;
      const limit = input.activation?.limit;
      // The message under a refused key is linked to the field; only an input that is itself
      // wrong takes the stroke (DL7). A refusal of a well-formed key is a neutral callout (DL6),
      // as ui-core's tone says.
      const refused = view.state === "rejected" || view.state === "cut-short";
      const wrong = refused && view.decisions.tone === "danger";
      // The refusal a different key cannot fix has no field; a TV scans the add-key page instead.
      const addKey = view.decisions.link;
      return html`${qrCode(c, addKey?.qr ? addKey.url : null, "a11y.qrAddKey")}
      ${scanCaption(c)}
      ${editing
        ? keyField(
            c,
            invalid || wrong,
            verdict.length ? "pk-verdict" : refused ? "pk-message" : null,
          )
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
      // The address is shown as text whenever there is one (a no-browser device has only it).
      const shown = url?.display ?? url?.url?.replace(/^https?:\/\//, "");
      const showUrl = keys.has("signin.handoff.url") && shown;
      return html`${code} ${nearbyCode(c)}
      ${qrCode(
        c,
        url?.qr ? url.url : null,
        keys.has("a11y.qrAddKey") ? "a11y.qrAddKey" : "a11y.qr",
      )}
      ${scanCaption(c)}
      ${showUrl
        ? html`<p class="body" data-key="signin.handoff.url">
            ${text(c, "signin.handoff.url", { url: shown as string })}
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
      return offlineSteps(c);
    case "UpdatePrompt":
      return updateNotes(c);
    case "ChannelPicker":
      return channelRows(c);
    case "Paywall":
      return offerRows(c);
    case "AccountAndLicense":
      return accountRows(c);
    default:
      return nothing;
  }
}

/** The download's percent, beside its bar (the bar itself is named for assistive tech). */
function percentFor(c: RenderCtx): TemplateResult | typeof nothing {
  const f = c.input.update?.progress?.fraction;
  if (c.view.component !== "UpdatePrompt" || c.view.state !== "downloading")
    return nothing;
  if (typeof f !== "number") return nothing;
  const pct = new Intl.NumberFormat(c.resolved.locale, {
    style: "percent",
  }).format(Math.max(0, Math.min(1, f)));
  return html`<p class="meta percent" aria-hidden="true">${pct}</p>`;
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
  // A counted download draws its bar wherever its line shows (a toast, the inline progress).
  if (
    p?.fraction !== undefined &&
    (view.component === "Toast" || view.component === "UpdateProgress")
  )
    return progressBar(c, p.fraction);
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
  // One form, one card width: a step of the sign-in form splits like its first step does.
  const split = layout.split === true || c.form === true;
  const placed = placeKeys(view, layout);
  // Keys a component draws inside its own steps are not repeated as text or controls.
  const own: readonly string[] =
    view.component === "OfflineActivation" && view.state !== "done"
      ? [
          "offlineActivation.request",
          "offlineActivation.loadHint",
          "offlineActivation.copyCode",
          ...(docksLoadFile(c) ? [] : ["offlineActivation.loadFile"]),
          "offlineActivation.codeCopied",
          "offlineActivation.paste",
          "offlineActivation.dropHint",
        ]
      : [];
  const p = {
    ...placed,
    body: placed.body.filter((k) => !own.includes(k)),
    meta: placed.meta.filter((k) => !own.includes(k)),
    controls: placed.controls.filter((k) => !own.includes(k)),
  };
  // The device limit with no license rows (SIGN-IN §3.19): Replace a device, Use another account,
  // then Cancel as the quiet exit; its sentences read in the body, not in a callout.
  const limit = view.component === "SignIn" && view.state === "device-limit";
  if (limit) {
    p.controls = DEVICE_LIMIT_ACTIONS.filter((k) => view.copy.includes(k));
    p.links = view.copy.includes("common.cancel") ? ["common.cancel"] : [];
  }
  const errorKeys = limit ? [] : p.body.filter(isErrorKey);
  const body = limit ? p.body : p.body.filter((k) => !isErrorKey(k));
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
    role=${ifDefined(c.fill ? "main" : undefined)}
    data-kind="screen"
    ?data-split=${split}
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
        ${split && c.resolved.iconUrl
          ? html`<div class="passport-ambient" aria-hidden="true">
              <img src=${c.resolved.iconUrl} alt="" />
            </div>`
          : nothing}
        ${split && showIdentity
          ? html`<div class="panel-icon" aria-hidden="true">
              ${productIcon(c)}
            </div>`
          : nothing}
      </div>
      ${showIdentity
        ? productHeader(c, layout.header, {
            name: !titleNames,
            // The hero reads icon, title, then "by Developer" (below the title).
            developer: !heroTitle && view.copy.includes("common.byDeveloper"),
          })
        : nothing}
      ${view.component === "SignIn" &&
      (view.state === "done" || view.state === "link-done")
        ? successMark()
        : view.component === "SignIn" &&
            view.state === "link-offer" &&
            c.input.provider === "Google"
          ? providerMark()
          : nothing}
      <div class="texts" data-part="texts">
        ${titles(
          c,
          p.titles,
          heroTitle ? "display" : "title",
          layout.subtitles,
        )}
        ${heroTitle && view.copy.includes("common.byDeveloper")
          ? html`<p
              class="by"
              data-part="developer"
              data-key="common.byDeveloper"
            >
              ${text(c, "common.byDeveloper")}
            </p>`
          : nothing}
        ${view.component === "SignIn" && view.state === "confirm"
          ? consentBody(c, body)
          : paragraphs(
              c,
              body.filter((k) => k !== "common.byDeveloper"),
            )}
        ${statusLine(c, p.meta)}
      </div>
      ${contentFor(c)} ${progressFor(c)} ${percentFor(c)}
      ${callout(c, errorKeys)}
      ${controlsAndLinks(c, p, view.component === "UpdatePrompt")}
      ${a11yOnly(c)}
      ${p.footnote.length ? paragraphs(c, p.footnote, "footnote") : nothing}
      ${attribution(c, p.meta)}
    </div>
  </section>`;
}

const DEVICE_LIMIT_ACTIONS = [
  "signin.deviceLimit.replace",
  "signin.auto.confirm.other",
];

/** The confirm step's body (SIGN-IN §3.19): "as {email}" under the title, then each group as a
 *  small muted label over its value, the license line strong. */
function consentBody(c: RenderCtx, keys: string[]): TemplateResult {
  const has = (k: string) => keys.includes(k);
  const sub = keys.find((k) => k.startsWith("signin.auto.confirm.as"));
  const used = new Set<string>();
  const label = (k: string) => {
    used.add(k);
    return has(k)
      ? html`<p class="consent-label" data-part="consent-label" data-key=${k}>
          ${text(c, k)}
        </p>`
      : nothing;
  };
  const line = (k: string, cls: string) => {
    used.add(k);
    return has(k)
      ? html`<p class=${cls} data-part=${cls} data-key=${k}>${text(c, k)}</p>`
      : nothing;
  };
  if (sub) used.add(sub);
  const license = [
    label("signin.consent.license"),
    line("signin.consent.newLicense", "consent-line"),
    line("signin.consent.licenseLine", "consent-line"),
  ];
  const also = [
    label("signin.consent.alsoGets"),
    line("signin.consent.profile", "consent-value"),
    line("signin.consent.pairwise", "consent-note"),
  ];
  const rest = keys.filter((k) => !used.has(k) && k !== "common.byDeveloper");
  return html`${sub
      ? html`<p class="subtitle" data-part="subtitle" data-key=${sub}>
          ${text(c, sub)}
        </p>`
      : nothing}
    <div class="consent" data-part="consent">
      ${license.some((x) => x !== nothing)
        ? html`<div class="consent-group">${license}</div>`
        : nothing}
      ${also.some((x) => x !== nothing)
        ? html`<div class="consent-group">${also}</div>`
        : nothing}
      ${rest.length ? paragraphs(c, rest) : nothing}
    </div>`;
}

/** The meta line of a screen or pane: its keys joined by a middle dot, announced politely. A
 *  ticking countdown is not a live region (a screen reader would read it every second). */
function statusLine(
  c: RenderCtx,
  keys: string[],
): TemplateResult | typeof nothing {
  if (keys.length === 0) return nothing;
  const ticking: string[] = keys.filter((k) => k === "signin.handoff.expires");
  const live = keys.filter((k) => !ticking.includes(k) && k !== POWERED_BY_KEY);
  return html`${ticking.map(
    (k) =>
      html`<p class="status-line" data-part="countdown">
        <span data-key=${k}>${text(c, k)}</span>
      </p>`,
  )}${live.length
    ? html`<p class="status-line" data-part="status" role="status">
        ${live.map(
          (k, i) =>
            html`${i ? " · " : ""}<span data-key=${k}>${text(c, k)}</span>`,
        )}
      </p>`
    : nothing}`;
}

const POWERED_BY_KEY = "part.poweredBy";

/** The attribution at the foot of a pane or screen, when the view carries it (UI-KITS §1.6). */
function attribution(
  c: RenderCtx,
  meta: string[],
): TemplateResult | typeof nothing {
  return meta.includes(POWERED_BY_KEY) ? poweredBy(c) : nothing;
}

/**
 * The optional attribution (UI-KITS §1.6): `<Locker micro mark, 16 px> Powered by Polaris Locker`
 * in live text, or, for `poweredBy: "badge"`, the Locker `powered-by` badge where 320 px is free
 * (a container query on the wrapper) and the line where it is not. The badge's art carries the
 * phrase, so it is the one accessible name and the line is hidden from assistive technology there.
 */
function poweredBy(c: RenderCtx): TemplateResult {
  const scheme = c.resolved.theme.scheme;
  const badge =
    c.input.integrator?.poweredBy === "badge" && c.view.component === "About";
  const line = html`<p
    class="status-line powered-by-line"
    data-part="powered-by"
  >
    ${unsafeHTML(
      markSvg({
        kind: "locker",
        size: POWERED_BY.markSize,
        theme: scheme,
        title: "",
      }),
    )}<span data-key=${POWERED_BY_KEY}>${text(c, POWERED_BY_KEY)}</span>
  </p>`;
  if (!badge) return line;
  return html`<div class="powered-by" data-variant="badge">
    <div class="powered-by-badge" data-part="powered-by-badge">
      ${unsafeHTML(
        poweredBySvg({
          theme: scheme,
          title: plain(c, POWERED_BY_KEY),
        }),
      )}
    </div>
    ${line}
  </div>`;
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
      ${titles(c, p.titles, "section", [], 2)} ${paragraphs(c, body)}
      ${statusLine(c, p.meta)}
    </div>
    ${loading
      ? html`<div class="skeleton" aria-hidden="true">
          <span></span><span data-short></span>
        </div>`
      : nothing}
    ${locked(c)} ${contentFor(c)} ${progressFor(c)} ${callout(c, errorKeys)}
    ${actions(c, p.controls, true)} ${links(c, p.links)} ${a11yOnly(c)}
    ${attribution(c, p.meta)}
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
    return s === "error" && view.decisions.tone === "neutral"
      ? GLYPHS.info()
      : s === "offline"
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
    // A sync that failed for want of a sign-in is neutral, not a fault (DL6).
    return view.state === "error" && view.decisions.tone === "neutral"
      ? "neutral"
      : view.state === "conflict" || view.state === "error"
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

/** The keys a component's base layout always shows, whatever the state adds on top (the review's
 *  "additive" rule). ui-core's per-state views carry only a state's own keys, and the corpus pins
 *  them, so the elements add the base here, for drawing only. */
function withBase(c: RenderCtx): View {
  const { view, input } = c;
  const add = (...keys: string[]): View => {
    const copy = [...view.copy];
    for (const k of keys) if (c.copy.has(k) && !copy.includes(k)) copy.push(k);
    return { ...view, copy };
  };
  switch (view.component) {
    case "LicenseChoice": {
      // The Replace step confirms on its own button: its "Replace a device" openers are gone.
      if (view.state === "replace-open")
        return {
          ...view,
          copy: view.copy.filter(
            (k) =>
              k !== "signin.replace.open" && k !== "signin.replace.openSystem",
          ),
        };
      const ch = input.choices;
      if (!ch || !CHOICE_STATES.has(view.state)) return view;
      const web = input.platform?.os === "web";
      const rowKeys: string[] = [];
      for (const r of ch.choices) {
        const o = ORIGIN_KEY[r.origin];
        if (o) rowKeys.push(o);
        rowKeys.push(
          r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until",
        );
      }
      const keyInstead =
        input.capabilities?.keyEntry !== false &&
        ch.getLicense?.keyEntry !== false;
      const lede =
        view.state === "all-full" || view.state === "raced"
          ? []
          : [
              view.state === "new"
                ? "signin.choice.ledeNew"
                : web
                  ? "signin.choice.ledeBrowser"
                  : "signin.choice.lede",
            ];
      // Each full license draws its own Replace a device, carrying the license.
      const rowReplace =
        (view.state === "all-full" || view.state === "mixed") &&
        ch.choices.some((r) => r.state !== "free" && r.replace?.allowed);
      const base = add(
        "signin.choice.title",
        ...lede,
        "signin.choice.group",
        "signin.choice.meta",
        "signin.choice.devices",
        "signin.choice.tag.current",
        "signin.choice.tag.full",
        ...rowKeys,
        "common.cancel",
        // Every license full and none replaceable: Use another account (SIGN-IN §3.19).
        ...(view.copy.includes("signin.choice.noneReplaceable")
          ? ["signin.auto.confirm.other"]
          : keyInstead
            ? ["signin.choice.keyInstead"]
            : []),
      );
      // One lede: the browser's, where the form runs in one (the model's own names the desktop).
      const one = (v: View): View =>
        v.copy.includes("signin.choice.ledeBrowser")
          ? { ...v, copy: v.copy.filter((k) => k !== "signin.choice.lede") }
          : v;
      if (rowReplace)
        return one({
          ...base,
          copy: base.copy.filter((k) => k !== "signin.replace.open"),
          decisions: {
            ...base.decisions,
            primary:
              base.decisions.primary === "signin.replace.open"
                ? null
                : base.decisions.primary,
          },
        });
      // Keep and Create are rows of the list, not buttons, wherever the list can be chosen from.
      return view.state === "all-full"
        ? one(base)
        : one({
            ...base,
            copy: base.copy.filter(
              (k) => k !== "signin.choice.keep" && k !== "signin.choice.create",
            ),
          });
    }
    case "SignInHandoff": {
      // The code step: how long the code lasts, that it waits, and a Cancel to leave by.
      if (view.state !== "code") return view;
      return add(
        ...(view.args.time !== undefined ? ["signin.handoff.expires"] : []),
        "cli.signin.waitingCode",
        "common.cancel",
      );
    }
    case "SignIn": {
      // The form ends on a heading and one Start; every other step can be backed out of (DL2).
      if (view.state === "done") {
        const licensed = !input.services || input.services.includes("license");
        if (!licensed) return view;
        // One heading: the tier line replaces the short one.
        const done = add(
          ...(view.copy.includes("signin.return.signedInTier")
            ? []
            : ["signin.return.signedInShort"]),
          "signin.done.start",
        );
        return {
          ...done,
          decisions: { ...done.decisions, primary: "signin.done.start" },
        };
      }
      const sheet = input.signIn?.presentation === "sheet";
      // Steps with their own way on (an offer's No thanks, an outcome's Continue) have no Cancel:
      // after a sign-in it would read as undoing it.
      const step =
        (view.state === "methods" && !sheet) || OWN_EXIT.has(view.state)
          ? view
          : add("common.cancel");
      // No "or" divider over the providers (DL4), and no "Sign in…" link on the sign-in step.
      return step.state === "methods" || step.state === "error"
        ? {
            ...step,
            copy: step.copy.filter(
              (k) =>
                k !== "signin.provider.group" && k !== "signin.menu.signIn",
            ),
          }
        : step;
    }
    case "Activate": {
      if (
        ["empty", "typing", "parsed", "cut-short", "rejected"].includes(
          view.state,
        )
      ) {
        // ui-core carries the base (title, lede, field, Paste); the kit adds Submit and Back.
        return add("activate.submit", "common.back");
      }
      // Over the limit the key is right: Back, or another key.
      if (view.state === "device-limit")
        return add("common.back", "signin.key.differentKey");
      if (view.state === "done") {
        const done = add("common.done");
        return {
          ...done,
          decisions: { ...done.decisions, primary: "common.done" },
        };
      }
      return view;
    }
    case "Devices": {
      if (
        !input.devices?.length ||
        !["renaming", "confirming"].includes(view.state)
      )
        return {
          ...view,
          copy: view.copy.filter((k) => k !== "devices.lede"),
        };
      return add(
        "devices.title",
        "devices.meta",
        "a11y.formFactor",
        "devices.rename",
        "devices.remove",
        "a11y.renameDevice",
        "a11y.removeDevice",
      );
    }
    case "Settings": {
      const titled = ["dirty", "locked", "saving"].includes(view.state)
        ? add("settings.title")
        : view;
      // Reset to default waits for a change of the person's; Show advanced for an advanced row.
      const rows = input.config ?? [];
      const gone = new Set<string>([
        ...(rows.some((r) => r.source === "local") ? [] : ["settings.reset"]),
        ...(rows.some((r) => r.advanced) ? [] : ["settings.advanced"]),
      ]);
      return gone.size === 0
        ? titled
        : { ...titled, copy: titled.copy.filter((k) => !gone.has(k)) };
    }
    case "UpdatePrompt": {
      const notes = input.releaseNotes ?? [];
      if (view.state === "downloading")
        // The download keeps its title: what is coming.
        return add(
          input.update?.version ? "update.title" : "update.availableTitle",
        );
      if (view.state !== "available" && view.state !== "ready") return view;
      // Restart when ready queues the restart of a download in flight (UI-KITS.md §4.1): an
      // available update offers Update now and Later.
      const noRestart = (copy: string[]) =>
        view.state === "available"
          ? copy.filter((k) => k !== "update.restartWhenReady")
          : copy;
      const kept = noRestart(
        notes.length === 0
          ? view.copy.filter((k) => k !== "update.whatsNew")
          : view.copy,
      );
      // On the web the page cannot install: one Download action and Later, a title that says so.
      if (view.state === "available" && input.platform?.os === "web") {
        const gone = new Set([
          "update.title",
          "update.restartWhenReady",
          "update.skipVersion",
        ]);
        return {
          ...view,
          copy: [
            "update.availableTitle",
            ...kept.filter(
              (k) => !gone.has(k) && k !== "update.availableTitle",
            ),
          ],
        };
      }
      return { ...view, copy: kept };
    }
    default:
      return view;
  }
}

const CHOICE_STATES: ReadonlySet<string> = new Set([
  "mixed",
  "current",
  "keep",
  "new",
  "create",
  "raced",
  "one",
  "many",
  "all-full",
]);

/** Drop every key whose own arguments the input leaves unfilled: a missing fact is never drawn
 *  as `{name}`. */
function fillable(c: RenderCtx): View {
  const view = withRenew(withBase(c), c.input);
  if (view.component === "ReleaseNotes") return view;
  // A content key is drawn by the component's own rows, which pass its arguments at the call.
  const content = new Set(LAYOUTS[view.component].content ?? []);
  const copy = view.copy.filter((k) => {
    if (k.startsWith("a11y.") || content.has(k)) return true;
    const lost = missingArgs({ ...c, view }, k);
    if (lost.length) warnMissing(k, lost);
    return lost.length === 0;
  });
  const primary = view.decisions.primary;
  // A primary that rides outside the copy list (a busy control) goes too when its label is lost.
  const keepPrimary =
    primary === null ||
    (copy.includes(primary)
      ? true
      : view.copy.includes(primary)
        ? false
        : usable({ ...c, view }, primary));
  if (copy.length === view.copy.length && keepPrimary) return view;
  return {
    ...view,
    copy,
    decisions: { ...view.decisions, primary: keepPrimary ? primary : null },
  };
}

/** Draw one view in its component's form; `hidden` draws nothing. */
export function renderView(ctx: RenderCtx): TemplateResult | typeof nothing {
  if (ctx.view.state === "hidden") return nothing;
  // DL7: a loading state inside its delay shows nothing at all (its view carries no copy yet).
  if (isLoading(ctx.view) && ctx.view.copy.length === 0) return nothing;
  // English's second table (the screens that follow a network answer, `LAZY_EN_PREFIXES`) is
  // still loading: draw nothing rather than a missing string (any other missing key throws, as
  // before). The element redraws when it arrives.
  if (ctx.view.copy.some((k) => !ctx.copy.has(k) && copyPending(k)))
    return nothing;
  const c: RenderCtx = { ...ctx, view: fillable(ctx) };
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

// ── Controls the panes share ─────────────────────────────────────────────────────────────────

type Drafts = { drafts?: Record<string, unknown> };
const draftsOf = (c: RenderCtx): Record<string, unknown> =>
  (c.input as Drafts).drafts ?? {};

let uid = 0;
/** A switch: a button with role=switch, named by its label, flipping on Space or Enter. */
function switchControl(
  c: RenderCtx,
  label: TemplateResult | string,
  on: boolean,
  change: (next: boolean) => void,
  options: { disabled?: boolean; name?: string } = {},
): TemplateResult {
  const id = `pk-sw-${++uid}`;
  return html`<span class="switch-wrap">
    <span id=${id} class="visually-hidden">${label}</span>
    <button
      type="button"
      class="switch"
      role="switch"
      part="switch"
      data-part="switch"
      aria-checked=${on ? "true" : "false"}
      aria-labelledby=${id}
      aria-disabled=${ifDefined(options.disabled ? "true" : undefined)}
      @click=${() => {
        if (!options.disabled) change(!on);
      }}
    >
      <span class="switch-thumb"></span>
    </button>
  </span>`;
}

/** A segmented choice: a radiogroup of buttons, arrows move the choice. */
function segmented(
  c: RenderCtx,
  name: string,
  options: { id: string; label: string }[],
  current: string | undefined,
  pick: (id: string) => void,
  disabled = false,
): TemplateResult {
  const at = Math.max(
    0,
    options.findIndex((o) => o.id === current),
  );
  return html`<div
    class="segmented"
    role="radiogroup"
    part="segmented"
    data-part="segmented"
    aria-label=${name}
  >
    ${options.map(
      (o, i) =>
        html`<button
          type="button"
          role="radio"
          data-id=${o.id}
          aria-checked=${i === at ? "true" : "false"}
          aria-disabled=${ifDefined(disabled ? "true" : undefined)}
          tabindex=${i === at ? "0" : "-1"}
          @click=${() => {
            if (!disabled) pick(o.id);
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (disabled) return;
            const step =
              e.key === "ArrowRight" || e.key === "ArrowDown"
                ? 1
                : e.key === "ArrowLeft" || e.key === "ArrowUp"
                  ? -1
                  : 0;
            if (!step) return;
            e.preventDefault();
            const next = options[(i + step + options.length) % options.length]!;
            pick(next.id);
            const group = (e.currentTarget as HTMLElement).parentElement;
            queueMicrotask(() =>
              group
                ?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)
                ?.focus(),
            );
          }}
        >
          ${o.label}
        </button>`,
    )}
  </div>`;
}

/** "Stable" from a channel id: the kit has no channel names, the host's ids read as words. */
const channelLabel = (id: string): string =>
  id ? id[0]!.toLocaleUpperCase() + id.slice(1) : id;

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

function deviceLimitContent(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  const used =
    c.input.activation?.deviceCount ?? c.input.replaceView?.seats.used;
  const limit =
    c.input.activation?.limit ?? c.input.replaceView?.seats.limit ?? undefined;
  const devices = c.input.devices ?? [];
  const link = c.view.decisions.link;
  const qr = qrCode(c, link?.qr ? link.url : null, "a11y.qrManage");
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
  // The subhead states the count ("Your license is on 3 of 3 devices"): the meter is the picture.
  const captioned = !keys.has("deviceLimit.heading");
  return html`${qr}${keys.has("part.seatMeter.caption") &&
  used !== undefined &&
  limit != null
    ? seatMeter(c, used, limit, captioned)
    : nothing}
  ${keys.has("signin.replace.meta")
    ? html`<div
        class="list"
        role="radiogroup"
        aria-labelledby="pk-title"
        data-part="device-list"
        ?data-scroll=${devices.length > 6}
      >
        ${devices.map(
          (d, i) =>
            html`<div
              class="row"
              role="radio"
              part="device-row"
              data-part="device-row"
              data-id=${String(i)}
              tabindex=${i === selected ? "0" : "-1"}
              aria-checked=${i === selected ? "true" : "false"}
              @click=${() => c.pick(String(i))}
              @keydown=${(e: KeyboardEvent) => radioKeys(e, c)}
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
                <span class="row-title"
                  >${d.name
                    ? html`<bdi>${d.name}</bdi>`
                    : text(c, "devices.unnamed")}</span
                >${i === leastRecent && keys.has("signin.replace.leastRecent")
                  ? html` <span
                      class="pill"
                      data-key="signin.replace.leastRecent"
                      >${text(c, "signin.replace.leastRecent")}</span
                    >`
                  : nothing}<br />
                <span class="meta">
                  ${text(c, "signin.replace.meta", {
                    platform: platformLabel(d.platform, c.copy),
                    when: days(d.lastSeenDays),
                  })}
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

/** Arrow keys move the choice among the group's radios (and the roving focus with it); Space
 *  and Enter choose the focused one. Each radio names its id in `data-id`. */
function radioKeys(e: KeyboardEvent, c: RenderCtx): void {
  const row = e.currentTarget as HTMLElement;
  const radios = [
    ...(row.parentElement?.querySelectorAll<HTMLElement>(
      '[role="radio"]:not([aria-disabled="true"])',
    ) ?? []),
  ];
  const i = radios.indexOf(row);
  const n = radios.length;
  const next =
    e.key === "ArrowDown" || e.key === "ArrowRight"
      ? (i + 1) % n
      : e.key === "ArrowUp" || e.key === "ArrowLeft"
        ? (i - 1 + n) % n
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? n - 1
            : null;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    c.pick(row.dataset.id ?? "");
  } else if (next !== null && i >= 0) {
    e.preventDefault();
    const target = radios[next]!;
    c.pick(target.dataset.id ?? "");
    queueMicrotask(() => target.focus());
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

type Entry =
  | { kind: "license"; id: string; row: LicenseChoiceRow }
  | { kind: "keep" | "create" | "new"; id: string; tier?: string };

/** The base anatomy of the license step in every state: the radiogroup of every license (and the
 *  keep, create and first-license rows), drawn from `input.choices` whatever the state adds. */
function licenseRows(c: RenderCtx): TemplateResult | typeof nothing {
  const ch = c.input.choices;
  if (!ch) return nothing;
  const has = (k: string) => c.copy.has(k);
  const entries: Entry[] = [
    ...(ch.state === "autoIssue" && ch.create
      ? [{ kind: "new" as const, id: "new", tier: ch.create.tierName }]
      : []),
    ...(ch.keep ? [{ kind: "keep" as const, id: "keep" }] : []),
    ...ch.choices.map((row) => ({
      kind: "license" as const,
      id: row.id,
      row,
    })),
    ...(ch.create && ch.state !== "autoIssue" && c.view.state !== "all-full"
      ? [{ kind: "create" as const, id: "create", tier: ch.create.tierName }]
      : []),
  ];
  if (entries.length === 0) return nothing;
  const selectable = (e: Entry) =>
    e.kind !== "license" || e.row.state === "free";
  const first = entries.find(selectable);
  const wanted = c.input.selected ?? ch.preselected ?? null;
  const selected = entries.some((e) => e.id === wanted && selectable(e))
    ? wanted
    : (first?.id ?? null);
  const allFull = !entries.some(selectable);
  const fullRows = entries.filter((e) => !selectable(e));
  const lone = allFull && fullRows.length === 1;
  const tag = (k: string) =>
    has(k)
      ? html` <span class="pill" data-key=${k}>${text(c, k)}</span>`
      : nothing;
  const check = (on: boolean) => (on ? GLYPHS.check() : html`<span></span>`);
  const rowFor = (e: Entry): TemplateResult => {
    const on = e.id === selected;
    if (e.kind !== "license") {
      const [titleKey, metaKey, tagKey, pill] =
        e.kind === "keep"
          ? ["signin.choice.keep", "signin.choice.keepMeta", null, null]
          : e.kind === "create"
            ? ["signin.choice.create", "signin.choice.createMeta", null, e.tier]
            : ["signin.choice.metaNew", null, "signin.choice.tag.new", e.tier];
      return html`<div
        class="row"
        role="radio"
        part="license-row"
        data-part="license-row"
        data-id=${e.id}
        tabindex=${on ? "0" : "-1"}
        aria-checked=${on ? "true" : "false"}
        @click=${() => c.pick(e.id)}
        @keydown=${(ev: KeyboardEvent) => radioKeys(ev, c)}
      >
        ${pill ? html`<span class="pill">${pill}</span>` : html`<span></span>`}
        <span>
          <span class="row-title" data-key=${titleKey!}
            >${text(c, titleKey!)}</span
          >${tagKey ? tag(tagKey) : nothing}
          ${metaKey && has(metaKey)
            ? html`<br /><span class="meta" data-key=${metaKey}
                  >${text(c, metaKey)}</span
                >`
            : nothing}
        </span>
        ${check(on)}
      </div>`;
    }
    const r = e.row;
    const full = r.state !== "free";
    const origin = ORIGIN_KEY[r.origin];
    const term =
      r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until";
    const date = r.expiresAt
      ? new Date(r.expiresAt * 1000).toLocaleDateString(c.copy.locale)
      : "";
    const metaArgs = {
      // A store-origin row with no store name says nothing of its origin (never "From {store}").
      origin:
        origin && has(origin) && (r.origin !== "store" || r.store)
          ? plain(c, origin, r.store ? { store: r.store } : {})
          : "",
      term: has(term) ? plain(c, term, { date }) : "",
    };
    const meta = metaArgs.origin
      ? has("signin.choice.meta")
        ? text(c, "signin.choice.meta", metaArgs)
        : metaArgs.origin
      : metaArgs.term;
    const body = html`<span class="pill">${r.tierName}</span>
      <span>
        ${r.seats.limit !== null && has("signin.choice.devices")
          ? html`<span class="row-title num"
                >${text(c, "signin.choice.devices", {
                  used: r.seats.used,
                  limit: r.seats.limit,
                })}</span
              ><br />${seatMeter(c, r.seats.used, r.seats.limit, false)}`
          : nothing}
        <span class="meta-line"
          ><span class="meta">${meta}</span> ${full
            ? tag("signin.choice.tag.full")
            : nothing}
          ${r.current ? tag("signin.choice.tag.current") : nothing}</span
        >
      </span>`;
    if (!full)
      return html`<div
        class="row"
        role="radio"
        part="license-row"
        data-part="license-row"
        data-id=${r.id}
        tabindex=${on ? "0" : "-1"}
        aria-checked=${on ? "true" : "false"}
        @click=${() => c.pick(r.id)}
        @keydown=${(ev: KeyboardEvent) => radioKeys(ev, c)}
      >
        ${body} ${check(on)}
      </div>`;
    // A full license cannot be chosen. In a list that can be chosen from it is a disabled radio;
    // when every license is full, Replace a device is its action, carrying its license.
    const replaceHere = r.replace?.allowed && has("signin.replace.open");
    if (!allFull && !replaceHere)
      return html`<div
        class="row"
        role="radio"
        part="license-row"
        data-part="license-row"
        data-id=${r.id}
        aria-disabled="true"
        aria-checked="false"
        tabindex="-1"
      >
        ${body} <span></span>
      </div>`;
    // The full row (SIGN-IN §3.19): the title, then the pill, the count and the tag on one line,
    // then the meter and the meta, then its Replace a device.
    const fullBody = html`${r.name
        ? html`<span class="row-name" data-part="row-name"
            ><bdi>${r.name}</bdi></span
          >`
        : nothing}
      <span class="row-line"
        ><span class="pill">${r.tierName}</span>${r.seats.limit !== null &&
        has("signin.choice.devices")
          ? html`<span class="row-title num"
              >${text(c, "signin.choice.devices", {
                used: r.seats.used,
                limit: r.seats.limit,
              })}</span
            >`
          : nothing}${tag("signin.choice.tag.full")}${r.current
          ? tag("signin.choice.tag.current")
          : nothing}</span
      >
      ${r.seats.limit !== null
        ? seatMeter(c, r.seats.used, r.seats.limit, false)
        : nothing}
      ${meta ? html`<span class="meta">${meta}</span>` : nothing}`;
    return html`<div
      class="row"
      role="group"
      part="license-row"
      data-part="license-row"
      data-layout="full"
      data-id=${r.id}
      aria-label=${r.name ?? r.tierName}
    >
      ${fullBody}
      ${replaceHere
        ? button(c, "signin.replace.open", lone ? "primary" : "secondary", {
            detail: { licenseId: r.id },
            // Replace in the browser leaves the app.
            external: c.input.signIn?.replace === "browser",
          })
        : nothing}
    </div>`;
  };
  return html`<div
    class="list pk-stagger"
    role=${allFull ? "group" : "radiogroup"}
    aria-label=${has("signin.choice.group")
      ? plain(c, "signin.choice.group")
      : ""}
    data-part="license-list"
    data-scroll
    data-key=${ifDefined(
      has("signin.choice.group") ? "signin.choice.group" : undefined,
    )}
  >
    ${entries.map(rowFor)}
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
      ?data-scroll=${devices.length > 6}
    >
      ${devices.map(
        (d, i) =>
          html`<div
            class="row"
            role="radio"
            part="device-row"
            data-part="device-row"
            data-id=${d.id}
            tabindex=${d === pick ? "0" : "-1"}
            aria-checked=${d === pick ? "true" : "false"}
            @click=${() => c.pick(d.id)}
            @keydown=${(e: KeyboardEvent) => radioKeys(e, c)}
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
                  platform: platformLabel(d.platform, c.copy),
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
  const list = c.input.devices ?? [];
  if (!keys.has("devices.meta") || list.length === 0) return nothing;
  const drafts = draftsOf(c);
  const edit = c.input.edit;
  const editing = edit
    ? (list.find((d) => d.id !== undefined && d.id === drafts.deviceId) ??
      list.find((d) => d.name === edit.device))
    : undefined;
  const row = (d: (typeof list)[number]) => {
    const id = d.id;
    const label = d.name ?? plain(c, "devices.unnamed");
    const glyph = html`<span
      role="img"
      aria-label=${plain(c, "a11y.formFactor", {
        formFactor: d.formFactor ?? "other",
      })}
      >${GLYPHS.device(d.formFactor)}</span
    >`;
    if (d === editing && edit?.kind === "rename")
      return html`<li
        class="row"
        part="device-row"
        data-part="device-row"
        data-editing="rename"
      >
        ${glyph}
        <div class="field" data-part="rename">
          <label class="label" for="pk-rename"
            >${text(c, "devices.renameLabel")}</label
          >
          <input
            id="pk-rename"
            data-key="devices.renameLabel"
            autocomplete="off"
            .value=${String(drafts.deviceName ?? d.name ?? "")}
            @input=${(e: Event) =>
              c.edit("deviceName", (e.target as HTMLInputElement).value, {
                deviceId: id,
              })}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                c.act("common.save", { deviceId: id });
              } else if (e.key === "Escape") {
                e.stopPropagation();
                c.act("common.cancel");
              }
            }}
          />
        </div>
        <span class="row-actions">
          ${button(c, "common.save", "primary", { detail: { deviceId: id } })}
          ${button(c, "common.cancel", "secondary")}
        </span>
      </li>`;
    if (d === editing && edit?.kind === "remove")
      return html`<li
        class="row"
        part="device-row"
        data-part="device-row"
        data-editing="remove"
      >
        ${glyph}
        <div class="callout" data-part="confirm" role="group">
          <span data-key="devices.removeConfirm"
            >${text(c, "devices.removeConfirm", { device: label })}</span
          >
          <div class="actions" data-layout="row">
            ${button(c, "devices.remove", "danger", {
              detail: { deviceId: id },
            })}
            ${button(c, "common.cancel", "secondary")}
          </div>
        </div>
      </li>`;
    return html`<li
      class="row"
      part="device-row"
      data-part="device-row"
      data-id=${ifDefined(id)}
    >
      ${glyph}
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
            platform: platformLabel(d.platform, c.copy),
            when: days(d.lastSeenDays),
          })}
        </span>
      </span>
      <span class="row-actions">
        ${button(c, "devices.rename", "link", {
          label: plain(c, "a11y.renameDevice", { device: label }),
          detail: { deviceId: id },
        })}
        ${d.current
          ? nothing
          : button(c, "devices.remove", "link", {
              label: plain(c, "a11y.removeDevice", { device: label }),
              detail: { deviceId: id },
            })}
      </span>
    </li>`;
  };
  return html`<ul class="list" data-part="device-list">
    ${list.map(row)}
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

export { settingLabel };

function settingsRows(c: RenderCtx): TemplateResult | typeof nothing {
  const has = (k: string) => c.copy.has(k);
  const rows = (c.input.config ?? []) as SettingsRow[];
  const advanced = draftsOf(c).advanced === true;
  const visible = rows.filter((r) => !r.advanced || advanced);
  const drawn = visible.map((r) => {
    const label = settingLabel(r);
    const from = r.locked
      ? r.org
        ? "settings.setBy"
        : "settings.setByGuardian"
      : `settings.source.${r.source}`;
    const meta: TemplateResult[] = [];
    // Validated as you type: the range turns into the error, and Save waits (aria-invalid).
    const bad = outOfRange(r);
    if (has(from))
      meta.push(
        html`<span data-key=${from}
          >${text(c, from, { org: r.org ?? "" })}</span
        >`,
      );
    if (
      r.type === "number" &&
      typeof r.min === "number" &&
      typeof r.max === "number" &&
      has("settings.range")
    )
      meta.push(
        bad
          ? html`<span
              class="message"
              id=${`pk-range-${r.key}`}
              data-tone="danger"
              data-key="settings.range"
              >${text(c, "settings.range", { min: r.min, max: r.max })}</span
            >`
          : html`<span data-key="settings.range" id=${`pk-range-${r.key}`}
              >${text(c, "settings.range", { min: r.min, max: r.max })}</span
            >`,
      );
    const change = (value: string | number | boolean) =>
      c.edit("setting", value, { key: r.key });
    const kind = settingKind(r);
    const word =
      typeof r.value === "boolean"
        ? r.value
          ? "settings.on"
          : "settings.off"
        : null;
    let control: TemplateResult | typeof nothing;
    if (r.locked) {
      // A locked row shows its value as text, with the lock and its source (§4.1).
      control =
        word !== null
          ? html`<span data-key=${word}
              >${has(word) ? text(c, word) : ""}</span
            >`
          : html`<bdi>${settingText(r)}</bdi>`;
    } else if (kind === "switch") {
      const on = r.value === true;
      const w = on ? "settings.on" : "settings.off";
      control = html`${has(w)
        ? html`<span class="meta" data-key=${w}>${text(c, w)}</span>`
        : nothing}${switchControl(c, label, on, change)}`;
    } else if (kind === "slider") {
      const min = r.min as number;
      const max = r.max as number;
      const now = typeof r.value === "number" ? r.value : min;
      control = html`<span class="slider" data-part="slider"
        ><input
          type="range"
          aria-label=${label}
          aria-invalid=${bad ? "true" : "false"}
          aria-describedby=${ifDefined(
            has("settings.range") ? `pk-range-${r.key}` : undefined,
          )}
          min=${min}
          max=${max}
          step=${sliderStep(r)}
          .value=${String(now)}
          @input=${(e: Event) =>
            change(Number((e.target as HTMLInputElement).value))}
        /><output class="meta">${r.display ?? String(now)}</output></span
      >`;
    } else if (kind === "number") {
      control = html`<span class="field"
        ><input
          type="number"
          inputmode="decimal"
          aria-label=${label}
          aria-invalid=${bad ? "true" : "false"}
          aria-describedby=${ifDefined(
            has("settings.range") && typeof r.max === "number"
              ? `pk-range-${r.key}`
              : undefined,
          )}
          min=${ifDefined(r.min)}
          max=${ifDefined(r.max)}
          step=${ifDefined(r.step)}
          .value=${r.value === undefined || r.value === null
            ? ""
            : String(r.value)}
          @input=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value;
            if (v !== "") change(Number(v));
          }}
      /></span>`;
    } else if (kind === "select") {
      const now =
        r.value === undefined || r.value === null ? "" : String(r.value);
      const options =
        r.options ?? (now ? [{ value: now, label: settingText(r) }] : []);
      control = html`<span class="field"
        ><select
          aria-label=${label}
          @change=${(e: Event) => change((e.target as HTMLSelectElement).value)}
        >
          ${options.map(
            (o) =>
              html`<option value=${o.value} ?selected=${o.value === now}>
                ${o.label}
              </option>`,
          )}
        </select></span
      >`;
    } else {
      control = html`<span class="field"
        ><input
          type="text"
          aria-label=${label}
          autocomplete="off"
          maxlength=${ifDefined(r.maxLength)}
          .value=${r.value === undefined || r.value === null
            ? ""
            : String(r.value)}
          @input=${(e: Event) => change((e.target as HTMLInputElement).value)}
      /></span>`;
    }
    return html`<li class="row" part="settings-row" data-part="settings-row">
      <span class="row-text">
        <span class="row-title"><bdi>${label}</bdi></span>
        ${meta.length
          ? html`<span class="meta"
              >${meta.map((m, i) => html`${i ? " · " : ""}${m}`)}</span
            >`
          : nothing}
      </span>
      <span class="row-value"
        >${r.locked && has("a11y.locked")
          ? html`<span
              role="img"
              data-key="a11y.locked"
              aria-label=${plain(c, "a11y.locked")}
              >${GLYPHS.lock()}</span
            >`
          : nothing}${control}</span
      >
    </li>`;
  });
  const group = has("settings.fromDeveloper")
    ? html`<h2 class="label group-label" data-key="settings.fromDeveloper">
        ${text(c, "settings.fromDeveloper")}
      </h2>`
    : nothing;
  const search = c.view.copy.includes("settings.search")
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
  // The view's own source and state words that no row carried still show, once.
  const shownKeys = new Set<string>();
  for (const r of visible) {
    shownKeys.add(
      r.locked
        ? r.org
          ? "settings.setBy"
          : "settings.setByGuardian"
        : `settings.source.${r.source}`,
    );
    if (typeof r.value === "boolean") {
      shownKeys.add(r.value ? "settings.on" : "settings.off");
    }
    if (r.type === "number") shownKeys.add("settings.range");
  }
  const rest = c.view.copy.filter(
    (k) =>
      !shownKeys.has(k) &&
      (k.startsWith("settings.source.") ||
        k === "settings.on" ||
        k === "settings.off" ||
        k === "settings.setBy" ||
        k === "settings.setByGuardian" ||
        k === "settings.range"),
  );
  if (visible.length === 0 && rest.length === 0)
    return group === nothing && search === nothing
      ? nothing
      : html`${search}${group}`;
  // What the policy locks is its own group: "Managed settings" (§4.1), the person's own below
  // "From <Developer>".
  const open = drawn.filter((_, i) => !visible[i]!.locked);
  const managed = drawn.filter((_, i) => visible[i]!.locked);
  const managedHead = has("account.managedSettings")
    ? html`<h2 class="label group-label" data-key="account.managedSettings">
        ${text(c, "account.managedSettings")}
      </h2>`
    : nothing;
  return html`${search}
  ${open.length || rest.length
    ? html`<div class="group" data-part="settings-group">
        ${open.length ? group : nothing}
        ${open.length
          ? html`<ul class="list" data-part="settings-list">
              ${open}
            </ul>`
          : nothing}
        ${rest.length
          ? html`<p class="meta">
              ${rest.map(
                (k, i) =>
                  html`${i ? " · " : ""}<span data-key=${k}
                      >${text(c, k)}</span
                    >`,
              )}
            </p>`
          : nothing}
      </div>`
    : nothing}
  ${managed.length
    ? html`<div class="group" data-part="settings-group" data-managed="">
        ${managedHead}
        <ul class="list" data-part="settings-list">
          ${managed}
        </ul>
      </div>`
    : nothing}`;
}

/** A label-and-value row of the account pane. */
function accountRow(
  key: string,
  label: TemplateResult | typeof nothing,
  value: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  return html`<li class="row" part="settings-row" data-part="settings-row">
    <span class="row-title" data-key=${key}>${label}</span>
    <span class="row-value">${value}</span>
  </li>`;
}

function accountRows(c: RenderCtx): TemplateResult | typeof nothing {
  const keys = new Set(c.view.copy);
  const i = c.input;
  const rows: TemplateResult[] = [];
  const t = (k: string, x: Record<string, string | number> = {}) =>
    text(c, k, x);
  // A row whose label names a fact the input lacks ("{tier} license") is left out.
  const ok = (k: string) => usable(c, k);
  if (keys.has("account.tier") && ok("account.tier"))
    rows.push(accountRow("account.tier", t("account.tier")));
  if (keys.has("account.devices")) {
    const d = i.account?.devices;
    rows.push(
      accountRow(
        "account.devices",
        t("account.devices"),
        d && c.copy.has("part.seatMeter.caption")
          ? html`<span class="num"
              >${d.limit === null
                ? String(d.used)
                : t("part.seatMeter.caption", {
                    used: d.used,
                    limit: d.limit,
                  })}</span
            >`
          : nothing,
      ),
    );
  }
  if (keys.has("account.cloudSync")) {
    const state = i.cloudSync?.state;
    const k = state ? `cloudSync.${state}` : "";
    rows.push(
      accountRow(
        "account.cloudSync",
        t("account.cloudSync"),
        k && c.copy.has(k) ? t(k) : nothing,
      ),
    );
  }
  const pre = rows;
  const updateRows: TemplateResult[] = [];
  if (keys.has("account.autoUpdate"))
    updateRows.push(
      accountRow(
        "account.autoUpdate",
        t("account.autoUpdate"),
        switchControl(
          c,
          t("account.autoUpdate"),
          i.account?.autoUpdate === true,
          (v) => c.edit("autoUpdate", v),
        ),
      ),
    );
  if (keys.has("account.channel")) {
    const options = (i.channel?.options ?? ["stable", "beta"]).map((id) => ({
      id,
      label: channelLabel(id),
    }));
    updateRows.push(
      accountRow(
        "account.channel",
        t("account.channel"),
        segmented(
          c,
          plain(c, "account.channel"),
          options,
          i.channel?.current,
          (id) => c.edit("channel", id),
          i.channel?.locked === true,
        ),
      ),
    );
  }
  if (keys.has("account.version") && ok("account.version"))
    updateRows.push(accountRow("account.version", t("account.version")));
  const tail: TemplateResult[] = [];
  if (keys.has("account.managedSettings"))
    tail.push(
      accountRow("account.managedSettings", t("account.managedSettings")),
    );
  if (
    pre.length + updateRows.length + tail.length === 0 &&
    !keys.has("account.updates")
  )
    return nothing;
  return html`${pre.length
    ? html`<ul class="list" data-part="account-list">
        ${pre}
      </ul>`
    : nothing}
  ${keys.has("account.updates")
    ? html`<h2
        class="label group-label"
        data-key="account.updates"
        ?hidden=${updateRows.length === 0}
      >
        ${t("account.updates")}
      </h2>`
    : nothing}
  ${updateRows.length
    ? html`<ul class="list" data-part="account-list">
        ${updateRows}
      </ul>`
    : nothing}
  ${tail.length
    ? html`<ul class="list" data-part="account-list">
        ${tail}
      </ul>`
    : nothing}`;
}

/** ChannelPicker: Stable or Beta as one segmented choice, or the lock and its reason. */
function channelRows(c: RenderCtx): TemplateResult | typeof nothing {
  if (c.view.state !== "default") return nothing;
  const options = (c.input.channel?.options ?? ["stable", "beta"]).map(
    (id) => ({
      id,
      label: channelLabel(id),
    }),
  );
  return segmented(
    c,
    plain(c, "channel.title"),
    options,
    c.input.channel?.current,
    (id) => c.edit("channel", id),
  );
}

/** Paywall: what can be bought, one radio row each with its price and term. */
function offerRows(c: RenderCtx): TemplateResult | typeof nothing {
  const items = c.input.offers?.items ?? [];
  if (c.view.state !== "offers" || items.length === 0) return nothing;
  const selected = items.some((o) => o.id === c.input.selected)
    ? c.input.selected
    : items[0]!.id;
  return html`<div
    class="list"
    role="radiogroup"
    aria-labelledby="pk-title"
    data-part="offer-list"
  >
    ${items.map(
      (o) =>
        html`<div
          class="row"
          role="radio"
          part="offer-row"
          data-part="offer-row"
          data-id=${o.id}
          tabindex=${o.id === selected ? "0" : "-1"}
          aria-checked=${o.id === selected ? "true" : "false"}
          @click=${() => c.pick(o.id)}
          @keydown=${(e: KeyboardEvent) => radioKeys(e, c)}
        >
          <span class="pill">${o.name}</span>
          <span>
            <span class="row-title num">${o.price}</span>${o.term
              ? html`<br /><span class="meta">${o.term}</span>`
              : nothing}
          </span>
          ${o.id === selected ? GLYPHS.check() : html`<span></span>`}
        </div>`,
    )}
  </div>`;
}

/** Step 2's primary (Load file, after a rejected signature) docks in the screen's action bar when
 *  the window is short or the text large: the step starts near the fold there, the bar never does.
 *  It follows the step's field in tab order and leads the bar. */
function docksLoadFile(c: RenderCtx): boolean {
  return (
    c.view.component === "OfflineActivation" &&
    c.view.state !== "done" &&
    c.view.decisions.primary === "offlineActivation.loadFile" &&
    (c.tight === true || c.shape === "short")
  );
}

/** OfflineActivation as two numbered steps: the request code, then the response. */
function offlineSteps(c: RenderCtx): TemplateResult {
  const has = (k: string) => c.copy.has(k);
  const code = c.input.offline?.requestCode;
  const loaded = c.input.offline?.response ?? "";
  const done = c.view.state === "done";
  if (done) return html`${nothing}`;
  const copyVariant =
    c.view.decisions.primary === "offlineActivation.copyCode"
      ? "primary"
      : "secondary";
  return html`<ol class="steps" data-part="steps">
    <li class="step-item" data-part="step">
      <p class="body" data-key="offlineActivation.request">
        ${text(c, "offlineActivation.request")}
      </p>
      ${code
        ? html`<span class="code-row"
              ><span class="code" data-mono data-part="request-code"
                >${code}</span
              >
              ${button(c, "offlineActivation.copyCode", copyVariant, {
                detail: { value: code },
              })}</span
            >${qrCode(c, code, "a11y.qrRequest")}`
        : button(c, "offlineActivation.copyCode", copyVariant)}
      ${c.view.copy.includes("offlineActivation.codeCopied")
        ? html`<span
            class="meta"
            role="status"
            data-key="offlineActivation.codeCopied"
            >${text(c, "offlineActivation.codeCopied")}</span
          >`
        : nothing}
    </li>
    <li class="step-item" data-part="step">
      <p class="body" data-key="offlineActivation.loadHint">
        ${text(c, "offlineActivation.loadHint")}
      </p>
      <div class="field" data-part="response">
        <label class="label" for="pk-response"
          >${text(c, "offlineActivation.paste")}</label
        >
        <textarea
          id="pk-response"
          rows="3"
          spellcheck="false"
          data-mono
          data-key="offlineActivation.paste"
          .value=${loaded}
          @input=${(e: Event) =>
            c.edit("response", (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        ${has("offlineActivation.dropHint")
          ? html`<span class="meta" data-key="offlineActivation.dropHint"
              >${text(c, "offlineActivation.dropHint")}</span
            >`
          : nothing}
      </div>
      ${docksLoadFile(c)
        ? nothing
        : button(
            c,
            "offlineActivation.loadFile",
            c.view.decisions.primary === "offlineActivation.loadFile"
              ? "primary"
              : "secondary",
          )}
    </li>
  </ol>`;
}

/** What's new on the update prompt: the first lines of this version's notes. */
function updateNotes(c: RenderCtx): TemplateResult | typeof nothing {
  if (!c.view.copy.includes("update.whatsNew")) return nothing;
  const notes = c.input.releaseNotes ?? [];
  const note =
    notes.find((n) => n.version === c.input.update?.version) ?? notes[0];
  const lines = (note?.notes ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (lines.length === 0) return nothing;
  return html`<ul class="notes" data-part="notes">
    ${lines.map((l) => html`<li>${l}</li>`)}
  </ul>`;
}

export { countdown };

/** The controls and links of a screen. In a modal dialog under the Windows or GNOME chrome the footer is
 *  drawn last, so the links come before it in the DOM and Tab follows the eye (WCAG 2.4.3), and
 *  the sign-in methods are choices in the body with Cancel the one command in the footer. */
function controlsAndLinks(
  c: RenderCtx,
  p: { controls: string[]; links: string[] },
  row: boolean,
): TemplateResult {
  const variant = platformVariant(c.resolved.theme);
  if (
    !(
      c.dialog &&
      (variant === "windows" || variant === "gnome" || variant === "macos")
    )
  )
    return html`${actions(c, p.controls, row)}${links(c, p.links)}`;
  const { choices, footer } = dialogControls(p.controls, c.view);
  // The Mac footer reads Cancel then the default: the default is last in the DOM too.
  return html`${actions(c, choices, false, false, "choices")}${links(
    c,
    p.links,
  )}${actions(c, footer, row, variant === "macos")}`;
}
