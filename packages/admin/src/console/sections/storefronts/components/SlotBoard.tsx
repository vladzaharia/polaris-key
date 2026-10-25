/**
 * The slot board (A-18j; notes/S-15 §7.4, §8.1 step 4): every image slot of the listing model,
 * grouped by store, from what `pkey listing assets` (A-18d) registered.
 *
 * - **Human** slots (icon master, key art, wordmark, screenshots) that are missing are the only
 *   red: they name the store's exact specification, since only a person can make them.
 * - **Derived** and **composed** outputs (icons; capsules, feature graphics, fitted screenshots)
 *   show their preview and wait for **Accept**: nothing is pushed unseen. Acceptance is the digest
 *   shown, so new bytes from CI need a new look.
 *
 * Previews are same-origin image responses (the console's CSP admits `img-src 'self'`). There is
 * no delete: a store's old images are removed in the store's own console (decision 6).
 */

import * as React from "react";
import { Check } from "lucide-react";
import type { ListingSlotDto } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { LISTING_GROUP_LABELS, useSlots } from "../data.js";
import { docsUrl } from "../../../../lib/docsLinks.js";

const KIND_WORDS: Record<ListingSlotDto["kind"], string> = {
  human: "Made by a person",
  derived: "Derived",
  composed: "Composed",
};

function SlotRow({
  slug,
  slot,
}: {
  slug: string;
  slot: ListingSlotDto;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const a = slot.asset;
  const accept = async () => {
    if (!a) return;
    setBusy(true);
    try {
      await mutate("acceptListingAsset", slug, {
        slot: slot.slot,
        locale: slot.locale,
        sha256: a.sha256,
      });
      toast.success(`${slot.slot} accepted`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className="flex min-h-20 flex-wrap items-center gap-x-3 gap-y-2 py-2"
      data-slot={slot.slot}
      data-state={slot.state}
    >
      <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-sunken">
        {a ? (
          <img
            src={a.image}
            alt={`Preview of ${slot.slot}`}
            loading="lazy"
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </div>
      <div className="min-w-[min(12rem,100%)] flex-1">
        <p className="break-all font-mono text-xs text-fg-strong">
          {slot.slot}
          {slot.locale ? ` · ${slot.locale}` : ""}
        </p>
        <p className="text-xs text-fg-muted">
          {KIND_WORDS[slot.kind]}
          {a?.width && a.height ? ` · ${a.width}×${a.height}` : ""}
          {a?.derivedFrom ? ` · from ${a.derivedFrom}` : ""}
        </p>
        {!a && slot.spec ? (
          <p className="text-xs text-fg">{slot.spec}</p>
        ) : null}
      </div>
      <div className="ms-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        {slot.state === "missing" && slot.kind === "human" ? (
          <StatusPill tone="danger" size="sm">
            Needed
          </StatusPill>
        ) : null}
        {slot.state === "review" ? (
          <Button size="sm" loading={busy} onClick={() => void accept()}>
            Accept
          </Button>
        ) : null}
        {slot.state === "accepted" ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check aria-hidden className="size-4" />
            Accepted
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function SlotBoard({
  slug,
  groups,
  groupLabels,
}: {
  slug: string;
  /** Storefront labels for groups (`play` -> "Google Play Console"), over the built-in words. */
  groupLabels?: Readonly<Record<string, string>>;
  /** Only these groups (a store's listing column, plus `masters`); every group when absent. */
  groups?: readonly string[];
}): React.ReactElement {
  const q = useSlots(slug);
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        context={{ area: "distribution", thing: "Slot board" }}
      />
    );
  const slots = q.data.slots.filter((s) => !groups || groups.includes(s.group));
  // A store slot nothing produced yet and no person has to make: `pkey listing assets` makes it.
  const shown = slots.filter(
    (s) => s.state !== "missing" || s.kind === "human",
  );
  if (shown.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={3}
        title="No listing images yet"
        description="Run pkey listing assets in CI: it derives every store's icons and art from the masters and registers them here for review."
        docs={docsUrl("storefrontListing")}
      />
    );
  const order = Object.keys(LISTING_GROUP_LABELS);
  const byGroup = [...new Set(shown.map((s) => s.group))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  const missingHuman = shown.some(
    (s) => s.state === "missing" && s.kind === "human",
  );
  return (
    <div className="@container space-y-3">
      {missingHuman ? (
        <p className="text-sm text-fg-muted">
          A needed image is made by a person: put the master in the product's{" "}
          <code className="font-mono text-xs">.pkey/</code> assets and run{" "}
          <code className="font-mono text-xs">pkey listing assets</code> in CI.{" "}
          <a
            className="py-1 text-accent-fg underline underline-offset-4"
            href={docsUrl("storefrontListing")}
            target="_blank"
            rel="noreferrer"
          >
            Listing images
          </a>
        </p>
      ) : null}
      <div className="grid gap-4 @3xl:grid-cols-2">
        {byGroup.map((g) => {
          const rows = shown.filter((s) => s.group === g);
          return (
            <section
              key={g}
              aria-label={groupLabels?.[g] ?? LISTING_GROUP_LABELS[g] ?? g}
              className="rounded-lg border border-border bg-surface-raised px-4 py-2"
            >
              <h3 className="py-2 text-sm font-semibold text-fg-strong">
                {groupLabels?.[g] ?? LISTING_GROUP_LABELS[g] ?? g}
              </h3>
              <ul className="divide-y divide-border">
                {rows.map((s) => (
                  <SlotRow
                    key={`${s.slot}@${s.locale ?? ""}`}
                    slug={slug}
                    slot={s}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
