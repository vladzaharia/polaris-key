/**
 * The Members model (ST-31.11; moved to access/ for ST-31.14, shared by Platform and Product members): one table of members and invites, who may change what
 * (mirroring the Worker's grant rules so the console never offers what it would refuse; the Worker
 * decides), and how an error from a write reads. Pure: no React, no fetch.
 */

import {
  HttpError,
  type AreaId,
  type GrantBody,
  type Me,
  type Member,
  type MemberInvite,
  type MemberRole,
  type MembersView,
} from "../../api.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { AREA_NAMES, listOf } from "./can.js";

/** One table row: a person with a role, or an address with an invite. */
export type MemberRow =
  | { kind: "member"; id: string; member: Member }
  | { kind: "invite"; id: string; invite: MemberInvite };

/** Members first (the Worker sorts them by name), then the invites, newest first. */
export function rowsOf(
  view: Pick<MembersView, "members" | "invites"> | undefined,
): MemberRow[] {
  if (!view) return [];
  return [
    ...view.members.map(
      (member): MemberRow => ({ kind: "member", id: member.memberId, member }),
    ),
    ...[...view.invites]
      .sort((a, b) => b.sentAt - a.sentAt)
      .map(
        (invite): MemberRow => ({
          kind: "invite",
          id: invite.bindingId,
          invite,
        }),
      ),
  ];
}

/** A role that is only Console access hides beside any other: every role implies it. */
export function visibleRoles<R extends Pick<MemberRole, "role">>(
  roles: readonly R[],
): R[] {
  const others = roles.filter((r) => r.role !== "console_access");
  return others.length > 0 ? others : [...roles];
}

export function initialsOf(name: string, email: string): string {
  const words = (name || email).split(/[\s@._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? words[1]![0]! : "";
  return (first + second).toUpperCase();
}

/** The product a role names (`product:<slug>`), else `null`. */
export function productOfScope(scope: string): string | null {
  return scope.startsWith("product:") ? scope.slice("product:".length) : null;
}

// ── who may do what ─────────────────────────────────────────────────────────────────────────

/** The roles the signed-in member holds. Without `/me.permissions` a platform admin is every role. */
export function viewerRoles(me: Me | undefined): MemberRole[] | "everything" {
  if (!me) return [];
  if (me.permissions) return me.permissions.roles as unknown as MemberRole[];
  return me.platformAdmin ? "everything" : [];
}

export function isSuperadmin(me: Me | undefined): boolean {
  const roles = viewerRoles(me);
  return roles === "everything" || roles.some((r) => r.role === "superadmin");
}

export type RoleChoice =
  | "console_access"
  | "product_admin"
  | "all_products"
  | "platform_admin"
  | "superadmin";

export const SUPERADMIN_ONLY: readonly RoleChoice[] = [
  "all_products",
  "platform_admin",
  "superadmin",
];

/** An L2 grant (a typed word, and `confirm: "L2"` on the wire). */
export const isL2 = (c: RoleChoice): boolean => SUPERADMIN_ONLY.includes(c);

export interface RoleDraft {
  choice: RoleChoice;
  /** The product slug for `product_admin`. */
  product: string;
  areaMode: "all" | "some";
  areas: AreaId[];
}

export const EMPTY_DRAFT: RoleDraft = {
  choice: "console_access",
  product: "",
  areaMode: "all",
  areas: [],
};

/** The eleven areas a Product admin can hold on a product, in the Worker's order. */
export const PRODUCT_AREAS: readonly AreaId[] = [
  "core",
  "license",
  "config",
  "ship",
  "signin",
  "sync",
  "commerce",
  "keys",
  "settings",
  "connect",
  "members",
];

export function grantOf(d: RoleDraft): GrantBody | null {
  switch (d.choice) {
    case "console_access":
      return { role: "console_access", scope: "platform", areas: null };
    case "platform_admin":
      return {
        role: "platform_admin",
        scope: "platform",
        areas: null,
        confirm: "L2",
      };
    case "superadmin":
      return {
        role: "superadmin",
        scope: "platform",
        areas: null,
        confirm: "L2",
      };
    case "all_products":
      return {
        role: "product_admin",
        scope: "products:*",
        areas: null,
        confirm: "L2",
      };
    case "product_admin": {
      if (!d.product) return null;
      if (d.areaMode === "some" && d.areas.length === 0) return null;
      return {
        role: "product_admin",
        scope: `product:${d.product}`,
        areas: d.areaMode === "all" ? null : orderAreas(d.areas),
      };
    }
  }
}

const orderAreas = (a: readonly AreaId[]): AreaId[] =>
  PRODUCT_AREAS.filter((x) => a.includes(x));

/**
 * Why the signed-in member cannot give this role, else `undefined`. Mirrors the Worker's G1 to G3:
 * the platform roles and All products only by a Superadmin; Console access by a Platform admin;
 * a product's admin only by someone who administers that product with the same areas.
 */
export function cannotGive(
  me: Me | undefined,
  choice: RoleChoice,
  product = "",
  areas: readonly AreaId[] | null = null,
): string | undefined {
  const roles = viewerRoles(me);
  if (roles === "everything" || roles.some((r) => r.role === "superadmin"))
    return undefined;
  if (SUPERADMIN_ONLY.includes(choice))
    return "Only a Superadmin can give this role.";
  if (choice === "console_access")
    return roles.some((r) => r.role === "platform_admin")
      ? undefined
      : "Only a Platform admin or a Superadmin can give Console access.";
  const held = roles.filter(
    (r) =>
      r.role === "product_admin" &&
      (r.scope === "products:*" || r.scope === `product:${product}`),
  );
  const covers = (a: AreaId): boolean =>
    held.some((r) => r.areas === null || r.areas.includes(a));
  const ok =
    product !== "" &&
    covers("members") &&
    (areas === null ? held.some((r) => r.areas === null) : areas.every(covers));
  return ok
    ? undefined
    : "You can give Product admin only on products you administer, with the areas you hold.";
}

/**
 * Why the signed-in member cannot take this role back, else `undefined` (G2, D-c, B1). Says what
 * it takes to remove it (not to give it), for the role named.
 */
export function cannotTake(
  me: Me | undefined,
  role: MemberRole,
  productName: (slug: string) => string = (s) => s,
  verb: "remove" | "revoke" | "sign out" = "remove",
): string | undefined {
  if (role.bindingId === null)
    return "This comes from the root rule. It can't be removed here.";
  const choice: RoleChoice =
    role.role === "product_admin"
      ? role.scope === "products:*"
        ? "all_products"
        : "product_admin"
      : role.role;
  const slug = productOfScope(role.scope) ?? "";
  if (cannotGive(me, choice, slug, role.areas) === undefined) return undefined;
  if (choice === "console_access")
    return `Only a Platform admin or a Superadmin can ${verb} Console access.`;
  if (choice === "product_admin") {
    const product = productName(slug);
    return `Only a Superadmin or an admin of ${product} with Members can ${verb} ${product} admin.`;
  }
  const word = {
    all_products: "All products admin",
    platform_admin: "Platform admin",
    superadmin: "Superadmin",
  }[choice as "all_products" | "platform_admin" | "superadmin"];
  return `Only a Superadmin can ${verb} ${word}.`;
}

/** Why the signed-in member cannot change this Product admin's areas, else `undefined`. */
export function cannotEditAreas(
  me: Me | undefined,
  role: MemberRole,
  productName: (slug: string) => string,
): string | undefined {
  if (role.bindingId === null) return cannotTake(me, role, productName);
  const slug = productOfScope(role.scope) ?? "";
  if (cannotGive(me, "product_admin", slug, role.areas) === undefined)
    return undefined;
  const product = productName(slug);
  return `Only a Superadmin or an admin of ${product} with Members can change the areas of ${product} admin.`;
}

/** The roles of a member the signed-in one can take back; `why` is the first refusal, if any. */
export function removable(
  me: Me | undefined,
  member: Member,
  productName: (slug: string) => string,
): { roles: MemberRole[]; why: string | undefined } {
  const held = member.roles.filter((r) => r.bindingId !== null);
  let why: string | undefined;
  for (const r of held) {
    why = cannotTake(me, r, productName);
    if (why) break;
  }
  return { roles: held, why };
}

// ── errors ──────────────────────────────────────────────────────────────────────────────────

const REASONS: Record<string, { title: string; description: string }> = {
  invite_budget: {
    title: "Too many invitations",
    description: "You've sent a lot of invitations recently. Try again later.",
  },
  self_grant: {
    title: "You can't give yourself access",
    description: "Ask another Superadmin.",
  },
  grant_refused: {
    title: "You can't give this access",
    description: "Pick a role you are allowed to give.",
  },
  exists: {
    title: "They already have this role",
    description: "Nothing was changed.",
  },
  too_many_emails: {
    title: "Too many addresses",
    description: "Invite up to 20 people at a time.",
  },
  account_session_required: {
    title: "Sign in again",
    description: "This session can't change who has access.",
  },
  confirm_required: {
    title: "Confirmation needed",
    description: "Type the role's name to confirm.",
  },
};

/** What an error from a Members write says; anything else is `errorCopy`'s. */
export function describeMembersError(e: unknown): {
  title: string;
  description?: string;
  action?: string;
  details?: Record<string, unknown>;
} {
  if (e instanceof HttpError && e.reason && REASONS[e.reason])
    return REASONS[e.reason]!;
  return errorCopy(e, { thing: "Members" });
}

/** "Ship builds and Commerce" for an area list. */
export const areaWords = (areas: readonly AreaId[]): string =>
  listOf(areas.map((a) => AREA_NAMES[a]));

/**
 * Why the signed-in member cannot change or remove this person's role on a product, said once for
 * the row: when they hold Members there, the real cause is an area the person has and they lack.
 */
export function cannotChangeProductRole(
  me: Me | undefined,
  who: string,
  role: MemberRole,
  slug: string,
  productName: (slug: string) => string,
): string | undefined {
  if (role.bindingId === null)
    return "This comes from a rule. It can't be changed here.";
  const generic = cannotEditAreas(me, role, productName);
  if (generic === undefined) return undefined;
  if (cannotGive(me, "product_admin", slug, ["members"]) === undefined) {
    const unheld = (role.areas ?? PRODUCT_AREAS).filter(
      (a) => cannotGive(me, "product_admin", slug, [a]) !== undefined,
    );
    if (unheld.length > 0)
      return role.areas === null
        ? `${who} has every area of ${productName(slug)}, and you hold only some. Ask a Superadmin.`
        : `${who} has ${areaWords(unheld)}, which you don't hold. Ask a Superadmin.`;
  }
  return generic;
}
