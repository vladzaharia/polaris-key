/**
 * The grant stored for a chosen channel list: `dev` includes `beta` (the include chain
 * dev ⊇ beta ⊇ stable), so choosing `dev` stores `beta` with it. Applied once on every write path
 * (the manifest's tier parse, and the Worker's tier and licence writes), so every writer stores
 * the same thing; the wire predicate never infers it, and a grant already stored is matched as it
 * is. `beta` goes just before the first `dev`; a list that holds `beta` already is unchanged.
 */
export function withIncludedChannels(channels: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of channels) {
    if (c === "dev" && !channels.includes("beta") && !out.includes("beta"))
      out.push("beta");
    out.push(c);
  }
  return out;
}
