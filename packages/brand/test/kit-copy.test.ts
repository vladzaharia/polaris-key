// The kit copy catalog (plans/UK-02.md §3.1–§3.3): the committed sources pass every check, each
// check refuses what it should, the per-platform renderers match their goldens on a small
// synthetic catalog, and the gettext plural formulas agree with Intl.PluralRules.
// Goldens: UPDATE_GOLDENS=1 rewrites test/kit-copy-golden/*.golden. Drift of the committed
// outputs is test/generated.test.ts's `run({ check: true })`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildKitCopyModel,
  COMPONENTS,
  formatMessage,
  gettextFile,
  KIT_COPY_TARGETS,
  KIT_LOCALES,
  loadKitCopySources,
  lookup,
  nodeModule,
  parseMessage,
  PLURAL_FORMS,
  pluralCategories,
  pythonModule,
  stringsXml,
  tableFor,
  titleCase,
  validateKitCopy,
  webIndex,
  webJson,
  xcstrings,
  type KitCopySources,
} from "../scripts/kit-copy.js";

const GOLDEN = join(import.meta.dirname, "kit-copy-golden");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

function golden(name: string, actual: string): void {
  const path = join(GOLDEN, `${name}.golden`);
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

const REAL = loadKitCopySources();
const clone = (): KitCopySources =>
  JSON.parse(JSON.stringify(REAL)) as KitCopySources;

describe("the committed catalog", () => {
  it("passes every check", () => {
    expect(validateKitCopy(REAL)).toEqual([]);
  });

  it("has every key in all nine locales", () => {
    const keys = Object.keys(REAL.en.messages);
    for (const locale of KIT_LOCALES.slice(1))
      expect(Object.keys(REAL.packs[locale]!.messages).sort()).toEqual(
        [...keys].sort(),
      );
  });

  it("marks every pack and translated core pack reviewed: false", () => {
    for (const locale of KIT_LOCALES.slice(1)) {
      expect(REAL.packs[locale]!.reviewed).toBe(false);
      if (REAL.core[locale]) expect(REAL.core[locale]!.reviewed).toBe(false);
    }
  });

  it("carries the owner's device-limit wording (plans/I-04.md, 2026-10-05)", () => {
    const m = REAL.en.messages;
    expect(m["deviceLimit.title"]!.value).toBe("Replace a device");
    expect(m["deviceLimit.confirmTitle"]!.value).toBe("Replace {device}?");
    expect(m["deviceLimit.primary"]!.value).toBe("Replace and continue");
    expect(m["deviceLimit.consequence"]!.value).toBe(
      m["signin.replace.consequence"]!.value,
    );
    expect(m["signin.choice.accountWide"]!.value).toBe(
      // Account-wide licenses stay device-limited (owner, 2026-10-05; SIGN-IN.md D-53 on main)
      "Account-wide · {used} of {limit, plural, one {# device} other {# devices}}",
    );
    expect(m["signin.term.lifetime"]!.value).toBe("Lifetime");
  });

  it("writes every output with a GENERATED banner where the format has comments", () => {
    const model = buildKitCopyModel(REAL);
    for (const t of KIT_COPY_TARGETS) {
      if (/\.(json|xcstrings)$/.test(t.path)) continue; // JSON: listed in AGENTS rule 3 instead
      expect(t.render(), t.path).toContain(
        "GENERATED FILE — do not edit by hand.",
      );
    }
    expect(model.entries.some((e) => e.key === "core.fallback.title")).toBe(
      true,
    );
  });
});

describe("the checks refuse", () => {
  const errorsAfter = (mutate: (s: KitCopySources) => void): string[] => {
    const s = clone();
    mutate(s);
    return validateKitCopy(s);
  };
  const en = (s: KitCopySources, key: string) => s.en.messages[key]!;

  it("a key that breaks the pattern, and a kit key under core.", () => {
    expect(
      errorsAfter((s) => {
        s.en.messages["common.Bad"] = { ...en(s, "common.cancel") };
        s.en.messages["core.extra"] = { ...en(s, "common.cancel") };
      }),
    ).toEqual(
      expect.arrayContaining([
        "en common.Bad: key breaks the pattern",
        "en core.extra: core.* is reserved for core copy",
      ]),
    );
  });

  it("a locale with a missing or an extra key", () => {
    const errors = errorsAfter((s) => {
      delete s.packs.de!.messages["common.cancel"];
      s.packs.ja!.messages["common.madeUp"] = "x";
    });
    expect(errors).toContain("de common.cancel: missing");
    expect(errors).toContain("ja common.madeUp: not in en.json");
  });

  it("an argument set that differs from English, and an argument outside the closed set", () => {
    const errors = errorsAfter((s) => {
      s.packs.de!.messages["welcome.title"] = "Willkommen";
      en(s, "common.cancel").value = "Cancel {thing}";
      s.packs.de!.messages["common.cancel"] = "Abbrechen {thing}";
    });
    expect(errors).toContain(
      "de welcome.title: arguments none differ from en's {product}",
    );
    expect(errors).toContain(
      "en common.cancel: argument {thing} is outside the closed set",
    );
  });

  it("ICU outside the subset", () => {
    const errors = errorsAfter((s) => {
      en(s, "common.cancel").value = "{count, number}";
      en(s, "common.close").value =
        "{count, plural, =0 {none} one {# x} other {# x}}";
      en(s, "common.back").value = "{product, select, a {x} other {y}}";
      en(s, "common.done").value =
        "{count, plural, one {# {product}} other {#}}";
    });
    expect(errors.some((e) => e.includes('ICU type "number"'))).toBe(true);
    expect(errors.some((e) => e.includes("no offsets or =N cases"))).toBe(true);
    expect(errors).toContain(
      "en common.back: select is only allowed on formFactor, not {product}",
    );
    expect(
      errors.some((e) => e.includes("a plural case may hold # and text only")),
    ).toBe(true);
  });

  it("plural categories that are not the locale's", () => {
    const errors = errorsAfter((s) => {
      s.packs.ja!.messages["devices.count"] =
        "{count, plural, one {#台} other {#台}}";
      s.packs.fr!.messages["devices.count"] =
        "{count, plural, one {# appareil} other {# appareils}}";
    });
    expect(errors).toContain(
      "ja devices.count: plural categories one, other differ from ja's CLDR categories other",
    );
    expect(errors).toContain(
      "fr devices.count: plural categories one, other differ from fr's CLDR categories one, many, other",
    );
  });

  it("a kit value equal to a core value (the duplicate ban)", () => {
    const errors = errorsAfter((s) => {
      en(s, "common.cancel").value = "something went wrong";
    });
    expect(
      errors.some((e) =>
        /^en common\.cancel: duplicates core copy core\.[a-z.-]+; reference that key instead$/.test(
          e,
        ),
      ),
    ).toBe(true);
  });

  it("banned vocabulary in English", () => {
    const errors = errorsAfter((s) => {
      en(s, "common.cancel").value = "Retry";
      en(s, "common.close").value = "Your licence";
      en(s, "common.back").value = "Your grant";
      en(s, "common.done").value = "This machine";
      en(s, "common.save").value = "Change plan";
    });
    for (const [key, word] of [
      ["common.cancel", "Retry"],
      ["common.close", "licence"],
      ["common.back", "grant"],
      ["common.done", "machine"],
      ["common.save", "plan"],
    ])
      expect(errors).toContain(
        `en ${key}: "${word}" is banned vocabulary (license, device, tier; never grant)`,
      );
  });

  it("a control character, a tab and a %", () => {
    const errors = errorsAfter((s) => {
      s.packs.ko!.messages["common.cancel"] = "취소\t";
      s.packs.it!.messages["common.close"] = "100%";
    });
    expect(errors).toContain(
      "ko common.cancel: control character or tab (terminal safety)",
    );
    expect(errors.some((e) => e.startsWith('it common.close: "%"'))).toBe(true);
  });

  it("a changed Polaris Key", () => {
    expect(
      errorsAfter((s) => {
        s.packs.de!.messages["part.poweredBy"] = "Unterstützt von Polaris-Key";
      }),
    ).toContain(
      'de part.poweredBy: "Polaris Key" must appear exactly as in English',
    );
  });

  it("variants on a role that cannot carry them", () => {
    expect(
      errorsAfter((s) => {
        en(s, "common.copied").variants = { macos: "Copied" };
      }),
    ).toContain(
      "en common.copied: variants are only allowed on button, menu and windowTitle keys",
    );
  });

  it("a components.json key en.json lacks, and an en.json key no state lists", () => {
    const errors = errorsAfter((s) => {
      s.components.components.Boot!.states.progress!.copy.push("boot.nope");
      s.components.components.Boot!.states.progress!.copy.push(
        "core.codes.nope.title",
      );
      s.en.messages["boot.orphan"] = { ...en(s, "boot.ready") };
    });
    expect(errors).toContain(
      "components.json Boot.progress: boot.nope is not in en.json",
    );
    expect(errors).toContain(
      "components.json Boot.progress: core.codes.nope.title is not in copy.en.json",
    );
    expect(errors).toContain("en boot.orphan: no component state lists it");
  });

  it("a missing §4.1 component", () => {
    expect(
      errorsAfter((s) => {
        delete s.components.components.Toast;
      }),
    ).toContain("components.json: Toast is missing");
  });
});

describe("the ICU subset", () => {
  it("parses a plural with text around it", () => {
    const p = parseMessage(
      "{used} of {limit, plural, one {# device} other {# devices}} left",
    );
    expect(p.head).toEqual([{ arg: "used" }, { text: " of " }]);
    expect(p.complex?.kind).toBe("plural");
    expect(p.complex?.cases.one).toEqual([{ hash: true }, { text: " device" }]);
    expect(p.tail).toEqual([{ text: " left" }]);
  });

  it("refuses two complex arguments and quoting", () => {
    expect(() =>
      parseMessage("{count, plural, other {#}} {days, plural, other {#}}"),
    ).toThrow(/only one plural or select/);
    expect(() => parseMessage("it''s")).toThrow(/apostrophe/);
  });

  it("formats plurals per locale, selects by form factor, and leaves a missing argument visible", () => {
    const m = "{limit, plural, one {# device} other {# devices}}";
    expect(formatMessage("en", m, { limit: 1 })).toBe("1 device");
    expect(formatMessage("en", m, { limit: 0 })).toBe("0 devices");
    const fr =
      "{limit, plural, one {# appareil} many {# d’appareils} other {# appareils}}";
    expect(formatMessage("fr", fr, { limit: 0 })).toBe("0 appareil");
    expect(formatMessage("fr", fr, { limit: 1000000 })).toBe(
      "1000000 d’appareils",
    );
    const ff = REAL.en.messages["part.thisDevice"]!.value;
    expect(formatMessage("en", ff, { formFactor: "mac" })).toBe("this Mac");
    expect(formatMessage("en", ff, { formFactor: "toaster" })).toBe(
      "this device",
    );
    expect(formatMessage("en", "Welcome to {product}")).toBe(
      "Welcome to {product}",
    );
  });

  it("looks up the locale override, the locale, the English override, then English", () => {
    const tables = { en: { a: "A", b: "B" }, de: { a: "A-de" } };
    expect(lookup(tables, "de", "a")).toBe("A-de");
    expect(lookup(tables, "de", "b")).toBe("B");
    expect(lookup(tables, "de", "b", { en: { b: "B!" } })).toBe("B!");
    expect(lookup(tables, "de", "a", { de: { a: "über" } })).toBe("über");
    expect(lookup(tables, "ja", "a")).toBe("A");
  });

  it("title-cases English for macOS (D13)", () => {
    expect(titleCase("Skip this version")).toBe("Skip This Version");
    expect(titleCase("Continue with {provider}")).toBe(
      "Continue with {provider}",
    );
    expect(titleCase("Use a license key instead")).toBe(
      "Use a License Key Instead",
    );
    expect(titleCase("Sign in to sync")).toBe("Sign In to Sync");
    expect(titleCase("Open in browser")).toBe("Open in Browser");
  });

  it("generates the macOS title case variant only where none is given", () => {
    const model = buildKitCopyModel(REAL);
    const get = (k: string) => model.entries.find((e) => e.key === k)!;
    expect(get("update.skipVersion").variants.macos).toBe("Skip This Version");
    expect(get("update.restartWhenReady").variants.macos).toBe(
      "Install and Relaunch",
    );
    expect(get("common.copied").variants).toEqual({});
  });
});

describe("gettext Plural-Forms", () => {
  // msgstr[i] is the i-th category of pluralCategories(locale); the C expression must agree with
  // Intl.PluralRules for every n the kits can show.
  const evaluate = (forms: string, n: number): number => {
    const expr = /plural=(.*);$/.exec(forms)![1]!;
    return Function("n", `return Number(${expr});`)(n) as number;
  };
  const samples = [
    ...Array.from({ length: 2001 }, (_, i) => i),
    999999,
    1000000,
    1000001,
    2000000,
    3000000,
    10000000,
    1500000,
  ];
  for (const locale of KIT_LOCALES)
    it(`${locale} agrees with Intl.PluralRules`, () => {
      const cats = pluralCategories(locale);
      const forms = PLURAL_FORMS[locale]!;
      expect(Number(/nplurals=(\d+)/.exec(forms)![1])).toBe(cats.length);
      const rules = new Intl.PluralRules(locale);
      for (const n of samples)
        expect(cats[evaluate(forms, n)], `${locale} n=${n}`).toBe(
          rules.select(n),
        );
    });
});

describe("renderers (goldens over a synthetic catalog)", () => {
  // Two kit keys of each kind and one core entry, in all nine locales.
  const thisDevice =
    "{formFactor, select, iphone {this iPhone} ipad {this iPad} mac {this Mac} phone {this phone} tablet {this tablet} computer {this computer} tv {this TV} other {this device}}";
  const plural = (locale: string, one: string, many: string, other: string) => {
    const cats = pluralCategories(locale);
    const text: Record<string, string> = { one, many, other };
    return `{count, plural, ${cats.map((c) => `${c} {${text[c]}}`).join(" ")}}`;
  };
  const synthetic = (): KitCopySources => {
    const messages = {
      "common.signInTo": {
        value: "Sign in to {product}",
        role: "button" as const,
        note: "A button.",
      },
      "common.restart": {
        value: "Restart when ready",
        role: "button" as const,
        note: "Queues a restart.",
        variants: { macos: "Install and Relaunch" },
      },
      "part.devices": {
        value: "{product}: {count, plural, one {# device} other {# devices}}",
        role: "label" as const,
        note: "A count.",
      },
      "part.thisDevice": {
        value: thisDevice,
        role: "label" as const,
        note: "The device.",
      },
      "common.quote": {
        value: `Say "hi" & <wave> \\ {name}`,
        role: "body" as const,
        note: "Escaping.",
      },
    };
    const packs: KitCopySources["packs"] = {};
    for (const locale of KIT_LOCALES.slice(1))
      packs[locale] = {
        kitCopyVersion: 1,
        locale,
        reviewed: false,
        glossaryVersion: 1,
        messages: {
          "common.signInTo": `[${locale}] {product}`,
          "common.restart": `[${locale}] restart`,
          "part.devices": `{product} ${plural(locale, `# ${locale}-1`, `# ${locale}-M`, `# ${locale}-N`)}`,
          "part.thisDevice": thisDevice.replace(/this /g, `${locale} `),
          "common.quote": `[${locale}] "{name}"`,
        },
      };
    const core = {
      locale: "en",
      fallback: { title: "Oops", message: "Oops ({code})." },
      codes: { "not-found": { title: "Gone", message: "It's gone." } },
      gate: {},
      activation: {},
    };
    return {
      en: { kitCopyVersion: 1, locale: "en", messages },
      packs,
      glossary: {
        glossaryVersion: 1,
        neverTranslate: ["Polaris Key"],
        terms: {
          license: Object.fromEntries(
            KIT_LOCALES.map((l) => [l, `license-${l}`]),
          ),
        },
      },
      components: {
        componentsVersion: 1,
        components: Object.fromEntries(
          COMPONENTS.map((c) => [
            c,
            {
              priority: "must" as const,
              family: null,
              states: { default: { copy: [] } },
            },
          ]),
        ),
      },
      core: {
        en: core,
        de: {
          ...core,
          locale: "de",
          reviewed: false,
          fallback: { title: "Hoppla", message: "Hoppla ({code})." },
        },
      },
    };
  };
  const model = buildKitCopyModel(synthetic());

  it("records the locales whose core copy fell back to English", () => {
    expect(model.coreFallback).toEqual(
      KIT_LOCALES.filter((l) => l !== "en" && l !== "de"),
    );
    expect(tableFor(model, "de")["core.fallback.title"]).toBe("Hoppla");
    expect(tableFor(model, "ja")["core.fallback.title"]).toBe("Oops");
  });

  it("web", () => {
    golden("web-de.json", webJson(model, "de"));
    golden("web-index.ts", webIndex(model));
  });
  it("Node", () => golden("node.ts", nodeModule(model)));
  it("Swift", () => golden("Localizable.xcstrings", xcstrings(model)));
  it("Kotlin", () => {
    golden("strings-en.xml", stringsXml(model, "en"));
    golden("strings-fr.xml", stringsXml(model, "fr"));
  });
  it("gettext", () => {
    golden("template.pot", gettextFile(model, null, "template"));
    golden("pt_BR.po", gettextFile(model, "pt-BR", "pt-BR"));
    golden("ja.po", gettextFile(model, "ja", "ja"));
  });
  it("Python", () => golden("python.py", pythonModule(model)));
});
