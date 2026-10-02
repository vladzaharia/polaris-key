import * as React from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Package,
} from "lucide-react";
import type {
  DeliverableDto,
  PackFilesResponse,
  PackReleaseDto,
  PackVariantDto,
  PinnedByDto,
} from "../../api.js";
import { api } from "../../api.js";
import { useResource } from "../../context.js";
import { navigate } from "../../route.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  Skeleton,
  type ColumnDef,
} from "../../components/ui/index.js";
import { absoluteTime, relativeTime } from "../format.js";
import { formatBytes, Sha256 } from "./ReleaseBuilds.js";
import { GateCell, PinnedCell } from "./Deliverables.js";

/**
 * A pack deliverable's page (P4-09): its declaration, then its releases newest first — version,
 * seq, channel, variants with payload and full-download sizes and the delta menu, yanked — and,
 * for each release, WHICH APP RELEASES PIN IT. That last column is the operator's question before
 * yanking a pack release (a yank never changes an existing pin, CONTENT §6.7) and when a player's
 * diagnostics name an app release.
 *
 * Read-only: `GET …/release/deliverables` (the declaration) and
 * `GET …/release/deliverables/<id>/releases`. Sizes are the record's; the console computes no
 * ratio the record does not carry, and never names where an object's bytes are stored.
 */
export function DeliverableDetail({
  slug,
  id,
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const list = useResource(`deliverables:${slug}`, () =>
    api.deliverables(slug),
  );
  const releases = useResource(`pack-releases:${slug}:${id}`, () =>
    api.packReleases(slug, id),
  );
  const decl =
    list.data?.deliverables.find((d) => d.id === id && d.kind !== "app") ??
    null;
  const back = (): void =>
    navigate({ kind: "product", slug, view: "deliverables" });

  if (releases.error && !releases.data) {
    return (
      <section className="space-y-6">
        <BackButton onClick={back} />
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load this pack"
          description={releases.error}
          action={
            <Button variant="outline" onClick={releases.reload}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <BackButton onClick={back} />
      <header className="space-y-1">
        <h2 className="break-all font-mono text-2xl font-semibold tracking-tight">
          {id}
        </h2>
        <p className="text-sm text-muted-foreground">
          A pack of <span className="font-mono">{slug}</span>.
        </p>
      </header>
      {list.loading && !list.data ? (
        <Skeleton className="h-24 w-full" />
      ) : decl ? (
        <Declaration d={decl} gateKnown={list.data?.gateKnown ?? true} />
      ) : null}
      <ReleasesCard
        slug={slug}
        deliverable={id}
        releases={releases.data?.releases ?? []}
        loading={releases.loading && !releases.data}
      />
    </section>
  );
}

function BackButton({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      <ArrowLeft className="size-4" aria-hidden />
      Deliverables
    </Button>
  );
}

function Declaration({
  d,
  gateKnown,
}: {
  d: DeliverableDto;
  gateKnown: boolean;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Package className="size-4 text-muted-foreground" aria-hidden />
            <CardTitle>Declaration</CardTitle>
          </div>
          <PinnedCell d={d} />
        </div>
        <CardDescription>
          As the release manifest declares it; edit it in{" "}
          <span className="font-mono">.pkey/release</span> and resync.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!d.declared ? (
          <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            This pack’s stored declaration does not read back. A resync rewrites
            it; until then app releases that need it are refused.
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <Fact term="Type" mono>
            {d.type ?? "—"}
          </Fact>
          <Fact term="Binding">{d.binding ?? "—"}</Fact>
          <Fact term="Required">
            {d.required === null ? "—" : d.required ? "required" : "optional"}
          </Fact>
          <Fact term="Baseline">{d.baseline ?? "—"}</Fact>
          <Fact term="Delivery">{d.delivery ?? "—"}</Fact>
          <Fact term="Entitlement">
            <GateCell d={d} gateKnown={gateKnown} />
          </Fact>
          <Fact term="Variants" mono>
            {d.variantKeys.length
              ? d.variantKeys.map((k) => k || "default").join(", ")
              : "—"}
          </Fact>
          <Fact term="Releases">{String(d.releaseCount)}</Fact>
        </dl>
      </CardContent>
    </Card>
  );
}

function ReleasesCard({
  slug,
  deliverable,
  releases,
  loading,
}: {
  slug: string;
  deliverable: string;
  releases: PackReleaseDto[];
  loading: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: ColumnDef<PackReleaseDto>[] = [
    {
      id: "expand",
      header: <span className="sr-only">Variants</span>,
      className: "w-8 pr-0",
      cell: (r) => {
        const expanded = open.has(r.releaseId);
        return (
          <button
            type="button"
            onClick={() => toggle(r.releaseId)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} variants of ${r.version}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden />
            ) : (
              <ChevronRight className="size-4" aria-hidden />
            )}
          </button>
        );
      },
    },
    {
      id: "version",
      header: "Version",
      accessor: (r) => r.seq ?? 0,
      sortable: true,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="font-mono text-xs">{r.version}</span>
          {r.yank ? (
            <Badge
              variant="destructive"
              title={`Yanked by ${r.yank.by} ${absoluteTime(r.yank.at)}`}
            >
              Yanked: {r.yank.reason}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: "seq",
      header: "Seq",
      cell: (r) => (r.seq === null ? "—" : String(r.seq)),
    },
    {
      id: "channel",
      header: "Channel",
      cell: (r) =>
        r.channel ?? <span className="text-muted-foreground">—</span>,
    },
    {
      id: "published",
      header: "Published",
      cell: (r) =>
        r.publishedAt ? (
          <span title={absoluteTime(r.publishedAt)}>
            {relativeTime(r.publishedAt)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "variants",
      header: "Variants",
      cell: (r) => String(r.variants.length),
    },
    {
      id: "pinnedBy",
      header: "Pinned by",
      cell: (r) => <PinnedBy pins={r.pinnedBy} />,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Releases</CardTitle>
        <CardDescription>
          Newest first. “Pinned by” lists every app release that ships this pack
          release; yanking a pack release keeps those pins and only stops new
          ones.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={releases}
          rowKey={(r) => r.releaseId}
          loading={loading}
          expanded={(r) =>
            open.has(r.releaseId) ? (
              <Variants slug={slug} deliverable={deliverable} release={r} />
            ) : null
          }
          empty={
            <EmptyState
              icon={<Package aria-hidden />}
              title="No releases yet"
              description="CI publishes pack releases; none has been published for this pack."
              className="rounded-none border-0"
            />
          }
        />
      </CardContent>
    </Card>
  );
}

/** The app releases that pin one pack release, each marked if it is itself yanked. */
function PinnedBy({ pins }: { pins: PinnedByDto[] }): React.ReactElement {
  if (!pins.length)
    return <span className="text-muted-foreground">no app release</span>;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Pinned by">
      {pins.map((p) => (
        <li key={p.appReleaseId}>
          <Badge
            variant={p.appYank ? "destructive" : "outline"}
            title={`${p.appReleaseId} · ${p.required ? "required" : "optional"} · ${p.delivery}`}
          >
            <span className="font-mono">
              app {p.appVersion ?? p.appReleaseId}
            </span>
            {p.appYank ? <span> (yanked)</span> : null}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function Variants({
  slug,
  deliverable,
  release,
}: {
  slug: string;
  deliverable: string;
  release: PackReleaseDto;
}): React.ReactElement {
  if (!release.variants.length)
    return (
      <p className="text-sm text-muted-foreground">
        This release’s stored record does not read back.
      </p>
    );
  return (
    <div className="space-y-2" aria-label={`Variants of ${release.version}`}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {release.recordSha256 ? (
          <span className="inline-flex items-center gap-1">
            Record <Sha256 value={release.recordSha256} />
          </span>
        ) : null}
        {release.formatVersion !== null ? (
          <span>Format version {release.formatVersion}</span>
        ) : null}
        <span>
          Signed entitlement:{" "}
          <span className="font-mono">{release.entitlement ?? "none"}</span>
        </span>
      </div>
      <div className="overflow-x-auto rounded-md border border-border bg-background">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Variant
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Engine
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Payload
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Full download
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Delta menu
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Files</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {release.variants.map((v) => (
              <VariantRow
                key={v.variantKey}
                v={v}
                files={{
                  slug,
                  deliverable,
                  releaseId: release.releaseId,
                  version: release.version,
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FilesTarget {
  slug: string;
  deliverable: string;
  releaseId: string;
  version: string;
}

function VariantRow({
  v,
  files,
}: {
  v: PackVariantDto;
  files: FilesTarget;
}): React.ReactElement {
  const [shown, setShown] = React.useState(false);
  const label = v.variantKey || "default";
  return (
    <>
      <tr className="border-t border-border align-top first:border-0">
        <td className="px-3 py-2 font-mono text-xs">
          {v.variantKey || "default"}
        </td>
        <td className="px-3 py-2">{v.engine ?? "—"}</td>
        <td className="px-3 py-2">
          <span className="inline-flex flex-wrap items-center gap-2">
            {formatBytes(v.payload.size)}
            <Sha256 value={v.payload.sha256} />
          </span>
        </td>
        <td className="px-3 py-2">{formatBytes(v.fullBytes)}</td>
        <td className="px-3 py-2">
          {v.deltas.length ? (
            <ul className="space-y-0.5 text-xs">
              {v.deltas.map((d, i) => (
                <li key={i}>
                  <span className="font-medium">{d.scope}</span>
                  {d.method ? (
                    <span className="text-muted-foreground"> {d.method}</span>
                  ) : null}{" "}
                  from{" "}
                  <span className="font-mono">
                    {d.fromVersion ??
                      (d.from ? `${d.from.slice(0, 12)}…` : "unknown")}
                  </span>
                  : {formatBytes(d.bytes)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">full only</span>
          )}
        </td>
        <td className="px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={shown}
            aria-label={`${shown ? "Hide" : "Show"} files of ${label} in ${files.version}`}
            onClick={() => setShown((x) => !x)}
          >
            {shown ? "Hide files" : "Files"}
          </Button>
        </td>
      </tr>
      {shown ? (
        <tr>
          <td colSpan={6} className="px-3 pb-3 pt-0">
            <FileList target={files} variantKey={v.variantKey} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * One variant's files, fetched on demand: the server decodes one files index per request, so
 * the page never asks for every variant's index at once.
 */
function FileList({
  target,
  variantKey,
}: {
  target: FilesTarget;
  variantKey: string;
}): React.ReactElement {
  const [state, setState] = React.useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; data: PackFilesResponse }
  >({ kind: "loading" });
  React.useEffect(() => {
    let live = true;
    api
      .packFiles(target.slug, target.deliverable, target.releaseId, variantKey)
      .then((data) => live && setState({ kind: "ok", data }))
      .catch(
        (e: unknown) =>
          live &&
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : "Request failed.",
          }),
      );
    return () => {
      live = false;
    };
  }, [target.slug, target.deliverable, target.releaseId, variantKey]);

  if (state.kind === "loading") return <Skeleton className="h-10 w-full" />;
  if (state.kind === "error")
    return (
      <p className="text-xs text-warning">
        Couldn’t read this variant’s files index: {state.message}
      </p>
    );
  const { files, total } = state.data;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {total === files.length
          ? `${total} files`
          : `The first ${files.length} of ${total} files`}
      </p>
      <ul
        className="max-h-80 space-y-0.5 overflow-y-auto text-xs"
        aria-label={`Files of ${variantKey || "default"}`}
      >
        {files.map((f) => (
          <li
            key={f.path}
            className="flex flex-wrap items-center gap-x-3 gap-y-0.5"
          >
            <span className="break-all font-mono">{f.path}</span>
            <span className="text-muted-foreground">{formatBytes(f.size)}</span>
            {f.blob.codec !== "none" ? (
              <span className="text-muted-foreground">
                {f.blob.codec} {formatBytes(f.blob.bytes)}
              </span>
            ) : null}
            <Sha256 value={f.sha256} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fact({
  term,
  children,
  mono,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">
        {term}
      </dt>
      <dd className={mono ? "break-words font-mono text-sm" : "text-sm"}>
        {children}
      </dd>
    </div>
  );
}
