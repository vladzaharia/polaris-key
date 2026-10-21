import * as React from "react";
import { LifeBuoy } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../../api.js";
import {
  SUPPORT_CODE_BAD_CHECK,
  SUPPORT_CODE_LOOKALIKE,
  formatSupportCode,
  looksLikeSupportCode,
  parseSupportCode,
} from "../../../lib/supportCode.js";
import { qk } from "../../data/queries.js";
import { r } from "../../routes.js";
import type { PaletteContext, PaletteItem, PaletteSource } from "./types.js";

/**
 * The support-code source (I-41). A query that is a support code (dashes optional, any case) asks
 * the Worker which product and user it names, and offers one row for each state: looking up, the
 * user ("Open support code XXX-XXX-XXX"), or an inert line saying why there is none. The Worker
 * answers a code the operator may not read exactly like an unknown one (404), so both read "No
 * user with support code …". A code whose check symbol fails, or that has a lookalike character,
 * is told apart locally (public math, no Worker call). Nothing is asked for any other query.
 */
export function useSupportCodeItems(
  query: string,
  ctx?: Pick<PaletteContext, "products">,
): PaletteItem[] {
  const typed = query.trim();
  const parsed = parseSupportCode(typed);
  const code = parsed.kind === "code" ? parsed.code : null;
  const found = useQuery({
    queryKey: qk.supportCode(code ?? ""),
    queryFn: () => api.supportCode(code!),
    enabled: code !== null,
    retry: false,
    staleTime: 60_000,
  });
  if (parsed.kind === "not_code") return [];
  const icon = <LifeBuoy aria-hidden className="size-4" />;
  const inert = (id: string, label: string): PaletteItem[] => [
    {
      id: `support-code:${id}`,
      group: "Support code",
      label,
      detail: "",
      keywords: typed,
      icon,
      inert: true,
    },
  ];
  // A nine-letter word is no code: only code-shaped text gets a line of its own.
  const shaped = looksLikeSupportCode(typed);
  if (parsed.kind === "lookalike")
    return inert("lookalike", SUPPORT_CODE_LOOKALIKE);
  if (parsed.kind === "bad_check")
    return inert("bad-check", SUPPORT_CODE_BAD_CHECK);
  const dashed = formatSupportCode(code!);
  if (found.isPending)
    return inert("pending", `Looking up support code ${dashed}…`);
  if (found.data) {
    const { product, subject } = found.data;
    const name = ctx?.products.find((p) => p.slug === product)?.name ?? product;
    return [
      {
        id: `support-code:${code}`,
        group: "Support code",
        label: "Open support code",
        labelMono: dashed,
        detail: name,
        // The raw query too, so a code typed without its dashes still matches the row.
        keywords: `${typed} ${code} support`,
        icon,
        href: r.user(product, subject),
      },
    ];
  }
  if (!shaped) return [];
  if (found.error instanceof ApiError && found.error.status === 429)
    return inert("limited", "Too many lookups. Try again in a minute.");
  if (found.error instanceof ApiError && found.error.status === 404)
    return inert(
      "none",
      `No user with support code ${dashed} in your products. Check it with the customer.`,
    );
  // Enter on the failure row asks again (the palette stays open).
  return [
    {
      id: "support-code:failed",
      group: "Support code",
      label: `Couldn't look up support code ${dashed}. Press Enter to try again.`,
      detail: "",
      keywords: typed,
      icon,
      keepOpen: true,
      perform: () => void found.refetch(),
    },
  ];
}

export const supportCodePaletteSource: PaletteSource = {
  id: "support-code",
  useItems: (ctx, query) => useSupportCodeItems(query, ctx),
};
