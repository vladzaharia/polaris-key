/**
 * Help messages: the copy catalog's consumer-facing titles, and the map from message id to the
 * Help page that explains it (docs plan §7.1, §7.5).
 *
 * The catalog (`conformance/parity/copy.en.json`) owns every title and message. This module reads
 * it, so a copy change reaches Help on the next build. `help-messages.json` owns the grouping.
 * `<HelpMessage id>` renders the pair; `helpMessages.test.ts` (DOC-05a) turns "every catalog key
 * is in exactly one entry or the developer-only list" into a failing test.
 */

import catalog from "../../../../conformance/parity/copy.en.json";
import data from "../../help-messages.json";

export interface CatalogEntry {
  title: string;
  message: string;
}

interface Catalog {
  fallback: CatalogEntry;
  codes: Record<string, CatalogEntry>;
  gate: Record<string, CatalogEntry>;
  activation: Record<string, CatalogEntry>;
}

export interface HelpMessagesData {
  version: 1;
  pages: Record<string, { title: string; group?: string }>;
  messages: Record<
    string,
    {
      page: string;
      entry?: string;
      article?: string;
      why?: string;
      fix?: string;
    }
  >;
  developerOnly: string[];
}

/**
 * A message id: a `codes` key as it is (server codes use `_`, client codes use `-`),
 * `gate.<key>`, `activation.<key>` or `fallback`. The dot keeps `activation.device-limit` apart
 * from the `device_limit` and `device-limit` code keys.
 */
export const MESSAGE_ID =
  /^(?:fallback|(?:gate|activation)\.[a-z0-9]+(?:-[a-z0-9]+)*|[a-z0-9]+(?:[_-][a-z0-9]+)*)$/;

/** Every catalog entry by message id. */
export function catalogEntries(source: Catalog): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  out.set("fallback", source.fallback);
  for (const [k, v] of Object.entries(source.codes)) out.set(k, v);
  for (const [k, v] of Object.entries(source.gate)) out.set(`gate.${k}`, v);
  for (const [k, v] of Object.entries(source.activation))
    out.set(`activation.${k}`, v);
  return out;
}

export const CATALOG_ENTRIES = catalogEntries(catalog as unknown as Catalog);
export const HELP_MESSAGES = data as unknown as HelpMessagesData;

/** The URL a kit or an own-UI app links to for a message id (docs plan §7.4). */
export const helpCodePath = (id: string): string => `/docs/help/code/${id}/`;

/** The problems with a `help-messages.json` document; empty when it is well formed. */
export function validateHelpMessages(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
): string[] {
  const problems: string[] = [];
  if (doc.version !== 1) problems.push("version must be 1");
  const pageKeys = new Set(Object.keys(doc.pages));
  if (!pageKeys.has("index")) problems.push('pages has no "index"');
  const owner = new Map<string, string>();
  for (const [id, entry] of Object.entries(doc.messages)) {
    if (!MESSAGE_ID.test(id)) problems.push(`${id}: not a message id`);
    if (!known.has(id)) problems.push(`${id}: not in the copy catalog`);
    if (!pageKeys.has(entry.page) || entry.page === "index")
      problems.push(`${id}: page "${entry.page}" is not a messages page`);
    if (entry.entry !== undefined) {
      const first = owner.get(entry.entry);
      if (first === undefined) owner.set(entry.entry, id);
      else if (known.get(first)?.title !== known.get(id)?.title)
        problems.push(
          `${id}: shares entry "${entry.entry}" with ${first} but not its title`,
        );
    }
  }
  for (const id of doc.developerOnly) {
    if (!known.has(id))
      problems.push(`${id}: developer-only id not in the copy catalog`);
    if (id in doc.messages)
      problems.push(`${id}: both a message and developer-only`);
  }
  return problems;
}
