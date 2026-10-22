import * as React from "react";
import { CircleAlert, KeyRound, Loader, UsersRound } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ApiError, type SearchLicenseDto } from "../../../api.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { r } from "../../routes.js";
import type { PaletteContext, PaletteItem, PaletteSource } from "./types.js";

/** A pause in typing before the Worker is asked, and the shortest query worth asking about. */
export const ENTITY_SEARCH_DELAY_MS = 250;
export const ENTITY_SEARCH_MIN = 2;

/** A licence key: `pkey_<product>_<22 base64url>`, the shape the Worker resolves by hash. */
const KEY_SHAPE = /^pkey_[a-z0-9-]+_[A-Za-z0-9_-]{22}$/;

/** Rows a group shows before "Show all N": enough to find the one, never a wall. */
export const ENTITY_GROUP_SHOWN = 5;

/** `value`, settled after `ms`. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const SEARCHING = "Searching licenses and people…";
const FAILED = "Couldn't search licenses and people. Try again.";

/** A license as a row: who, the holder's email, the product and the tier; its issue as a pill. */
function licenseRow(
  l: SearchLicenseDto,
  opts: { id: string; group: string; label?: string; keywords: string },
): PaletteItem {
  const expired = l.expiresAt !== null && l.expiresAt * 1000 < Date.now();
  const who = l.name || l.email || l.id;
  return {
    id: opts.id,
    group: opts.group,
    label: opts.label ?? who,
    detail: [opts.label ? who : l.name ? l.email : null, l.productName, l.tier]
      .filter(Boolean)
      .join(" · "),
    keywords: opts.keywords,
    icon: <KeyRound aria-hidden className="size-4" />,
    href: r.license(l.product, l.id),
    recordName: who,
    ...(l.status === "disabled"
      ? { issue: { tone: "warning" as const, label: "Disabled" } }
      : expired
        ? { issue: { tone: "warning" as const, label: "Expired" } }
        : {}),
  };
}

/**
 * The entity source (ST-52, EXPERIENCE.md §0.3 J-1): licenses and users from `POST
 * /manage/api/search`, scoped by the Worker to what the member can read, and a pasted licence key
 * resolved to its license.
 *
 * - A pasted key is asked at once and shown under "Pasted key", drawn like a license row. It never
 *   reaches a URL, a row id, an href or the recents. A key that resolves to nothing (unknown, or a
 *   license the member may not read: the Worker cannot tell them apart) reads as an inert "No
 *   license for this key in your products."
 * - Any other text of two or more characters is asked after a pause. The last answer stays on
 *   screen while the next is on its way, and an inert "Searching…" line stands in until there is
 *   one, so the palette never claims "Nothing matches" before the search has answered.
 * - Each group shows 5; "Show all N" expands it in place.
 * - Nothing is asked for an empty or one-character query.
 */
export function useEntityItems(
  query: string,
  ctx?: Pick<PaletteContext, "products">,
): PaletteItem[] {
  const typed = query.trim();
  const isKey = KEY_SHAPE.test(typed);
  const settled = useSettled(typed, isKey ? 0 : ENTITY_SEARCH_DELAY_MS);
  const enabled = typed.length >= ENTITY_SEARCH_MIN && settled === typed;
  const found = useQuery({
    queryKey: qk.search(typed),
    // A read sent as POST (the key stays out of the URL): it declares no invalidation.
    queryFn: () => mutate("search", typed),
    enabled,
    retry: false,
    staleTime: 30_000,
    // A pasted key is held in memory only as long as it is on screen.
    gcTime: isKey ? 0 : 5 * 60_000,
    placeholderData: isKey ? undefined : keepPreviousData,
  });
  const [expanded, setExpanded] = React.useState<{
    q: string;
    groups: string[];
  }>({ q: "", groups: [] });
  if (typed.length < ENTITY_SEARCH_MIN) return [];
  const open = expanded.q === typed ? expanded.groups : [];

  const line = (
    id: string,
    group: string,
    label: string,
    icon: React.ReactNode = <KeyRound aria-hidden className="size-4" />,
  ): PaletteItem => ({
    id: `entity:${id}`,
    group,
    label,
    detail: "",
    keywords: typed,
    icon,
    inert: true,
  });
  const group = isKey ? "Pasted key" : "Licenses";
  if (found.error && !found.isFetching) {
    const limited =
      found.error instanceof ApiError && found.error.status === 429;
    const icon = <CircleAlert aria-hidden className="size-4" />;
    if (limited)
      return [
        line(
          "limited",
          group,
          "Too many searches. Try again in a minute.",
          icon,
        ),
      ];
    return [
      {
        ...line(
          "failed",
          group,
          isKey ? "Couldn't look up this key. Try again." : FAILED,
          icon,
        ),
        inert: false,
        keepOpen: true,
        perform: () => void found.refetch(),
      },
    ];
  }
  const waiting = typed !== settled || found.isFetching;
  if (isKey) {
    if (!found.data)
      return [
        line(
          "key-pending",
          group,
          "Looking up license key…",
          <Loader aria-hidden className="size-4" />,
        ),
      ];
    const hit = found.data.key;
    if (!hit)
      return [
        line("key-none", group, "No license for this key in your products."),
      ];
    return [
      licenseRow(hit, {
        id: `entity:key:${hit.product}:${hit.licenseId}`,
        group,
        label: "Open license for this key",
        keywords: typed,
      }),
    ];
  }
  const data = found.data;
  const rows: PaletteItem[] = [];
  const addGroup = (
    heading: string,
    noun: string,
    all: PaletteItem[],
  ): void => {
    const shown = open.includes(heading)
      ? all
      : all.slice(0, ENTITY_GROUP_SHOWN);
    rows.push(...shown);
    if (all.length > shown.length)
      rows.push({
        id: `entity:more:${heading}`,
        group: heading,
        label: `Show all ${all.length} ${noun}`,
        detail: "",
        keywords: typed,
        icon: <KeyRound aria-hidden className="size-4" />,
        keepOpen: true,
        capped: { shown: shown.length, total: all.length, noun },
        perform: () => setExpanded({ q: typed, groups: [...open, heading] }),
      });
  };
  addGroup(
    "Licenses",
    "licenses",
    (data?.licenses ?? []).map((l) =>
      licenseRow(l, {
        id: `entity:license:${l.product}:${l.id}`,
        group: "Licenses",
        keywords: typed,
      }),
    ),
  );
  addGroup(
    "Users",
    "users",
    (data?.people ?? []).map((p) => ({
      id: `entity:person:${p.product}:${p.subject}`,
      group: "Users",
      label: p.name || p.email || "Unnamed user",
      detail: [p.name ? p.email : null, p.productName]
        .filter(Boolean)
        .join(" · "),
      keywords: typed,
      icon: <UsersRound aria-hidden className="size-4" />,
      href: r.user(p.product, p.subject),
      recordName: p.name || p.email || "Unnamed user",
    })),
  );
  if (rows.length === 0 && (waiting || !data))
    return [
      line(
        "searching",
        "Licenses",
        SEARCHING,
        <Loader aria-hidden className="size-4" />,
      ),
    ];
  void ctx;
  return rows;
}

export const entitiesPaletteSource: PaletteSource = {
  id: "entities",
  useItems: (ctx, query) => useEntityItems(query, ctx),
};
