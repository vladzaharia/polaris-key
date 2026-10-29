// The content the kit draws for the screens the gate rarely shows first: OfflineActivation's two
// steps, the Replace step, device rows, release notes, settings rows, the account pane and the
// channel picker. Loaded on demand (lazy.ts) so the gate's entry stays inside its size budget
// (SP-47): until it arrives these draw nothing, and every kit component redraws when it does.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  outOfRange,
  platformLabel,
  settingKind,
  settingLabel,
  settingText,
  sliderStep,
  type SettingsRow,
} from "./contract.js";
import {
  button,
  days,
  docksLoadFile,
  GLYPHS,
  openOnChecked,
  plain,
  qrCode,
  radioKeys,
  since,
  text,
  usableKey,
  type KitCtx,
} from "./parts.js";

/** OfflineActivation as two numbered steps: the request code (with Copy and a QR), then the
 *  response (Load file, the paste box, the drop hint). The verdict follows below. */
export function offlineSteps(c: KitCtx): ReactNode {
  if (c.view.state === "done") return null;
  const keys = new Set(c.view.copy);
  const code = c.input.offline?.requestCode;
  const loaded = c.input.offline?.response ?? "";
  const primary = c.view.decisions.primary;
  const variant = (k: string) => (k === primary ? "primary" : "secondary");
  return (
    <ol className="steps" data-part="steps">
      <li className="step-item" data-part="step">
        <p className="body" data-key="offlineActivation.request">
          {text(c, "offlineActivation.request")}
        </p>
        {code ? (
          <>
            <span className="code-row">
              <span className="code" data-mono="" data-part="request-code">
                {code}
              </span>
              {button(
                c,
                "offlineActivation.copyCode",
                variant("offlineActivation.copyCode"),
                { detail: { value: code } },
              )}
            </span>
            {qrCode(c, code, "a11y.qrRequest")}
          </>
        ) : (
          button(
            c,
            "offlineActivation.copyCode",
            variant("offlineActivation.copyCode"),
          )
        )}
        {keys.has("offlineActivation.codeCopied") ? (
          <span
            className="meta"
            role="status"
            data-key="offlineActivation.codeCopied"
          >
            {text(c, "offlineActivation.codeCopied")}
          </span>
        ) : null}
      </li>
      <li className="step-item" data-part="step">
        <p className="body" data-key="offlineActivation.loadHint">
          {text(c, "offlineActivation.loadHint")}
        </p>
        <div className="field" data-part="response">
          <label className="label" htmlFor="pk-response">
            {text(c, "offlineActivation.paste")}
          </label>
          <textarea
            id="pk-response"
            rows={3}
            spellCheck={false}
            data-mono=""
            data-key="offlineActivation.paste"
            value={loaded}
            onChange={(e) => c.edit("response", e.currentTarget.value)}
          />
          {keys.has("offlineActivation.dropHint") ? (
            <span className="meta" data-key="offlineActivation.dropHint">
              {text(c, "offlineActivation.dropHint")}
            </span>
          ) : null}
        </div>
        {docksLoadFile(c)
          ? null
          : button(
              c,
              "offlineActivation.loadFile",
              variant("offlineActivation.loadFile"),
            )}
      </li>
    </ol>
  );
}

/** The Replace step (SIGN-IN.md §3.7): the license's devices, the least recent preselected, and
 *  the one confirm under the list that names the picked device. */
export function replaceRows(c: KitCtx): ReactNode {
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

export function deviceRows(c: KitCtx): ReactNode {
  const keys = new Set(c.view.copy);
  const list = c.input.devices ?? [];
  const editing = c.view.state === "renaming" || c.view.state === "confirming";
  // The row the edit concerns (`input.selected`); without a list, the form stands alone.
  const edit = c.input.edit;
  const at =
    editing && c.input.selected !== undefined
      ? Number(c.input.selected)
      : edit
        ? list.findIndex((d) => d.name === edit.device)
        : -1;
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
        const glyph = (
          <span
            role="img"
            aria-label={plain(c, "a11y.formFactor", {
              formFactor: d.formFactor ?? "other",
            })}
          >
            {GLYPHS.device(d.formFactor)}
          </span>
        );
        if (c.view.state === "renaming" && i === at)
          return (
            <li
              key={i}
              className="row"
              data-part="device-row"
              data-editing="rename"
            >
              {glyph}
              <div className="field" data-part="rename">
                <label className="label" htmlFor="pk-rename">
                  {text(c, "devices.renameLabel")}
                </label>
                <input
                  id="pk-rename"
                  defaultValue={d.name ?? ""}
                  data-key="devices.renameLabel"
                  autoComplete="off"
                  onChange={(e) => c.edit("rename", e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") c.act("common.save");
                  }}
                />
              </div>
              <span className="row-actions">
                {button(c, "common.save", "primary")}
                {button(c, "common.cancel", "secondary")}
              </span>
            </li>
          );
        if (c.view.state === "confirming" && i === at)
          return (
            <li
              key={i}
              className="row"
              data-part="device-row"
              data-editing="remove"
            >
              {glyph}
              <div className="callout" data-part="confirm" role="group">
                <span data-key="devices.removeConfirm">
                  {text(c, "devices.removeConfirm", { device: label })}
                </span>
                <div className="actions" data-layout="row">
                  {button(c, "devices.remove", "danger")}
                  {button(c, "common.cancel", "secondary")}
                </div>
              </div>
            </li>
          );
        const row = (
          <li key={i} className="row" data-part="device-row">
            {glyph}
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
        return row;
      })}
    </ul>
  );
}

export function releaseNotes(c: KitCtx): ReactNode {
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

export { settingLabel, type SettingsRow };

/** A bounded number: the slider, with its value read out beside it. It keeps its own position
 *  while it is dragged and reports each move; a new value from the host moves it. */
function SettingSlider(props: {
  row: SettingsRow;
  name: string;
  describedBy: string | undefined;
  bad: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  const { row, name } = props;
  const min = row.min as number;
  const max = row.max as number;
  const start = typeof row.value === "number" ? row.value : min;
  const [now, setNow] = useState(start);
  useEffect(() => setNow(start), [start]);
  return (
    <span className="slider" data-part="slider">
      <input
        type="range"
        aria-label={name}
        aria-invalid={props.bad ? "true" : "false"}
        aria-describedby={props.describedBy}
        min={min}
        max={max}
        step={sliderStep(row)}
        value={now}
        onChange={(e) => {
          setNow(Number(e.currentTarget.value));
          props.onChange(e.currentTarget.value);
        }}
      />
      <output className="meta">{row.display ?? String(now)}</output>
    </span>
  );
}

/** The field a setting's value is edited in (UI-KITS.md §4.1): a switch, a slider for a bounded
 *  number, a number field, a select or text. Switches, sliders and choices apply at once; a number
 *  or text applies when it loses focus or on Enter. The host hears `config:<key>` with the new
 *  value. */
function settingControl(
  c: KitCtx,
  r: SettingsRow,
  name: string,
  describedBy: string | undefined,
  bad: boolean,
): ReactNode {
  const field = `config:${r.key}`;
  const kind = settingKind(r);
  if (kind === "switch") {
    const on = r.value === true;
    const word = on ? "settings.on" : "settings.off";
    return (
      <>
        {c.copy.has(word) ? (
          <span className="meta" data-key={word}>
            {text(c, word)}
          </span>
        ) : null}
        <span className="switch-wrap">
          <button
            type="button"
            role="switch"
            className="switch"
            data-part="switch"
            aria-checked={on ? "true" : "false"}
            aria-label={name}
            onClick={() => c.edit(field, String(!on))}
          >
            <span className="switch-thumb" />
          </button>
        </span>
      </>
    );
  }
  if (kind === "slider")
    return (
      <SettingSlider
        row={r}
        name={name}
        describedBy={describedBy}
        bad={bad}
        onChange={(v) => c.edit(field, v)}
      />
    );
  const now = r.value === undefined || r.value === null ? "" : String(r.value);
  if (kind === "select") {
    const options =
      r.options ?? (now ? [{ value: now, label: settingText(r) }] : []);
    return (
      <span className="field">
        <select
          aria-label={name}
          value={now}
          onChange={(e) => c.edit(field, e.currentTarget.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    );
  }
  const number = kind === "number";
  const commit = (el: HTMLInputElement) => {
    if (el.value !== now) c.edit(field, el.value);
  };
  return (
    <span className="field">
      <input
        key={now}
        type={number ? "number" : "text"}
        aria-label={name}
        defaultValue={now}
        autoComplete="off"
        {...(number
          ? {
              inputMode: "decimal" as const,
              "aria-invalid": bad ? ("true" as const) : ("false" as const),
              "aria-describedby": describedBy,
              ...(r.min !== undefined ? { min: r.min } : {}),
              ...(r.max !== undefined ? { max: r.max } : {}),
              ...(r.step !== undefined ? { step: r.step } : {}),
            }
          : r.maxLength !== undefined
            ? { maxLength: r.maxLength }
            : {})}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget);
        }}
      />
    </span>
  );
}

export function settingsRows(c: KitCtx): ReactNode {
  const has = (k: string) => c.copy.has(k);
  const rows = (c.input.config ?? []) as SettingsRow[];
  const advanced =
    (c.input as { drafts?: Record<string, unknown> }).drafts?.advanced === true;
  const visible = rows.filter((r) => !r.advanced || advanced);
  // Each row: its name, where its value comes from (or who set it), and the value at the end.
  const drawn = visible.map((r) => {
    const label = settingLabel(r);
    const meta: ReactNode[] = [];
    const from = r.locked
      ? r.org
        ? "settings.setBy"
        : "settings.setByGuardian"
      : `settings.source.${r.source}`;
    // Validated as you type: the range turns into the error, and Save waits (aria-invalid).
    const bad = outOfRange(r);
    if (has(from))
      meta.push(
        <span key={from} data-key={from}>
          {text(c, from, { org: r.org ?? "" })}
        </span>,
      );
    const ranged =
      r.type === "number" &&
      typeof r.min === "number" &&
      typeof r.max === "number" &&
      has("settings.range");
    if (ranged)
      meta.push(
        <span
          key="range"
          id={`pk-range-${r.key}`}
          data-key="settings.range"
          {...(bad ? { className: "message", "data-tone": "danger" } : {})}
        >
          {text(c, "settings.range", {
            min: r.min as number,
            max: r.max as number,
          })}
        </span>,
      );
    let value: ReactNode;
    if (r.locked) {
      // A locked row shows its value as text, with the lock and its source (§4.1).
      if (typeof r.value === "boolean") {
        const k = r.value ? "settings.on" : "settings.off";
        value = <span data-key={k}>{has(k) ? text(c, k) : ""}</span>;
      } else value = <bdi>{settingText(r)}</bdi>;
    } else
      value = settingControl(
        c,
        r,
        label,
        ranged || (has("settings.range") && typeof r.max === "number")
          ? `pk-range-${r.key}`
          : undefined,
        bad,
      );
    return (
      <li key={r.key} className="row" data-part="settings-row">
        <span className="row-text">
          <span className="row-title">
            <bdi>{label}</bdi>
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
          {r.locked && has("a11y.locked") ? (
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
  const group = has("settings.fromDeveloper") ? (
    <h2 className="label group-label" data-key="settings.fromDeveloper">
      {text(c, "settings.fromDeveloper")}
    </h2>
  ) : null;
  const search = c.view.copy.includes("settings.search") ? (
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
  // The view's own source and state words that no row carried still show, once.
  const shown = new Set<string>();
  for (const r of visible) {
    shown.add(
      r.locked
        ? r.org
          ? "settings.setBy"
          : "settings.setByGuardian"
        : `settings.source.${r.source}`,
    );
    if (typeof r.value === "boolean")
      shown.add(r.value ? "settings.on" : "settings.off");
    if (r.type === "number") shown.add("settings.range");
  }
  const rest = c.view.copy.filter(
    (k) =>
      !shown.has(k) &&
      (k.startsWith("settings.source.") ||
        k === "settings.on" ||
        k === "settings.off" ||
        k === "settings.setBy" ||
        k === "settings.setByGuardian" ||
        k === "settings.range"),
  );
  if (visible.length === 0 && rest.length === 0)
    return group === null && search === null ? null : (
      <>
        {search}
        {group}
      </>
    );
  // What the policy locks is its own group: "Managed settings" (§4.1), the person's own below
  // "From <Developer>".
  const open = drawn.filter((_, i) => !visible[i]!.locked);
  const managed = drawn.filter((_, i) => visible[i]!.locked);
  return (
    <>
      {search}
      {open.length || rest.length ? (
        <div className="group" data-part="settings-group">
          {open.length ? group : null}
          {open.length ? (
            <ul className="list" data-part="settings-list">
              {open}
            </ul>
          ) : null}
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
      ) : null}
      {managed.length ? (
        <div className="group" data-part="settings-group" data-managed="">
          {has("account.managedSettings") ? (
            <h2
              className="label group-label"
              data-key="account.managedSettings"
            >
              {text(c, "account.managedSettings")}
            </h2>
          ) : null}
          <ul className="list" data-part="settings-list">
            {managed}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/** "Stable" from a channel id: the kit has no channel names, the host's ids read as words. */
const channelLabel = (id: string): string =>
  id ? id[0]!.toLocaleUpperCase() + id.slice(1) : id;

/** A label-and-value row of the account pane (the elements' markup: label at the start, the
 *  value or control at the end). */
function accountRow(
  key: string,
  label: ReactNode,
  value: ReactNode = null,
): ReactNode {
  return (
    <li key={key} className="row" data-part="settings-row">
      <span className="row-title" data-key={key}>
        {label}
      </span>
      <span className="row-value">{value}</span>
    </li>
  );
}

/** A segmented choice: a radiogroup of buttons, arrows move the choice. */
function segmented(
  name: string,
  options: { id: string; label: string }[],
  current: string | undefined,
  pick: (id: string) => void,
  disabled = false,
): ReactNode {
  const at = Math.max(
    0,
    options.findIndex((o) => o.id === current),
  );
  return (
    <div
      className="segmented"
      role="radiogroup"
      data-part="segmented"
      aria-label={name}
    >
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          data-id={o.id}
          aria-checked={i === at ? "true" : "false"}
          aria-disabled={disabled ? "true" : undefined}
          tabIndex={i === at ? 0 : -1}
          onClick={() => {
            if (!disabled) pick(o.id);
          }}
          onKeyDown={(e) => {
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
            const group = e.currentTarget.parentElement;
            queueMicrotask(() =>
              group
                ?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)
                ?.focus(),
            );
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The account pane's rows, grouped as the web settings frames draw them: the license facts,
 *  then "Updates" over the update controls, then the managed settings. A row whose label names a
 *  fact the input lacks ("{tier} license") is left out. */
export function accountRows(c: KitCtx): ReactNode {
  const { copy } = c.view;
  const input = c.input;
  const has = (k: string) => copy.includes(k);
  const usable = (k: string): boolean => usableKey(c, k);
  const pre: ReactNode[] = [];
  if (has("account.tier") && usable("account.tier"))
    pre.push(accountRow("account.tier", text(c, "account.tier")));
  if (has("account.devices")) {
    const d = input.account?.devices;
    pre.push(
      accountRow(
        "account.devices",
        text(c, "account.devices"),
        d && c.copy.has("part.seatMeter.caption") ? (
          <span className="num">
            {d.limit === null
              ? String(d.used)
              : text(c, "part.seatMeter.caption", {
                  used: d.used,
                  limit: d.limit,
                })}
          </span>
        ) : null,
      ),
    );
  }
  if (has("account.cloudSync")) {
    const state = input.cloudSync?.state;
    const k = state
      ? state === "ring-changed"
        ? "cloudSync.ringChanged"
        : `cloudSync.${state}`
      : "";
    pre.push(
      accountRow(
        "account.cloudSync",
        text(c, "account.cloudSync"),
        k && c.copy.has(k) ? text(c, k) : null,
      ),
    );
  }
  const updateRows: ReactNode[] = [];
  if (has("account.autoUpdate")) {
    const on = input.account?.autoUpdate === true;
    updateRows.push(
      accountRow(
        "account.autoUpdate",
        text(c, "account.autoUpdate"),
        <span className="switch-wrap">
          <button
            type="button"
            role="switch"
            className="switch"
            data-part="switch"
            aria-checked={on ? "true" : "false"}
            aria-label={plain(c, "account.autoUpdate")}
            onClick={() => c.edit("autoUpdate", String(!on))}
          >
            <span className="switch-thumb" />
          </button>
        </span>,
      ),
    );
  }
  if (has("account.channel"))
    updateRows.push(
      accountRow(
        "account.channel",
        text(c, "account.channel"),
        segmented(
          plain(c, "account.channel"),
          (input.channel?.options ?? ["stable", "beta"]).map((id) => ({
            id,
            label: channelLabel(id),
          })),
          input.channel?.current,
          (id) => c.edit("channel", id),
          input.channel?.locked === true,
        ),
      ),
    );
  if (has("account.version") && usable("account.version"))
    updateRows.push(accountRow("account.version", text(c, "account.version")));
  const tail: ReactNode[] = [];
  if (has("account.managedSettings"))
    tail.push(
      accountRow("account.managedSettings", text(c, "account.managedSettings")),
    );
  if (
    pre.length + updateRows.length + tail.length === 0 &&
    !has("account.updates")
  )
    return null;
  return (
    <>
      {pre.length ? (
        <ul className="list" data-part="account-list">
          {pre}
        </ul>
      ) : null}
      {has("account.updates") ? (
        <h2
          className="label group-label"
          data-key="account.updates"
          hidden={updateRows.length === 0}
        >
          {text(c, "account.updates")}
        </h2>
      ) : null}
      {updateRows.length ? (
        <ul className="list" data-part="account-list">
          {updateRows}
        </ul>
      ) : null}
      {tail.length ? (
        <ul className="list" data-part="account-list">
          {tail}
        </ul>
      ) : null}
    </>
  );
}

/** The release channels on offer as one segmented choice: the one in use is checked, a pick is
 *  reported through `onSelect` (the channel's own name, which is the product's, never the
 *  catalog's). The elements draw the same, Stable and Beta when the host names none. */
export function channelRows(c: KitCtx): ReactNode {
  if (c.view.state !== "default") return null;
  const options = (c.input.channel?.options ?? ["stable", "beta"]).map(
    (id) => ({
      id,
      label: channelLabel(id),
    }),
  );
  return segmented(
    plain(c, "channel.title"),
    options,
    c.input.selected ?? c.input.channel?.current,
    (id) => c.pick(id),
  );
}
