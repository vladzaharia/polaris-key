import * as React from "react";
import type { ConfigEntry } from "../../../../api.js";
import { FormField } from "../../../../ui/form.js";
import { AllowedValues } from "./AllowedValues.js";
import {
  RemovalWarning,
  type KeyHolders,
  type Removal,
} from "./RemovedValues.js";

type Json = Record<string, unknown>;

/**
 * The Allowed values field of a setting (config.entry-setting): the chips with who uses each value,
 * the warning when a removed one is still in use, and the way into the schema as JSON.
 */
export function AllowedValuesField({
  entry,
  type,
  advanced,
  baseEntry,
  removal,
  holders,
  slug,
  describedBy,
  onEnum,
  onEditJson,
}: {
  entry: ConfigEntry;
  type: string;
  advanced: boolean;
  baseEntry: ConfigEntry | undefined;
  removal: Removal | undefined;
  holders: KeyHolders | undefined;
  slug: string;
  describedBy: string;
  onEnum: (next: unknown[]) => void;
  onEditJson: () => void;
}): React.ReactElement | null {
  if (advanced || !["string", "integer", "number"].includes(type)) return null;
  const schema = (entry.schema ?? {}) as Json;
  const values = Array.isArray(schema.enum) ? schema.enum : [];
  const was = (baseEntry?.schema as Json | undefined)?.enum;
  const baseValues = Array.isArray(was) ? was : null;
  const removed = removal?.values ?? [];
  const restore = (v: unknown): void => {
    const order = baseValues ?? [];
    const keep = [...values, v];
    onEnum([
      ...order.filter((o) =>
        keep.some((k) => JSON.stringify(k) === JSON.stringify(o)),
      ),
      ...values.filter(
        (x) => !order.some((o) => JSON.stringify(o) === JSON.stringify(x)),
      ),
    ]);
  };
  return (
    <div className="space-y-2">
      <FormField
        name="enum"
        label="Allowed values"
        group
        help={
          values.length === 0
            ? "Any value is allowed. Add values to limit it."
            : undefined
        }
        value={values}
      >
        {(f) => (
          <div aria-labelledby={f["aria-labelledby"]} className="space-y-3">
            <AllowedValues
              values={values}
              removed={removed}
              baseValues={baseValues}
              defaultValue={entry.default}
              numeric={type !== "string"}
              use={holders}
              onChange={onEnum}
              onUndo={restore}
            />
            <RemovalWarning
              slug={slug}
              removal={removal}
              describedBy={describedBy}
            />
          </div>
        )}
      </FormField>
      <button
        type="button"
        onClick={onEditJson}
        className="inline-flex min-h-6 items-center text-sm text-fg-strong underline underline-offset-2"
      >
        Edit as JSON schema
      </button>
    </div>
  );
}
