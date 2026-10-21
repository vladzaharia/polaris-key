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
  role,
  label,
}: {
  admins: AccessAdmin[];
  meEmail: string | undefined;
  role: (a: AccessAdmin) => React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <table className="w-full text-left" aria-label={label}>
      <thead className="max-sm:sr-only">
        <tr className="border-b border-border bg-surface-sunken text-sm text-fg-strong">
          <th scope="col" className="w-3/5 px-5 py-2.5 font-medium">
            Member
          </th>
          <th scope="col" className="px-5 py-2.5 font-medium">
            Role
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {admins.map((a) => (
          <tr key={a.email} className="max-sm:block max-sm:px-5 max-sm:py-3">
            <td className="px-5 py-3 max-sm:block max-sm:p-0 max-sm:pb-2">
              <Person admin={a} you={a.email === meEmail} />
            </td>
            <td className="px-5 py-3 max-sm:block max-sm:p-0">{role(a)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
            <Rows
              label="Admins"
              admins={admins}
              meEmail={me.data?.email}
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
            label="Platform roles"
            admins={platform}
            meEmail={me.data?.email}
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
