// plans/UK-02b.md §9: the UI state matrix's generator checks, one failing input per refusal; the
// generator-local i18n formatter against hand-written vectors; and the rule that tools/ui-matrix.ts
// imports nothing it checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildUiMatrix,
  checkUiMatrix,
  FORM_FACTORS,
  LOCALES,
  loadUiMatrixSources,
  MUST_NOT,
  refFormat,
  refLookup,
  resolveTheme,
  servicesWithout,
  UI_MATRIX_VERSION,
  type Row,
  type UiMatrix,
  type UiMatrixSources,
} from "./ui-matrix.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = loadUiMatrixSources();
const DOC = buildUiMatrix(S);
const clone = <T>(v: T): T => structuredClone(v);
const row = (doc: UiMatrix, family: keyof UiMatrix, name: string): Row => {
  const r = (doc[family] as Row[]).find((x) => x.name === name);
  if (!r) throw new Error(`no row ${name}`);
  return r;
};

describe("ui-matrix.json", () => {
  it("is the committed file, at the generated version, ASCII only", () => {
    const text = readFileSync(
      join(ROOT, "conformance", "corpus", "v2", "ui-matrix.json"),
      "utf8",
    );
    const file = JSON.parse(text) as UiMatrix;
    expect(file.uiMatrixVersion).toBe(UI_MATRIX_VERSION);
    expect(UI_MATRIX_VERSION).toBe(1);
    expect(JSON.parse(JSON.stringify(DOC))).toEqual(file);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
    expect(text.toLowerCase()).not.toContain("\\u0000");
  });

  it("passes every check, and every family has rows", () => {
    expect(checkUiMatrix(DOC, S)).toEqual([]);
    for (const f of [
      "gate",
      "activate",
      "signIn",
      "deviceLimit",
      "devices",
      "update",
      "settings",
      "paywall",
      "theme",
      "i18n",
    ] as const)
      expect(DOC[f].length, f).toBeGreaterThan(0);
  });

  it("imports nothing it checks (plans/UK-02b.md §4.1)", () => {
    const src = readFileSync(join(ROOT, "tools", "ui-matrix.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["node:fs", "node:path", "node:url"]);
  });

  it("states UI-KITS §4.1's Must not for every must component", () => {
    const spec = readFileSync(
      join(ROOT, "docs", "design", "UI-KITS.md"),
      "utf8",
    );
    const table = spec.slice(spec.indexOf("**Must not.**"));
    const rows = new Map<string, string>();
    for (const m of table.matchAll(/^\| (\w+) +\| (.+?) +\|$/gm))
      if (m[1] !== "Component") rows.set(m[1]!, m[2]!);
    for (const [c, text] of Object.entries(MUST_NOT))
      expect(rows.get(c), c).toBe(text);
    const must = Object.entries(S.components)
      .filter(([, c]) => c.priority === "must")
      .map(([n]) => n);
    for (const c of must)
      if (rows.has(c)) expect(MUST_NOT[c], c).toBe(rows.get(c));
  });

  it("closes a services list under requires (ST-38)", () => {
    expect(servicesWithout(S.services, "release")).toEqual([
      "license",
      "config",
      "identity",
      "sync",
    ]);
    expect(servicesWithout(S.services, "config")).not.toContain("sync");
    expect(servicesWithout(S.services, "identity")).not.toContain("sync");
    expect(servicesWithout(S.services, "update")).toContain("distribution");
  });
});

describe("the generator refuses", () => {
  const cases: [string, (d: UiMatrix, s: UiMatrixSources) => void, string][] = [
    [
      "an unclosed services list",
      (d) => {
        row(d, "update", "UpdatePrompt: Update off").input.services = [
          "license",
          "config",
          "distribution",
          "identity",
          "sync",
        ];
      },
      "services is not closed",
    ],
    [
      "a device-code row whose outcome contradicts the poll",
      (d) => {
        (
          row(d, "signIn", "SignIn/code: a device-code sign-in").input
            .signIn as Record<string, unknown>
        ).outcome = "choose";
      },
      "outcome is absent or signedIn",
    ],
    [
      "signedIn on a device code that is still waiting",
      (d) => {
        (
          row(d, "signIn", "SignIn/done: device code, an existing license")
            .input.deviceCode as Record<string, unknown>
        ).phase = "waiting";
      },
      "signedIn only with phase ok",
    ],
    [
      "a deviceCode input on a browser sign-in",
      (d) => {
        row(
          d,
          "signIn",
          "SignIn/handoff: waiting for the browser",
        ).input.deviceCode = { phase: "waiting" };
      },
      "deviceCode input appears exactly",
    ],
    [
      "issuedNow without a signedIn outcome",
      (d) => {
        (
          row(d, "signIn", "SignIn/handoff: waiting for the browser").input
            .signIn as Record<string, unknown>
        ).issuedNow = true;
      },
      "issuedNow only with outcome signedIn",
    ],
    [
      "a missing (component, service) pair",
      (d) => {
        d.update = d.update.filter(
          (r) => r.name !== "ReleaseNotes: Release off",
        );
      },
      "ReleaseNotes: no row turns release off",
    ],
    [
      "License off with a gate status",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed: License off").input.gate = {
          status: "ok",
        };
      },
      "License off: gate.status",
    ],
    [
      "License off with a license choice",
      (d) => {
        row(d, "signIn", "LicenseChoice: License off").input.choices = {};
      },
      "License off: no choices",
    ],
    [
      "License off requiring a license to register",
      (d) => {
        row(d, "signIn", "SignIn/done: License off").input.registration =
          "requires-license";
      },
      "License off: registration",
    ],
    [
      "Identity off with a sign-in session",
      (d) => {
        row(d, "signIn", "SignIn: Identity off").input.signIn = {
          presentation: "inline",
          replace: "inline",
          channel: "browser",
        };
      },
      "Identity off: no signIn",
    ],
    [
      "Identity off with sign-in capable",
      (d) => {
        row(d, "activate", "Welcome: Identity off").input.capabilities = {};
      },
      "Identity off: capabilities.signIn",
    ],
    [
      "an ending that is not §4.5's",
      (d) => {
        row(d, "signIn", "first-automatic-license").expect.copy = [
          "signin.desktop.toast",
        ];
      },
      "the form ends with",
    ],
    [
      "a missing ending",
      (d) => {
        d.signIn = d.signIn.filter(
          (r) => r.name !== "SignIn/done: browser, an existing license",
        );
      },
      "no browser ending with issuedNow false",
    ],
    [
      "a missing first-automatic-license row",
      (d) => {
        row(d, "signIn", "first-automatic-license").name = "renamed";
      },
      "first-automatic-license",
    ],
    [
      "a presentation-absent row that changes more than identity",
      (d) => {
        row(d, "activate", "Welcome: presentation absent").expect.copy = row(
          d,
          "activate",
          "Welcome: presentation absent",
        ).expect.copy.filter((k) => k !== "welcome.trial");
      },
      "presentation absent changes more",
    ],
    [
      "a browser sign-in that reaches the license choice (D4)",
      (d) => {
        (
          row(d, "signIn", "LicenseChoice/one").input.signIn as Record<
            string,
            unknown
          >
        ).presentation = "browser";
      },
      "never reaches choose, replace or LicenseChoice",
    ],
    [
      "replace browser that opens the device list",
      (d) => {
        (
          row(d, "signIn", "LicenseChoice/replace-open").input.signIn as Record<
            string,
            unknown
          >
        ).replace = "browser";
      },
      "replace browser never opens",
    ],
    [
      "hidden on a row with every service on",
      (d) => {
        delete row(d, "update", "UpdatePrompt: Update off").input.services;
      },
      "hidden only on a row that turns a service off",
    ],
    [
      "hidden with copy",
      (d) => {
        row(d, "update", "UpdatePrompt: Update off").expect.copy = [
          "update.upToDate",
        ];
      },
      "hidden shows no copy",
    ],
    [
      "an unknown license status",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed").input.gate = {
          status: "fine",
        };
      },
      "gate.status fine",
    ],
    [
      "a parked platform (D8)",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed").input.platform = {
          os: "tvos",
          formFactor: "tv",
        };
      },
      "not a must-tier platform",
    ],
    [
      "a TV form factor on iOS",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed").input.platform = {
          os: "ios",
          formFactor: "tv",
        };
      },
      "formFactor tv only with android or linux",
    ],
    [
      "an action outside the vocabulary",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed").expect.actions = ["buy"];
      },
      "not in the vocabulary",
    ],
    [
      "actions that are not the copy's controls",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed").expect.actions = ["cancel"];
      },
      "are not its controls'",
    ],
    [
      "a copy key outside the state's list (D7)",
      (d) => {
        row(d, "gate", "PolarisKeyGate/needs-activation").expect.copy.push(
          "welcome.trial",
        );
      },
      "is not in PolarisKeyGate.needs-activation's list",
    ],
    [
      "unsorted copy",
      (d) => {
        row(d, "activate", "Activate/empty").expect.copy.reverse();
      },
      "copy is not sorted",
    ],
    [
      "a core key copy.en.json lacks",
      (d) => {
        row(d, "gate", "Toast/error: stays until dismissed").expect.copy = [
          "common.dismiss",
          "core.codes.nope.title",
        ];
      },
      "core.codes.nope.title is not in copy.en.json",
    ],
    [
      "an unreached key on a row",
      (d) => {
        row(d, "signIn", "SignIn/choose: desktop").expect.copy.push(
          "signin.consent.licenseInApp",
        );
        row(d, "signIn", "SignIn/choose: desktop").expect.copy.sort();
      },
      "listed as unreached",
    ],
    [
      "a must state with no row",
      (d) => {
        d.gate = d.gate.filter((r) => r.name !== "Boot/declined");
      },
      "Boot.declined: no row",
    ],
    [
      "a state's keys no row covers (D7)",
      (d) => {
        for (const r of d.gate)
          if (r.expect.component === "Boot" && r.expect.state === "consent")
            r.expect.copy = r.expect.copy.filter((k) => k !== "common.notNow");
      },
      "no row shows common.notNow",
    ],
    [
      "a negative row that shows what it must not",
      (d) => {
        const r = row(
          d,
          "devices",
          "Devices/list: the runtime does not know this device",
        );
        r.expect.copy = [...r.expect.copy, "part.thisDeviceTitle"].sort();
      },
      "mustNot copy part.thisDeviceTitle is shown",
    ],
    [
      "a component with no negative row",
      (d) => {
        for (const r of d.paywall)
          if (r.expect.component === "Paywall") delete r.mustNot;
      },
      "Paywall: no negative row",
    ],
    [
      "an unknown stage",
      (d) => {
        row(d, "gate", "Boot/rolled-back").input.stage = {
          stage: "warmup",
          outcome: "running",
        };
      },
      "stage warmup",
    ],
    [
      "an error code with no core copy",
      (d) => {
        row(
          d,
          "devices",
          "Devices/error: the list could not load",
        ).input.error = { code: "nope" };
      },
      "error.code nope has no core copy",
    ],
    [
      "a control character",
      (d) => {
        row(d, "gate", "PolarisKeyGate/licensed").name = "licensed\u0007";
      },
      "a control character",
    ],
    [
      "a theme expectation off the resolution order",
      (d) => {
        d.theme[0]!.expect.accentSource = "core";
      },
      "not the resolution order's",
    ],
    [
      "a kit with no native row",
      (d) => {
        d.theme = d.theme.filter(
          (t) => !(t.input.kit === "qt" && t.input.preset === "native"),
        );
      },
      "no qt row under native",
    ],
    [
      "an i18n key no table has",
      (d) => {
        d.i18n[0]!.key = "welcome.nope";
      },
      "no table has welcome.nope",
    ],
    [
      "a components.json state named hidden",
      (_d, s) => {
        s.components.Toast!.states.hidden = { copy: [] };
      },
      '"hidden" is reserved',
    ],
  ];

  for (const [what, mutate, message] of cases)
    it(what, () => {
      const d = clone(DOC);
      const s = clone(S);
      mutate(d, s);
      expect(checkUiMatrix(d, s).join("\n")).toContain(message);
    });
});

describe("the reference formatter", () => {
  it("formats plain arguments, plurals and selects", () => {
    expect(
      refFormat("en", "{count, plural, one {# device} other {# devices}}", {
        count: 1,
      }),
    ).toBe("1 device");
    expect(
      refFormat("en", "{count, plural, one {# device} other {# devices}}", {
        count: 0,
      }),
    ).toBe("0 devices");
    expect(
      refFormat("en", "Welcome to {product}", { product: "Tidewater Studio" }),
    ).toBe("Welcome to Tidewater Studio");
    expect(refFormat("en", "Welcome to {product}", {})).toBe(
      "Welcome to {product}",
    );
    const ff =
      "{formFactor, select, iphone {this iPhone} mac {this Mac} other {this device}}";
    expect(refFormat("en", `Use it on ${ff}.`, { formFactor: "mac" })).toBe(
      "Use it on this Mac.",
    );
    expect(refFormat("en", ff, { formFactor: "watch" })).toBe("this device");
  });

  it("picks each locale's CLDR categories", () => {
    const m =
      "{n, plural, zero {z#} one {o#} two {t#} few {f#} many {m#} other {x#}}";
    expect(refFormat("fr", m, { n: 0 })).toBe("o0");
    expect(refFormat("fr", m, { n: 1000000 })).toBe("m1000000");
    expect(refFormat("pt-BR", m, { n: 1 })).toBe("o1");
    expect(refFormat("de", m, { n: 0 })).toBe("x0");
    expect(refFormat("ja", m, { n: 1 })).toBe("x1");
    for (const locale of LOCALES)
      for (const c of new Intl.PluralRules(locale).resolvedOptions()
        .pluralCategories as string[])
        expect(
          DOC.i18n.some(
            (r) => r.locale === locale && r.name.endsWith(`plural ${c}`),
          ),
          `${locale} ${c}`,
        ).toBe(true);
  });

  it("covers every formFactor case", () => {
    for (const ff of FORM_FACTORS)
      expect(
        DOC.i18n.some((r) => r.args.formFactor === ff),
        ff,
      ).toBe(true);
    expect(
      DOC.i18n.find((r) => r.name === "en: part.thisDeviceTitle, iphone")
        ?.expect,
    ).toBe("This iPhone");
  });

  it("looks a key up: locale override, locale, English override, English", () => {
    const o = { de: { "welcome.signIn": "A" }, en: { "welcome.useKey": "B" } };
    expect(refLookup(S, "de", "welcome.signIn", o)).toBe("A");
    expect(refLookup(S, "de", "welcome.useKey", o)).toBe(
      S.kit.de!["welcome.useKey"],
    );
    expect(refLookup(S, "sv", "welcome.useKey", o)).toBe("B");
    expect(refLookup(S, "sv", "welcome.trial", o)).toBe(
      S.kit.en!["welcome.trial"],
    );
    // copy.fr.json is pending (SP-03): French core copy falls back to English.
    expect(refLookup(S, "fr", "core.gate.expired.title")).toBe(
      S.core.en!["core.gate.expired.title"],
    );
  });
});

describe("theme resolution (UI-KITS §1.2, §3.4)", () => {
  it("follows the order: integrator, native host, presentation, icon, ink", () => {
    expect(resolveTheme({ kit: "react" })).toEqual({
      name: "Tidewater Studio",
      accentSource: "icon",
      colorScheme: "system",
      icon: "image",
      preset: "polaris-key",
    });
    expect(resolveTheme({ kit: "godot" }).colorScheme).toBe("dark");
    expect(resolveTheme({ kit: "terminal" }).icon).toBe("none");
    expect(resolveTheme({ kit: "react", preset: "native" }).accentSource).toBe(
      "host",
    );
    expect(
      resolveTheme({ kit: "react", integrator: { accent: "core" } })
        .accentSource,
    ).toBe("core");
    expect(
      resolveTheme({ kit: "react", presentation: null }).accentSource,
    ).toBe("ink");
    expect(
      resolveTheme({
        kit: "compose",
        platform: { os: "android", formFactor: "tv" },
      }).colorScheme,
    ).toBe("dark");
  });
});
