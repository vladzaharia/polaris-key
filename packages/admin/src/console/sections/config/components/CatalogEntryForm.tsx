import * as React from "react";
import { AlertCircle, Code } from "lucide-react";
import { userSettingIssues } from "@polaris-key/catalog";
import type {
  ConfigEntry,
  ConfigKind,
  ManagementState,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { IN_APP_LABELS } from "../../../../lib/labels.js";
import { MintRecipeFields } from "./MintRecipeFields.js";
import {
  ENTRY_TYPE_LABELS,
  TYPE_LABELS,
  typeCardHelp,
  codeOnlyText,
  entryType,
  inAppHelp,
  type EntryType,
} from "./entryType.js";
import {
  MANAGEMENT_STATES,
  SchemaField,
  type CatalogIssue,
} from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Select } from "../../../../ui/Select.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { newEntry } from "../model/catalogDraft.js";
import {
  Group,
  FormHintsFields,
  UserSettingFields,
  conflictOptionsFor,
  withField,
} from "./EntryFormParts.js";

export { conflictOptionsFor };
import {
  PLACEHOLDER_LABEL,
  TYPES,
  defaultText,
  guessDefault,
  labelFromKey,
  type SchemaType,
} from "./entryDefaults.js";
import { DESCRIPTIVE_KEYWORDS, ValidationGroup } from "./ValidationGroup.js";
import { same } from "../model/mergeDraft.js";
import { retiredNotes } from "../model/entryNotes.js";
import { AllowedValuesField } from "./AllowedValuesField.js";
import type { KeyHolders, Removal } from "./RemovedValues.js";
import { TypeGlyph } from "./EditorParts.js";

type Json = Record<string, unknown>;

export { labelFromKey, guessDefault, type SchemaType };

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
  slug,
  syncEnabled = true,
  flagKeys = [],
  baseEntry,
  removal,
  holders,
  productName,
  onChange,
}: {
  entry: ConfigEntry;
  /** The draft's problems on this entry. */
  issues: CatalogIssue[];
  /** Every category in the draft, offered as suggestions. */
  categories: string[];
  /** The entry was added in this draft (its type may still be guessed from the default). */
  fresh?: boolean;
  /** The product, for the link to its recipes. */
  slug?: string;
  /** Cloud Sync is on for the product, so an Editable setting's choice can sync. */
  syncEnabled?: boolean;
  /** The draft's flag keys, offered for a minted token's Required entitlement. */
  flagKeys?: string[];
  /** The entry as published, for the allowed values this draft removed. */
  baseEntry?: ConfigEntry;
  /** The removed allowed values and who still holds one. */
  removal?: Removal;
  /** Who sets this key and to what, for the tags on the allowed values. */
  holders?: KeyHolders;
  /** The product's name, for "Shown under the setting in …". */
  productName?: string;
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
  const setUi = (field: string, value: unknown): void => {
    const ui = withField((entry.ui ?? {}) as Json, field, value);
    onChange(withField(entry, "ui", Object.keys(ui).length ? ui : undefined));
  };
  const listId = React.useId();
  const removalNote = React.useId();

  const [advanced, setAdvanced] = React.useState(false);

  const secret = entry.kind === "secret";
  const minted = entryType(entry) === "minted";
  const codeOnly = secret;
  const ui = (entry.ui ?? {}) as Json;
  const hasRules = Object.keys(schema).some(
    (k) => !DESCRIPTIVE_KEYWORDS.has(k),
  );

  // The type is guessed until someone picks it or writes a rule that depends on it.
  const [typePicked, setTypePicked] = React.useState(false);
  const guessing = fresh && !secret && !typePicked && !hasRules && !advanced;
  const [defaultRaw, setDefaultRaw] = React.useState(() =>
    defaultText(entry.default),
  );

  const userIssue = issue("user");
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

  const pickType = (picked: EntryType): void => {
    const kind: ConfigKind =
      picked === "setting" ? "config" : picked === "flag" ? "flag" : "secret";
    // A minted token is a secret delivered as edgeMint; the other types carry no delivery of
    // their own (a secret then means clientScoped). Fields the new type does not use stay on the
    // entry, so picking the earlier type puts them back; the publish drops them
    // (`applicableEntry`).
    onChange(
      withField(
        { ...entry, kind },
        "delivery",
        picked === "minted" ? "edgeMint" : undefined,
      ),
    );
  };
  return (
    <div className="space-y-6">
      {fresh ? (
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
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
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
        help={
          productName
            ? `Shown under the setting in ${productName}'s settings`
            : undefined
        }
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

      <FormField
        name="kind"
        label="Type"
        group
        value={entry.kind}
        error={issue("kind")}
      >
        {(f) => (
          <RadioCards<EntryType>
            columns={entry.kind === "flag" ? 4 : 3}
            indicator="check"
            aria-labelledby={f["aria-labelledby"]}
            value={entryType(entry)}
            onChange={pickType}
            options={(
              [
                "setting",
                "secret",
                "minted",
                ...(entry.kind === "flag" ? (["flag"] as const) : []),
              ] as const
            ).map((k) => ({
              value: k,
              label: ENTRY_TYPE_LABELS[k],
              icon: (
                <span aria-hidden>
                  <TypeGlyph type={k} />
                </span>
              ),
              description:
                k === entryType(entry)
                  ? typeCardHelp(k, productName)
                  : undefined,
            }))}
          />
        )}
      </FormField>
      {entry.kind === "config" ? (
        <AllowedValuesField
          entry={entry}
          type={type}
          advanced={advanced}
          baseEntry={baseEntry}
          removal={removal}
          holders={holders}
          slug={slug ?? ""}
          describedBy={removalNote}
          onEnum={(next) => {
            // The Default's own value is gone: Default empties rather than keep a value the list
            // no longer allows.
            const gone =
              entry.default !== undefined &&
              next.length > 0 &&
              !next.some((v) => same(v, entry.default));
            onChange({
              ...(gone ? withField(entry, "default", undefined) : entry),
              schema: withField(schema, "enum", next),
            });
          }}
          onEditJson={() => setAdvanced(true)}
        />
      ) : null}
      <div className={cn("grid gap-4 sm:grid-cols-2", minted && "hidden")}>
        {minted ? null : (
          <FormField
            name="type"
            label="Value type"
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
        )}
        {secret ? null : guessing ? (
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
              error={issue("default")}
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
      </div>
      {entry.kind === "config" ? (
        <FormField
          name="managementDefault"
          label="In the app"
          group
          help={inAppHelp(
            entry.managementDefault ?? "default",
            syncEnabled && entry.user?.sync !== "local",
          )}
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
                label: IN_APP_LABELS[s.value] ?? s.label,
              }))}
            />
          )}
        </FormField>
      ) : codeOnly ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-fg-strong">In the app</p>
          <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm text-fg-muted">
            <Code aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {codeOnlyText(entryType(entry), entry.key, productName)}
            </span>
          </p>
        </div>
      ) : null}
      {entry.kind === "config" && syncEnabled ? (
        <UserSettingFields
          user={entry.user}
          type={type}
          locked={
            entry.managementDefault === "enforced" ||
            entry.managementDefault === "hidden"
          }
          note={
            userSettingIssues(entry as unknown as Json).find(
              (u) => u.severity === "warning",
            )?.message
          }
          error={userIssue}
          onChange={(user) => set("user", user)}
        />
      ) : null}
      {minted && slug ? (
        <MintRecipeFields
          entry={entry}
          flagKeys={flagKeys}
          slug={slug}
          productName={productName}
          error={issue("mint")}
          onChange={onChange}
        />
      ) : null}
      {retiredNotes(entry).map((note) => (
        <p
          key={note}
          role="status"
          className="flex items-start gap-2 text-sm text-warning"
        >
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{note}</span>
        </p>
      ))}

      {entry.kind === "flag" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Checkbox
            label="Give to the user"
            checked={entry.userGrant === true}
            onCheckedChange={(on) => set("userGrant", on ? true : undefined)}
          />
          {entry.userGrant ? (
            <FormField
              name="grantLabel"
              label="Add-on label"
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
        {minted ? null : (
          <ValidationGroup
            schema={schema}
            type={type}
            advanced={advanced}
            setAdvanced={setAdvanced}
            problem={issue("schema")}
            onSchema={setSchema}
          />
        )}

        {secret ? null : (
          <Group
            title="Form hints"
            open={hintsOpen}
            onOpenChange={setHintsOpen}
          >
            <FormHintsFields ui={ui} setUi={setUi} />
          </Group>
        )}
      </div>
    </div>
  );
}
