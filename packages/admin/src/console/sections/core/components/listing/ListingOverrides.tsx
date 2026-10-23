/**
 * The scoped listing editor's Overrides tab (A-27.11): the values one storefront gets instead of
 * the shared listing's. Editing the shared text is done under "Every storefront"; here an override
 * is edited or removed, and a new one is made from the Fit report. Values are data, shown escaped.
 */

import * as React from "react";
import type { ListingResponse } from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../../ui/EmptyState.js";
import { Textarea } from "../../../../../ui/Textarea.js";
import { toast } from "../../../../../ui/toast.js";
import { errorCopy } from "../../../../../lib/errorCopy.js";
import { mutate } from "../../../../data/mutations.js";
import {
  SettingsRow,
  SettingsSection,
} from "../../../../templates/Settings.js";
import { fieldLabel } from "../../../storefronts/model/listingFields.js";

type Override = ListingResponse["overrides"][number];

const asText = (v: Override["value"]): string =>
  Array.isArray(v) ? v.join("\n") : v;

export function OverridesTab({
  slug,
  data,
  column,
  storeLabel,
}: {
  slug: string;
  data: ListingResponse;
  column: string;
  storeLabel: string;
}): React.ReactElement {
  const mine = data.overrides.filter((o) => o.store === column);
  const [editing, setEditing] = React.useState<Override | null>(null);
  const [draft, setDraft] = React.useState("");
  const [removing, setRemoving] = React.useState<Override | null>(null);
  const save = async (o: Override) => {
    const list = Array.isArray(o.value);
    await mutate("putListingOverride", slug, {
      store: o.store,
      locale: o.locale,
      field: o.field,
      value: list
        ? draft
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean)
        : draft,
    });
    toast.success(`Override saved for ${storeLabel}`);
    setEditing(null);
  };
  if (mine.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title={`${storeLabel} uses the shared listing`}
        description="It has no overrides. Override a field from the Fit report when it does not fit this storefront."
      />
    );
  return (
    <>
      <SettingsSection id="listing-overrides" title="Overrides">
        {mine.map((o) => {
          const id = `${o.field}:${o.locale ?? ""}`;
          const isEditing =
            editing?.field === o.field && editing.locale === o.locale;
          return (
            <SettingsRow
              key={id}
              label={`${fieldLabel(o.field)}${o.locale ? ` (${o.locale})` : ""}`}
              help={`${storeLabel} override. Other storefronts keep the shared value.`}
            >
              <div className="flex w-full flex-col gap-2" data-override={id}>
                {isEditing ? (
                  <>
                    <Textarea
                      dir="auto"
                      value={draft}
                      onValueChange={setDraft}
                      aria-label={`${fieldLabel(o.field)} override`}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void save(o)}>
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p
                      dir="auto"
                      className="whitespace-pre-wrap break-words text-sm text-fg"
                    >
                      {asText(o.value)}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing(o);
                          setDraft(asText(o.value));
                        }}
                      >
                        Edit override
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemoving(o)}
                      >
                        Remove override
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </SettingsRow>
          );
        })}
      </SettingsSection>
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove the ${fieldLabel(removing.field).toLowerCase()} override?`}
          consequences={[
            `${storeLabel} goes back to the shared listing's value.`,
          ]}
          confirmLabel="Remove override"
          describeError={(e) =>
            errorCopy(e, { area: "distribution", thing: "Override" })
          }
          onConfirm={async () => {
            await mutate("putListingOverride", slug, {
              store: removing.store,
              locale: removing.locale,
              field: removing.field,
              value: null,
            });
            toast.success(`Override removed for ${storeLabel}`);
          }}
        />
      ) : null}
    </>
  );
}
