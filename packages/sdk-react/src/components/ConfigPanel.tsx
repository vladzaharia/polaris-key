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
// An override is saved through the adapter's device-local store (`config.set`, `config.local`):
// `localStorage` in a browser, the host's state directory over bridge v4 on desktop. A refusal
// (`bad_request` for a value the catalog rejects) is shown under the input from the copy
// catalog. A host that keeps overrides itself passes `onOverride`, which takes over the save.
//
// Slots follow the `LicenseGate` pattern: every region is replaceable while the data layer and
// the a11y contract stay. Every state renders inside the panel, in the host's page (the
// disabled one too); the panel measures itself, and from 32rem of width an editable row is one
// line: the key and its state at the start, the value and Override at the end.

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { ConfigSource } from "@polaris-key/client-core";
import { useManagedConfig, usePolarisTheme } from "../react/hooks.js";
import { Button } from "./primitives/buttons.js";
import { FONT, SPACE } from "@polaris-key/brand";
import {
  Panel,
  chipStyle,
  dangerText,
  mutedText,
  titleText,
  typeStep,
} from "./primitives/card.js";
import { TextField } from "./primitives/input.js";
import { useRemSize } from "./primitives/layout.js";
import { describeError } from "../core/copy.js";
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
  /** Called when the user commits an override for an overridable key, INSTEAD of the panel's
   *  own `config.set` (a host that owns its overrides, as `localOverrides`). Without it the
   *  panel saves through the adapter's device-local store when `supports("config.local")`. */
  onOverride?: (key: string, value: string) => void;
  /** Hide the override affordance entirely (read-only settings display). */
  readOnly?: boolean;
  /** No border, background, radius or inline padding, for a host that frames the panel itself
   *  (the title and the row dividers stay). */
  bare?: boolean;
}

/** From this width (rem) an editable row is one line. */
const ONE_LINE_FROM_REM = 32;

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

const badgeStyle = { ...chipStyle, display: "inline-block" } as const;

const rowStyle = (last: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: SPACE["2"],
  paddingBlock: SPACE["3"],
  borderBottom: last ? "none" : "1px solid var(--pk-border)",
});

/** The key and its state chip. */
const keyLine: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: SPACE["2"],
  alignItems: "center",
  minWidth: 0,
};

export function ConfigPanel(props: ConfigPanelProps): JSX.Element {
  const theme = usePolarisTheme();
  const cfg = useManagedConfig();
  const titleId = useId();
  const slots = props.slots ?? {};
  // The rows' own width: a panel in a narrow sidebar stacks its rows like one on a phone.
  const [measure, size] = useRemSize<HTMLDivElement>();
  const oneLine = size.width >= ONE_LINE_FROM_REM;

  const header = (title: string, lede: string): ReactNode => (
    <div>
      <h2 id={titleId} style={titleText}>
        {title}
      </h2>
      <p style={mutedText}>{lede}</p>
    </div>
  );

  if (!cfg.enabled) {
    return slots.disabled ? (
      <>{slots.disabled()}</>
    ) : (
      // In the host's page like every other state: the panel explains itself in place.
      <Panel
        className={props.className}
        bare={props.bare}
        data-polaris-config="disabled"
        aria-labelledby={titleId}
      >
        {header(theme.copy.configDisabledTitle, theme.copy.configDisabledBody)}
      </Panel>
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
      bare={props.bare}
      data-polaris-config="panel"
      aria-labelledby={titleId}
    >
      {header(theme.copy.configTitle, theme.copy.configSubtitle)}
      <div ref={measure}>
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
            {rows.map((row, index) => (
              <li
                key={row.key}
                style={rowStyle(index === rows.length - 1)}
                data-polaris-config-row={row.key}
              >
                {slots.row ? (
                  slots.row(row)
                ) : (
                  <ConfigEntryRow
                    row={row}
                    theme={theme}
                    oneLine={oneLine}
                    readOnly={props.readOnly}
                    onOverride={props.onOverride}
                    canSet={cfg.canSet}
                    set={cfg.set}
                    clear={cfg.clear}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function ConfigEntryRow(props: {
  row: ConfigRow;
  theme: PolarisTheme;
  /** The panel is wide enough for the row on one line. */
  oneLine: boolean;
  readOnly?: boolean;
  onOverride?: (key: string, value: string) => void;
  canSet: boolean;
  set: (key: string, value: JSONValue) => Promise<void>;
  clear: (key: string) => Promise<void>;
}): JSX.Element {
  const { row, theme, oneLine } = props;
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(() => stringify(row.value));
  const [error, setError] = useState<string | null>(null);
  const ownSave = !props.onOverride && props.canSet;
  const showOverride =
    !props.readOnly &&
    row.overridable &&
    (Boolean(props.onOverride) || ownSave);
  const fail = (e: unknown) =>
    setError(
      describeError(
        e && typeof e === "object"
          ? (e as Parameters<typeof describeError>[0])
          : null,
      ),
    );

  const key = (
    <div style={keyLine}>
      <span
        style={{
          ...typeStep("sm"),
          fontWeight: 600,
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {row.key}
      </span>
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
  );

  // One line from 32rem: the key at the start, the value at the end; stacked below that.
  const line: CSSProperties = oneLine
    ? {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: `${SPACE["2"]} ${SPACE["4"]}`,
      }
    : { display: "flex", flexDirection: "column", gap: SPACE["2"] };

  if (!showOverride)
    return (
      <div style={line}>
        {key}
        <span
          style={{
            ...mutedText,
            fontFamily: FONT.mono,
            overflowWrap: "anywhere",
          }}
          data-polaris-config-value={row.key}
        >
          {stringify(row.value)}
        </span>
      </div>
    );

  // The field is fitted to its value on one line (at most 16rem), full width when stacked.
  const fitted = `min(16rem, calc(${Math.max(draft.length, 4)}ch + ${SPACE["6"]} + 2px))`;
  return (
    <form
      style={line}
      onSubmit={(e) => {
        e.preventDefault();
        if (props.onOverride) {
          props.onOverride(row.key, draft);
          return;
        }
        setError(null);
        props.set(row.key, parseDraft(draft, row.value)).catch(fail);
      }}
    >
      {key}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: SPACE["2"],
          ...(oneLine ? { justifyContent: "flex-end" } : null),
        }}
      >
        {/* The key names the field; no visible "{key} Override" label repeats it. */}
        <TextField
          id={inputId}
          label={row.key}
          hideLabel
          value={draft}
          onChange={(v) => {
            setDraft(v);
            setError(null);
          }}
          style={oneLine ? { width: fitted } : undefined}
          data-polaris-config-input={row.key}
          invalid={Boolean(error)}
          errorId={error ? errorId : undefined}
        />
        <Button variant="secondary" type="submit" size="compact">
          {theme.copy.configOverrideLabel}
        </Button>
        {ownSave && row.source === "local" ? (
          <Button
            variant="secondary"
            type="button"
            size="compact"
            data-polaris-config-reset={row.key}
            onClick={() => {
              setError(null);
              props
                .clear(row.key)
                .then(() => setDraft(stringify(row.value)))
                .catch(fail);
            }}
          >
            {theme.copy.configResetLabel}
          </Button>
        ) : null}
      </div>
      {error ? (
        <span
          id={errorId}
          role="alert"
          style={{ ...dangerText, flexBasis: "100%" }}
          data-polaris-config-error={row.key}
        >
          {error}
        </span>
      ) : null}
    </form>
  );
}

function stringify(value: JSONValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The typed value for what the user typed: text for a string setting, otherwise JSON when it
 *  parses (`8`, `true`, `["a"]`), else the text itself, which the catalog check then refuses
 *  when the key wants another type. */
function parseDraft(draft: string, current: JSONValue): JSONValue {
  if (typeof current === "string") return draft;
  try {
    return JSON.parse(draft) as JSONValue;
  } catch {
    return draft;
  }
}
