/**
 * What a storefront run left for the operator to finish in the store's own console (A-18j;
 * decision 6): Polaris Key never deletes store images, so after a replaced set the older ones are
 * counted and the store page where they are removed is linked. The sentence and the link come
 * from the server (the run result's `followUp`), never from the store's name; a link the product
 * cannot render yet names the identifiers it lacks instead.
 */

import * as React from "react";
import { ExternalLink } from "lucide-react";
import type { StorefrontFollowUp } from "../../../api.js";
import { Button } from "../../../ui/Button.js";

export function FollowUpNote({
  followUp,
  storeLabel,
}: {
  followUp: StorefrontFollowUp;
  storeLabel: string;
}): React.ReactElement {
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border bg-surface-sunken px-3 py-2"
      data-follow-up={followUp.count}
    >
      <div className="min-w-0 flex-[1_1_16rem] space-y-1">
        <p className="text-sm text-fg">{followUp.text}</p>
        {followUp.url === null && followUp.missing.length ? (
          <p className="text-sm text-fg-muted">
            The link opens once the product has its{" "}
            {followUp.missing.join(", ")}.
          </p>
        ) : null}
      </div>
      {followUp.url ? (
        <Button size="sm" variant="outline" className="ml-auto" asChild>
          <a href={followUp.url} target="_blank" rel="noreferrer noopener">
            <ExternalLink aria-hidden />
            Open {storeLabel}
          </a>
        </Button>
      ) : null}
    </div>
  );
}
