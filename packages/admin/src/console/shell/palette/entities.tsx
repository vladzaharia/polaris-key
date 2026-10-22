import * as React from "react";
import { KeyRound, Mail, ScrollText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../../api.js";
import { qk } from "../../data/queries.js";
import { r } from "../../routes.js";
import type { PaletteContext, PaletteItem, PaletteSource } from "./types.js";

/** A pause in typing before the Worker is asked, and the shortest query worth asking about. */
export const ENTITY_SEARCH_DELAY_MS = 250;
export const ENTITY_SEARCH_MIN = 2;

/** A licence key: `pkey_<product>_<22 base64url>`, the shape the Worker resolves by hash. */
const KEY_SHAPE = /^pkey_[a-z0-9-]+_[A-Za-z0-9_-]{22}$/;

/** `value`, settled after `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * The entity source (ST-52, EXPERIENCE.md §0.3 J-1): licenses and people from `GET
 * /manage/api/search`, scoped by the Worker to what the member can read, and a pasted licence key
 * resolved to its license.
 *
 * - A pasted key is asked at once and shown under "Pasted key". The key never reaches a row id,
 *   an href or the recents; the row opens the license it names. A key that resolves to nothing
 *   (unknown, or a license the member may not read: the Worker cannot tell them apart) reads as
 *   an inert "No license for this key in your products."
 * - Any other text of two or more characters is asked after a pause. Rows come under "Licenses"
 *   and "People", each a sentence: who, the holder's email, and the product.
 * - Nothing is asked for an empty or one-character query.
 */
export function useEntityItems(
  query: string,
  ctx?: Pick<PaletteContext, "products">,
): PaletteItem[] {
  const typed = query.trim();
  const isKey = KEY_SHAPE.test(typed);
  const settled = useSettled(typed, isKey ? 0 : ENTITY_SEARCH_DELAY_MS);
  const asked = isKey ? typed : settled;
  const enabled = asked.length >= ENTITY_SEARCH_MIN && asked === typed;
  const found = useQuery({
    queryKey: qk.search(asked),
    queryFn: () => api.search(asked),
    enabled,
    retry: false,
    staleTime: 30_000,
    // A pasted key is held in memory only as long as it is on screen.
    gcTime: isKey ? 0 : 5 * 60_000,
  });
  if (typed.length < ENTITY_SEARCH_MIN) return [];
  const inert = (id: string, group: string, label: string): PaletteItem[] => [
    {
      id: `entity:${id}`,
      group,
      label,
      detail: "",
      keywords: typed,
      icon: <KeyRound aria-hidden className="size-4" />,
      inert: true,
    },
  ];
  if (isKey) {
    if (found.isPending && enabled)
      return inert("key-pending", "Pasted key", "Looking up license key…");
    if (found.error)
      return failure(found.error, typed, "Pasted key", () => found.refetch());
    const hit = found.data?.key;
    if (!hit)
      return found.data
        ? inert(
            "key-none",
            "Pasted key",
            "No license for this key in your products.",
          )
        : [];
    const name = ctx?.products.find((p) => p.slug === hit.product)?.name;
    return [
      {
        id: `entity:key:${hit.product}:${hit.licenseId}`,
        group: "Pasted key",
        label: "Open license for this key",
        detail: `${name ?? hit.product} · ${hit.licenseId}`,
        keywords: typed,
        icon: <KeyRound aria-hidden className="size-4" />,
        href: r.license(hit.product, hit.licenseId),
      },
    ];
  }
  if (!enabled || !found.data) {
    if (found.error)
      return failure(found.error, typed, "Licenses", () => found.refetch());
    return [];
  }
  const rows: PaletteItem[] = [];
  for (const l of found.data.licenses) {
    const expired = l.expiresAt !== null && l.expiresAt * 1000 < Date.now();
    rows.push({
      id: `entity:license:${l.product}:${l.id}`,
      group: "Licenses",
      label: l.name || l.email || l.id,
      detail: [l.name ? l.email : null, l.productName]
        .filter(Boolean)
        .join(" · "),
      keywords: typed,
      icon: <ScrollText aria-hidden className="size-4" />,
      href: r.license(l.product, l.id),
      ...(l.status === "disabled"
        ? { issue: { tone: "warning" as const, label: "Disabled" } }
        : expired
          ? { issue: { tone: "warning" as const, label: "Expired" } }
          : {}),
    });
  }
  for (const p of found.data.people)
    rows.push({
      id: `entity:person:${p.product}:${p.subject}`,
      group: "People",
      label: p.name || p.email || "Unnamed person",
      detail: [p.name ? p.email : null, p.productName]
        .filter(Boolean)
        .join(" · "),
      keywords: typed,
      icon: <Mail aria-hidden className="size-4" />,
      href: r.user(p.product, p.subject),
    });
  return rows;
}

/** A failed search: rate-limited says so, anything else offers Enter to ask again. */
function failure(
  error: unknown,
  typed: string,
  group: string,
  retry: () => unknown,
): PaletteItem[] {
  const icon = <KeyRound aria-hidden className="size-4" />;
  if (error instanceof ApiError && error.status === 429)
    return [
      {
        id: "entity:limited",
        group,
        label: "Too many searches. Try again in a minute.",
        detail: "",
        keywords: typed,
        icon,
        inert: true,
      },
    ];
  return [
    {
      id: "entity:failed",
      group,
      label: "Couldn't search. Press Enter to try again.",
      detail: "",
      keywords: typed,
      icon,
      keepOpen: true,
      perform: () => void retry(),
    },
  ];
}

export const entitiesPaletteSource: PaletteSource = {
  id: "entities",
  useItems: (ctx, query) => useEntityItems(query, ctx),
};
