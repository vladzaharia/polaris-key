import * as React from "react";
import { X } from "lucide-react";
import type { Catalog } from "@polaris-key/catalog";
import type { ConfigEntry, ManagementState } from "../api.js";
import { cn } from "../lib/cn.js";
import { fromSeconds } from "../lib/format.js";
import { KIND_LABELS, MANAGEMENT_LABELS } from "../lib/labels.js";
import { Button } from "../ui/Button.js";
import { IconButton } from "../ui/IconButton.js";
import { StatusPill } from "../ui/StatusPill.js";
import { Timestamp } from "../ui/Timestamp.js";
import {
  KIND_TONE,
  STATE_TONE,
  entryDefault,
  formatValue,
  isSecretEntry,
  type FieldResult,
  type InheritedValue,
} from "./entry.js";
import { ManagementStateControl } from "./ManagementStateControl.js";
import { SchemaField } from "./SchemaField.js";

/**
 * One managed key, end to end (docs/design/ADMIN.md §6.6.3): the catalog label and dotted key,
 * the type-correct editor, the management state, provenance, and the set/unset affordance.
 *
 * SET-VS-UNSET IS THE POINT. `applyOverrides` deletes a key whose update carries no value and
 * state `default`; anything else writes one. So "unset" is a real, representable state, not an
 * empty string: an absent key reads "Not set" with the fallback ghosted, "Set value" materialises
 * an editor, and Remove takes it back to absent. Writing `""` to mean "unset" would store a blank
 * string the SDKs would faithfully hand to the app.
 *
 * Both consumers (profile payloads and license overrides) render this component; the only thing
 * overrides add is the `inherited` line.
 */
export interface ManagedFieldProps {
  entry: ConfigEntry;
  value: unknown;
  state: ManagementState;
  /** Epoch seconds, from the API. */
  updatedAt?: number;
  onValueChange: (result: FieldResult) => void;
  onStateChange: (state: ManagementState) => void;
  /** Omit for an always-editable row; pass it to get the set/unset affordance. */
  set?: boolean;
  onSetChange?: (set: boolean) => void;
  catalog?: Catalog | null;
  /** An error the row's owner computed (a JSON parse failure, a 422): outranks the local check. */
  error?: string;
  dirty?: boolean;
  /** A secret with a stored value on the server. Its value is never sent, so never rendered. */
  secretConfigured?: boolean;
  inherited?: InheritedValue | null;
  disabled?: boolean;
  /** The row's element id (jump-to-error scrolls to it and focuses its first control). */
  domId?: string;
}

export function ManagedField({
  entry,
  value,
  state,
  updatedAt,
  onValueChange,
  onStateChange,
  set,
  onSetChange,
  catalog,
  error,
  dirty,
  secretConfigured,
  inherited,
  disabled,
  domId,
}: ManagedFieldProps): React.ReactElement {
  const secret = isSecretEntry(entry);
  const managed = set !== false;
  const kind = (
    <StatusPill tone={KIND_TONE[entry.kind]} icon={null} size="sm">
      {KIND_LABELS[entry.kind] ?? entry.kind}
    </StatusPill>
  );
  const header = (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-bold text-fg-strong">{entry.label}</span>
      <code className="font-mono text-xs font-normal text-fg-muted">
        {entry.key}
      </code>
      {dirty ? (
        <span className="inline-flex items-center self-center">
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          <span className="sr-only">(changed)</span>
        </span>
      ) : null}
    </span>
  );
  const fallback = entryDefault(entry);

  if (!managed) {
    return (
      <div
        id={domId}
        data-row={entry.key}
        className="rounded-md border border-dashed border-border bg-surface-page p-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p>{header}</p>
            {entry.description ? (
              <p className="text-xs text-fg-muted">{entry.description}</p>
            ) : null}
            <p className="text-xs text-fg-muted">
              <span className="font-bold text-fg">Not set</span>
              {inherited ? (
                <>
                  {" "}
                  · inherits {formatValue(inherited.value)} from{" "}
                  {inherited.source}.
                </>
              ) : fallback !== undefined ? (
                <> · clients fall back to {formatValue(fallback)}.</>
              ) : (
                <> · this key contributes nothing.</>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {kind}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              aria-label={`Set a value for ${entry.label}`}
              onClick={() => onSetChange?.(true)}
            >
              Set value
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const aside = (
    <span className="flex shrink-0 flex-wrap items-center gap-1.5">
      {kind}
      <StatusPill tone={STATE_TONE[state]} icon={null} size="sm">
        {MANAGEMENT_LABELS[state] ?? state}
      </StatusPill>
      {secret ? (
        <StatusPill
          domain="secret"
          state={secretConfigured ? "configured" : "missing"}
          size="sm"
        />
      ) : null}
      {onSetChange ? (
        <IconButton
          label={`Remove ${entry.label} from the payload`}
          size="sm"
          variant="ghost"
          disabled={disabled}
          icon={<X aria-hidden />}
          onClick={() => onSetChange(false)}
        />
      ) : null}
    </span>
  );

  return (
    <div
      id={domId}
      data-row={entry.key}
      className={cn(
        "space-y-3 rounded-md border bg-surface-raised p-3 transition-colors",
        dirty ? "border-accent" : "border-border",
        error ? "border-danger" : null,
      )}
    >
      <SchemaField
        entry={entry}
        value={value}
        disabled={disabled}
        catalog={catalog}
        onChange={onValueChange}
        label={header}
        labelAside={aside}
        error={error}
        secretConfigured={secret ? secretConfigured : undefined}
        help={
          secret
            ? "Write-only: the server never returns a stored secret."
            : entry.description || undefined
        }
      />

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-border pt-2.5">
        <ManagementStateControl
          value={state}
          disabled={disabled}
          label={`Management state for ${entry.label}`}
          onChange={onStateChange}
        />
        <div className="flex flex-col items-end gap-0.5 text-xs text-fg-muted">
          {inherited ? (
            <span>
              Overrides {formatValue(inherited.value)} from {inherited.source}
            </span>
          ) : null}
          {updatedAt ? (
            <span>
              Updated <Timestamp at={fromSeconds(updatedAt)} />
            </span>
          ) : null}
        </div>
      </div>

      {/* `applyOverrides` deletes a key whose update carries no value and state `default`. For a
          secret the console has no value to resend, so choosing Default really does clear it:
          say so rather than letting the stored secret vanish on save. */}
      {secret && secretConfigured && state === "default" && !value ? (
        <p className="text-xs font-bold text-warning">
          Saving with Default removes the stored secret: the server keeps no
          value for an unmanaged key.
        </p>
      ) : null}
    </div>
  );
}
