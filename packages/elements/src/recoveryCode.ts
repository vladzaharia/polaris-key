// The recovery code as the screens draw and copy it (U-42.2). The engine hands it over as eight
// groups joined by hyphens; a host may also hand spaces, lower case or none. One normal form: strip
// spaces and hyphens, upper-case, regroup in fours.

/** The code's groups of four (the last may be shorter). */
export function recoveryGroups(code: string): string[] {
  const flat = code.replace(/[\s-]+/g, "").toUpperCase();
  return flat.match(/.{1,4}/g) ?? [];
}

/** What Copy code writes: the groups joined by hyphens, as the engine hands the code over. */
export const copyForm = (groups: readonly string[]): string => groups.join("-");

/** The groups as a screen reader says them: one character at a time, a comma between groups so it
 *  pauses ("K 7 Q F, 2 M 9 D"). */
export const spokenForm = (groups: readonly string[]): string =>
  groups.map((g) => [...g].join(" ")).join(", ");
