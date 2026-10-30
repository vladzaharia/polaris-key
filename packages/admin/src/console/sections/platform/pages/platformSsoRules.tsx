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
import { Plus } from "lucide-react";
import {
  HttpError,
  type AccessOffer,
  type AccessRuleBody,
  type Me,
  type MembersView,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { readStash } from "../../../../lib/stepUp.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { confirmBlocked, NEEDS_REASON } from "../../../../ui/confirmReasons.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { RuleEditor } from "../../../access/RuleEditor.js";
import { mutate } from "../../../data/mutations.js";
import { platformReads } from "../data.js";
import { OffersCard } from "./platformSsoOffers.js";
import {
  askLine,
  describeSave,
  offerOf,
  offerRule,
  RootRule,
  RuleRow,
} from "./platformSsoParts.js";

const CONFIRM_KEY = "SSO rules";

/** The list a pending save would store, and what it is. */
interface Pending {
  rules: AccessRuleBody[];
  title: string;
  confirmLabel: string;
  lead: string;
  /** Danger is for removing a rule only; adding or saving access is caution. */
  intent?: "caution" | "danger";
  /** Set when the save accepts a conversion offer: the one rule, written by the offers route. */
  offer?: AccessOffer;
  /** The stored version the list was built from; sent as `expectedVersion`, also after a step-up. */
  baseVersion?: number;
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
  const offersQ = useQuery({ ...platformReads.accessOffers(), retry: false });
  const [editing, setEditing] = React.useState<
    AccessRuleBody | "new" | { offer: AccessOffer } | null
  >(null);
  const [accepted, setAccepted] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [pending, setPending] = React.useState<Pending | null>(null);
  // The offers route refused: the group moved or the offer went. Said at the card.
  const [offerNote, setOfferNote] = React.useState<{
    title: string;
    text: string;
  } | null>(null);
  // Where focus goes when the editor closes, and after a dismissal.
  const trigger = React.useRef<HTMLElement | null>(null);
  const afterDismiss = React.useRef<string | null | undefined>(undefined);
  // A saved step-up that was never reopened must not pop up later in the visit.
  React.useEffect(() => () => void readStash(CONFIRM_KEY, true), []);
  const openEditor = (e: AccessRuleBody | "new" | { offer: AccessOffer }) => {
    trigger.current = document.activeElement as HTMLElement | null;
    setOfferNote(null);
    setEditing(e);
  };
  React.useEffect(() => {
    if (editing !== null || !trigger.current) return;
    const t = trigger.current;
    trigger.current = null;
    // After the dialog's own focus return has run.
    const id = setTimeout(() => {
      (t.isConnected && !t.hasAttribute("disabled")
        ? t
        : document.getElementById("sso-rules-title")
      )?.focus();
    }, 50);
    return () => clearTimeout(id);
  }, [editing]);
  const offerList = offersQ.data?.offers;
  const [focusTick, setFocusTick] = React.useState(0);
  React.useEffect(() => {
    if (afterDismiss.current === undefined) return;
    const next = afterDismiss.current;
    const id = setTimeout(() => {
      const row = next
        ? Array.from(document.querySelectorAll<HTMLElement>("[data-offer]"))
            .find((el) => el.dataset.offer === next)
            ?.querySelector("button")
        : null;
      (row ?? document.getElementById("sso-rules-title"))?.focus();
      afterDismiss.current = undefined;
    }, 50);
    return () => clearTimeout(id);
  }, [focusTick]);
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

  const editingOffer = offerOf(editing);
  const store = (rules: AccessRuleBody[], p: Omit<Pending, "rules">): void => {
    setReason("");
    setPending({ rules, baseVersion: view?.version, ...p });
  };
  const saveRule = (rule: AccessRuleBody): void => {
    const offer = offerOf(editing);
    if (offer) {
      store([rule], {
        title: `Add a rule for ${offer.name}'s admin group?`,
        confirmLabel: "Add rule",
        lead: `People in ${offer.group} become ${offer.name} admins at their next sign-in.`,
        offer,
      });
      return;
    }
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
        intent: "danger",
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
            baseVersion: view.version,
            title: "Save sign-in rules?",
            confirmLabel: "Save rules",
            lead: "",
          });
      }}
      intent={pending?.intent ?? "caution"}
      title={pending?.title ?? "Save sign-in rules?"}
      stepUpKey={CONFIRM_KEY}
      stepUpState={{
        reason,
        rules: JSON.stringify(pending?.rules ?? []),
        offer: JSON.stringify(pending?.offer ?? null),
        baseVersion: String(pending?.baseVersion ?? ""),
        title: pending?.title ?? "",
        confirmLabel: pending?.confirmLabel ?? "",
        lead: pending?.lead ?? "",
        intent: pending?.intent ?? "caution",
      }}
      onRestore={(s) => {
        setReason(s.reason ?? "");
        try {
          const rules = JSON.parse(s.rules ?? "[]") as AccessRuleBody[];
          const offer = JSON.parse(s.offer ?? "null") as AccessOffer | null;
          setPending({
            title: s.title || "Save sign-in rules?",
            confirmLabel: s.confirmLabel || "Save rules",
            lead: s.lead ?? "",
            intent: s.intent === "danger" ? "danger" : "caution",
            rules,
            ...(Number.isInteger(Number(s.baseVersion)) && s.baseVersion
              ? { baseVersion: Number(s.baseVersion) }
              : {}),
            ...(offer ? { offer } : {}),
          });
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
        if (pending.offer) {
          const offer = pending.offer;
          const rule = pending.rules[0];
          if (!rule) return;
          try {
            const r = await mutate("decideAccessOffer", offer.product, {
              action: "accept",
              group: offer.group,
              connection: rule.when.connection,
              areas: rule.grant.areas ?? [],
              ...(rule.label ? { label: rule.label } : {}),
              reason: reason.trim(),
              confirm: "console.access",
            });
            setEditing(null);
            setReason("");
            setAccepted((a) => new Set(a).add(offer.product));
            toast.success("Rule added", {
              description:
                r.notified && r.notified.of > 0
                  ? `${r.notified.sent} of ${r.notified.of} Superadmins emailed.`
                  : undefined,
            });
          } catch (e) {
            // The group moved or the offer went: say so at the card, re-read, and close the
            // dialog, so no confirm is left that would send the stale group again.
            if (
              e instanceof HttpError &&
              (e.reason === "offer_changed" || e.reason === "no_such_offer")
            ) {
              const d = describeSave(e);
              setOfferNote({ title: d.title, text: d.description ?? "" });
              setEditing(null);
              setReason("");
              void offersQ.refetch();
              return;
            }
            throw e;
          }
          return;
        }
        const r = await mutate("replaceAccessRules", {
          rules: pending.rules,
          expectedVersion: pending.baseVersion ?? view.version,
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
        {offerNote ? (
          <Callout tone="warning" alert title={offerNote.title}>
            {offerNote.text}
          </Callout>
        ) : null}
        <OffersCard
          offers={offerList ?? []}
          canDecide={canEdit}
          readOnlyNote={askLine(superadmins)}
          noConnection={(view?.connections.length ?? 1) === 0}
          editing={editing !== null}
          accepted={accepted}
          onAccept={(offer) => openEditor({ offer })}
          onDismissed={(next) => {
            afterDismiss.current = next;
            setFocusTick((n) => n + 1);
          }}
        />
        <section
          aria-labelledby="sso-rules-title"
          className="rounded-lg border border-border bg-surface-raised"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
            <div>
              <h2
                id="sso-rules-title"
                tabIndex={-1}
                className="text-base font-semibold text-fg-strong outline-none"
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
                onClick={() => openEditor("new")}
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
                          onClick={() => openEditor(rule)}
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
            key={
              editing === "new"
                ? "new"
                : editingOffer
                  ? `offer:${editingOffer.product}`
                  : (editing as AccessRuleBody).id
            }
            connections={view.connections}
            products={products}
            me={me}
            initial={
              editing === "new"
                ? null
                : editingOffer
                  ? offerRule(editingOffer, view.connections[0]?.id ?? "")
                  : (editing as AccessRuleBody)
            }
            {...(editingOffer
              ? {
                  title: `Map ${editingOffer.group} to ${editingOffer.name} admin`,
                  lockMatch: true,
                  saveLabel: "Add rule…",
                }
              : {})}
            onCancel={() => setEditing(null)}
            onSave={saveRule}
          />
        ) : null}
      </div>
      <RootRule group={group} people={rootPeople} loading={!roster} />
      {view ? dialog : null}
    </div>
  );
}
