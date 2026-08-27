// `<ConfigPanel>` — the settings panel over the config service's ALREADY-SHIPPED data layer.
//
// It adds no fetching and no precedence logic of its own: `listUserConfig()` and
// `getConfigSource()` have been on the adapter since the v2 config work, and every product that
// wanted a settings screen has been reimplementing the same table on top of them. This renders
// that table once, with the two things a hand-rolled copy usually gets wrong:
//
//   * a per-entry PROVENANCE badge, so a user can tell "your administrator set this" from
//     "this is the shipped default" — a locked row with no explanation reads as a bug;
//   * an override affordance offered ONLY on `default`/`fallback`-state keys, because
//     `enforced` and `hidden` are locked to the server and an input that silently discards
//     what you typed is worse than no input.
//
// Slots follow the `LicenseGate` pattern: every region is replaceable while the data layer and
// the a11y contract stay.

import { useId, useState, type ReactNode } from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { ConfigSource } from "@polaris-key/client-core";
import { useManagedConfig, usePolarisTheme } from "../react/hooks.js";
import { Button } from "./primitives/buttons.js";
import { Panel, mutedText } from "./primitives/card.js";
import { MessageScreen } from "./primitives/MessageScreen.js";
import { TextField } from "./primitives/input.js";
import type { PolarisTheme } from "./theme.js";

/** One row as the panel renders it: the effective value plus where it came from. */
export interface ConfigRow {
  key: string;
  value: JSONValue;
  enforced: boolean;
  source: ConfigSource;
  /** True when a local override may be set for this key (`default`/`fallback` state). */
  overridable: boolean;
}

export interface ConfigPanelSlots {
  /** Replace the whole row list. */
  rows?: (rows: ConfigRow[]) => ReactNode;
  /** Replace one row. */
  row?: (row: ConfigRow) => ReactNode;
  /** Replace the "nothing delivered" state. */
  empty?: () => ReactNode;
  /** Replace the "config service disabled" state. */
  disabled?: () => ReactNode;
}

export interface ConfigPanelProps {
  slots?: ConfigPanelSlots;
  className?: string;
  /** Called when the user commits an override for an overridable key. The panel does NOT
   *  persist overrides itself: they are the host's `localOverrides`, which the host owns
   *  (a renderer writing to disk is exactly what the desktop bridge exists to prevent). */
  onOverride?: (key: string, value: string) => void;
  /** Hide the override affordance entirely (read-only settings display). */
  readOnly?: boolean;
}

function badgeFor(theme: PolarisTheme, source: ConfigSource): string {
  switch (source) {
    case "enforced":
    case "hidden":
      return theme.copy.configEnforcedBadge;
    case "local":
    case "env":
      return theme.copy.configLocalBadge;
    default:
      return theme.copy.configRemoteBadge;
  }
}

const badgeStyle = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid var(--pk-border)",
  color: "var(--pk-text-muted)",
  fontSize: "11px",
  letterSpacing: "0.02em",
} as const;

const rowStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "6px",
  padding: "12px 0",
  borderBottom: "1px solid var(--pk-border)",
};

export function ConfigPanel(props: ConfigPanelProps): JSX.Element {
  const theme = usePolarisTheme();
  const cfg = useManagedConfig();
  const titleId = useId();
  const slots = props.slots ?? {};

  if (!cfg.enabled) {
    return slots.disabled ? (
      <>{slots.disabled()}</>
    ) : (
      <MessageScreen
        title={theme.copy.configDisabledTitle}
        body={theme.copy.configDisabledBody}
        data-polaris-config="disabled"
      />
    );
  }

  const rows: ConfigRow[] = cfg.listUserConfig().map((entry) => {
    const source = cfg.getConfigSource(entry.key);
    return {
      ...entry,
      source,
      overridable: !entry.enforced && source !== "hidden",
    };
  });
  rows.sort((a, b) => a.key.localeCompare(b.key));

  return (
    <Panel
      className={props.className}
      data-polaris-config="panel"
      aria-labelledby={titleId}
    >
      <div>
        <h2 id={titleId} style={{ margin: "0 0 4px", fontSize: "20px" }}>
          {theme.copy.configTitle}
        </h2>
        <p style={mutedText}>{theme.copy.configSubtitle}</p>
      </div>
      {rows.length === 0 ? (
        slots.empty ? (
          <>{slots.empty()}</>
        ) : (
          <p style={mutedText} role="status" data-polaris-config="empty">
            {theme.copy.configEmpty}
          </p>
        )
      ) : slots.rows ? (
        <>{slots.rows(rows)}</>
      ) : (
        <ul
          style={{ listStyle: "none", margin: 0, padding: 0 }}
          data-polaris-config="rows"
        >
          {rows.map((row) => (
            <li
              key={row.key}
              style={rowStyle}
              data-polaris-config-row={row.key}
            >
              {slots.row ? (
                slots.row(row)
              ) : (
                <ConfigEntryRow
                  row={row}
                  theme={theme}
                  readOnly={props.readOnly}
                  onOverride={props.onOverride}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ConfigEntryRow(props: {
  row: ConfigRow;
  theme: PolarisTheme;
  readOnly?: boolean;
  onOverride?: (key: string, value: string) => void;
}): JSX.Element {
  const { row, theme } = props;
  const inputId = useId();
  const [draft, setDraft] = useState(() => stringify(row.value));
  const showOverride =
    !props.readOnly && row.overridable && Boolean(props.onOverride);

  return (
    <>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <span style={{ fontSize: "14px", fontWeight: 600 }}>{row.key}</span>
        <span
          style={badgeStyle}
          data-polaris-config-source={row.source}
          // The badge is the row's explanation, so it is announced with the row rather than
          // left as decorative styling.
          aria-label={`${row.key}: ${badgeFor(theme, row.source)}`}
        >
          {badgeFor(theme, row.source)}
        </span>
      </div>
      {showOverride ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: "6px" }}
          onSubmit={(e) => {
            e.preventDefault();
            props.onOverride?.(row.key, draft);
          }}
        >
          <TextField
            id={inputId}
            label={`${row.key} ${theme.copy.configOverrideLabel}`}
            value={draft}
            onChange={setDraft}
            data-polaris-config-input={row.key}
          />
          <Button
            variant="secondary"
            type="submit"
            style={{ fontSize: "13px" }}
          >
            {theme.copy.configOverrideLabel}
          </Button>
        </form>
      ) : (
        <span
          style={{ ...mutedText, fontSize: "13px", fontFamily: "monospace" }}
          data-polaris-config-value={row.key}
        >
          {stringify(row.value)}
        </span>
      )}
    </>
  );
}

function stringify(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
