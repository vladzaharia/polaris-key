/**
 * Customer-facing copy from the kit copy catalog (`@polaris-key/brand/kit-copy`; SIGN-IN.md D-41).
 *
 * `t(key, args)` is the one way the customer portal gets a string the catalog already words: the
 * same sentence the SDK kits, the terminal and the hosted card show, so a catalog edit moves every
 * surface at once. English only: the portal has no locale picker yet, and the table already holds
 * the core copy under `core.*` (refusal and gate wording), so a refusal code resolves through
 * `core.codes.<code>.title` and `.message`.
 *
 * The formatter is ui-core's ICU subset (plain arguments, at most one plural or select). A missing
 * argument stays visible as `{name}`, and an unknown key throws, so a typo fails a test rather than
 * showing as a blank. `test/portalCopy.test.ts` fails when a portal file spells out a sentence the
 * catalog holds.
 */
import { KIT_COPY_EN, type KitCopyKey } from "@polaris-key/brand/kit-copy";
import { Copy, type CopyArgs } from "@polaris-key/ui-core";

const english = new Copy({ tables: { en: KIT_COPY_EN }, locale: "en" });

export type { CopyArgs, KitCopyKey };

/** The catalog string for `key` with `args` filled in. */
export function t(key: KitCopyKey, args?: CopyArgs): string {
  return english.format(key, args);
}

/** Whether the catalog holds `key` (a refusal code the catalog does not word has no key). */
export function hasCopy(key: string): key is KitCopyKey {
  return english.has(key);
}

const SLOT = "\u0001";

/**
 * A message split around arguments the caller renders itself (a bold address inside a sentence).
 * Each `slots` name comes back as `{ slot }` where the argument sits; the rest is text. Other
 * arguments are filled in as with `t`.
 */
export function tParts(
  key: KitCopyKey,
  slots: readonly string[],
  args?: CopyArgs,
): Array<string | { slot: string }> {
  const marked: Record<string, string | number> = { ...args };
  for (const name of slots) marked[name] = `${SLOT}${name}${SLOT}`;
  return english
    .format(key, marked)
    .split(SLOT)
    .map((piece, i) => (i % 2 === 1 ? { slot: piece } : piece))
    .filter((piece) => piece !== "");
}
