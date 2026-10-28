// One template per component form (screen, pane, banner, toast, inline) over the elements'
// `LAYOUTS`, plus the content a few components draw themselves: the key field, the user code,
// device and license rows, progress, release notes and settings rows. The React twin of
// `@polaris-key/elements` src/views.ts: the same DOM, so the shared stylesheet draws both alike.

import type { ReactNode } from "react";
import { withRenew, type View } from "@polaris-key/ui-core";
import {
  LAYOUTS,
  dialogControls,
  placeKeys,
  platformLabel,
  copyPending,
  type Layout,
} from "./contract.js";
import { platformVariant } from "@polaris-key/ui-core/theme";
import { rowsOf } from "./lazy.js";
import {
  isRefusalStep,
  REFUSAL_ERROR_KEY,
  refusalLayout,
  refusalView,
} from "./refusal.js";
export type { SettingsRow } from "./contract.js";

import {
  a11yOnly,
  actions,
  backButton,
  button,
  callout,
  codeDisplay,
  nearbyCode,
  copyAddress,
  days,
  GLYPHS,
  keyField,
  links,
  paragraphs,
  plain,
  productHeader,
  productIcon,
  progressBar,
  qrCode,
  radioKeys,
  seatMeter,
  docksLoadFile,
  openOnChecked,
  shimmer,
  statusLine,
  attribution,
  providerMark,
  successMark,
  text,
  titles,
  unfilled,
  usableKey,
  type KitCtx,
} from "./parts.js";

const ERROR_PREFIXES = ["core.codes.", "core.activation."];
const isErrorKey = (k: string) =>
  ERROR_PREFIXES.some((p) => k.startsWith(p)) ||
  /(Failed|\.failed|\.stale|methodError|\.error)$/.test(k);

/** Keys the content of a component draws itself. */
function contentFor(c: KitCtx): ReactNode {
  const { view, input } = c;
  const keys = new Set(view.copy);
  switch (view.component) {
    case "Activate": {
      // A refusal no other key can fix is a focused step: no field (refusal.ts); a TV scans the
      // add-key page instead.
      if (isRefusalStep(view)) {
        const link = view.decisions.link;
        return (
          <>
            {qrCode(c, link?.qr ? link.url : null, "a11y.qrAddKey")}
            {keys.has("signin.key.scan") ? (
              <p className="body" data-key="signin.key.scan">
                {text(c, "signin.key.scan")}
              </p>
            ) : null}
          </>
        );
      }
      const verdict = [
        "part.keyField.verdict",
        "part.keyField.cutShort",
        "part.keyField.malformed",
        "part.keyField.empty",
        "part.keyField.forProduct",
      ].filter((k) => keys.has(k) && usableKey(c, k));
      const invalid = verdict.some(
        (k) =>
          k !== "part.keyField.verdict" && k !== "part.keyField.forProduct",
      );
      const editing =
        ["empty", "typing", "parsed", "cut-short", "rejected"].includes(
          view.state,
        ) ||
        // The drop-in keeps the field while a key is checked.
        (view.state === "busy" && keys.has("part.keyField.label"));
      // The message under a refused key is linked to the field; only an input that is itself
      // wrong takes the stroke (DL7). A refusal of a well-formed key is a neutral callout (DL6),
      // as ui-core's tone says.
      const refused = view.state === "rejected" || view.state === "cut-short";
      const wrong = refused && view.decisions.tone === "danger";
      const used = input.activation?.deviceCount;
      const limit = input.activation?.limit;
      // The refusal a different key cannot fix has no field; a TV scans the add-key page instead.
      const addKey = view.decisions.link;
      return (
        <>
          {qrCode(c, addKey?.qr ? addKey.url : null, "a11y.qrAddKey")}
          {keys.has("signin.key.scan") ? (
            <p className="body" data-key="signin.key.scan">
              {text(c, "signin.key.scan")}
            </p>
          ) : null}
          {editing
            ? keyField(
                c,
                invalid || wrong,
                verdict.length ? "pk-verdict" : refused ? "pk-message" : null,
              )
            : null}
          {keys.has("part.seatMeter.caption") &&
          used !== undefined &&
          limit !== undefined
            ? seatMeter(c, used, limit)
            : null}
          {verdict.length ? (
            <p
              id="pk-verdict"
              className={invalid ? "message" : "meta"}
              data-tone={invalid ? "danger" : undefined}
              data-part="verdict"
              aria-live="polite"
            >
              {verdict.map((k) => (
                <span key={k} data-key={k}>
                  {text(c, k)}
                </span>
              ))}
            </p>
          ) : null}
        </>
      );
    }
    case "SignIn":
    case "SignInHandoff": {
      const url = c.view.decisions.link;
      // The address is shown as text whenever there is one (a no-browser device has only it).
      const shown = url?.display ?? url?.url?.replace(/^https?:\/\//, "");
      const showUrl = keys.has("signin.handoff.url") && shown;
      return (
        <>
          {codeDisplay(c)}
          {nearbyCode(c)}
          {qrCode(
            c,
            url?.qr ? url.url : null,
            keys.has("a11y.qrAddKey") ? "a11y.qrAddKey" : "a11y.qr",
          )}
          {keys.has("signin.key.scan") ? (
            <p className="body" data-key="signin.key.scan">
              {text(c, "signin.key.scan")}
            </p>
          ) : null}
          {showUrl ? (
            <p className="body" data-key="signin.handoff.url">
              {text(c, "signin.handoff.url", { url: shown as string })}
              {copyAddress(c)}
            </p>
          ) : keys.has("signin.handoff.url") ? (
            <p className="body" data-key="signin.handoff.url">
              {text(c, "signin.handoff.url")}
            </p>
          ) : (
            copyAddress(c)
          )}
          {keys.has("part.keyField.label") ? keyField(c, false, null) : null}
        </>
      );
    }
    case "DeviceLimit":
      return deviceLimitContent(c);
    case "LicenseChoice":
      return c.view.state === "replace-open"
        ? (rowsOf()?.replaceRows(c) ?? null)
        : (c.licenseRows?.(c) ?? null);
    case "Devices":
      return rowsOf()?.deviceRows(c) ?? null;
    case "ReleaseNotes":
      return rowsOf()?.releaseNotes(c) ?? null;
    case "Settings":
      return c.account ? (
        <>
          {c.account}
          {rowsOf()?.settingsRows(c) ?? null}
        </>
      ) : (
        (rowsOf()?.settingsRows(c) ?? null)
      );
    case "OfflineActivation":
      return rowsOf()?.offlineSteps(c) ?? null;
    case "UpdatePrompt": {
      // What's new on the update prompt: the first lines of this version's notes.
      if (!c.view.copy.includes("update.whatsNew")) return null;
      const notes = c.input.releaseNotes ?? [];
      const note =
        notes.find((n) => n.version === c.input.update?.version) ?? notes[0];
      const lines = (note?.notes ?? "")
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3);
      return lines.length === 0 ? null : (
        <ul className="notes" data-part="notes">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      );
    }
    case "AccountAndLicense":
      return rowsOf()?.accountRows(c) ?? null;
    case "ChannelPicker":
      return rowsOf()?.channelRows(c) ?? null;
    default:
      return null;
  }
}

function progressFor(c: KitCtx): ReactNode {
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
    return progressBar(c, p?.fraction);
  if (view.copy.includes("a11y.progress")) return progressBar(c, p?.fraction);
  // A counted download draws its bar wherever its line shows (a toast, the inline progress).
  if (
    p?.fraction !== undefined &&
    (view.component === "Toast" || view.component === "UpdateProgress")
  )
    return progressBar(c, p.fraction);
  return null;
}

/** The download's percent, beside its bar (the bar itself is named for assistive tech). */
function percentFor(c: KitCtx): ReactNode {
  const f = c.input.update?.progress?.fraction;
  if (c.view.component !== "UpdatePrompt" || c.view.state !== "downloading")
    return null;
  if (typeof f !== "number") return null;
  const pct = new Intl.NumberFormat(c.resolved.locale, {
    style: "percent",
  }).format(Math.max(0, Math.min(1, f)));
  return (
    <p className="meta percent" aria-hidden="true">
      {pct}
    </p>
  );
}

/** A locked value (ChannelPicker, a managed setting): the lock glyph, named. */
function locked(c: KitCtx): ReactNode {
  if (!c.view.copy.includes("a11y.locked")) return null;
  // Settings name the lock on the locked row itself.
  if (c.view.component === "Settings" && c.input.config?.some((r) => r.locked))
    return null;
  return (
    <span
      role="img"
      data-key="a11y.locked"
      aria-label={plain(c, "a11y.locked")}
    >
      {GLYPHS.lock()}
    </span>
  );
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

/** Keys OfflineActivation draws inside its own two steps; its text, controls and meta never
 *  repeat them. */
const STEP_KEYS: readonly string[] = [
  "offlineActivation.request",
  "offlineActivation.loadHint",
  "offlineActivation.copyCode",
  "offlineActivation.loadFile",
  "offlineActivation.codeCopied",
  "offlineActivation.paste",
  "offlineActivation.dropHint",
];

function ownFiltered<
  P extends {
    body: string[];
    meta: string[];
    controls: string[];
  },
>(c: KitCtx, p: P): P {
  const { view } = c;
  if (view.component !== "OfflineActivation" || view.state === "done") return p;
  const docked = docksLoadFile(c);
  const keep = (k: string): boolean =>
    !STEP_KEYS.includes(k) || (docked && k === "offlineActivation.loadFile");
  return {
    ...p,
    body: p.body.filter(keep),
    meta: p.meta.filter(keep),
    controls: p.controls.filter(keep),
  };
}

/** The keys a component's base layout always shows, whatever the state adds on top (the
 *  elements' `withBase`): ui-core's per-state views carry only a state's own keys and the corpus
 *  pins them, so the kit adds the base for drawing only. A standalone Activate draws its own
 *  Submit, Back and Done; the drop-in drives the same controls. */
export function withBase(c: KitCtx): View {
  const { view } = c;
  const refusal = refusalView(view, c.input);
  if (refusal) return refusal;
  const add = (...keys: string[]): View => {
    const copy = [...view.copy];
    for (const k of keys) if (c.copy.has(k) && !copy.includes(k)) copy.push(k);
    return { ...view, copy };
  };
  if (view.component === "Activate") {
    if (
      ["empty", "typing", "parsed", "cut-short", "rejected"].includes(
        view.state,
      )
    )
      return add("activate.submit", "common.back");
    if (view.state === "device-limit")
      return add("common.back", "signin.key.differentKey");
    if (view.state === "done") {
      const done = add("common.done");
      return {
        ...done,
        decisions: { ...done.decisions, primary: "common.done" },
      };
    }
  }
  // The Replace step confirms on its own button: its "Replace a device" openers are gone.
  if (view.component === "LicenseChoice" && view.state === "replace-open")
    return {
      ...view,
      copy: view.copy.filter(
        (k) => k !== "signin.replace.open" && k !== "signin.replace.openSystem",
      ),
    };
  // The code step: how long the code lasts, that it waits, and a Cancel to leave by.
  if (view.component === "SignInHandoff" && view.state === "code")
    return add(
      ...(view.args.time !== undefined ? ["signin.handoff.expires"] : []),
      "cli.signin.waitingCode",
      "common.cancel",
    );
  if (view.component === "Devices") {
    const input = c.input;
    if (
      !input.devices?.length ||
      !["renaming", "confirming"].includes(view.state)
    )
      return { ...view, copy: view.copy.filter((k) => k !== "devices.lede") };
    // An edit keeps the list: the row it concerns turns into the form, in place.
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
  if (view.component === "UpdatePrompt") {
    const notes = c.input.releaseNotes ?? [];
    if (view.state === "downloading")
      // The download keeps its title: what is coming.
      return add(
        c.input.update?.version ? "update.title" : "update.availableTitle",
      );
    if (view.state !== "available" && view.state !== "ready") return view;
    const kept = (
      notes.length === 0
        ? view.copy.filter((k) => k !== "update.whatsNew")
        : view.copy
    ).filter(
      (k) => view.state !== "available" || k !== "update.restartWhenReady",
    );
    // On the web the page cannot install: one Download action and Later, a title that says so.
    if (view.state === "available" && c.input.platform?.os === "web") {
      const gone = new Set(["update.title", "update.skipVersion"]);
      return {
        ...view,
        copy: [
          "update.availableTitle",
          ...kept.filter((k) => !gone.has(k) && k !== "update.availableTitle"),
        ],
      };
    }
    return { ...view, copy: kept };
  }
  if (view.component === "Settings") {
    const titled = ["dirty", "locked", "saving"].includes(view.state)
      ? add("settings.title")
      : view;
    // Reset to default waits for a change of the person's; Show advanced for an advanced row.
    const rows = c.input.config ?? [];
    const gone = new Set<string>([
      ...(rows.some((r) => r.source === "local") ? [] : ["settings.reset"]),
      ...(rows.some((r) => r.advanced) ? [] : ["settings.advanced"]),
    ]);
    const trimmed =
      gone.size === 0
        ? titled
        : { ...titled, copy: titled.copy.filter((k) => !gone.has(k)) };
    // The dialog the host opened closes on Done (the scrim and Escape answer too).
    if (!c.dialog || !c.copy.has("common.done")) return trimmed;
    return {
      ...trimmed,
      copy: [...trimmed.copy, "common.done"],
      decisions: { ...trimmed.decisions, primary: "common.done" },
    };
  }
  return view;
}

const DEVICE_LIMIT_ACTIONS = [
  "signin.deviceLimit.replace",
  "signin.auto.confirm.other",
];

/** The confirm step's body (SIGN-IN §3.19): "as {email}" under the title, then each group as a
 *  small muted label over its value, the license line strong. */
function consentBody(c: KitCtx, keys: string[]): ReactNode {
  const has = (k: string) => keys.includes(k);
  const sub = keys.find((k) => k.startsWith("signin.auto.confirm.as"));
  const used = new Set<string>();
  const label = (k: string) => {
    used.add(k);
    return has(k) ? (
      <p
        key={k}
        className="consent-label"
        data-part="consent-label"
        data-key={k}
      >
        {text(c, k)}
      </p>
    ) : null;
  };
  const line = (k: string, cls: string) => {
    used.add(k);
    return has(k) ? (
      <p key={k} className={cls} data-part={cls} data-key={k}>
        {text(c, k)}
      </p>
    ) : null;
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
  const rest = keys.filter((k) => !used.has(k));
  return (
    <>
      {sub ? (
        <p className="subtitle" data-part="subtitle" data-key={sub}>
          {text(c, sub)}
        </p>
      ) : null}
      <div className="consent" data-part="consent">
        {license.some(Boolean) ? (
          <div className="consent-group">{license}</div>
        ) : null}
        {also.some(Boolean) ? (
          <div className="consent-group">{also}</div>
        ) : null}
        {rest.length ? paragraphs(c, rest, "body") : null}
      </div>
    </>
  );
}

/** `placeKeys`, then the drop-in's chrome: controls and links the state lacks, keys it drops. */
function place(c: KitCtx, layout: Layout) {
  const placed = ownFiltered(c, placeKeys(c.view, layout));
  // A line whose argument the input does not carry is dropped, never drawn as "{version}".
  const whole = (k: string) => usableKey(c, k);
  const p = {
    ...placed,
    titles: placed.titles.filter(whole),
    body: placed.body.filter(whole),
    meta: placed.meta.filter(whole),
    footnote: placed.footnote.filter(whole),
  };
  // The device limit with no license rows (SIGN-IN §3.19): Replace a device, Use another account,
  // then Cancel as the quiet exit.
  if (c.view.component === "SignIn" && c.view.state === "device-limit") {
    p.controls = DEVICE_LIMIT_ACTIONS.filter((k) => c.view.copy.includes(k));
    p.links = c.view.copy.includes("common.cancel") ? ["common.cancel"] : [];
  }
  const x = c.chrome;
  if (!x) return p;
  if (x.meta?.length) p.meta = [...new Set([...p.meta, ...x.meta])];
  const drop = new Set(x.drop ?? []);
  return {
    ...p,
    controls: [...new Set([...p.controls, ...(x.controls ?? [])])].filter(
      (k) => !drop.has(k),
    ),
    links: [...p.links, ...(x.links ?? [])].filter((k) => !drop.has(k)),
  };
}

/** A blocking step: the card on the product ambient (DL1, DL2, DL5). */
function screen(c: KitCtx, layout: Layout): ReactNode {
  const { view } = c;
  // One form, one card width: a step of the sign-in form splits like its first step does.
  const split = layout.split === true || c.form === true;
  const p = place(c, layout);
  // The refusal step says its sentence in the body, not in a callout.
  const plainBody =
    isRefusalStep(view) ||
    (view.component === "SignIn" && view.state === "device-limit");
  const errorKeys = plainBody
    ? p.body.filter((k) => k === REFUSAL_ERROR_KEY)
    : p.body.filter(isErrorKey);
  const body = plainBody
    ? p.body.filter((k) => k !== REFUSAL_ERROR_KEY)
    : p.body.filter((k) => !isErrorKey(k));
  const heroTitle = layout.header === "hero";
  const ambient = c.resolved.theme.ambient;
  const showIdentity = layout.header !== "none";
  // DL5: the product's name appears once: in the title when the title names it.
  const name = c.resolved.identity.name || c.resolved.theme.name;
  const titleNames =
    p.titles.length > 0 && name !== "" && plain(c, p.titles[0]!).includes(name);
  const loading = isLoading(view);
  // A stage that owns the window is the page's main landmark.
  const Stage = c.fill ? "main" : "section";
  return (
    <Stage
      className="stage"
      data-part="stage"
      data-kind="screen"
      data-split={split ? "" : undefined}
    >
      {ambient ? (
        <div className="ambient" aria-hidden="true">
          {c.resolved.iconUrl ? <img src={c.resolved.iconUrl} alt="" /> : null}
        </div>
      ) : null}
      <div
        className="card step"
        data-part="card"
        data-align={heroTitle ? "center" : "start"}
        aria-busy={loading ? "true" : undefined}
      >
        {loading ? shimmer() : null}
        {c.chrome?.back ? backButton(c) : null}
        <div className="split passport">
          {split && c.resolved.iconUrl ? (
            <div className="passport-ambient" aria-hidden="true">
              <img src={c.resolved.iconUrl} alt="" />
            </div>
          ) : null}
          {split && showIdentity ? (
            <div className="panel-icon" aria-hidden="true">
              {productIcon(c)}
            </div>
          ) : null}
        </div>
        {showIdentity
          ? productHeader(c, layout.header, {
              name: !titleNames,
              // The hero reads icon, title, then "by Developer" (below the title).
              developer: !heroTitle && view.copy.includes("common.byDeveloper"),
            })
          : null}
        {view.component === "SignIn" &&
        (view.state === "done" || view.state === "link-done")
          ? successMark()
          : view.component === "SignIn" &&
              view.state === "link-offer" &&
              c.input.provider === "Google"
            ? providerMark()
            : null}
        <div className="texts" data-part="texts">
          {titles(
            c,
            p.titles,
            heroTitle ? "display" : "title",
            layout.subtitles,
          )}
          {heroTitle && view.copy.includes("common.byDeveloper") ? (
            <p
              className="by"
              data-part="developer"
              data-key="common.byDeveloper"
            >
              {text(c, "common.byDeveloper")}
            </p>
          ) : null}
          {view.component === "SignIn" && view.state === "confirm"
            ? consentBody(c, body)
            : paragraphs(
                c,
                body.filter((k) => k !== "common.byDeveloper"),
              )}
          {statusLine(c, p.meta)}
        </div>
        {c.content ?? contentFor(c)}
        {progressFor(c)}
        {percentFor(c)}
        {callout(c, errorKeys)}
        {controlsAndLinks(c, p)}
        {a11yOnly(c)}
        {p.footnote.length ? paragraphs(c, p.footnote, "footnote") : null}
        {attribution(c, p.meta)}
      </div>
    </Stage>
  );
}

/** An embedded pane (DL2): start edge, at most 40rem, its own frame unless `bare`. */
function pane(c: KitCtx, layout: Layout): ReactNode {
  const p = place(c, layout);
  const errorKeys = p.body.filter(isErrorKey);
  const body = p.body.filter((k) => !isErrorKey(k));
  const loading = isLoading(c.view);
  // A pane a page of the app holds does not repeat the product above a title that names it, and
  // an update with no notes to list has no "What's new" heading over nothing.
  const own = c.interactive === true || c.embedded === true;
  const name = c.resolved.identity.name || c.resolved.theme.name;
  const named =
    own &&
    name !== "" &&
    p.titles.length > 0 &&
    plain(c, p.titles[0]!).includes(name);
  const heads = own
    ? p.titles.filter((k) => k !== "update.whatsNew")
    : p.titles;
  return (
    <section
      className="pane step"
      data-part="pane"
      aria-busy={loading ? "true" : undefined}
    >
      {loading ? shimmer() : null}
      {productHeader(c, layout.header === "none" || named ? "none" : "compact")}
      <div className="texts" data-part="texts">
        {titles(c, heads, "section")}
        {paragraphs(c, body)}
        {statusLine(c, p.meta)}
      </div>
      {loading ? (
        <div className="skeleton" aria-hidden="true">
          <span />
          <span data-short="" />
        </div>
      ) : null}
      {locked(c)}
      {c.content ?? contentFor(c)}
      {progressFor(c)}
      {callout(c, errorKeys)}
      {actions(c, p.controls, true)}
      {links(c, p.links)}
      {a11yOnly(c)}
      {attribution(c, p.meta)}
    </section>
  );
}

function statusGlyph(view: View): ReactNode {
  const s = view.state;
  if (view.component === "Toast")
    return s === "success"
      ? GLYPHS.success()
      : s === "warning" || s === "error"
        ? GLYPHS.warning()
        : GLYPHS.info();
  if (view.component === "GraceBanner") return GLYPHS.offline();
  if (view.component === "CloudSyncStatus")
    return view.decisions.tone === "neutral"
      ? GLYPHS.info()
      : s === "offline"
        ? GLYPHS.offline()
        : s === "synced"
          ? GLYPHS.success()
          : s === "syncing"
            ? null
            : GLYPHS.warning();
  return null;
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
    return view.decisions.tone === "neutral"
      ? "neutral"
      : view.state === "conflict" || view.state === "error"
        ? "warning"
        : view.state === "synced"
          ? "success"
          : "neutral";
  return "neutral";
}

/** A banner or a toast: one line plus its consequence, at most two actions. */
function strip(c: KitCtx, layout: Layout, kind: "banner" | "toast"): ReactNode {
  const p = place(c, layout);
  const lines = [...p.titles, ...p.body, ...p.meta];
  const role = c.view.decisions.tone === "danger" ? "alert" : "status";
  return (
    <div
      className={kind}
      data-part={kind}
      data-status={statusOf(c.view)}
      role={role}
    >
      {statusGlyph(c.view)}
      <div className="texts">
        {lines.map((k, i) => (
          <span key={k} className={i === 0 ? "label" : "meta"} data-key={k}>
            {text(c, k)}
          </span>
        ))}
        {progressFor(c)}
      </div>
      {p.controls.length ? (
        <div className="actions" data-layout="row" data-part="actions">
          {p.controls.map((k) =>
            button(
              c,
              k,
              k === c.view.decisions.primary ? "primary" : "secondary",
            ),
          )}
        </div>
      ) : null}
      {kind === "toast" && c.view.copy.includes("a11y.toastTimer") ? (
        <span className="timer" aria-hidden="true" />
      ) : null}
      {a11yOnly(c)}
    </div>
  );
}

/** A small status inside the host's layout. */
function inline(c: KitCtx, layout: Layout): ReactNode {
  const p = place(c, layout);
  const lines = [...p.titles, ...p.meta, ...p.body];
  return (
    <div
      className="inline-status"
      data-part="status"
      data-status={statusOf(c.view)}
      role="status"
    >
      {statusGlyph(c.view)}
      {lines.map((k) => (
        <span
          key={k}
          className={p.titles.includes(k) ? "label" : undefined}
          data-key={k}
        >
          {text(c, k)}
        </span>
      ))}
      {progressFor(c)}
      {a11yOnly(c)}
      {p.controls.map((k) =>
        button(c, k, k === c.view.decisions.primary ? "primary" : "secondary"),
      )}
      {links(c, p.links)}
    </div>
  );
}

/** Draw one view in its component's form; `hidden` draws nothing. */
export function renderView(c0: KitCtx): ReactNode {
  const c = { ...c0, view: withRenew(withBase(c0), c0.input) };
  if (c.view.state === "hidden") return null;
  // DL7: a loading state inside its delay shows nothing at all (its view carries no copy yet).
  if (isLoading(c.view) && c.view.copy.length === 0) return null;
  // English's second table (the screens that follow a network answer, `LAZY_EN_PREFIXES`) is
  // still loading: draw nothing rather than a missing string (any other missing key throws, as
  // before). The kit redraws when it arrives.
  if (c.view.copy.some((k) => !c.copy.has(k) && copyPending(k))) return null;
  const own = LAYOUTS[c.view.component as keyof typeof LAYOUTS];
  const layout =
    c.layout ??
    (isRefusalStep(c.view) ? refusalLayout(own, c.view.component) : own);
  // A page of the app's holds a screen-form part as a pane (no stage, no ambient, its own width).
  if (c.embedded && layout.kind === "screen")
    return pane(c, { ...layout, kind: "pane", split: false });
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

function deviceLimitContent(c: KitCtx): ReactNode {
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
  return (
    <>
      {qr}
      {keys.has("part.seatMeter.caption") && used !== undefined && limit != null
        ? seatMeter(c, used, limit, !keys.has("deviceLimit.heading"))
        : null}
      {keys.has("signin.replace.meta") ? (
        <div
          className="list"
          role="radiogroup"
          aria-labelledby="pk-title"
          data-part="device-list"
          data-scroll={devices.length > 6 ? "" : undefined}
          ref={devices.length > 6 ? openOnChecked : undefined}
        >
          {devices.map((d, i) => (
            <div
              key={i}
              className="row"
              role="radio"
              data-part="device-row"
              tabIndex={i === selected ? 0 : -1}
              aria-checked={i === selected ? "true" : "false"}
              onClick={() => c.pick(String(i))}
              onKeyDown={(e) => radioKeys(e, c, i, devices.length)}
            >
              <span
                aria-label={
                  keys.has("a11y.formFactor")
                    ? plain(c, "a11y.formFactor", {
                        formFactor: d.formFactor ?? "other",
                      })
                    : ""
                }
                role="img"
              >
                {GLYPHS.device(d.formFactor)}
              </span>
              <span>
                <span className="row-title">
                  <bdi>{d.name ?? ""}</bdi>
                </span>
                {i === leastRecent && keys.has("signin.replace.leastRecent") ? (
                  <>
                    {" "}
                    <span
                      className="pill"
                      data-key="signin.replace.leastRecent"
                    >
                      {text(c, "signin.replace.leastRecent")}
                    </span>
                  </>
                ) : null}
                <br />
                <span className="meta">
                  {text(c, "signin.replace.meta", {
                    platform: platformLabel(d.platform),
                    when: days(d.lastSeenDays),
                  })}
                </span>
              </span>
              {i === selected ? GLYPHS.check() : <span />}
            </div>
          ))}
        </div>
      ) : null}
      {keys.has("deviceLimit.confirmTitle") && pick ? (
        <div className="callout" data-part="confirm">
          <span className="callout-title">
            {text(c, "deviceLimit.confirmTitle", { device: pick.name ?? "" })}
          </span>
          {keys.has("deviceLimit.consequence") ? (
            <span>
              {text(c, "deviceLimit.consequence", {
                device: pick.name ?? "",
                thisDevice: plain(c, "part.thisDevice", {
                  formFactor: c.input.platform?.formFactor ?? "computer",
                }),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The controls and links of a screen. In a modal dialog under the Windows or GNOME chrome the footer is
 *  drawn last, so the links come before it in the DOM and Tab follows the eye (WCAG 2.4.3), and
 *  the sign-in methods are choices in the body with Cancel the one command in the footer. */
function controlsAndLinks(
  c: KitCtx,
  p: { controls: string[]; links: string[] },
): ReactNode {
  const variant = platformVariant(c.resolved.theme);
  if (
    !(
      c.dialog &&
      (variant === "windows" || variant === "gnome" || variant === "macos")
    )
  )
    return (
      <>
        {actions(c, p.controls)}
        {links(c, p.links)}
      </>
    );
  const { choices, footer } = dialogControls(p.controls, c.view);
  return (
    <>
      {actions(c, choices, false, "choices")}
      {links(c, p.links)}
      {actions(c, footer, false, undefined, variant === "macos")}
    </>
  );
}
