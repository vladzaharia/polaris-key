/**
 * Masthead and stretch overshoots that belong to a page's own composition, each with the package
 * that fixes it (ST-48 builds the shell; the area packages build their screens on it). The list
 * only shrinks: a full run fails when an entry no longer matches a violation, so delete the entry
 * in the change that fixes the page. It is empty now (B-235); a new page never joins it.
 */
export const MASTHEAD_DEBT: readonly {
  /** The case name (`djdl:licenses/record/keys`). */
  cases: RegExp;
  /** `rule/kind`. */
  kinds: readonly string[];
  owner: string;
  why: string;
}[] = [];
