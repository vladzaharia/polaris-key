/**
 * Help messages: the copy catalog's consumer-facing titles, and the map from message id to the
 * Help page that explains it (docs plan §7.1, §7.5).
 *
 * The catalog (`conformance/parity/copy.en.json`) owns every title and message. This module reads
 * it, so a copy change reaches Help on the next build. The customer portal words a few errors
 * itself (`packages/admin/src/portal/errors.ts`); `help-messages.json` mirrors them under
 * `portal`, as the ids `portal.<key>`, and `helpMessages.test.ts` fails when the mirror and
 * `errors.ts` disagree. `help-messages.json` owns the grouping and the plain-language Why and
 * What to do. `<HelpMessage id>` renders an entry; `helpMessages.test.ts` turns "every catalog key
 * and every portal error is in exactly one entry or the developer-only list" into a failing test.
 *
 * The model: an id is one message. Ids that carry the same on-screen title share one **entry**
 * (one heading); the id that comes first in the file owns the heading and its anchor. Inside an
 * entry, ids with the same on-screen message form one **branch**; the first id of a branch holds
 * its Why and What to do, and the others inherit them. A title with two causes is one entry with
 * two branches, and every id keeps its own anchor.
 *
 * This module imports JSON only (no `import.meta.glob`), so Vite, vitest and tsx all load it.
 */

import catalog from "../../../../conformance/parity/copy.en.json";
import de from "../../../../conformance/parity/copy.de.json";
import es from "../../../../conformance/parity/copy.es.json";
import it from "../../../../conformance/parity/copy.it.json";
import ja from "../../../../conformance/parity/copy.ja.json";
import ko from "../../../../conformance/parity/copy.ko.json";
import ptBR from "../../../../conformance/parity/copy.pt-BR.json";
import zhHans from "../../../../conformance/parity/copy.zh-Hans.json";
import data from "../../help-messages.json";

export interface CatalogEntry {
  title: string;
  message: string;
}

export interface Catalog {
  /** A BCP-47 tag; the translated catalogs carry it (`copy.<locale>.json`). */
  locale?: string;
  fallback: CatalogEntry;
  codes: Record<string, CatalogEntry>;
  gate: Record<string, CatalogEntry>;
  activation: Record<string, CatalogEntry>;
}

/**
 * The links a message can end with, after What to do (the schema's `cta`): `library` is Open your
 * library, `contact` is the pointer to who to ask when the fix may not be the reader's alone.
 */
export const CTA_ACTIONS = ["library", "contact"] as const;
export type CtaAction = (typeof CTA_ACTIONS)[number];

/** The Help article the `contact` cta links to (a path under `help/`): who to ask about an app. */
export const CONTACT_ARTICLE = "contact";

export interface HelpMessage {
  /** A key of `pages`, other than `index`. */
  page: string;
  /** Ids with one title share an entry. The entry is named after the id that owns its heading. */
  entry?: string;
  /** A shipped Help article (a path under `help/`) the message links to. */
  article?: string;
  /** Why you see this. On the first id of each distinct on-screen message. */
  why?: string;
  /** What to do. On the first id of each distinct on-screen message. */
  fix?: string;
  /** A link that ends What to do: `library` or `contact`. On the first id of each distinct on-screen message. */
  cta?: CtaAction;
}

export interface HelpMessagesData {
  version: 1;
  pages: Record<string, { title: string; group?: string }>;
  /** The portal's own error copy, keyed as in `errors.ts`; the message ids are `portal.<key>`. */
  portal?: Record<string, CatalogEntry>;
  messages: Record<string, HelpMessage>;
  developerOnly: string[];
}

/**
 * A message id: a `codes` key as it is (server codes use `_`, client codes use `-`),
 * `gate.<key>`, `activation.<key>`, `portal.<key>` or `fallback`. The dot keeps
 * `activation.device-limit` apart from the `device_limit` and `device-limit` code keys.
 */
export const MESSAGE_ID =
  /^(?:fallback|(?:gate|activation)\.[a-z0-9]+(?:-[a-z0-9]+)*|portal\.[a-z0-9]+(?:[_-][a-z0-9]+)*|[a-z0-9]+(?:[_-][a-z0-9]+)*)$/;

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

/** The portal's own messages by id: `portal.<key>`. */
export function portalEntries(
  portal: HelpMessagesData["portal"],
): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const [key, value] of Object.entries(portal ?? {}))
    out.set(`portal.${key}`, value);
  return out;
}

export const CATALOG_ENTRIES = catalogEntries(catalog as unknown as Catalog);
export const HELP_MESSAGES = data as unknown as HelpMessagesData;
export const PORTAL_ENTRIES = portalEntries(HELP_MESSAGES.portal);

/** Everything that has a title and a message: the copy catalog and the portal's own copy. */
export const KNOWN_ENTRIES: ReadonlyMap<string, CatalogEntry> = new Map([
  ...CATALOG_ENTRIES,
  ...PORTAL_ENTRIES,
]);

/**
 * The translated catalogs (`conformance/parity/copy.<locale>.json`), by locale. A new locale file
 * joins this list, and `helpMessages.test.ts` fails until it does.
 */
export const TRANSLATED_CATALOGS: Readonly<Record<string, Catalog>> = {
  de: de as unknown as Catalog,
  es: es as unknown as Catalog,
  it: it as unknown as Catalog,
  ja: ja as unknown as Catalog,
  ko: ko as unknown as Catalog,
  "pt-BR": ptBR as unknown as Catalog,
  "zh-Hans": zhHans as unknown as Catalog,
};

/** The URL a kit or an own-UI app links to for a message id (docs plan §7.4). */
export const helpCodePath = (id: string): string => `/docs/help/code/${id}/`;

/** The Help page of an id: its messages page, or Other messages for a developer-only id. */
export function pageOfId(
  doc: HelpMessagesData,
  id: string,
): string | undefined {
  const message = doc.messages[id];
  if (message !== undefined) return message.page;
  return doc.developerOnly.includes(id) ? "other" : undefined;
}

/** Where an id's heading or code sits: `/docs/help/messages/<page>/#<id>`. */
export function helpMessageUrl(doc: HelpMessagesData, id: string): string {
  const page = pageOfId(doc, id);
  if (page === undefined) throw new Error(`${id}: not in help-messages.json`);
  return `/docs/help/messages/${page}/#${id}`;
}

/**
 * The link to a Help article (a path under `help/`): the "More help" of a message, and the page the
 * `contact` cta points at. None when the page showing the message is that article (a link to the
 * page you are on says nothing). `pathname` is the page's path with the site base, with or without
 * its trailing slash.
 */
export function articleHref(
  article: string | undefined,
  pathname: string,
): string | undefined {
  if (article === undefined) return undefined;
  const href = `/docs/help/${article}/`;
  return pathname.replace(/\/?$/, "/") === href ? undefined : href;
}

// ── placeholders ─────────────────────────────────────────────────────────────────────────────

/**
 * What a reader sees where a catalog message holds a placeholder: the app fills these in, the
 * page names what goes there. The set is the catalog schema's closed set (copy.schema.json).
 */
export const PLACEHOLDER_LABELS: Readonly<Record<string, string>> = {
  product: "app name",
  code: "code",
  detail: "details",
  limit: "number",
  deviceCount: "number",
  retryAfterSeconds: "seconds",
};

export type MessagePart = string | { placeholder: string; label: string };

/** A catalog message split around its `{placeholders}`. */
export function messageParts(message: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of message.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    const label = PLACEHOLDER_LABELS[name];
    if (label === undefined)
      throw new Error(
        `placeholder {${name}} has no label in PLACEHOLDER_LABELS`,
      );
    const at = m.index ?? 0;
    if (at > last) parts.push(message.slice(last, at));
    parts.push({ placeholder: name, label });
    last = at + m[0].length;
  }
  if (last < message.length) parts.push(message.slice(last));
  return parts;
}

export type TextPart = string | { strong: string };

/**
 * A Why or What to do text split around its `**UI labels**`: a label is bold, exactly as the
 * screen shows it (style guide §3). Nothing else in these texts is markup.
 */
export function textParts(text: string): TextPart[] {
  return text
    .split(/\*\*(.+?)\*\*/)
    .map((piece, i): TextPart => (i % 2 === 1 ? { strong: piece } : piece))
    .filter((piece) => piece !== "");
}

// ── entries ──────────────────────────────────────────────────────────────────────────────────

/** Ids of one entry that show the same message. The first id holds the Why and What to do. */
export interface EntryBranch {
  ids: string[];
  message: string;
  why: string | undefined;
  fix: string | undefined;
  cta: CtaAction | undefined;
  article: string | undefined;
}

/** One heading on a messages page: the title, and one branch per distinct message. */
export interface HelpEntry {
  /** The id that owns the heading and its anchor: the first id of the entry. */
  id: string;
  title: string;
  page: string;
  ids: string[];
  branches: EntryBranch[];
}

/** The branches of some ids: grouped by message, in file order. */
function branchesOf(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
  ids: readonly string[],
): EntryBranch[] {
  const byMessage = new Map<string, string[]>();
  for (const id of ids) {
    const message = known.get(id)?.message ?? "";
    byMessage.set(message, [...(byMessage.get(message) ?? []), id]);
  }
  return [...byMessage].map(([message, group]) => {
    const owner = doc.messages[group[0]!];
    const article = group
      .map((id) => doc.messages[id]?.article)
      .find((a) => a !== undefined);
    return {
      ids: group,
      message,
      why: owner?.why,
      fix: owner?.fix,
      cta: owner?.cta,
      article,
    };
  });
}

/** The entry key of an id: its `entry`, or the id itself. */
const entryKeyOf = (doc: HelpMessagesData, id: string): string =>
  doc.messages[id]?.entry ?? id;

/** Every entry of the document, in file order (the order the pages show them). */
export function helpEntries(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
): HelpEntry[] {
  const byKey = new Map<string, string[]>();
  for (const id of Object.keys(doc.messages)) {
    const key = entryKeyOf(doc, id);
    byKey.set(key, [...(byKey.get(key) ?? []), id]);
  }
  return [...byKey.values()].map((ids) => {
    const id = ids[0]!;
    return {
      id,
      title: known.get(id)?.title ?? "",
      page: doc.messages[id]!.page,
      ids,
      branches: branchesOf(doc, known, ids),
    };
  });
}

/** The entry an id belongs to, or undefined for an id the map does not hold. */
export function entryOf(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
  id: string,
): HelpEntry | undefined {
  if (doc.messages[id] === undefined) return undefined;
  const key = entryKeyOf(doc, id);
  return helpEntries(doc, known).find((e) => entryKeyOf(doc, e.id) === key);
}

/**
 * One id on its own, for an article that carries a message's anchor: its title, its message and
 * the Why and What to do of the branch it belongs to. An id the map does not hold shows its title
 * and message only.
 */
export function singleOf(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
  id: string,
): { id: string; title: string; branch: EntryBranch } | undefined {
  const base = known.get(id);
  if (base === undefined) return undefined;
  const entry = entryOf(doc, known, id);
  const branch = entry?.branches.find((b) => b.ids.includes(id)) ?? {
    ids: [id],
    message: base.message,
    why: undefined,
    fix: undefined,
    cta: undefined,
    article: undefined,
  };
  return { id, title: base.title, branch: { ...branch, ids: [id] } };
}

// ── aliases ──────────────────────────────────────────────────────────────────────────────────

export interface Alias {
  lang: string;
  title: string;
}

const translatedEntries = new Map<Catalog, Map<string, CatalogEntry>>();
function entriesOfPack(pack: Catalog): Map<string, CatalogEntry> {
  let entries = translatedEntries.get(pack);
  if (entries === undefined) {
    entries = catalogEntries(pack);
    translatedEntries.set(pack, entries);
  }
  return entries;
}

/**
 * The search aliases of some ids: their titles in every translated catalog, so a reader who saw
 * the message in German finds the entry. A title that repeats the English one, or another
 * locale's, adds nothing and is left out.
 */
export function aliasesFor(
  ids: readonly string[],
  english: ReadonlyMap<string, CatalogEntry> = KNOWN_ENTRIES,
  packs: Readonly<Record<string, Catalog>> = TRANSLATED_CATALOGS,
): Alias[] {
  const seen = new Set(
    ids.map((id) => english.get(id)?.title.toLowerCase()).filter(Boolean),
  );
  const out: Alias[] = [];
  for (const lang of Object.keys(packs).sort()) {
    const entries = entriesOfPack(packs[lang]!);
    for (const id of ids) {
      const title = entries.get(id)?.title;
      if (title === undefined || title.includes("{")) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lang, title });
    }
  }
  return out;
}

// ── the developer-only list and the A to Z index ─────────────────────────────────────────────

export interface DeveloperOnlyGroup {
  title: string;
  /** One row per distinct message of the title, with every id that shows it. */
  messages: { message: string; ids: string[] }[];
}

/** The developer-only ids grouped by title, then by message, in file order. */
export function developerOnlyGroups(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
): DeveloperOnlyGroup[] {
  const groups = new Map<string, DeveloperOnlyGroup>();
  for (const id of doc.developerOnly) {
    const entry = known.get(id);
    if (entry === undefined) continue;
    let group = groups.get(entry.title);
    if (group === undefined) {
      group = { title: entry.title, messages: [] };
      groups.set(entry.title, group);
    }
    const row = group.messages.find((m) => m.message === entry.message);
    if (row === undefined)
      group.messages.push({ message: entry.message, ids: [id] });
    else row.ids.push(id);
  }
  return [...groups.values()];
}

export interface IndexRow {
  title: string;
  /** The id whose anchor the row links to. */
  id: string;
  page: string;
  pageTitle: string;
}

const COLLATOR = new Intl.Collator("en", {
  sensitivity: "base",
  ignorePunctuation: true,
});

/** Every title a reader can see, A to Z, each with the anchor that explains it. */
export function indexRows(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
): IndexRow[] {
  const rows: IndexRow[] = [
    ...helpEntries(doc, known).map((e) => ({
      title: e.title,
      id: e.id,
      page: e.page,
    })),
    ...developerOnlyGroups(doc, known).map((g) => ({
      title: g.title,
      id: g.messages[0]!.ids[0]!,
      page: "other",
    })),
  ].map((r) => ({ ...r, pageTitle: doc.pages[r.page]?.title ?? r.page }));
  return rows.sort((a, b) => COLLATOR.compare(a.title, b.title));
}

export interface IndexSection {
  /** The first letter of its titles, upper case. */
  letter: string;
  /** The anchor of the letter's heading. */
  id: string;
  rows: IndexRow[];
}

/** The index rows grouped by the first letter of the title, in order. */
export function indexSections(rows: readonly IndexRow[]): IndexSection[] {
  const sections = new Map<string, IndexSection>();
  for (const row of rows) {
    const letter = row.title.charAt(0).toUpperCase();
    let section = sections.get(letter);
    if (section === undefined) {
      section = { letter, id: `letter-${letter.toLowerCase()}`, rows: [] };
      sections.set(letter, section);
    }
    section.rows.push(row);
  }
  return [...sections.values()];
}

/** One "On this page" item, as Starlight's route data holds it. */
export interface TocItem {
  depth: number;
  slug: string;
  text: string;
  children: TocItem[];
}

/**
 * The headings a Help messages page gets from its components, not from its Markdown, so
 * Starlight's heading collector never sees them: one item per entry on a group page, one per
 * letter on the A to Z index. `routeId` is the page's Starlight id (`help/messages/<page>`);
 * any other page has none.
 */
export function messageToc(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
  routeId: string,
): TocItem[] {
  const match = /^help\/messages(?:\/([^/]+))?$/.exec(routeId);
  const page = match === null ? undefined : (match[1] ?? "index");
  if (page === undefined || !Object.hasOwn(doc.pages, page)) return [];
  const item = (slug: string, text: string): TocItem => ({
    depth: 2,
    slug,
    text,
    children: [],
  });
  return page === "index"
    ? indexSections(indexRows(doc, known)).map((s) => item(s.id, s.letter))
    : helpEntries(doc, known)
        .filter((e) => e.page === page)
        .map((e) => item(e.id, e.title));
}

// ── validation ───────────────────────────────────────────────────────────────────────────────

/** The problems with the shape and the consistency of a `help-messages.json`; empty when fine. */
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
    if (
      entry.cta !== undefined &&
      !(CTA_ACTIONS as readonly string[]).includes(entry.cta)
    )
      problems.push(
        `${id}: cta "${entry.cta}" is not one of ${CTA_ACTIONS.join(", ")}`,
      );
    if (entry.entry !== undefined) {
      const first = owner.get(entry.entry);
      if (first === undefined) {
        owner.set(entry.entry, id);
        if (entry.entry !== id)
          problems.push(
            `${id}: entry "${entry.entry}" is named after the first id of the entry, which is ${id}`,
          );
      } else {
        if (known.get(first)?.title !== known.get(id)?.title)
          problems.push(
            `${id}: shares entry "${entry.entry}" with ${first} but not its title`,
          );
        if (doc.messages[first]?.page !== entry.page)
          problems.push(
            `${id}: shares entry "${entry.entry}" with ${first} but not its page`,
          );
      }
    }
  }
  for (const id of doc.developerOnly) {
    if (!known.has(id))
      problems.push(`${id}: developer-only id not in the copy catalog`);
    if (id in doc.messages)
      problems.push(`${id}: both a message and developer-only`);
  }
  if (new Set(doc.developerOnly).size !== doc.developerOnly.length)
    problems.push("developerOnly lists an id twice");

  // One title, one heading: a title is one entry, or developer-only, never two places.
  const homes = new Map<string, Set<string>>();
  const home = (title: string | undefined, where: string): void => {
    if (title === undefined) return;
    homes.set(title, (homes.get(title) ?? new Set()).add(where));
  };
  for (const id of Object.keys(doc.messages))
    home(known.get(id)?.title, `entry ${entryKeyOf(doc, id)}`);
  for (const id of doc.developerOnly)
    home(known.get(id)?.title, "the developer-only list");
  for (const [title, where] of homes)
    if (where.size > 1)
      problems.push(
        `"${title}" is in more than one place: ${[...where].join(", ")}`,
      );

  // A branch's Why, What to do and cta sit on its first id; the others show the same message.
  for (const entry of helpEntries(doc, known))
    for (const branch of entry.branches)
      for (const id of branch.ids.slice(1))
        if (
          doc.messages[id]?.why !== undefined ||
          doc.messages[id]?.fix !== undefined ||
          doc.messages[id]?.cta !== undefined
        )
          problems.push(
            `${id}: shows the same message as ${branch.ids[0]}, so its Why, What to do and cta are ${branch.ids[0]}'s; remove them here`,
          );

  // The portal's copy is used: every `portal` key is an id of a message or of the developer list.
  for (const key of Object.keys(doc.portal ?? {})) {
    const id = `portal.${key}`;
    if (!(id in doc.messages) && !doc.developerOnly.includes(id))
      problems.push(`${id}: in portal but in no entry and not developer-only`);
  }
  return problems;
}

/**
 * What stops every id of `known` from having a home: each id is in exactly one entry or in the
 * developer-only list, and each branch has its Why and What to do (docs plan §7.5).
 */
export function coverageProblems(
  doc: HelpMessagesData,
  known: ReadonlyMap<string, CatalogEntry>,
): string[] {
  const problems: string[] = [];
  const developer = new Set(doc.developerOnly);
  for (const id of known.keys()) {
    const inMessages = id in doc.messages;
    const inDeveloper = developer.has(id);
    if (inMessages && inDeveloper)
      problems.push(`${id}: in an entry and in the developer-only list`);
    else if (!inMessages && !inDeveloper)
      problems.push(`${id}: in no entry and not developer-only`);
  }
  for (const entry of helpEntries(doc, known))
    for (const branch of entry.branches) {
      const first = branch.ids[0]!;
      if (!branch.why?.trim()) problems.push(`${first}: no why`);
      if (!branch.fix?.trim()) problems.push(`${first}: no fix`);
    }
  return problems;
}
