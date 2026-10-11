/**
 * Settings → Members (ST-08): who can administer this product, read from the access list
 * (`GET /access/admins`, ST-29). Roles, invites and removal are ST-31's; this hosts the area.
 */

import * as React from "react";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { useAccessAdmins } from "../../../access/useCan.js";
import { SettingsSection } from "../../../templates/Settings.js";

const ROLE = { superadmin: "Superadmin", product_admin: "Product admin" };

export function SettingsMembersPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const q = useAccessAdmins("core", slug);
  useLoadingAnnouncement("members", q.isPending);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description="People who can administer this product."
        refetching={q.isFetching && !q.isPending}
      />
      <SettingsSection id="members-admins" title="Administrators">
        {q.isPending ? (
          <div className="space-y-3 p-5" aria-busy="true">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : q.isError ? (
          <div className="p-5">
            <ErrorState
              error={q.error}
              onRetry={() => void q.refetch()}
              compact
            />
          </div>
        ) : q.data.admins.length === 0 ? (
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No administrators found"
            description="Ask a superadmin to add one."
          />
        ) : (
          <ul className="divide-y divide-border">
            {q.data.admins.map((a) => (
              <li
                key={a.email}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-fg-strong">{a.name}</p>
                  <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                    {a.email}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-sm text-fg-muted">
                  {ROLE[a.role]}
                  <CopyButton value={a.email} label={`Copy ${a.email}`} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
