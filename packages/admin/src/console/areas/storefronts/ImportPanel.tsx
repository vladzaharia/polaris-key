/**
 * Listing import (A-18j over A-18c's `POST …/listing/import`; notes/S-15 §8.1 step 3): pick the
 * sources, see the field-by-field diff, then apply exactly that diff (its digest). Nothing is
 * written before the apply, and the apply refuses when the sources changed since the preview.
 *
 * The Godot project is read by the CLI, where the project is (`pkey listing import --godot <project> --product <slug>`); the
 * console imports from the stores and the manifests. Imported text is shown escaped, never as HTML.
 */

import * as React from "react";
import type {
  ListingImportChange,
  ListingImportPreview,
} from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { toast } from "../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../ui/useUnsavedChangesGuard.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { mutate } from "../../data/mutations.js";

const SOURCES = [
  { id: "app-store", label: "From App Store" },
  { id: "play", label: "From Google Play" },
  { id: "ms-store", label: "From Microsoft Store" },
  { id: "manifest", label: "From .pkey/distribution" },
  { id: "product", label: "From .pkey/product" },
] as const;

const ACTION_WORDS: Record<ListingImportChange["action"], string> = {
  add: "Added",
  replace: "Changed",
  keep: "Kept",
};

function show(v: ListingImportChange["current"]): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return JSON.stringify(v);
}

export function ImportPanel({ slug }: { slug: string }): React.ReactElement {
  const [picked, setPicked] = React.useState<string[]>(["manifest"]);
  const [preview, setPreview] = React.useState<ListingImportPreview | null>(
    null,
  );
  const [busy, setBusy] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const pending = preview !== null && !preview.applied;
  const guard = useUnsavedChangesGuard(pending, {
    message: "Leave without applying the import?",
    consequences: ["The diff is not applied. Nothing has been imported."],
    // The flow's own `?step=` changes keep the diff.
    allow: (hash) => hash.split("?")[0] === window.location.hash.split("?")[0],
  });
  const sources = picked.map((source) => ({ source }));

  const run = async () => {
    setBusy(true);
    try {
      const r = await mutate("listingImport", slug, { sources });
      setPreview(r.import);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const changes = preview?.changes ?? [];
  const applicable = changes.filter((c) => c.action !== "keep");
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-fg-strong">
          Sources
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SOURCES.map((s) => (
            <Checkbox
              key={s.id}
              label={s.label}
              checked={picked.includes(s.id)}
              onCheckedChange={(on) => {
                setPreview(null);
                setPicked((p) =>
                  on ? [...p, s.id] : p.filter((x) => x !== s.id),
                );
              }}
            />
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <p className="text-sm text-fg-muted">
          From the Godot project, in CI or a checkout:
        </p>
        <CodeBlock
          code={`pkey listing import --godot . --product ${slug}`}
          language="sh"
        />
      </div>
      <div className="flex justify-end">
        <Button
          variant="outline"
          loading={busy}
          disabled={picked.length === 0}
          onClick={() => void run()}
        >
          Show the changes
        </Button>
      </div>
      {preview ? (
        <div className="space-y-3">
          {preview.sources
            .filter((s) => !s.ok)
            .map((s) => (
              <p key={s.source} className="text-sm text-danger">
                {s.source}: {s.message ?? s.reason ?? "could not be read"}
              </p>
            ))}
          {changes.length === 0 ? (
            <p className="text-sm text-fg-muted">
              The sources match the listing: nothing to import.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Import changes</caption>
                <thead className="bg-surface-sunken text-left text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Field</th>
                    <th className="px-3 py-2 font-medium">Now</th>
                    <th className="px-3 py-2 font-medium">Imported</th>
                    <th className="px-3 py-2 text-right font-medium">From</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {changes.map((c) => (
                    <tr key={c.field} data-action={c.action} className="h-11">
                      <td className="px-3 py-2">
                        <span className="block font-mono text-xs text-fg-strong">
                          {c.field}
                        </span>
                        <span className="text-xs text-fg-muted">
                          {ACTION_WORDS[c.action]}
                          {c.reason ? `: ${c.reason}` : ""}
                        </span>
                      </td>
                      <td className="max-w-xs whitespace-pre-wrap break-words px-3 py-2 text-fg-muted">
                        {show(c.current)}
                      </td>
                      <td className="max-w-xs whitespace-pre-wrap break-words px-3 py-2 text-fg">
                        {show(c.proposed)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-fg-muted">
                        {c.proposedSource}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {applicable.length && !preview.applied ? (
            <div className="flex justify-end">
              <Button onClick={() => setApplying(true)}>
                Apply {applicable.length} change
                {applicable.length === 1 ? "" : "s"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={applying}
        onOpenChange={setApplying}
        title="Apply the import?"
        consequences={[
          `${applicable.length} field${applicable.length === 1 ? "" : "s"} of the shared listing change as shown.`,
          "Fields you typed yourself are kept unless the diff says otherwise.",
        ]}
        confirmLabel="Apply the import"
        describeError={(e) =>
          errorCopy(e, { area: "distribution", thing: "Import" })
        }
        onConfirm={async () => {
          const r = await mutate("listingImport", slug, {
            sources,
            confirm: preview!.digest,
          });
          setPreview(r.import);
          toast.success("Listing imported");
        }}
      />
      {guard.dialog}
    </div>
  );
}
