/**
 * The `help-messages.json` contract (docs plan sections 7.1 and 7.5): the id format, the schema,
 * the data, and what keeps Help true. Every message of the copy catalog and every error of the
 * portal's `errors.ts` is in exactly one Help entry or in the developer-only list; titles render
 * from the catalog; the titles of every translated catalog are search aliases; the words of the
 * map pass the same prose rules as the pages; the messages pages show exactly the map's entries,
 * and "On this page" lists them (the A to Z index lists its letters, src/routeData.ts). Built-page
 * checks run when the docs have been built, as slugManifest.test.ts does.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ENTRIES,
  CONTACT_ARTICLE,
  CTA_ACTIONS,
  HELP_MESSAGES,
  KNOWN_ENTRIES,
  MESSAGE_ID,
  PLACEHOLDER_LABELS,
  TRANSLATED_CATALOGS,
  aliasesFor,
  articleHref,
  catalogEntries,
  coverageProblems,
  developerOnlyGroups,
  entryOf,
  helpCodePath,
  helpEntries,
  helpMessageUrl,
  indexRows,
  indexSections,
  messageParts,
  messageToc,
  pageOfId,
  singleOf,
  textParts,
  validateHelpMessages,
  type CatalogEntry,
  type HelpMessagesData,
  type TocItem,
} from "../src/lib/helpMessages";
import { onRequest } from "../src/routeData";
import { lintPage, type Facts } from "../scripts/lint-docs";
import { fileFor, splitFrontmatter } from "../scripts/site-map.mjs";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "..", "..");
const parity = join(repoRoot, "conformance", "parity");
const pagesDir = join(docsRoot, "src", "content", "docs", "help", "messages");
const dist = join(docsRoot, "dist");
const schema = JSON.parse(
  readFileSync(join(docsRoot, "help-messages.schema.json"), "utf8"),
) as {
  properties: {
    messages: {
      propertyNames: { pattern: string };
      additionalProperties: { properties: { cta: { enum: string[] } } };
    };
  };
  required: string[];
};

const read = (file: string): string => readFileSync(file, "utf8");
const words = (s: string): number => (s.match(/[A-Za-z0-9'’-]+/g) ?? []).length;
const entries = helpEntries(HELP_MESSAGES, KNOWN_ENTRIES);
const messagePages = Object.keys(HELP_MESSAGES.pages).filter(
  (k) => k !== "index",
);

/** The English catalog file as it is on disk: what the code under test is checked against. */
const englishFile = JSON.parse(read(join(parity, "copy.en.json"))) as {
  fallback: CatalogEntry;
  codes: Record<string, CatalogEntry>;
  gate: Record<string, CatalogEntry>;
  activation: Record<string, CatalogEntry>;
};
let portalCopies: Record<string, CatalogEntry> | undefined;
/** A message by its id, found in the files themselves, not through `catalogEntries`. */
function fileEntry(id: string): CatalogEntry | undefined {
  if (id === "fallback") return englishFile.fallback;
  const dot = id.indexOf(".");
  if (dot === -1) return englishFile.codes[id];
  const key = id.slice(dot + 1);
  const group = id.slice(0, dot);
  if (group === "gate") return englishFile.gate[key];
  if (group === "activation") return englishFile.activation[key];
  if (group !== "portal") return undefined;
  portalCopies ??= portalErrorsSource().copies;
  return portalCopies[key];
}

/** Source without its comment lines: the code a screen is built from. */
const withoutComments = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A label as a whole word: a string or JSX text, not a piece of an identifier. */
const wholeWord = (label: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(label)}(?![A-Za-z0-9_])`);
/** The title of the page the contact cta links to, from its own frontmatter. */
const contactTitle = (): string => {
  const file = fileFor(`help/${CONTACT_ARTICLE}`);
  if (file === null) throw new Error(`help/${CONTACT_ARTICLE} does not exist`);
  return String(splitFrontmatter(read(file)).data.title);
};

describe("message ids", () => {
  it.each([
    "device_limit",
    "license_owned",
    "gate.expired",
    "activation.device-limit",
    "fallback",
    "service-unavailable",
    "device-limit",
    "portal.file_not_found",
    "portal.status-404",
  ])("%s is an id", (id) => expect(MESSAGE_ID.test(id)).toBe(true));

  it.each([
    "Device_limit",
    "gate.",
    "gate.Expired",
    "activation.device_limit",
    "device__limit",
    "-limit",
    "codes.device_limit",
    "portal.",
    "portal.Status",
    "",
  ])("%j is not an id", (id) => expect(MESSAGE_ID.test(id)).toBe(false));

  it("the JSON schema uses the same pattern as the code", () => {
    expect(schema.properties.messages.propertyNames.pattern).toBe(
      MESSAGE_ID.source,
    );
  });

  it("every catalog key makes a valid id", () => {
    for (const id of KNOWN_ENTRIES.keys())
      expect(MESSAGE_ID.test(id), id).toBe(true);
  });

  it("a gate or activation key never collides with a codes key", () => {
    // activation.device-limit and device_limit are different ids on purpose.
    expect(CATALOG_ENTRIES.has("device_limit")).toBe(true);
    expect(CATALOG_ENTRIES.has("activation.device-limit")).toBe(true);
    expect(helpCodePath("activation.device-limit")).toBe(
      "/docs/help/code/activation.device-limit/",
    );
  });

  it("the catalog holds one id per fallback, codes, gate and activation key", () => {
    const catalog = JSON.parse(read(join(parity, "copy.en.json"))) as {
      codes: object;
      gate: object;
      activation: object;
    };
    expect(CATALOG_ENTRIES.size).toBe(
      1 +
        Object.keys(catalog.codes).length +
        Object.keys(catalog.gate).length +
        Object.keys(catalog.activation).length,
    );
  });
});

describe("the data", () => {
  it("is well formed against the catalog and the portal's copy", () => {
    expect(validateHelpMessages(HELP_MESSAGES, KNOWN_ENTRIES)).toEqual([]);
  });

  it("names a messages page for every page key, and only those", () => {
    for (const key of messagePages)
      expect(fileFor(`help/messages/${key}`), key).not.toBeNull();
    const pagesUsed = new Set(
      Object.values(HELP_MESSAGES.messages).map((m) => m.page),
    );
    for (const used of pagesUsed) expect(messagePages, used).toContain(used);
    // Every page of the map holds something.
    for (const key of messagePages) expect(pagesUsed, key).toContain(key);
  });

  it("the file declares the keys the schema requires", () => {
    for (const key of schema.required)
      expect(HELP_MESSAGES).toHaveProperty(key);
  });

  it("an article is a shipped Help page", () => {
    for (const [id, message] of Object.entries(HELP_MESSAGES.messages)) {
      if (message.article === undefined) continue;
      const file = fileFor(`help/${message.article}`);
      expect(file, `${id}: help/${message.article} does not exist`).not.toBe(
        null,
      );
      const { data } = splitFrontmatter(read(file!));
      expect(data.status, `${id}: help/${message.article} is a stub`).not.toBe(
        "stub",
      );
    }
  });
});

describe("an article that shows a message links back from it", () => {
  it("every message an article embeds names that article", () => {
    const helpDir = join(docsRoot, "src", "content", "docs", "help");
    const problems: string[] = [];
    for (const file of readdirSync(helpDir).filter((f) => /\.mdx$/.test(f))) {
      const article = file.replace(/\.mdx$/, "");
      for (const m of read(join(helpDir, file)).matchAll(
        /<HelpMessage id="([^"]+)"/g,
      )) {
        const id = m[1]!;
        const owner = HELP_MESSAGES.messages[id];
        const entry = entryOf(HELP_MESSAGES, KNOWN_ENTRIES, id);
        // A portal copy and the activation result have no per-message article of their own.
        if (owner === undefined || id.startsWith("portal.")) continue;
        if (id === "activation.ok") continue;
        const linked = entry?.branches
          .filter((b) => b.ids.includes(id))
          .some((b) => b.article === article);
        if (!linked)
          problems.push(
            `help/${article} embeds ${id}, which does not link back`,
          );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("every message has a home", () => {
  it("every catalog key is in exactly one entry or the developer-only list", () => {
    const developer = new Set(HELP_MESSAGES.developerOnly);
    const lost: string[] = [];
    for (const id of CATALOG_ENTRIES.keys()) {
      const homes =
        (id in HELP_MESSAGES.messages ? 1 : 0) + (developer.has(id) ? 1 : 0);
      if (homes !== 1) lost.push(`${id}: ${homes} homes`);
    }
    expect(lost).toEqual([]);
  });

  it("no message or developer-only id is outside the catalog and the portal's copy", () => {
    for (const id of [
      ...Object.keys(HELP_MESSAGES.messages),
      ...HELP_MESSAGES.developerOnly,
    ])
      expect(KNOWN_ENTRIES.has(id), id).toBe(true);
  });

  it("every id has a home and every branch has its Why and What to do", () => {
    expect(coverageProblems(HELP_MESSAGES, KNOWN_ENTRIES)).toEqual([]);
  });

  it("a title is one heading, or developer-only, never two places", () => {
    const titles = entries.map((e) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
    const developer = developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES).map(
      (g) => g.title,
    );
    expect(new Set(developer).size).toBe(developer.length);
    for (const title of developer) expect(titles).not.toContain(title);
  });

  it("the entries and the developer-only list hold every id once", () => {
    const ids = [
      ...entries.flatMap((e) => e.ids),
      ...developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES).flatMap((g) =>
        g.messages.flatMap((m) => m.ids),
      ),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...KNOWN_ENTRIES.keys()].sort());
  });
});

/** What `packages/admin/src/portal/errors.ts` words itself, keyed as the `portal` section keys it. */
function portalErrorsSource(): {
  copies: Record<string, CatalogEntry>;
  titles: number;
} {
  const text = read(
    join(repoRoot, "packages", "admin", "src", "portal", "errors.ts"),
  );
  // The portal's own words are `locker.error.*` keys of the kit copy catalog (its portal table).
  const kit = JSON.parse(
    read(
      join(
        repoRoot,
        "packages",
        "brand",
        "src",
        "generated",
        "kit-copy",
        "portal-en.json",
      ),
    ),
  ) as Record<string, string>;
  const core = JSON.parse(
    read(
      join(
        repoRoot,
        "packages",
        "brand",
        "src",
        "generated",
        "kit-copy",
        "en.json",
      ),
    ),
  ) as Record<string, string>;
  const word = (key: string): string => {
    const value = kit[key] ?? core[key];
    if (value === undefined) throw new Error(`errors.ts: no kit copy ${key}`);
    return value;
  };
  const copies: Record<string, CatalogEntry> = {};
  const own = String.raw`own\(\s*t\("(?<title>[\w.-]+)"\),\s*t\("(?<desc>[\w.-]+)"\)`;

  // The download-link refusals: a table keyed by the Worker's reason.
  const block =
    /const DOWNLOAD_REFUSALS[^{]*\{(?<body>[\s\S]*?)\n\};/.exec(text)?.groups
      ?.body ?? "";
  for (const m of block.matchAll(
    new RegExp(String.raw`^ {2}(?<key>\w+):\s*\(\)\s*=>\s*${own}`, "gm"),
  ))
    copies[m.groups!.key!] = {
      title: word(m.groups!.title!),
      message: word(m.groups!.desc!),
    };
  // One copy per HTTP status the portal words itself (the rest read the catalog's refusal codes).
  for (const m of text.matchAll(
    new RegExp(
      String.raw`err\.status === (?<status>\d+)\)\s*return\s*${own}`,
      "g",
    ),
  ))
    copies[`status-${m.groups!.status}`] = {
      title: word(m.groups!.title!),
      message: word(m.groups!.desc!),
    };
  return {
    copies,
    titles: (text.match(/\bown\(\s*t\(/g) ?? []).length,
  };
}

describe("the portal's own copy", () => {
  const source = portalErrorsSource();

  it("is read whole from errors.ts", () => {
    // A copy errors.ts words in a shape this reader does not know would be missed silently.
    expect(Object.keys(source.copies)).toHaveLength(source.titles);
    expect(source.copies).toHaveProperty("file_not_found");
    expect(
      Object.keys(source.copies).some((k) => k.startsWith("status-")),
    ).toBe(true);
  });

  it("is mirrored in help-messages.json, word for word", () => {
    expect(HELP_MESSAGES.portal).toEqual(source.copies);
  });

  it("has every error in exactly one entry or the developer-only list", () => {
    const developer = new Set(HELP_MESSAGES.developerOnly);
    for (const key of Object.keys(source.copies)) {
      const id = `portal.${key}`;
      const homes =
        (id in HELP_MESSAGES.messages ? 1 : 0) + (developer.has(id) ? 1 : 0);
      expect(homes, `${id}: ${homes} homes`).toBe(1);
    }
  });
});

describe("titles render from the catalog", () => {
  it("every entry heading is the title of the catalog file, and every branch quotes its message", () => {
    // Read from the files, not through the code that builds the entries.
    for (const entry of entries)
      for (const branch of entry.branches)
        for (const id of branch.ids) {
          const file = fileEntry(id);
          expect(file, `${id}: not in the catalog files`).toBeDefined();
          expect(entry.title, id).toBe(file!.title);
          expect(branch.message, id).toBe(file!.message);
        }
  });

  it("no title holds a markup character: a heading is handed to Starlight as HTML", () => {
    // AnchorHeading words its screen-reader label from the rendered heading and escapes that text
    // again, so HelpMessage.astro passes the title unescaped (an escaped Can&#39;t would be read
    // out as is). That holds for a title with no & < >. A single `<HelpMessage id>` in an article
    // takes the title of any id the catalog or the portal's copy has, not only of an entry, so
    // every one is checked.
    expect(KNOWN_ENTRIES.size).toBeGreaterThan(0);
    for (const [id, { title }] of KNOWN_ENTRIES)
      expect(title, id).not.toMatch(/[&<>]/);
  });

  it("a page never retypes a title: its headings come from the component", () => {
    for (const page of [...messagePages, "index"]) {
      const { body } = splitFrontmatter(read(join(pagesDir, `${page}.mdx`)));
      const headings = body.split("\n").filter((l) => /^#{1,6} /.test(l));
      expect(headings, page).toEqual(
        page === "other" ? ["## Messages for the app's developer"] : [],
      );
      for (const entry of entries)
        expect(body, `${page} retypes ${entry.id}`).not.toContain(
          entry.branches[0]!.message,
        );
    }
  });

  it("splits a message around its placeholders", () => {
    expect(messageParts(CATALOG_ENTRIES.get("license_owned")!.message)).toEqual(
      [
        "This ",
        { placeholder: "product", label: "app name" },
        " license is already in another Polaris Locker account. A license never moves by its key.",
      ],
    );
    expect(messageParts("No placeholders.")).toEqual(["No placeholders."]);
    expect(() => messageParts("A {nonesuch} here")).toThrow("nonesuch");
  });

  it("labels every placeholder any catalog uses", () => {
    const packs = [
      ...CATALOG_ENTRIES.values(),
      ...Object.values(TRANSLATED_CATALOGS).flatMap((pack) => [
        ...catalogEntries(pack).values(),
      ]),
    ];
    for (const { title, message } of packs)
      for (const m of `${title} ${message}`.matchAll(/\{(\w+)\}/g))
        expect(PLACEHOLDER_LABELS, m[1]).toHaveProperty(m[1]!);
  });
});

describe("search aliases", () => {
  const locales = readdirSync(parity)
    .map((f) => /^copy\.(.+)\.json$/.exec(f)?.[1])
    .filter(
      (l): l is string => l !== undefined && !["en", "schema"].includes(l),
    )
    .sort();

  it("cover every translated catalog", () => {
    expect(Object.keys(TRANSLATED_CATALOGS).sort()).toEqual(locales);
    for (const [locale, pack] of Object.entries(TRANSLATED_CATALOGS))
      expect(pack.locale, locale).toBe(locale);
  });

  it("carry the translated title of every id of every entry and developer-only title", () => {
    const idLists = [
      ...entries.map((e) => ({ name: e.id, ids: e.ids })),
      ...developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES).map((g) => ({
        name: g.title,
        ids: g.messages.flatMap((m) => m.ids),
      })),
    ];
    for (const { name, ids } of idLists) {
      const english = new Set(
        ids.map((id) => KNOWN_ENTRIES.get(id)!.title.toLowerCase()),
      );
      const expected = new Set<string>();
      for (const pack of Object.values(TRANSLATED_CATALOGS))
        for (const id of ids) {
          const title = catalogEntries(pack).get(id)?.title;
          if (title !== undefined && !english.has(title.toLowerCase()))
            expected.add(title.toLowerCase());
        }
      const actual = aliasesFor(ids);
      expect(new Set(actual.map((a) => a.title.toLowerCase())), name).toEqual(
        expected,
      );
      for (const alias of actual) {
        expect(locales, name).toContain(alias.lang);
        expect(alias.title, name).not.toContain("{");
      }
    }
    // The portal's own copy is English only: it has no translated title to index.
    expect(aliasesFor(["portal.status-401"])).toEqual([]);
  });

  it("include a known title in another language", () => {
    const german = TRANSLATED_CATALOGS.de!.codes.device_limit!.title;
    expect(
      aliasesFor(["device_limit", "activation.device-limit"]),
    ).toContainEqual({ lang: "de", title: german });
  });

  it("leave out a title that repeats the English one or another locale's", () => {
    const known = new Map<string, CatalogEntry>([
      ["a", { title: "Offline", message: "m" }],
    ]);
    const pack = (title: string) => ({
      fallback: { title: "x", message: "m" },
      codes: { a: { title, message: "m" } },
      gate: {},
      activation: {},
    });
    expect(
      aliasesFor(["a"], known, {
        de: pack("Offline"),
        es: pack("Sin conexión"),
        it: pack("sin conexión"),
        fr: pack("Hors ligne {n}"),
      }),
    ).toEqual([{ lang: "es", title: "Sin conexión" }]);
  });
});

describe("the words", () => {
  const facts: Facts = {
    commands: new Map(),
    commonFlags: new Set(),
    routes: [],
  };

  it("pass the prose rules the pages pass", () => {
    const texts: { id: string; field: string; text: string }[] = [];
    for (const [id, m] of Object.entries(HELP_MESSAGES.messages))
      for (const field of ["why", "fix"] as const)
        if (m[field] !== undefined) texts.push({ id, field, text: m[field]! });
    const hits = lintPage(
      {
        id: "help/messages/words",
        data: { type: "help-messages", lastReviewed: "2026-10-11" },
        body: texts.map((t) => t.text).join("\n\n"),
        firstLine: 1,
      },
      facts,
    );
    // Each text is one paragraph, two lines apart.
    expect(
      hits.map((h) => {
        const t = texts[(h.line - 1) / 2]!;
        return `${t.id}.${t.field}: ${h.rule} "${h.text}"`;
      }),
    ).toEqual([]);
  });

  it("keep each entry within 120 words: its title and every branch's message, Why and What to do", () => {
    // The budget is per entry (docs plan section 2, style guide section 3): one heading with all
    // its branches.
    const over = entries
      .map((entry) => ({
        id: entry.id,
        count:
          words(entry.title) +
          entry.branches.reduce(
            (sum, b) =>
              sum + words(`${b.message} ${b.why ?? ""} ${b.fix ?? ""}`),
            0,
          ),
      }))
      .filter(({ count }) => count > 120)
      .map(({ id, count }) => `${id}: ${count} words`);
    expect(over).toEqual([]);
  });

  it("bold only labels a screen shows", () => {
    // The kit table, and the portal's own table (its namespaces generate to portal-en.json).
    const kit = ["en.json", "portal-en.json"].flatMap((file) =>
      Object.values(
        JSON.parse(
          read(
            join(
              repoRoot,
              "packages",
              "brand",
              "src",
              "generated",
              "kit-copy",
              file,
            ),
          ),
        ) as Record<string, string>,
      ),
    );
    const portalDir = join(repoRoot, "packages", "admin", "src", "portal");
    const portal = withoutComments(
      readdirSync(portalDir, { recursive: true })
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => read(join(portalDir, f)))
        .join("\n"),
    );
    const labels = new Set<string>();
    for (const m of Object.values(HELP_MESSAGES.messages))
      for (const text of [m.why, m.fix])
        for (const part of textParts(text ?? ""))
          if (typeof part !== "string") labels.add(part.strong);
    expect(labels.size).toBeGreaterThan(0);
    for (const label of labels)
      expect(
        kit.includes(label) ||
          kit.some((value) => wholeWord(label).test(value)) ||
          wholeWord(label).test(portal),
        `**${label}** is not a string a kit or the portal shows`,
      ).toBe(true);
  });

  it("finds a label as a whole word of the code, not in an identifier or a comment", () => {
    const code = withoutComments(
      "// Discover things\n * Discover again\nconst portalDiscover = 1;\n",
    );
    expect(wholeWord("Discover").test(code)).toBe(false);
    expect(wholeWord("Discover").test(`${code}<h1>Discover</h1>`)).toBe(true);
    expect(wholeWord("Add (new)").test("x Add (new) y")).toBe(true);
  });

  it("splits bold labels from plain text", () => {
    expect(textParts("Choose **Replace a device** or wait.")).toEqual([
      "Choose ",
      { strong: "Replace a device" },
      " or wait.",
    ]);
    expect(textParts("Plain.")).toEqual(["Plain."]);
  });
});

describe("the pages", () => {
  it("each messages page is shipped, is a Help messages page and shows the map's entries in order", () => {
    for (const page of messagePages) {
      const text = read(join(pagesDir, `${page}.mdx`));
      const { data, body } = splitFrontmatter(text);
      expect(data.title, page).toBe(HELP_MESSAGES.pages[page]!.title);
      expect(data.type, page).toBe("help-messages");
      expect(data.status, page).toBe("shipped");
      expect(data.lastReviewed, page).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(data.sidebar?.hidden, page).toBeUndefined();
      expect(JSON.stringify(data.head ?? []), page).not.toContain("noindex");
      const calls = [
        ...body.matchAll(/<HelpMessage id="([^"]+)"( entry)? \/>/g),
      ];
      expect(
        calls.map((c) => c[1]),
        page,
      ).toEqual(entries.filter((e) => e.page === page).map((e) => e.id));
      for (const call of calls)
        expect(call[2], `${page}: ${call[1]} needs entry`).toBe(" entry");
      expect(body.includes("<DeveloperOnly />"), page).toBe(page === "other");
      // "On this page" puts every entry before the page's own headings (src/routeData.ts), so a
      // Markdown heading never comes before an entry.
      const firstHeading = body.search(/^#{1,6} /m);
      if (firstHeading !== -1)
        expect(
          body.lastIndexOf("<HelpMessage "),
          `${page}: an entry follows a Markdown heading`,
        ).toBeLessThan(firstHeading);
    }
  });

  it("the index is shipped, kept out of search, and links every group", () => {
    const { data, body } = splitFrontmatter(read(join(pagesDir, "index.mdx")));
    expect(data.title).toBe(HELP_MESSAGES.pages.index!.title);
    expect(data.status).toBe("shipped");
    expect(data.type).toBe("help-messages");
    expect(data.pagefind).toBe(false);
    expect(body).toContain("<MessageIndex />");
    for (const page of messagePages)
      expect(body).toContain(`/docs/help/messages/${page}/`);
  });
});

describe("entries", () => {
  const known = new Map<string, CatalogEntry>([
    ["a", { title: "Same", message: "one" }],
    ["b", { title: "Same", message: "one" }],
    ["c", { title: "Same", message: "two" }],
    ["d", { title: "Other", message: "three" }],
    ["dev1", { title: "Broken", message: "four" }],
    ["dev2", { title: "Broken", message: "five" }],
    ["dev3", { title: "Broken", message: "four" }],
    ["portal.x", { title: "Own", message: "six" }],
  ]);
  const doc: HelpMessagesData = {
    version: 1,
    pages: { index: { title: "All" }, p: { title: "P" }, q: { title: "Q" } },
    portal: { x: { title: "Own", message: "six" } },
    messages: {
      a: { page: "p", entry: "a", why: "Why a", fix: "Fix a", article: "x" },
      b: { page: "p", entry: "a" },
      c: { page: "p", entry: "a", why: "Why c", fix: "Fix c" },
      d: { page: "q", why: "Why d", fix: "Fix d" },
      "portal.x": { page: "q", why: "Why x", fix: "Fix x" },
    },
    developerOnly: ["dev1", "dev2", "dev3"],
  };

  it("one entry for ids with a title, one branch for each distinct message", () => {
    expect(helpEntries(doc, known)).toEqual([
      {
        id: "a",
        title: "Same",
        page: "p",
        ids: ["a", "b", "c"],
        branches: [
          {
            ids: ["a", "b"],
            message: "one",
            why: "Why a",
            fix: "Fix a",
            article: "x",
          },
          {
            ids: ["c"],
            message: "two",
            why: "Why c",
            fix: "Fix c",
            article: undefined,
          },
        ],
      },
      {
        id: "d",
        title: "Other",
        page: "q",
        ids: ["d"],
        branches: [
          {
            ids: ["d"],
            message: "three",
            why: "Why d",
            fix: "Fix d",
            article: undefined,
          },
        ],
      },
      {
        id: "portal.x",
        title: "Own",
        page: "q",
        ids: ["portal.x"],
        branches: [
          {
            ids: ["portal.x"],
            message: "six",
            why: "Why x",
            fix: "Fix x",
            article: undefined,
          },
        ],
      },
    ]);
  });

  it("finds the entry of any id, and none for an id the map lacks", () => {
    expect(entryOf(doc, known, "b")?.id).toBe("a");
    expect(entryOf(doc, known, "dev1")).toBeUndefined();
  });

  it("shows one id on its own with the Why and What to do of its branch", () => {
    const one = singleOf(doc, known, "b")!;
    expect(one.title).toBe("Same");
    expect(one.branch).toMatchObject({
      ids: ["b"],
      message: "one",
      why: "Why a",
      fix: "Fix a",
    });
    expect(singleOf(doc, known, "dev2")!.branch).toMatchObject({
      ids: ["dev2"],
      message: "five",
      why: undefined,
    });
    expect(singleOf(doc, known, "nonesuch")).toBeUndefined();
  });

  it("groups developer-only ids by title, then by message", () => {
    expect(developerOnlyGroups(doc, known)).toEqual([
      {
        title: "Broken",
        messages: [
          { message: "four", ids: ["dev1", "dev3"] },
          { message: "five", ids: ["dev2"] },
        ],
      },
    ]);
  });

  it("indexes every title A to Z with its anchor, developer-only titles on Other", () => {
    expect(indexRows(doc, known)).toEqual([
      { title: "Broken", id: "dev1", page: "other", pageTitle: "other" },
      { title: "Other", id: "d", page: "q", pageTitle: "Q" },
      { title: "Own", id: "portal.x", page: "q", pageTitle: "Q" },
      { title: "Same", id: "a", page: "p", pageTitle: "P" },
    ]);
    expect(helpMessageUrl(doc, "b")).toBe("/docs/help/messages/p/#b");
    expect(helpMessageUrl(doc, "dev2")).toBe("/docs/help/messages/other/#dev2");
    expect(pageOfId(doc, "nonesuch")).toBeUndefined();
    expect(() => helpMessageUrl(doc, "nonesuch")).toThrow("nonesuch");
  });

  it("indexes the real map: every title once, A to Z", () => {
    const rows = indexRows(HELP_MESSAGES, KNOWN_ENTRIES);
    const titles = new Set([...KNOWN_ENTRIES.values()].map((e) => e.title));
    expect(rows.map((r) => r.title).sort()).toEqual([...titles].sort());
    // The order is checked against the first letters and fixed neighbours, not by sorting again
    // with the collator the code sorts with.
    const order = rows.map((r) => r.title);
    const letters = order.map((t) => t.charAt(0).toUpperCase());
    expect(letters).toEqual([...letters].sort());
    const at = (title: string): number => {
      expect(order, `${title} is indexed`).toContain(title);
      return order.indexOf(title);
    };
    expect(at("Activate")).toBeLessThan(at("Activated"));
    expect(at("Activated")).toBeLessThan(at("Activation failed"));
    // And every pair of neighbours, read without case and punctuation: a plain comparison of the
    // letters and digits, not the collator.
    const key = (title: string): string =>
      title.toLowerCase().replace(/[^a-z0-9]/g, "");
    order.slice(1).forEach((title, i) => {
      expect(
        key(order[i]!) <= key(title),
        `${order[i]} comes before ${title}`,
      ).toBe(true);
    });
  });
});

describe("the cta of a message", () => {
  const known = new Map<string, CatalogEntry>([
    ["a", { title: "Same", message: "one" }],
    ["b", { title: "Same", message: "one" }],
    ["c", { title: "Same", message: "two" }],
    ["d", { title: "Same", message: "three" }],
  ]);
  const doc: HelpMessagesData = {
    version: 1,
    pages: { index: { title: "All" }, p: { title: "P" } },
    messages: {
      a: { page: "p", entry: "a", why: "Why a", fix: "Fix a", cta: "library" },
      b: { page: "p", entry: "a" },
      c: { page: "p", entry: "a", why: "Why c", fix: "Fix c", cta: "contact" },
      d: { page: "p", entry: "a", why: "Why d", fix: "Fix d" },
    },
    developerOnly: [],
  };

  it("ends the branch that holds it, and no other", () => {
    expect(helpEntries(doc, known)[0]!.branches.map((b) => b.cta)).toEqual([
      "library",
      "contact",
      undefined,
    ]);
    expect(singleOf(doc, known, "b")!.branch.cta).toBe("library");
    expect(singleOf(doc, known, "c")!.branch.cta).toBe("contact");
    expect(singleOf(doc, known, "d")!.branch.cta).toBeUndefined();
  });

  it("is one of the actions the schema lists", () => {
    expect(
      schema.properties.messages.additionalProperties.properties.cta.enum,
    ).toEqual([...CTA_ACTIONS]);
  });

  it("is on the first id of a branch in the real data, and an action", () => {
    for (const entry of entries)
      for (const branch of entry.branches)
        for (const id of branch.ids.slice(1))
          expect(HELP_MESSAGES.messages[id]?.cta, id).toBeUndefined();
    for (const [id, message] of Object.entries(HELP_MESSAGES.messages))
      if (message.cta !== undefined)
        expect(CTA_ACTIONS, id).toContain(message.cta);
  });

  it("is held by one branch of an entry at most, so an entry shows each link once", () => {
    for (const entry of entries)
      for (const action of CTA_ACTIONS)
        expect(
          entry.branches.filter((b) => b.cta === action).length,
          `${entry.id}: ${action}`,
        ).toBeLessThanOrEqual(1);
  });

  it("has a Help page to go to for the contact link", () => {
    // The page can still be a stub when this package lands (it ships on its own); the link needs it
    // to exist, and the build checks the link.
    expect(
      fileFor(`help/${CONTACT_ARTICLE}`),
      `help/${CONTACT_ARTICLE}`,
    ).not.toBeNull();
  });

  it("is the only way a Why or What to do names the contact page: as a link, never as plain words", () => {
    const title = contactTitle();
    expect(title.length).toBeGreaterThan(0);
    const plain = Object.entries(HELP_MESSAGES.messages).flatMap(([id, m]) =>
      (["why", "fix"] as const)
        .filter((field) =>
          m[field]?.toLowerCase().includes(title.toLowerCase()),
        )
        .map((field) => `${id}.${field}`),
    );
    expect(plain, `say it with cta "contact", which links ${title}`).toEqual(
      [],
    );
  });
});

describe("the article link", () => {
  it("is the message's article, as a Help path", () => {
    expect(articleHref("devices", "/docs/help/messages/devices/")).toBe(
      "/docs/help/devices/",
    );
    expect(articleHref("a/b", "/docs/")).toBe("/docs/help/a/b/");
  });

  it("is left out when the page showing the message is the article, with or without the trailing slash", () => {
    expect(articleHref("activate", "/docs/help/activate/")).toBeUndefined();
    expect(articleHref("activate", "/docs/help/activate")).toBeUndefined();
  });

  it("compares whole paths, not prefixes", () => {
    expect(articleHref("device", "/docs/help/devices/")).toBe(
      "/docs/help/device/",
    );
    expect(articleHref("devices", "/docs/help/devices-and-more/")).toBe(
      "/docs/help/devices/",
    );
  });

  it("is none for a message without an article", () => {
    expect(articleHref(undefined, "/docs/help/devices/")).toBeUndefined();
  });

  it("is the contact page for the contact cta, and none on that page itself", () => {
    expect(articleHref(CONTACT_ARTICLE, "/docs/help/messages/other/")).toBe(
      "/docs/help/contact/",
    );
    expect(articleHref(CONTACT_ARTICLE, "/docs/help/contact/")).toBeUndefined();
  });
});

describe("the A to Z letters", () => {
  it("group the rows by the first letter of the title, in order, each with its heading's anchor", () => {
    const rows = ["apple", "Avocado", "Banana", "Berry", "cherry"].map(
      (title) => ({ title, id: title, page: "p", pageTitle: "P" }),
    );
    expect(
      indexSections(rows).map((s) => [
        s.letter,
        s.id,
        s.rows.map((r) => r.title),
      ]),
    ).toEqual([
      ["A", "letter-a", ["apple", "Avocado"]],
      ["B", "letter-b", ["Banana", "Berry"]],
      ["C", "letter-c", ["cherry"]],
    ]);
  });

  it("are plain capitals on the real index, so an anchor is plain ASCII and none repeats", () => {
    const sections = indexSections(indexRows(HELP_MESSAGES, KNOWN_ENTRIES));
    for (const s of sections) expect(s.letter).toMatch(/^[A-Z]$/);
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
  });
});

describe("the table of contents", () => {
  it("lists the entries of a group page: the ids its calls name, with the catalog titles", () => {
    for (const page of messagePages) {
      const { body } = splitFrontmatter(read(join(pagesDir, `${page}.mdx`)));
      const called = [...body.matchAll(/<HelpMessage id="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      const items = messageToc(
        HELP_MESSAGES,
        KNOWN_ENTRIES,
        `help/messages/${page}`,
      );
      expect(called.length, page).toBeGreaterThan(0);
      expect(
        items.map((i) => i.slug),
        page,
      ).toEqual(called);
      expect(
        items.map((i) => i.text),
        page,
      ).toEqual(called.map((id) => fileEntry(id)!.title));
      for (const item of items) {
        expect(item.depth, page).toBe(2);
        expect(item.children, page).toEqual([]);
      }
    }
  });

  it("lists the letters of the A to Z index", () => {
    const letters = [
      ...new Set(
        [...KNOWN_ENTRIES.values()].map((e) => e.title.charAt(0).toUpperCase()),
      ),
    ].sort();
    const items = messageToc(HELP_MESSAGES, KNOWN_ENTRIES, "help/messages");
    expect(items.map((i) => i.text)).toEqual(letters);
    expect(items.map((i) => i.slug)).toEqual(
      letters.map((l) => `letter-${l.toLowerCase()}`),
    );
  });

  it("is empty for any other page", () => {
    for (const id of [
      "help/activate",
      "help/messages/nonesuch",
      "help/messages/constructor",
      "help/messages/devices/extra",
      "contribute/docs-components",
    ])
      expect(messageToc(HELP_MESSAGES, KNOWN_ENTRIES, id), id).toEqual([]);
  });
});

describe("the route middleware", () => {
  const overview: TocItem = {
    depth: 2,
    slug: "_top",
    text: "Overview",
    children: [],
  };
  const own: TocItem = {
    depth: 2,
    slug: "own-heading",
    text: "The page's own heading",
    children: [],
  };
  /** Runs the middleware on a route and returns the slugs of its list, or undefined with none. */
  const run = async (
    id: string,
    toc: { minHeadingLevel: number; maxHeadingLevel: number } | undefined,
  ): Promise<string[] | undefined> => {
    const starlightRoute = {
      id,
      toc: toc && { ...toc, items: [overview, own] },
    };
    await onRequest({ locals: { starlightRoute } } as never, async () => {});
    return starlightRoute.toc?.items.map((i) => i.slug);
  };
  const levels = { minHeadingLevel: 2, maxHeadingLevel: 3 };

  it("puts the entries of a messages page after Overview and before the page's own headings", async () => {
    for (const page of messagePages)
      expect(await run(`help/messages/${page}`, levels), page).toEqual([
        "_top",
        ...entries.filter((e) => e.page === page).map((e) => e.id),
        "own-heading",
      ]);
  });

  it("puts the letters of the index there", async () => {
    const slugs = (await run("help/messages", levels))!;
    expect(slugs[0]).toBe("_top");
    expect(slugs.at(-1)).toBe("own-heading");
    expect(slugs.slice(1, -1)).toEqual(
      messageToc(HELP_MESSAGES, KNOWN_ENTRIES, "help/messages").map(
        (i) => i.slug,
      ),
    );
  });

  it("leaves every other page's list as it is", async () => {
    expect(await run("help/activate", levels)).toEqual(["_top", "own-heading"]);
  });

  it("leaves a page without a list, or with one that does not show level 2, alone", async () => {
    expect(await run("help/messages/devices", undefined)).toBeUndefined();
    expect(
      await run("help/messages/devices", {
        minHeadingLevel: 3,
        maxHeadingLevel: 4,
      }),
    ).toEqual(["_top", "own-heading"]);
    expect(
      await run("help/messages/devices", {
        minHeadingLevel: 1,
        maxHeadingLevel: 1,
      }),
    ).toEqual(["_top", "own-heading"]);
  });
});

describe("validateHelpMessages", () => {
  const known = catalogEntries({
    fallback: { title: "Something went wrong", message: "m" },
    codes: {
      device_limit: { title: "Device limit reached", message: "m" },
      other: { title: "Other", message: "m" },
    },
    gate: {},
    activation: {
      "device-limit": { title: "Device limit reached", message: "m" },
    },
  });
  const base = (): HelpMessagesData => ({
    version: 1,
    pages: { index: { title: "All" }, devices: { title: "Devices" } },
    messages: { device_limit: { page: "devices" } },
    developerOnly: [],
  });
  const shared = (doc: HelpMessagesData): void => {
    doc.messages.device_limit = { page: "devices", entry: "device_limit" };
    doc.messages["activation.device-limit"] = {
      page: "devices",
      entry: "device_limit",
    };
  };

  it("accepts a good document", () => {
    expect(validateHelpMessages(base(), known)).toEqual([]);
  });

  it("refuses an id the catalog lacks", () => {
    const doc = base();
    doc.messages.nonesuch = { page: "devices" };
    expect(validateHelpMessages(doc, known)).toContain(
      "nonesuch: not in the copy catalog",
    );
  });

  it("refuses a malformed id and an unknown page", () => {
    const doc = base();
    doc.messages["Bad-Id"] = { page: "nowhere" };
    const problems = validateHelpMessages(doc, known);
    expect(problems).toContain("Bad-Id: not a message id");
    expect(problems.some((p) => p.includes('page "nowhere"'))).toBe(true);
  });

  it("lets ids with one title share an entry, and refuses a different title", () => {
    const doc = base();
    shared(doc);
    expect(validateHelpMessages(doc, known)).toEqual([]);
    doc.messages.other = { page: "devices", entry: "device_limit" };
    expect(validateHelpMessages(doc, known).join()).toContain("shares entry");
  });

  it("names an entry after its first id, and keeps it on one page", () => {
    const doc = base();
    shared(doc);
    doc.messages.device_limit!.entry = "limit";
    doc.messages["activation.device-limit"]!.entry = "limit";
    expect(validateHelpMessages(doc, known).join()).toContain(
      'entry "limit" is named after the first id',
    );
    const split = base();
    shared(split);
    split.pages.other = { title: "Other" };
    split.messages["activation.device-limit"]!.page = "other";
    expect(validateHelpMessages(split, known).join()).toContain(
      "but not its page",
    );
  });

  it("refuses an id that is both a message and developer-only", () => {
    const doc = base();
    doc.developerOnly = ["device_limit"];
    expect(validateHelpMessages(doc, known).join()).toContain(
      "both a message and developer-only",
    );
  });

  it("refuses a developer-only id twice", () => {
    const doc = base();
    doc.messages = {};
    doc.developerOnly = ["other", "other"];
    expect(validateHelpMessages(doc, known)).toContain(
      "developerOnly lists an id twice",
    );
  });

  it("refuses one title in two places", () => {
    const doc = base();
    doc.messages["activation.device-limit"] = { page: "devices" };
    expect(validateHelpMessages(doc, known).join()).toContain(
      '"Device limit reached" is in more than one place',
    );
  });

  it("refuses a Why on an id that shows another id's message", () => {
    const doc = base();
    shared(doc);
    doc.messages["activation.device-limit"]!.why = "again";
    expect(validateHelpMessages(doc, known).join()).toContain(
      "shows the same message as device_limit",
    );
  });

  it("refuses a cta that is not an action", () => {
    const doc = base();
    doc.messages.device_limit = { page: "devices", cta: "nonesuch" as never };
    expect(validateHelpMessages(doc, known).join()).toContain(
      'device_limit: cta "nonesuch" is not one of library, contact',
    );
  });

  it("refuses a cta on an id that shows another id's message", () => {
    const doc = base();
    shared(doc);
    doc.messages["activation.device-limit"]!.cta = "library";
    expect(validateHelpMessages(doc, known).join()).toContain(
      "shows the same message as device_limit",
    );
  });

  it("refuses portal copy that nothing uses", () => {
    const doc = base();
    doc.portal = { default: { title: "Own", message: "m" } };
    expect(validateHelpMessages(doc, known).join()).toContain(
      "portal.default: in portal but in no entry",
    );
  });
});

describe("coverageProblems", () => {
  const known = catalogEntries({
    fallback: { title: "Something went wrong", message: "m" },
    codes: { device_limit: { title: "Device limit reached", message: "m" } },
    gate: {},
    activation: {},
  });

  it("names an id with no home, and a branch with no Why or What to do", () => {
    const doc: HelpMessagesData = {
      version: 1,
      pages: { index: { title: "All" }, devices: { title: "Devices" } },
      messages: { device_limit: { page: "devices", why: "Because." } },
      developerOnly: [],
    };
    expect(coverageProblems(doc, known)).toEqual([
      "fallback: in no entry and not developer-only",
      "device_limit: no fix",
    ]);
    doc.developerOnly = ["fallback", "device_limit"];
    expect(coverageProblems(doc, known)).toContain(
      "device_limit: in an entry and in the developer-only list",
    );
  });
});

describe("the Help message styles", () => {
  const helpDir = join(docsRoot, "src", "components", "help");
  // The shared stylesheet, and the style block of the one component that has its own.
  const sheets = [
    read(join(helpDir, "message.css")),
    ...[
      ...read(join(helpDir, "MessageIndex.astro")).matchAll(
        /<style[^>]*>([\s\S]*?)<\/style>/g,
      ),
    ].map((m) => m[1]!),
  ].join("\n");

  it("use tokens only: no colour of their own, so dark and light follow the theme", () => {
    expect(sheets).toContain("var(--");
    expect(sheets).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  });

  it("read only variables the brand tokens or the docs theme declare", () => {
    const declared = new Set<string>();
    for (const file of [
      join(repoRoot, "packages", "brand", "css", "tokens.css"),
      join(docsRoot, "src", "styles", "global.css"),
    ])
      for (const m of read(file).matchAll(/(--[\w-]+)\s*:/g))
        declared.add(m[1]!);
    for (const m of sheets.matchAll(/var\((--[\w-]+)/g))
      expect(declared, m[1]).toContain(m[1]);
  });
});

describe.skipIf(!existsSync(join(dist, "help", "messages", "index.html")))(
  "the built pages",
  () => {
    const decode = (s: string): string =>
      s
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    const html = (page: string): string =>
      read(
        page === "index"
          ? join(dist, "help", "messages", "index.html")
          : join(dist, "help", "messages", page, "index.html"),
      );
    const ids = (page: string): string[] =>
      [...html(page).matchAll(/ id="([^"]+)"/g)].map((m) => decode(m[1]!));
    /** A failure names the page, never prints it. */
    const has = (text: string, needle: string, what: string): void =>
      expect(text.includes(needle), `${what}: ${needle}`).toBe(true);

    it.each(messagePages)(
      "%s: each entry is the catalog title with its id as the anchor, and every id has one anchor",
      (page) => {
        const text = html(page);
        const headings = [
          ...text.matchAll(/<h2 id="([^"]+)"[^>]*>([^<]*)<\/h2>/g),
        ].map((m) => [decode(m[1]!), decode(m[2]!)]);
        const expected = entries
          .filter((e) => e.page === page)
          .map((e) => [e.id, fileEntry(e.id)!.title]);
        expect(
          headings.filter(([id]) => expected.some(([e]) => e === id)),
        ).toEqual(expected);
        const seen = ids(page);
        for (const id of entries
          .filter((e) => e.page === page)
          .flatMap((e) => e.ids))
          expect(
            seen.filter((x) => x === id),
            `${page}#${id}`,
          ).toHaveLength(1);
        if (page === "other")
          for (const id of HELP_MESSAGES.developerOnly)
            expect(
              seen.filter((x) => x === id),
              `${page}#${id}`,
            ).toHaveLength(1);
        expect(text.includes('content="noindex"'), `${page}: noindex`).toBe(
          false,
        );
      },
    );

    it("quotes each message as the app shows it, with a placeholder named", () => {
      has(
        decode(html("accounts")),
        "This <var>app name</var> license is already in another Polaris Locker account.",
        "accounts",
      );
      has(
        decode(html("license-key")),
        "Activation was refused (<var>code</var>).",
        "license-key",
      );
    });

    it("emits each translated title as hidden, language-tagged text", () => {
      for (const page of messagePages) {
        const text = decode(html(page));
        for (const entry of entries.filter((e) => e.page === page))
          for (const alias of aliasesFor(entry.ids))
            has(
              text,
              `<span hidden lang="${alias.lang}" data-pagefind-weight="6">${alias.title}</span>`,
              `${page}#${entry.id}`,
            );
      }
    });

    it("lists every title on the index, each linking to an anchor that exists", () => {
      const text = html("index");
      const links = [
        ...text.matchAll(
          /<li><a href="\/docs\/help\/messages\/([a-z-]+)\/#([^"]+)">([^<]*)<\/a>/g,
        ),
      ];
      const rows = indexRows(HELP_MESSAGES, KNOWN_ENTRIES);
      expect(links.map((l) => [l[1], decode(l[2]!), decode(l[3]!)])).toEqual(
        rows.map((r) => [r.page, r.id, r.title]),
      );
      for (const [, page, id] of links)
        expect(ids(page!), `${page}#${id}`).toContain(decode(id!));
    });

    it("lists the developer-only titles with the message and every code", () => {
      const text = decode(html("other"));
      for (const group of developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES)) {
        has(text, `<strong>${group.title}</strong>`, "other");
        for (const row of group.messages)
          for (const id of row.ids) has(text, `<code>${id}</code>`, "other");
      }
    });

    /** The links of one of a page's "On this page" lists, as [slug, text]. */
    const toc = (page: string, element: string): string[][] => {
      const text = html(page);
      const start = text.indexOf(`<${element}`);
      expect(
        start,
        `${page}: <${element}> is on the page`,
      ).toBeGreaterThanOrEqual(0);
      const list = text.slice(start, text.indexOf(`</${element}>`, start));
      return [
        ...list.matchAll(/<a href="#([^"]*)"[^>]*><span[^>]*>([^<]*)<\/span>/g),
      ].map((m) => [decode(m[1]!), decode(m[2]!)]);
    };

    it.each([...messagePages, "index"])(
      "%s: 'On this page' lists every heading of the page, in the page's order, on desktop and on a phone",
      (page) => {
        const headings = [
          ...html(page).matchAll(/<h2 id="([^"]+)"[^>]*>([^<]*)<\/h2>/g),
        ]
          .map((m) => [decode(m[1]!), decode(m[2]!)])
          .filter(([id]) => !id!.startsWith("starlight__"));
        expect(headings.length, page).toBeGreaterThan(0);
        for (const element of ["starlight-toc", "mobile-starlight-toc"])
          expect(toc(page, element), `${page} ${element}`).toEqual([
            ["_top", "Overview"],
            ...headings,
          ]);
      },
    );

    it.each(messagePages)(
      "%s: the anchor link of each heading is named by the heading's text, not by its HTML",
      (page) => {
        const text = html(page);
        const headings = [
          ...text.matchAll(
            /<h2 id="[^"]+"[^>]*>([^<]*)<\/h2><a class="sl-anchor-link"[^>]*>.*?Section titled “([^<]*)”<\/span>/gs,
          ),
        ];
        expect(headings.length, page).toBe(
          [...text.matchAll(/<h2 id="(?!starlight__)/g)].length,
        );
        for (const [, title, label] of headings) {
          expect(label, `${title}: the label is escaped twice`).not.toContain(
            "&amp;",
          );
          expect(decode(label!), title).toBe(decode(title!));
        }
      },
    );

    it.each(messagePages)(
      "%s: the ids of an entry's first message anchor at its heading, the ids of its other messages below it",
      (page) => {
        const text = html(page);
        for (const entry of entries.filter((e) => e.page === page)) {
          const start = text.indexOf(`data-help-message="${entry.id}"`);
          const heading = text.indexOf(`<h2 id="${entry.id}"`, start);
          expect(start, entry.id).toBeGreaterThanOrEqual(0);
          expect(heading, entry.id).toBeGreaterThan(start);
          entry.branches.forEach((branch, i) => {
            for (const id of branch.ids.filter((x) => x !== entry.id)) {
              const at = text.indexOf(`<span id="${id}"`, start);
              expect(at, `${page}#${id}`).toBeGreaterThan(start);
              if (i === 0) expect(at, `${page}#${id}`).toBeLessThan(heading);
              else expect(at, `${page}#${id}`).toBeGreaterThan(heading);
            }
          });
        }
      },
    );

    it.each(messagePages)(
      "%s: a branch that holds a cta ends with its link, and no other branch has one",
      (page) => {
        const text = html(page);
        const branches = entries
          .filter((e) => e.page === page)
          .flatMap((e) => e.branches);
        const wanted = (action: string): number =>
          branches.filter((b) => b.cta === action).length;
        // Every cta paragraph is one a branch asked for.
        expect(
          text.match(/class="pk-help-message__cta"/g) ?? [],
          page,
        ).toHaveLength(wanted("library") + wanted("contact"));
        // The portal root, not `/library`: the portal is one page at the site root that routes by
        // hash (`#/` is the Library), and the Worker serves its shell for `/`, `/index.html`,
        // `/activate` and `/assets/` only (packages/worker/src/router.ts), so `/library` is a 404.
        expect(
          text.match(
            /<p class="pk-help-message__cta"><a class="pk-portal-link(?: [^"]*)?" href="\/"[^>]*>Open your library ↗<\/a><\/p>/g,
          ) ?? [],
          page,
        ).toHaveLength(wanted("library"));
        // The contact page, by its own title, as a plain link: it is a page of Help, so no new tab.
        expect(
          text.match(
            new RegExp(
              `<p class="pk-help-message__cta">Still need help\\? Read <a href="/docs/help/contact/">${escapeRegExp(contactTitle())}</a>\\.</p>`,
              "g",
            ),
          ) ?? [],
          page,
        ).toHaveLength(wanted("contact"));
      },
    );

    it("the A to Z index opens with a link to every letter, each to a heading of the page", () => {
      const text = html("index");
      const row =
        /<nav class="[^"]*pk-help-letters[^"]*" aria-label="Jump to a letter">(.*?)<\/nav>/s.exec(
          text,
        )?.[1];
      expect(row, "the letter row is on the page").toBeDefined();
      const links = [...row!.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map(
        (m) => [m[1], m[2]],
      );
      const letters = [
        ...new Set(
          [...KNOWN_ENTRIES.values()].map((e) =>
            e.title.charAt(0).toUpperCase(),
          ),
        ),
      ].sort();
      expect(links).toEqual(
        letters.map((l) => [`letter-${l.toLowerCase()}`, l]),
      );
      for (const [id, letter] of links)
        has(text, `<h2 id="${id}">${letter}</h2>`, "index");
      expect(text.indexOf("pk-help-letters")).toBeLessThan(
        text.indexOf('<h2 id="letter-'),
      );
    });

    it("emits each translated title of a developer-only title as hidden, language-tagged text", () => {
      const text = decode(html("other"));
      for (const group of developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES))
        for (const alias of aliasesFor(group.messages.flatMap((m) => m.ids)))
          has(
            text,
            `<span hidden lang="${alias.lang}" data-pagefind-weight="6">${alias.title}</span>`,
            `other: ${group.title}`,
          );
    });

    it("anchors the ids of a developer-only title's first message at the title, the ids of its other messages below it", () => {
      const text = decode(html("other"));
      const anchor = (id: string): string =>
        `<span id="${id}" class="pk-help-developer__anchor"></span>`;
      // The hidden translated titles sit between the anchors and the title.
      const hidden = String.raw`(?:<span hidden lang="[^"]+" data-pagefind-weight="6">[^<]*</span>)*`;
      for (const group of developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES)) {
        const [first, ...rest] = group.messages;
        const head = new RegExp(
          `<li>${first!.ids.map((id) => escapeRegExp(anchor(id))).join("")}${hidden}<strong>${escapeRegExp(group.title)}</strong>`,
        );
        const start = text.search(head);
        expect(
          start,
          `${group.title}: its first message's ids come before the title`,
        ).toBeGreaterThanOrEqual(0);
        const end = text.indexOf("</li>", start);
        for (const row of rest)
          for (const id of row.ids) {
            const at = text.indexOf(anchor(id), start);
            expect(
              at,
              `${group.title}: ${id} is below the title`,
            ).toBeGreaterThan(start);
            expect(
              at,
              `${group.title}: ${id} is in its own title`,
            ).toBeLessThan(end);
          }
      }
    });

    it("ends each developer-only item with its last message: the hidden text comes before the title", () => {
      // Starlight spaces a list item by its last child, unless that child is a span (an
      // `li > :last-child:not(span …)` rule), so hidden text at the end of an item would take the
      // space after it from the message above it.
      const text = html("other");
      const from = text.indexOf('<ul class="pk-help-developer">');
      expect(
        from,
        "the developer-only list is on the page",
      ).toBeGreaterThanOrEqual(0);
      const items = text
        .slice(from, text.indexOf("</ul>", from))
        .split("</li>")
        .slice(0, -1);
      expect(items).toHaveLength(
        developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES).length,
      );
      for (const item of items)
        expect(
          item.endsWith("</div>"),
          `an item ends with …${item.slice(-70)}`,
        ).toBe(true);
    });

    it("an article carries a message on its own: the title as heading, the id as anchor, the article link", () => {
      const text = decode(
        read(join(dist, "contribute", "docs-components", "index.html")),
      );
      const one = singleOf(HELP_MESSAGES, KNOWN_ENTRIES, "device_limit")!;
      has(text, 'data-help-message="device_limit"', "docs-components");
      has(text, `<h2 id="device_limit">${one.title}</h2>`, "docs-components");
      if (one.branch.article === undefined)
        expect(text).not.toContain("<strong>More help.</strong>");
      else {
        const article = splitFrontmatter(
          read(fileFor(`help/${one.branch.article}`)!),
        ).data.title;
        has(
          text,
          `<strong>More help.</strong> <a href="/docs/help/${one.branch.article}/">${article}</a>`,
          "docs-components",
        );
      }
    });

    it("the search index holds the translated titles of every entry and developer-only title", () => {
      // A build without a search index is a defect, not a reason to skip.
      const entry = join(dist, "pagefind", "pagefind-entry.json");
      expect(existsSync(entry), "the build made a search index").toBe(true);
      // Pagefind writes one gzipped fragment per page: a marker, then JSON with the page's text.
      const dir = join(dist, "pagefind", "fragment");
      const marker = "pagefind_dcd";
      const indexed = new Map<string, string>();
      for (const file of readdirSync(dir).filter((f) =>
        f.endsWith(".pf_fragment"),
      )) {
        const raw = gunzipSync(readFileSync(join(dir, file))).toString("utf8");
        expect(raw.startsWith(marker), file).toBe(true);
        const page = JSON.parse(raw.slice(marker.length)) as {
          url: string;
          content: string;
        };
        indexed.set(page.url, page.content);
      }
      for (const page of messagePages) {
        const content = indexed.get(`/help/messages/${page}/`);
        expect(content, `${page} is in the search index`).toBeDefined();
        const idLists = entries
          .filter((e) => e.page === page)
          .map((e) => e.ids);
        if (page === "other")
          idLists.push(
            ...developerOnlyGroups(HELP_MESSAGES, KNOWN_ENTRIES).map((g) =>
              g.messages.flatMap((m) => m.ids),
            ),
          );
        for (const ids of idLists)
          for (const alias of aliasesFor(ids))
            expect(
              content!.includes(alias.title),
              `${page}: ${alias.lang} "${alias.title}" is searchable`,
            ).toBe(true);
      }
    });
  },
);
