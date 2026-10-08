// `<DeviceManager>` — list / rename / disconnect, over the adapter's device methods.
//
// The interesting case here is the one that ISN'T supported. A browser cookie session holds no
// `pkeyt_` bearer token and `/<p>/devices` authenticates with one, so remote device management
// is genuinely unreachable from a browser — and a desktop bridge that predates the `invoke()`
// escape hatch cannot reach it either. Both refuse with `device-management-unsupported`.
//
// So this component treats that refusal as a FIRST-CLASS STATE, not an error: it renders an
// explanation of where the user can manage devices instead. An unsupported capability rendered
// as a red "something went wrong" trains people to ignore real failures.

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
import { Button, compactStyle } from "./primitives/buttons.js";
import {
  Panel,
  chipStyle,
  dangerText,
  mutedText,
  titleText,
  typeStep,
} from "./primitives/card.js";
import { themePoweredBy } from "./brand.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { TextField } from "./primitives/input.js";
import type { PolarisTheme } from "./theme.js";

export interface DeviceManagerSlots {
  /** Replace the whole device list. */
  devices?: (devices: DeviceInfo[]) => ReactNode;
  /** Replace one row. */
  device?: (device: DeviceInfo) => ReactNode;
  /** Replace the "no devices" state. */
  empty?: () => ReactNode;
  /** Replace the "this transport cannot manage devices" state. */
  unsupported?: (message: string) => ReactNode;
}

export interface DeviceManagerProps {
  slots?: DeviceManagerSlots;
  className?: string;
  /** Hide the rename affordance (list + disconnect only). */
  readOnly?: boolean;
}

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: SPACE["3"],
  paddingBlock: SPACE["3"],
  borderBottom: "1px solid var(--pk-border)",
};

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

const rowName: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: SPACE["2"],
  minWidth: 0,
};

const rowActions: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: SPACE["2"],
};

const badgeStyle: CSSProperties = { ...chipStyle, display: "inline-block" };

export function DeviceManager(props: DeviceManagerProps): JSX.Element {
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await adapter.listDevices();
      setDevices(rows);
      setUnsupported(null);
      setError(null);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "device-management-unsupported") {
        setUnsupported(err.message ?? theme.copy.devicesUnsupportedBody);
        // The current device is still knowable from the verified document, so show at least
        // that rather than pretending the user has none.
        const current = adapter.currentDevice();
        setDevices(current ? [current] : []);
      } else {
        setError(err.message ?? "Could not load your devices.");
      }
    } finally {
      setLoading(false);
    }
  }, [adapter, theme.copy.devicesUnsupportedBody]);

  // Wait for the first snapshot: `currentDevice()` is null during `loading`, so a roster
  // fetched before then would report "no devices" for a session that has one.
  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  if (!loading && unsupported && devices.length === 0) {
    return slots.unsupported ? (
      <>{slots.unsupported(unsupported)}</>
    ) : (
      <MessageScreen
        title={theme.copy.devicesUnsupportedTitle}
        body={unsupported}
        data-polaris-devices="unsupported"
      />
    );
  }

  return (
    <Panel
      className={props.className}
      data-polaris-devices="panel"
      aria-labelledby={titleId}
    >
      <div>
        <h2 id={titleId} style={titleText}>
          {theme.copy.devicesTitle}
        </h2>
        <p style={mutedText}>{theme.copy.devicesSubtitle}</p>
      </div>

      {unsupported ? (
        <p style={mutedText} role="status" data-polaris-devices="partial">
          {unsupported}
        </p>
      ) : null}
      {error ? (
        <p style={dangerText} role="alert">
          {error}
        </p>
      ) : null}

      {loading || !ready ? (
        <p style={mutedText} role="status">
          {theme.copy.loadingLabel}
        </p>
      ) : devices.length === 0 ? (
        slots.empty ? (
          <>{slots.empty()}</>
        ) : (
          <p style={mutedText} role="status" data-polaris-devices="empty">
            {theme.copy.devicesEmpty}
          </p>
        )
      ) : slots.devices ? (
        <>{slots.devices(devices)}</>
      ) : (
        <ul
          style={{ listStyle: "none", margin: 0, padding: 0 }}
          data-polaris-devices="rows"
        >
          {devices.map((device) => (
            <li
              key={device.id}
              style={rowStyle}
              data-polaris-device={device.id}
            >
              {slots.device ? (
                slots.device(device)
              ) : (
                <DeviceRow
                  device={device}
                  theme={theme}
                  readOnly={props.readOnly || Boolean(unsupported)}
                  onRename={async (label) => {
                    await adapter.renameDevice(device.id, label);
                    await load();
                  }}
                  onDisconnect={async () => {
                    await adapter.deauthorizeDevice(device.id);
                    await load();
                  }}
                  onError={setError}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {themePoweredBy(theme)}
    </Panel>
  );
}

function DeviceRow(props: {
  device: DeviceInfo;
  theme: PolarisTheme;
  readOnly?: boolean;
  onRename: (label: string | null) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onError: (message: string) => void;
}): JSX.Element {
  const { device, theme } = props;
  const name = device.label || device.id;
  const inputId = useId();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(device.label ?? "");
  const [busy, setBusy] = useState(false);
  const renameRef = useRef<HTMLButtonElement>(null);
  const refocusRename = useRef(false);

  // Closing the rename field puts focus back on the Rename button that opened it (WCAG 2.4.3).
  useEffect(() => {
    if (renaming || !refocusRename.current) return;
    refocusRename.current = false;
    renameRef.current?.focus();
  }, [renaming]);

  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      props.onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    refocusRename.current = true;
    setRenaming(false);
  };

  return (
    <>
      <div style={rowMain}>
        <div style={rowInfo}>
          <div style={rowName}>
            <span style={{ ...typeStep("sm"), fontWeight: 700, minWidth: 0 }}>
              {name}
            </span>
            {device.current ? (
              <span style={badgeStyle} data-polaris-device-current="">
                {theme.copy.deviceCurrentBadge}
              </span>
            ) : null}
          </div>
          <span style={mutedText}>
            {[device.platform, device.arch, device.appVersion]
              .filter(Boolean)
              .join(" · ") || device.status}
          </span>
        </div>
        <div style={rowActions}>
          {props.readOnly || renaming ? null : (
            <Button
              ref={renameRef}
              variant="secondary"
              style={compactStyle}
              label={`${theme.copy.deviceRenameActionLabel} ${name}`}
              disabled={busy}
              onClick={() => {
                setLabel(device.label ?? "");
                setRenaming(true);
              }}
              data-polaris-device-rename={device.id}
            >
              {theme.copy.deviceRenameActionLabel}
            </Button>
          )}
          <Button
            variant="ghost"
            busy={busy}
            disabled={busy}
            style={{ ...compactStyle, color: "var(--pk-danger)" }}
            label={`${theme.copy.deviceDisconnectLabel} ${name}`}
            onClick={() => void run(props.onDisconnect)}
            data-polaris-device-disconnect={device.id}
          >
            {theme.copy.deviceDisconnectLabel}
          </Button>
        </div>
      </div>
      {renaming && !props.readOnly ? (
        // Opened on request only, inline under the row it renames. Escape closes it.
        <form
          style={{
            display: "flex",
            flexDirection: "column",
            gap: SPACE["2"],
          }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => props.onRename(label.trim() || null)).then((ok) => {
              if (ok) close();
            });
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            close();
          }}
          data-polaris-device-rename-form={device.id}
        >
          <TextField
            id={inputId}
            label={theme.copy.deviceRenameLabel}
            value={label}
            onChange={setLabel}
            disabled={busy}
            autoFocus
            data-polaris-device-input={device.id}
          />
          <div style={rowActions}>
            <Button
              variant="primary"
              type="submit"
              busy={busy}
              disabled={busy}
              style={compactStyle}
            >
              {theme.copy.deviceRenameSubmitLabel}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              style={compactStyle}
              onClick={close}
            >
              {theme.copy.deviceRenameCancelLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
