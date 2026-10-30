/**
 * The pieces of Platform → Members → SSO rules that hold no state: the save error words, the
 * conversion-offer helpers, a rule's row and the read-only root rule (split from
 * `platformSsoRules.tsx`, ST-32.7).
 */

import * as React from "react";
import { Lock } from "lucide-react";
import {
  HttpError,
  type AccessOffer,
  type AccessRuleBody,
} from "../../../../api.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { MATCH_ICON, whenWords } from "../../../access/RuleEditor.js";
import { RoleTag, RoleTags } from "../../../access/RoleTag.js";
import {
  describeMembersError,
  PRODUCT_AREAS,
} from "../../../access/membersModel.js";

export function describeSave(e: unknown) {
  if (e instanceof HttpError && e.code === "step_up_required")
    return {
      title: "Sign in again",
      description: "This needs a sign-in from the last 5 minutes.",
    };
  if (e instanceof HttpError && e.reason === "version_conflict")
    return {
      title: "The rules changed",
      description: "Someone saved first. Reload the page and try again.",
    };
  if (e instanceof HttpError && e.reason === "offer_changed")
    return {
      title: "The group changed",
      description:
        "The product has a different admin group now. Review it below.",
    };
  if (e instanceof HttpError && e.reason === "no_such_offer")
    return {
      title: "That admin group is gone",
      description: "It was already mapped or dismissed.",
    };
  if (e instanceof HttpError && e.reason === "superadmin_only")
    return {
      title: "Only a Superadmin can change rules",
      description: "Ask one to make the change.",
    };
  if (e instanceof HttpError && e.status === 422 && e.message)
    return { title: "That rule isn't allowed", description: e.message };
  return describeMembersError(e);
}

/** The offer being accepted, when the editor is open for one. */
export function offerOf(e: unknown): AccessOffer | null {
  return e !== null && typeof e === "object" && "offer" in e
    ? (e as { offer: AccessOffer }).offer
    : null;
}

/** The rule an offer starts the editor from: its group, every area but Members. */
export function offerRule(
  offer: AccessOffer,
  connection: string,
): AccessRuleBody {
  return {
    when: { connection, group: offer.group },
    grant: {
      role: "product_admin",
      scope: `product:${offer.product}`,
      areas: PRODUCT_AREAS.filter((a) => a !== "members"),
    },
  };
}

export function askLine(superadmins: string[]): string {
  if (superadmins.length === 0) return "Ask a Superadmin to change a rule.";
  const [a, b, ...rest] = superadmins;
  const names = b
    ? `${a} or ${b}${rest.length ? ` (and ${rest.length} more)` : ""}`
    : a;
  return `Ask ${names} to change a rule.`;
}

export function RuleRow({
  rule,
  connection,
  productName,
  actions,
}: {
  rule: AccessRuleBody & { id: string };
  connection: string;
  productName: (slug: string) => string;
  actions: React.ReactNode;
}): React.ReactElement {
  const w = whenWords(rule.when);
  const kind =
    "group" in rule.when ? "group" : "domain" in rule.when ? "domain" : "claim";
  const Icon = MATCH_ICON[kind];
  const role = {
    role: rule.grant.role,
    scope: rule.grant.scope,
    areas: rule.grant.areas ?? null,
    source: "rule",
  };
  return (
    <li
      className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6"
      data-rule-id={rule.id}
    >
      <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm text-fg-strong [overflow-wrap:anywhere]">
            {w.kind} <code className="font-mono text-xs">{w.value}</code>
          </div>
          <div className="text-xs text-fg-muted [overflow-wrap:anywhere]">
            From {connection}
            {"domain" in rule.when ? " · verified and enforced" : ""}
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-[1_1_14rem]">
        <RoleTags roles={[role]} productName={productName} />
      </div>
      {actions ? <div className="ms-auto flex gap-1">{actions}</div> : null}
    </li>
  );
}

export function RootRule({
  group,
  people,
  loading,
}: {
  group: string | null;
  people: number;
  loading: boolean;
}): React.ReactElement {
  return (
    <section
      aria-labelledby="sso-root-title"
      className="rounded-lg border border-border bg-surface-raised px-4 py-4 sm:px-6"
      data-root-rule=""
    >
      <h2
        id="sso-root-title"
        className="text-base font-semibold text-fg-strong"
      >
        Root rule
      </h2>
      <p className="mt-0.5 text-xs text-fg-muted">
        Set at deploy time by{" "}
        <code className="font-mono">PLATFORM_ADMIN_GROUP</code>
      </p>
      {loading ? (
        <Skeleton className="mt-3 h-10 w-full" />
      ) : group ? (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 text-sm text-fg-strong">
            <span>
              Group <code className="font-mono text-xs">{group}</code>
            </span>
            <Lock
              className="size-3.5 text-fg-muted"
              role="img"
              aria-label="Locked: set at deploy time"
            />
          </div>
          <RoleTag
            role={{ role: "superadmin", scope: "platform", areas: null }}
            productName={(s) => s}
          />
          <p className="text-xs text-fg-muted">
            {people} {people === 1 ? "person" : "people"}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-fg-muted">No group is set.</p>
      )}
    </section>
  );
}
