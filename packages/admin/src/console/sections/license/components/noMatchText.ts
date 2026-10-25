import { LICENSE_STATE_LABELS } from "./shared.js";

/** "No floating Studio license has a name, email or id containing “Q2KD-88”." */
export function noMatchText(
  state: { q: string; filters: Record<string, string[]> },
  words: Record<"holder" | "tier", (value: string) => string>,
): string {
  // Holder words are common nouns ("floating"); a tier keeps its name ("Studio").
  const pick = (id: "holder" | "tier"): string =>
    (state.filters[id] ?? [])
      .map((v) => (id === "holder" ? words[id](v).toLowerCase() : words[id](v)))
      .join(" or ");
  const q = state.q.trim();
  const who = [pick("holder"), pick("tier")].filter(Boolean).join(" ");
  const what = `${who ? `${who} ` : ""}license`;
  // The other facets, named: "is Disabled on beta". A facet with no words of its own stays out.
  const status = (state.filters.status ?? []).map(
    (v) => LICENSE_STATE_LABELS[v as keyof typeof LICENSE_STATE_LABELS] ?? v,
  );
  const channel = state.filters.channel ?? [];
  const others = [
    status.length ? `is ${status.join(" or ")}` : "",
    channel.length ? `on ${channel.join(" or ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const more = Object.entries(state.filters).some(
    ([id, v]) =>
      v.length > 0 && !["holder", "tier", "status", "channel"].includes(id),
  );
  if (q)
    return `No ${what} has a name, email or id containing “${q}”${others ? ` and ${others}` : ""}${more ? " under the other filters" : ""}.`;
  return `No ${what} ${others || "matches"}${more ? " under the other filters" : ""}.`;
}
