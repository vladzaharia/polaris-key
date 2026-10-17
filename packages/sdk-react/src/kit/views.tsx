// One template per component form (screen, pane, banner, toast, inline) over the elements'
// `LAYOUTS`, plus the content a few components draw themselves: the key field, the user code,
// device and license rows, progress, release notes and settings rows. The React twin of
// `@polaris-key/elements` src/views.ts: the same DOM, so the shared stylesheet draws both alike.

import { Fragment, type ReactNode } from "react";
import type { View } from "@polaris-key/ui-core";
import { LAYOUTS, placeKeys, platformLabel, type Layout } from "./contract.js";

import {
  a11yOnly,
  actions,
  backButton,
  button,
  callout,
  codeDisplay,
  copyAddress,
  GLYPHS,
  keyField,
  links,
  paragraphs,
  plain,
  productHeader,
  progressBar,
  qrCode,
  radioKeys,
  seatMeter,
  openOnChecked,
  shimmer,
  statusLine,
  successMark,
  text,
  titles,
  unfilled,
  type KitCtx,
} from "./parts.js";

const ERROR_PREFIXES = ["core.codes.", "core.activation."];
const isErrorKey = (k: string) =>
  ERROR_PREFIXES.some((p) => k.startsWith(p)) ||
  /(Failed|\.failed|methodError|\.error)$/.test(k);

/** Keys the content of a component draws itself. */
function contentFor(c: KitCtx): ReactNode {
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
      const editing =
        ["empty", "typing", "parsed", "cut-short", "rejected"].includes(
          view.state,
        ) ||
        // The drop-in keeps the field while a key is checked.
        (view.state === "busy" && keys.has("part.keyField.label"));
      // A refused key is an input that is wrong: the stroke, and the message linked to it.
      const refused = view.state === "rejected" || view.state === "cut-short";
      const used = input.activation?.deviceCount;
      const limit = input.activation?.limit;
      return (
        <>
          {editing
            ? keyField(
                c,
                invalid || refused,
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
          {qrCode(c, url?.qr ? url.url : null)}
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
      return c.view.state === "replace-open" ? replaceRows(c) : licenseRows(c);
    case "Devices":
      return deviceRows(c);
    case "ReleaseNotes":
      return releaseNotes(c);
    case "Settings":
      return settingsRows(c);
    case "OfflineActivation":
      return keys.has("offlineActivation.paste") ? (
        <div className="field" data-part="response">
          <label className="label" htmlFor="pk-response">
            {text(c, "offlineActivation.paste")}
          </label>
          <textarea id="pk-response" rows={3} spellCheck={false} data-mono="" />
          {keys.has("offlineActivation.dropHint") ? (
            <span className="meta" data-key="offlineActivation.dropHint">
              {text(c, "offlineActivation.dropHint")}
            </span>
          ) : null}
        </div>
      ) : null;
    case "AccountAndLicense":
      return accountRows(c);
    case "ChannelPicker":
      return channelRows(c);
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
    return progressBar(c, p?.fraction ?? 0);
  if (view.copy.includes("a11y.progress"))
    return progressBar(c, p?.fraction ?? 0);
  return null;
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

/** `placeKeys`, then the drop-in's chrome: controls and links the state lacks, keys it drops. */
function place(c: KitCtx, layout: Layout) {
  const placed = placeKeys(c.view, layout);
  // A line whose argument the input does not carry is dropped, never drawn as "{version}".
  // Only where the drop-in drives the part: a fixture state draws its keys as the corpus lists them.
  const whole = (k: string) => c.driven !== true || !unfilled(c, k);
  const p = {
    ...placed,
    titles: placed.titles.filter(whole),
    body: placed.body.filter(whole),
    meta: placed.meta.filter(whole),
    footnote: placed.footnote.filter(whole),
  };
  const x = c.chrome;
  if (!x) return p;
  if (x.meta?.length) p.meta = [...p.meta, ...x.meta];
  const drop = new Set(x.drop ?? []);
  return {
    ...p,
    controls: [...p.controls, ...(x.controls ?? [])].filter(
      (k) => !drop.has(k),
    ),
    links: [...p.links, ...(x.links ?? [])].filter((k) => !drop.has(k)),
  };
}

/** A blocking step: the card on the product ambient (DL1, DL2, DL5). */
function screen(c: KitCtx, layout: Layout): ReactNode {
  const { view } = c;
  const p = place(c, layout);
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
  // A stage that owns the window is the page's main landmark.
  const Stage = c.fill ? "main" : "section";
  return (
    <Stage
      className="stage"
      data-part="stage"
      data-kind="screen"
      data-split={layout.split === true ? "" : undefined}
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
          {layout.split && c.resolved.iconUrl ? (
            <div className="passport-ambient" aria-hidden="true">
              <img src={c.resolved.iconUrl} alt="" />
            </div>
          ) : null}
          {showIdentity
            ? productHeader(c, layout.header, {
                name: !titleNames,
                developer: view.copy.includes("common.byDeveloper"),
              })
            : null}
        </div>
        {view.component === "SignIn" && view.state === "done"
          ? successMark()
          : null}
        <div className="texts" data-part="texts">
          {titles(
            c,
            p.titles,
            heroTitle ? "display" : "title",
            layout.subtitles,
          )}
          {paragraphs(
            c,
            body.filter((k) => k !== "common.byDeveloper"),
          )}
          {statusLine(c, p.meta)}
        </div>
        {contentFor(c)}
        {progressFor(c)}
        {callout(c, errorKeys)}
        {actions(c, p.controls)}
        {links(c, p.links)}
        {a11yOnly(c)}
        {p.footnote.length ? paragraphs(c, p.footnote, "footnote") : null}
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
      {contentFor(c)}
      {progressFor(c)}
      {callout(c, errorKeys)}
      {actions(c, p.controls, true)}
      {links(c, p.links)}
      {a11yOnly(c)}
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
    return s === "offline"
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
    return view.state === "conflict" || view.state === "error"
      ? "warning"
      : view.state === "synced"
        ? "success"
        : "neutral";
  return "neutral";
}

/** A banner or a toast: one line plus its consequence, at most two actions. */
function strip(c: KitCtx, layout: Layout, kind: "banner" | "toast"): ReactNode {
  const p = placeKeys(c.view, layout);
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
  const p = placeKeys(c.view, layout);
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
export function renderView(c: KitCtx): ReactNode {
  if (c.view.state === "hidden") return null;
  // DL7: a loading state inside its delay shows nothing at all (its view carries no copy yet).
  if (isLoading(c.view) && c.view.copy.length === 0) return null;
  const layout = LAYOUTS[c.view.component];
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
                <br />
                <span className="meta">
                  {text(c, "signin.replace.meta", {
                    platform: platformLabel(d.platform),
                    when: days(d.lastSeenDays),
                  })}
                  {i === leastRecent &&
                  keys.has("signin.replace.leastRecent") ? (
                    <> · {text(c, "signin.replace.leastRecent")}</>
                  ) : null}
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

function licenseRows(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  const view = c.input.choices;
  const rows = view?.choices ?? [];
  const selected = c.input.selected ?? view?.preselected ?? null;
  // A row of its own for keep, create and a first automatic license (never blurred, Must not).
  const special = (key: string, meta: string | null, id: string) => (
    <div
      className="row"
      role="radio"
      data-part="license-row"
      tabIndex={0}
      aria-checked={
        selected === id || c.view.state === "new" ? "true" : "false"
      }
      onClick={() => c.pick(id)}
    >
      <span />
      <span>
        <span className="row-title" data-key={key}>
          {text(c, key)}
        </span>
        {meta && keys.has(meta) ? (
          <>
            <br />
            <span className="meta" data-key={meta}>
              {text(c, meta)}
            </span>
          </>
        ) : null}
      </span>
      {GLYPHS.check()}
    </div>
  );
  if (c.view.state === "keep")
    return (
      <div className="list" role="radiogroup">
        {special("signin.choice.keep", "signin.choice.keepMeta", "keep")}
      </div>
    );
  if (c.view.state === "create")
    return (
      <div className="list" role="radiogroup">
        {special("signin.choice.create", "signin.choice.createMeta", "create")}
      </div>
    );
  if (c.view.state === "new")
    return (
      <div className="list" role="radiogroup">
        <div
          className="row"
          role="radio"
          aria-checked="true"
          data-part="license-row"
          tabIndex={0}
        >
          <span className="pill">{String(c.view.args.tier ?? "")}</span>
          <span>
            <span className="row-title" data-key="signin.choice.metaNew">
              {text(c, "signin.choice.metaNew")}
            </span>
            <span className="pill" data-key="signin.choice.tag.new">
              {text(c, "signin.choice.tag.new")}
            </span>
          </span>
          {GLYPHS.check()}
        </div>
      </div>
    );
  const tagged = ["signin.choice.tag.current", "signin.choice.tag.full"].filter(
    (k) => keys.has(k),
  );
  if (!keys.has("signin.choice.group") && tagged.length === 0) return null;
  const shownRows = keys.has("signin.choice.group")
    ? rows
    : rows.filter(
        (r) =>
          (keys.has("signin.choice.tag.current") && r.current) ||
          (keys.has("signin.choice.tag.full") && r.state !== "free"),
      );
  return (
    <div
      className="list pk-stagger"
      role="radiogroup"
      aria-label={
        keys.has("signin.choice.group") ? plain(c, "signin.choice.group") : ""
      }
      data-part="license-list"
      data-key={
        keys.has("signin.choice.group") ? "signin.choice.group" : undefined
      }
    >
      {shownRows.map((r, i) => {
        const full = r.state !== "free";
        const on = r.id === selected || (selected === null && i === 0 && !full);
        const origin = ORIGIN_KEY[r.origin];
        const term =
          r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until";
        const date = r.expiresAt
          ? new Date(r.expiresAt * 1000).toLocaleDateString(c.copy.locale)
          : "";
        // An origin naming a store the row does not carry (`LicenseChoiceRow` has none) is left
        // out, never drawn as "From {store}": the term still says what the license is.
        const originText = origin && keys.has(origin) ? plain(c, origin) : "";
        const metaArgs = {
          origin: /\{[A-Za-z]\w*\}/.test(originText) ? "" : originText,
          term: keys.has(term) ? plain(c, term, { date }) : "",
        };
        return (
          <div
            key={r.id}
            className="row"
            role={full ? "group" : "radio"}
            data-part="license-row"
            tabIndex={full ? -1 : on ? 0 : -1}
            aria-checked={full ? undefined : on ? "true" : "false"}
            onClick={() => (full ? undefined : c.pick(r.id))}
          >
            <span className="pill">{r.tierName}</span>
            <span>
              {keys.has("signin.choice.devices") && r.seats.limit !== null ? (
                <>
                  <span className="row-title num">
                    {text(c, "signin.choice.devices", {
                      used: r.seats.used,
                      limit: r.seats.limit,
                    })}
                  </span>
                  <br />
                </>
              ) : null}
              {keys.has("signin.choice.meta") ? (
                <span className="meta">
                  {metaArgs.origin
                    ? text(c, "signin.choice.meta", metaArgs)
                    : metaArgs.term}
                </span>
              ) : null}
              {full && keys.has("signin.choice.tag.full") ? (
                <>
                  {" "}
                  <span className="pill" data-key="signin.choice.tag.full">
                    {text(c, "signin.choice.tag.full")}
                  </span>
                </>
              ) : null}
              {r.current && keys.has("signin.choice.tag.current") ? (
                <>
                  {" "}
                  <span className="pill" data-key="signin.choice.tag.current">
                    {text(c, "signin.choice.tag.current")}
                  </span>
                </>
              ) : null}
            </span>
            {on ? GLYPHS.check() : <span />}
          </div>
        );
      })}
    </div>
  );
}

/** "3 days ago", "last month": a relative time from epoch seconds (the server's `lastSeen`). */
function since(epochSeconds: number, locale: string): string {
  const d = Math.max(
    0,
    Math.floor((Date.now() - epochSeconds * 1000) / 86_400_000),
  );
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (d < 45) return rtf.format(-d, "day");
  if (d < 365) return rtf.format(-Math.round(d / 30), "month");
  return rtf.format(-Math.round(d / 365), "year");
}

/** The Replace step (SIGN-IN.md §3.7): the license's devices, the least recent preselected, and
 *  the one confirm under the list that names the picked device. */
function replaceRows(c: KitCtx): ReactNode {
  const rv = c.input.replaceView;
  if (!rv) return null;
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
  const tag = (k: string) => (
    <>
      {" "}
      <span className="pill" data-key={k}>
        {text(c, k)}
      </span>
    </>
  );
  return (
    <>
      <div
        className="list pk-stagger"
        role="radiogroup"
        aria-labelledby="pk-title"
        data-part="device-list"
        data-scroll={devices.length > 6 ? "" : undefined}
        ref={devices.length > 6 ? openOnChecked : undefined}
      >
        {devices.map((d, i) => (
          <div
            key={d.id}
            className="row"
            role="radio"
            data-part="device-row"
            tabIndex={d === pick ? 0 : -1}
            aria-checked={d === pick ? "true" : "false"}
            onClick={() => c.pick(d.id)}
            onKeyDown={(e) =>
              radioKeys(e, c, i, devices.length, (n) => devices[n]!.id)
            }
          >
            <span
              role="img"
              aria-label={plain(c, "a11y.formFactor", {
                formFactor: d.deviceType ?? "other",
              })}
            >
              {GLYPHS.device(d.deviceType)}
            </span>
            <span>
              <span className="row-title">
                <bdi>{name(d)}</bdi>
              </span>
              {d.leastRecent ? tag("signin.replace.leastRecent") : null}
              {d.activeNow ? tag("signin.replace.activeNow") : null}
              {d.thisBrowser ? tag("signin.replace.thisBrowser") : null}
              <br />
              <span className="meta">
                {text(c, "signin.replace.meta", {
                  platform: platformLabel(d.platform),
                  when: since(d.lastSeen, c.copy.locale),
                })}
              </span>
            </span>
            {d === pick ? GLYPHS.check() : <span />}
          </div>
        ))}
      </div>
      {pick && keys.has("signin.replace.title") ? (
        <div className="callout" data-part="confirm" role="status">
          <span className="callout-title" data-key="signin.replace.title">
            {text(c, "signin.replace.title", { device: name(pick) })}
          </span>
          {keys.has("signin.replace.consequence") ? (
            <span data-key="signin.replace.consequence">
              {text(c, "signin.replace.consequence", {
                device: name(pick),
                thisDevice,
              })}
            </span>
          ) : null}
          {pick.activeNow ? (
            <span className="message" data-tone="warning">
              {text(c, "signin.replace.inUse", { device: name(pick) })}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The inline rename form of one device row. */
function renameForm(c: KitCtx, name: string): ReactNode {
  const keys = new Set(c.view.copy);
  return (
    <div className="field" data-part="rename">
      <label className="label" htmlFor="pk-rename">
        {text(c, "devices.renameLabel")}
      </label>
      <div className="field-row">
        <input
          id="pk-rename"
          defaultValue={name}
          data-key="devices.renameLabel"
          autoComplete="off"
          onChange={(e) => c.edit("rename", e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") c.act("common.save");
          }}
        />
        {keys.has("common.save")
          ? button(
              c,
              "common.save",
              c.view.decisions.primary === "common.save"
                ? "primary"
                : "secondary",
            )
          : null}
        {keys.has("common.cancel")
          ? button(c, "common.cancel", "secondary")
          : null}
      </div>
    </div>
  );
}

function removeConfirm(c: KitCtx): ReactNode {
  return (
    <div className="callout" data-part="confirm">
      <span>{text(c, "devices.removeConfirm")}</span>
      <div className="actions" data-layout="row">
        {button(c, "devices.remove", "danger")}
        {button(c, "common.cancel", "secondary")}
      </div>
    </div>
  );
}

function deviceRows(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  const list = c.input.devices ?? [];
  const editing = c.view.state === "renaming" || c.view.state === "confirming";
  // The row the edit concerns (`input.selected`); without a list, the form stands alone.
  const at =
    editing && c.input.selected !== undefined ? Number(c.input.selected) : -1;
  if (!keys.has("devices.meta") || list.length === 0 || (editing && at < 0)) {
    if (keys.has("devices.renameLabel"))
      return renameForm(c, String(c.view.args.device ?? ""));
    if (keys.has("devices.removeConfirm")) return removeConfirm(c);
  }
  if (!keys.has("devices.meta")) return null;
  const unnamed = plain(c, "devices.unnamed");
  return (
    <ul className="list" data-part="device-list">
      {list.map((d, i) => {
        // A row with no name is named by its platform, so its buttons say which it is.
        const label = d.name ?? unnamed;
        const row =
          c.view.state === "renaming" && i === at ? (
            <li key={i} className="row" data-part="device-row">
              {renameForm(c, d.name ?? "")}
            </li>
          ) : (
            <li key={i} className="row" data-part="device-row">
              <span
                role="img"
                aria-label={plain(c, "a11y.formFactor", {
                  formFactor: d.formFactor ?? "other",
                })}
              >
                {GLYPHS.device(d.formFactor)}
              </span>
              <span>
                <span className="row-title">
                  {d.name ? <bdi>{d.name}</bdi> : text(c, "devices.unnamed")}
                </span>
                <br />
                <span className="meta">
                  {d.current && keys.has("part.thisDeviceTitle") ? (
                    <>
                      {text(c, "part.thisDeviceTitle", {
                        formFactor: d.formFactor ?? "other",
                      })}
                      {c.interactive ? null : " · "}
                    </>
                  ) : null}
                  {/* A driven row for this device says "This Mac" and no platform beside it. */}
                  {d.current && c.interactive
                    ? null
                    : text(c, "devices.meta", {
                        platform: platformLabel(d.platform),
                        when: days(d.lastSeenDays),
                      })}
                </span>
              </span>
              <span className="row-actions">
                {button(c, "devices.rename", "link", {
                  label: plain(c, "a11y.renameDevice", { device: label }),
                  detail: { index: i, ...(d.id ? { deviceId: d.id } : {}) },
                })}
                {d.current
                  ? null
                  : button(c, "devices.remove", "link", {
                      label: plain(c, "a11y.removeDevice", { device: label }),
                      detail: { index: i, ...(d.id ? { deviceId: d.id } : {}) },
                    })}
              </span>
            </li>
          );
        return c.view.state === "confirming" && i === at ? (
          <Fragment key={i}>
            {row}
            <li className="row" data-part="device-confirm">
              {removeConfirm(c)}
            </li>
          </Fragment>
        ) : (
          row
        );
      })}
    </ul>
  );
}

function releaseNotes(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  if (!keys.has("releaseNotes.version")) return null;
  return (
    <div className="texts" data-part="notes">
      {(c.input.releaseNotes ?? []).map((n) => (
        <article key={n.version} className="texts" data-part="note">
          <h2 className="title" data-size="section">
            {text(c, "releaseNotes.version", { version: n.version })}
          </h2>
          {keys.has("releaseNotes.released") ? (
            <span className="meta">
              {text(c, "releaseNotes.released", { date: n.date })}
            </span>
          ) : null}
          {n.notes.split(/\n+/).map((line, i) => (
            <p key={i} className="body">
              {line}
            </p>
          ))}
        </article>
      ))}
    </div>
  );
}

/** A config row as the kit takes it: ui-core's row plus the catalog entry's `label`, when the
 *  adapter passes it (every product catalog entry has one). */
export type SettingsRow = NonNullable<KitCtx["input"]["config"]>[number] & {
  label?: string;
  /** The value as the person reads it ("48,000 Hz", "WAV"): the catalog's unit and option label. */
  display?: string;
  /** The choices of an enum setting, in the catalog's order. */
  options?: readonly { value: string; label: string }[];
  step?: number;
};

/** The field a setting's value is edited in. Switches and choices apply at once; a number or text
 *  applies when it loses focus or on Enter. The host hears `config:<key>` with the new value. */
function settingControl(c: KitCtx, r: SettingsRow, name: string): ReactNode {
  const field = `config:${r.key}`;
  if (typeof r.value === "boolean") {
    const on = r.value;
    return (
      <button
        type="button"
        role="switch"
        className="btn"
        data-part="switch"
        data-variant={on ? "primary" : "secondary"}
        aria-checked={on ? "true" : "false"}
        aria-label={name}
        onClick={() => c.edit(field, String(!on))}
      >
        <span>{text(c, on ? "settings.on" : "settings.off")}</span>
      </button>
    );
  }
  if (r.options && r.options.length > 0)
    return (
      <span className="field" style={{ inlineSize: "10rem" }}>
        <select
          aria-label={name}
          value={String(r.value ?? "")}
          onChange={(e) => c.edit(field, e.currentTarget.value)}
        >
          {r.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    );
  const number = r.type === "number" || typeof r.value === "number";
  const commit = (el: HTMLInputElement) => {
    if (el.value !== String(r.value ?? "")) c.edit(field, el.value);
  };
  return (
    <span className="field" style={{ inlineSize: "9rem" }}>
      <input
        key={String(r.value ?? "")}
        type={number ? "number" : "text"}
        aria-label={name}
        defaultValue={String(r.value ?? "")}
        autoComplete="off"
        {...(number
          ? {
              inputMode: "decimal" as const,
              ...(r.min !== undefined ? { min: r.min } : {}),
              ...(r.max !== undefined ? { max: r.max } : {}),
              ...(r.step !== undefined ? { step: r.step } : {}),
            }
          : {})}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget);
        }}
      />
    </span>
  );
}

/** Words a key spells in capitals when it is read as a label (ui.compact reads "UI compact"). */
const ACRONYMS: Readonly<Record<string, string>> = {
  ui: "UI",
  url: "URL",
  uri: "URI",
  id: "ID",
  api: "API",
  cpu: "CPU",
  gpu: "GPU",
  fps: "FPS",
  hdr: "HDR",
  vr: "VR",
  ar: "AR",
  ip: "IP",
  dns: "DNS",
  vpn: "VPN",
  usb: "USB",
  tls: "TLS",
  ssl: "SSL",
  sdk: "SDK",
  os: "OS",
  pc: "PC",
  tv: "TV",
  hdmi: "HDMI",
  pin: "PIN",
  qr: "QR",
};

/** A setting's name: the catalog entry's label, else its key read as words (`audio.volume` →
 *  "Audio volume"), never the raw key (DL8). */
export function settingLabel(row: SettingsRow): string {
  if (row.label?.trim()) return row.label.trim();
  const phrase = row.key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._\-\s/:]+/)
    .filter(Boolean)
    .map((w) =>
      Object.hasOwn(ACRONYMS, w.toLowerCase())
        ? ACRONYMS[w.toLowerCase()]!
        : w.toLocaleLowerCase(),
    )
    .join(" ");
  return phrase ? phrase[0]!.toLocaleUpperCase() + phrase.slice(1) : row.key;
}

function settingsRows(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  const rows = (c.input.config ?? []) as SettingsRow[];
  const used = new Set<string>();
  const use = (k: string) => (keys.has(k) ? (used.add(k), true) : false);
  // Each row: its name, where its value comes from (or who set it), and the value at the end.
  const drawn = rows.map((r) => {
    const meta: ReactNode[] = [];
    const from = r.locked
      ? r.org
        ? "settings.setBy"
        : "settings.setByGuardian"
      : `settings.source.${r.source}`;
    if (use(from))
      meta.push(
        <span key={from} data-key={from}>
          {text(c, from, { org: r.org ?? "" })}
        </span>,
      );
    if (
      r.type === "number" &&
      typeof r.min === "number" &&
      typeof r.max === "number" &&
      use("settings.range")
    )
      meta.push(
        <span key="range" data-key="settings.range">
          {text(c, "settings.range", { min: r.min, max: r.max })}
        </span>,
      );
    let value: ReactNode = null;
    if (
      c.interactive &&
      !r.locked &&
      r.value !== undefined &&
      r.value !== null
    ) {
      // The switch says On or Off itself.
      use("settings.on");
      use("settings.off");
      value = settingControl(c, r, settingLabel(r));
    } else if (typeof r.value === "boolean") {
      const k = r.value ? "settings.on" : "settings.off";
      use(k);
      value = <span data-key={k}>{text(c, k)}</span>;
    } else if (r.value !== undefined && r.value !== null)
      value = <bdi>{r.display ?? String(r.value)}</bdi>;
    return (
      <li key={r.key} className="row" data-part="settings-row">
        <span className="row-text">
          <span className="row-title">
            <bdi>{settingLabel(r)}</bdi>
          </span>
          {meta.length ? (
            <span className="meta">
              {meta.map((m, i) => (
                <Fragment key={i}>
                  {i ? " · " : ""}
                  {m}
                </Fragment>
              ))}
            </span>
          ) : null}
        </span>
        <span className="row-value">
          {r.locked && keys.has("a11y.locked") ? (
            <span
              role="img"
              data-key="a11y.locked"
              aria-label={plain(c, "a11y.locked")}
            >
              {GLYPHS.lock()}
            </span>
          ) : null}
          {value}
        </span>
      </li>
    );
  });
  // The provenance group's heading (B10: "From <Developer>" for what the person can change).
  const group = use("settings.fromDeveloper") ? (
    <h2 className="label group-label" data-key="settings.fromDeveloper">
      {text(c, "settings.fromDeveloper")}
    </h2>
  ) : null;
  const search = use("settings.search") ? (
    <div className="field" data-part="search">
      <input
        type="search"
        data-key="settings.search"
        aria-label={plain(c, "settings.search")}
        placeholder={plain(c, "settings.search")}
        autoComplete="off"
        onChange={(e) => c.edit("search", e.currentTarget.value)}
      />
    </div>
  ) : null;
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
    return group === null && search === null ? null : (
      <>
        {search}
        {group}
      </>
    );
  return (
    <>
      {search}
      <div className="group" data-part="settings-group">
        {group}
        <ul className="list" data-part="settings-list">
          {drawn}
        </ul>
        {rest.length ? (
          <p className="meta">
            {rest.map((k, i) => (
              <Fragment key={k}>
                {i ? " · " : ""}
                <span data-key={k}>{text(c, k)}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>
    </>
  );
}

function accountRows(c: KitCtx): ReactNode {
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
  if (keys.length === 0) return null;
  return (
    <ul className="list" data-part="account-list">
      {keys.map((k) => (
        <li key={k} className="row" data-part="settings-row">
          <span />
          <span className="row-title" data-key={k}>
            {text(c, k)}
          </span>
          <span />
        </li>
      ))}
    </ul>
  );
}

/** The release channels on offer as one radio group: the one in use is checked, a pick is reported
 *  through `onSelect` (the channel's own name, which is the product's, never the catalog's). */
function channelRows(c: KitCtx): ReactNode {
  const ch = c.input.channel;
  const options = ch?.options ?? [];
  if (c.view.state !== "default" || options.length === 0) return null;
  const on = c.input.selected ?? ch?.current ?? options[0];
  return (
    <div
      className="list"
      role="radiogroup"
      aria-labelledby="pk-title"
      data-part="channel-list"
    >
      {options.map((o, i) => (
        <div
          key={o}
          className="row"
          role="radio"
          data-part="channel-row"
          tabIndex={o === on ? 0 : -1}
          aria-checked={o === on ? "true" : "false"}
          onClick={() => c.pick(o)}
          onKeyDown={(e) =>
            radioKeys(e, c, i, options.length, (n) => options[n]!)
          }
        >
          <span />
          <span className="row-title">
            <bdi>{o}</bdi>
          </span>
          {o === on ? GLYPHS.check() : <span />}
        </div>
      ))}
    </div>
  );
}
