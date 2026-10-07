/**
 * The Polaris Key panel's words (PS-06; notes/S-21 §6.5, §6.6), kept apart from the page so they
 * read as one table and are tested as one: the listing states and audiences with who each one
 * shows the product to, each way to add, the "Who can see this?" lines, and the tile's reason line
 * exactly as S-21 §6.5's table gives it to the portal.
 *
 * ADMIN.md §5.8: sentence case, the docs' voice, no implementation-status copy. A way to add the
 * product that is not configured is absent from every list here, never "unavailable".
 */

import type {
  ObtainPathKind,
  PolarisKeyAudience,
  PolarisKeyListed,
  PolarisKeyPreviewResponse,
  PolarisKeyStatusResponse,
  PolarisKeyTerms,
  PolarisKeyTile,
  PolarisKeyTilePath,
} from "../../../api.js";

export interface ChoiceCopy<V extends string> {
  value: V;
  label: string;
  /** One line: who sees the product. */
  description: string;
}

/** `storefront.polarisKey.listed`, in the panel's order. */
export const LISTED_CHOICES: readonly ChoiceCopy<PolarisKeyListed>[] = [
  {
    value: "auto",
    label: "Automatic",
    description:
      "Shown to people that auto-issue or a mapped group would give it to, as Discover does by default.",
  },
  {
    value: "listed",
    label: "Listed",
    description:
      "Shown to everyone who can add it, by any of the ways to add it below.",
  },
  {
    value: "unlisted",
    label: "Not listed",
    description:
      "Shown to no one in the portal. Sign-in, auto-issue and every licence keep working.",
  },
];

/** `storefront.polarisKey.audience`. */
export const AUDIENCE_CHOICES: readonly ChoiceCopy<PolarisKeyAudience>[] = [
  {
    value: "eligible",
    label: "People who can add it",
    description: "Only a person with a way to add the product sees it.",
  },
  {
    value: "everyone",
    label: "Everyone signed in",
    description:
      "Every signed-in person sees it. Someone with no way to add it gets a link to its store pages or website instead of Add.",
  },
];

/** Each way to add a product: its switch label and what it means. */
export const PATH_COPY: Readonly<
  Record<ObtainPathKind, { label: string; help: string }>
> = {
  group: {
    label: "Members of a mapped group",
    help: "People in an IdP group mapped in the product's sign-in get the group's tier.",
  },
  auto_issue: {
    label: "Free with an account",
    help: "Everyone signed in with the Polaris Key sign-in gets the auto-issue tier.",
  },
  open: {
    label: "Free to use",
    help: "Nothing to license: License is off and every download is public or for signed-in people. Add puts it in the person's Library.",
  },
  store_owned: {
    label: "Owned on a store",
    help: "People who linked a store account that owns the product.",
  },
  product_idp: {
    label: "The product's own sign-in",
    help: "People with a verified account at the product's own identity provider.",
  },
  email_domain: {
    label: "An email domain",
    help: "People with a verified email at one of the product's domains.",
  },
};

/** The kinds `auto` counts (today's Discover); the rest count only when Listed. */
export const IDENTITY_KINDS: readonly ObtainPathKind[] = [
  "group",
  "auto_issue",
];

/** The analytics card's name for a path kind, or for a link. */
export function kindLabel(kind: ObtainPathKind | "link"): string {
  if (kind === "link") return "Link to get it";
  return PATH_COPY[kind].label;
}

/** A store id as people know it ("Steam"). */
function storeName(id: string | null): string {
  if (!id) return "a store";
  if (id === "steam") return "Steam";
  return id;
}

/**
 * The tile's reason line for a path (notes/S-21 §6.5's table). Every offer shows why, so this
 * never answers nothing.
 */
export function reasonLine(path: PolarisKeyTilePath): string {
  switch (path.kind) {
    case "auto_issue": {
      const days = path.terms?.expiryDays ?? null;
      return days !== null
        ? `Free trial · ${days} ${days === 1 ? "day" : "days"}`
        : "Free with a Polaris Key account";
    }
    case "group":
      return path.label
        ? `Included with ${path.label}`
        : `For members of ${path.detail ?? "a group"}`;
    case "product_idp":
      return `Included with your ${path.detail ?? "product"} account`;
    case "email_domain":
      return `For everyone with a ${path.detail ?? "listed"} email`;
    case "store_owned":
      return `You own it on ${storeName(path.detail)}`;
    case "open":
      return "Free to use";
  }
}

/** "Beta · 90 days · 2 devices": the tier and its terms, as the portal's tile writes them. */
export function termsLine(terms: PolarisKeyTerms): string {
  const tier = terms.tierLabel ?? terms.tier;
  const parts: string[] = [];
  if (tier) parts.push(tier);
  if (terms.expiryDays !== null)
    parts.push(
      `${terms.expiryDays} ${terms.expiryDays === 1 ? "day" : "days"}`,
    );
  else if (!tier || tier.toLowerCase() !== "lifetime") parts.push("Lifetime");
  if (terms.deviceLimit > 0)
    parts.push(
      `${terms.deviceLimit} ${terms.deviceLimit === 1 ? "device" : "devices"}`,
    );
  return parts.join(" · ");
}

/** The tile's action, as the person reads it. */
export function tileAction(tile: PolarisKeyTile): string {
  if (tile.cta === "add") return "Add to library";
  const store = tile.stores[0];
  return store ? `Get it on ${store.label}` : "Visit the website";
}

/** Why a persona sees nothing, for the operator. */
export function hiddenCopy(
  hidden: NonNullable<PolarisKeyPreviewResponse["hidden"]>,
): string {
  switch (hidden) {
    case "storefront_off":
      return "The Polaris Key storefront is off for this deployment, so no one sees any product.";
    case "not_candidate":
      return "The product is not listed, or its customer portal is off, so no one sees it.";
    case "holds":
      return "This person already has it: it is in their Library, not on Discover.";
    case "no_path":
      return "This person has no way to add it, so the product is not shown to them.";
  }
}

/**
 * "Who can see this?" in plain language: one line per offered way to add, from the policy and
 * never from who holds what. Empty when no one does.
 */
export function whoLines(status: PolarisKeyStatusResponse): string[] {
  if (!status.enabled || !status.portalEnabled) return [];
  if (status.listing.listed === "unlisted") return [];
  const lines: string[] = [];
  for (const kind of status.active) {
    if (kind === "group")
      for (const g of status.groups)
        lines.push(
          g.label
            ? `Members of ${g.group} at the Polaris Key sign-in, shown “Included with ${g.label}”`
            : `Members of ${g.group} at the Polaris Key sign-in`,
        );
    else if (kind === "auto_issue") {
      const days = status.autoIssue?.expiryDays ?? null;
      lines.push(
        days !== null
          ? `Everyone with a Polaris Key account, as a ${days}-day free trial`
          : "Everyone with a Polaris Key account",
      );
    } else if (kind === "open")
      lines.push("Everyone signed in: it is free to use");
    else if (kind === "store_owned")
      lines.push("Store owners who linked that store");
    else if (kind === "product_idp")
      lines.push("People with an account at the product's own sign-in");
    else lines.push("People with a verified email at a listed domain");
  }
  if (status.everyone)
    lines.push("Everyone else signed in, with a link to get it");
  return lines;
}

/** Why "Who can see this?" is empty. */
export function nobodyCopy(status: PolarisKeyStatusResponse): string {
  if (!status.enabled)
    return "No one: the Polaris Key storefront is off for this deployment.";
  if (!status.portalEnabled)
    return "No one: the customer portal is off for this product.";
  if (status.listing.listed === "unlisted")
    return "No one: the product is not listed.";
  if (status.listing.listed === "auto" && status.available.length > 0)
    return "No one: Automatic lists only auto-issue and mapped groups. Choose Listed to offer the other ways.";
  return "No one: no way to add this product is configured or turned on.";
}
