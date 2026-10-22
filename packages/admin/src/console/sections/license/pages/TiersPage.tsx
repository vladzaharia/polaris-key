/**
 * License → Tiers (licenses.tiers): the tiers beside the open tier's record. From 1024 px the list
 * is a column (272 px, 300 from 1280) and the record fills the rest; below that a select picks
 * the tier above the record. Rows open the tier (`/tiers/<id>`; `/tiers` opens the first) and
 * show its rank ("1 of 4", best first). Delete lives in the record's menu. Create is a one-pane
 * drawer (TIR-8). Reordering, Includes and the other mockup fields wait for LX-44, LX-34, LX-41.
 */

import * as React from "react";
import { Plus } from "lucide-react";
import { mutate } from "../../../data/mutations.js";
import { r } from "../../../routes.js";
import { Link, navigate } from "../../../router.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { cn } from "../../../../lib/cn.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Form, useAdminForm } from "../../../../ui/form.js";
import { Select } from "../../../../ui/Select.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import {
  EMPTY_TIER,
  TierFields,
  tierCreateBody,
  validateTier,
  type TierValues,
} from "../components/TierForm.js";
import { TierEditor } from "../components/TierEditor.js";
import { licenseCountText, useTierUsage } from "../components/tierSummary.js";
import { useTiers } from "../components/shared.js";

export function TiersPage({
  slug,
  selectedId,
}: {
  slug: string;
  /** The tier the route opens; the first tier when absent. */
  selectedId?: string;
}): React.ReactElement {
  const tiersQ = useTiers(slug);
  const usage = useTierUsage(slug);
  const [createOpen, setCreateOpen] = React.useState(false);
  const tiers = React.useMemo(() => tiersQ.data?.tiers ?? [], [tiersQ.data]);
  const open =
    selectedId === undefined
      ? tiers[0]
      : tiers.find((t) => t.id === selectedId);

  const header = (
    <PageHeader
      title="Tiers"
      primaryAction={
        <Button iconStart={<Plus />} onClick={() => setCreateOpen(true)}>
          New tier
        </Button>
      }
      refetching={tiersQ.isFetching && !tiersQ.isPending}
    />
  );

  let body: React.ReactNode;
  if (tiersQ.isPending) {
    body = <PageSkeleton template="record" label="tiers" />;
  } else if (tiersQ.error && !tiersQ.data) {
    body = (
      <ErrorState
        error={tiersQ.error}
        onRetry={() => void tiersQ.refetch()}
        context={{ thing: "Tiers" }}
      />
    );
  } else if (tiers.length === 0) {
    body = (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No tiers yet"
        description="A tier bundles a profile and policy defaults that licenses can be put on."
        primaryAction={
          <Button iconStart={<Plus />} onClick={() => setCreateOpen(true)}>
            New tier
          </Button>
        }
        docs={docsUrl("tierEditor")}
      />
    );
  } else {
    body = (
      <div className="grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[18.75rem_minmax(0,1fr)]">
        <div className="lg:hidden">
          <Select
            aria-label="Tier"
            value={open?.id ?? null}
            placeholder="Choose a tier"
            options={tiers.map((t) => ({
              value: t.id,
              label: t.label || t.id,
              description: usage ? licenseCountText(usage.get(t.id) ?? 0) : "",
            }))}
            onChange={(id) => id && navigate(r.tier(slug, id))}
          />
        </div>
        <nav
          aria-label="Tiers"
          className="hidden overflow-hidden rounded-lg border border-border bg-surface-raised lg:sticky lg:top-4 lg:block"
        >
          <ul className="divide-y divide-border">
            {tiers.map((t, i) => {
              const used = usage?.get(t.id) ?? 0;
              const current = t.id === open?.id;
              return (
                <li
                  key={t.id}
                  className={cn(
                    "flex items-center gap-1 border-s-[3px] pe-2",
                    current
                      ? "border-accent bg-accent-subtle"
                      : "border-transparent",
                  )}
                >
                  <Link
                    to={r.tier(slug, t.id)}
                    aria-current={current ? "page" : undefined}
                    className="min-w-0 flex-1 px-3 py-2 outline-offset-[-2px] hover:bg-hover"
                  >
                    <span
                      className="block truncate text-sm font-medium text-fg-strong"
                      title={t.label || t.id}
                    >
                      {t.label || t.id}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {`${i + 1} of ${tiers.length}`}
                      {usage ? ` · ${licenseCountText(used)}` : ""}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        {open ? (
          <TierEditor
            key={open.id}
            slug={slug}
            tier={open}
            used={usage ? (usage.get(open.id) ?? 0) : null}
          />
        ) : (
          <EmptyState
            kind="not-found"
            headingLevel={2}
            title="This tier doesn't exist"
            description="It may have been deleted, or the link has a typo."
            primaryAction={
              <Button variant="outline" onClick={() => navigate(r.tiers(slug))}>
                Back to tiers
              </Button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <CollectionTemplate header={header}>
      {body}
      <CreateTierDrawer
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingIds={tiers.map((t) => t.id)}
      />
    </CollectionTemplate>
  );
}

function CreateTierDrawer({
  slug,
  open,
  onOpenChange,
  existingIds,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingIds: string[];
}): React.ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="New tier" size="lg">
      {open ? (
        <CreateTierForm
          slug={slug}
          existingIds={existingIds}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Drawer>
  );
}

function CreateTierForm({
  slug,
  existingIds,
  onDone,
}: {
  slug: string;
  existingIds: string[];
  onDone: () => void;
}): React.ReactElement {
  const form = useAdminForm<TierValues>({
    values: EMPTY_TIER,
    validate: (v) => validateTier(v, { existingIds, creating: true }),
    onSubmit: async (v) => {
      await mutate("createTier", slug, tierCreateBody(v));
      toast.success("Tier created", {
        description: `“${v.label.trim() || v.id.trim()}” is ready to assign.`,
      });
      onDone();
    },
  });
  return (
    <Form
      form={form}
      aria-label="New tier"
      className="flex min-h-0 flex-1 flex-col"
    >
      <DrawerBody className="space-y-4">
        <TierFields slug={slug} creating />
        {form.submitError && !Object.keys(form.errors).length ? (
          <Callout tone="danger" title="The tier wasn't created" live>
            {errorCopy(form.submitError, { thing: "Tier" }).description}
          </Callout>
        ) : null}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onDone} disabled={form.isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" loading={form.isSubmitting}>
          Create tier
        </Button>
      </DrawerFooter>
    </Form>
  );
}
