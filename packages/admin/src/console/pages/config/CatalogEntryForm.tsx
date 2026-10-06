import * as React from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import { SUPPORTED_FORMATS } from "@polaris-key/catalog";
import type { ConfigEntry, ConfigKind, ManagementState } from "../../../api.js";
import { KIND_LABELS } from "../../../lib/labels.js";
import {
  MANAGEMENT_STATES,
  SchemaField,
  schemaIssue,
  type CatalogIssue,
} from "../../../schema/index.js";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { formatJson } from "../../../ui/CodeEditor.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { SegmentedControl } from "../../../ui/SegmentedControl.js";
import { Select } from "../../../ui/Select.js";
import { Textarea } from "../../../ui/Textarea.js";
import { newEntry } from "./catalogDraft.js";

type Json = Record<string, unknown>;

const TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
] as const;
type SchemaType = (typeof TYPES)[number];

const TYPE_LABELS: Record<SchemaType, string> = {
  string: "Text",
  integer: "Whole number",
  number: "Number",
  boolean: "On / off",
  array: "List (JSON)",
  object: "Object (JSON)",
};

const WIDGETS = [
  "password",
  "select",
  "textarea",
  "switch",
  "stepper",
] as const;

/** A copy of `obj` with `field` set, or removed when `value` is empty. */
function withField<T extends object>(obj: T, field: string, value: unknown): T {
  const next = { ...obj } as Record<string, unknown>;
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    delete next[field];
  } else {
    next[field] = value;
  }
  return next as T;
}

const numberOrUndefined = (raw: string): number | undefined => {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/** Keywords that only describe a fragment; anything else in it is a validation rule. */
const DESCRIPTIVE_KEYWORDS = new Set(["type", "description"]);

/**
 * The label a key implies: its last dotted segment in words, sentence case (`audio.bufferSize`
 * → "Buffer size", `net.retry_count` → "Retry count"). All-caps words keep their case.
 */
export function labelFromKey(key: string): string {
  const last = key.split(".").filter(Boolean).pop() ?? "";
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (w.length > 1 && /^[A-Z0-9]+$/.test(w) ? w : w.toLowerCase()));
  const text = words.join(" ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "";
}

/**
 * The type a typed default implies, with the default in that type: `true` → On / off, `512` →
 * Whole number, `0.5` → Number, `[…]`/`{…}` that parse → List/Object, anything else → Text.
 * An empty box is no default.
 */
export function guessDefault(
  raw: string,
): { type: SchemaType; value: unknown } | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t === "true" || t === "false")
    return { type: "boolean", value: t === "true" };
  if (/^-?\d+$/.test(t) && Number.isSafeInteger(Number(t)))
    return { type: "integer", value: Number(t) };
  if (/^-?(\d+\.\d*|\.\d+|\d+(\.\d+)?[eE][+-]?\d+)$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return { type: "number", value: n };
  }
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return { type: "array", value: parsed };
      if (parsed && typeof parsed === "object")
        return { type: "object", value: parsed };
    } catch {
      // Not JSON (yet): it is text.
    }
  }
  return { type: "string", value: raw };
}

/** The text a default reads as in the plain Default box. */
const defaultText = (value: unknown): string =>
  value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/** The label `newEntry` gives a fresh entry, which Label-from-Key replaces like a derived one. */
const PLACEHOLDER_LABEL = newEntry([], "").label;

/**
 * One catalog entry as a structured form (docs/design/ADMIN.md §6.6.2, decision Q5;
 * EXPERIENCE.md §0.4 S4). It leads with what every entry needs (Key, Kind, Type, Default, then
 * Label, Category and Description) and collapses the rest: **Validation** (the schema's keywords
 * by type, or the whole fragment as JSON checked by the server's own interpreter, CAT-5) and
 * **Form hints**. A group opens by itself when it holds something or has a problem.
 *
 * - **Label from Key:** while the label is still the one the key implies (or the new-entry
 *   placeholder), editing the key rewrites it.
 * - **Type guess:** on an entry added in this draft whose type nobody picked and whose schema has
 *   no rules yet, Default is a plain box and the type follows what is typed into it.
 */
export function CatalogEntryForm({
  entry,
  issues,
  categories,
  fresh = false,
  onChange,
}: {
  entry: ConfigEntry;
  /** The draft's problems on this entry. */
  issues: CatalogIssue[];
  /** Every category in the draft, offered as suggestions. */
  categories: string[];
  /** The entry was added in this draft (its type may still be guessed from the default). */
  fresh?: boolean;
  onChange: (next: ConfigEntry) => void;
}): React.ReactElement {
  const schema = (entry.schema ?? {}) as Json;
  const type = (
    TYPES.includes(schema.type as SchemaType) ? schema.type : "string"
  ) as SchemaType;
  const issue = (field: string): string | undefined =>
    issues.find((i) => i.field === field)?.message;
  const set = (field: keyof ConfigEntry, value: unknown): void =>
    onChange(withField(entry, field, value));
  const setSchema = (next: Json): void => onChange({ ...entry, schema: next });
  const setSchemaField = (field: string, value: unknown): void =>
    setSchema(withField(schema, field, value));
  const setUi = (field: string, value: unknown): void => {
    const ui = withField((entry.ui ?? {}) as Json, field, value);
    onChange(withField(entry, "ui", Object.keys(ui).length ? ui : undefined));
  };
  const listId = React.useId();

  const [advanced, setAdvanced] = React.useState(false);
  const [schemaText, setSchemaText] = React.useState(() =>
    JSON.stringify(schema, null, 2),
  );
  const [schemaTextError, setSchemaTextError] = React.useState<string | null>(
    null,
  );
  // Follow the entry when it changes from outside the JSON box (another control, a new selection).
  const lastSchema = React.useRef(schema);
  React.useEffect(() => {
    if (lastSchema.current === schema) return;
    lastSchema.current = schema;
    setSchemaText(JSON.stringify(schema, null, 2));
    setSchemaTextError(null);
  }, [schema]);

  const enumValues = Array.isArray(schema.enum) ? schema.enum : null;
  const secret = entry.kind === "secret";
  const ui = (entry.ui ?? {}) as Json;
  const hasRules = Object.keys(schema).some(
    (k) => !DESCRIPTIVE_KEYWORDS.has(k),
  );
  const schemaProblem = schemaTextError ?? issue("schema");

  // The type is guessed until someone picks it or writes a rule that depends on it.
  const [typePicked, setTypePicked] = React.useState(false);
  const guessing = fresh && !secret && !typePicked && !hasRules && !advanced;
  const [defaultRaw, setDefaultRaw] = React.useState(() =>
    defaultText(entry.default),
  );

  const [validationOpen, setValidationOpen] = React.useState(
    () => hasRules || schemaProblem !== undefined,
  );
  React.useEffect(() => {
    if (schemaProblem) setValidationOpen(true);
  }, [schemaProblem]);
  const [hintsOpen, setHintsOpen] = React.useState(
    () => Object.keys(ui).length > 0,
  );

  const changeKey = (key: string): void => {
    const derived =
      entry.label === "" ||
      entry.label === PLACEHOLDER_LABEL ||
      entry.label === labelFromKey(entry.key);
    const label = derived ? labelFromKey(key) || entry.label : entry.label;
    onChange({ ...entry, key, label });
  };

  const typeDefault = (raw: string): void => {
    setDefaultRaw(raw);
    const guess = guessDefault(raw);
    if (guess === null) {
      onChange(withField(entry, "default", undefined));
      return;
    }
    const nextSchema: Json =
      guess.type === type ? schema : { ...schema, type: guess.type };
    onChange({ ...entry, schema: nextSchema, default: guess.value });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="key"
          label="Key"
          required
          value={entry.key}
          error={issue("key")}
        >
          {(f) => (
            <Input
              {...f}
              mono
              value={entry.key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => changeKey(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          name="kind"
          label="Kind"
          group
          value={entry.kind}
          error={issue("kind")}
        >
          {(f) => (
            <SegmentedControl<ConfigKind>
              className="w-fit self-start"
              aria-labelledby={f["aria-labelledby"]}
              value={entry.kind}
              onChange={(kind) => {
                let next: ConfigEntry = { ...entry, kind };
                // A secret has no plaintext default; a management default is config-only.
                if (kind === "secret") {
                  next = withField(next, "default", undefined);
                  setDefaultRaw("");
                }
                if (kind !== "config")
                  next = withField(next, "managementDefault", undefined);
                if (kind !== "flag") {
                  next = withField(next, "userGrant", undefined);
                  next = withField(next, "grantLabel", undefined);
                }
                onChange(next);
              }}
              options={(["config", "secret", "flag"] as const).map((k) => ({
                value: k,
                label: KIND_LABELS[k],
              }))}
            />
          )}
        </FormField>
        <FormField
          name="type"
          label="Type"
          help={
            guessing && entry.default !== undefined
              ? "Guessed from the default."
              : undefined
          }
          value={type}
        >
          {(f) => (
            <Select
              {...f}
              value={type}
              options={TYPES.map((t) => ({
                value: t,
                label: TYPE_LABELS[t],
              }))}
              onChange={(t) => {
                setTypePicked(true);
                setDefaultRaw("");
                const next: Json = { type: t };
                if (schema.description) next.description = schema.description;
                onChange({
                  ...withField(entry, "default", undefined),
                  schema: next,
                });
              }}
            />
          )}
        </FormField>
        {secret ? (
          <p className="self-end text-sm text-fg-muted sm:pb-2">
            A secret has no default: its value is write-only and set per profile
            or license.
          </p>
        ) : guessing ? (
          <FormField
            name="default"
            label="Default"
            help={
              entry.default === undefined
                ? "No default: clients get nothing until a profile or license sets the key."
                : undefined
            }
            value={defaultRaw}
          >
            {(f) => (
              <Input
                {...f}
                value={defaultRaw}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => typeDefault(e.target.value)}
              />
            )}
          </FormField>
        ) : (
          <div className="min-w-0 space-y-2">
            <SchemaField
              entry={entry}
              value={entry.default}
              label="Default"
              labelAside={null}
              help={
                entry.default === undefined
                  ? "No default: clients get nothing until a profile or license sets the key."
                  : undefined
              }
              onChange={(result) => set("default", result.value)}
            />
            {entry.default !== undefined ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => set("default", undefined)}
              >
                Remove the default
              </Button>
            ) : null}
          </div>
        )}
        <FormField
          name="label"
          label="Label"
          required
          value={entry.label}
          error={issue("label")}
        >
          {(f) => (
            <Input
              {...f}
              value={entry.label}
              placeholder={labelFromKey(entry.key) || undefined}
              onChange={(e) => onChange({ ...entry, label: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          name="category"
          label="Category"
          value={entry.category}
          error={issue("category")}
        >
          {(f) => (
            <>
              <Input
                {...f}
                list={listId}
                value={entry.category}
                onChange={(e) =>
                  onChange({ ...entry, category: e.target.value })
                }
              />
              <datalist id={listId}>
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </>
          )}
        </FormField>
      </div>
      <FormField
        name="description"
        label="Description"
        value={entry.description}
      >
        {(f) => (
          <Textarea
            {...f}
            rows={2}
            value={entry.description ?? ""}
            onChange={(e) =>
              onChange({ ...entry, description: e.target.value })
            }
          />
        )}
      </FormField>

      {entry.kind === "config" ? (
        <FormField
          name="managementDefault"
          label="Management default"
          group
          help={
            MANAGEMENT_STATES.find(
              (s) => s.value === (entry.managementDefault ?? "default"),
            )?.help
          }
          value={entry.managementDefault ?? "default"}
        >
          {(f) => (
            <SegmentedControl<ManagementState>
              className="w-fit self-start"
              aria-labelledby={f["aria-labelledby"]}
              value={entry.managementDefault ?? "default"}
              onChange={(v) =>
                set("managementDefault", v === "default" ? undefined : v)
              }
              options={MANAGEMENT_STATES.map((s) => ({
                value: s.value,
                label: s.label,
              }))}
            />
          )}
        </FormField>
      ) : null}

      {entry.kind === "flag" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Checkbox
            label="Grant to the user"
            checked={entry.userGrant === true}
            onCheckedChange={(on) => set("userGrant", on ? true : undefined)}
          />
          {entry.userGrant ? (
            <FormField
              name="grantLabel"
              label="Grant label"
              value={entry.grantLabel}
            >
              {(f) => (
                <Input
                  {...f}
                  value={entry.grantLabel ?? ""}
                  placeholder="Included with your license"
                  onChange={(e) => set("grantLabel", e.target.value)}
                />
              )}
            </FormField>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <Group
          title="Validation"
          open={validationOpen}
          onOpenChange={setValidationOpen}
          problem={schemaProblem !== undefined}
        >
          {advanced ? (
            <FormField
              name="schema-json"
              label="Schema (JSON)"
              value={schemaText}
              error={schemaProblem}
              announceError
            >
              {(f) => (
                <Textarea
                  {...f}
                  mono
                  rows={8}
                  spellCheck={false}
                  value={schemaText}
                  onChange={(e) => {
                    const text = e.target.value;
                    setSchemaText(text);
                    let parsed: unknown;
                    try {
                      parsed = JSON.parse(text);
                    } catch (err) {
                      setSchemaTextError(
                        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
                      );
                      return;
                    }
                    const problem = schemaIssue(parsed);
                    setSchemaTextError(problem);
                    if (problem === null) {
                      lastSchema.current = parsed as Json;
                      setSchema(parsed as Json);
                    }
                  }}
                />
              )}
            </FormField>
          ) : type === "string" || type === "integer" || type === "number" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {type === "string" ? (
                <FormField name="format" label="Format" value={schema.format}>
                  {(f) => (
                    <Select
                      {...f}
                      value={
                        typeof schema.format === "string" ? schema.format : null
                      }
                      allowEmpty
                      emptyLabel="Any text"
                      options={SUPPORTED_FORMATS.map((s) => ({
                        value: s,
                        label: s,
                      }))}
                      onChange={(v) => setSchemaField("format", v)}
                    />
                  )}
                </FormField>
              ) : null}
              <FormField
                name="enum"
                label="Allowed values"
                help="Comma-separated. Leave empty to allow any value."
                value={enumValues}
              >
                {(f) => (
                  <Input
                    {...f}
                    value={enumValues ? enumValues.map(String).join(", ") : ""}
                    onChange={(e) => {
                      const parts = e.target.value
                        .split(",")
                        .map((p) => p.trim())
                        .filter((p) => p !== "");
                      setSchemaField(
                        "enum",
                        type === "string"
                          ? parts
                          : parts.map(Number).filter((n) => Number.isFinite(n)),
                      );
                    }}
                  />
                )}
              </FormField>
              {type === "integer" || type === "number" ? (
                <>
                  <NumberKeyword
                    name="minimum"
                    label="Minimum"
                    schema={schema}
                    onChange={setSchemaField}
                  />
                  <NumberKeyword
                    name="maximum"
                    label="Maximum"
                    schema={schema}
                    onChange={setSchemaField}
                  />
                </>
              ) : (
                <>
                  <NumberKeyword
                    name="minLength"
                    label="Minimum length"
                    schema={schema}
                    onChange={setSchemaField}
                  />
                  <NumberKeyword
                    name="maxLength"
                    label="Maximum length"
                    schema={schema}
                    onChange={setSchemaField}
                  />
                  <FormField
                    name="pattern"
                    label="Pattern"
                    help="A regular expression the value must match."
                    value={schema.pattern}
                  >
                    {(f) => (
                      <Input
                        {...f}
                        mono
                        value={
                          typeof schema.pattern === "string"
                            ? schema.pattern
                            : ""
                        }
                        onChange={(e) =>
                          setSchemaField("pattern", e.target.value)
                        }
                      />
                    )}
                  </FormField>
                </>
              )}
            </div>
          ) : null}
          {issue("schema") && !advanced ? (
            <p role="alert" className="text-xs text-danger">
              {issue("schema")}
            </p>
          ) : null}
          <Checkbox
            label="Edit the schema as JSON"
            checked={advanced}
            onCheckedChange={(on) => {
              setAdvanced(on);
              const pretty = formatJson(JSON.stringify(schema));
              setSchemaText((pretty ?? "{}").trimEnd());
              setSchemaTextError(null);
            }}
          />
        </Group>

        <Group title="Form hints" open={hintsOpen} onOpenChange={setHintsOpen}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="widget" label="Widget" value={ui.widget}>
              {(f) => (
                <Select
                  {...f}
                  value={typeof ui.widget === "string" ? ui.widget : null}
                  allowEmpty
                  emptyLabel="Automatic"
                  options={WIDGETS.map((w) => ({ value: w, label: w }))}
                  onChange={(v) => setUi("widget", v)}
                />
              )}
            </FormField>
            <FormField name="unit" label="Unit" value={ui.unit}>
              {(f) => (
                <Input
                  {...f}
                  value={typeof ui.unit === "string" ? ui.unit : ""}
                  placeholder="seconds"
                  onChange={(e) => setUi("unit", e.target.value)}
                />
              )}
            </FormField>
            <FormField name="help" label="Help" value={ui.help}>
              {(f) => (
                <Input
                  {...f}
                  value={typeof ui.help === "string" ? ui.help : ""}
                  onChange={(e) => setUi("help", e.target.value)}
                />
              )}
            </FormField>
            <FormField
              name="placeholder"
              label="Placeholder"
              value={ui.placeholder}
            >
              {(f) => (
                <Input
                  {...f}
                  value={
                    typeof ui.placeholder === "string" ? ui.placeholder : ""
                  }
                  onChange={(e) => setUi("placeholder", e.target.value)}
                />
              )}
            </FormField>
            <FormField name="order" label="Order" value={ui.order}>
              {(f) => (
                <Input
                  {...f}
                  type="number"
                  inputMode="numeric"
                  value={typeof ui.order === "number" ? String(ui.order) : ""}
                  onChange={(e) =>
                    setUi("order", numberOrUndefined(e.target.value))
                  }
                />
              )}
            </FormField>
          </div>
          <Checkbox
            label="Show under More settings"
            description="Collapses the key into the trailing group of generated forms."
            checked={ui.advanced === true}
            onCheckedChange={(on) => setUi("advanced", on ? true : undefined)}
          />
        </Group>
      </div>
    </div>
  );
}

/**
 * A collapsed group of the form: a native disclosure, so it needs no script to open and is
 * announced as expandable. LX-14's `combine` and `entitlementKind` selects join Validation.
 */
function Group({
  title,
  open,
  onOpenChange,
  problem = false,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Something inside is wrong: the summary says so while the group is closed. */
  problem?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
      className="group rounded-md border border-border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-4 py-3 text-sm font-bold text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-90"
        />
        <span className="flex-1">{title}</span>
        {problem && !open ? (
          <span className="inline-flex items-center gap-1 text-xs font-normal text-danger">
            <AlertCircle aria-hidden className="size-3" />
            Has a problem
          </span>
        ) : null}
      </summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}

function NumberKeyword({
  name,
  label,
  schema,
  onChange,
}: {
  name: string;
  label: string;
  schema: Json;
  onChange: (field: string, value: unknown) => void;
}): React.ReactElement {
  const value = schema[name];
  return (
    <FormField name={name} label={label} value={value}>
      {(f) => (
        <Input
          {...f}
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(name, numberOrUndefined(e.target.value))}
        />
      )}
    </FormField>
  );
}
