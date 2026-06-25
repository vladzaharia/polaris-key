import * as React from "react";
import { AlertTriangle, FileJson, Lock, Upload } from "lucide-react";
import type { ConfigEntry } from "../api.js";
import { api } from "../api.js";
import { useResource } from "../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "../components/ui/index.js";
import {
  KIND_VARIANT,
  STATE_VARIANT,
  formatValue,
  groupByCategory,
  schemaSummary,
} from "./catalog/helpers.js";
import { PublishDialog } from "./catalog/PublishDialog.js";

/**
 * Catalog view: the active config catalog for a product, grouped by category, plus a
 * "Publish new version" flow. The catalog is the per-product schema (`getSchema`) — the set of
 * `ConfigEntry`s (config / secret / flag) an admin can override on tiers, profiles, and
 * licenses. Read-heavy; the only mutation is publishing a new `schemaVersion`.
 */
export function Catalog({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(`schema:${slug}`, () => api.schema(slug));
  const [publishOpen, setPublishOpen] = React.useState(false);

  if (loading && !data) return <CatalogSkeleton />;

  if (error && !data) {
    return (
      <section className="space-y-6">
        <Header version={null} onPublish={null} />
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load the catalog"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }

  if (!data) {
    return (
      <section className="space-y-6">
        <Header version={null} onPublish={() => setPublishOpen(true)} />
        <EmptyState
          icon={<FileJson aria-hidden />}
          title="No catalog yet"
          description="Publish a first version to define the config keys this product exposes."
        />
      </section>
    );
  }

  const groups = groupByCategory(data.entries);
  const total = data.entries.length;

  return (
    <section className="space-y-6">
      <Header version={data.schemaVersion} count={total} onPublish={() => setPublishOpen(true)} />

      {total === 0 ? (
        <EmptyState
          icon={<FileJson aria-hidden />}
          title="This catalog is empty"
          description="Publish a new version to add config, secret, and flag entries."
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <CategorySection key={group.category} category={group.category} entries={group.entries} />
          ))}
        </div>
      )}

      <PublishDialog slug={slug} catalog={data} open={publishOpen} onOpenChange={setPublishOpen} />
    </section>
  );
}

function Header({
  version,
  count,
  onPublish,
}: {
  version: number | null;
  count?: number;
  onPublish: (() => void) | null;
}): React.ReactElement {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Catalog</h2>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          The config schema for this product.
          {version != null ? (
            <Badge variant="outline">schema v{version}</Badge>
          ) : null}
          {typeof count === "number" ? (
            <span>
              {count} {count === 1 ? "entry" : "entries"}
            </span>
          ) : null}
        </p>
      </div>
      {onPublish ? (
        <Button onClick={onPublish}>
          <Upload aria-hidden />
          Publish new version
        </Button>
      ) : null}
    </header>
  );
}

function CategorySection({
  category,
  entries,
}: {
  category: string;
  entries: ConfigEntry[];
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {category}
      </h3>
      <div className="grid gap-3">
        {entries.map((entry) => (
          <EntryCard key={entry.key} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function EntryCard({ entry }: { entry: ConfigEntry }): React.ReactElement {
  const isSecret = entry.secret || entry.kind === "secret";
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              {entry.label}
              {isSecret ? (
                <Lock className="size-3.5 text-warning" aria-label="secret" />
              ) : null}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{entry.key}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={KIND_VARIANT[entry.kind]}>{entry.kind}</Badge>
            {entry.managementDefault ? (
              <Badge variant={STATE_VARIANT[entry.managementDefault]}>
                {entry.managementDefault}
              </Badge>
            ) : null}
            {entry.userGrant ? <Badge variant="outline">user-grant</Badge> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {entry.description ? (
          <p className="mb-3 text-sm text-muted-foreground">{entry.description}</p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Detail term="Schema" value={schemaSummary(entry.schema)} mono />
          <Detail
            term="Default"
            value={isSecret ? "— (write-only)" : formatValue(entry.default)}
            mono
          />
          {entry.ui?.widget ? <Detail term="Widget" value={entry.ui.widget} /> : null}
          {entry.ui?.help ? <Detail term="UI help" value={entry.ui.help} /> : null}
          {entry.ui?.placeholder ? (
            <Detail term="Placeholder" value={entry.ui.placeholder} />
          ) : null}
          {entry.ui?.advanced ? <Detail term="Visibility" value="advanced" /> : null}
          {entry.accessor ? <Detail term="Accessor" value={entry.accessor} mono /> : null}
        </dl>
      </CardContent>
    </Card>
  );
}

function Detail({
  term,
  value,
  mono,
}: {
  term: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{term}</dt>
      <dd className={mono ? "break-words font-mono text-xs" : "break-words"}>{value}</dd>
    </div>
  );
}

function CatalogSkeleton(): React.ReactElement {
  return (
    <section className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </section>
  );
}
