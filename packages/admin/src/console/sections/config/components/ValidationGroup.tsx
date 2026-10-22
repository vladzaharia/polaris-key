import * as React from "react";
import { SUPPORTED_FORMATS } from "@polaris-key/catalog";
import { schemaIssue } from "../../../../schema/index.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { formatJson } from "../../../../ui/CodeEditor.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { Select } from "../../../../ui/Select.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { Group, NumberKeyword } from "./EntryFormParts.js";
import { withField } from "./EntryFormParts.js";

type Json = Record<string, unknown>;

/** Keywords that only describe a fragment; anything else in it is a validation rule. */
export const DESCRIPTIVE_KEYWORDS = new Set(["type", "description"]);

/**
 * The Validation group of the entry form: the schema's keywords by type, or the whole fragment as
 * JSON checked by the server's own interpreter (CAT-5). It opens by itself when it holds a rule or
 * a problem, and when the JSON editor is switched on from elsewhere (`advanced`).
 */
export function ValidationGroup({
  schema,
  type,
  advanced,
  setAdvanced,
  problem: schemaFromEntry,
  onSchema,
}: {
  schema: Json;
  type: string;
  advanced: boolean;
  setAdvanced: (on: boolean) => void;
  /** The draft's problem with the schema. */
  problem: string | undefined;
  onSchema: (next: Json) => void;
}): React.ReactElement {
  const setSchema = onSchema;
  const setSchemaField = (field: string, value: unknown): void =>
    setSchema(withField(schema, field, value));
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
  const hasRules = Object.keys(schema).some(
    (k) => !DESCRIPTIVE_KEYWORDS.has(k),
  );
  const schemaProblem = schemaTextError ?? schemaFromEntry;
  const [open, setOpen] = React.useState(
    () => hasRules || schemaProblem !== undefined,
  );
  React.useEffect(() => {
    if (schemaProblem) setOpen(true);
  }, [schemaProblem]);
  // Switching the JSON editor on (here or from the Allowed values link) opens the group and
  // shows the fragment as it stands.
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (advanced) setOpen(true);
    setSchemaText(
      ((formatJson(JSON.stringify(schema)) ?? "{}") as string).trimEnd(),
    );
    setSchemaTextError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advanced]);
  const issue = schemaFromEntry;
  return (
    <Group
      title="Validation"
      open={open}
      onOpenChange={setOpen}
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
                      typeof schema.pattern === "string" ? schema.pattern : ""
                    }
                    onChange={(e) => setSchemaField("pattern", e.target.value)}
                  />
                )}
              </FormField>
            </>
          )}
        </div>
      ) : null}
      {issue && !advanced ? (
        <p role="alert" className="text-xs text-danger">
          {issue}
        </p>
      ) : null}
      <Checkbox
        label="Edit the schema as JSON"
        checked={advanced}
        onCheckedChange={setAdvanced}
      />
    </Group>
  );
}
