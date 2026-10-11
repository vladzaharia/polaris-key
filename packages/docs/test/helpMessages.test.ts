/**
 * The `help-messages.json` contract (docs plan sections 7.1 and 7.5): the id format, the schema,
 * the data, and what keeps Help true. Every message of the copy catalog and every error of the
 * portal's `errors.ts` is in exactly one Help entry or in the developer-only list; titles render
 * from the catalog; the titles of every translated catalog are search aliases; the words of the
 * map pass the same prose rules as the pages; and the messages pages show exactly the map's
 * entries. Built-page checks run when the docs have been built, as slugManifest.test.ts does.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ENTRIES,
  HELP_MESSAGES,
  KNOWN_ENTRIES,
  MESSAGE_ID,
  PLACEHOLDER_LABELS,
  TRANSLATED_CATALOGS,
  aliasesFor,
  catalogEntries,
  coverageProblems,
  developerOnlyGroups,
  entryOf,
  helpCodePath,
  helpEntries,
  helpMessageUrl,
  indexRows,
  messageParts,
  pageOfId,
  singleOf,
  textParts,
  validateHelpMessages,
  type CatalogEntry,
  type HelpMessagesData,
} from "../src/lib/helpMessages";
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
  properties: { messages: { propertyNames: { pattern: string } } };
  required: string[];
};

const read = (file: string): string => readFileSync(file, "utf8");
const words = (s: string): number => (s.match(/[A-Za-z0-9'’-]+/g) ?? []).length;
const entries = helpEntries(HELP_MESSAGES, KNOWN_ENTRIES);
const messagePages = Object.keys(HELP_MESSAGES.pages).filter(
  (k) => k !== "index",
);

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
  const kit = JSON.parse(
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
  const unquote = (s: string): string => JSON.parse(`"${s}"`) as string;
  const title = (g: Record<string, string | undefined>): string => {
    if (g.title !== undefined) return unquote(g.title);
    const value = kit[g.key!];
    if (value === undefined) throw new Error(`errors.ts: no kit copy ${g.key}`);
    return value;
  };
  const copies: Record<string, CatalogEntry> = {};
  const str = String.raw`"(?<title>(?:[^"\\]|\\.)*)"`;
  const strOrKey = String.raw`(?:"(?<title>(?:[^"\\]|\\.)*)"|t\("(?<key>[\w.]+)"\))`;
  const desc = String.raw`description:\s*"(?<desc>(?:[^"\\]|\\.)*)",`;

  // The download-link refusals: a table keyed by the Worker's reason.
  const block =
    /const DOWNLOAD_REFUSALS[^=]*=\s*\{(?<body>[\s\S]*?)\n\};/.exec(text)
      ?.groups?.body ?? "";
  for (const m of block.matchAll(
    new RegExp(
      String.raw`^ {2}(?<key>\w+):\s*\{\s*title:\s*${str},\s*${desc}`,
      "gm",
    ),
  ))
    copies[m.groups!.key!] = {
      title: unquote(m.groups!.title!),
      message: unquote(m.groups!.desc!),
    };
  // A sign-in needed again.
  const stepUp = new RegExp(
    String.raw`isStepUpRequired\(err\)\)\s*return\s*\{\s*title:\s*${str},\s*${desc}`,
  ).exec(text)?.groups;
  if (stepUp)
    copies.step_up_required = {
      title: unquote(stepUp.title!),
      message: unquote(stepUp.desc!),
    };
  // One copy per HTTP status.
  for (const m of text.matchAll(
    new RegExp(
      String.raw`err\.status === (?<status>\d+)\)\s*return\s*\{\s*title:\s*${strOrKey},\s*${desc}`,
      "g",
    ),
  ))
    copies[`status-${m.groups!.status}`] = {
      title: title(m.groups!),
      message: unquote(m.groups!.desc!),
    };
  // Everything else.
  const fallback = new RegExp(
    String.raw`\n {2}return\s*\{\s*title:\s*${strOrKey},\s*${desc}`,
  ).exec(text)?.groups;
  if (fallback)
    copies.default = {
      title: title(fallback),
      message: unquote(fallback.desc!),
    };
  return {
    copies,
    titles: (text.match(/\btitle:\s*(?:"|t\()/g) ?? []).length,
  };
}

describe("the portal's own copy", () => {
  const source = portalErrorsSource();

  it("is read whole from errors.ts", () => {
    // A copy errors.ts words in a shape this reader does not know would be missed silently.
    expect(Object.keys(source.copies)).toHaveLength(source.titles);
    expect(source.copies).toHaveProperty("step_up_required");
    expect(source.copies).toHaveProperty("default");
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
  it("every entry heading is the catalog's title, and every branch quotes its message", () => {
    for (const entry of entries) {
      expect(entry.title, entry.id).toBe(KNOWN_ENTRIES.get(entry.id)!.title);
      for (const branch of entry.branches)
        for (const id of branch.ids) {
          expect(KNOWN_ENTRIES.get(id)!.title, id).toBe(entry.title);
          expect(KNOWN_ENTRIES.get(id)!.message, id).toBe(branch.message);
        }
    }
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
        " license is already in another Polaris Key account. A license never moves by its key.",
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

  it("carry the translated title of every id of every entry", () => {
    for (const entry of entries) {
      const english = new Set(
        entry.ids.map((id) => KNOWN_ENTRIES.get(id)!.title.toLowerCase()),
      );
      const expected = new Set<string>();
      for (const pack of Object.values(TRANSLATED_CATALOGS))
        for (const id of entry.ids) {
          const title = catalogEntries(pack).get(id)?.title;
          if (title !== undefined && !english.has(title.toLowerCase()))
            expected.add(title.toLowerCase());
        }
      const actual = aliasesFor(entry.ids);
      expect(
        new Set(actual.map((a) => a.title.toLowerCase())),
        entry.id,
      ).toEqual(expected);
      for (const alias of actual) {
        expect(locales, entry.id).toContain(alias.lang);
        expect(alias.title, entry.id).not.toContain("{");
      }
    }
    // The portal's own copy is English only: it has no translated title to index.
    expect(aliasesFor(["portal.default"])).toEqual([]);
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

  it("keep each branch within 120 words", () => {
    for (const entry of entries)
      for (const branch of entry.branches)
        expect(
          words(`${branch.message} ${branch.why ?? ""} ${branch.fix ?? ""}`),
          branch.ids[0],
        ).toBeLessThanOrEqual(120);
  });

  it("bold only labels a screen shows", () => {
    const kit = Object.values(
      JSON.parse(
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
      ) as Record<string, string>,
    );
    const portalDir = join(repoRoot, "packages", "admin", "src", "portal");
    const portal = readdirSync(portalDir, { recursive: true })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => read(join(portalDir, f)))
      .join("\n");
    const labels = new Set<string>();
    for (const m of Object.values(HELP_MESSAGES.messages))
      for (const text of [m.why, m.fix])
        for (const part of textParts(text ?? ""))
          if (typeof part !== "string") labels.add(part.strong);
    expect(labels.size).toBeGreaterThan(0);
    for (const label of labels)
      expect(
        kit.includes(label) || portal.includes(label),
        `**${label}** is not a string a kit or the portal shows`,
      ).toBe(true);
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

  it("indexes the real map: every title once, sorted", () => {
    const rows = indexRows(HELP_MESSAGES, KNOWN_ENTRIES);
    const titles = new Set([...KNOWN_ENTRIES.values()].map((e) => e.title));
    expect(rows.map((r) => r.title).sort()).toEqual([...titles].sort());
    const sorted = [...rows].sort((a, b) =>
      new Intl.Collator("en", {
        sensitivity: "base",
        ignorePunctuation: true,
      }).compare(a.title, b.title),
    );
    expect(rows).toEqual(sorted);
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
          .map((e) => [e.id, KNOWN_ENTRIES.get(e.id)!.title]);
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
        "This <var>app name</var> license is already in another Polaris Key account.",
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
  },
);
