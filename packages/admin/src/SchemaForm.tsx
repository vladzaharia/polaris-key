import React, { useMemo, useState } from "react";
import type { ConfigEntry } from "./api.js";

/**
 * A tiny schema-driven form. Given a catalog entry's JSON-Schema fragment it renders the
 * right input (boolean -> switch, enum -> select, number -> stepper, string -> text) and
 * validates the value against the fragment locally so the SchemaCatalog "live preview" and
 * the override editor share one renderer. This is a deliberately small subset of Draft-07
 * (type / enum / minimum / maximum / minLength / maxLength / pattern) — the same fragments
 * the worker's Ajv validates server-side, so a value that passes here also passes there.
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
export function validate(schema: Record<string, unknown>, value: unknown): string | null {
  const type = schema.type as string | undefined;
  if (value === undefined || value === "") {
    return null; // empty ⇒ "no override"
  }
  if (type === "integer" || type === "number") {
    const n = Number(value);
    if (Number.isNaN(n)) return "must be a number";
    if (type === "integer" && !Number.isInteger(n)) return "must be an integer";
    if (typeof schema.minimum === "number" && n < schema.minimum) return `must be ≥ ${schema.minimum}`;
    if (typeof schema.maximum === "number" && n > schema.maximum) return `must be ≤ ${schema.maximum}`;
  }
  if (type === "string") {
    const s = String(value);
    if (typeof schema.minLength === "number" && s.length < schema.minLength) return `min length ${schema.minLength}`;
    if (typeof schema.maxLength === "number" && s.length > schema.maxLength) return `max length ${schema.maxLength}`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(s)) return "does not match pattern";
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return "not an allowed value";
  return null;
}

export function SchemaField({
  entry,
  value,
  onChange,
}: {
  entry: ConfigEntry;
  value: unknown;
  onChange: (result: FieldResult) => void;
}): React.ReactElement {
  const schema = entry.schema;
  const error = useMemo(() => validate(schema, value), [schema, value]);
  const emit = (raw: string) => {
    const v = coerce(schema, raw);
    onChange({ value: v, valid: validate(schema, v) === null, error: validate(schema, v) ?? undefined });
  };

  const inputId = `f-${entry.key}`;
  let control: React.ReactElement;
  if (schema.type === "boolean") {
    control = (
      <input
        id={inputId}
        type="checkbox"
        checked={value === true}
        aria-label={entry.label}
        onChange={(ev) => onChange({ value: ev.target.checked, valid: true })}
      />
    );
  } else if (Array.isArray(schema.enum)) {
    control = (
      <select id={inputId} value={String(value ?? "")} aria-label={entry.label} onChange={(ev) => emit(ev.target.value)}>
        <option value="">—</option>
        {(schema.enum as unknown[]).map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "integer" || schema.type === "number") {
    control = (
      <input
        id={inputId}
        type="number"
        value={value === undefined || value === null ? "" : String(value)}
        aria-label={entry.label}
        min={typeof schema.minimum === "number" ? schema.minimum : undefined}
        max={typeof schema.maximum === "number" ? schema.maximum : undefined}
        onChange={(ev) => emit(ev.target.value)}
      />
    );
  } else {
    control = (
      <input
        id={inputId}
        type={entry.secret || entry.kind === "secret" ? "password" : "text"}
        value={String(value ?? "")}
        aria-label={entry.label}
        placeholder={entry.ui?.placeholder}
        onChange={(ev) => emit(ev.target.value)}
      />
    );
  }

  return (
    <div className={`field${error ? " field-invalid" : ""}`}>
      <label htmlFor={inputId} className="field-label">
        {entry.label}
        <span className="field-kind">{entry.kind}</span>
      </label>
      {control}
      {entry.description ? <p className="field-help">{entry.description}</p> : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
