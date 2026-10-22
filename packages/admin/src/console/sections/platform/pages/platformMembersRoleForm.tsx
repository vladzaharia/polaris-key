/**
 * The role picker the Members dialogs share (ST-31.11): five roles as cards (the ones the signed-in
 * member cannot give are off, with the reason), a product, and every area or only some. Pure view
 * state: the Worker enforces what may be given.
 */

import * as React from "react";
import type { Me } from "../../../../api.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { Select } from "../../../../ui/Select.js";
import { AREA_NAMES, listOf } from "../../../access/can.js";
import {
  cannotGive,
  grantOf,
  PRODUCT_AREAS,
  SUPERADMIN_ONLY,
  type RoleChoice,
  type RoleDraft,
} from "./platformMembersModel.js";

export type ProductName = (slug: string) => string;

const CHOICES: {
  value: RoleChoice;
  label: string;
  description: string;
}[] = [
  {
    value: "console_access",
    label: "Console access",
    description: "Opens the console. No product or platform pages.",
  },
  {
    value: "product_admin",
    label: "Product admin",
    description: "One product: every area, or only the ones you pick.",
  },
  {
    value: "all_products",
    label: "All products admin",
    description: "Every product, now and later.",
  },
  {
    value: "platform_admin",
    label: "Platform admin",
    description: "Platform pages and members, but not Superadmins.",
  },
  {
    value: "superadmin",
    label: "Superadmin",
    description: "Everything, and can give any role.",
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

// ── the role picker ─────────────────────────────────────────────────────────────────────────

export function RoleForm({
  draft,
  onChange,
  me,
  products,
  disabled,
}: {
  draft: RoleDraft;
  onChange: (d: RoleDraft) => void;
  me: Me | undefined;
  products: readonly { slug: string; name: string }[];
  disabled?: boolean;
}): React.ReactElement {
  const roleId = React.useId();
  const productId = React.useId();
  const areaMode = draft.areaMode;
  // The cards that are off, and the reason once for the group.
  const offChoices = CHOICES.filter(
    (c) => c.value !== "product_admin" && cannotGive(me, c.value) !== undefined,
  ).map((c) => c.value);
  const offId = React.useId();
  const superOnly = CHOICES.filter(
    (c) => SUPERADMIN_ONLY.includes(c.value) && offChoices.includes(c.value),
  ).map((c) => c.label);
  const offReason = [
    superOnly.length > 0
      ? `Only a Superadmin can give ${listOf(superOnly)}.`
      : "",
    offChoices.includes("console_access")
      ? "Only a Platform admin or a Superadmin can give Console access."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span id={roleId} className="block text-sm font-medium text-fg-strong">
          Role
        </span>
        <RadioCards<RoleChoice>
          aria-labelledby={roleId}
          aria-describedby={offReason ? offId : undefined}
          columns={2}
          value={draft.choice}
          disabled={disabled}
          onChange={(choice) => onChange({ ...draft, choice })}
          options={CHOICES.map((c) => ({
            value: c.value,
            label: c.label,
            description: c.description,
            disabled: offChoices.includes(c.value),
          }))}
        />
        {offReason ? (
          <p id={offId} className="text-xs text-fg-muted">
            {offReason}
          </p>
        ) : null}
      </div>
      {draft.choice === "product_admin" ? (
        <>
          <div className="space-y-1.5">
            <label
              htmlFor={productId}
              className="block text-sm font-medium text-fg-strong"
            >
              Product
            </label>
            <Select
              id={productId}
              value={draft.product || null}
              disabled={disabled}
              placeholder="Choose a product"
              onChange={(product) =>
                onChange({ ...draft, product: product ?? "" })
              }
              options={products.map((p) => ({ value: p.slug, label: p.name }))}
            />
          </div>
          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="text-sm font-medium text-fg-strong">
              Areas
            </legend>
            <RadioCards<"all" | "some">
              aria-label="Areas"
              columns={2}
              value={areaMode}
              onChange={(m) => onChange({ ...draft, areaMode: m })}
              options={[
                {
                  value: "all",
                  label: "Every area",
                  description: "All of the product's pages.",
                },
                {
                  value: "some",
                  label: "Only these areas",
                  description: "Pick the ones they need.",
                },
              ]}
            />
            {areaMode === "some" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {PRODUCT_AREAS.map((a) => (
                  <Checkbox
                    key={a}
                    label={AREA_NAMES[a]}
                    checked={draft.areas.includes(a)}
                    onCheckedChange={(on) =>
                      onChange({
                        ...draft,
                        areas: on
                          ? [...draft.areas, a]
                          : draft.areas.filter((x) => x !== a),
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
          </fieldset>
          {draft.product
            ? (() => {
                const g = grantOf(draft);
                const reason = cannotGive(
                  me,
                  "product_admin",
                  draft.product,
                  g ? g.areas : null,
                );
                return reason ? (
                  <p role="status" className="text-sm text-fg-muted">
                    {reason}
                  </p>
                ) : null;
              })()
            : null}
        </>
      ) : null}
    </div>
  );
}

/** Whether a draft can be sent: a role chosen, a product and areas where they are needed, and allowed. */
export function draftReady(d: RoleDraft, me: Me | undefined): boolean {
  const g = grantOf(d);
  if (!g) return false;
  return (
    cannotGive(
      me,
      d.choice,
      d.product,
      d.choice === "product_admin" ? g.areas : null,
    ) === undefined
  );
}

export const draftLabel = (d: RoleDraft, productName: ProductName): string =>
  d.choice === "product_admin" && d.product
    ? `${productName(d.product)} admin`
    : WORD[d.choice];
