/**
 * A-18b — the shared listing model's projection (notes/S-15 §7.3): one test per store column of
 * S-15 §7.3 (Apple, Play, Microsoft, Steam, Flathub, Snap, winget, F-Droid), each with an
 * over-limit case that yields an issue and NO truncation (the store gets no payload and the model
 * is unchanged); keyword packing per store; overrides; the release notes' short form and its
 * proposed cut; the fit report's colours; and the model's own validators.
 */

import { describe, expect, it } from "vitest";
import {
  appProblems,
  assetProblems,
  LISTING_ASSET_SLOTS,
  localeTextProblems,
  overrideProblems,
  precedenceProblems,
  releaseNotesProblems,
  type ListingModel,
} from "../src/core/storefront/listingModel.js";
import {
  adapterListingProfile,
  LISTING_STORES,
  STORE_LISTING_COLUMNS,
  type ListingStore,
} from "../src/core/storefront/listingProfiles.js";
import {
  fitReport,
  projectListing,
  proposeCut,
  type ProjectionInput,
} from "../src/core/storefront/projection.js";
import { fitListing } from "../src/core/storefront/listing.js";
import { storefrontAdapter } from "../src/core/storefront/adapter.js";

/** A model that fits every store. */
function model(over: Partial<ListingModel> = {}): ListingModel {
  return {
    app: {
      defaultLocale: "en-US",
      name: "Diceroll",
      developerName: "Vlad",
      category: "games",
      urls: {
        website: "https://diceroll.example",
        support: "https://diceroll.example/support",
        privacy: "https://diceroll.example/privacy",
        marketing: "https://diceroll.example/m",
      },
      contactEmail: "support@diceroll.example",
      copyright: "© 2026 Vlad",
      tint: "#ff8800",
    },
    locales: {
      "en-US": {
        subtitle: "Roll dice with friends",
        shortDescription: "A tiny dice roller for tabletop nights.",
        description: "Diceroll rolls dice.\n\nThat is all it does.",
        keywords: ["dice", "tabletop", "rpg", "roller"],
        features: ["Roll any die", "Share results"],
        promotionalText: "Now with d100.",
      },
    },
    overrides: [],
    ...over,
  };
}

const notes = { "en-US": { text: "Fixed the d20.", short: null } };
const input = (m: ListingModel = model()): ProjectionInput => ({
  model: m,
  releaseNotes: notes,
});

/** A model whose `field` in en-US (or at app level) is `value`. */
function withLocale(field: string, value: unknown): ListingModel {
  const m = model();
  return {
    ...m,
    locales: { "en-US": { ...m.locales["en-US"], [field]: value } },
  };
}

function expectBlockedUnchanged(
  store: ListingStore,
  m: ListingModel,
  field: string,
  limit: number,
  actual: number,
  unit: "chars" | "bytes" = "chars",
) {
  const frozen = JSON.stringify(m);
  const p = projectListing(input(m), store);
  expect(p.payload).toBeNull();
  expect(p.issues.filter((i) => i.field === field)).toEqual([
    expect.objectContaining({
      store,
      field,
      issue: "too_long",
      severity: "block",
      limit,
      actual,
      unit,
    }),
  ]);
  expect(JSON.stringify(m)).toBe(frozen);
}

describe("every store column projects a model that fits", () => {
  for (const store of LISTING_STORES)
    it(`${store}: a payload and no blocking issue`, () => {
      const p = projectListing(input(), store);
      expect(p.issues.filter((i) => i.severity === "block")).toEqual([]);
      expect(p.payload).not.toBeNull();
    });
});

describe("per store column (S-15 §7.3): limits, and over a limit is an issue, never a cut", () => {
  it("Apple: name 30, subtitle 30, description 4,000, promotional text 170, whatsNew 4,000", () => {
    const p = projectListing(input(), "app-store");
    expect(p.payload!.locales["en-US"]).toMatchObject({
      name: "Diceroll",
      subtitle: "Roll dice with friends",
      keywords: "dice,tabletop,rpg,roller",
      promotionalText: "Now with d100.",
      whatsNew: "Fixed the d20.",
      supportUrl: "https://diceroll.example/support",
    });
    expectBlockedUnchanged(
      "app-store",
      withLocale("name", "n".repeat(31)),
      "name",
      30,
      31,
    );
    expectBlockedUnchanged(
      "app-store",
      withLocale("subtitle", "s".repeat(31)),
      "subtitle",
      30,
      31,
    );
    expectBlockedUnchanged(
      "app-store",
      withLocale("promotionalText", "p".repeat(171)),
      "promotionalText",
      170,
      171,
    );
    const longNotes = projectListing(
      {
        model: model(),
        releaseNotes: { "en-US": { text: "w".repeat(4001), short: null } },
      },
      "app-store",
    );
    expect(longNotes.payload).toBeNull();
    expect(longNotes.issues).toEqual([
      expect.objectContaining({
        field: "whatsNew",
        issue: "too_long",
        limit: 4000,
        actual: 4001,
      }),
    ]);
  });

  it("Apple: the support URL is required", () => {
    const m = model();
    const p = projectListing(
      input({
        ...m,
        app: { ...m.app, urls: { website: "https://x.example" } },
      }),
      "app-store",
    );
    expect(p.payload).toBeNull();
    expect(p.issues).toEqual([
      expect.objectContaining({
        field: "supportUrl",
        issue: "missing",
        severity: "block",
      }),
    ]);
  });

  it("Play: title 30, short description 80, full description 4,000, release notes 500", () => {
    const p = projectListing(input(), "play");
    expect(p.payload!.locales["en-US"]).toMatchObject({
      title: "Diceroll",
      fullDescription: "Diceroll rolls dice.\n\nThat is all it does.",
      releaseNotes: "Fixed the d20.",
    });
    expect(p.payload!.app).toMatchObject({
      contactWebsite: "https://diceroll.example",
      contactEmail: "support@diceroll.example",
    });
    // Over Play's 80 only through an override (the model holds 78).
    const m = model({
      overrides: [
        {
          store: "play",
          locale: null,
          field: "shortDescription",
          value: "x".repeat(81),
        },
      ],
    });
    expectBlockedUnchanged("play", m, "shortDescription", 80, 81);
  });

  it("Microsoft: the name is the store's own; description 10,000; features 20 × 200", () => {
    const p = projectListing(input(), "ms-store");
    expect(p.payload!.locales["en-US"]!.name).toBeUndefined();
    expect(p.cells.find((c) => c.field === "name")).toMatchObject({
      plane: "manual",
      status: "green",
    });
    expect(p.payload!.locales["en-US"]!.features).toEqual([
      "Roll any die",
      "Share results",
    ]);
    const m = model({
      overrides: [
        {
          store: "ms-store",
          locale: null,
          field: "description",
          value: "d".repeat(10001),
        },
      ],
    });
    expectBlockedUnchanged("ms-store", m, "description", 10000, 10001);
    const many = projectListing(
      input(withLocale("features", Array(21).fill("f"))),
      "ms-store",
    );
    expect(many.payload).toBeNull();
    expect(many.issues).toEqual([
      expect.objectContaining({
        field: "features",
        issue: "too_many",
        limit: 20,
        actual: 21,
      }),
    ]);
  });

  it("Microsoft: the short description over the 270 shown is amber, over 1,000 red", () => {
    const amber = projectListing(
      input(
        model({
          overrides: [
            {
              store: "ms-store",
              locale: null,
              field: "shortDescription",
              value: "s".repeat(271),
            },
          ],
        }),
      ),
      "ms-store",
    );
    expect(amber.payload).not.toBeNull();
    expect(amber.issues).toEqual([
      expect.objectContaining({
        issue: "over_recommended",
        severity: "warn",
        limit: 270,
        actual: 271,
      }),
    ]);
    expectBlockedUnchanged(
      "ms-store",
      model({
        overrides: [
          {
            store: "ms-store",
            locale: null,
            field: "shortDescription",
            value: "s".repeat(1001),
          },
        ],
      }),
      "shortDescription",
      1000,
      1001,
    );
  });

  it("Steam: copy cards; a short description over a few hundred is amber, never red", () => {
    const p = projectListing(input(), "steam");
    expect(p.cells.every((c) => c.plane === "copy")).toBe(true);
    const long = projectListing(
      input(
        model({
          overrides: [
            {
              store: "steam",
              locale: null,
              field: "shortDescription",
              value: "s".repeat(301),
            },
          ],
        }),
      ),
      "steam",
    );
    expect(long.payload!.locales["en-US"]!.shortDescription).toBe(
      "s".repeat(301),
    );
    expect(long.issues).toEqual([
      expect.objectContaining({
        field: "shortDescription",
        issue: "over_recommended",
        severity: "warn",
      }),
    ]);
    // The name is still required (the copy card needs it).
    const m = model();
    const noName = projectListing(
      input({ ...m, app: { ...m.app, name: undefined } }),
      "steam",
    );
    expect(noName.issues).toEqual([
      expect.objectContaining({ field: "name", issue: "missing" }),
    ]);
  });

  it("Flathub: name under 20 (ideally 15: amber), summary 35", () => {
    const amber = projectListing(
      input(withLocale("name", "Diceroll Deluxe XL")),
      "flathub",
    );
    expect(amber.payload).not.toBeNull();
    expect(amber.issues).toEqual([
      expect.objectContaining({
        field: "name",
        issue: "over_recommended",
        severity: "warn",
        limit: 15,
        actual: 18,
      }),
    ]);
    expect(
      fitReport(input(withLocale("name", "Diceroll Deluxe XL")), [
        "flathub",
      ])[0]!.status,
    ).toBe("amber");
    expectBlockedUnchanged(
      "flathub",
      withLocale("name", "Diceroll Deluxe Extra"),
      "name",
      19,
      21,
    );
    const summary = model({
      overrides: [
        {
          store: "flathub",
          locale: "en-US",
          field: "subtitle",
          value: "s".repeat(36),
        },
      ],
    });
    expectBlockedUnchanged("flathub", summary, "summary", 35, 36);
  });

  it("Snap: title 40, summary 78", () => {
    const p = projectListing(input(), "snap");
    expect(p.payload!.locales["en-US"]).toMatchObject({
      title: "Diceroll",
      summary: "A tiny dice roller for tabletop nights.",
    });
    const m = model({
      overrides: [
        { store: "snap", locale: null, field: "name", value: "t".repeat(41) },
      ],
    });
    expectBlockedUnchanged("snap", m, "title", 40, 41);
  });

  it("winget: PackageName 256, ShortDescription 256, Description 10,000, ReleaseNotes 10,000", () => {
    const p = projectListing(input(), "winget");
    expect(p.payload!.app).toMatchObject({
      Publisher: "Vlad",
      PublisherSupportUrl: "https://diceroll.example/support",
      Copyright: "© 2026 Vlad",
    });
    expect(p.payload!.locales["en-US"]!.Tags).toEqual([
      "dice",
      "tabletop",
      "rpg",
      "roller",
    ]);
    const m = model({
      overrides: [
        {
          store: "winget",
          locale: null,
          field: "shortDescription",
          value: "s".repeat(257),
        },
      ],
    });
    expectBlockedUnchanged("winget", m, "ShortDescription", 256, 257);
  });

  it("F-Droid: name 50, summary 80, description 4,000, what's new 500", () => {
    const p = projectListing(input(), "fdroid");
    expect(p.payload!.locales["en-US"]).toMatchObject({
      name: "Diceroll",
      whatsNew: "Fixed the d20.",
    });
    const m = model({
      overrides: [
        { store: "fdroid", locale: null, field: "name", value: "n".repeat(51) },
      ],
    });
    expectBlockedUnchanged("fdroid", m, "name", 50, 51);
  });
});

describe("keyword packing (S-15 §7.3): what is left out is shown, amber", () => {
  it("Apple joins with commas under 100 BYTES", () => {
    // Five two-byte characters a term: 10 bytes, 5 characters. Bytes fit 9 (9*10 + 8 = 98);
    // characters alone would have fit all 12 (12*5 + 11 = 71).
    const terms = Array.from({ length: 12 }, () => "äääää");
    const p = projectListing(input(withLocale("keywords", terms)), "app-store");
    const joined = p.payload!.locales["en-US"]!.keywords as string;
    expect(new TextEncoder().encode(joined).length).toBeLessThanOrEqual(100);
    expect(joined.split(",")).toHaveLength(9);
    expect(p.issues).toEqual([
      expect.objectContaining({
        field: "keywords",
        issue: "packed",
        severity: "warn",
        limit: 9,
        actual: 12,
      }),
    ]);
  });

  it("Microsoft takes at most 7 terms of at most 30 characters, within 21 words", () => {
    const terms = [
      "dice-roller-for-tabletop-nights-x", // 33 characters: left out
      "aa bb cc dd ee ff gg hh ii jj", // 10 words
      "kk ll mm nn oo pp qq rr ss tt", // 20
      "uu vv", // would be 22: left out
      "w", // 21
      "x",
      "y",
    ];
    const p = projectListing(input(withLocale("keywords", terms)), "ms-store");
    const kept = p.payload!.locales["en-US"]!.keywords as string[];
    expect(kept).toEqual([terms[1], terms[2], "w"]);
    expect(p.issues.map((i) => i.issue).sort()).toEqual([
      "item_too_long",
      "packed",
    ]);
    expect(p.issues.every((i) => i.severity === "warn")).toBe(true);
    const seven = projectListing(
      input(
        withLocale("keywords", ["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
      ),
      "ms-store",
    );
    expect(seven.payload!.locales["en-US"]!.keywords).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(seven.issues).toEqual([
      expect.objectContaining({ issue: "packed", limit: 7, actual: 9 }),
    ]);
  });

  it("winget takes at most 16 tags of 40", () => {
    const terms = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const p = projectListing(input(withLocale("keywords", terms)), "winget");
    expect(p.payload!.locales["en-US"]!.Tags).toEqual(terms.slice(0, 16));
    expect(p.issues).toEqual([
      expect.objectContaining({
        field: "Tags",
        issue: "packed",
        limit: 16,
        actual: 20,
      }),
    ]);
  });
});

describe("overrides and locales", () => {
  it("a locale's override beats the every-locale one, which beats the model", () => {
    const m = model({
      locales: {
        "en-US": model().locales["en-US"]!,
        "fr-FR": {
          subtitle: "Lancez les dés",
          description: "Diceroll lance des dés.",
        },
      },
      overrides: [
        {
          store: "app-store",
          locale: null,
          field: "subtitle",
          value: "Every locale",
        },
        {
          store: "app-store",
          locale: "fr-FR",
          field: "subtitle",
          value: "Seulement fr",
        },
      ],
    });
    const p = projectListing(input(m), "app-store");
    expect(p.payload!.locales["en-US"]!.subtitle).toBe("Every locale");
    expect(p.payload!.locales["fr-FR"]!.subtitle).toBe("Seulement fr");
    // The app-level name stands in where a locale has none.
    expect(p.payload!.locales["fr-FR"]!.name).toBe("Diceroll");
    // Projection order: the default locale first.
    expect(Object.keys(p.payload!.locales)).toEqual(["en-US", "fr-FR"]);
  });
});

describe("release notes: the short form (S-15 §5.5)", () => {
  const long =
    "We rewrote the dice engine from scratch. ".repeat(10) +
    "Rolls are now fair on every platform! " +
    "The d100 is back. ".repeat(10);

  it("notes over 500 with no short form are red on Play and F-Droid, with a proposed cut, never a cut", () => {
    expect(long.length).toBeGreaterThan(500);
    const i = {
      model: model(),
      releaseNotes: { "en-US": { text: long, short: null } },
    };
    for (const store of ["play", "fdroid"] as const) {
      const p = projectListing(i, store);
      expect(p.payload).toBeNull();
      const issue = p.issues.find((x) => x.from === "releaseNotesShort")!;
      expect(issue).toMatchObject({
        issue: "too_long",
        severity: "block",
        limit: 500,
        actual: long.length,
      });
      expect(issue.proposal!.length).toBeLessThanOrEqual(500);
      expect(issue.proposal).toMatch(/[.!?]$/);
      expect(long.startsWith(issue.proposal!)).toBe(true);
    }
    // Apple takes the full text (4,000).
    expect(
      projectListing(i, "app-store").payload!.locales["en-US"]!.whatsNew,
    ).toBe(long);
  });

  it("a stored short form is what Play and F-Droid get", () => {
    const i = {
      model: model(),
      releaseNotes: { "en-US": { text: long, short: "Fairer dice." } },
    };
    expect(
      projectListing(i, "play").payload!.locales["en-US"]!.releaseNotes,
    ).toBe("Fairer dice.");
    expect(
      projectListing(i, "app-store").payload!.locales["en-US"]!.whatsNew,
    ).toBe(long);
  });

  it("proposeCut cuts at a sentence end in the second half, else a space, else the limit", () => {
    expect(proposeCut("short", 500)).toBe("short");
    expect(proposeCut("One. Two three four five six.", 20)).toBe(
      "One. Two three four",
    );
    expect(proposeCut("Aaaaaaaaaaaaaaa. Bbbbbbb cccccc", 25)).toBe(
      "Aaaaaaaaaaaaaaa.",
    );
    expect(proposeCut("Aaaaaaaaaaa. Bbbbbbb cccccc dddddd", 25)).toBe(
      "Aaaaaaaaaaa. Bbbbbbb",
    );
    expect(proposeCut("aaaaaaaaaa bbbbbbbbbb cccccccccc", 25)).toBe(
      "aaaaaaaaaa bbbbbbbbbb",
    );
    expect(proposeCut("x".repeat(30), 25)).toBe("x".repeat(25));
    expect(proposeCut("First line\nsecond line goes on", 20)).toBe(
      "First line",
    );
  });
});

describe("the fit report", () => {
  it("one row per store, one cell per field and locale, graded green, amber or red", () => {
    const m = model();
    const report = fitReport(
      input({ ...m, app: { ...m.app, contactEmail: undefined } }),
    );
    expect(report.map((r) => r.store)).toEqual([...LISTING_STORES]);
    const byStore = Object.fromEntries(report.map((r) => [r.store, r]));
    expect(byStore.play!.status).toBe("red");
    expect(
      byStore.play!.cells.find((c) => c.field === "contactEmail"),
    ).toMatchObject({
      locale: null,
      status: "red",
      present: false,
    });
    expect(byStore["app-store"]!.status).toBe("green");
    for (const r of report) {
      const column = STORE_LISTING_COLUMNS[r.store];
      expect(r.label).toBe(column.label);
      const perLocale = Object.values(column.fields).filter(
        (f) => f.perLocale,
      ).length;
      const app = Object.values(column.fields).length - perLocale;
      expect(r.cells).toHaveLength(perLocale + app);
    }
  });
});

describe("the adapter's ListingProfile comes from its column (conformance item 7)", () => {
  it("Apple's profile is its column's api fields, and fitListing agrees with the projection", () => {
    const apple = storefrontAdapter("app-store")!;
    expect(apple.listing).toEqual(
      adapterListingProfile(STORE_LISTING_COLUMNS["app-store"]),
    );
    expect(Object.keys(apple.listing.fields)).toEqual(
      expect.arrayContaining([
        "name",
        "subtitle",
        "description",
        "keywords",
        "promotionalText",
        "whatsNew",
      ]),
    );
    expect(
      fitListing(apple.listing, { "en-US": { name: "n".repeat(31) } }).filter(
        (i) => i.field === "name",
      ),
    ).toEqual([
      {
        field: "name",
        locale: "en-US",
        issue: "too_long",
        limit: 30,
        actual: 31,
      },
    ]);
  });

  it("every column's limited text fields fit at the limit and are red one over", () => {
    for (const store of LISTING_STORES) {
      for (const [name, f] of Object.entries(
        STORE_LISTING_COLUMNS[store].fields,
      )) {
        if (
          f.kind !== "text" ||
          f.maxChars === undefined ||
          f.plane === "manual"
        )
          continue;
        if (f.from === "releaseNotes" || f.from === "releaseNotesShort")
          continue;
        const ov = (value: string) =>
          model({ overrides: [{ store, locale: null, field: f.from, value }] });
        const at = projectListing(input(ov("a".repeat(f.maxChars))), store);
        expect(
          at.issues.filter((i) => i.field === name && i.severity === "block"),
          `${store}.${name}`,
        ).toEqual([]);
        const over = projectListing(
          input(ov("a".repeat(f.maxChars + 1))),
          store,
        );
        expect(over.payload, `${store}.${name}`).toBeNull();
        expect(
          over.issues.filter((i) => i.field === name).map((i) => i.issue),
        ).toEqual(["too_long"]);
      }
    }
  });
});

describe("the model's validators (refuse, never cut)", () => {
  it("app fields", () => {
    expect(
      appProblems({ defaultLocale: "en-US", name: "Diceroll" }, true),
    ).toEqual([]);
    expect(appProblems({}, true).map((p) => p.field)).toEqual([
      "defaultLocale",
    ]);
    expect(appProblems({ name: "n".repeat(31) })).toEqual([
      {
        field: "name",
        message: "name must be at most 30 characters (it is 31)",
      },
    ]);
    expect(appProblems({ tint: "orange" }).map((p) => p.field)).toEqual([
      "tint",
    ]);
    expect(
      appProblems({ urls: { website: "http://x.example" } }).map(
        (p) => p.field,
      ),
    ).toEqual(["urls.website"]);
    expect(
      appProblems({ urls: { blog: "https://x.example" } }).map((p) => p.field),
    ).toEqual(["urls.blog"]);
    expect(
      appProblems({ category: "Games & Fun" }).map((p) => p.field),
    ).toEqual(["category"]);
    expect(appProblems({ contactEmail: "nope" }).map((p) => p.field)).toEqual([
      "contactEmail",
    ]);
    expect(appProblems({ bogus: 1 }).map((p) => p.field)).toEqual(["bogus"]);
  });

  it("locale fields: subtitle 30, short 78, description 4,000, promo 170, features 20 × 200", () => {
    const at = (f: string) => `locales.en-US.${f}`;
    expect(
      localeTextProblems(
        "en-US",
        model().locales["en-US"] as Record<string, unknown>,
      ),
    ).toEqual([]);
    const fields = (patch: Record<string, unknown>) =>
      localeTextProblems("en-US", patch).map((p) => p.field);
    expect(fields({ subtitle: "s".repeat(31) })).toEqual([at("subtitle")]);
    expect(fields({ shortDescription: "s".repeat(79) })).toEqual([
      at("shortDescription"),
    ]);
    expect(fields({ description: "d".repeat(4001) })).toEqual([
      at("description"),
    ]);
    expect(fields({ promotionalText: "p".repeat(171) })).toEqual([
      at("promotionalText"),
    ]);
    expect(fields({ features: Array(21).fill("f") })).toEqual([at("features")]);
    expect(fields({ features: ["f".repeat(201)] })).toEqual([
      `${at("features")}[0]`,
    ]);
    expect(fields({ subtitle: "two\nlines" })).toEqual([at("subtitle")]);
    expect(fields({ description: "two\nlines" })).toEqual([]);
  });

  it("release notes: text ≤ 10,000, short ≤ 500", () => {
    expect(releaseNotesProblems({ text: "ok", short: "ok" })).toEqual([]);
    expect(releaseNotesProblems({ text: "" }).map((p) => p.field)).toEqual([
      "text",
    ]);
    expect(
      releaseNotesProblems({ text: "t".repeat(10001) }).map((p) => p.field),
    ).toEqual(["text"]);
    expect(
      releaseNotesProblems({ text: "ok", short: "s".repeat(501) }).map(
        (p) => p.field,
      ),
    ).toEqual(["short"]);
  });

  it("overrides name a known store and model field", () => {
    const stores = ["play"];
    expect(
      overrideProblems(
        { store: "play", field: "shortDescription", value: "x" },
        stores,
      ),
    ).toEqual([]);
    expect(
      overrideProblems(
        { store: "nope", field: "name", value: "x" },
        stores,
      ).map((p) => p.field),
    ).toEqual(["store"]);
    expect(
      overrideProblems(
        { store: "play", field: "nope", value: "x" },
        stores,
      ).map((p) => p.field),
    ).toEqual(["field"]);
    expect(
      overrideProblems(
        { store: "play", field: "keywords", value: "x" },
        stores,
      ).map((p) => p.field),
    ).toEqual(["value"]);
    expect(
      overrideProblems({ store: "play", field: "name", value: null }, stores),
    ).toEqual([]);
  });

  it("precedence lists distinct known sources", () => {
    expect(precedenceProblems({ name: ["manifest", "app-store"] })).toEqual([]);
    expect(precedenceProblems({ name: ["manifest", "manifest"] }).length).toBe(
      1,
    );
    expect(precedenceProblems({ name: ["nope"] }).length).toBe(1);
    expect(precedenceProblems({ nope: ["manifest"] }).length).toBe(1);
  });

  it("asset slots carry their text rule", () => {
    expect(LISTING_ASSET_SLOTS["steam:library-hero"]).toBe("none");
    expect(LISTING_ASSET_SLOTS["ms-store:super-hero"]).toBe("none");
    expect(LISTING_ASSET_SLOTS["steam:header-capsule"]).toBe("title");
    expect(LISTING_ASSET_SLOTS["screenshot:phone-portrait"]).toBe("free");
    const ok = {
      slot: "key-art",
      locale: null,
      blob: "blobs/abc",
      sha256: "a".repeat(64),
      width: 3840,
      height: 2160,
      alpha: false,
      derivedFrom: null,
      textAllowed: "none" as const,
    };
    expect(assetProblems(ok)).toEqual([]);
    expect(
      assetProblems({ ...ok, textAllowed: "free" }).map((p) => p.field),
    ).toEqual(["textAllowed"]);
    expect(assetProblems({ ...ok, slot: "nope" }).map((p) => p.field)).toEqual([
      "slot",
    ]);
  });
});
