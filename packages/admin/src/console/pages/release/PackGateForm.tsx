import * as React from "react";
import type { DeliverableDto, ReleaseAccess } from "../../../api.js";
import { ENTITLEMENT_PATTERN } from "@polaris-key/protocol/packs";
import {
  ACCESS_DESCRIPTIONS,
  ACCESS_LABELS,
  label,
} from "../../../lib/labels.js";
import { Callout } from "../../../ui/Callout.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import {
  Form,
  FormField,
  useAdminForm,
  type FieldErrorMap,
} from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { SaveBar } from "../../../ui/SaveBar.js";
import { Select } from "../../../ui/Select.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { useDeliveryAccess } from "./data.js";

/**
 * A pack's delivery gate (ADMIN.md §6.3.4 "Delivery tab", DLV-3): who may download it and the
 * license flag a device needs. One `dist_access` row, saved on its own (`PUT …/distribution/access`
 * with `deliverable` and `entitlement`); a pack with no row inherits the app's mode. Distribution
 * owns the row, so the form reads "Distribution is off" rather than guessing when it is.
 */

interface Values {
  mode: string;
  entitlement: string;
}

export function PackGateForm({
  slug,
  deliverable,
  distributionOn,
}: {
  slug: string;
  deliverable: DeliverableDto;
  distributionOn: boolean;
}): React.ReactElement {
  const access = useDeliveryAccess(slug, distributionOn);
  const row = access.data?.deliverables.find(
    (d) => d.deliverableId === deliverable.id,
  );
  const inheritedMode = access.data?.app.mode ?? "entitled";
  const values: Values = {
    mode: row?.mode ?? inheritedMode,
    entitlement: row?.entitlement ?? "",
  };
  const form = useAdminForm<Values>({
    values,
    validate: (v): FieldErrorMap =>
      v.entitlement.trim() && !ENTITLEMENT_PATTERN.test(v.entitlement.trim())
        ? {
            entitlement:
              "Use a short identifier: letters, digits, dots, colons, dashes or underscores (64 at most).",
          }
        : {},
    onSubmit: async (v) => {
      await mutate("saveDeliveryAccess", slug, {
        deliverable: deliverable.id,
        mode: v.mode as ReleaseAccess,
        entitlement: v.entitlement.trim() || null,
      });
      toast.success(`Saved ${deliverable.id}'s delivery gate`);
    },
  });

  if (!distributionOn)
    return (
      <Callout tone="info" title="Distribution is off">
        Delivery gates are Distribution's: turn Distribution on in Services to
        gate who may download {deliverable.id}.
      </Callout>
    );
  if (access.isPending) return <Skeleton className="h-40 w-full" />;
  if (access.error)
    return (
      <ErrorState error={access.error} onRetry={() => void access.refetch()} />
    );

  const modes = access.data?.modes ?? [];
  const signed = deliverable.latest?.entitlement ?? null;
  const gate = deliverable.gate;
  return (
    <Form form={form} aria-label={`${deliverable.id} delivery gate`}>
      <div className="max-w-3xl space-y-6 rounded-lg border border-border bg-surface-raised p-4 lg:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-fg-strong">Delivery gate</h2>
          {row ? (
            <SourceBadge source={row.source} path=".pkey/distribution" />
          ) : (
            <span className="text-xs text-fg-muted">
              Inherits the app's mode ({label(ACCESS_LABELS, inheritedMode)})
            </span>
          )}
        </div>
        <FormField
          name="mode"
          label="Who may download"
          help={ACCESS_DESCRIPTIONS[form.rhf.watch("mode")] ?? undefined}
        >
          {(f) => (
            <Select
              {...f}
              options={modes.map((m) => ({
                value: m,
                label: label(ACCESS_LABELS, m),
                description: ACCESS_DESCRIPTIONS[m],
              }))}
            />
          )}
        </FormField>
        <FormField
          name="entitlement"
          label="Entitlement"
          help="The license flag a device needs to download this pack. Leave it blank for no flag."
        >
          {(f) => <Input {...f} mono placeholder="hd-textures" />}
        </FormField>
        {deliverable.latest && signed !== gate ? (
          <Callout
            tone="warning"
            title="The latest release was signed with a different gate"
          >
            {deliverable.latest.version} was signed with{" "}
            {signed ? (
              <span className="font-mono">{signed}</span>
            ) : (
              "no entitlement"
            )}
            . Devices follow the signed value until the next publish.
          </Callout>
        ) : null}
        {deliverable.assertedEntitlement &&
        deliverable.assertedEntitlement !== gate ? (
          <p className="text-xs text-fg-muted">
            The manifest asserts{" "}
            <span className="font-mono">{deliverable.assertedEntitlement}</span>
            ; the gate saved here is what downloads enforce.
          </p>
        ) : null}
      </div>
      <SaveBar form={form} section="Delivery gate" />
    </Form>
  );
}
