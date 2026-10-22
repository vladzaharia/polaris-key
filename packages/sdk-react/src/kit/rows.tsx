// The content the kit draws for the screens the gate rarely shows first: OfflineActivation's two
// steps, the Replace step, device rows, release notes, settings rows, the account pane and the
// channel picker. Loaded on demand (lazy.ts) so the gate's entry stays inside its size budget
// (SP-47): until it arrives these draw nothing, and every kit component redraws when it does.

import { Fragment, type ReactNode } from "react";
import { platformLabel } from "./contract.js";
import {
  button,
  days,
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
        {button(
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
      Object.prototype.hasOwnProperty.call(ACRONYMS, w.toLowerCase())
        ? ACRONYMS[w.toLowerCase()]!
        : w.toLocaleLowerCase(),
    )
    .join(" ");
  return phrase ? phrase[0]!.toLocaleUpperCase() + phrase.slice(1) : row.key;
}

export function settingsRows(c: KitCtx): ReactNode {
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
    const k = state ? `cloudSync.${state}` : "";
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

/** The release channels on offer as one radio group: the one in use is checked, a pick is reported
 *  through `onSelect` (the channel's own name, which is the product's, never the catalog's). */
export function channelRows(c: KitCtx): ReactNode {
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
