import * as React from "react";
import type { ConfigEntry, ManagementState } from "./api.js";
import {
  Badge,
  Checkbox,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/index.js";

/**
 * Schema-driven form fields. Given a catalog entry's JSON-Schema fragment it renders the
 * right primitive (boolean → checkbox, enum → select, number → number input, string → text /
 * password) and validates locally against the fragment. This is a deliberately small subset
 * of Draft-07 (type / enum / minimum / maximum / minLength / maxLength / pattern) — the same
 * fragments the worker's Ajv validates server-side, so a value valid here is valid there.
 *
 * `ManagedField` wraps a `SchemaField` with the v2 management-state controls (default /
 * enforced / hidden) and an `updatedAt` stamp, mirroring the managed-payload wire shape.
 */

export interface FieldResult {
  value: unknown;
  valid: boolean;
  error?: string;
}

function coerce(schema: Record<string, unknown>, raw: string): unknown {
  const type = schema.type;
  if (type === "integer" || type === "number") {
    if (raw.trim() === "") return undefined;
    return Number(raw);
  }
  if (type === "boolean") return raw === "true";
  return raw;
}

/** Local validation mirroring the Draft-07 subset the catalog uses. */
export function validate(
  schema: Record<string, unknown>,
  value: unknown,
): string | null {
  const type = schema.type as string | undefined;
  if (value === undefined || value === "") {
    return null; // empty ⇒ "no override"
  }
  if (type === "integer" || type === "number") {
    const n = Number(value);
    if (Number.isNaN(n)) return "must be a number";
    if (type === "integer" && !Number.isInteger(n)) return "must be an integer";
    if (typeof schema.minimum === "number" && n < schema.minimum)
      return `must be ≥ ${schema.minimum}`;
    if (typeof schema.maximum === "number" && n > schema.maximum)
      return `must be ≤ ${schema.maximum}`;
  }
  if (type === "string") {
    const s = String(value);
    if (typeof schema.minLength === "number" && s.length < schema.minLength)
      return `min length ${schema.minLength}`;
    if (typeof schema.maxLength === "number" && s.length > schema.maxLength)
      return `max length ${schema.maxLength}`;
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(s)
    )
      return "does not match pattern";
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return "not an allowed value";
  return null;
}

const KIND_VARIANT: Record<string, "primary" | "warning" | "default"> = {
  config: "default",
  secret: "warning",
  flag: "primary",
};

export function SchemaField({
  entry,
  value,
  onChange,
  disabled,
}: {
  entry: ConfigEntry;
  value: unknown;
  onChange: (result: FieldResult) => void;
  disabled?: boolean;
}): React.ReactElement {
  const schema = entry.schema;
  const error = React.useMemo(() => validate(schema, value), [schema, value]);
  const emit = (raw: string): void => {
    const v = coerce(schema, raw);
    const e = validate(schema, v);
    onChange({ value: v, valid: e === null, error: e ?? undefined });
  };

  let control: React.ReactElement;
  if (schema.type === "boolean") {
    control = (
      <Checkbox
        aria-label={entry.label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) =>
          onChange({ value: checked === true, valid: true })
        }
      />
    );
  } else if (Array.isArray(schema.enum)) {
    control = (
      <Select
        value={value == null ? "" : String(value)}
        disabled={disabled}
        onValueChange={(v) => emit(v)}
      >
        <SelectTrigger aria-label={entry.label}>
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {(schema.enum as unknown[]).map((opt) => (
            <SelectItem key={String(opt)} value={String(opt)}>
              {String(opt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (schema.type === "integer" || schema.type === "number") {
    control = (
      <Input
        type="number"
        aria-label={entry.label}
        disabled={disabled}
        value={value === undefined || value === null ? "" : String(value)}
        min={typeof schema.minimum === "number" ? schema.minimum : undefined}
        max={typeof schema.maximum === "number" ? schema.maximum : undefined}
        onChange={(ev) => emit(ev.target.value)}
      />
    );
  } else {
    control = (
      <Input
        type={entry.secret || entry.kind === "secret" ? "password" : "text"}
        aria-label={entry.label}
        disabled={disabled}
        value={value == null ? "" : String(value)}
        placeholder={entry.ui?.placeholder}
        onChange={(ev) => emit(ev.target.value)}
      />
    );
  }

  return (
    <Field
      label={entry.label}
      help={entry.description || undefined}
      error={error ?? undefined}
      labelAside={
        <Badge variant={KIND_VARIANT[entry.kind] ?? "default"}>
          {entry.kind}
        </Badge>
      }
    >
      {control}
    </Field>
  );
}

const STATES: { value: ManagementState; label: string }[] = [
  { value: "default", label: "Default (overridable)" },
  { value: "enforced", label: "Enforced (locked)" },
  { value: "hidden", label: "Hidden (enforced + withheld)" },
];

const STATE_VARIANT: Record<
  ManagementState,
  "default" | "primary" | "warning"
> = {
  default: "default",
  enforced: "primary",
  hidden: "warning",
};

function formatStamp(updatedAt?: number): string | null {
  if (!updatedAt) return null;
  try {
    return new Date(updatedAt * 1000).toLocaleString();
  } catch {
    return null;
  }
}

/**
 * A managed-payload field: a `SchemaField` value editor plus the v2 management-state selector
 * and an `updatedAt` stamp. When the state is `enforced`/`hidden` the value still edits (the
 * server enforces it on clients), but the badge communicates the lock. Drives one entry of a
 * license-override or profile-payload batch.
 */
export function ManagedField({
  entry,
  value,
  state,
  updatedAt,
  onValueChange,
  onStateChange,
}: {
  entry: ConfigEntry;
  value: unknown;
  state: ManagementState;
  updatedAt?: number;
  onValueChange: (result: FieldResult) => void;
  onStateChange: (state: ManagementState) => void;
}): React.ReactElement {
  const stamp = formatStamp(updatedAt);
  return (
    <div className="space-y-2 rounded-md border border-border bg-card/40 p-3">
      <SchemaField entry={entry} value={value} onChange={onValueChange} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Field label="Management state" className="min-w-48 flex-1">
          <Select
            value={state}
            onValueChange={(v) => onStateChange(v as ManagementState)}
          >
            <SelectTrigger aria-label={`Management state for ${entry.label}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex flex-col items-end gap-1 self-end pb-1">
          <Badge variant={STATE_VARIANT[state]}>{state}</Badge>
          {stamp ? (
            <span className="text-xs text-muted-foreground">
              Updated {stamp}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
