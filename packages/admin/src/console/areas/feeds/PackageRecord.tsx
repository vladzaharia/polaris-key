/**
 * The package record (T3; notes/S-12 §10.1): Versions, Setup and History, in either scope.
 *
 * Each version shows its tags, when and how it was published (a trusted-publisher run with its
 * link, a static CI token, the console), its size, its digests (each copyable) and its state.
 * Row actions follow the protocol: Yank and Unyank where it has a yank, Deprecate where it has a
 * deprecation (npm); each names the client effect in its confirmation. A yank is L2 (ADMIN.md
 * §5.2), an unyank and a deprecation L1. There is no delete: a version is unique forever.
 */

import * as React from "react";
import type {
  FeedEcosystem,
  FeedPackageDto,
  FeedPackageVersion,
  FeedVersionVerb,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import {
  formatBytes,
  fromSeconds,
  truncateMiddle,
} from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import {
  DataTable,
  type DataColumn,
  type RowActionItem,
} from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Textarea } from "../../../ui/Textarea.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { mutate } from "../../data/mutations.js";
import { Link } from "../../router.js";
import { PACKAGE_TABS } from "../../nav.js";
import { intentOf } from "../../pages/core/confirmGate.js";
import type { ActionId } from "../../../lib/actions.js";
import { useFeedDetail, useFeedPackage } from "./data.js";
import { ActivityTab } from "./FeedPage.js";
import {
  ECOSYSTEM_LABELS,
  YANK_EFFECTS,
  feedHref,
  overviewHref,
  packageHref,
  setupSnippets,
  type FeedScope,
} from "./model.js";

const TAB_LABELS: Record<(typeof PACKAGE_TABS)[number], string> = {
  versions: "Versions",
  setup: "Setup",
  history: "History",
};

export function PackageRecord({
  scope,
  eco,
  owner,
  name,
  tab,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  owner: string;
  name: string;
  tab?: string;
}): React.ReactElement {
  const query = useFeedPackage(scope, eco, owner, name);
  useLoadingAnnouncement("package", query.isPending);
  const current = (PACKAGE_TABS as readonly string[]).includes(tab ?? "")
    ? (tab as (typeof PACKAGE_TABS)[number])
    : "versions";
  const data = query.data;
  const crumbs = (
    <Breadcrumbs
      items={[
        { label: "Package feeds", to: overviewHref(scope) },
        { label: ECOSYSTEM_LABELS[eco], to: feedHref(scope, eco) },
        { label: name },
      ]}
    />
  );
  if (query.isPending)
    return <PageSkeleton template="record" label="package" />;
  if (query.isError || !data) {
    const missing =
      query.error &&
      typeof query.error === "object" &&
      "status" in query.error &&
      (query.error as { status: number }).status === 404;
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={crumbs}
          title={missing ? "Package not found" : name}
        />
        {missing ? (
          <EmptyState
            kind="not-found"
            title={`No ${ECOSYSTEM_LABELS[eco]} package ${name}`}
            description="Its manifest no longer declares it, or the link is wrong."
            primaryAction={
              <Button asChild variant="outline">
                <Link to={feedHref(scope, eco)}>
                  All {ECOSYSTEM_LABELS[eco]} packages
                </Link>
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            context={{ area: "distribution", thing: "Package" }}
          />
        )}
      </div>
    );
  }
  const latest = data.versions.find((v) => v.state !== "yanked");
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={crumbs}
        title={<span className="font-mono">{data.name}</span>}
        titleAside={
          latest ? (
            <StatusPill tone="neutral" icon={null}>
              {latest.version}
            </StatusPill>
          ) : undefined
        }
        description={
          scope.kind === "platform" ? (
            <>
              {data.ownerName}{" "}
              <span className="font-mono text-xs">{data.owner}</span>
            </>
          ) : (
            `${ECOSYSTEM_LABELS[eco]} package`
          )
        }
        meta={
          <span className="font-mono text-xs text-fg-muted">
            {data.deliverableId}
          </span>
        }
        tabs={
          <PageTabs
            label="Package"
            value={current}
            items={PACKAGE_TABS.map((t) => ({
              value: t,
              label: TAB_LABELS[t],
              to: packageHref(scope, eco, owner, name, t),
              ...(t === "versions" ? { count: data.versions.length } : {}),
            }))}
          />
        }
        refetching={query.isFetching}
        sticky
      />
      {current === "versions" ? (
        <VersionsTab scope={scope} eco={eco} data={data} />
      ) : current === "setup" ? (
        <PackageSetup scope={scope} eco={eco} data={data} />
      ) : (
        <ActivityTab
          scope={scope}
          eco={eco}
          emptyTitle="No activity on this package yet"
          filter={(t) =>
            t !== null &&
            t.kind === "package" &&
            t.id.startsWith(`${eco}:${data.name}@`)
          }
        />
      )}
    </div>
  );
}

const STATE_PILL: Record<
  FeedPackageVersion["state"],
  { tone: "success" | "danger" | "warning"; label: string }
> = {
  live: { tone: "success", label: "Live" },
  yanked: { tone: "danger", label: "Yanked" },
  deprecated: { tone: "warning", label: "Deprecated" },
};

function sourceLine(v: FeedPackageVersion): React.ReactNode {
  const s = v.source;
  if (s.kind === "oidc")
    return (
      <>
        Trusted publisher{s.publisher ? ` ${s.publisher}` : ""}
        {s.runUrl ? (
          <>
            {" · "}
            <a
              href={s.runUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent-fg underline-offset-4 hover:underline"
            >
              run
            </a>
          </>
        ) : null}
      </>
    );
  if (s.kind === "static")
    return (
      <>
        CI token
        {s.tokenId ? <span className="font-mono"> {s.tokenId}</span> : null}
      </>
    );
  if (s.kind === "console") return "The console";
  return "Unknown source";
}

function versionColumns(): DataColumn<FeedPackageVersion>[] {
  return [
    {
      id: "version",
      header: "Version",
      accessorFn: (v) => v.version,
      meta: { priority: 1, mono: true, primary: true, label: "Version" },
    },
    {
      id: "tags",
      header: "Tags",
      accessorFn: (v) => v.tags.join(" "),
      enableSorting: false,
      meta: { priority: 2, label: "Tags" },
      cell: ({ row }) =>
        row.original.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {row.original.tags.map((t) => (
              <StatusPill key={t} tone="neutral" icon={null} size="sm">
                {t}
              </StatusPill>
            ))}
          </span>
        ) : null,
    },
    {
      id: "published",
      header: "Published",
      accessorFn: (v) => v.publishedAt,
      meta: { priority: 1, label: "Published" },
      cell: ({ row }) => (
        <span className="flex flex-col gap-0.5">
          <Timestamp at={fromSeconds(row.original.publishedAt)} />
          <span className="text-xs text-fg-muted">
            {sourceLine(row.original)}
          </span>
        </span>
      ),
    },
    {
      id: "size",
      header: "Size",
      accessorFn: (v) => v.size,
      meta: { priority: 2, numeric: true, label: "Size" },
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {formatBytes(row.original.size)}
        </span>
      ),
    },
    {
      id: "integrity",
      header: "Integrity",
      accessorFn: (v) => v.files[0]?.sha256 ?? "",
      enableSorting: false,
      meta: { priority: 3, label: "Integrity" },
      cell: ({ row }) => <Digests version={row.original} />,
    },
    {
      id: "state",
      header: "Status",
      accessorFn: (v) => v.state,
      meta: { priority: 1, label: "Status" },
      cell: ({ row }) => {
        const pill = STATE_PILL[row.original.state];
        return (
          <span className="flex flex-col items-start gap-0.5">
            <StatusPill tone={pill.tone} size="sm">
              {pill.label}
            </StatusPill>
            {row.original.stateMessage ? (
              <span className="text-xs text-fg-muted">
                {row.original.stateMessage}
              </span>
            ) : null}
          </span>
        );
      },
    },
  ];
}

/** Each file's digests, one per line, middle-truncated (the full value in a tooltip), each
 *  copyable; a digest never wraps inside the narrow column. */
function Digests({
  version,
}: {
  version: FeedPackageVersion;
}): React.ReactElement {
  return (
    <ul className="space-y-1">
      {version.files.map((f) => (
        <li key={f.name} className="text-xs">
          <span className="font-mono text-fg-muted">{f.name}</span>
          <span className="flex flex-col">
            {(
              [
                ["sha256", f.sha256],
                ["sha512", f.sha512],
                ["sha1", f.sha1],
                ["md5", f.md5],
              ] as [string, string | undefined][]
            )
              .filter((d): d is [string, string] => Boolean(d[1]))
              .map(([alg, value]) => (
                <span
                  key={alg}
                  className="inline-flex items-center gap-0.5 whitespace-nowrap"
                >
                  <span className="font-mono" title={`${alg} ${value}`}>
                    {alg} {truncateMiddle(value, 8, 6)}
                  </span>
                  <CopyButton
                    value={value}
                    label={`Copy the ${alg} of ${f.name}`}
                    size="xs"
                  />
                </span>
              ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface PendingAction {
  verb: FeedVersionVerb;
  version: string;
}

const VERB_ACTION: Record<FeedVersionVerb, ActionId> = {
  yank: "package.yank",
  unyank: "package.unyank",
  deprecate: "package.deprecate",
  undeprecate: "package.undeprecate",
};

function VersionsTab({
  scope,
  eco,
  data,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  data: FeedPackageDto;
}): React.ReactElement {
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const columns = React.useMemo(() => versionColumns(), []);
  const caps = data.capabilities;
  const actions = (v: FeedPackageVersion): RowActionItem[] => {
    const items: RowActionItem[] = [];
    if (caps.deprecate && v.state === "live")
      items.push({
        label: "Deprecate…",
        onSelect: () => setPending({ verb: "deprecate", version: v.version }),
      });
    if (caps.deprecate && v.state === "deprecated")
      items.push({
        label: "Lift deprecation…",
        onSelect: () => setPending({ verb: "undeprecate", version: v.version }),
      });
    if (caps.yank && v.state === "yanked")
      items.push({
        label: "Unyank…",
        onSelect: () => setPending({ verb: "unyank", version: v.version }),
      });
    if (caps.yank && v.state !== "yanked") {
      if (items.length) items.push({ type: "separator" });
      items.push({
        label: "Yank…",
        tone: "danger",
        onSelect: () => setPending({ verb: "yank", version: v.version }),
      });
    }
    return items;
  };
  return (
    <>
      <DataTable<FeedPackageVersion>
        id="feed-package-versions"
        caption={`Versions of ${data.name}`}
        data={data.versions}
        columns={columns}
        getRowId={(v) => v.version}
        rowLabel={(v) => v.version}
        rowActions={caps.yank || caps.deprecate ? actions : undefined}
        exportCsv={false}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No versions published yet"
            description="A version appears here when CI publishes it with pkey release publish. Versions are never deleted: a yanked number cannot be published again."
          />
        }
      />
      {pending ? (
        <VersionDialog
          key={`${pending.verb}:${pending.version}`}
          scope={scope}
          eco={eco}
          data={data}
          pending={pending}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}

function VersionDialog({
  scope,
  eco,
  data,
  pending,
  onClose,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  data: FeedPackageDto;
  pending: PendingAction;
  onClose: () => void;
}): React.ReactElement {
  const [text, setText] = React.useState("");
  const { verb, version } = pending;
  const label = `${data.name} ${version}`;
  const needsText = verb === "yank" || verb === "deprecate";
  const copy: Record<
    FeedVersionVerb,
    { title: string; consequences: string[]; confirm: string; done: string }
  > = {
    yank: {
      title: `Yank ${label}?`,
      consequences: [
        YANK_EFFECTS[eco],
        "The version number stays taken: it can never be published again.",
      ],
      confirm: `Yank ${version}`,
      done: `${label} yanked`,
    },
    unyank: {
      title: `Unyank ${label}?`,
      consequences: [
        "The version is offered to clients again, as before the yank.",
      ],
      confirm: `Unyank ${version}`,
      done: `${label} unyanked`,
    },
    deprecate: {
      title: `Deprecate ${label}?`,
      consequences: [
        "The version stays installable; npm prints your message on every install.",
      ],
      confirm: `Deprecate ${version}`,
      done: `${label} deprecated`,
    },
    undeprecate: {
      title: `Lift the deprecation of ${label}?`,
      consequences: ["npm stops printing the deprecation message."],
      confirm: "Lift deprecation",
      done: `${label} is no longer deprecated`,
    },
  };
  const c = copy[verb];
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      intent={intentOf(VERB_ACTION[verb])}
      title={c.title}
      consequences={c.consequences}
      confirmLabel={c.confirm}
      confirmDisabled={needsText && text.trim() === ""}
      describeError={(e) =>
        errorCopy(e, { area: "distribution", thing: "Package" })
      }
      onConfirm={async () => {
        await mutate(
          "feedVersionAction",
          scope,
          eco,
          data.owner,
          data.name,
          version,
          verb,
          verb === "yank"
            ? { reason: text.trim() }
            : verb === "deprecate"
              ? { message: text.trim() }
              : {},
        );
        toast.success(c.done);
      }}
    >
      {needsText ? (
        <FormField<string>
          name={verb === "yank" ? "reason" : "message"}
          label={verb === "yank" ? "Reason" : "Message"}
          help={
            verb === "yank"
              ? "Recorded with the yank; PyPI shows it to pip and uv."
              : "What npm prints on install, like: use 2.x instead."
          }
          value={text}
          onChange={setText}
        >
          {(field) => <Textarea {...field} rows={2} maxLength={500} />}
        </FormField>
      ) : null}
    </ConfirmDialog>
  );
}

function PackageSetup({
  scope,
  eco,
  data,
}: {
  scope: FeedScope;
  eco: FeedEcosystem;
  data: FeedPackageDto;
}): React.ReactElement {
  const detail = useFeedDetail(scope, eco);
  if (!data.baseUrl)
    return (
      <EmptyState
        kind="first-run"
        title="No registry URL"
        description="This deployment has no registry host (PKG_ORIGIN), so the package has no address to give clients."
      />
    );
  const latest = data.versions.find((v) => v.state !== "yanked");
  // Platform scope may show another owner's package: its namespace is not the platform feed's.
  const namespace =
    scope.kind === "product" || data.owner === detail.data?.owner
      ? (detail.data?.settings.namespace ?? {})
      : {};
  const snippets = setupSnippets(eco, {
    baseUrl: data.baseUrl,
    owner: data.owner,
    namespace,
    pkg: { name: data.name, version: latest?.version ?? null },
  });
  return (
    <div className="space-y-4">
      {snippets.map((s) => (
        <section key={s.title} className="space-y-2">
          <h2 className="text-sm font-bold text-fg-strong">{s.title}</h2>
          {s.description ? (
            <p className="text-sm text-fg-muted">{s.description}</p>
          ) : null}
          <CodeBlock
            code={s.code}
            language={s.language}
            filename={s.filename}
            copy
          />
        </section>
      ))}
    </div>
  );
}
