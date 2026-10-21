/**
 * Settings → Members (ST-08, admin.product-members): who can administer this product, read from
 * the access list (`GET /access/admins`, ST-29). The admins and the platform roles are two
 * tables; the Invite drawer, per-area roles and row menus are ST-31's.
 */

import * as React from "react";
import { Crown } from "lucide-react";
import type { AccessAdmin } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { useAccessAdmins } from "../../../access/useCan.js";
import { useMe } from "../../../data/hooks.js";
import { SettingsSection } from "../../../templates/Settings.js";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0]! : "")
  ).toUpperCase();
}

function Person({
  admin,
  you,
}: {
  admin: AccessAdmin;
  you: boolean;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "inline-grid size-9 shrink-0 place-items-center rounded-full border border-border bg-surface-sunken text-xs font-medium text-fg-strong",
        )}
      >
        {initials(admin.name)}
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-fg-strong">
          {admin.name}
          {you ? (
            <span className="text-xs font-normal text-fg-muted">You</span>
          ) : null}
        </p>
        <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
          {admin.email}
        </p>
      </div>
    </div>
  );
}

function Rows({
  admins,
  meEmail,
  columns,
  role,
}: {
  admins: AccessAdmin[];
  meEmail: string | undefined;
  columns: string;
  role: (a: AccessAdmin) => React.ReactNode;
}): React.ReactElement {
  return (
    <ul className="divide-y divide-border">
      {admins.map((a) => (
        <li
          key={a.email}
          className={cn("grid items-center gap-x-6 gap-y-2 px-5 py-3", columns)}
        >
          <Person admin={a} you={a.email === meEmail} />
          <div>{role(a)}</div>
        </li>
      ))}
    </ul>
  );
}

export function SettingsMembersPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const q = useAccessAdmins("core", slug);
  const me = useMe();
  useLoadingAnnouncement("members", q.isPending);
  const admins = q.data?.admins.filter((a) => a.role !== "superadmin") ?? [];
  const platform = q.data?.admins.filter((a) => a.role === "superadmin") ?? [];
  const columns = "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]";
  if (q.isPending)
    return (
      <SettingsSection id="members-admins" title="Admins">
        <div className="space-y-3 p-5" aria-busy="true">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </SettingsSection>
    );
  if (q.isError)
    return (
      <SettingsSection id="members-admins" title="Admins">
        <div className="p-5">
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            compact
          />
        </div>
      </SettingsSection>
    );
  return (
    <div className="space-y-6" data-template="members">
      <SettingsSection id="members-admins" title="Admins">
        {admins.length === 0 ? (
          <EmptyState
            kind="first-run"
            variant="inline"
            title="No product admins"
            description="Superadmins below can still administer this product."
          />
        ) : (
          <>
            <div
              aria-hidden
              className={cn(
                "hidden gap-x-6 border-b border-border bg-surface-sunken px-5 py-2.5 text-sm font-medium text-fg-strong sm:grid",
                columns,
              )}
            >
              <span>Member</span>
              <span>Role</span>
            </div>
            <Rows
              admins={admins}
              meEmail={me.data?.email}
              columns={columns}
              role={() => (
                <StatusPill tone="neutral" icon={false} size="sm">
                  Product admin
                </StatusPill>
              )}
            />
          </>
        )}
      </SettingsSection>
      {platform.length > 0 ? (
        <SettingsSection
          id="members-platform"
          title="Platform roles"
          description="Read-only here."
        >
          <Rows
            admins={platform}
            meEmail={me.data?.email}
            columns={columns}
            role={() => (
              <StatusPill tone="neutral" icon={Crown} size="sm">
                Superadmin
              </StatusPill>
            )}
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}
