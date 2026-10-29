/**
 * Platform → Members → SSO rules (`#/platform/members?tab=sso`, ST-32.7; mockup `admin.sso-rules`):
 * the rules that give people who sign in through a company identity provider access to the
 * console, and the read-only root rule beside them. Everyone with Members reads them; only a
 * Superadmin adds, edits or removes one (the Worker decides: `PUT /access/rules`).
 *
 * Every save, a removal included, is one write of the whole list, behind the typed confirmation,
 * a reason and a recent sign-in. The editor is `access/RuleEditor.tsx`; a person gets every rule
 * they match, so there is no order and no deny rule.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, Plus } from "lucide-react";
import {
  HttpError,
  type AccessRuleBody,
  type AccessRulesView,
  type Me,
  type MembersView,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { confirmBlocked, NEEDS_REASON } from "../../../../ui/confirmReasons.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import {
  MATCH_ICON,
  RuleEditor,
  whenWords,
} from "../../../access/RuleEditor.js";
import { RoleTag, RoleTags } from "../../../access/RoleTag.js";
import { describeMembersError } from "../../../access/membersModel.js";
import { mutate } from "../../../data/mutations.js";
import { platformReads } from "../data.js";

const CONFIRM_KEY = "SSO rules";

/** The list a pending save would store, and what it is. */
interface Pending {
  rules: AccessRuleBody[];
  title: string;
  confirmLabel: string;
  lead: string;
}

function describeSave(e: unknown) {
  if (e instanceof HttpError && e.reason === "version_conflict")
    return {
      title: "The rules changed",
      description: "Someone saved first. Reload the page and try again.",
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

export function PlatformSsoRules({
  roster,
  me,
  products,
  productName,
}: {
  roster: MembersView | undefined;
  me: Me | undefined;
  products: { slug: string; name: string }[];
  productName: (slug: string) => string;
}): React.ReactElement {
  const q = useQuery(platformReads.accessRules());
  const view = q.data;
  const [editing, setEditing] = React.useState<AccessRuleBody | "new" | null>(
    null,
  );
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [reason, setReason] = React.useState("");
  const canEdit = view?.editable === true && !view.unreadable;
  const group = roster?.rootRule.group ?? null;
  // Who can change a rule, for the read-only line.
  const superadmins = (roster?.members ?? [])
    .filter((m) => !m.disabled && m.roles.some((r) => r.role === "superadmin"))
    .map((m) => m.name || m.email);
  const rootPeople =
    roster?.members.filter((m) => m.roles.some((r) => r.bindingId === null))
      .length ?? 0;
  const connectionLabel = (id: string): string =>
    view?.connections.find((c) => c.id === id)?.label ?? id;

  const store = (rules: AccessRuleBody[], p: Omit<Pending, "rules">): void => {
    setReason("");
    setPending({ rules, ...p });
  };
  const saveRule = (rule: AccessRuleBody): void => {
    const list = view?.rules ?? [];
    const next = rule.id
      ? list.map((r) => (r.id === rule.id ? rule : r))
      : [...list, rule];
    store(next, {
      title: rule.id ? "Save this rule?" : "Add this rule?",
      confirmLabel: rule.id ? "Save rule" : "Add rule",
      lead: "People who match get this access at their next sign-in, people added to the group later too.",
    });
  };
  const removeRule = (rule: AccessRuleBody & { id: string }): void =>
    store(
      (view?.rules ?? []).filter((r) => r.id !== rule.id),
      {
        title: "Remove this rule?",
        confirmLabel: "Remove rule",
        lead: "People who only had access through it lose it at their next sign-in.",
      },
    );

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
        // The page came back from the sign-in: `onRestore` fills the list in.
        else if (!pending && view)
          setPending({
            rules: view.rules,
            title: "Save sign-in rules?",
            confirmLabel: "Save rules",
            lead: "",
          });
      }}
      intent="danger"
      title={pending?.title ?? "Save sign-in rules?"}
      stepUpKey={CONFIRM_KEY}
      stepUpState={{ reason, rules: JSON.stringify(pending?.rules ?? []) }}
      onRestore={(s) => {
        setReason(s.reason ?? "");
        try {
          const rules = JSON.parse(s.rules ?? "[]") as AccessRuleBody[];
          setPending((p) => ({
            title: p?.title ?? "Save sign-in rules?",
            confirmLabel: p?.confirmLabel ?? "Save rules",
            lead: p?.lead ?? "",
            rules,
          }));
        } catch {
          setPending(null);
        }
      }}
      signedInAt={me?.authAt}
      lead={
        pending?.lead ? <p className="text-sm">{pending.lead}</p> : undefined
      }
      consequences={[
        "A rule never gives Platform admin or Superadmin.",
        "Every Superadmin gets an email.",
      ]}
      confirmLabel={pending?.confirmLabel ?? "Save rules"}
      typedConfirmation={{
        value: "console.access",
        label: "Type to confirm",
      }}
      {...confirmBlocked([reason.trim() === "", NEEDS_REASON])}
      describeError={describeSave}
      onConfirm={async () => {
        if (!pending || !view) return;
        const r = await mutate("replaceAccessRules", {
          rules: pending.rules,
          expectedVersion: view.version,
          reason: reason.trim(),
          confirm: "console.access",
        });
        setEditing(null);
        setReason("");
        toast.success("Sign-in rules saved", {
          description:
            r.notified.of > 0
              ? `${r.notified.sent} of ${r.notified.of} Superadmins emailed.`
              : "No Superadmin could be emailed.",
        });
      }}
    >
      <div className="space-y-1 text-sm">
        <label className="block space-y-1">
          <span className="font-medium text-fg-strong">Reason</span>
          <Textarea
            value={reason}
            onValueChange={setReason}
            maxLength={500}
            rows={2}
            placeholder="Why this changes"
          />
        </label>
        <p className="text-xs text-fg-muted">
          Required. Kept in the activity log.
        </p>
      </div>
    </ConfirmDialog>
  );

  if (q.isError && !view)
    return (
      <ErrorState
        error={q.error}
        onRetry={() => void q.refetch()}
        thing="SSO rules"
        context={{ thing: "SSO rules" }}
      />
    );

  return (
    <div className="w-full max-w-[1280px] space-y-6" data-sso-tab="">
      <div className="min-w-0 space-y-6" data-sso-main="">
        {view?.unreadable ? (
          <Callout tone="warning" title="The stored rules can't be read">
            No rule is applied until a Superadmin fixes the setting.
          </Callout>
        ) : null}
        <section
          aria-labelledby="sso-rules-title"
          className="rounded-lg border border-border bg-surface-raised"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
            <div>
              <h2
                id="sso-rules-title"
                className="text-base font-semibold text-fg-strong"
              >
                Rules
              </h2>
              <p className="text-sm text-fg-muted">
                {view && !view.editable
                  ? askLine(superadmins)
                  : "A person gets every rule they match."}
              </p>
            </div>
            {canEdit && editing === null ? (
              <Button
                variant="primary"
                iconStart={<Plus className="size-4" aria-hidden="true" />}
                onClick={() => setEditing("new")}
              >
                Add rule
              </Button>
            ) : null}
          </div>
          {q.isPending ? (
            <div className="space-y-2 p-4 sm:px-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : view && view.rules.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-muted sm:px-6">
              No rules yet. Only the root rule and added members have access.
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="sso-rules">
              {(view?.rules ?? []).map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  connection={connectionLabel(rule.when.connection)}
                  productName={productName}
                  actions={
                    canEdit ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={editing !== null}
                          onClick={() => setEditing(rule)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={editing !== null}
                          onClick={() => removeRule(rule)}
                        >
                          Remove…
                        </Button>
                      </>
                    ) : null
                  }
                />
              ))}
            </ul>
          )}
        </section>
        {canEdit && view && editing !== null ? (
          <RuleEditor
            // A new editor per rule: its draft starts from that rule.
            key={editing === "new" ? "new" : editing.id}
            connections={view.connections}
            products={products}
            me={me}
            initial={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSave={saveRule}
          />
        ) : null}
      </div>
      <RootRule group={group} people={rootPeople} loading={!roster} />
      {dialog}
    </div>
  );
}

function askLine(superadmins: string[]): string {
  if (superadmins.length === 0) return "Ask a Superadmin to change a rule.";
  const [a, b, ...rest] = superadmins;
  const names = b
    ? `${a} or ${b}${rest.length ? ` (and ${rest.length} more)` : ""}`
    : a;
  return `Ask ${names} to change a rule.`;
}

function RuleRow({
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
            {w.kind} <code className="font-mono text-[0.9em]">{w.value}</code>
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

function RootRule({
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
              Group <code className="font-mono text-[0.9em]">{group}</code>
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
