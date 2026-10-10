// One template per component form (screen, pane, banner, toast, inline) over the elements'
// `LAYOUTS`, plus the content a few components draw themselves: the key field, the user code,
// device and license rows, progress, release notes and settings rows. The React twin of
// `@polaris-key/elements` src/views.ts: the same DOM, so the shared stylesheet draws both alike.

import type { ReactNode } from "react";
import type { View } from "@polaris-key/ui-core";
import {
  isTitleKey,
  LAYOUTS,
  type Layout,
} from "@polaris-key/elements/contract";

import {
  a11yOnly,
  actions,
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
  shimmer,
  statusLine,
  text,
  titles,
  type KitCtx,
} from "./parts.js";

const ERROR_PREFIXES = ["core.codes.", "core.activation."];
const isErrorKey = (k: string) =>
  ERROR_PREFIXES.some((p) => k.startsWith(p)) ||
  /(Failed|\.failed|methodError|\.error)$/.test(k);

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
  const linkKeys = (layout.links ?? []).filter((k) => all.includes(k));
  const placed = new Set([...controls, ...linkKeys, ...content]);
  const rest = all.filter((k) => !placed.has(k));
  const titleKeys = ordered(
    rest.filter((k) => isTitleKey(k, layout)),
    layout,
  );
  const meta = rest.filter((k) => layout.meta?.includes(k));
  const footnote = rest.filter((k) => layout.footnote?.includes(k));
  const body = ordered(
    rest.filter(
      (k) =>
        !titleKeys.includes(k) && !meta.includes(k) && !footnote.includes(k),
    ),
    layout,
  );
  return {
    controls,
    links: linkKeys,
    titles: titleKeys,
    meta,
    body,
    footnote,
  };
}

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
      const editing = [
        "empty",
        "typing",
        "parsed",
        "cut-short",
        "rejected",
      ].includes(view.state);
      const used = input.activation?.deviceCount;
      const limit = input.activation?.limit;
      return (
        <>
          {editing
            ? keyField(c, invalid, verdict.length ? "pk-verdict" : null)
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
      const showUrl = keys.has("signin.handoff.url") && url?.display;
      return (
        <>
          {codeDisplay(c)}
          {qrCode(c, url?.qr ? url.url : null)}
          {showUrl ? (
            <p className="body" data-key="signin.handoff.url">
              {text(c, "signin.handoff.url", { url: url!.display! })}
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
      return licenseRows(c);
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

/** A blocking step: the card on the product ambient (DL1, DL2, DL5). */
function screen(c: KitCtx, layout: Layout): ReactNode {
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
  return (
    <section
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
        <div className="split passport">
          {showIdentity
            ? productHeader(c, layout.header, {
                name: !titleNames,
                developer: view.copy.includes("common.byDeveloper"),
              })
            : null}
        </div>
        <div className="texts" data-part="texts">
          {titles(c, p.titles, heroTitle ? "display" : "title")}
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
    </section>
  );
}

/** An embedded pane (DL2): start edge, at most 40rem, its own frame unless `bare`. */
function pane(c: KitCtx, layout: Layout): ReactNode {
  const p = placeKeys(c.view, layout);
  const errorKeys = p.body.filter(isErrorKey);
  const body = p.body.filter((k) => !isErrorKey(k));
  const loading = isLoading(c.view);
  return (
    <section
      className="pane step"
      data-part="pane"
      aria-busy={loading ? "true" : undefined}
    >
      {loading ? shimmer() : null}
      {productHeader(c, layout.header === "none" ? "none" : "compact")}
      <div className="texts" data-part="texts">
        {titles(c, p.titles, "section")}
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
        ? seatMeter(c, used, limit)
        : null}
      {keys.has("signin.replace.meta") ? (
        <div
          className="list"
          role="radiogroup"
          aria-labelledby="pk-title"
          data-part="device-list"
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
                    platform: d.platform ?? "",
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
      className="list"
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
        const metaArgs = {
          origin: origin && keys.has(origin) ? plain(c, origin) : "",
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
                  {text(c, "signin.choice.meta", metaArgs)}
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

function deviceRows(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  if (keys.has("devices.renameLabel")) {
    const device = String(c.view.args.device ?? "");
    return (
      <div className="field" data-part="rename">
        <label className="label" htmlFor="pk-rename">
          {text(c, "devices.renameLabel")}
        </label>
        <div className="field-row">
          <input
            id="pk-rename"
            defaultValue={device}
            data-key="devices.renameLabel"
            autoComplete="off"
            onChange={(e) => c.edit("rename", e.currentTarget.value)}
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
  if (keys.has("devices.removeConfirm"))
    return (
      <div className="callout" data-part="confirm">
        <span>{text(c, "devices.removeConfirm")}</span>
        <div className="actions" data-layout="row">
          {button(c, "devices.remove", "danger")}
          {button(c, "common.cancel", "secondary")}
        </div>
      </div>
    );
  if (!keys.has("devices.meta")) return null;
  const list = c.input.devices ?? [];
  return (
    <ul className="list" data-part="device-list">
      {list.map((d, i) => (
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
                  })}{" "}
                  ·{" "}
                </>
              ) : null}
              {text(c, "devices.meta", {
                platform: d.platform ?? "",
                when: days(d.lastSeenDays),
              })}
            </span>
          </span>
          <span className="row-actions">
            {button(c, "devices.rename", "link", {
              label: plain(c, "a11y.renameDevice", { device: d.name ?? "" }),
            })}
            {d.current
              ? null
              : button(c, "devices.remove", "link", {
                  label: plain(c, "a11y.removeDevice", {
                    device: d.name ?? "",
                  }),
                })}
          </span>
        </li>
      ))}
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

function settingsRows(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  const rows = c.input.config ?? [];
  const shown = [...keys].filter(
    (k) =>
      k.startsWith("settings.") &&
      (k.startsWith("settings.source.") ||
        k === "settings.on" ||
        k === "settings.off" ||
        k === "settings.setBy" ||
        k === "settings.setByGuardian" ||
        k === "settings.fromDeveloper" ||
        k === "settings.range" ||
        k === "settings.search"),
  );
  if (rows.length === 0 && shown.length === 0) return null;
  return (
    <ul className="list" data-part="settings-list">
      {rows.map((r) => (
        <li key={r.key} className="row" data-part="settings-row">
          <span />
          <span>
            <span className="row-title">{r.key}</span>
          </span>
          <span className="meta">
            {r.locked && keys.has("settings.setBy")
              ? text(c, "settings.setBy", { org: r.org ?? "" })
              : r.value === undefined
                ? ""
                : String(r.value)}
          </span>
        </li>
      ))}
      {shown
        .filter((k) => !(k === "settings.setBy" && rows.some((r) => r.locked)))
        .map((k) => (
          <li key={k} className="row">
            <span />
            <span className="meta" data-key={k}>
              {text(c, k)}
            </span>
            <span />
          </li>
        ))}
    </ul>
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
