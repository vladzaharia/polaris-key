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
import { ErrorBlock } from "./InlineFailure.js";
import { Button } from "../../../../ui/Button.js";
import { errorCopy } from "../../../../lib/errorCopy.js";

export function TierEditor(props: {
  slug: string;
  tier: TierSummary;
  /** Licenses on the tier; `null` while unknown. */
  used: number | null;
}): React.ReactElement {
  return props.tier.implicit ? (
    <DefaultTierRecord {...props} />
  ) : (
    <EditableTierRecord {...props} />
  );
}

/**
 * The product's Default tier (LX-33.7): read-only. In release N its limits follow the product's
 * license defaults, and it cannot be deleted.
 */
function DefaultTierRecord({
  slug,
  tier,
  used,
}: {
  slug: string;
  tier: TierSummary;
  used: number | null;
}): React.ReactElement {
  const name = tier.label || tier.id;
  return (
    <section
      aria-labelledby="tier-title"
      className="overflow-hidden rounded-lg border border-border bg-surface-raised"
    >
      <div className="px-5 py-4">
        <h2
          id="tier-title"
          className="truncate text-lg font-semibold text-fg-strong"
          title={name}
        >
          {name}
        </h2>
        <p className="mt-0.5 text-sm text-fg-muted">
          Used when a license names no tier
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
      <dl className="divide-y divide-border border-t border-border text-sm">
        <div className="grid gap-x-4 px-5 py-3 sm:grid-cols-[9rem_1fr]">
          <dt className="text-fg-muted">Devices</dt>
          <dd className="font-medium text-fg-strong">
            {tier.policyDeviceLimit == null
              ? "Unlimited"
              : tier.policyDeviceLimit}
          </dd>
        </div>
      </dl>
      <p className="border-t border-border px-5 py-3 text-sm text-fg-muted">
        Its limits follow the product&apos;s license defaults.
      </p>
    </section>
  );
}

function EditableTierRecord({
  slug,
  tier,
  used,
}: {
  slug: string;
  tier: TierSummary;
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
                  disabledReason: used
                    ? `${usedByText(used)}. Move them to another tier first.`
                    : undefined,
                  onSelect: () => setDeleting(true),
                },
              ]}
            />
          </div>
          <TierGroups slug={slug} heldChannels={values.channels} />
        </section>
        {form.submitError && !Object.keys(form.errors).length ? (
          <SaveFailure error={form.submitError} />
        ) : null}
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

/** A save that failed, above the bar: the words, Copy details, and Reload when the tier moved. */
function SaveFailure({ error }: { error: unknown }): React.ReactElement {
  const copy = errorCopy(error, { thing: "Tier" });
  const moved = (error as { status?: number })?.status === 409;
  return (
    <div className="mb-3">
      <ErrorBlock
        error={error}
        thing="Tier"
        title={moved ? "This tier changed elsewhere" : "The tier wasn't saved"}
        action={
          copy.action === "reload" || moved ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
