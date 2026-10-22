import * as React from "react";
import { CircleCheck, TriangleAlert, Users } from "lucide-react";
import type { EdgeMintRecipe } from "../../../../api.js";
import { formatDateTime, fromSeconds } from "../../../../lib/format.js";
import { Section } from "../../../../ui/Section.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { REQUIRES_LABELS, changedLabel } from "../model/edgeMintFields.js";

/**
 * Under a minted token: the approval history as far as the API serves it (the last approval, and
 * the pending change when there is one), and who can get a token, in words from the recipe.
 */
export function MintCards({
  slug,
  keyName,
  recipe,
}: {
  slug: string;
  keyName: string;
  recipe: EdgeMintRecipe;
}): React.ReactElement {
  const a = recipe.approval;
  const waiting = recipe.status !== "approved";
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section
        variant="settings"
        id="approval-history"
        title="Approval history"
        actions={
          <Link
            to={r.catalogEntry(slug, keyName, true)}
            className="text-sm underline underline-offset-2"
          >
            {waiting ? "Review" : "View"}
          </Link>
        }
      >
        <ul className="divide-y divide-border text-sm">
          {waiting ? (
            <li className="flex items-start gap-3 px-4 py-3">
              <TriangleAlert
                aria-hidden
                className="mt-0.5 size-4 text-warning"
              />
              <span>
                {recipe.status === "changed" && recipe.changedFields.length > 0
                  ? `${recipe.changedFields.map(changedLabel).join(", ")} changed`
                  : "Not approved yet"}
                <span className="block text-fg-muted">
                  Waiting for approval
                </span>
              </span>
            </li>
          ) : null}
          {a ? (
            <li className="flex items-start gap-3 px-4 py-3">
              <CircleCheck
                aria-hidden
                className="mt-0.5 size-4 text-fg-muted"
              />
              <span>
                {a.approvedBy} approved
                <span className="block text-fg-muted">
                  {formatDateTime(fromSeconds(a.approvedAt))}
                </span>
              </span>
            </li>
          ) : null}
        </ul>
      </Section>
      <Section variant="settings" id="who-can-get" title="Who can get one">
        <ul className="divide-y divide-border text-sm">
          <li className="flex items-center gap-3 px-4 py-3">
            <Users aria-hidden className="size-4 text-fg-muted" />
            {REQUIRES_LABELS[recipe.requires]}
          </li>
          {recipe.requiredEntitlement ? (
            <li className="flex items-center gap-3 px-4 py-3">
              <span className="ps-6">
                The license must include{" "}
                <code className="font-mono text-xs">
                  {recipe.requiredEntitlement}
                </code>
              </span>
            </li>
          ) : null}
        </ul>
      </Section>
    </div>
  );
}
