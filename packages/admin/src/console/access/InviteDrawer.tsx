/**
 * The Invite drawer and Edit roles (ST-31.12; mockup `admin.invite`). One drawer, two modes:
 *
 * - **Invite**: email chips, one role, a product and areas, a live sentence, the facts, one button.
 * - **Edit roles** (a member): their roles, with Edit areas and Remove, and "Add a role" and "Edit
 *   areas" as views of the same drawer.
 *
 * A write the Worker refuses for a stale sign-in (403 `step_up_required`) turns the footer into
 * "Sign in again". The sign-in leaves the page, so the draft (the addresses, the role, the product,
 * the areas, the typed word, the member and the view) waits in `sessionStorage` under one key, the
 * way `ConfirmDialog` keeps a dialog's fields (15 minutes, this page, removed when read). The page
 * mounts the drawer closed; one holding a saved state opens itself and puts it all back. The
 * addresses are kept nowhere else.
 */

import * as React from "react";
import { CircleAlert, Fingerprint } from "lucide-react";
import {
  ApiError,
  type AreaId,
  type InviteResult,
  type Me,
  type Member,
  type MemberRole,
} from "../../api.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog, isStepUpRequired } from "../../ui/ConfirmDialog.js";
import { CopyButton } from "../../ui/CopyButton.js";
import { CopyDetails } from "../../ui/CopyDetails.js";
import { Dialog, DialogBody, DialogFooter } from "../../ui/Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../ui/Drawer.js";
import { toast } from "../../ui/toast.js";
import { readStash, stashStepUp } from "../../ui/ConfirmDialog.js";
import { startStepUp } from "../../lib/stepUp.js";
import { formatDate, formatRelative } from "../../lib/format.js";
import { mutate } from "../data/mutations.js";
import {
  cannotGive,
  cannotTake,
  describeMembersError,
  EMPTY_DRAFT,
  grantOf,
  isL2,
  PRODUCT_AREAS,
  productOfScope,
  type RoleChoice,
  type RoleDraft,
} from "../sections/platform/pages/platformMembersModel.js";
import { AREA_NAMES, listOf, roleLabel } from "./can.js";
import {
  AreaChecks,
  EmailChips,
  giveableProducts,
  isEmail,
  MAX_INVITES,
  people,
  previewOf,
  RoleFields,
  splitEmails,
  useOfferedAreas,
  whoWords,
  WORD,
  type ProductName,
} from "./InviteDrawerParts.js";
import { RoleSet } from "./RoleTag.js";

/** The one stash key: only one drawer is open at a time. */
export const DRAWER_KEY = "members:drawer";

type View =
  | { kind: "list" }
  | { kind: "add" }
  | { kind: "areas"; bindingId: string };

const sourceText = (r: MemberRole): string => {
  if (r.source === "root") return "Root rule";
  if (r.source === "creator") return "Created the product";
  const by = r.grantedBy?.name;
  return `${r.source === "invite" ? "Invited" : "Added"}${by ? ` by ${by}` : ""}`;
};

const roleName = (r: MemberRole, productName: ProductName): string =>
  roleLabel({ ...r, source: "" }, productName).label;

export interface InviteDrawerProps {
  /** Whether the drawer is shown. */
  open: boolean;
  /** `null`: invite people; a member: edit that member's roles. */
  member: Member | null;
  /** The drawer found a saved sign-in return and asks the page to show it. */
  onReopen: (memberId: string | null) => void;
  onClose: () => void;
  me: Me | undefined;
  members: readonly Member[];
  products: readonly { slug: string; name: string }[];
  productName: ProductName;
  /** Why writes are off right now (read-only, no `members` edit), else `undefined`. */
  writeReason?: string | undefined;
}

export function InviteDrawer(props: InviteDrawerProps): React.ReactElement {
  const { open, member, onReopen, onClose, me, members, products } = props;
  const { productName, writeReason } = props;
  const editing = member !== null;

  const [tokens, setTokens] = React.useState<string[]>([]);
  const [text, setText] = React.useState("");
  const [draft, setDraft] = React.useState<RoleDraft>(EMPTY_DRAFT);
  const [typed, setTyped] = React.useState("");
  const [view, setView] = React.useState<View>({ kind: "list" });
  const [areas, setAreas] = React.useState<AreaId[]>([]);
  const [error, setError] = React.useState<unknown>(null);
  const [pending, setPending] = React.useState(false);
  const [links, setLinks] = React.useState<InviteResult | null>(null);
  const [removing, setRemoving] = React.useState<MemberRole | null>(null);
  const ids = React.useId();

  const name = member?.name || member?.email || "";
  const stepUp = isStepUpRequired(error);

  // The page came back from the sign-in: a saved drawer opens itself.
  React.useEffect(() => {
    if (open) return;
    const s = readStash(DRAWER_KEY, false);
    if (s) onReopen(s.fields.member ? s.fields.member : null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A fresh drawer every time it opens; a saved one comes back whole.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setError(null);
      setPending(false);
      const saved = readStash(DRAWER_KEY, true);
      const f = saved?.fields;
      const mine = f && (f.member ?? "") === (member?.memberId ?? "");
      if (saved && f && mine) {
        setTokens(splitEmails(f.emails ?? ""));
        setText(f.text ?? "");
        setDraft({
          choice: (f.choice as RoleChoice) || "console_access",
          product: f.product ?? "",
          areaMode: f.areaMode === "some" ? "some" : "all",
          areas: splitEmails(f.areas ?? "") as AreaId[],
        });
        setAreas(splitEmails(f.editAreas ?? "") as AreaId[]);
        setTyped(saved.typed);
        setView(
          f.view === "add"
            ? { kind: "add" }
            : f.view === "areas" && f.binding
              ? { kind: "areas", bindingId: f.binding }
              : { kind: "list" },
        );
      } else {
        setTokens([]);
        setText("");
        setDraft(EMPTY_DRAFT);
        setAreas([]);
        setTyped("");
        setView({ kind: "list" });
      }
    }
    wasOpen.current = open;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeDraft = (d: RoleDraft): void => {
    setDraft(d);
    setError(null);
  };

  // ── the addresses ────────────────────────────────────────────────────────────────────────
  const all = React.useMemo(() => {
    const pendingTokens = splitEmails(text);
    const seen = new Set(tokens.map((t) => t.toLowerCase()));
    return [
      ...tokens,
      ...pendingTokens.filter((t) => !seen.has(t.toLowerCase())),
    ];
  }, [tokens, text]);
  // Only finished chips are called wrong; what is still being typed is not.
  const invalid = tokens.filter((e) => !isEmail(e));
  const valid = all.filter(isEmail);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const existing = valid.filter((e) => byEmail.has(e.toLowerCase()));
  const tooMany = valid.length > MAX_INVITES;
  const emailProblem = tooMany
    ? `Invite up to ${MAX_INVITES} people at a time.`
    : invalid.length > 0
      ? `${invalid.join(", ")} ${invalid.length === 1 ? "isn't an email address, so it isn't" : "aren't email addresses, so they aren't"} counted.`
      : undefined;

  // ── what is being given ──────────────────────────────────────────────────────────────────
  const grant = grantOf(draft);
  const l2 = isL2(draft.choice);
  const slug = draft.choice === "product_admin" ? draft.product : "";
  const productLabel = slug ? productName(slug) : "";
  const { offered } = useOfferedAreas(slug);
  const draftOk =
    grant !== null &&
    cannotGive(
      me,
      draft.choice,
      draft.product,
      draft.choice === "product_admin" ? grant.areas : null,
    ) === undefined &&
    (draft.choice !== "product_admin" ||
      draft.areaMode === "all" ||
      draft.areas.some((a) => offered.includes(a)));
  const typedOk =
    !l2 || typed.trim().toLowerCase() === WORD[draft.choice].toLowerCase();
  const areaWords = listOf(
    PRODUCT_AREAS.filter((a) => draft.areas.includes(a)).map(
      (a) => AREA_NAMES[a],
    ),
  );
  const roleText =
    draft.choice === "product_admin" && slug
      ? `${productLabel} admin`
      : WORD[draft.choice];

  // ── the areas view ───────────────────────────────────────────────────────────────────────
  const areaRole =
    view.kind === "areas"
      ? (member?.roles.find((r) => r.bindingId === view.bindingId) ?? null)
      : null;
  const areaSlug = areaRole ? (productOfScope(areaRole.scope) ?? "") : "";
  const areaOffer = useOfferedAreas(areaSlug).offered;
  React.useEffect(() => {
    if (view.kind === "areas" && areaRole && areas.length === 0)
      setAreas([...(areaRole.areas ?? PRODUCT_AREAS)]);
  }, [view.kind, areaRole?.bindingId]); // eslint-disable-line react-hooks/exhaustive-deps
  const areasAll = areas.length === PRODUCT_AREAS.length;
  const areasWhy = areaRole
    ? cannotGive(me, "product_admin", areaSlug, areasAll ? null : areas)
    : undefined;

  // ── the footer's one action ──────────────────────────────────────────────────────────────
  let ready = false;
  let label = "";
  let why: string | undefined;
  if (!editing) {
    const adding = valid.length - existing.length;
    ready =
      valid.length > 0 && !tooMany &&
      draftOk &&
      typedOk;
    label =
      valid.length === 0
        ? "Invite people"
        : existing.length === 0
          ? `Invite ${people(valid.length)}`
          : adding === 0
            ? `Add the role to ${people(existing.length)}`
            : `Invite ${people(adding)} and update ${existing.length}`;
    why = valid.length === 0 ? "Add an email address" : undefined;
  } else if (view.kind === "add") {
    ready = draftOk && typedOk;
    label = "Add role";
  } else if (view.kind === "areas") {
    ready = areas.length > 0 && areasWhy === undefined;
    label = "Save areas";
    why = areas.length === 0 ? "Pick at least one area" : areasWhy;
  }
  if (!ready && !why && l2 && !typedOk)
    why = `Type ${WORD[draft.choice]} to confirm`;
  if (!ready && !why && !draftOk && (!editing || view.kind === "add"))
    why =
      draft.choice === "product_admin" && !draft.product
        ? "Choose a product"
        : undefined;

  const dirty = !editing
    ? tokens.length > 0 || text.trim() !== "" || draft !== EMPTY_DRAFT
    : view.kind !== "list";

  const save = async (): Promise<void> => {
    if (pending) return;
    if (stepUp) {
      stashStepUp(DRAWER_KEY, typed, {
        member: member?.memberId ?? "",
        view: view.kind,
        binding: view.kind === "areas" ? view.bindingId : "",
        emails: tokens.join(","),
        text,
        choice: draft.choice,
        product: draft.product,
        areaMode: draft.areaMode,
        areas: draft.areas.join(","),
        editAreas: areas.join(","),
      });
      startStepUp();
      return;
    }
    if (!ready) return;
    setError(null);
    setPending(true);
    try {
      if (!editing) await sendInvites();
      else if (view.kind === "add") {
        await mutate("grantRole", { ...grant!, member: member!.memberId });
        toast.success(`Gave ${name} ${roleText}`);
        setView({ kind: "list" });
        setDraft(EMPTY_DRAFT);
        setTyped("");
      } else if (view.kind === "areas") {
        await mutate("editBindingAreas", view.bindingId, {
          areas: areasAll
            ? null
            : PRODUCT_AREAS.filter((a) => areas.includes(a)),
        });
        toast.success("Areas saved");
        setView({ kind: "list" });
        setAreas([]);
      }
      setPending(false);
    } catch (e) {
      setPending(false);
      setError(e ?? new Error("Something went wrong. Try again."));
    }
  };

  const sendInvites = async (): Promise<void> => {
    const result = await mutate("inviteMembers", { ...grant!, emails: valid });
    const invited = result.results.filter((r) => r.status === "invited");
    const updated = result.results.filter((r) => r.status === "updated");
    const undoIds = (rs: typeof invited): string[] =>
      rs.flatMap((r) => (r.bindingId ? [r.bindingId] : []));
    const ids = [...undoIds(invited), ...undoIds(updated)];
    const skipped = result.counts.exists;
    const unsent = result.emailOff ? [] : result.results.filter((r) => r.link);
    const head =
      invited.length + updated.length === 0
        ? "Nobody new to invite"
        : updated.length === 0
          ? `Invited ${people(invited.length)}`
          : invited.length === 0
            ? `Updated ${people(updated.length)}`
            : `Invited ${people(invited.length)} and updated ${updated.length}`;
    toast.success(head, {
      description:
        [
          skipped > 0 ? `${skipped} already had this role.` : "",
          unsent.length > 0
            ? `${unsent.length === 1 ? "1 email" : `${unsent.length} emails`} didn't go out.`
            : "",
          !result.emailOff && result.notified.nobodyNotified
            ? "Nobody was notified."
            : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
      ...(ids.length > 0
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                void (async () => {
                  let undone = 0;
                  try {
                    for (const id of ids) {
                      await mutate("revokeBinding", id);
                      undone += 1;
                    }
                    toast.success(
                      updated.length === 0
                        ? "Invitations withdrawn"
                        : invited.length === 0
                          ? "Roles taken back"
                          : "Invitations withdrawn and roles taken back",
                    );
                  } catch {
                    toast.error(`Took back ${undone} of ${ids.length}`, {
                      context: { thing: "the invitations" },
                    });
                  }
                })();
              },
            },
          }
        : {}),
    });
    if (result.results.some((r) => r.link)) setLinks(result);
    onClose();
  };

  // ── the head ─────────────────────────────────────────────────────────────────────────────
  const title = !editing
    ? "Invite people"
    : view.kind === "add"
      ? `Add a role for ${name}`
      : view.kind === "areas"
        ? `Areas for ${name}`
        : `Edit roles for ${name}`;
  const base = areaRole ? roleName(areaRole, productName) : "";
  const err = error && !stepUp ? describeMembersError(error) : null;
  const errorId = `${ids}-err`;
  const emailsId = `${ids}-emails`;
  const hintId = `${ids}-hint`;
  const showFooterAction = !editing || view.kind !== "list";
  const takenOut = member?.roles ?? [];

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => {
          if (!o) {
            setError(null);
            onClose();
          }
        }}
        title={title}
        description={
          editing && view.kind === "list"
            ? "Roles add up. Console access comes with every other role."
            : editing && view.kind === "areas" && base
              ? base
              : undefined
        }
        unsaved={dirty && !pending}
        dismissible={!pending}
        closeStyle="close-narrow"
      >
        <DrawerBody className="space-y-5">
          {!editing ? (
            <>
              <div className="space-y-1.5">
                <label
                  htmlFor={emailsId}
                  className="block text-sm font-medium text-fg-strong"
                >
                  Email addresses
                </label>
                <EmailChips
                  tokens={tokens}
                  onTokens={(t) => {
                    setTokens(t);
                    setError(null);
                  }}
                  text={text}
                  onText={setText}
                  members={members}
                  inputId={emailsId}
                  describedBy={hintId}
                  invalid={emailProblem !== undefined}
                  disabled={pending}
                />
                <p
                  id={hintId}
                  role={emailProblem ? "alert" : undefined}
                  className={
                    emailProblem
                      ? "text-sm text-danger"
                      : "text-sm text-fg-muted"
                  }
                >
                  {emailProblem ??
                    "Separate addresses with commas, spaces or new lines."}
                </p>
                {existing.map((e) => {
                  const m = byEmail.get(e.toLowerCase())!;
                  return (
                    <p key={e} className="text-sm text-fg-muted">
                      {m.name || m.email} is already a member.
                      {grant ? ` Adds ${roleText}.` : ""}
                    </p>
                  );
                })}
              </div>
              <RoleFields
                draft={draft}
                onChange={changeDraft}
                me={me}
                products={products}
                disabled={pending}
                idPrefix={`${ids}-i`}
              />
            </>
          ) : view.kind === "list" ? (
            <ul className="divide-y divide-border">
              {takenOut.map((r, i) => {
                const rwhy = cannotTake(me, r, productName);
                const narrowable =
                  r.role === "product_admin" &&
                  r.scope.startsWith("product:") &&
                  r.bindingId !== null;
                const rn = roleName(r, productName);
                return (
                  <li
                    key={r.bindingId ?? `root-${i}`}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <RoleSet role={r} productName={productName} />
                      <p className="text-xs text-fg-muted">{sourceText(r)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {narrowable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={rwhy !== undefined || !!writeReason}
                          disabledReason={writeReason ?? rwhy}
                          onClick={() => {
                            setAreas([...(r.areas ?? PRODUCT_AREAS)]);
                            setError(null);
                            setView({ kind: "areas", bindingId: r.bindingId! });
                          }}
                          aria-label={`Edit areas of ${rn}`}
                        >
                          Edit areas
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rwhy !== undefined || !!writeReason}
                        disabledReason={writeReason ?? rwhy}
                        onClick={() => setRemoving(r)}
                        aria-label={`Remove ${rn}`}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : view.kind === "add" ? (
            <RoleFields
              draft={draft}
              onChange={changeDraft}
              me={me}
              products={products}
              held={takenOut}
              name={name}
              disabled={pending}
              idPrefix={`${ids}-a`}
            />
          ) : areaRole ? (
            <fieldset className="space-y-2" disabled={pending}>
              <legend className="sr-only">Areas</legend>
              <AreaChecks
                me={me}
                slug={areaSlug}
                offered={areaOffer}
                areas={areas}
                onChange={(a) => {
                  setAreas(a);
                  setError(null);
                }}
                legend="Pick the areas"
              />
              <p className="text-xs text-fg-muted">
                Taking areas away is immediate. Giving more needs a recent
                sign-in.
              </p>
            </fieldset>
          ) : null}

          {showFooterAction && (!editing || view.kind === "add") ? (
            <p className="text-sm text-fg" aria-live="polite">
              {previewOf(
                !editing ? whoWords(valid, "They") : name,
                draft,
                productLabel,
                areaWords,
              )}
            </p>
          ) : null}

          {l2 && showFooterAction && (!editing || view.kind === "add") ? (
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-word`} className="block text-sm text-fg">
                Type the role to confirm{" "}
                <code className="rounded-xs bg-surface-sunken px-1 font-mono text-xs text-fg-strong">
                  {WORD[draft.choice]}
                </code>
              </label>
              <input
                id={`${ids}-word`}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void save();
                  }
                }}
                className="h-9 pointer-coarse:h-11 w-full rounded-md border border-border-strong bg-surface-sunken px-3 font-mono text-sm text-fg focus-visible:outline-2 focus-visible:outline-focus"
              />
            </div>
          ) : null}

          {showFooterAction && view.kind !== "areas" ? (
            <ul className="space-y-0.5 text-sm text-fg-muted">
              {!editing ? (
                <li>Expires {formatDate(Date.now() + 7 * 86_400_000)}</li>
              ) : null}
              <li>Every Superadmin is told</li>
            </ul>
          ) : null}

          {err ? (
            <div
              id={errorId}
              role="alert"
              className="flex gap-2 rounded-md border border-danger-border bg-danger-subtle p-3"
            >
              <CircleAlert
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-danger"
              />
              <div className="space-y-0.5">
                <p className="font-semibold text-fg-strong">{err.title}</p>
                {err.description ? (
                  <p className="text-fg">{err.description}</p>
                ) : null}
                <CopyDetails copy={err} />
              </div>
            </div>
          ) : null}
          {stepUp ? (
            <div
              id={errorId}
              role="status"
              className="flex gap-2 rounded-md border border-border bg-surface-sunken p-3"
            >
              <Fingerprint
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-fg-muted"
              />
              <div className="space-y-0.5">
                <p className="font-semibold text-fg-strong">
                  Sign in again to confirm it&apos;s you
                </p>
                {typeof me?.authAt === "number" ? (
                  <p className="text-fg">
                    You signed in {formatRelative(me.authAt * 1000)}.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          {editing && view.kind !== "list" ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                setView({ kind: "list" });
              }}
            >
              Back to roles
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                onClose();
              }}
            >
              {editing ? "Close" : "Cancel"}
            </Button>
          )}
          {editing && view.kind === "list" ? (
            <Button
              variant="primary"
              disabled={member!.you || !!writeReason}
              disabledReason={
                writeReason ??
                (member!.you ? "You can't give yourself a role." : undefined)
              }
              onClick={() => {
                // The first role they can be given that adds something.
                const order: RoleChoice[] =
                  takenOut.length === 0
                    ? [
                        "console_access",
                        "product_admin",
                        "platform_admin",
                        "superadmin",
                      ]
                    : ["product_admin", "platform_admin", "superadmin"];
                const first: RoleChoice =
                  order.find((c) =>
                    c === "product_admin"
                      ? giveableProducts(me, products).length > 0
                      : cannotGive(me, c) === undefined,
                  ) ?? "product_admin";
                setDraft({ ...EMPTY_DRAFT, choice: first });
                setTyped("");
                setError(null);
                setView({ kind: "add" });
              }}
            >
              Add a role
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={pending}
              disabled={!stepUp && !ready}
              disabledReason={!stepUp && !ready ? why : undefined}
              aria-describedby={err || stepUp ? errorId : undefined}
              onClick={() => void save()}
            >
              {stepUp ? "Sign in again" : label}
            </Button>
          )}
        </DrawerFooter>
      </Drawer>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        intent="caution"
        title={`Remove ${removing ? roleName(removing, productName) : "role"} from ${name}?`}
        consequences={[
          "The role stops applying within 30 seconds.",
          "Every Superadmin is told.",
        ]}
        confirmLabel="Remove role"
        describeError={describeMembersError}
        onConfirm={async () => {
          try {
            await mutate("revokeBinding", removing!.bindingId!);
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
          toast.success("Role removed");
        }}
      />
      <InviteLinksDialog result={links} onClose={() => setLinks(null)} />
    </>
  );
}

/**
 * The Worker returns a sign-in link for an address it did not email: every address with email
 * off, or the ones whose send failed.
 */
export function InviteLinksDialog({
  result,
  onClose,
}: {
  result: InviteResult | null;
  onClose: () => void;
}): React.ReactElement {
  const rows = (result?.results ?? []).filter((r) => r.link);
  const off = result?.emailOff ?? false;
  const unsent = rows.length;
  return (
    <Dialog
      open={result !== null}
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={
        off
          ? "Send these links"
          : `${unsent === 1 ? "1 email" : `${unsent} emails`} didn't go out. Send ${unsent === 1 ? "this link" : "these links"}`
      }
      description={
        off
          ? "Email is off, so nobody was emailed. Each link opens the console sign-in for that address."
          : `No email reached ${rows.map((r) => r.email).join(", ")}. Each link opens the console sign-in for that address.`
      }
    >
      <DialogBody className="space-y-3 text-sm">
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.email} className="space-y-1">
              <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                {r.email}
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xs bg-surface-sunken px-2 py-1 font-mono text-xs">
                  {r.link}
                </code>
                <CopyButton
                  value={r.link!}
                  label={`Copy link for ${r.email}`}
                />
              </div>
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
