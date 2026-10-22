/**
 * RoleTag and RoleSet (ST-31.11; mockups `admin.members`, `admin.invite`, `admin.no-access`): how
 * a role reads wherever it appears. A tag is the role's name with its glyph (Superadmin a crown,
 * Platform admin a shield, a product's admin a package, All products admin layers, Console access
 * a key). A Product admin narrowed to areas is a set: the tag, then the areas outside it, each
 * with its service glyph, so the tag never wraps into a box on a phone.
 *
 * The names come from `roleLabel` (can.ts), the console's one spelling of a role.
 */

import * as React from "react";
import { Crown, KeyRound, Layers, Package, ShieldCheck } from "lucide-react";
import type { AreaId, MeRole } from "../../api.js";
import { cn } from "../../lib/cn.js";
import { ServiceGlyph } from "../../ui/ServiceBadge.js";
import { AREA_ACCENTS, AREA_NAMES, roleLabel } from "./can.js";

/** The subset of a role the tag draws. */
export type RoleLike = Pick<MeRole, "role" | "scope" | "areas">;

function Glyph({ role }: { role: RoleLike }): React.ReactElement {
  const cls = "size-3.5 shrink-0";
  switch (role.role) {
    case "superadmin":
      return <Crown className={cls} aria-hidden="true" />;
    case "platform_admin":
      return <ShieldCheck className={cls} aria-hidden="true" />;
    case "console_access":
      return <KeyRound className={cls} aria-hidden="true" />;
    case "product_admin":
      return role.scope.startsWith("product:") ? (
        <Package className={cls} aria-hidden="true" />
      ) : (
        <Layers className={cls} aria-hidden="true" />
      );
  }
}

export function RoleTag({
  role,
  productName,
  className,
}: {
  role: RoleLike;
  /** A product's name from its slug; the slug itself when unknown. */
  productName: (slug: string) => string;
  className?: string;
}): React.ReactElement {
  const { label } = roleLabel({ ...role, source: "" }, productName);
  return (
    <span
      data-role-tag={role.role}
      className={cn(
        "inline-flex max-w-[13rem] items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface-sunken px-2 py-0.5 text-xs font-medium text-fg-strong",
        className,
      )}
    >
      <Glyph role={role} />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </span>
  );
}

function AreaList({ areas }: { areas: readonly AreaId[] }): React.ReactElement {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
      {areas.map((a) => {
        const accent = AREA_ACCENTS[a];
        return (
          <span
            key={a}
            className="inline-flex items-center gap-1 whitespace-nowrap"
          >
            {accent ? <ServiceGlyph id={accent as "core"} size={16} /> : null}
            {AREA_NAMES[a]}
          </span>
        );
      })}
    </span>
  );
}

/** One role: the tag, and for a narrowed Product admin the areas beside it (below it on a phone). */
export function RoleSet({
  role,
  productName,
}: {
  role: RoleLike;
  productName: (slug: string) => string;
}): React.ReactElement {
  const areas = role.role === "product_admin" ? role.areas : null;
  return (
    <span
      data-role-set
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 max-sm:flex-col max-sm:items-start"
    >
      <RoleTag role={role} productName={productName} />
      {areas && areas.length > 0 ? <AreaList areas={areas} /> : null}
    </span>
  );
}

/** A member's roles, one set per role. A member with no stored role shows nothing. */
export function RoleTags({
  roles,
  productName,
}: {
  roles: readonly RoleLike[];
  productName: (slug: string) => string;
}): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 max-sm:flex-col max-sm:items-start">
      {roles.map((r, i) => (
        <RoleSet
          key={`${r.role}:${r.scope}:${i}`}
          role={r}
          productName={productName}
        />
      ))}
    </span>
  );
}
