import * as React from "react";
import { Lock, PencilLine, RotateCcw } from "lucide-react";
import { Button } from "../Button.js";
import { NumberInput } from "../NumberInput.js";
import { SegmentedControl } from "../SegmentedControl.js";
import { Select } from "../Select.js";
import { StatusPill } from "../StatusPill.js";
import { Switch } from "../Switch.js";
import {
  fieldUnit,
  formatSettingValue,
  fromField,
  toField,
  type SettingSpec,
} from "./model.js";
import {
  ConflictNote,
  SettingHistory,
  type SettingHistoryEntry,
} from "./SettingExtras.js";
import { SettingsRow } from "./SettingsRow.js";
import {
  useSettingWrite,
  type SettingWriteOptions,
} from "./useSettingWrite.js";

export interface SettingRowProps extends Omit<SettingWriteOptions, "commit"> {
  /** DOM id of the control. */
  id: string;
  help?: React.ReactNode;
  /** Who owns the value in force: a `SourceBadge` (or the lock pill). */
  source: React.ReactNode;
  /** Defaults to immediate for a switch or a short choice, an explicit Save otherwise. */
  commit?: SettingWriteOptions["commit"];
  /** The control is off (the store cannot be read, a save is in flight elsewhere). */
  disabled?: boolean;
  /**
   * The setting is locked or enforced: the control stays but is off, and this says why, as text
   * beside the value (never a tooltip). `lockedAction` is the way out (a link, Request access).
   */
  locked?: React.ReactNode;
  lockedAction?: React.ReactNode;
  /** Show the value as muted text instead of a control (not in effect yet). */
  display?: "control" | "text";
  /** Facts under the row: a hard off, an invalid stored value. */
  notes?: React.ReactNode;
  /** Under the control: the exact bytes in effect. */
  footnote?: React.ReactNode;
  /** One muted line under the help: who uses the setting. */
  meta?: React.ReactNode;
  /** The word after a number field, when the spec's unit has none ("per license"). */
  unitLabel?: string;
  /** The bounds sentence under a number field (default: "1 to 365 days."). */
  bounds?: React.ReactNode;
  /** The reloaded message's tail ("set by ada@x.io"). */
  reloadedBy?: string;
  /** Loads this setting's past changes; adds a History button. */
  history?: () => Promise<SettingHistoryEntry[]>;
  /** What the History drawer says about the setting before its changes (deploy var, default). */
  details?: React.ReactNode;
  /** The registry key, as a quiet chip on the title line. */
  chip?: string;
  /**
   * The member may read this row but not change it. The value shows as full-contrast text with a
   * lock glyph, the reason is its description, and Revert is gone. The page says why once.
   */
  readOnly?: string;
  align?: "end" | "stretch" | "block";
}

/**
 * One registry setting (ST-07): the value in force, who owns it, and one way to change it. The
 * same row serves product and platform settings.
 *
 * States, each visible as words and a shape (never colour alone): default; **Not saved · was X**
 * (a draft, neutral ink); locked (the reason as text); error (an alert under the control, the
 * input kept); conflict (named, with Reload); busy; loading is the caller's skeleton.
 *
 * Keyboard: Enter in a field saves, Escape discards; the confirm dialog traps and restores focus.
 */
export function SettingRow(props: SettingRowProps): React.ReactElement {
  const {
    id,
    help,
    source,
    disabled = false,
    locked,
    lockedAction,
    display = "control",
    notes,
    footnote,
    bounds,
    reloadedBy,
    history,
    details,
    chip,
    readOnly,
    align,
    spec,
    label,
    labels,
    value,
  } = props;
  const commit =
    props.commit ??
    (spec.kind === "switch" ||
    spec.kind === "boolean" ||
    (spec.kind === "enum" && spec.values.length <= 3)
      ? "immediate"
      : "explicit");
  const w = useSettingWrite({ ...props, commit });
  // The opener can be gone when a confirmation closes (a Save bar that unmounts on a clean row, a
  // conflict): focus then falls to <body>, so it returns to the field. The dialog's own return to
  // a surviving opener runs first and is left alone.
  const wasConfirming = React.useRef(false);
  React.useEffect(() => {
    if (wasConfirming.current && !w.confirming) {
      const t = window.setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body) document.getElementById(id)?.focus();
      }, 120);
      wasConfirming.current = false;
      return () => window.clearTimeout(t);
    }
    wasConfirming.current = w.confirming;
    return undefined;
  }, [w.confirming, id]);
  const fmt = (v: unknown) => formatSettingValue(spec, v, labels);
  const viewOnly = readOnly !== undefined;
  const off = disabled || locked !== undefined || viewOnly || w.busy;
  const errId = `${id}-error`;
  const hintId = `${id}-hint`;
  const unit = props.unitLabel ?? fieldUnit(spec);
  const state = w.conflict
    ? "conflict"
    : w.error
      ? "error"
      : locked !== undefined
        ? "locked"
        : w.dirty && commit === "explicit"
          ? "changed"
          : "default";

  const reasonId = `${id}-readonly`;
  const asText = viewOnly;
  let control: React.ReactNode;
  if (asText)
    control = (
      <span
        id={id}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-strong"
        aria-describedby={reasonId}
      >
        <Lock aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
        {fmt(value)}
      </span>
    );
  else if (display === "text")
    control = <span className="text-sm text-fg-muted">{fmt(value)}</span>;
  else if (spec.kind === "switch" || spec.kind === "boolean") {
    const on = spec.kind === "boolean" ? w.draft === true : w.draft === "on";
    control = (
      <Switch
        id={id}
        checked={on}
        // Busy is not disabled: a disabled control drops focus, and the write keeps it.
        disabled={disabled || locked !== undefined || viewOnly}
        aria-describedby={viewOnly ? reasonId : undefined}
        readOnly={w.busy}
        aria-busy={w.busy || undefined}
        onCheckedChange={(next) =>
          w.propose(spec.kind === "boolean" ? next : next ? "on" : "off")
        }
      />
    );
  } else if (spec.kind === "enum" && spec.values.length <= 3) {
    control = (
      <SegmentedControl
        id={id}
        size="sm"
        aria-label={label}
        options={spec.values.map((v) => ({
          value: v,
          label: labels?.[v] ?? v,
        }))}
        value={String(w.draft)}
        disabled={off}
        onChange={(v) => w.propose(v)}
      />
    );
  } else if (spec.kind === "enum") {
    control = (
      <Select
        id={id}
        value={String(w.draft)}
        disabled={off}
        onChange={(v) => v !== null && w.propose(v)}
        options={spec.values.map((v) => ({
          value: v,
          label: labels?.[v] ?? v,
        }))}
        className="min-w-56"
      />
    );
  } else if (spec.kind === "integer") {
    const min = toField(spec, spec.min);
    const max = toField(spec, spec.max);
    control = (
      <div
        className="w-48 text-left"
        onKeyDown={(e) => {
          if (e.key === "Enter" && w.dirty && !off) {
            e.preventDefault();
            w.commit();
          } else if (e.key === "Escape" && w.dirty) {
            e.stopPropagation();
            w.discard();
          }
        }}
      >
        <NumberInput
          id={id}
          aria-label={unit ? `${label} (${unit})` : label}
          aria-invalid={w.error && !w.conflict ? true : undefined}
          aria-describedby={[hintId, w.error ? errId : null]
            .filter(Boolean)
            .join(" ")}
          value={typeof w.draft === "number" ? toField(spec, w.draft) : null}
          onChange={(v) => w.setDraft(v === null ? null : fromField(spec, v))}
          unit={unit}
          min={min}
          max={max}
          step={spec.unit === "bytes" ? "any" : 1}
          integer={spec.unit !== "bytes"}
          disabled={off}
        />
        <p id={hintId} className="mt-1 text-xs text-fg-muted">
          {bounds ?? `${min} to ${max}${unit ? ` ${unit}` : ""}.`}
        </p>
      </div>
    );
  } else control = <code className="font-mono text-xs">{fmt(value)}</code>;

  const changed = w.dirty && commit === "explicit" && display === "control";
  const sourceSlot = (
    <>
      {source}
      {changed ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
          <StatusPill tone="neutral" icon={PencilLine}>
            Not saved
          </StatusPill>
          <span>was {fmt(value)}</span>
        </span>
      ) : null}
    </>
  );

  const canRevert = !viewOnly && props.revertPlan?.() != null;
  const draftText = changed && w.draft !== null ? fmt(w.draft) : undefined;

  const footer = (
    <>
      {props.meta ? (
        <p className="mt-2 text-xs text-fg-muted">{props.meta}</p>
      ) : null}
      {footnote ? (
        <p className="mt-2 text-xs text-fg-muted">{footnote}</p>
      ) : null}
      {locked !== undefined ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-fg-muted">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {locked} {lockedAction}
          </span>
        </p>
      ) : null}
      {changed ? (
        <div
          role="region"
          aria-label={`Unsaved changes in ${label}`}
          className="mt-3 flex flex-wrap items-center justify-end gap-2"
        >
          <Button
            size="sm"
            variant="ghost"
            onClick={w.discard}
            disabled={w.busy}
          >
            Discard
          </Button>
          {w.conflict === "refused" ? null : (
            <Button
              size="sm"
              loading={w.busy}
              disabled={locked !== undefined || disabled}
              onClick={() => w.commit()}
            >
              {w.asks ? "Save…" : "Save"}
            </Button>
          )}
        </div>
      ) : null}
      {w.error ? (
        <p
          id={errId}
          role="alert"
          className="mt-2 text-sm font-medium text-danger"
        >
          {w.error.title}
          {w.error.description ? (
            <span className="block font-normal text-fg-muted">
              {w.error.description}
            </span>
          ) : null}
        </p>
      ) : null}
      <ConflictNote
        state={w.conflict}
        reloading={w.reloading}
        onReload={() => void w.reload()}
        onDismiss={w.clearConflict}
        now={`${fmt(value)}${reloadedBy ? `, ${reloadedBy}` : ""}`}
        draft={draftText}
      />
      {notes ? <div className="mt-3 space-y-2">{notes}</div> : null}
      {w.dialog}
    </>
  );

  return (
    <SettingsRow
      label={label}
      help={help}
      htmlFor={display === "text" || asText ? undefined : id}
      source={sourceSlot}
      chip={chip}
      align={align}
      state={state}
      footer={footer}
    >
      {canRevert ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={w.revert}
          disabled={disabled || w.busy}
          aria-label={`Revert ${label.toLowerCase()}…`}
        >
          <RotateCcw aria-hidden />
          Revert…
        </Button>
      ) : null}
      {history ? (
        <SettingHistory label={label} load={history} details={details} />
      ) : null}
      {viewOnly ? (
        <span id={reasonId} className="sr-only">
          Read-only. {readOnly}
        </span>
      ) : null}
      {control}
    </SettingsRow>
  );
}

export type { SettingSpec };
