import * as React from "react";
import { AlertTriangle, KeyRound } from "lucide-react";
import type { DelegationDto } from "../../api.js";
import { api } from "../../api.js";
import { useResource } from "../../context.js";
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
  type ColumnDef,
} from "../../components/ui/index.js";
import { absoluteTime } from "../format.js";

/**
 * The Release section's "Content keys" table (P4-19, plans/P4-19.md §6.3, decision 11): every
 * delegation CI minted, so an operator can see who may publish data-only packs and where — its
 * scope, types, `seq`, signing window, status, the release key that signed it, the delegated key's
 * fingerprint, how many releases it signed and its revocation. Read-only: minting
 * (`pkey release delegate`) and revoking (`pkey release revoke --delegation`) are CI acts, never
 * console ones, so the Worker never holds the power to grant publishing.
 */
export function ContentKeys({ slug }: { slug: string }): React.ReactElement {
  const list = useResource(`delegations:${slug}`, () => api.delegations(slug));
  const rows = list.data?.delegations ?? [];
  const columns: ColumnDef<DelegationDto>[] = [
    {
      id: "scope",
      header: "Scope",
      accessor: (d) => d.scope,
      sortable: true,
      cell: (d) => <span className="font-mono text-xs">{d.scope}.*</span>,
    },
    {
      id: "types",
      header: "Types",
      cell: (d) => (
        <span className="inline-flex flex-wrap gap-1">
          {d.effectiveTypes.map((t) => (
            <Badge key={t} variant="outline">
              <span className="font-mono">{t}</span>
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: "seq",
      header: "Seq",
      accessor: (d) => d.seq,
      sortable: true,
      cell: (d) => <span className="font-mono text-xs">{d.seq}</span>,
    },
    {
      id: "window",
      header: "Signing window",
      cell: (d) => (
        <span className="text-xs">
          {absoluteTime(d.issuedAt)} – {absoluteTime(d.expiresAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (d) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge
            variant={
              d.status === "active"
                ? "primary"
                : d.status === "revoked"
                  ? "destructive"
                  : "outline"
            }
          >
            {d.status}
          </Badge>
          {d.revocation?.reason ? (
            <span
              className="text-xs text-muted-foreground"
              title={`Revocation ${d.revocation.sha256}`}
            >
              {d.revocation.reason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "signedBy",
      header: "Signed by",
      cell: (d) => <span className="font-mono text-xs">{d.signedBy}</span>,
    },
    {
      id: "key",
      header: "Content key",
      cell: (d) => (
        <span className="font-mono text-xs" title={d.keyFingerprint}>
          {d.keyFingerprint.slice(0, 16)}…
        </span>
      ),
    },
    {
      id: "releases",
      header: "Releases",
      accessor: (d) => d.releaseCount,
      sortable: true,
      cell: (d) => <span className="text-xs">{d.releaseCount}</span>,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle>Content keys</CardTitle>
        </div>
        <CardDescription>
          Keys the release key delegated to publish data-only packs under a
          scope. Minting and revoking happen in CI, never here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {list.error && !list.data ? (
          <EmptyState
            icon={<AlertTriangle aria-hidden />}
            title="Couldn’t load the content keys"
            description={list.error}
            action={
              <Button variant="outline" onClick={list.reload}>
                Retry
              </Button>
            }
            className="rounded-none border-0"
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(d) => d.sha256}
            loading={list.loading && !list.data}
            empty={
              <EmptyState
                icon={<KeyRound aria-hidden />}
                title="No content keys"
                description="Only the release key publishes. Delegate a content key with pkey release delegate."
                className="rounded-none border-0"
              />
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
