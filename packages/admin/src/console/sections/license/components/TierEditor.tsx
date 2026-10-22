/** The open tier's record (licenses.tiers): see TierRecord.tsx for the route. */

import * as React from "react";
import type { TierSummary } from "../../../../api.js";
import { mutate } from "../../../data/mutations.js";
import { r } from "../../../routes.js";
import { Link, navigate } from "../../../router.js";
import { ActionMenu } from "../../../../ui/ActionMenu.js";
import { Form, useAdminForm } from "../../../../ui/form.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { toast } from "../../../../ui/toast.js";
import { useUnsavedChangesGuard } from "../../../../ui/useUnsavedChangesGuard.js";
import {
  TierGroups,
  tierPatchBody,
  tierValues,
  validateTier,
  type TierValues,
} from "./TierForm.js";
import { reachesText, usedByText } from "./tierSummary.js";
import { DeleteTierDialog } from "./DeleteTierDialog.js";

export function TierEditor({
  slug,
  tier,
  used,
}: {
  slug: string;
  tier: TierSummary;
  /** Licenses on the tier; `null` while unknown. */
  used: number | null;
}): React.ReactElement {
  const [deleting, setDeleting] = React.useState(false);
  const values = React.useMemo(() => tierValues(tier), [tier]);
  const form = useAdminForm<TierValues>({
    values,
    validate: (v) => validateTier(v),
    onSubmit: async (draft, { server }) => {
      const body = tierPatchBody(server, draft);
      if (Object.keys(body).length === 0) return;
      await mutate("patchTier", slug, tier.id, body);
      toast.success("Tier saved");
    },
  });
  const name = tier.label || tier.id;
  const recordPrefix = r.tier(slug, tier.id);
  const changed = form.dirtyFields
    .map((f) => form.labels.current.get(f) ?? f)
    .join(", ");
  const guard = useUnsavedChangesGuard(form.isDirty, {
    message: `Discard ${form.dirtyCount} ${form.dirtyCount === 1 ? "change" : "changes"} to ${name}?`,
    consequences: [`${changed} go back to what is saved.`],
    onDiscard: form.discard,
    allow: (hash) => hash.split("?")[0] === recordPrefix,
  });
  const reaches = reachesText(used);
  const n = form.dirtyCount;
  return (
    <div className="space-y-6">
      <Form form={form} aria-label="Tier">
        <section
          aria-labelledby="tier-title"
          className="overflow-hidden rounded-lg border border-border bg-surface-raised"
        >
          <div className="flex items-start gap-3 px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2
                id="tier-title"
                className="truncate text-lg font-semibold text-fg-strong"
                title={name}
              >
                {name}
              </h2>
              <p className="mt-0.5 text-sm text-fg-muted">
                <span className="font-mono text-xs">{tier.id}</span>
                {" · "}
                {used === null ? (
                  "Usage unknown"
                ) : used === 0 ? (
                  usedByText(0)
                ) : (
                  <Link
                    to={r.licenses(slug, { tier: tier.id })}
                    className="text-accent-fg underline-offset-4 hover:underline"
                  >
                    {usedByText(used)}
                  </Link>
                )}
              </p>
            </div>
            <ActionMenu
              label="More actions"
              size="md"
              items={[
                {
                  label: "Delete tier…",
                  tone: "danger",
                  disabledReason: used ? usedByText(used) : undefined,
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
          </div>
          <TierGroups slug={slug} heldChannels={values.channels} />
        </section>
        <SaveBar
          form={form}
          saveLabel={`Save ${name}`}
          summary={`${n} ${n === 1 ? "change" : "changes"}. ${reaches}`.trim()}
        />
        {guard.dialog}
      </Form>
      <DeleteTierDialog
        slug={slug}
        tier={deleting ? tier : null}
        onOpenChange={(o) => !o && setDeleting(false)}
        onDeleted={() => navigate(r.tiers(slug))}
      />
    </div>
  );
}
