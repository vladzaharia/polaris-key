import * as React from "react";
import type { DelegationDto } from "../../../api.js";
import { docsUrl } from "../../../lib/docsLinks.js";
import {
  formatDate,
  formatRelative,
  fromSeconds,
} from "../../../lib/format.js";
import type { Tone } from "../../../lib/status.js";
import { useLoadingAnnouncement } from "../../../ui/loading.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { Hash } from "../../../ui/Hash.js";
import { SignedBadge } from "../../../ui/SignedBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Link } from "../../router.js";
import { productPage } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { useDelegations } from "./data.js";

/**
 * Release → Content keys (ADMIN.md §2.3, T2; DLV-5, CKY-1 to CKY-3): every key CI delegated to
 * publish data-only packs under a scope. Read-only: delegating and revoking are CI acts
 * (`pkey release delegate`, `pkey release revoke --delegation`), never console ones, so the Worker
 * never holds the power to grant publishing.
 */

const STATUS: Record<DelegationDto["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
  revoked: { label: "Revoked", tone: "danger" },
};

const ORIGIN: Record<DelegationDto["origin"], string> = {
  submit: "Published by CI",
  revocation: "Learned from a revocation",
};

/** "Expires in 12 days" / "Expired 3 days ago", with the dates beside it (CKY-2). */
function SigningWindow({
  d,
  now,
}: {
  d: DelegationDto;
  now: number;
}): React.ReactElement {
  const expires = fromSeconds(d.expiresAt);
  const issued = fromSeconds(d.issuedAt);
  const past = expires <= now;
  return (
    <span className="flex flex-col">
      <span className={past ? "text-fg-muted" : "text-fg"}>
        {past ? "Expired " : "Expires "}
        {formatRelative(expires, now)}
      </span>
      <span className="text-xs text-fg-muted">
        {formatDate(issued)} – {formatDate(expires)}
      </span>
    </span>
  );
}

export function ContentKeysPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const query = useDelegations(slug);
  const [state, setState] = useTableUrlState("content-keys", {
    facets: ["status"],
  });
  useLoadingAnnouncement("content keys", query.isPending);
  const rows = query.data?.delegations ?? [];
  const now = Date.now();

  const columns: DataColumn<DelegationDto>[] = [
    {
      id: "scope",
      header: "Scope",
      accessorKey: "scope",
      meta: { priority: 1, primary: true, label: "Scope", alwaysVisible: true },
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.scope}.*</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessorKey: "status",
      meta: { priority: 1, label: "Status" },
      cell: ({ row }) => {
        const d = row.original;
        const s = STATUS[d.status] ?? { label: d.status, tone: "neutral" };
        return (
          <span className="flex flex-col items-start gap-0.5">
            <StatusPill tone={s.tone}>{s.label}</StatusPill>
            {d.revocation ? (
              <span className="text-xs text-fg-muted">
                {d.revocation.reason ?? "No reason given"}
                {d.revocation.kid ? (
                  <>
                    {" · by "}
                    <span className="font-mono">{d.revocation.kid}</span>
                  </>
                ) : null}
                {d.revocation.issuedAt
                  ? ` · ${formatDate(fromSeconds(d.revocation.issuedAt))}`
                  : null}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "types",
      header: "Pack types",
      accessorFn: (d) => d.effectiveTypes.join(" "),
      meta: { priority: 2, label: "Pack types" },
      cell: ({ row }) => {
        const d = row.original;
        const narrowed =
          d.types.length !== d.effectiveTypes.length ||
          d.types.some((t) => !d.effectiveTypes.includes(t));
        return (
          <span className="flex flex-col items-start gap-0.5">
            <span className="inline-flex flex-wrap gap-1">
              {d.effectiveTypes.map((t) => (
                <span
                  key={t}
                  className="rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-xs"
                >
                  {t}
                </span>
              ))}
            </span>
            {narrowed ? (
              <span className="text-xs text-fg-muted">
                Delegated: {d.types.length ? d.types.join(", ") : "any type"}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "window",
      header: "Signing window",
      accessorFn: (d) => d.expiresAt,
      meta: { priority: 2, label: "Signing window" },
      cell: ({ row }) => <SigningWindow d={row.original} now={now} />,
    },
    {
      id: "signedBy",
      header: "Signed by",
      accessorKey: "signedBy",
      // Priority 3: hidden by default under 1440 px (every delegation is signed by the release
      // key, so it is the column a laptop can spare). With it shown the table's min-content
      // width left 1.5 px of slack at 1280 px, which whole-pixel glyph advances overran.
      meta: { priority: 3, label: "Signed by" },
      cell: ({ row }) => (
        <SignedBadge kid={row.original.signedBy} by="the release key" />
      ),
    },
    {
      id: "key",
      header: "Content key",
      accessorKey: "keyFingerprint",
      enableSorting: false,
      meta: { priority: 2, label: "Content key" },
      cell: ({ row }) => (
        <Hash
          value={row.original.keyFingerprint}
          label="key fingerprint"
          className="whitespace-nowrap"
        />
      ),
    },
    {
      id: "releases",
      header: "Releases",
      accessorKey: "releaseCount",
      meta: { priority: 2, numeric: true, label: "Releases" },
      cell: ({ row }) =>
        row.original.releaseCount ? (
          <Link
            to={productPage(slug, "deliverables", {
              query: { q: row.original.scope },
            })}
            className="text-accent-fg underline-offset-4 hover:underline"
          >
            {row.original.releaseCount}
            <span className="sr-only">
              {" "}
              releases signed under {row.original.scope}.*
            </span>
          </Link>
        ) : (
          "0"
        ),
    },
    {
      id: "seq",
      header: "Seq",
      accessorKey: "seq",
      meta: {
        priority: 3,
        numeric: true,
        mono: true,
        label: "Seq",
        defaultHidden: true,
      },
    },
    {
      id: "origin",
      header: "Origin",
      accessorKey: "origin",
      meta: { priority: 3, label: "Origin", defaultHidden: true },
      cell: ({ row }) => ORIGIN[row.original.origin] ?? row.original.origin,
    },
  ];

  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Content keys"
          titleAside={
            query.data ? (
              <span className="text-sm tabular-nums text-fg-muted">
                {rows.length}
              </span>
            ) : null
          }
          description="CI delegates and revokes these keys; this page only reads them."
          refetching={query.isFetching && !query.isPending}
        />
      }
    >
      <DataTable<DelegationDto>
        id="content-keys"
        caption="Content keys"
        data={rows}
        columns={columns}
        getRowId={(d) => d.sha256}
        rowLabel={(d) => `${d.scope}.*`}
        state={state}
        onStateChange={setState}
        search={{ placeholder: "Search scopes", columns: ["scope", "types"] }}
        facets={[
          {
            id: "status",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "closed", label: "Closed" },
              { value: "revoked", label: "Revoked" },
            ],
          },
        ]}
        pagination={{ mode: "client" }}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        mobile="cards"
        empty={
          <EmptyState
            kind="first-run"
            title="No content keys"
            description="Only the release key publishes. Delegate a content key from CI with pkey release delegate to let a team publish data-only packs under a scope."
            docs={docsUrl("packDeliverables")}
          />
        }
      />
    </CollectionTemplate>
  );
}
