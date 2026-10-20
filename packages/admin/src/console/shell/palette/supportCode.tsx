import * as React from "react";
import { LifeBuoy } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api.js";
import {
  formatSupportCode,
  normalizeSupportCode,
} from "../../../lib/supportCode.js";
import { qk } from "../../data/queries.js";
import { r } from "../../routes.js";
import type { PaletteItem, PaletteSource } from "./types.js";

/**
 * The support-code source (I-41). A query that is a support code (dashes optional, any case) asks
 * the Worker which product and user it names, and offers one row, "Open support code XXX-XXX-XXX",
 * that jumps to that user. The Worker answers a code the operator may not read exactly like an
 * unknown one (404), so no row appears for either. Nothing is asked for any other query.
 */
export function useSupportCodeItems(query: string): PaletteItem[] {
  const code = normalizeSupportCode(query.trim());
  const found = useQuery({
    queryKey: qk.supportCode(code ?? ""),
    queryFn: () => api.supportCode(code!),
    enabled: code !== null,
    retry: false,
    staleTime: 60_000,
  });
  if (!code || !found.data) return [];
  const { product, subject } = found.data;
  const dashed = formatSupportCode(code);
  return [
    {
      id: `support-code:${code}`,
      group: "Support code",
      label: `Open support code ${dashed}`,
      detail: product,
      // The raw query too, so a code typed without its dashes still matches the row.
      keywords: `${query.trim()} ${code} support`,
      icon: <LifeBuoy aria-hidden className="size-4" />,
      href: r.user(product, subject),
    },
  ];
}

export const supportCodePaletteSource: PaletteSource = {
  id: "support-code",
  useItems: (_ctx, query) => useSupportCodeItems(query),
};
