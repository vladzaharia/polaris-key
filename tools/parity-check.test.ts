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
  TRANSCRIPTS_DIR,
} from "./parity-check.js";
import {
  capabilityDigest,
  capabilityTable,
  type CapabilityManifest,
  type CapabilityRegistry,
} from "./capabilities.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONSTANTS = "sdks/demo/constants.generated.ts";

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
    sdks: [
      {
        id: "demo",
        title: "Demo",
        manifest: "sdks/demo/parity.json",
        constants: CONSTANTS,
      },
    ],
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
  /** conformance/transcripts/<name>.json → content. */
  transcripts?: Record<string, Json>;
  /** The generated constants module; default: one carrying the fixture's own digest. `null`
   *  leaves it out. */
  constants?: string | null;
}

/** A constants module carrying the digest of this registry and manifest (when it has one). */
function constantsFor(reg: Json, man: Json): string {
  try {
    const digest = capabilityDigest(
      capabilityTable(
        reg as unknown as CapabilityRegistry,
        man as unknown as CapabilityManifest,
      ),
    );
    return `export const CAPABILITY_DIGEST = "${digest}";\n`;
  } catch {
    return "// no table: the manifest is incomplete\n";
  }
}

function fixture(over: Fixture = {}): string {
  const root = mkdtempSync(join(tmpdir(), "parity-"));
  roots.push(root);
  for (const schema of [REGISTRY_SCHEMA_PATH, MANIFEST_SCHEMA_PATH])
    cpSync(join(repo, schema), join(root, schema));
  const reg = over.registry ?? registry();
  const man = over.manifest ?? manifest();
  write(root, REGISTRY_PATH, reg);
  write(root, "sdks/demo/parity.json", man);
  if (over.constants !== null)
    write(root, CONSTANTS, over.constants ?? constantsFor(reg, man));
  write(root, "conformance/corpus/v2/mini.json", { cases: [] });
  for (const [name, text] of Object.entries(over.tests ?? TESTS))
    write(root, `sdks/demo/tests/${name}`, text);
  if (over.program !== null) write(root, PROGRAM_PATH, over.program ?? PROGRAM);
  for (const [name, content] of Object.entries(over.transcripts ?? {}))
    write(root, `${TRANSCRIPTS_DIR}/${name}.json`, content);
  return root;
}

const run = (over?: Fixture) => checkParity({ root: fixture(over) });

function withEntry(id: string, entry: Json): Json {
  const m = manifest();
  (m.features as Json)[id] = entry;
  return m;
}

/** The same manifest shipping to the browser only. */
const webOnly = (m: Json): Json => ({ ...m, runtimes: ["web"] });

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
      '[rule 2] demo: demo.verify is proven by corpus mini.json, but no file tagged @pkey-feature demo.verify loads it (a string literal naming "mini.json")',
    ]);
  });

  it("does not count a prose mention of the corpus file as loading it", () => {
    const { violations } = run({
      tests: {
        ...TESTS,
        "verify.test.ts": `// @pkey-feature demo.verify\n// Covers the edge cases, like mini.json does.\n`,
      },
    });
    expect(violations).toHaveLength(1);
  });

  it("accepts the load calls each runner actually makes", () => {
    for (const load of [
      `readFileSync(v2("mini.json"))`,
      `CORPUS_DIR / 'mini.json'`,
      `join(here, "corpus/v2/mini.json")`,
      `Bundle.module.url(forResource: "mini", withExtension: "json")`,
    ])
      expect(
        run({
          tests: {
            ...TESTS,
            "verify.test.ts": `// @pkey-feature demo.verify\n${load}\n`,
          },
        }).violations,
        load,
      ).toEqual([]);
  });

  it("requires a family proof's runner to name the family as well as the file", () => {
    const r = registry();
    (r.features as Json[])[0]!.proof = [
      { kind: "corpus", file: "mini.json", family: "cases" },
    ];
    const bare = run({ registry: r });
    expect(bare.violations).toEqual([
      '[rule 2] demo: demo.verify is proven by corpus mini.json#cases, but no file tagged @pkey-feature demo.verify loads it (a string literal naming "mini.json" and the family cases)',
    ]);
    const named = run({
      registry: r,
      tests: {
        ...TESTS,
        "verify.test.ts": `// @pkey-feature demo.verify\nconst { cases } = load("mini.json");\n`,
      },
    });
    expect(named.violations).toEqual([]);
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

  // The next two use a web-only manifest, so the N/A covers every runtime and the pair is the
  // only thing wrong.
  it("fails an na on a listed runtime the registry does not allow", () => {
    const { violations } = run({
      manifest: webOnly(
        withEntry("demo.verify", {
          status: "na",
          runtime: "web",
          reason: "runtime",
        }),
      ),
    });
    expect(violations).toEqual([
      "[rule 3] demo: demo.verify: na web: runtime is not an N/A the registry allows",
    ]);
  });

  it("fails an na whose reason differs from the allowed one", () => {
    const { violations } = run({
      manifest: webOnly(
        withEntry("demo.secret", {
          status: "na",
          runtime: "web",
          reason: "dependency",
        }),
      ),
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

  it("fails an na that does not cover every runtime the manifest lists", () => {
    const { violations } = run({
      manifest: withEntry("demo.secret", {
        status: "na",
        runtime: "web",
        reason: "runtime",
      }),
    });
    expect(violations).toEqual([
      "[rule 3] demo: demo.secret: na covers web but not node; declare a partial N/A with except",
    ]);
  });

  it("accepts an na that covers every listed runtime with an allowed pair", () => {
    const reg = registry();
    const secret = (reg.features as Json[]).find(
      (f) => f.id === "demo.secret",
    )!;
    (secret.allowedNa as Json[]).push({
      runtime: "node",
      reason: "runtime",
      why: "delegated",
    });
    const { violations } = run({
      registry: reg,
      manifest: withEntry("demo.secret", {
        status: "na",
        runtime: ["node", "web"],
        reason: "runtime",
      }),
    });
    expect(violations).toEqual([]);
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

describe("rule 4 — a registry corpus proof's wp (proof level)", () => {
  const proofNaming = (file: string, wp: string): Json => {
    const r = registry();
    (r.features as Json[])[0]!.proof = [{ kind: "corpus", file, wp }];
    return r;
  };
  const untagged = {
    ...TESTS,
    "verify.test.ts": `// @pkey-feature demo.verify\n`,
  };

  it("fails a missing proof whose owner is done", () => {
    const { violations } = run({
      registry: proofNaming("future.json", "P9-02"),
      tests: untagged,
    });
    expect(violations).toEqual([
      "[rule 4] demo.verify: corpus proof names P9-02, which is done, but conformance/corpus/v2/future.json does not exist",
    ]);
  });

  it("fails a missing proof whose owner is not a work package", () => {
    const { violations } = run({
      registry: proofNaming("future.json", "P9-99"),
      tests: untagged,
    });
    expect(violations).toEqual([
      "[rule 4] demo.verify: corpus proof future.json names P9-99, which is not a work package",
    ]);
  });

  it("passes a missing proof whose owner is still open", () => {
    const { violations } = run({
      registry: proofNaming("future.json", "P9-01"),
      tests: untagged,
    });
    expect(violations).toEqual([]);
  });

  it("passes a present proof whose owner is done: the wp is provenance", () => {
    const { violations } = run({ registry: proofNaming("mini.json", "P9-02") });
    expect(violations).toEqual([]);
  });

  // A directory proof (P4-04's `content/`) names a family in that directory's cases.json.
  const directoryProof = (family: string): ReturnType<typeof checkParity> => {
    const r = registry();
    (r.features as Json[])[0]!.proof = [
      { kind: "corpus", file: "content/", family, wp: "P9-02" },
    ];
    const root = fixture({
      registry: r,
      tests: {
        ...TESTS,
        "verify.test.ts": `// @pkey-feature demo.verify\nconst c = load("content/", "${family}");\n`,
      },
    });
    write(root, "conformance/corpus/v2/content/cases.json", {
      packSetIdCases: [],
    });
    return checkParity({ root });
  };

  it("reads a directory proof's family from its cases.json", () => {
    expect(directoryProof("packSetIdCases").violations).toEqual([]);
  });

  it("fails a directory proof whose cases.json lacks the family", () => {
    expect(directoryProof("stampCases").violations).toEqual([
      "[rule 4] demo.verify: corpus proof names P9-02, which is done, but conformance/corpus/v2/content/ does not exist (or lacks stampCases)",
    ]);
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

// ── Rule 6 ─────────────────────────────────────────────────────────────────────────────────

/** The fixture registry plus `demo.sync`, a feature proven by transcripts. */
function withSync(proof: Json = { kind: "transcript" }): Json {
  const r = registry();
  (r.features as Json[]).push({
    id: "demo.sync",
    family: "demo",
    title: "Sync",
    service: "core",
    proof: [proof],
    allowedNa: [],
  });
  return r;
}

const SYNC_TRANSCRIPT = {
  sync: { id: "sync", features: ["demo.sync"], requires: [] as string[] },
};
const TAGGED_ONLY = `// @pkey-feature demo.sync\nit("syncs against a hand-written fake", () => {});\n`;
const REPLAYER = `// @pkey-feature demo.sync\n// Replays conformance/transcripts/ through the SDK.\n`;

describe("rule 6 — a transcript that applies has a tagged replayer", () => {
  it("fails when the only tagged test does not replay conformance/transcripts", () => {
    const { violations } = run({
      registry: withSync(),
      manifest: withEntry("demo.sync", { status: "implemented" }),
      tests: { ...TESTS, "sync.test.ts": TAGGED_ONLY },
      transcripts: SYNC_TRANSCRIPT,
    });
    expect(violations).toEqual([
      "[rule 6] demo: sync applies here, but no test tagged @pkey-feature demo.sync replays conformance/transcripts",
    ]);
  });

  it("passes when a tagged test replays conformance/transcripts", () => {
    const result = run({
      registry: withSync(),
      manifest: withEntry("demo.sync", { status: "implemented" }),
      tests: { ...TESTS, "sync.test.ts": REPLAYER },
      transcripts: SYNC_TRANSCRIPT,
    });
    expect(result.violations).toEqual([]);
    expect(result.unrecorded).toEqual([]);
  });

  it("does not apply while the SDK has not implemented a feature the transcript proves", () => {
    const { violations } = run({
      registry: withSync(),
      manifest: withEntry("demo.sync", { status: "planned", wp: "P9-01" }),
      transcripts: SYNC_TRANSCRIPT,
    });
    expect(violations).toEqual([]);
  });

  it("does not apply where a feature the transcript requires is na", () => {
    const m = webOnly(withEntry("demo.sync", { status: "implemented" }));
    (m.features as Json)["demo.secret"] = {
      status: "na",
      runtime: "web",
      reason: "runtime",
    };
    const needsSecret = {
      sync: { id: "sync", features: ["demo.sync"], requires: ["demo.secret"] },
    };
    const tests = { ...TESTS, "sync.test.ts": TAGGED_ONLY };
    expect(
      run({
        registry: withSync(),
        manifest: m,
        tests,
        transcripts: needsSecret,
      }).violations,
    ).toEqual([]);
    // …and applies again once the requirement is merely planned.
    (m.features as Json)["demo.secret"] = { status: "planned", wp: "P9-01" };
    expect(
      run({
        registry: withSync(),
        manifest: m,
        tests,
        transcripts: needsSecret,
      }).violations,
    ).toEqual([
      "[rule 6] demo: sync applies here, but no test tagged @pkey-feature demo.sync replays conformance/transcripts",
    ]);
  });

  it("fails a malformed transcript, an unknown feature, and a feature with no transcript proof", () => {
    const { violations } = run({
      registry: withSync(),
      manifest: withEntry("demo.sync", { status: "planned", wp: "P9-01" }),
      transcripts: {
        renamed: { id: "other", features: ["demo.sync"], requires: [] },
        unknown: { id: "unknown", features: ["demo.nope"], requires: [] },
        unproven: { id: "unproven", features: ["demo.secret"], requires: [] },
        badreq: { id: "badreq", features: ["demo.sync"], requires: ["demo.x"] },
      },
    });
    expect(violations).toEqual([
      '[rule 6] conformance/transcripts/badreq.json: requires unknown feature "demo.x"',
      '[rule 6] conformance/transcripts/renamed.json: needs "id": "renamed", a non-empty "features" list and a "requires" list',
      '[rule 6] conformance/transcripts/unknown.json: names unknown feature "demo.nope"',
      "[rule 6] conformance/transcripts/unproven.json: lists demo.secret, whose registry entry has no transcript proof",
      // demo.secret is implemented, so the (invalid) transcript still demands a replayer.
      "[rule 6] demo: unproven applies here, but no test tagged @pkey-feature demo.secret replays conformance/transcripts",
    ]);
  });

  it("lists an unrecorded transcript proof, and warns when its owner is done", () => {
    const open = run({
      registry: withSync({ kind: "transcript", wp: "P9-01" }),
      manifest: withEntry("demo.sync", { status: "planned", wp: "P9-01" }),
    });
    expect(open.violations).toEqual([]);
    expect(open.warnings).toEqual([]);
    expect(open.unrecorded).toEqual([{ feature: "demo.sync", wp: "P9-01" }]);

    const closed = run({
      registry: withSync({ kind: "transcript", wp: "P9-02" }),
      manifest: withEntry("demo.sync", { status: "planned", wp: "P9-01" }),
    });
    expect(closed.warnings).toEqual([
      "[rule 6] demo.sync: its transcript proof names P9-02, which is done, but no transcript lists demo.sync",
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
  // It reads every manifest and test file in the checkout: seconds on a slow CI runner.
  it("pass the gate", () => {
    expect(checkParity({ root: repo }).violations).toEqual([]);
  }, 60_000);
});

// ── Rule 7 ─────────────────────────────────────────────────────────────────────────────────

describe("rule 7 — the generated capability table is the manifest's", () => {
  it("fails when the constants module carries another manifest's digest", () => {
    // Generated before demo.ui moved from planned to implemented-with-a-test.
    const stale = constantsFor(registry(), manifest());
    const m = withEntry("demo.ui", {
      status: "implemented",
      except: [{ runtime: "web", reason: "runtime" }],
    });
    const { violations } = run({
      manifest: m,
      constants: stale,
      tests: { ...TESTS, "ui.test.ts": "// @pkey-feature demo.ui\n" },
      registry: (() => {
        const r = registry();
        const ui = (r.features as Json[])[2]!;
        ui.allowedNa = [{ runtime: "web", reason: "runtime", why: "x" }];
        return r;
      })(),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(
      /^\[rule 7\] demo: the capability table in sdks\/demo\/constants\.generated\.ts is not sdks\/demo\/parity\.json's \(CAPABILITY_DIGEST [0-9a-f]{64}\); run `pnpm gen:constants`$/,
    );
  });

  it("fails when the constants module does not exist", () => {
    const { violations } = run({ constants: null });
    expect(violations).toEqual([
      "[rule 7] demo: sdks/demo/constants.generated.ts does not exist (run `pnpm gen:constants`)",
    ]);
  });

  it("is skipped while rule 1 fails: an incomplete manifest has no table", () => {
    const m = manifest();
    delete (m.features as Json)["demo.ui"];
    const { violations } = run({ manifest: m, constants: "// stale\n" });
    expect(violations).toEqual([
      "[rule 1] demo: demo.ui is missing from sdks/demo/parity.json",
    ]);
  });

  it("a trait N/A is expanded to every runtime the manifest lists", () => {
    const m: Json = { ...manifest(), traits: ["headless"] };
    (m.features as Json)["demo.ui"] = {
      status: "na",
      runtime: "headless",
      reason: "runtime",
    };
    const table = capabilityTable(
      registry() as unknown as CapabilityRegistry,
      m as unknown as CapabilityManifest,
    );
    expect(table.rows.find((r) => r.feature === "demo.ui")).toEqual({
      feature: "demo.ui",
      status: "na",
      service: "sdk",
      na: [
        { runtime: "node", reason: "runtime" },
        { runtime: "web", reason: "runtime" },
      ],
    });
    expect(run({ manifest: m }).violations).toEqual([]);
  });
});
