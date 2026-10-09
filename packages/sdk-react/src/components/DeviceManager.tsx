// `<DeviceManager>` — list / rename / remove, over the adapter's device methods.
//
// The interesting case here is the one that ISN'T supported. A browser cookie session holds no
// `pkeyt_` bearer token and `/<p>/devices` authenticates with one, so remote device management
// is genuinely unreachable from a browser — and a desktop bridge that predates the `invoke()`
// escape hatch cannot reach it either. Both refuse with `device-management-unsupported`.
//
// So this component treats that refusal as a FIRST-CLASS STATE, not an error: it says where the
// person can manage devices instead (devices.browser). An unsupported capability rendered as a
// red "something went wrong" trains people to ignore real failures. A real failure to load the
// list is its own state, with Try again: never the "no devices" state, which would be false.
//
// Every state renders inside the panel, in the host's page; nothing here takes the window. Every
// string is a catalog value from the theme copy (packages/brand/kit-copy/en.json, the core copy
// in conformance/parity/copy.en.json), and every failure reads the catalog's sentence for it,
// never the error's message text.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { SPACE } from "@polaris-key/brand";
import { useAdapterState, useCtx, usePolarisTheme } from "../react/hooks.js";
import type { DeviceInfo } from "../core/index.js";
import {
  copyMessage,
  copyTitle,
  describeError,
  hasCopy,
} from "../core/copy.js";
import { Button } from "./primitives/buttons.js";
import {
  Panel,
  chipStyle,
  dangerText,
  mutedText,
  titleText,
  typeStep,
} from "./primitives/card.js";
import { useIsomorphicLayoutEffect } from "./primitives/layout.js";
import { TextField } from "./primitives/input.js";
import { themePoweredBy } from "./brand.js";
import { formatCopy } from "./format.js";
import { knownProductName, type PolarisTheme } from "./theme.js";

export interface DeviceManagerSlots {
  /** Replace the whole device list. */
  devices?: (devices: DeviceInfo[]) => ReactNode;
  /** Replace one row. */
  device?: (device: DeviceInfo) => ReactNode;
  /** Replace the "no devices" state. */
  empty?: () => ReactNode;
  /** Replace the "this transport cannot manage devices" state. Receives the refusal's
   *  diagnostic message (for logs; show the person your own words). */
  unsupported?: (message: string) => ReactNode;
}

export interface DeviceManagerProps {
  slots?: DeviceManagerSlots;
  className?: string;
  /** Hide the rename affordance (list + remove only). */
  readOnly?: boolean;
  /** No border, background, radius or inline padding, for a host that frames the panel itself
   *  (the title and the row dividers stay). */
  bare?: boolean;
  /** Where the person can manage their devices (the customer portal's device page). Shown as a
   *  "Manage devices" link when this transport cannot manage devices itself. */
  manageUrl?: string;
}

/** The row editor open in the list: at most one at a time. */
type Editor = { id: string; kind: "rename" | "remove" } | null;

const rowStyle = (last: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: SPACE["3"],
  paddingBlock: SPACE["3"],
  borderBottom: last ? "none" : "1px solid var(--pk-border)",
});

/** A row: the name and its meta on the start side, the actions on the end. When the row is too
 *  narrow for both (a phone, a sidebar), the actions wrap under the name as a row of their own,
 *  so nothing is pushed out of the card. */
const rowMain: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: `${SPACE["2"]} ${SPACE["4"]}`,
};

const rowInfo: CSSProperties = {
  flex: "1 1 14rem",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: SPACE["1"],
};

/** The name, with the This device chip flowing inline after it (on the name's last line). */
const rowName: CSSProperties = {
  ...typeStep("sm"),
  minWidth: 0,
  overflowWrap: "anywhere",
};

const rowActions: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: SPACE["2"],
};

const badgeStyle: CSSProperties = {
  ...chipStyle,
  display: "inline-block",
  marginInlineStart: SPACE["2"],
  verticalAlign: "middle",
};

/** A ghost button that starts a row lines its text up with the content edge. */
const ghostLead: CSSProperties = { marginInlineStart: `-${SPACE["3"]}` };

/** Present to assistive tech, absent from the layout. */
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/** The platform names a row shows, for the ids the SDKs report. */
const PLATFORM_NAMES: Record<string, string> = {
  macos: "macOS",
  ipados: "iPadOS",
  ios: "iOS",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
};

/** A platform id as a person reads it: the known names, else the id title-cased. */
export function platformName(id: string | null | undefined): string | null {
  if (!id) return null;
  const known = PLATFORM_NAMES[id.toLowerCase()];
  if (known) return known;
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "2 days ago", from epoch seconds (`DeviceInfo.lastVerifiedAt`). */
function lastSeen(at: number | undefined, now = Date.now()): string | null {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return null;
  const ms = at * 1000;
  const seconds = Math.round((ms - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  if (abs < 365 * 86400)
    return rtf.format(Math.round(seconds / (30 * 86400)), "month");
  return rtf.format(Math.round(seconds / (365 * 86400)), "year");
}

/** The catalog title and sentence for a failure: the error's own code when the catalog has it,
 *  else the operation's (`device_list_failed`, …). Never the error's message text. */
export function deviceFailure(
  e: unknown,
  fallback: string,
): { title: string; body: string } {
  const err = (e && typeof e === "object" ? e : {}) as {
    code?: string;
    wireCode?: string;
  };
  const known = [err.wireCode, err.code].find(
    (c): c is string => !!c && c !== "unknown" && hasCopy(c),
  );
  if (!known)
    return { title: copyTitle(fallback), body: copyMessage(fallback) };
  return {
    title: copyTitle(known),
    body: describeError(known === err.wireCode ? err : { code: known }),
  };
}

/** A row's title: its name, or "Unnamed device" (never the raw id or a status). */
function titleOf(device: DeviceInfo, theme: PolarisTheme): string {
  return device.label?.trim() || theme.copy.deviceUnnamed;
}

/** A row's muted line: the platform, and when it was last seen (devices.meta) when known; the
 *  id, for a device with no name. */
function metaOf(device: DeviceInfo, theme: PolarisTheme): string {
  const platform = platformName(device.platform);
  const when = lastSeen(device.lastVerifiedAt);
  const parts: string[] = [];
  if (platform && when)
    parts.push(formatCopy(theme.copy.deviceMeta, { platform, when }));
  else if (platform) parts.push(platform);
  if (!device.label?.trim()) parts.push(device.id);
  return parts.join(" · ");
}

/** `CSS.escape` where it exists (every browser); a plain escape elsewhere. */
function cssEscape(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/["\\]/g, "\\$&");
}

export function DeviceManager(props: DeviceManagerProps): React.JSX.Element {
  const theme = usePolarisTheme();
  // The ADAPTER, not `usePolarisKey()`: that hook rebuilds its bound callbacks on every
  // snapshot, so an effect depending on it would re-fetch the roster on every state change.
  // The adapter is stable for the provider's lifetime.
  const { adapter } = useCtx();
  const state = useAdapterState(adapter);
  const ready = state.phase === "ready";
  const titleId = useId();
  const slots = props.slots ?? {};

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);

  // Where focus goes once the list re-renders (after a save, a cancel, a removal).
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    if (selector === "heading") {
      pendingFocus.current = null;
      headingRef.current?.focus();
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(selector);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await adapter.listDevices();
      setDevices(rows);
      setUnsupported(null);
      setLoadError(null);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "device-management-unsupported") {
        setUnsupported(err.message ?? "");
        setLoadError(null);
        // The current device is still knowable from the verified document, so show at least
        // that rather than pretending the person has none.
        const current = adapter.currentDevice();
        setDevices(current ? [current] : []);
      } else {
        setLoadError(e ?? {});
      }
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [adapter]);

  // Wait for the first snapshot: `currentDevice()` is null during `loading`, so a roster
  // fetched before then would report "no devices" for a session that has one.
  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const product = knownProductName(theme) ?? theme.copy.productName;
  const limit = state.entitlements?.["deviceLimit"];
  const subtitle =
    loaded && !loadError && unsupported === null && devices.length > 0
      ? typeof limit === "number"
        ? formatCopy(theme.copy.deviceLimitHeading, {
            used: devices.length,
            limit,
          })
        : formatCopy(theme.copy.devicesCount, { count: devices.length })
      : null;

  let body: ReactNode;
  if (!ready || (!loaded && devices.length === 0)) {
    // The first load only: a refresh keeps the rows on screen and updates them in place.
    body = (
      <p style={mutedText} role="status" data-polaris-devices="loading">
        {theme.copy.devicesLoadingLabel}
      </p>
    );
  } else if (loadError) {
    const failure = deviceFailure(loadError, "device_list_failed");
    body = (
      <div
        role="alert"
        data-polaris-devices="error"
        style={{ display: "flex", flexDirection: "column", gap: SPACE["3"] }}
      >
        <div>
          <p style={{ ...typeStep("sm"), margin: 0, fontWeight: 600 }}>
            {failure.title}
          </p>
          <p style={mutedText}>{failure.body}</p>
        </div>
        <div>
          <Button
            variant="primary"
            busy={loading}
            onClick={() => void load()}
            data-polaris-devices-retry=""
          >
            {theme.copy.retryLabel}
          </Button>
        </div>
      </div>
    );
  } else if (unsupported !== null && devices.length === 0) {
    body = slots.unsupported ? (
      <>{slots.unsupported(unsupported)}</>
    ) : (
      <UnsupportedLine
        theme={theme}
        manageUrl={props.manageUrl}
        marker="unsupported"
      />
    );
  } else if (devices.length === 0) {
    body = slots.empty ? (
      <>{slots.empty()}</>
    ) : (
      <p style={mutedText} role="status" data-polaris-devices="empty">
        {theme.copy.devicesEmpty}
      </p>
    );
  } else if (slots.devices) {
    body = <>{slots.devices(devices)}</>;
  } else {
    const readOnly = props.readOnly || unsupported !== null;
    body = (
      <>
        {unsupported !== null ? (
          <UnsupportedLine
            theme={theme}
            manageUrl={props.manageUrl}
            marker="partial"
          />
        ) : null}
        <ul
          style={{ listStyle: "none", margin: 0, padding: 0 }}
          data-polaris-devices="rows"
        >
          {devices.map((device, index) => (
            <li
              key={device.id}
              style={rowStyle(index === devices.length - 1)}
              data-polaris-device={device.id}
            >
              {slots.device ? (
                slots.device(device)
              ) : (
                <DeviceRow
                  device={device}
                  theme={theme}
                  product={product}
                  readOnly={readOnly}
                  editor={
                    editor && editor.id === device.id ? editor.kind : null
                  }
                  onEdit={(kind) => setEditor({ id: device.id, kind })}
                  onClose={(refocus) => {
                    pendingFocus.current = refocus;
                    setEditor(null);
                  }}
                  onRename={async (label) => {
                    await adapter.renameDevice(device.id, label);
                    pendingFocus.current = `[data-polaris-device-rename="${cssEscape(device.id)}"]`;
                    setEditor(null);
                    await load();
                  }}
                  onRemove={async () => {
                    if (device.current) await adapter.signOut();
                    else await adapter.deauthorizeDevice(device.id);
                    // Focus moves to the next row's first action (or the one before it), or
                    // the heading once no rows are left.
                    const next = devices[index + 1] ?? devices[index - 1];
                    pendingFocus.current = next
                      ? `[data-polaris-device="${cssEscape(next.id)}"] [data-polaris-device-action]`
                      : "heading";
                    setEditor(null);
                    await load();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <Panel
      className={props.className}
      bare={props.bare}
      data-polaris-devices="panel"
      aria-labelledby={titleId}
    >
      <div>
        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          style={{ ...titleText, outline: "none" }}
        >
          {theme.copy.devicesTitle}
        </h2>
        {subtitle ? (
          <p style={mutedText} data-polaris-devices-subtitle="">
            {subtitle}
          </p>
        ) : null}
      </div>
      <div ref={listRef} style={{ display: "contents" }}>
        {body}
      </div>
      {themePoweredBy(theme)}
    </Panel>
  );
}

/** The portal link, drawn as a compact secondary control (a target of its own, not a word in
 *  a sentence). */
const manageLink: CSSProperties = {
  ...typeStep("sm"),
  display: "inline-flex",
  alignItems: "center",
  boxSizing: "border-box",
  minHeight: "2.375rem",
  padding: `${SPACE["2"]} ${SPACE["3"]}`,
  border: "1px solid var(--pk-border-strong, var(--pk-border))",
  borderRadius: "var(--pk-control-radius, var(--pk-radius))",
  color: "var(--pk-text-strong, var(--pk-text))",
  fontWeight: 500,
  textDecoration: "none",
};

function UnsupportedLine(props: {
  theme: PolarisTheme;
  manageUrl?: string;
  marker: "unsupported" | "partial";
}): React.JSX.Element {
  const { theme, manageUrl } = props;
  return (
    <div
      role="status"
      data-polaris-devices={props.marker}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: SPACE["3"],
      }}
    >
      <p style={mutedText}>{theme.copy.devicesUnsupportedBody}</p>
      {manageUrl ? (
        <a
          href={manageUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={manageLink}
          data-polaris-devices-manage=""
        >
          {theme.copy.devicesManageLabel}
        </a>
      ) : null}
    </div>
  );
}

function DeviceRow(props: {
  device: DeviceInfo;
  theme: PolarisTheme;
  product: string;
  readOnly?: boolean;
  editor: "rename" | "remove" | null;
  onEdit: (kind: "rename" | "remove") => void;
  /** Close the open editor, then focus the element this selector names. */
  onClose: (refocus: string) => void;
  onRename: (label: string | null) => Promise<void>;
  onRemove: () => Promise<void>;
}): React.JSX.Element {
  const { device, theme } = props;
  const title = titleOf(device, theme);
  const meta = metaOf(device, theme);
  const nameId = useId();
  const inputId = useId();
  const renameErrorId = useId();
  const confirmId = useId();
  const [label, setLabel] = useState(device.label ?? "");
  const [busy, setBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const id = cssEscape(device.id);
  const renameSel = `[data-polaris-device-rename="${id}"]`;
  const removeSel = `[data-polaris-device-disconnect="${id}"]`;
  // On this device's row the action signs out; elsewhere it removes the device.
  const removeLabel = device.current
    ? theme.copy.signOutLabel
    : theme.copy.deviceRemoveLabel;

  const save = async (): Promise<void> => {
    setBusy(true);
    setRenameError(null);
    try {
      await props.onRename(label.trim() || null);
    } catch (e) {
      setRenameError(deviceFailure(e, "device_rename_failed").body);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setRemoveError(null);
    try {
      await props.onRemove();
    } catch (e) {
      setRemoveError(deviceFailure(e, "device_deauthorize_failed").body);
      props.onClose(removeSel);
    } finally {
      setBusy(false);
    }
  };

  const renaming = props.editor === "rename" && !props.readOnly;
  const confirming = props.editor === "remove";

  // An opened editor comes into view whole (its Save and Cancel too), not only its field.
  const editorRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (renaming) editorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [renaming]);

  return (
    <>
      {renaming ? (
        // Opened on request only, in place of the name line, so the name is not shown twice.
        // Escape closes it, and focus goes back to Rename.
        <form
          ref={editorRef}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: SPACE["2"],
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void save();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            props.onClose(renameSel);
          }}
          data-polaris-device-rename-form={device.id}
        >
          <span id={nameId} style={visuallyHidden} dir="auto">
            {title}
          </span>
          <TextField
            id={inputId}
            label={theme.copy.deviceRenameLabel}
            value={label}
            onChange={(v) => {
              setLabel(v);
              setRenameError(null);
            }}
            busy={busy}
            autoFocus
            dir="auto"
            describedBy={nameId}
            errorId={renameError ? renameErrorId : undefined}
            data-polaris-device-input={device.id}
          />
          {renameError ? (
            <p
              id={renameErrorId}
              role="alert"
              style={dangerText}
              data-polaris-device-error={device.id}
            >
              {renameError}
            </p>
          ) : null}
          {meta ? (
            <span style={{ ...mutedText, overflowWrap: "anywhere" }}>
              {meta}
            </span>
          ) : null}
          <div style={rowActions}>
            <Button variant="primary" type="submit" size="compact" busy={busy}>
              {theme.copy.deviceRenameSubmitLabel}
            </Button>
            <Button
              variant="ghost"
              size="compact"
              disabled={busy}
              onClick={() => props.onClose(renameSel)}
            >
              {theme.copy.deviceRenameCancelLabel}
            </Button>
          </div>
        </form>
      ) : (
        <div style={rowMain}>
          <div style={rowInfo}>
            <div style={rowName}>
              <span id={nameId} style={{ fontWeight: 600 }} dir="auto">
                {title}
              </span>
              {device.current ? (
                <span style={badgeStyle} data-polaris-device-current="">
                  {theme.copy.deviceCurrentBadge}
                </span>
              ) : null}
            </div>
            {meta ? (
              <span style={{ ...mutedText, overflowWrap: "anywhere" }}>
                {meta}
              </span>
            ) : null}
          </div>
          {confirming ? null : (
            <div style={rowActions}>
              {props.readOnly ? null : (
                <Button
                  variant="secondary"
                  size="compact"
                  label={formatCopy(theme.copy.deviceRenameA11yLabel, {
                    device: title,
                  })}
                  onClick={() => {
                    setLabel(device.label ?? "");
                    setRenameError(null);
                    props.onEdit("rename");
                  }}
                  data-polaris-device-rename={device.id}
                  data-polaris-device-action=""
                >
                  {theme.copy.deviceRenameActionLabel}
                </Button>
              )}
              <Button
                variant="ghost"
                size="compact"
                style={props.readOnly ? ghostLead : undefined}
                label={
                  device.current
                    ? removeLabel
                    : formatCopy(theme.copy.deviceRemoveA11yLabel, {
                        device: title,
                      })
                }
                onClick={() => {
                  setRemoveError(null);
                  props.onEdit("remove");
                }}
                data-polaris-device-disconnect={device.id}
                {...(props.readOnly
                  ? { "data-polaris-device-action": "" }
                  : {})}
              >
                {removeLabel}
              </Button>
            </div>
          )}
        </div>
      )}
      {confirming ? (
        // The inline confirm: only its primary removes. Focus starts on Cancel; Escape cancels
        // and puts focus back on the row's action.
        <div
          role="group"
          aria-labelledby={confirmId}
          style={{ display: "flex", flexDirection: "column", gap: SPACE["2"] }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            props.onClose(removeSel);
          }}
          data-polaris-device-confirm={device.id}
        >
          <p id={confirmId} style={{ ...typeStep("sm"), margin: 0 }}>
            {formatCopy(theme.copy.deviceRemoveConfirm, {
              device: title,
              product: props.product,
            })}
          </p>
          <div style={rowActions}>
            <Button
              variant="danger"
              size="compact"
              busy={busy}
              onClick={() => void remove()}
              data-polaris-device-confirm-remove={device.id}
            >
              {removeLabel}
            </Button>
            <CancelButton
              label={theme.copy.deviceRenameCancelLabel}
              disabled={busy}
              onClick={() => props.onClose(removeSel)}
            />
          </div>
        </div>
      ) : null}
      {removeError ? (
        <p
          role="alert"
          style={dangerText}
          data-polaris-device-error={device.id}
        >
          {removeError}
        </p>
      ) : null}
    </>
  );
}

/** Cancel in the inline confirm, focused when the confirm opens. */
function CancelButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="compact"
      disabled={props.disabled}
      onClick={props.onClick}
      data-polaris-device-confirm-cancel=""
    >
      {props.label}
    </Button>
  );
}
