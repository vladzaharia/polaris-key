import * as React from "react";
import { SUPPORTED_FORMATS } from "@polaris-key/catalog";
import type {
  UserSettingConflict,
  UserSettingPolicy,
  UserSettingSync,
} from "@polaris-key/catalog";
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

/** Where a user setting's value roams (S-17 §5.3), in the console's words. */
const USER_SYNC_OPTIONS: { value: UserSettingSync; label: string }[] = [
  { value: "user", label: "Everywhere the person signs in" },
  { value: "platform", label: "Per platform family" },
  { value: "device", label: "Per device" },
  { value: "local", label: "Never leaves the device" },
];

/** How concurrent writes resolve. `max`/`min` need a number schema, `merge` an object. */
const USER_CONFLICT_OPTIONS: { value: UserSettingConflict; label: string }[] = [
  { value: "lastWrite", label: "Last write wins" },
  { value: "max", label: "Keep the highest" },
  { value: "min", label: "Keep the lowest" },
  { value: "merge", label: "Merge members" },
];

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

/**
 * One catalog entry as a structured form (docs/design/ADMIN.md §6.6.2, decision Q5): key, kind,
 * label, category, description, the schema's common keywords by type, default, management
 * default, user grant and UI hints. Anything the basic schema controls cannot express is edited
 * as a JSON fragment, validated by the same interpreter the server uses (CAT-5).
 */
export function CatalogEntryForm({
  entry,
  issues,
  categories,
  onChange,
}: {
  entry: ConfigEntry;
  /** The draft's problems on this entry. */
  issues: CatalogIssue[];
  /** Every category in the draft, offered as suggestions. */
  categories: string[];
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

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="key"
          label="Key"
          required
          help="A dotted identifier, unique in the catalog."
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
              onChange={(e) => onChange({ ...entry, key: e.target.value })}
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
                if (kind === "secret")
                  next = withField(next, "default", undefined);
                if (kind !== "config") {
                  next = withField(next, "managementDefault", undefined);
                  // A user setting is a config key (Cloud Sync rule 1).
                  next = withField(next, "user", undefined);
                }
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

      <fieldset className="space-y-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-bold text-fg-strong">
          Schema
        </legend>
        {advanced ? (
          <FormField
            name="schema-json"
            label="Schema (JSON)"
            help="The full JSON-Schema fragment, checked by the catalog's own validator."
            value={schemaText}
            error={schemaTextError ?? issue("schema")}
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
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="type" label="Type" value={type}>
              {(f) => (
                <Select
                  {...f}
                  value={type}
                  options={TYPES.map((t) => ({
                    value: t,
                    label: TYPE_LABELS[t],
                  }))}
                  onChange={(t) => {
                    const next: Json = { type: t };
                    if (schema.description)
                      next.description = schema.description;
                    onChange({
                      ...withField(entry, "default", undefined),
                      schema: next,
                    });
                  }}
                />
              )}
            </FormField>
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
            {type === "string" || type === "integer" || type === "number" ? (
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
            ) : null}
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
            ) : null}
            {type === "string" ? (
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
                        typeof schema.pattern === "string" ? schema.pattern : ""
                      }
                      onChange={(e) =>
                        setSchemaField("pattern", e.target.value)
                      }
                    />
                  )}
                </FormField>
              </>
            ) : null}
          </div>
        )}
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
      </fieldset>

      {secret ? (
        <p className="text-sm text-fg-muted">
          A secret has no default: its value is write-only and set per profile
          or license.
        </p>
      ) : (
        <div className="space-y-2">
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

      {entry.kind === "config" ? (
        <UserSettingFields
          user={entry.user}
          error={issue("user")}
          onChange={(user) => set("user", user)}
        />
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

      <fieldset className="space-y-4 rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-bold text-fg-strong">
          Form hints
        </legend>
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
                value={typeof ui.placeholder === "string" ? ui.placeholder : ""}
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
      </fieldset>
    </div>
  );
}

/**
 * The entry's `user` block (S-17 §5.10: "User setting" with scope, conflict and listed). A user
 * setting's value is chosen by the person and kept on their device by the Config SDK; with Cloud
 * Sync on and the person signed in, it syncs. The operator can still enforce the key, which is
 * why an enforced or hidden management default refuses the block (rule 2).
 */
function UserSettingFields({
  user,
  error,
  onChange,
}: {
  user: UserSettingPolicy | undefined;
  error: string | undefined;
  onChange: (next: UserSettingPolicy | undefined) => void;
}): React.ReactElement {
  return (
    <fieldset className="space-y-4 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-bold text-fg-strong">
        User setting
      </legend>
      <Checkbox
        label="People choose this value"
        description="Kept on each device by the Config SDK; with Cloud Sync on, it syncs for people who sign in."
        checked={user !== undefined}
        onCheckedChange={(on) => onChange(on ? { sync: "user" } : undefined)}
      />
      {user ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="user-sync" label="Syncs" value={user.sync}>
              {(f) => (
                <Select
                  {...f}
                  value={user.sync}
                  options={USER_SYNC_OPTIONS}
                  onChange={(v) =>
                    onChange({
                      ...user,
                      sync: (v ?? "user") as UserSettingSync,
                    })
                  }
                />
              )}
            </FormField>
            <FormField
              name="user-conflict"
              label="When two devices disagree"
              value={user.conflict ?? "lastWrite"}
            >
              {(f) => (
                <Select
                  {...f}
                  value={user.conflict ?? "lastWrite"}
                  options={USER_CONFLICT_OPTIONS}
                  onChange={(v) =>
                    onChange(
                      withField(
                        user,
                        "conflict",
                        v === "lastWrite" ? undefined : v,
                      ),
                    )
                  }
                />
              )}
            </FormField>
          </div>
          <Checkbox
            label="Show in settings panels"
            checked={user.listed !== false}
            onCheckedChange={(on) =>
              onChange(withField(user, "listed", on ? undefined : false))
            }
          />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
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
