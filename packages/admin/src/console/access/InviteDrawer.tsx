/**
 * The Invite drawer and Edit roles (ST-31.12; mockup `admin.invite`). One drawer, two modes:
 *
 * - **Invite**: email chips, one role, a product and areas. The sentence, the facts, any error and
 *   the primary sit in one footer band, so what will happen is always beside the button.
 * - **Edit roles** (a member): their roles with Edit areas and Remove, and "Add a role" and "Edit
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
  HttpError,
  type AreaId,
  type InviteResult,
  type Me,
  type Member,
  type MemberInvite,
  type MemberRole,
  type ProductPlatformRole,
} from "../../api.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog, isStepUpRequired } from "../../ui/ConfirmDialog.js";
import { readStash, stashStepUp } from "../../lib/stepUp.js";
import { CopyButton } from "../../ui/CopyButton.js";
import { CopyDetails } from "../../ui/CopyDetails.js";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DiscardStrip,
} from "../../ui/Dialog.js";
import { Drawer, DrawerBody } from "../../ui/Drawer.js";
import { toast } from "../../ui/toast.js";
import { startStepUp } from "../../lib/stepUp.js";
import { formatRelative, formatShort } from "../../lib/format.js";

import { mutate } from "../data/mutations.js";
import {
  cannotEditAreas,
  cannotGive,
  cannotTake,
  describeMembersError,
  EMPTY_DRAFT,
  grantOf,
  isL2,
  isSuperadmin,
  PRODUCT_AREAS,
  productOfScope,
  type RoleChoice,
  type RoleDraft,
} from "./membersModel.js";
import { AREA_NAMES, listOf, roleLabel } from "./can.js";
import {
  AreaPicker,
  EmailChips,
  ScopedRole,
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
import { useMe } from "../data/hooks.js";

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

/** "Sep 28", with the year only when it is not this year. */
export function expiresText(ms: number): string {
  return formatShort(ms);
}

const article = (label: string): string =>
  `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}`;

/** "Sam Okoye is now a Superadmin". */
function nowWords(name: string, role: string): string {
  return role === "Console access"
    ? `${name} now has Console access`
    : `${name} is now ${article(role)}`;
}

const areaWordsOf = (a: readonly AreaId[]): string =>
  listOf(PRODUCT_AREAS.filter((x) => a.includes(x)).map((x) => AREA_NAMES[x]));

const sameDraft = (a: RoleDraft, b: RoleDraft): boolean =>
  a.choice === b.choice &&
  a.product === b.product &&
  a.areaMode === b.areaMode &&
  a.areas.length === b.areas.length &&
  a.areas.every((x) => b.areas.includes(x));

/** Whether a member already holds what the draft would give. */
function holds(m: Member, g: ReturnType<typeof grantOf>): boolean {
  if (!g) return false;
  if (g.role === "console_access") return m.roles.length > 0;
  return m.roles.some(
    (r) =>
      r.role === g.role &&
      r.scope === g.scope &&
      (r.areas === null ||
        (g.areas !== null && g.areas.every((a) => r.areas!.includes(a)))),
  );
}

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
  /** Invitations waiting (their addresses get a note). */
  invites?: readonly MemberInvite[];
  products: readonly { slug: string; name: string }[];
  productName: ProductName;
  /** Why writes are off right now (read-only, no `members` edit), else `undefined`. */
  writeReason?: string | undefined;
  /**
   * Product → Settings → Members (ST-31.14): the drawer works on one product. The role is fixed to
   * Product admin of it, only the areas the caller holds are offered, and every write goes through
   * the product's own routes. `members` and `invites` are that product's.
   */
  productScope?: { slug: string; name: string };
  /** Scoped: who reaches the product from above, matched against the addresses typed. */
  platformRoles?: readonly ProductPlatformRole[];
  /** Scoped edit: open straight in the Edit areas view of the member's product role. */
  startView?: "areas";
}

type Undoable = { id: string; label: string; kind: "invited" | "updated" };

/** Take bindings back one by one; what could not be, with a Retry for just those. */
async function takeBack(
  items: Undoable[],
  done: string,
  revoke: (id: string) => Promise<unknown>,
): Promise<void> {
  const left: Undoable[] = [];
  for (const it of items) {
    try {
      await revoke(it.id);
    } catch (e) {
      // Already gone is the outcome we want.
      if (!(e instanceof HttpError && e.status === 404)) left.push(it);
    }
  }
  if (left.length === 0) {
    toast.success(done);
    return;
  }
  const open = left.filter((l) => l.kind === "invited").map((l) => l.label);
  const kept = left.filter((l) => l.kind === "updated").map((l) => l.label);
  toast.error(`Took back ${items.length - left.length} of ${items.length}`, {
    description: [
      open.length > 0
        ? `The invitation for ${listOf(open)} is still open.`
        : "",
      kept.length > 0 ? `${listOf(kept)} still has the role.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    action: {
      label: "Retry",
      onClick: () => void takeBack(left, done, revoke),
    },
  });
}

export function InviteDrawer(props: InviteDrawerProps): React.ReactElement {
  const { open, member, onReopen, onClose, me, members, products } = props;
  const { productName, writeReason, invites = [], productScope } = props;
  const editing = member !== null;
  const scoped = productScope !== undefined;
  // What a fresh invite starts as: scoped, Product admin of the one product, every area unless the
  // caller holds only some.
  const blank = React.useMemo<RoleDraft>(
    () =>
      productScope
        ? {
            choice: "product_admin",
            product: productScope.slug,
            areaMode:
              cannotGive(me, "product_admin", productScope.slug, null) ===
              undefined
                ? "all"
                : "some",
            areas: [],
          }
        : EMPTY_DRAFT,
    [productScope, me],
  );
  const revoke = (id: string): Promise<unknown> =>
    productScope
      ? mutate("revokeProductMember", productScope.slug, id)
      : mutate("revokeBinding", id);

  const [tokens, setTokens] = React.useState<string[]>([]);
  const [text, setText] = React.useState("");
  const [draft, setDraft] = React.useState<RoleDraft>(blank);
  const [typed, setTyped] = React.useState("");
  const [view, setView] = React.useState<View>({ kind: "list" });
  const [error, setError] = React.useState<unknown>(null);
  const [pending, setPending] = React.useState(false);
  const [links, setLinks] = React.useState<InviteResult | null>(null);
  const [removing, setRemoving] = React.useState<MemberRole | null>(null);
  const [askBack, setAskBack] = React.useState(false);
  // Confirmations while the drawer is open sit in it (a toast beside a modal cannot be reached).
  const [notice, setNotice] = React.useState<{
    text: string;
    undo?: () => void;
    retry?: () => void;
  } | null>(null);
  const ids = React.useId();
  // Whether the footer's notes overflow (at large text they do): then the region is focusable.
  const footScroll = React.useRef<HTMLDivElement>(null);
  const [footScrolls, setFootScrolls] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = footScroll.current;
    if (el) setFootScrolls(el.scrollHeight > el.clientHeight + 1);
  });
  const wordRef = React.useRef<HTMLInputElement>(null);

  // Who opened the drawer, so focus goes back there after the links dialog too.
  const opener = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const a = document.activeElement;
    opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
  }

  // Email on or off (a refused or failed read counts as on: the Worker says when a link is needed).
  const emailOn = useMe().data?.emailOn ?? true;

  const name = member?.name || member?.email || "";
  const stepUp = isStepUpRequired(error);

  // The page came back from the sign-in: a saved drawer opens itself.
  React.useEffect(() => {
    if (open) return;
    const s = readStash(DRAWER_KEY, false);
    if (s) onReopen(s.fields.member ? s.fields.member : null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A fresh drawer every time it opens; a saved one comes back whole.
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setError(null);
      setPending(false);
      setAskBack(false);
      setNotice(null);
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
          ...(productScope
            ? { choice: "product_admin" as const, product: productScope.slug }
            : {}),
        });
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
        setDraft(blank);
        setTyped("");
        setView({ kind: "list" });
        // Scoped edit from the row's Edit areas: straight into that view.
        const first =
          props.startView === "areas"
            ? member?.roles.find(
                (r) => r.role === "product_admin" && r.bindingId !== null,
              )
            : undefined;
        if (first) {
          setDraft(areasSeed(first));
          setView({ kind: "areas", bindingId: first.bindingId! });
          // The title, not the unchecked radio: Space there would switch the mode.
          window.setTimeout(
            () =>
              document
                .querySelector<HTMLElement>(
                  '[data-pk-overlay-header] [tabindex="-1"]',
                )
                ?.focus({ preventScroll: true }),
            60,
          );
        }
      }
    }
    wasOpen.current = open;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new view: say its title.
  const firstView = React.useRef(true);
  React.useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (!open) return;
    document
      .querySelector<HTMLElement>('[data-pk-overlay-header] [tabindex="-1"]')
      ?.focus({ preventScroll: true });
  }, [view.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeDraft = (d: RoleDraft): void => {
    setDraft(d);
    setError(null);
  };

  // ── the addresses ────────────────────────────────────────────────────────────────────────
  const all = React.useMemo(() => {
    const seen = new Set(tokens.map((t) => t.toLowerCase()));
    return [
      ...tokens,
      ...splitEmails(text).filter((t) => !seen.has(t.toLowerCase())),
    ];
  }, [tokens, text]);
  const selfEmail = (me?.email ?? "").toLowerCase();
  // Only finished chips are called wrong; what is still being typed is not.
  const invalid = tokens.filter((e) => !isEmail(e));
  const valid = all.filter(isEmail);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const wide = new Map(
    (props.platformRoles ?? []).map((p) => [p.email.toLowerCase(), p]),
  );
  const scopeName = productScope?.name ?? "";
  const waiting = new Map(invites.map((i) => [i.email.toLowerCase(), i]));
  const selfIn = valid.some((e) => e.toLowerCase() === selfEmail);
  const tooMany = valid.length > MAX_INVITES;

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

  // Who is sent: not you, and not anyone who already has it.
  const sendable = valid.filter((e) => {
    const k = e.toLowerCase();
    if (k === selfEmail) return false;
    // A Superadmin already manages every product: a binding would be redundant.
    if (wide.get(k)?.role === "superadmin") return false;
    const m = byEmail.get(k);
    return !(m && holds(m, grant));
  });
  const updating = sendable.filter(
    (e) => byEmail.has(e.toLowerCase()) || wide.has(e.toLowerCase()),
  ).length;
  const adding = sendable.length - updating;

  const problems: string[] = [];
  if (tooMany) problems.push(`Invite up to ${MAX_INVITES} people at a time.`);
  if (invalid.length > 0)
    problems.push(
      `${invalid.join(", ")} ${invalid.length === 1 ? "isn't an email address, so it isn't" : "aren't email addresses, so they aren't"} counted.`,
    );
  if (selfIn)
    problems.push("That's your address. You can't give yourself a role.");
  const notes = valid.flatMap((e) => {
    const k = e.toLowerCase();
    const m = byEmail.get(k);
    if (k === selfEmail) return [];
    if (m) {
      if (holds(m, grant))
        return [`${m.name || m.email} already has ${roleText}.`];
      const part = m.roles.find(
        (r) =>
          grant && r.role === grant.role && r.scope === grant.scope && r.areas,
      );
      return [
        part
          ? `${m.name || m.email} already has ${roleText} (${areaWordsOf(part.areas!)}). Adds the rest.`
          : `${m.name || m.email} is a member. Adds ${roleText}.`,
      ];
    }
    const w = wide.get(k);
    if (w) {
      const n = w.name || w.email;
      return [
        w.role === "superadmin"
          ? `${n} is a Superadmin and already manages ${scopeName}.`
          : `${n} manages ${scopeName} through All products admin${w.areas ? ` (${areaWordsOf(w.areas)})` : ""}. Adds ${scopeName} admin.`,
      ];
    }
    if (waiting.has(k))
      return [`${e} has an invitation waiting. Sending renews it.`];
    return [];
  });

  // ── the areas view ───────────────────────────────────────────────────────────────────────
  const areaRole =
    view.kind === "areas"
      ? (member?.roles.find((r) => r.bindingId === view.bindingId) ?? null)
      : null;
  const areaSlug = areaRole ? (productOfScope(areaRole.scope) ?? "") : "";
  const areasL2 = view.kind === "areas" && areaSlug === "";
  const areasSeed = (r: MemberRole): RoleDraft => ({
    choice: r.scope === "products:*" ? "all_products" : "product_admin",
    product: productOfScope(r.scope) ?? "",
    areaMode: r.areas === null ? "all" : "some",
    areas: r.areas ?? [],
  });
  const areasPicked = draft.areaMode === "all" || draft.areas.length > 0;
  // The All products role asks for the word only when the edit widens it (the Worker's rule).
  const widens =
    areasL2 &&
    !!areaRole &&
    areaRole.areas !== null &&
    (draft.areaMode === "all" ||
      draft.areas.some((a) => !areaRole.areas!.includes(a)));
  const areasBody = {
    areas:
      draft.areaMode === "all"
        ? null
        : PRODUCT_AREAS.filter((a) => draft.areas.includes(a)),
  };
  const areasWhy = areaRole
    ? areaSlug === ""
      ? isSuperadmin(me)
        ? undefined
        : "Only a Superadmin can change All products admin."
      : cannotGive(me, "product_admin", areaSlug, areasBody.areas)
    : undefined;

  // ── the footer's one action ──────────────────────────────────────────────────────────────
  const emailOff = !editing && !emailOn && adding > 0;
  const draftWhy = !draftOk
    ? draft.choice === "product_admin" && !draft.product
      ? "Choose a product"
      : draft.choice === "product_admin" &&
          draft.areaMode === "some" &&
          draft.areas.length === 0
        ? "Choose at least one area"
        : "Pick a role you can give"
    : undefined;
  let label = "";
  let why: string | undefined;
  let rest = false; // everything but the typed word is in order
  if (!editing) {
    label =
      sendable.length === 0
        ? "Invite people"
        : emailOff
          ? "Create invite links"
          : updating === 0
            ? `Invite ${people(sendable.length)}`
            : adding === 0
              ? `Add the role to ${people(updating)}`
              : `Invite ${people(adding)} and update ${updating}`;
    rest = sendable.length > 0 && !tooMany && draftOk;
    why =
      valid.length === 0
        ? "Add an email address"
        : sendable.length === 0
          ? selfIn && valid.length === 1
            ? "You can't give yourself a role"
            : "They already have this role"
          : tooMany
            ? `Invite up to ${MAX_INVITES} people at a time`
            : draftWhy;
  } else if (view.kind === "add") {
    label = "Add role";
    rest = draftOk;
    why = draftWhy;
  } else if (view.kind === "areas") {
    label = "Save areas";
    // Scoped, Save waits for a change.
    const unchanged =
      scoped && !!areaRole && sameDraft(draft, areasSeed(areaRole));
    rest = areasPicked && areasWhy === undefined && !unchanged;
    why = !areasPicked
      ? "Choose at least one area"
      : (areasWhy ?? (unchanged ? "Change an area first" : undefined));
  }
  const needWord = view.kind === "areas" ? widens : l2;
  const word = areasL2 ? WORD.all_products : WORD[draft.choice];
  const wordOk = !needWord || typed.trim().toLowerCase() === word.toLowerCase();
  const ready = rest && wordOk;
  const wordMissing = rest && !wordOk;
  const reasonText = !ready
    ? (why ?? (wordMissing ? `Type ${word} to confirm` : undefined))
    : undefined;
  void typedOk;

  // ── is there anything to lose ────────────────────────────────────────────────────────────
  const addDefault = (): RoleDraft => {
    const order: RoleChoice[] =
      (member?.roles.length ?? 0) === 0
        ? ["console_access", "product_admin", "platform_admin", "superadmin"]
        : ["product_admin", "platform_admin", "superadmin"];
    const choice =
      order.find((c) =>
        c === "product_admin"
          ? giveableProducts(me, products).length > 0
          : cannotGive(me, c) === undefined,
      ) ?? "product_admin";
    return { ...EMPTY_DRAFT, choice };
  };
  const dirty = !editing
    ? tokens.length > 0 || text.trim() !== "" || !sameDraft(draft, blank)
    : view.kind === "add"
      ? !sameDraft(draft, addDefault()) || typed !== ""
      : view.kind === "areas" && areaRole
        ? !sameDraft(draft, areasSeed(areaRole)) || typed !== ""
        : false;

  const toList = (): void => {
    setError(null);
    setAskBack(false);
    setDraft(blank);
    setTyped("");
    setView({ kind: "list" });
  };

  /** Undo from the notice: the drawer is modal, so the answer stays in it too. */
  const undoInline = async (id: string): Promise<void> => {
    try {
      await revoke(id);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) {
        setNotice({
          text: `Couldn't take the role back from ${name}.`,
          retry: () => void undoInline(id),
        });
        return;
      }
    }
    setNotice({ text: `Took the role back from ${name}` });
  };

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
      });
      startStepUp();
      return;
    }
    if (wordMissing) {
      wordRef.current?.scrollIntoView({ block: "center" });
      wordRef.current?.focus();
      return;
    }
    if (!ready) return;
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      if (!editing) await sendInvites();
      else if (view.kind === "add") {
        const r = await mutate("grantRole", {
          ...grant!,
          member: member!.memberId,
        });
        const bindingId = r?.binding?.bindingId;
        toList();
        setNotice({
          text: nowWords(name, roleText),
          ...(bindingId ? { undo: () => void undoInline(bindingId) } : {}),
        });
      } else if (view.kind === "areas") {
        if (productScope)
          await mutate(
            "editProductMemberAreas",
            productScope.slug,
            view.bindingId,
            areasBody,
          );
        else
          await mutate("editBindingAreas", view.bindingId, {
            ...areasBody,
            ...(widens ? { confirm: "L2" as const } : {}),
          });
        if (productScope) {
          onClose();
          toast.success(
            `${name} now manages ${
              areasBody.areas === null
                ? `every area of ${productScope.name}`
                : areaWordsOf(areasBody.areas)
            }`,
          );
        } else {
          toList();
          setNotice({ text: "Areas saved" });
        }
      }
      setPending(false);
    } catch (e) {
      setPending(false);
      setError(e ?? new Error("Something went wrong. Try again."));
    }
  };

  const sendInvites = async (): Promise<void> => {
    const result = productScope
      ? await mutate("inviteProductMembers", productScope.slug, {
          emails: sendable,
          areas: grant!.areas,
        })
      : await mutate("inviteMembers", { ...grant!, emails: sendable });
    const renewed = new Set(invites.map((i) => i.bindingId));
    const pick = (status: "invited" | "updated"): Undoable[] =>
      result.results
        // A renewed invitation is the earlier one: Undo must not delete it.
        .filter(
          (r) =>
            r.status === status && r.bindingId && !renewed.has(r.bindingId),
        )
        .map((r) => ({ id: r.bindingId!, label: r.email, kind: status }));
    const invited = result.results.filter((r) => r.status === "invited");
    const updated = result.results.filter((r) => r.status === "updated");
    const undo = [...pick("invited"), ...pick("updated")];
    const skipped = result.counts.exists;
    const unsent = result.emailOff ? [] : result.results.filter((r) => r.link);
    const head =
      invited.length + updated.length === 0
        ? "Nobody new to invite"
        : updated.length === 0
          ? scoped && invited.length === 1
            ? `Invited ${invited[0]!.email}`
            : `Invited ${people(invited.length)}`
          : invited.length === 0
            ? `Updated ${people(updated.length)}`
            : `Invited ${people(invited.length)} and updated ${updated.length}`;
    // The links dialog says the mail did not go out; the toast only counts.
    toast.success(head, {
      description:
        [
          skipped > 0 ? `${skipped} already had this role.` : "",
          invalid.length > 0 ? `Skipped ${invalid.join(", ")}.` : "",
          !result.emailOff &&
          unsent.length === 0 &&
          result.notified.nobodyNotified
            ? "Nobody was notified."
            : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
      ...(undo.length > 0
        ? {
            action: {
              label: "Undo",
              onClick: () =>
                void takeBack(
                  undo,
                  updated.length === 0
                    ? "Invitations withdrawn"
                    : invited.length === 0
                      ? "Roles taken back"
                      : "Invitations withdrawn and roles taken back",
                  revoke,
                ),
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
  const err = error && !stepUp ? describeMembersError(error) : null;
  const errorId = `${ids}-err`;
  const emailsId = `${ids}-emails`;
  const hintId = `${ids}-hint`;
  const sentence =
    view.kind === "areas"
      ? null
      : previewOf(
          !editing ? whoWords(sendable, "They") : name,
          draft,
          productLabel,
          areaWords,
        );
  // Nothing to say when nobody will be sent anything.
  const showSentence =
    (!editing && sendable.length > 0) || (editing && view.kind === "add");
  const lastRole =
    !scoped && removing !== null && (member?.roles.length ?? 0) === 1;

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
          editing && (view.kind === "list" || scoped)
            ? member!.email
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
                  selfEmail={selfEmail}
                  pending={new Set(waiting.keys())}
                  inputId={emailsId}
                  describedBy={hintId}
                  invalid={problems.length > 0}
                  disabled={pending}
                />
                <div id={hintId} className="space-y-0.5 text-sm">
                  {problems.length > 0 ? (
                    <div role="alert" className="space-y-0.5 text-danger">
                      {problems.map((p) => (
                        <p key={p}>{p}</p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-fg-muted">
                      Separate addresses with commas, spaces or new lines.
                    </p>
                  )}
                  {notes.map((n) => (
                    <p key={n} className="text-fg-muted">
                      {n}
                    </p>
                  ))}
                </div>
              </div>
              {productScope ? (
                <ScopedRole
                  me={me}
                  draft={draft}
                  onChange={changeDraft}
                  slug={productScope.slug}
                  productLabel={productScope.name}
                  disabled={pending}
                  idPrefix={`${ids}-i`}
                />
              ) : (
                <RoleFields
                  draft={draft}
                  onChange={changeDraft}
                  me={me}
                  products={products}
                  disabled={pending}
                  idPrefix={`${ids}-i`}
                />
              )}
            </>
          ) : view.kind === "list" ? (
            <>
              {notice ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken p-2 text-sm"
                >
                  <p className="min-w-0 text-fg-strong">{notice.text}</p>
                  {notice.undo || notice.retry ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={notice.undo ?? notice.retry}
                    >
                      {notice.undo ? "Undo" : "Retry"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <ul className="divide-y divide-border">
                {(member?.roles ?? []).map((r, i) => {
                  const wide = r.scope === "products:*";
                  const narrowable =
                    r.role === "product_admin" &&
                    r.bindingId !== null &&
                    (r.scope.startsWith("product:") ||
                      (wide && r.areas !== null));
                  const whyTake = cannotTake(me, r, productName);
                  const whyAreas = !narrowable
                    ? undefined
                    : wide
                      ? isSuperadmin(me)
                        ? undefined
                        : "Only a Superadmin can change All products admin."
                      : cannotEditAreas(me, r, productName);
                  const rn = roleName(r, productName);
                  // One reason per row: the first thing it cannot do.
                  const rowWhy =
                    writeReason ??
                    (whyTake !== undefined &&
                    (!narrowable || whyAreas !== undefined)
                      ? whyTake
                      : undefined);
                  return (
                    <li
                      key={r.bindingId ?? `root-${i}`}
                      className="grid gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                    >
                      <div className="min-w-0 space-y-1">
                        <RoleSet role={r} productName={productName} />
                        <p className="text-xs text-fg-muted">{sourceText(r)}</p>
                        {rowWhy ? (
                          <p className="text-xs text-fg-muted">{rowWhy}</p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {narrowable ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={whyAreas !== undefined || !!writeReason}
                            disabledReason={writeReason ?? whyAreas}
                            onClick={() => {
                              setDraft(areasSeed(r));
                              setTyped("");
                              setError(null);
                              setView({
                                kind: "areas",
                                bindingId: r.bindingId!,
                              });
                            }}
                            aria-label={`Edit areas of ${rn}`}
                          >
                            Edit areas
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={whyTake !== undefined || !!writeReason}
                          disabledReason={writeReason ?? whyTake}
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
            </>
          ) : view.kind === "add" ? (
            <RoleFields
              draft={draft}
              onChange={changeDraft}
              me={me}
              products={products}
              held={member?.roles ?? []}
              name={name}
              disabled={pending}
              idPrefix={`${ids}-a`}
            />
          ) : areaRole ? (
            <AreaPicker
              me={me}
              draft={draft}
              onChange={changeDraft}
              slug={areaSlug}
              productLabel={
                areaSlug === "" ? "every product" : productName(areaSlug)
              }
              disabled={pending}
              idPrefix={`${ids}-e`}
            />
          ) : null}

          {needWord && (view.kind !== "list" || !editing) ? (
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-word`} className="block text-sm text-fg">
                Type the role to confirm{" "}
                <code className="rounded-xs bg-surface-sunken px-1 font-mono text-xs text-fg-strong">
                  {word}
                </code>
              </label>
              <input
                ref={wordRef}
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
        </DrawerBody>

        <div
          data-drawer-footer=""
          className="flex max-h-[55%] shrink-0 flex-col border-t border-border px-4 py-3 lg:px-6"
        >
          {/* What can scroll; the buttons below never do. A scrolling region takes focus, so a
              keyboard can reach what is cut off. */}
          <div
            ref={footScroll}
            {...(footScrolls
              ? { tabIndex: 0, role: "region", "aria-label": "Summary" }
              : {})}
            className="min-h-0 space-y-2 overflow-y-auto [&:not(:empty)]:pb-2"
          >
            {askBack ? (
              <DiscardStrip
                className="rounded-md border px-3"
                onKeep={() => setAskBack(false)}
                onDiscard={scoped ? onClose : toList}
              />
            ) : null}
            {err ? (
              <div
                id={errorId}
                role="alert"
                className="flex gap-2 rounded-md border border-danger-border bg-danger-subtle p-2 text-sm"
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
                className="flex gap-2 rounded-md border border-border bg-surface-sunken p-2 text-sm"
              >
                <Fingerprint
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-fg-muted"
                />
                <div className="space-y-0.5">
                  <p className="font-semibold text-fg-strong">
                    Sign in again to confirm it&apos;s you
                  </p>
                  <p className="text-fg">
                    Your changes are kept.
                    {typeof me?.authAt === "number"
                      ? ` You signed in ${formatRelative(me.authAt * 1000)}.`
                      : ""}
                  </p>
                </div>
              </div>
            ) : null}
            {showSentence && sentence ? (
              <div className="space-y-1 rounded-md border border-border bg-surface-sunken p-2 text-sm">
                <p className="text-fg-strong" aria-live="polite">
                  {sentence}
                </p>
                <ul className="flex flex-wrap gap-x-4 text-xs text-fg-muted">
                  {!editing ? (
                    <li>Expires {expiresText(Date.now() + 7 * 86_400_000)}</li>
                  ) : null}
                  {emailOn ? (
                    <li>Every Superadmin is told</li>
                  ) : (
                    <>
                      {emailOff ? <li>Nobody is emailed</li> : null}
                      <li>Superadmins see it in Activity</li>
                    </>
                  )}
                </ul>
              </div>
            ) : null}
            {reasonText && !stepUp ? (
              <p className="text-xs text-fg-muted sm:hidden">{reasonText}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {editing && view.kind !== "list" ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  dirty ? setAskBack(true) : scoped ? onClose() : toList()
                }
              >
                {scoped ? "Cancel" : "Back to roles"}
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
            {editing && view.kind === "list" && scoped ? null : editing &&
              view.kind === "list" ? (
              <Button
                variant="primary"
                disabled={member!.you || !!writeReason}
                disabledReason={
                  writeReason ??
                  (member!.you ? "You can't give yourself a role." : undefined)
                }
                onClick={() => {
                  setDraft(addDefault());
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
                disabled={!stepUp && !ready && !wordMissing}
                disabledReason={
                  !stepUp && !ready && !wordMissing ? why : undefined
                }
                aria-describedby={err || stepUp ? errorId : undefined}
                onClick={() => void save()}
              >
                {stepUp ? "Sign in again" : label}
              </Button>
            )}
          </div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        intent="caution"
        title={
          lastRole
            ? `Remove ${name} from the console?`
            : `Remove ${removing ? roleName(removing, productName) : "role"} from ${name}?`
        }
        consequences={[
          lastRole
            ? `${name} loses access to the console.`
            : "The role stops applying within 30 seconds.",
          "Every Superadmin is told.",
        ]}
        confirmLabel={lastRole ? "Remove from console" : "Remove role"}
        describeError={describeMembersError}
        onConfirm={async () => {
          try {
            await revoke(removing!.bindingId!);
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 404)) throw e;
          }
          // The drawer is open behind this dialog: say it there, not in a toast.
          setNotice({ text: lastRole ? `Removed ${name}` : "Role removed" });
        }}
      />
      <InviteLinksDialog
        result={links}
        productName={productName}
        grant={grant}
        onClose={() => setLinks(null)}
        onCloseAutoFocus={(e) => {
          const o = opener.current;
          if (o?.isConnected) {
            e.preventDefault();
            o.focus();
          }
        }}
      />
    </>
  );
}

/**
 * The Worker returns a sign-in link for an address it did not email: every address with email
 * off, or the ones whose send failed.
 */
export function InviteLinksDialog({
  result,
  grant,
  productName,
  onClose,
  onCloseAutoFocus,
}: {
  result: InviteResult | null;
  grant: ReturnType<typeof grantOf>;
  productName: ProductName;
  onClose: () => void;
  onCloseAutoFocus?: (e: Event) => void;
}): React.ReactElement {
  const rows = (result?.results ?? []).filter((r) => r.link);
  const off = result?.emailOff ?? false;
  const unsent = rows.length;
  const expires = rows.find((r) => r.expiresAt)?.expiresAt;
  const role = grant
    ? roleLabel({ ...grant, source: "" }, productName).label
    : "";
  return (
    <Dialog
      open={result !== null}
      onOpenChange={(o) => !o && onClose()}
      onCloseAutoFocus={onCloseAutoFocus}
      size="md"
      title={
        off
          ? `Invite links for ${people(unsent)}`
          : `${unsent === 1 ? "1 email" : `${unsent} emails`} didn't go out. Send ${unsent === 1 ? "this link" : "these links"}.`
      }
      description={
        off
          ? "Nothing was emailed. Each link opens the console sign-in for that address."
          : "Each link opens the console sign-in for that address."
      }
    >
      <DialogBody className="space-y-3 text-sm">
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.email} className="space-y-1">
              <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                {r.email}
                {role ? (
                  <span className="font-normal text-fg-muted"> · {role}</span>
                ) : null}
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
        {expires ? (
          <p className="text-xs text-fg-muted">
            Expires {expiresText(expires * 1000)}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
