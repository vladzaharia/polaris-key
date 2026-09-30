import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkParity,
  MANIFEST_SCHEMA_PATH,
  parseTags,
  PROGRAM_PATH,
  REGISTRY_PATH,
  REGISTRY_SCHEMA_PATH,
} from "./parity-check.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── A miniature repository ─────────────────────────────────────────────────────────────────
//
// One SDK ("demo", runtimes node + web) against a three-feature registry, with the REAL schemas
// copied in so the fixtures are held to the same shapes as the committed files. `base()` is
// clean; each test breaks exactly one thing and asserts the one violation it causes.

type Json = Record<string, unknown>;

function registry(): Json {
  return {
    registryVersion: 1,
    reasons: ["runtime", "outlet", "product", "dependency", "version"],
    runtimes: [
      { id: "node", title: "Node" },
      { id: "web", title: "Browser" },
      { id: "ios", title: "iOS" },
    ],
    traits: [{ id: "headless", title: "Headless" }],
    families: [{ id: "demo", title: "Demo" }],
    sdks: [{ id: "demo", title: "Demo", manifest: "sdks/demo/parity.json" }],
    features: [
      {
        id: "demo.verify",
        family: "demo",
        title: "Verify",
        service: "core",
        proof: [{ kind: "corpus", file: "mini.json" }],
        allowedNa: [],
      },
      {
        id: "demo.secret",
        family: "demo",
        title: "Secret",
        service: "config",
        proof: [{ kind: "unit" }],
        allowedNa: [{ runtime: "web", reason: "runtime", why: "stripped" }],
      },
      {
        id: "demo.ui",
        family: "demo",
        title: "UI kit",
        service: "sdk",
        proof: [{ kind: "snapshot" }],
        allowedNa: [
          { runtime: "headless", reason: "runtime", why: "no toolkit" },
        ],
      },
    ],
  };
}

function manifest(): Json {
  return {
    sdk: "demo",
    runtimes: ["node", "web"],
    testRoots: ["sdks/demo/tests"],
    features: {
      "demo.verify": { status: "implemented" },
      "demo.secret": {
        status: "implemented",
        except: [{ runtime: "web", reason: "runtime" }],
      },
      "demo.ui": { status: "planned", wp: "P9-01" },
    },
  };
}

const TESTS = {
  "verify.test.ts": `// @pkey-feature demo.verify\nconst corpus = load("mini.json");\n`,
  "secret.test.ts": `describe("x", () => {\n  // @pkey-feature demo.secret\n  it("y", () => {});\n});\n`,
};

const PROGRAM = {
  workPackages: [
    { id: "P9-01", status: "todo" },
    { id: "P9-02", status: "done" },
  ],
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function write(root: string, file: string, content: string | Json): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(
    join(root, file),
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

interface Fixture {
  registry?: Json;
  manifest?: Json;
  tests?: Record<string, string>;
  program?: Json | null;
}

function fixture(over: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "parity-"));
  roots.push(root);
  for (const schema of [REGISTRY_SCHEMA_PATH, MANIFEST_SCHEMA_PATH])
    cpSync(join(repo, schema), join(root, schema));
  write(root, REGISTRY_PATH, over.registry ?? registry());
  write(root, "sdks/demo/parity.json", over.manifest ?? manifest());
  write(root, "conformance/corpus/v2/mini.json", { cases: [] });
  for (const [name, text] of Object.entries(over.tests ?? TESTS))
    write(root, `sdks/demo/tests/${name}`, text);
  if (over.program !== null) write(root, PROGRAM_PATH, over.program ?? PROGRAM);
  return root;
}

const run = (over?: Fixture) => checkParity({ root: fixture(over) });

function withEntry(id: string, entry: Json): Json {
  const m = manifest();
  (m.features as Json)[id] = entry;
  return m;
}

// ── The clean baseline ─────────────────────────────────────────────────────────────────────

describe("parity-check — the clean fixture", () => {
  it("reports nothing", () => {
    const result = run();
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.unowned).toEqual([]);
  });
});

// ── Rule 1 ─────────────────────────────────────────────────────────────────────────────────

describe("rule 1 — the manifest and the registry list the same ids", () => {
  it("fails when a registry id is missing from the manifest", () => {
    const m = manifest();
    delete (m.features as Json)["demo.ui"];
    const { violations } = run({ manifest: m });
    expect(violations).toEqual([
      "[rule 1] demo: demo.ui is missing from sdks/demo/parity.json",
    ]);
  });

  it("fails when the manifest names an id the registry lacks", () => {
    const { violations } = run({
      manifest: withEntry("demo.extra", { status: "planned", wp: "P9-01" }),
    });
    expect(violations).toEqual([
      "[rule 1] demo: demo.extra is not a registry feature (sdks/demo/parity.json)",
    ]);
  });
});

// ── Rule 2 ─────────────────────────────────────────────────────────────────────────────────

describe("rule 2 — an implemented entry has a tagged test", () => {
  it("fails when no test is tagged with the id", () => {
    const { violations } = run({
      tests: { ...TESTS, "secret.test.ts": `it("y", () => {});\n` },
    });
    expect(violations).toEqual([
      "[rule 2] demo: demo.secret is implemented but no test under sdks/demo/tests is tagged @pkey-feature demo.secret",
    ]);
  });

  it("fails when no tagged file loads the corpus file the proof names", () => {
    const { violations } = run({
      tests: { ...TESTS, "verify.test.ts": `// @pkey-feature demo.verify\n` },
    });
    expect(violations).toEqual([
      '[rule 2] demo: demo.verify is proven by corpus mini.json, but no file tagged @pkey-feature demo.verify loads "mini"',
    ]);
  });

  it("does not count a corpus basename that is only a prefix of another word", () => {
    const { violations } = run({
      tests: {
        ...TESTS,
        "verify.test.ts": `// @pkey-feature demo.verify\nload("mini-extra.json");\n`,
      },
    });
    expect(violations).toHaveLength(1);
  });

  it("does not enforce a corpus proof that does not exist yet when it names its owner", () => {
    const r = registry();
    (r.features as Json[])[0]!.proof = [
      { kind: "corpus", file: "future.json", wp: "P9-01" },
    ];
    const { violations } = run({
      registry: r,
      tests: { ...TESTS, "verify.test.ts": `// @pkey-feature demo.verify\n` },
    });
    expect(violations).toEqual([]);
  });

  it("fails a registry corpus proof that does not exist and names no owner", () => {
    const r = registry();
    (r.features as Json[])[0]!.proof = [
      { kind: "corpus", file: "future.json" },
    ];
    const { violations } = run({ registry: r });
    expect(violations).toEqual([
      "[registry] demo.verify: corpus proof future.json does not exist and names no work package that adds it",
    ]);
  });
});

// ── Rule 3 ─────────────────────────────────────────────────────────────────────────────────

describe("rule 3 — an N/A must be one the registry allows", () => {
  it("fails an na on a runtime the manifest does not list", () => {
    const { violations } = run({
      manifest: withEntry("demo.secret", {
        status: "na",
        runtime: "ios",
        reason: "runtime",
      }),
    });
    expect(violations).toEqual([
      '[rule 3] demo: demo.secret: na names runtime "ios", which the manifest does not list',
    ]);
  });

  it("fails an na on a listed runtime the registry does not allow", () => {
    const { violations } = run({
      manifest: withEntry("demo.verify", {
        status: "na",
        runtime: "web",
        reason: "runtime",
      }),
    });
    expect(violations).toEqual([
      "[rule 3] demo: demo.verify: na web: runtime is not an N/A the registry allows",
    ]);
  });

  it("fails an na whose reason differs from the allowed one", () => {
    const { violations } = run({
      manifest: withEntry("demo.secret", {
        status: "na",
        runtime: "web",
        reason: "dependency",
      }),
    });
    expect(violations).toEqual([
      "[rule 3] demo: demo.secret: na web: dependency is not an N/A the registry allows",
    ]);
  });

  it("fails an except the registry does not allow", () => {
    const { violations } = run({
      manifest: withEntry("demo.verify", {
        status: "implemented",
        except: [{ runtime: "web", reason: "runtime" }],
      }),
    });
    expect(violations).toEqual([
      "[rule 3] demo: demo.verify: except web: runtime is not an N/A the registry allows",
    ]);
  });

  it("accepts a trait the manifest declares, and refuses it when the manifest does not", () => {
    const na = { status: "na", runtime: "headless", reason: "runtime" };
    const withTrait = { ...withEntry("demo.ui", na), traits: ["headless"] };
    expect(run({ manifest: withTrait }).violations).toEqual([]);
    expect(run({ manifest: withEntry("demo.ui", na) }).violations).toEqual([
      '[rule 3] demo: demo.ui: na names runtime "headless", which the manifest does not list',
    ]);
  });
});

// ── Rule 4 ─────────────────────────────────────────────────────────────────────────────────

describe("rule 4 — a planned entry names an open work package", () => {
  it("fails a wp that is not in the program", () => {
    const { violations } = run({
      manifest: withEntry("demo.ui", { status: "planned", wp: "P9-99" }),
    });
    expect(violations).toEqual([
      "[rule 4] demo: demo.ui is planned in P9-99, which is not a work package",
    ]);
  });

  it("fails a wp that is already done", () => {
    const { violations } = run({
      manifest: withEntry("demo.ui", { status: "planned", wp: "P9-02" }),
    });
    expect(violations).toEqual([
      "[rule 4] demo: demo.ui is planned in P9-02, which is done — update the manifest",
    ]);
  });

  it("lists an unowned gap instead of failing it", () => {
    const result = run({
      manifest: withEntry("demo.ui", {
        status: "planned",
        unowned: true,
        note: "nobody yet",
      }),
    });
    expect(result.violations).toEqual([]);
    expect(result.unowned).toEqual([
      { sdk: "demo", feature: "demo.ui", note: "nobody yet" },
    ]);
  });

  it("rejects an unowned entry without a note (schema)", () => {
    const { violations } = run({
      manifest: withEntry("demo.ui", { status: "planned", unowned: true }),
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.every((v) => v.startsWith("[schema] sdks/demo/parity.json")),
    ).toBe(true);
  });

  it("skips the rule with a warning when the program file is absent", () => {
    const result = run({
      program: null,
      manifest: withEntry("demo.ui", { status: "planned", wp: "P9-99" }),
    });
    expect(result.violations).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^\[rule 4\] skipped/);
  });
});

// ── Rule 5 ─────────────────────────────────────────────────────────────────────────────────

describe("rule 5 — a tag names a registry feature", () => {
  it("fails a tag with an unknown feature id", () => {
    const { violations } = run({
      tests: { ...TESTS, "typo.test.ts": `// @pkey-feature demo.verfy\n` },
    });
    expect(violations).toEqual([
      '[rule 5] sdks/demo/tests/typo.test.ts:1: @pkey-feature names unknown feature "demo.verfy"',
    ]);
  });

  it("fails a tag that names no id at all", () => {
    const { violations } = run({
      tests: { ...TESTS, "empty.py": `# @pkey-feature\n` },
    });
    expect(violations).toEqual([
      "[rule 5] sdks/demo/tests/empty.py:1: @pkey-feature names no feature id",
    ]);
  });
});

// ── Schemas ────────────────────────────────────────────────────────────────────────────────

describe("schemas", () => {
  it("fails a registry that does not match its schema, before any rule runs", () => {
    const r = registry();
    (r.features as Json[])[1]!.service = "nope";
    const { violations } = run({ registry: r });
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.every((v) => v.startsWith(`[schema] ${REGISTRY_PATH}`)),
    ).toBe(true);
  });

  it("fails a manifest status outside implemented/na/planned", () => {
    const { violations } = run({
      manifest: withEntry("demo.ui", { status: "partial" }),
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.every((v) => v.startsWith("[schema] sdks/demo/parity.json")),
    ).toBe(true);
  });
});

// ── Tag parsing ────────────────────────────────────────────────────────────────────────────

describe("parseTags", () => {
  it("reads //, ///, # and block-comment tags, stopping at the first non-id token", () => {
    const text = [
      "// @pkey-feature core.verify license.gate",
      "    /// @pkey-feature devices.report — only inside sync",
      "# @pkey-feature config.resolve, config.list",
      "/* @pkey-feature ui.kit */",
      'const s = "no tag here";',
    ].join("\n");
    expect(parseTags(text, "f").map((t) => [t.line, t.ids])).toEqual([
      [1, ["core.verify", "license.gate"]],
      [2, ["devices.report"]],
      [3, ["config.resolve", "config.list"]],
      [4, ["ui.kit"]],
    ]);
  });
});

// ── The committed repository ───────────────────────────────────────────────────────────────

describe("the committed registry and manifests", () => {
  it("pass the gate", () => {
    expect(checkParity({ root: repo }).violations).toEqual([]);
  });
});
