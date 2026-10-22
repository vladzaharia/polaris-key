/** The listing editor's Push tab (A-27.10; moved out of ListingEditor.tsx). */

import * as React from "react";
import type { StorefrontDto, StorefrontFollowUp } from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../../ui/Skeleton.js";
import { toast } from "../../../../../ui/toast.js";
import { errorCopy } from "../../../../../lib/errorCopy.js";
import { mutate } from "../../../../data/mutations.js";
import {
  SettingsRow,
  SettingsSection,
} from "../../../../templates/Settings.js";
import {
  newIdempotencyKey,
  useStorefronts,
} from "../../../storefronts/data.js";
import { FollowUpNote } from "../../../storefronts/components/FollowUpNote.js";
import { followUpOf } from "../../../storefronts/components/StepDialog.js";
import { docsUrl } from "../../../../../lib/docsLinks.js";

// ── Push ─────────────────────────────────────────────────────────────────────────────────────

/** A storefront's id (`google-play`, `ms-store`…), as `StorefrontDto.id`. */
export type StorefrontId = string;

export function PushTab({
  slug,
  store,
}: {
  slug: string;
  store?: StorefrontId | undefined;
}): React.ReactElement {
  const q = useStorefronts(slug);
  const [pushing, setPushing] = React.useState<StorefrontDto | null>(null);
  // What each store's last push left to finish in its console (decision 6), by store id.
  const [followUps, setFollowUps] = React.useState<
    Record<string, StorefrontFollowUp>
  >({});
  if (q.isPending) return <Skeleton className="h-48 w-full" />;
  if (q.isError)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        context={{ area: "distribution", thing: "Storefronts" }}
      />
    );
  const stores = q.data.stores.filter(
    (s) => s.pushListing !== null && (store === undefined || s.id === store),
  );
  if (stores.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No store takes a listing push"
        description="Stores whose listing Polaris Key can write appear here."
        docs={docsUrl("storefronts")}
      />
    );
  return (
    <>
      <SettingsSection id="listing-push" title="Push listing">
        {stores.map((s) => (
          <SettingsRow
            key={s.id}
            label={s.label}
            help={
              s.readOnly ??
              (s.app
                ? `Text and accepted images go to ${s.app.name ?? s.app.id}.`
                : "Assign the product's app in Platform → Store connections first.")
            }
          >
            <Button
              size="sm"
              disabled={s.readOnly !== null || s.app === null}
              onClick={() => setPushing(s)}
            >
              Push listing
            </Button>
          </SettingsRow>
        ))}
      </SettingsSection>
      {stores
        .filter((s) => followUps[s.id])
        .map((s) => (
          <FollowUpNote
            key={s.id}
            followUp={followUps[s.id]!}
            storeLabel={s.label}
          />
        ))}
      <PushDialog
        slug={slug}
        store={pushing}
        onClose={() => setPushing(null)}
        onDone={(store, result) =>
          setFollowUps((s) => {
            const { [store]: _, ...rest } = s;
            const f = followUpOf(result);
            return f ? { ...rest, [store]: f } : rest;
          })
        }
      />
    </>
  );
}

function PushDialog({
  slug,
  store,
  onClose,
  onDone,
}: {
  slug: string;
  store: StorefrontDto | null;
  onClose: () => void;
  onDone: (store: string, result: unknown) => void;
}): React.ReactElement | null {
  const key = React.useMemo(() => (store ? newIdempotencyKey() : ""), [store]);
  if (!store) return null;
  const canStage = store.pushListing?.stageOnly === true;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Push the listing to ${store.label}?`}
      consequences={[
        `${store.label} receives every locale's listing text and the accepted images.`,
        canStage
          ? "The change is staged: nothing is sent for review until you submit."
          : "The pending submission stays uncommitted: nothing goes to certification.",
        "No image is deleted: older ones stay until you remove them in the store's console. The result counts them and links the page.",
      ]}
      confirmLabel="Push listing"
      describeError={(e) =>
        errorCopy(e, { area: "distribution", thing: "Listing push" })
      }
      onConfirm={async () => {
        const result = await mutate(
          "pushListing",
          slug,
          store.id,
          {},
          { idempotencyKey: key },
        );
        toast.success(`Listing pushed to ${store.label}`);
        onDone(store.id, result);
      }}
    />
  );
}
