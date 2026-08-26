import * as React from "react";
import { compileLinearPattern, type LinearPattern } from "@plrs/catalog";
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
 * fragments the worker validates server-side, so a value valid here is valid there.
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

/**
 * Compiled `pattern` matchers, memoised by source.
 *
 * NOT `new RegExp(schema.pattern)`. A catalog `pattern` is operator-supplied: it arrives from
 * an admin publish, or — with no review step at all — from `.pkey/` in a linked GitHub repo,
 * applied by a webhook-triggered resync (`release/resync.ts`, VERIFY-R10-01 §5a). V8
 * backtracks, so the eight-character `(x+x+)+y` takes ~54 s on a 41-character input; measured
 * in this audit. The console has no worker thread and no timeout, so that is a frozen browser
 * tab for the operator, on a value they typed themselves.
 *
 * `@plrs/catalog` ships the Thompson/Pike NFA the worker already validates with
 * (`shared-catalog/src/regex.ts`: input, source, quantifier and instruction budgets, semantics
 * pinned by differential comparison against the host `RegExp`). Reusing it — rather than
 * adding a second, differently-shaped cap here — is what keeps the console's verdict AND its
 * cost model identical to the server's.
 */
const PATTERN_CACHE = new Map<string, LinearPattern | null>();
/** `validate` runs per keystroke and per render; bound the memo so a long session can't grow
 *  it without limit. Catalogs are small, so eviction is a formality. */
const PATTERN_CACHE_MAX = 256;

/** `null` ⇒ the matcher refused this pattern; fail closed, never fall back to `RegExp`. */
function matcherFor(source: string): LinearPattern | null {
  const hit = PATTERN_CACHE.get(source);
  if (hit !== undefined) return hit;
  let compiled: LinearPattern | null = null;
  try {
    compiled = compileLinearPattern(source);
  } catch {
    compiled = null;
  }
  if (PATTERN_CACHE.size >= PATTERN_CACHE_MAX) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(source, compiled);
  return compiled;
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
    if (typeof schema.pattern === "string") {
      const matcher = matcherFor(schema.pattern);
      // The worker marks a fragment it cannot interpret as rejected and refuses every value
      // under it (`Catalog#validateEntryValue`). Say so here rather than letting the operator
      // submit something the server will drop.
      if (!matcher) return "unsupported pattern — the server rejects any value";
      // `test` also returns false past MAX_PATTERN_INPUT, which is the server's behaviour too.
      if (!matcher.test(s)) return "does not match pattern";
    }
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
