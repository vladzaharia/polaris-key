import * as React from "react";
import type { Catalog } from "@polaris-key/catalog";
import type { ConfigEntry } from "../api.js";
import { KIND_LABELS } from "../lib/labels.js";
import { Button } from "../ui/Button.js";
import { formatJson } from "../ui/CodeEditor.js";
import { FormField } from "../ui/form.js";
import { Input } from "../ui/Input.js";
import { SecretInput } from "../ui/SecretInput.js";
import { Select } from "../ui/Select.js";
import { StatusPill } from "../ui/StatusPill.js";
import { Switch } from "../ui/Switch.js";
import { Textarea } from "../ui/Textarea.js";
import {
  KIND_TONE,
  validateEntry,
  widgetFor,
  type FieldResult,
} from "./entry.js";

/**
 * The type-correct editor for one catalog entry (docs/design/ADMIN.md §6.6). The JSON-Schema
 * picks the control: boolean → switch, enum → select, integer/number → number input,
 * array/object → a JSON editor, string → text, textarea or a write-only secret input. Every
 * change is validated by the catalog's own interpreter and reported as a `FieldResult`.
 *
 * The control sits inside the form layer's `FormField`, which hands it the id, the
 * `aria-describedby` for help and error, and `aria-invalid` through a render prop. So the visible
 * label (with its unit) names the control, a select's trigger is labelled like any input
 * (SCF-1), no control overrides its label with `aria-label` (SCF-2), and the error is announced.
 */

/** An empty number box is "not set"; anything else that will not parse goes on as text so the
 *  catalog reports a type error the operator can read (never a `NaN` that serialises to null). */
function coerceNumber(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

function numberStep(schema: Record<string, unknown>): number | "any" {
  if (typeof schema.multipleOf === "number") return schema.multipleOf;
  return schema.type === "integer" ? 1 : "any";
}

export interface SchemaFieldProps {
  entry: ConfigEntry;
  value: unknown;
  onChange: (result: FieldResult) => void;
  disabled?: boolean;
  /** Share one `Catalog` across a whole editor so each fragment is analysed once. */
  catalog?: Catalog | null;
  label?: React.ReactNode;
  labelAside?: React.ReactNode;
  help?: React.ReactNode;
  /** An error the owner computed (a 422, a JSON parse failure): outranks the local check. */
  error?: string;
  /** A write-only entry with a stored value: the secret input asks before replacing it. */
  secretConfigured?: boolean;
  className?: string;
}

export function SchemaField({
  entry,
  value,
  onChange,
  disabled,
  catalog,
  label,
  labelAside,
  help,
  error: externalError,
  secretConfigured,
  className,
}: SchemaFieldProps): React.ReactElement {
  const schema = entry.schema;
  const localError = React.useMemo(
    () => validateEntry(entry, value, catalog),
    [entry, value, catalog],
  );
  const error = externalError ?? localError ?? undefined;

  const emit = (v: unknown): void => {
    const e = validateEntry(entry, v, catalog);
    onChange({ value: v, valid: e === null, error: e ?? undefined });
  };

  const widget = widgetFor(entry);
  const unit = entry.ui?.unit;
  const labelNode = (
    <span className="inline-flex flex-wrap items-baseline gap-1.5">
      {label ?? entry.label}
      {unit ? (
        <span className="text-xs font-normal text-fg-muted"> ({unit})</span>
      ) : null}
    </span>
  );

  return (
    <FormField
      name={entry.key || "value"}
      label={labelNode}
      help={help ?? (entry.description || undefined)}
      error={error}
      announceError
      disabled={disabled}
      className={className}
      labelAside={
        labelAside === undefined ? (
          <StatusPill tone={KIND_TONE[entry.kind]} icon={null} size="sm">
            {KIND_LABELS[entry.kind] ?? entry.kind}
          </StatusPill>
        ) : (
          labelAside
        )
      }
      value={value}
    >
      {(field) => {
        const aria = {
          id: field.id,
          disabled,
          "aria-describedby": field["aria-describedby"],
          "aria-invalid": field["aria-invalid"],
        };
        if (widget === "switch") {
          return (
            <Switch
              {...aria}
              // Toggles sit at the row's right edge, under the pills.
              className="self-end"
              checked={value === true}
              // A switch validates too (SCF-3): a schema can pin a boolean with `const`/`enum`.
              onCheckedChange={(checked) => emit(checked === true)}
            />
          );
        }
        if (widget === "select") {
          const options = (schema.enum as unknown[] | undefined) ?? [];
          const labels = entry.ui?.optionLabels ?? {};
          return (
            <Select
              {...aria}
              // A short pick needs a short control, not the full row.
              className="w-full sm:max-w-xs"
              value={value == null ? "" : String(value)}
              placeholder="Choose…"
              options={options.map((o) => ({
                value: String(o),
                label: labels[String(o)] ?? String(o),
              }))}
              // Round-trip through the declared enum so a numeric or boolean option keeps its
              // type; the select can only carry strings.
              onChange={(raw) =>
                emit(options.find((o) => String(o) === raw) ?? raw)
              }
            />
          );
        }
        if (widget === "number") {
          return (
            <Input
              {...aria}
              className="w-full sm:max-w-[12rem]"
              type="number"
              inputMode={schema.type === "integer" ? "numeric" : "decimal"}
              value={value === undefined || value === null ? "" : String(value)}
              min={
                typeof schema.minimum === "number" ? schema.minimum : undefined
              }
              max={
                typeof schema.maximum === "number" ? schema.maximum : undefined
              }
              step={numberStep(schema)}
              placeholder={entry.ui?.placeholder}
              onChange={(ev) => emit(coerceNumber(ev.target.value))}
            />
          );
        }
        if (widget === "json") {
          return (
            <JsonControl
              {...aria}
              entry={entry}
              value={value}
              catalog={catalog}
              onChange={onChange}
            />
          );
        }
        if (widget === "textarea") {
          return (
            <Textarea
              {...aria}
              rows={4}
              value={value == null ? "" : String(value)}
              placeholder={entry.ui?.placeholder}
              onChange={(ev) => emit(ev.target.value)}
            />
          );
        }
        if (widget === "password") {
          // Write-only (SCF-4): reveal shows only what is being typed; a stored value is never
          // returned, so replacing it is an explicit choice.
          return (
            <SecretInput
              {...aria}
              value={value == null ? "" : String(value)}
              configured={secretConfigured}
              placeholder={entry.ui?.placeholder}
              onChange={(v) => emit(v)}
            />
          );
        }
        return (
          <Input
            {...aria}
            type="text"
            value={value == null ? "" : String(value)}
            placeholder={entry.ui?.placeholder}
            onChange={(ev) => emit(ev.target.value)}
          />
        );
      }}
    </FormField>
  );
}

/**
 * The array/object editor: monospace, with Format (SCF-4).
 *
 * The *text* is local state, because the value and the text are not the same thing: a half-typed
 * `[1,` has no value, and pretty-printing every keystroke would fight the operator's cursor. A
 * parse failure reports `valid: false` while leaving the stored value as it was, so a typo never
 * blanks a key. The box follows the value when it changes for an outside reason (a reload,
 * Discard) and never follows its own echo: `JSON.parse` returns a fresh object each time, so
 * identity against the last emitted value tells the two apart.
 */
function JsonControl({
  entry,
  value,
  catalog,
  onChange,
  id,
  disabled,
  ...aria
}: {
  entry: ConfigEntry;
  value: unknown;
  catalog?: Catalog | null;
  onChange: (result: FieldResult) => void;
  id: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}): React.ReactElement {
  const serialised = React.useMemo(() => {
    if (value === undefined) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }, [value]);
  const [text, setText] = React.useState(serialised);
  const emitted = React.useRef<unknown>(value);
  React.useEffect(() => {
    if (Object.is(value, emitted.current)) return; // our own echo
    emitted.current = value;
    setText(serialised);
  }, [value, serialised]);

  const publish = (result: FieldResult): void => {
    emitted.current = result.value;
    onChange(result);
  };

  const change = (next: string): void => {
    setText(next);
    if (next.trim() === "") {
      publish({ value: undefined, valid: true });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch (err) {
      publish({
        value,
        valid: false,
        error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const e = validateEntry(entry, parsed, catalog);
    publish({ value: parsed, valid: e === null, error: e ?? undefined });
  };

  const pretty = formatJson(text);
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        {...aria}
        id={id}
        disabled={disabled}
        mono
        rows={5}
        spellCheck={false}
        value={text}
        placeholder={
          entry.ui?.placeholder ?? (entry.schema.type === "array" ? "[]" : "{}")
        }
        onChange={(ev) => change(ev.target.value)}
      />
      <span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          disabledReason={
            pretty === null && text.trim() !== ""
              ? "Fix the JSON before formatting it."
              : undefined
          }
          onClick={() => {
            if (pretty !== null) change(pretty.trimEnd());
          }}
        >
          Format
        </Button>
      </span>
    </div>
  );
}
