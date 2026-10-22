/**
 * The pieces of the Invite / Edit roles drawer (ST-31.12; mockup `admin.invite`): the email chip
 * field, the role picker (four cards, a product, areas), and the live preview sentence. Pure view
 * state: the Worker enforces what may be given, the console only declines to offer it and says why.
 */

import * as React from "react";
import { X } from "lucide-react";
import { RadioGroup } from "radix-ui";
import type { AreaId, Me, Member, MemberRole } from "../../api.js";
import { cn } from "../../lib/cn.js";
import { Checkbox } from "../../ui/Checkbox.js";
import { RadioCards } from "../../ui/RadioCards.js";
import { Select } from "../../ui/Select.js";
import { useProductServices } from "../data/hooks.js";
import {
  cannotGive,
  isSuperadmin,
  PRODUCT_AREAS,
  type RoleChoice,
  type RoleDraft,
} from "../sections/platform/pages/platformMembersModel.js";
import { AREA_ACCENTS, AREA_NAMES, listOf } from "./can.js";
import { RoleGlyph } from "./RoleTag.js";
import { ServiceGlyph } from "../../ui/ServiceBadge.js";

// ── emails ──────────────────────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export const MAX_INVITES = 20;

export const isEmail = (e: string): boolean => EMAIL.test(e);

/** Split typed or pasted text on commas, semicolons and whitespace. */
export const splitEmails = (text: string): string[] =>
  text.split(/[\s,;]+/).filter(Boolean);

/** Add tokens, dropping repeats (case-insensitive) and keeping the first spelling. */
export function mergeEmails(
  have: readonly string[],
  add: readonly string[],
): string[] {
  const seen = new Set(have.map((e) => e.toLowerCase()));
  const out = [...have];
  for (const e of add) {
    const k = e.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export const people = (n: number): string =>
  `${n} ${n === 1 ? "person" : "people"}`;

const initialsOf = (name: string, email: string): string => {
  const w = (name || email).split(/[\s@._-]+/).filter(Boolean);
  return ((w[0]?.[0] ?? "?") + (w[1]?.[0] ?? "")).toUpperCase();
};

export function EmailChips({
  tokens,
  onTokens,
  text,
  onText,
  members,
  selfEmail,
  pending,
  inputId,
  describedBy,
  invalid,
  disabled,
}: {
  tokens: readonly string[];
  onTokens: (t: string[]) => void;
  text: string;
  onText: (t: string) => void;
  members: readonly Member[];
  /** The signed-in member's own address: it cannot be invited. */
  selfEmail: string;
  /** Addresses with an invitation waiting (lower case). */
  pending: ReadonlySet<string>;
  inputId: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const [said, setSaid] = React.useState("");
  const before = React.useRef<readonly string[]>(tokens);
  React.useEffect(() => {
    const was = before.current;
    before.current = tokens;
    const added = tokens.filter((t) => !was.includes(t));
    const gone = was.filter((t) => !tokens.includes(t));
    if (added.length > 0) setSaid(`${added.join(", ")} added`);
    else if (gone.length > 0) setSaid(`${gone.join(", ")} removed`);
  }, [tokens]);
  const commit = (rest: string): void => {
    const parts = splitEmails(rest);
    if (parts.length > 0) onTokens(mergeEmails(tokens, parts));
    onText("");
  };
  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-1.5 rounded-md border bg-surface-sunken px-2 py-1.5",
        "focus-within:outline-2 focus-within:outline-focus",
        invalid ? "border-danger" : "border-border-strong",
      )}
    >
      {tokens.length > 0 ? (
        <ul
          aria-label="Addresses"
          className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
        >
          {tokens.map((e) => {
            const k = e.toLowerCase();
            const member = byEmail.get(k);
            const self = k === selfEmail;
            const bad = !isEmail(e) || self;
            return (
              <li
                key={k}
                data-chip={
                  !isEmail(e)
                    ? "invalid"
                    : self
                      ? "self"
                      : member
                        ? "member"
                        : pending.has(k)
                          ? "waiting"
                          : "email"
                }
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-md border bg-surface-raised py-0.5 ps-2 pe-1 text-sm text-fg-strong",
                  bad
                    ? "border-danger bg-danger-subtle"
                    : "border-border-strong",
                )}
              >
                {member && !bad ? (
                  <span
                    aria-hidden
                    className="inline-flex size-5 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold"
                  >
                    {initialsOf(member.name, member.email)}
                  </span>
                ) : null}
                <span className="min-w-0 [overflow-wrap:anywhere]">{e}</span>
                {!isEmail(e) ? (
                  <span className="sr-only">, not an email address</span>
                ) : self ? (
                  <span className="sr-only">, that&apos;s you</span>
                ) : member ? (
                  <span className="sr-only">, already a member</span>
                ) : pending.has(k) ? (
                  <span className="sr-only">, invitation waiting</span>
                ) : null}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${e}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onTokens(tokens.filter((x) => x !== e));
                    inputRef.current?.focus();
                  }}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:size-8"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {said}
      </span>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        inputMode="email"
        value={text}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        placeholder={tokens.length === 0 ? "ana@example.com" : undefined}
        onChange={(ev) => {
          const v = ev.target.value;
          if (!/[\s,;]/.test(v)) return onText(v);
          // Everything before the last separator is done; the rest is still being typed.
          const ends = /[\s,;]$/.test(v);
          const parts = splitEmails(v);
          const rest = ends ? "" : (parts.pop() ?? "");
          onTokens(mergeEmails(tokens, parts));
          onText(rest);
        }}
        onPaste={(ev) => {
          // A single-line input drops the line breaks of a pasted list, gluing the addresses.
          const pasted = ev.clipboardData.getData("text");
          if (!/[\s,;]/.test(pasted.trim())) return;
          ev.preventDefault();
          onTokens(mergeEmails(tokens, splitEmails(text + pasted)));
          onText("");
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && text.trim()) {
            ev.preventDefault();
            commit(text);
          } else if (ev.key === "Backspace" && text === "" && tokens.length) {
            onTokens(tokens.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && commit(text)}
        className="min-w-[10rem] flex-1 bg-transparent px-1 py-1 text-sm text-fg outline-hidden placeholder:text-fg-subtle"
      />
    </div>
  );
}

// ── roles ───────────────────────────────────────────────────────────────────────────────────

type Card =
  | "console_access"
  | "product_admin"
  | "platform_admin"
  | "superadmin";

const CARDS: { value: Card; label: string; description: string }[] = [
  {
    value: "console_access",
    label: "Console access",
    description: "Opens the console. Sees nothing until given another role.",
  },
  {
    value: "product_admin",
    label: "Product admin",
    description: "Manages the products you pick.",
  },
  {
    value: "platform_admin",
    label: "Platform admin",
    description: "Platform settings, connections, packages and new products.",
  },
  {
    value: "superadmin",
    label: "Superadmin",
    description: "Everything, including every role and SSO rule.",
  },
];

/** The role's name as the typed confirmation asks for it. */
export const WORD: Record<RoleChoice, string> = {
  console_access: "Console access",
  product_admin: "Product admin",
  all_products: "All products admin",
  platform_admin: "Platform admin",
  superadmin: "Superadmin",
};

export type ProductName = (slug: string) => string;

/** The area's feature: the area is offered only while that service runs on the product. */
const AREA_SERVICE: Partial<Record<AreaId, string>> = {
  commerce: "commerce",
  license: "license",
  config: "config",
  ship: "release",
  signin: "identity",
  sync: "sync",
};

/** Products the signed-in member may give Product admin on. */
export function giveableProducts(
  me: Me | undefined,
  products: readonly { slug: string; name: string }[],
): { slug: string; name: string }[] {
  return products.filter(
    (p) => cannotGive(me, "product_admin", p.slug, []) === undefined,
  );
}

/** Plain radio rows (a small circle and a label), with whatever belongs to the row nested below. */
export function RadioRows<V extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
  idPrefix,
}: {
  value: V;
  onChange: (v: V) => void;
  label: string;
  disabled?: boolean;
  idPrefix: string;
  options: {
    value: V;
    label: React.ReactNode;
    disabled?: boolean;
    children?: React.ReactNode;
  }[];
}): React.ReactElement {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(v) => onChange(v as V)}
      className="space-y-2"
    >
      {options.map((o) => {
        const id = `${idPrefix}-${o.value}`;
        return (
          <div key={o.value} className="space-y-2">
            <div className="flex min-h-6 items-center gap-2.5 pointer-coarse:min-h-9">
              <RadioGroup.Item
                id={id}
                value={o.value}
                disabled={o.disabled}
                className="group relative flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-raised after:absolute after:-inset-2 after:content-[''] focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 disabled:opacity-50 data-[state=checked]:border-accent forced-colors:border-[ButtonText]"
              >
                <RadioGroup.Indicator className="size-2 rounded-full bg-accent forced-colors:bg-[Highlight]" />
              </RadioGroup.Item>
              <label
                htmlFor={id}
                className={cn(
                  "text-sm text-fg-strong",
                  o.disabled && "text-fg-muted",
                )}
              >
                {o.label}
              </label>
            </div>
            {o.value === value && o.children ? (
              <div className="ps-6">{o.children}</div>
            ) : null}
          </div>
        );
      })}
    </RadioGroup.Root>
  );
}

const WITH_GLYPH = (a: AreaId): React.ReactNode => {
  const accent = AREA_ACCENTS[a];
  return (
    <span className="inline-flex items-center gap-1.5">
      {accent ? <ServiceGlyph id={accent as "core"} size={16} /> : null}
      {AREA_NAMES[a]}
    </span>
  );
};

export function RoleFields({
  draft,
  onChange,
  me,
  products,
  held = [],
  name,
  disabled,
  idPrefix,
}: {
  draft: RoleDraft;
  onChange: (d: RoleDraft) => void;
  me: Me | undefined;
  products: readonly { slug: string; name: string }[];
  /** Roles the person already holds (edit mode): Console access is implied by any of them. */
  held?: readonly MemberRole[];
  name?: string;
  disabled?: boolean;
  idPrefix: string;
}): React.ReactElement {
  const roleId = `${idPrefix}-role`;
  const groupId = `${idPrefix}-role-why`;
  const productId = `${idPrefix}-product`;
  const card: Card =
    draft.choice === "all_products" ? "product_admin" : draft.choice;
  const mayProducts = giveableProducts(me, products);
  const superOnly: string[] = [];
  const reasons: string[] = [];
  const off = new Set<Card>();
  for (const c of CARDS) {
    if (c.value === "platform_admin" || c.value === "superadmin")
      if (cannotGive(me, c.value) !== undefined) {
        off.add(c.value);
        superOnly.push(c.label);
      }
  }
  if (cannotGive(me, "all_products") !== undefined)
    superOnly.push("All products");
  if (superOnly.length > 0)
    reasons.push(`Only a Superadmin can give ${listOf(superOnly)}.`);
  if (cannotGive(me, "console_access") !== undefined) {
    off.add("console_access");
    reasons.push(
      "Only a Platform admin or a Superadmin can give Console access.",
    );
  }
  // A person with any role already has Console access; offering it again is a dead end.
  if (held.length > 0 && !off.has("console_access")) {
    off.add("console_access");
    reasons.push(`${name ?? "They"} already has Console access.`);
  }
  if (mayProducts.length === 0) {
    off.add("product_admin");
    reasons.push(
      products.length === 0
        ? "There are no products yet."
        : "You can give Product admin only on products you administer.",
    );
  }
  const reason = reasons.join(" ");
  const allWhy = cannotGive(me, "all_products");
  const slug = draft.choice === "product_admin" ? draft.product : "";
  const sel = CARDS.find((c) => c.value === card);

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <span id={roleId} className="block text-sm font-medium text-fg-strong">
          Role
        </span>
        <RadioCards<Card>
          aria-labelledby={roleId}
          aria-describedby={reason ? groupId : undefined}
          id={`${idPrefix}-card`}
          columns={2}
          // Two by two on a phone too.
          className="grid-cols-2"
          value={card}
          disabled={disabled}
          onChange={(c) =>
            onChange({
              ...draft,
              choice:
                c === "product_admin" && draft.choice === "all_products"
                  ? "all_products"
                  : c,
            })
          }
          options={CARDS.map((c) => ({
            value: c.value,
            label: c.label,
            icon: (
              <RoleGlyph
                role={{
                  role: c.value,
                  scope: c.value === "product_admin" ? "product:x" : "platform",
                  areas: null,
                }}
                className="size-4"
              />
            ),
            // On a phone the chosen role's words sit once below the tiles.
            description: <span className="max-sm:hidden">{c.description}</span>,
            disabled: off.has(c.value),
          }))}
        />
        {sel ? (
          <p className="text-xs text-fg-muted sm:hidden">{sel.description}</p>
        ) : null}
        {reason ? (
          <p id={groupId} className="text-xs text-fg-muted">
            {reason}
          </p>
        ) : null}
      </div>
      {card === "product_admin" ? (
        <div className="space-y-5">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-fg-strong">
              Products
            </span>
            <RadioRows<"one" | "all">
              label="Products"
              idPrefix={`${idPrefix}-scope`}
              disabled={disabled}
              value={draft.choice === "all_products" ? "all" : "one"}
              onChange={(v) =>
                onChange({
                  ...draft,
                  choice: v === "all" ? "all_products" : "product_admin",
                })
              }
              options={[
                {
                  value: "one",
                  label: "One product",
                  children: (
                    <Select
                      id={productId}
                      aria-label="Product"
                      value={draft.product || null}
                      disabled={disabled}
                      placeholder="Choose a product"
                      onChange={(product) =>
                        onChange({
                          ...draft,
                          product: product ?? "",
                          areas: [],
                        })
                      }
                      options={mayProducts.map((p) => ({
                        value: p.slug,
                        label: p.name,
                      }))}
                    />
                  ),
                },
                {
                  value: "all",
                  label: "All products, including ones added later",
                  disabled: allWhy !== undefined,
                },
              ]}
            />
            {allWhy ? <p className="text-xs text-fg-muted">{allWhy}</p> : null}
          </div>
          {slug ? (
            <AreaPicker
              me={me}
              draft={draft}
              onChange={onChange}
              slug={slug}
              productLabel={products.find((p) => p.slug === slug)?.name ?? slug}
              disabled={disabled}
              idPrefix={idPrefix}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The areas a product offers: only those whose feature is on. */
export function useOfferedAreas(slug: string): {
  offered: AreaId[];
  missing: AreaId[];
} {
  const services = useProductServices(slug);
  return React.useMemo(() => {
    const offered: AreaId[] = [];
    const missing: AreaId[] = [];
    for (const a of PRODUCT_AREAS) {
      const svc = AREA_SERVICE[a];
      const on =
        !svc ||
        !services ||
        (services as Record<string, { enabled: boolean } | undefined>)[svc]
          ?.enabled !== false;
      (on ? offered : missing).push(a);
    }
    return { offered, missing };
  }, [services]);
}

/** "Every area of X" or "Only these areas" with the offered areas ticked below. */
export function AreaPicker({
  me,
  draft,
  onChange,
  slug,
  productLabel,
  disabled,
  idPrefix,
}: {
  me: Me | undefined;
  draft: RoleDraft;
  onChange: (d: RoleDraft) => void;
  /** The product's slug; empty for All products. */
  slug: string;
  productLabel: string;
  disabled?: boolean;
  idPrefix: string;
}): React.ReactElement {
  const { offered, missing } = useOfferedAreas(slug);
  const everyWhy =
    slug === "" || isSuperadmin(me)
      ? undefined
      : cannotGive(me, "product_admin", slug, null);
  const hint =
    missing.length > 0
      ? `${listOf(missing.map((a) => AREA_NAMES[a]))} ${missing.length === 1 ? "is" : "are"} off for ${productLabel}.`
      : "";
  const ticked = draft.areas.filter((a) => offered.includes(a));
  const allTicked =
    draft.areaMode === "some" &&
    offered.length > 0 &&
    offered.every((a) => draft.areas.includes(a));
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium text-fg-strong">Areas</span>
      <RadioRows<"all" | "some">
        label="Areas"
        idPrefix={`${idPrefix}-areamode`}
        disabled={disabled}
        value={draft.areaMode}
        onChange={(m) => onChange({ ...draft, areaMode: m })}
        options={[
          {
            value: "all",
            label: `Every area of ${productLabel}`,
            disabled: everyWhy !== undefined,
          },
          {
            value: "some",
            label: "Only these areas",
            children: (
              <div className="space-y-1.5">
                <AreaChecks
                  me={me}
                  slug={slug}
                  offered={offered}
                  areas={draft.areas}
                  onChange={(areas) => onChange({ ...draft, areas })}
                />
                {allTicked ? (
                  <p className="text-xs text-fg-muted">
                    That&apos;s every area now. Choose Every area of{" "}
                    {productLabel} to include ones added later.
                  </p>
                ) : null}
              </div>
            ),
          },
        ]}
      />
      {everyWhy ? (
        <p className="text-xs text-fg-muted">You hold only some areas.</p>
      ) : null}
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
      <span className="sr-only" aria-live="polite">
        {draft.areaMode === "some" ? `${ticked.length} areas picked` : ""}
      </span>
    </div>
  );
}

export function AreaChecks({
  me,
  slug,
  offered,
  areas,
  onChange,
  legend,
}: {
  me: Me | undefined;
  slug: string;
  offered: readonly AreaId[];
  areas: readonly AreaId[];
  onChange: (a: AreaId[]) => void;
  legend?: string;
}): React.ReactElement {
  return (
    <div
      role="group"
      aria-label={legend ?? "Pick the areas"}
      className="grid grid-cols-2 gap-x-3 gap-y-2"
    >
      {offered.map((a) => {
        const why =
          slug === "" ? undefined : cannotGive(me, "product_admin", slug, [a]);
        return (
          <Checkbox
            key={a}
            label={WITH_GLYPH(a)}
            checked={areas.includes(a)}
            disabled={why !== undefined}
            onCheckedChange={(on) =>
              onChange(on ? [...areas, a] : areas.filter((x) => x !== a))
            }
          />
        );
      })}
    </div>
  );
}

// ── the sentence ────────────────────────────────────────────────────────────────────────────

/** "hana@ and theo@" for the addresses, by local part. */
export function whoWords(emails: readonly string[], fallback: string): string {
  if (emails.length === 0) return fallback;
  const names = emails.slice(0, 3).map((e) => `${e.split("@")[0]}@`);
  if (emails.length > 3) names.push(`${emails.length - 3} more`);
  return listOf(names);
}

/** What the people will and won't see, for the draft. */
export function previewOf(
  who: string,
  d: RoleDraft,
  productLabel: string,
  areaWords: string,
): string {
  switch (d.choice) {
    case "console_access":
      return `${who} will open the console and see nothing else.`;
    case "platform_admin":
      return `${who} will manage the platform and its members, but can't give Superadmin.`;
    case "superadmin":
      return `${who} will have full access and can give any role.`;
    case "all_products":
      return `${who} will manage every area of every product, now and later.`;
    case "product_admin":
      if (!d.product) return `${who} will manage the product you pick.`;
      if (d.areaMode === "some")
        return d.areas.length > 0
          ? `${who} will manage ${areaWords} in ${productLabel}.`
          : "Choose at least one area.";
      return `${who} will manage every area of ${productLabel}.`;
  }
}
