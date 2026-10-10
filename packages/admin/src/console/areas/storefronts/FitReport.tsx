/**
 * The fit report (A-18j over A-18b's `GET …/listing/fit`; notes/S-15 §7.3): per store, whether the
 * shared listing fits, and every field that does not, with what it would take. Nothing is ever cut
 * to fit: a field over a store's limit is fixed in the model or replaced for that store with an
 * **override**, offered on each issue.
 */

import * as React from "react";
import { Check } from "lucide-react";
import type { ListingFitIssue } from "../../../api.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { Select } from "../../../ui/Select.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Textarea } from "../../../ui/Textarea.js";
import { toast } from "../../../ui/toast.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { mutate } from "../../data/mutations.js";
import { useListingFit } from "./data.js";

const ISSUE_WORDS: Record<string, string> = {
  too_long: "too long",
  over_recommended: "over the recommended length",
  missing: "required and missing",
  too_many: "too many entries",
  item_too_long: "an entry is too long",
  packed: "some terms left out",
};

export function issueLine(i: ListingFitIssue): string {
  const where = i.locale ? ` (${i.locale})` : "";
  const amount =
    i.limit !== null && i.actual !== null
      ? `: ${i.actual} of ${i.limit}${i.unit === "bytes" ? " bytes" : i.unit === "items" ? "" : ""}`
      : "";
  return `${i.field}${where} ${ISSUE_WORDS[i.issue] ?? i.issue}${amount}`;
}

function OverrideDialog({
  slug,
  issue,
  storeLabel,
  onClose,
}: {
  slug: string;
  issue: ListingFitIssue | null;
  storeLabel: string;
  onClose: () => void;
}): React.ReactElement | null {
  const [value, setValue] = React.useState("");
  React.useEffect(() => setValue(issue?.proposal ?? ""), [issue]);
  if (!issue) return null;
  const list = issue.from === "keywords" || issue.from === "features";
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Override ${issue.from} for ${storeLabel}?`}
      consequences={[
        `${storeLabel} gets this value instead of the shared listing's${issue.locale ? ` in ${issue.locale}` : " in every locale"}.`,
        "The other stores keep the shared value.",
      ]}
      confirmLabel="Save the override"
      confirmDisabled={value.trim() === ""}
      describeError={(e) =>
        errorCopy(e, { area: "distribution", thing: "Override" })
      }
      onConfirm={async () => {
        await mutate("putListingOverride", slug, {
          store: issue.store,
          locale: issue.locale,
          field: issue.from,
          value: list
            ? value
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean)
            : value,
        });
        toast.success(`Override saved for ${storeLabel}`);
      }}
    >
      <FormField<string>
        name="override-value"
        label={list ? "Values, one per line" : "Value"}
        help={
          issue.limit !== null
            ? `${storeLabel} takes at most ${issue.limit}${issue.unit === "items" ? " entries" : issue.unit === "bytes" ? " bytes" : " characters"}.`
            : undefined
        }
        required
        value={value}
        onChange={setValue}
      >
        {(field) => (
          <Textarea
            id={field.id}
            value={value}
            onValueChange={setValue}
            aria-describedby={field["aria-describedby"]}
          />
        )}
      </FormField>
    </ConfirmDialog>
  );
}

export function FitReport({
  slug,
  stores,
  storeFilter,
}: {
  slug: string;
  /** Only these listing columns (`play`, `ms-store`…); every store when absent. */
  stores?: readonly string[];
  /**
   * The store switcher (PS-06): one store's row, or every store's (`""`), chosen by the operator.
   * The Listing page keeps it in the URL (`?store=`), so a storefront's page links to its row.
   */
  storeFilter?: { value: string; onChange: (store: string) => void };
}): React.ReactElement {
  const q = useListingFit(slug);
  const [override, setOverride] = React.useState<{
    issue: ListingFitIssue;
    label: string;
  } | null>(null);
  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        context={{ area: "distribution", thing: "Fit report" }}
      />
    );
  const known = q.data.stores.some((s) => s.store === storeFilter?.value);
  const only = storeFilter && known ? storeFilter.value : null;
  const rows = q.data.stores.filter(
    (s) =>
      (!stores || stores.includes(s.store)) &&
      (only === null || s.store === only),
  );
  return (
    <>
      {storeFilter ? (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          <label
            htmlFor={`fit-store-${slug}`}
            className="text-sm text-fg-muted"
          >
            Store
          </label>
          <Select
            id={`fit-store-${slug}`}
            className="w-full sm:w-56"
            value={only ?? "all"}
            options={[
              { value: "all", label: "Every store" },
              ...q.data.stores.map((s) => ({ value: s.store, label: s.label })),
            ]}
            onChange={(v) => storeFilter.onChange(!v || v === "all" ? "" : v)}
          />
        </div>
      ) : null}
      <ul
        aria-label="Fit report"
        className="divide-y divide-border rounded-lg border border-border bg-surface-raised"
      >
        {rows.map((s) => (
          <li key={s.store} className="px-4 py-3" data-fit={s.store}>
            <div className="flex min-h-8 items-center justify-between gap-3">
              <span className="text-sm font-medium text-fg-strong">
                {s.label}
              </span>
              {s.status === "green" ? (
                <span className="inline-flex items-center gap-1 text-sm text-success">
                  <Check aria-hidden className="size-4" />
                  Fits
                </span>
              ) : (
                <StatusPill
                  tone={s.status === "red" ? "danger" : "warning"}
                  size="sm"
                >
                  {s.issues.length} to review
                </StatusPill>
              )}
            </div>
            {s.issues.length ? (
              <ul className="mt-2 space-y-1">
                {s.issues.map((i, n) => (
                  <li
                    key={`${i.field}:${i.locale ?? ""}:${n}`}
                    className="flex min-h-8 items-center justify-between gap-3"
                  >
                    <span
                      className={
                        i.severity === "block"
                          ? "text-sm text-danger"
                          : "text-sm text-fg"
                      }
                    >
                      {issueLine(i)}
                    </span>
                    {i.from !== "releaseNotes" &&
                    i.from !== "releaseNotesShort" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setOverride({ issue: i, label: s.label })
                        }
                      >
                        Override…
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      <OverrideDialog
        slug={slug}
        issue={override?.issue ?? null}
        storeLabel={override?.label ?? ""}
        onClose={() => setOverride(null)}
      />
    </>
  );
}
