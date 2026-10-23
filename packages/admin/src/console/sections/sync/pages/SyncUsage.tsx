/**
 * Cloud Sync → Usage (config.cloud-sync-usage; U-05.20). Read-only, from the directory's own
 * aggregate (`GET …/sync/usage`, U-05.19): the console computes nothing from it and shows no
 * person, subject or device. Counts and bytes, in MiB and GiB.
 *
 * A game says "player" and an app "person"; which one the product is comes from its catalog (a
 * `saves` collection means a game), never from a product name (rule 5).
 *
 * Nothing here depends on colour: every tile, row and bar segment carries its label and value in
 * text, and the bar has a short text alternative (the table beside it holds every size).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type ProductCatalog,
  type SyncUsageResponse,
} from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import {
  formatCount,
  formatRelative,
  fromSeconds,
} from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatTile } from "../../../../ui/charts/StatTile.js";
import { DOCS_LINKS } from "../../../../lib/docsLinks.js";
import { useProduct } from "../../../data/hooks.js";
import { qk } from "../../../data/queries.js";
import { SECTIONS } from "../../../nav.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { Panel } from "../../../templates/Dashboard.js";
import { declaresSaves, useProductCeilingBytes } from "../data.js";
import { SyncHeader } from "../SyncHeader.js";
import {
  formatStorage,
  nounsFor,
  PlatformPanel,
  StoredPanel,
  storedKinds,
  TierPanel,
  cap,
  type Nouns,
  type Usage,
} from "./usageParts.js";

export { formatStorage, nounsFor };

export function SyncUsagePage({ slug }: { slug: string }): React.ReactElement {
  const product = useProduct(slug);
  const off = product.data?.services?.sync?.enabled === false;
  const usage = useQuery({
    queryKey: qk.syncUsage(slug),
    queryFn: () => api.syncUsage(slug),
    retry: false,
    enabled: !off && !product.isPending,
  });
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    retry: false,
    enabled: !off,
  });
  const nouns = nounsFor(declaresSaves(catalog.data ?? null));
  const licensing = product.data?.services?.license?.enabled !== false;

  const header = (
    <SyncHeader
      slug={slug}
      tab="sync-usage"
      refetching={usage.isFetching && !usage.isPending}
    />
  );

  let body: React.ReactNode;
  if (off || (usage.data && !usage.data.enabled)) {
    body = <SyncOff slug={slug} name={product.data?.name ?? slug} />;
  } else if (usage.isPending || catalog.isPending) {
    // The catalog is part of loading: the page never says "People" and then "Players".
    body = <UsageSkeleton />;
  } else if (usage.isError) {
    body = (
      <ErrorState
        error={usage.error}
        onRetry={() => void usage.refetch()}
        thing="Usage"
        context={{ read: true }}
      />
    );
  } else if (usage.data.enabled) {
    body =
      usage.data.usage.people === 0 ? (
        <UsageEmpty data={usage.data} nouns={nouns} slug={slug} />
      ) : (
        <UsageBody
          data={usage.data}
          nouns={nouns}
          slug={slug}
          catalog={catalog.data ?? null}
          licensing={licensing}
        />
      );
  }

  return (
    <div className="space-y-6" data-template="record">
      {header}
      {body}
    </div>
  );
}

/** The shell's off page, in the tab: the same words, a primary Open Features and the docs. */
function SyncOff({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  const section = SECTIONS.find((s) => s.key === "sync");
  return (
    <EmptyState
      kind="service-off"
      service="sync"
      headingLevel={2}
      title={`Cloud Sync is off for ${name}.`}
      description={`${name} doesn't use Cloud Sync, so there is nothing here to manage. Turn it on in Features and this page comes back.`}
      primaryAction={
        <Button asChild>
          <Link to={r.services(slug)}>Open Features</Link>
        </Button>
      }
      docs={section?.docs}
    />
  );
}

const TILES =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 xl:grid-cols-4";

/** Four tiles and a table card: the page's own shape, with no second header. */
function UsageSkeleton(): React.ReactElement {
  return (
    <div className="space-y-6" aria-busy="true">
      <p role="status" className="sr-only">
        Loading usage
      </p>
      <div aria-hidden className={TILES}>
        {["a", "b", "c", "d"].map((k) => (
          <StatTile key={k} label="Loading" loading />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

/** No one has data: one fact and one action. Today's counters stay when syncs have happened. */
function UsageEmpty({
  data,
  nouns,
  slug,
}: {
  data: Usage;
  nouns: Nouns;
  slug: string;
}): React.ReactElement {
  const { today } = data;
  return (
    <>
      {today.syncs > 0 || today.conflicts > 0 ? (
        <div className={TILES}>
          <StatTile
            label="Syncs today"
            value={formatCount(today.syncs)}
            secondary="Since 00:00 UTC"
          />
          <StatTile
            label="Conflicts today"
            value={formatCount(today.conflicts)}
            secondary="Since 00:00 UTC"
          />
        </div>
      ) : null}
      <EmptyState
        kind="first-run"
        headingLevel={2}
        docs={DOCS_LINKS.syncUsage}
        title="No data yet"
        description={`Usage updates every 15 minutes, once a signed-in ${nouns.one} syncs.`}
        primaryAction={
          <Button asChild variant="outline">
            <Link to={r.syncSetup(slug)}>See Setup</Link>
          </Button>
        }
      />
    </>
  );
}

function UsageBody({
  data,
  nouns,
  slug,
  catalog,
  licensing,
}: {
  data: Usage;
  nouns: Nouns;
  slug: string;
  catalog: ProductCatalog | null;
  licensing: boolean;
}): React.ReactElement {
  const { usage, today } = data;
  const ceilingBytes = useProductCeilingBytes(slug);
  // Stored and platforms share a row only when stored has the body to balance it.
  const kinds = storedKinds(usage, catalog);
  const paired = kinds.bar || kinds.shown.length >= 3;
  const updated = usage.computedAt
    ? `Updated ${formatRelative(fromSeconds(usage.computedAt))}.`
    : "";
  return (
    <>
      <div className={TILES}>
        <StatTile
          label={`${cap(nouns.many)} with data`}
          value={formatCount(usage.people)}
        />
        <StatTile
          label="Storage used"
          value={formatStorage(usage.bytes)}
          secondary={`Of ${formatStorage(ceilingBytes)}`}
        />
        <StatTile
          label="Syncs today"
          value={formatCount(today.syncs)}
          secondary="Since 00:00 UTC"
        />
        <StatTile
          label="Conflicts today"
          value={formatCount(today.conflicts)}
          secondary="Since 00:00 UTC"
        />
      </div>
      {updated ? (
        <p className="-mt-3 text-xs text-fg-muted">
          {updated} Syncs and conflicts are live.{" "}
          <a
            href={DOCS_LINKS.syncUsage}
            className="underline underline-offset-2 hover:text-fg-strong"
          >
            What these figures mean
          </a>
        </p>
      ) : null}

      <div className="grid gap-6 min-[1100px]:grid-cols-[3fr_2fr] min-[1600px]:grid-cols-[minmax(0,1fr)_400px]">
        <TierPanel
          data={data}
          nouns={nouns}
          slug={slug}
          licensing={licensing}
          className="min-[1100px]:col-span-2 min-[1600px]:col-span-1 min-[1600px]:col-start-1 min-[1600px]:row-start-1"
        />
        <StoredPanel
          usage={usage}
          nouns={nouns}
          catalog={catalog}
          className={cn(
            "min-[1600px]:col-start-1 min-[1600px]:row-start-2",
            !paired && "min-[1100px]:col-span-2 min-[1600px]:col-span-1",
          )}
        />
        <PlatformPanel
          data={data}
          nouns={nouns}
          className={cn(
            "min-[1600px]:col-start-2 min-[1600px]:row-start-1",
            !paired && "min-[1100px]:col-span-2 min-[1600px]:col-span-1",
          )}
        />
      </div>
    </>
  );
}
