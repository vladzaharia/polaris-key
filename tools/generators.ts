// The generator registry: the one list of every generator this repository runs, what each reads, what
// each writes, in what order, and how to check it. `pnpm gen` (tools/gen.ts) runs it; CI, the pre-commit
// hook and the lead's gate read it through `pnpm gen --check`; `tools/gen-generators-doc.ts` renders
// reference/generators.mdx and the AGENTS.md rule-3 table from it; and tools/generators.test.ts fails
// when a file carries a GENERATED banner that no entry here claims.
//
// Adding a generator: write the script so it has a write mode and a `--check` mode that exits 1 on any
// difference and writes nothing, then add ONE entry below. Nothing else changes: the gate, CI, the hook
// and the docs follow from the entry.

/** One process to run. `argv[0]` is the executable; `cwd` is relative to the repo root. */
export interface Cmd {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Generator {
  /** The name `pnpm gen <id>` takes. */
  id: string;
  /** One line: what the family is. */
  title: string;
  /** Run order, ascending. A family that reads another family's output runs after it. */
  order: number;
  /** Repo-relative globs of what the family reads (used by `--changed` and the generated docs). */
  inputs: string[];
  /** Repo-relative globs of every file the family writes. Every GENERATED banner must match one. */
  outputs: string[];
  /** Steps that regenerate the outputs. Omitted for a family with no in-repo generator yet. */
  write?: Cmd[];
  /**
   * Steps that fail (exit 1) on any difference and write nothing. Defaults to the last `write` step
   * with `--check` appended.
   */
  check?: Cmd[];
  /** The generator is a checker: it validates, it never writes. */
  checkOnly?: boolean;
  /** Not run by a plain `pnpm gen` or `pnpm gen --check`: the reason. A named run still works. */
  manual?: string;
  /** Another family's run produces this family's outputs; this entry only declares them. */
  via?: string;
  /** Cheap enough for the pre-commit hook (`pnpm gen --check --fast`). */
  fast?: boolean;
  /** Needs `pnpm build` to have run first. */
  needsBuild?: boolean;
}

const tsx = (script: string, cwd?: string): Cmd => ({
  argv: ["pnpm", "exec", "tsx", script],
  ...(cwd ? { cwd } : {}),
});

const SDK_DIRS = "{sdks,packages}";

export const GENERATORS: Generator[] = [
  {
    id: "corpus",
    title: "Signed conformance corpus (v2) and its one Godot mirror",
    order: 10,
    inputs: [
      "tools/sign-corpus.ts",
      "tools/corpus/**",
      "tools/{sync-scenarios,presentation-matrix,ui-matrix,gen-content-chunks,gen-content-corpus}.ts",
      "conformance/corpus/v2/content/blobs/**",
      "packages/shared-*/src/**",
      "packages/client-core/src/**",
    ],
    outputs: [
      "conformance/corpus/v2/*.json",
      "conformance/corpus/v2/content/cases.json",
      "sdks/godot/tests/corpus/v2/**",
    ],
    write: [tsx("tools/sign-corpus.ts")],
    fast: true,
  },
  {
    id: "ui-matrix",
    title: "UI-kit state matrix (the corpus's ui-matrix.json)",
    order: 11,
    via: "corpus",
    inputs: ["tools/ui-matrix.ts"],
    outputs: ["conformance/corpus/v2/ui-matrix.json"],
  },
  {
    id: "services",
    title: "Service table in every language",
    order: 20,
    inputs: ["tools/services.json", "tools/gen-services.ts"],
    outputs: [
      "packages/shared-manifest/src/services.generated.ts",
      "packages/admin/src/services.generated.ts",
      "packages/sdk-node/src/services.generated.ts",
      "packages/sdk-react/src/core/services.generated.ts",
      "sdks/python/src/polaris_key/_services.py",
      "sdks/swift/Sources/PolarisKeyCore/ServiceSlug.generated.swift",
      "sdks/godot/addons/polaris_key/core/services_generated.gd",
      "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/ServiceSlug.generated.kt",
    ],
    write: [tsx("tools/gen-services.ts")],
    fast: true,
  },
  {
    id: "channels",
    title: "Distribution-channel catalogue",
    order: 21,
    inputs: ["tools/channels.json", "tools/gen-channels.ts"],
    outputs: [
      "packages/shared-manifest/src/channels.generated.ts",
      "packages/docs/src/content/docs/reference/channels.mdx",
    ],
    write: [tsx("tools/gen-channels.ts")],
    fast: true,
  },
  {
    id: "transcripts",
    title:
      "HTTP transcripts recorded through the Worker router, and their Godot mirror",
    order: 30,
    inputs: [
      "packages/worker/src/**",
      "packages/worker/test/transcripts/**",
      "packages/worker/test/transcripts.test.ts",
      "packages/shared-*/src/**",
    ],
    outputs: ["conformance/transcripts/**", "sdks/godot/tests/transcripts/**"],
    write: [{ argv: ["node", "tools/gen-transcripts.mjs"] }],
  },
  {
    id: "constants",
    title: "SDK constants: error codes, headers, enums, feature ids, core copy",
    order: 40,
    inputs: [
      "tools/gen-sdk-constants.ts",
      "tools/capabilities.ts",
      "tools/services.json",
      "conformance/parity/**",
      "packages/shared-protocol/src/**",
      "packages/worker/src/**",
      "sdks/*/parity.json",
      "packages/*/parity.json",
    ],
    outputs: [
      "packages/sdk-node/src/constants.generated.ts",
      "packages/sdk-node/src/copy.generated.ts",
      "packages/sdk-react/src/constants.generated.ts",
      "packages/sdk-react/src/copy.generated.ts",
      "sdks/python/src/polaris_key/constants_generated.py",
      "sdks/python/src/polaris_key/copy_generated.py",
      "sdks/swift/Sources/PolarisKeyCore/Constants.generated.swift",
      "sdks/swift/Sources/PolarisKeyCore/Copy.generated.swift",
      "sdks/godot/addons/polaris_key/core/constants_generated.gd",
      "sdks/godot/addons/polaris_key/core/copy_generated.gd",
      "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Constants.generated.kt",
      "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/Copy.generated.kt",
    ],
    write: [tsx("tools/gen-sdk-constants.ts")],
  },
  {
    id: "platform-inventory",
    title: "Platform inventory from the tagged Env members",
    order: 50,
    inputs: [
      "packages/worker/scripts/gen-platform-inventory.ts",
      "packages/worker/src/env.ts",
      "packages/worker/wrangler.toml",
    ],
    outputs: ["packages/worker/src/platformInventory.generated.ts"],
    write: [tsx("packages/worker/scripts/gen-platform-inventory.ts")],
  },
  {
    id: "storefront-ci",
    title: "CLI copy of the Worker's storefront CI plane",
    order: 60,
    inputs: [
      "packages/worker/scripts/gen-storefront-ci.ts",
      "packages/worker/src/core/storefront/**",
    ],
    outputs: ["packages/cli/src/storefronts/ciPlane.generated.ts"],
    write: [tsx("packages/worker/scripts/gen-storefront-ci.ts")],
  },
  {
    id: "settings",
    title: "Settings reference page and console search index",
    order: 70,
    inputs: [
      "packages/worker/scripts/gen-settings.ts",
      "packages/worker/src/core/settings/**",
      "packages/worker/src/**/settings.ts",
    ],
    outputs: [
      "packages/docs/src/content/docs/reference/settings.mdx",
      "packages/admin/src/console/settings.generated.ts",
    ],
    write: [tsx("packages/worker/scripts/gen-settings.ts")],
  },
  {
    id: "brand",
    title: "Brand tokens, launch kit, kit copy and per-SDK theme files",
    order: 80,
    inputs: [
      "packages/brand/scripts/**",
      "packages/brand/src/tokens/**",
      "packages/brand/kit/**",
      "packages/brand/kit-copy/**",
      "packages/brand/fixtures/**",
      "conformance/parity/copy.*.json",
    ],
    outputs: [
      "packages/brand/css/*.css",
      "packages/brand/tokens.json",
      "packages/brand/src/generated/**",
      "packages/brand/test/kit-copy-golden/**",
      "packages/sdk-node/src/cli/tokens.generated.ts",
      "packages/sdk-node/src/kitCopy.generated.ts",
      "sdks/godot/addons/polaris_key/brand/**",
      "sdks/godot/addons/polaris_key/dotnet/PKeyBrand.generated.cs",
      "sdks/godot/addons/polaris_key/ui/locale/**",
      "sdks/godot/addons/polaris_key/ui/theme/*_generated.gd",
      "sdks/godot/addons/polaris_key/ui/theme/fonts/*.tres",
      "sdks/godot/tests/brand/**",
      "sdks/kotlin/ui/src/**/brand/*.generated.kt",
      "sdks/kotlin/ui/src/**/composeResources/**",
      "sdks/python/src/polaris_key/ui/_tokens.py",
      "sdks/python/src/polaris_key/ui/ansi.py",
      "sdks/python/src/polaris_key/ui/kit_copy_generated.py",
      "sdks/python/src/polaris_key/ui/locale/**",
      "sdks/python/src/polaris_key/ui/qt/**",
      "sdks/python/tests/fixtures/accent-vectors.json",
      "sdks/swift/Sources/PolarisKeyUI/*.generated.swift",
      "sdks/swift/Sources/PolarisKeyUI/Resources/**",
      "sdks/swift/Tests/PolarisKeyTests/AccentVectors.generated.swift",
    ],
    write: [tsx("scripts/gen.ts", "packages/brand")],
  },
  {
    id: "action-bundle",
    title: "The publish Action's committed esbuild bundle of the CLI",
    order: 90,
    inputs: [
      "packages/cli/src/**",
      "packages/cli/scripts/bundle-action.mjs",
      "packages/shared-*/src/**",
      "packages/shared-catalog/src/**",
    ],
    outputs: ["actions/publish/dist/index.js"],
    write: [
      {
        argv: ["pnpm", "--filter", "@polaris-key/cli", "bundle:action"],
      },
    ],
    check: [
      {
        argv: [
          "pnpm",
          "--filter",
          "@polaris-key/cli",
          "bundle:action",
          "--",
          "--check",
        ],
      },
    ],
    needsBuild: true,
  },
  {
    id: "docs-reference",
    title:
      "Docs reference pages generated from the validators, routes, migrations and corpus",
    order: 100,
    inputs: [
      "packages/docs/scripts/gen-reference.mjs",
      "packages/worker/src/**",
      "packages/worker/migrations/**",
      "packages/shared-*/src/**",
      "conformance/corpus/v2/**",
      "conformance/parity/**",
      "sdks/*/parity.json",
      "packages/*/parity.json",
      "packages/worker/openapi/**",
      "conformance/transcripts/**",
    ],
    outputs: [
      "packages/docs/src/content/docs/reference/{config-entry,error-codes,parity,routes,validation-codes}.mdx",
      "packages/docs/src/content/docs/reference/protocol/{corpus,fingerprint-constants}.mdx",
      "packages/docs/src/content/docs/contribute/data-model.mdx",
    ],
    write: [{ argv: ["pnpm", "--filter", "@polaris-key/docs", "gen"] }],
    check: [{ argv: ["pnpm", "--filter", "@polaris-key/docs", "gen:check"] }],
  },
  {
    id: "registry-docs",
    title:
      "This registry as a docs page and the AGENTS.md generated-files table",
    order: 110,
    inputs: ["tools/generators.ts", "tools/gen-generators-doc.ts"],
    outputs: [
      "packages/docs/src/content/docs/reference/generators.mdx",
      "AGENTS.md",
    ],
    write: [tsx("tools/gen-generators-doc.ts")],
    fast: true,
  },
  {
    id: "parity",
    title: "Parity gate: every SDK's parity.json against the feature registry",
    order: 120,
    checkOnly: true,
    inputs: [
      "tools/parity-check.ts",
      "tools/capabilities.ts",
      "conformance/parity/**",
      "sdks/*/parity.json",
      "packages/*/parity.json",
      "sdks/**/tests/**",
      `${SDK_DIRS}/*/test/**`,
    ],
    outputs: [],
    write: [tsx("tools/parity-check.ts")],
  },
  {
    id: "graph-index",
    title: "Omniplatform program INDEX.md from workpackages.json",
    order: 130,
    inputs: [
      "docs/research/2026-09-29-godot-omniplatform/program/workpackages.json",
      "docs/research/2026-09-29-godot-omniplatform/program/check.mjs",
      "docs/research/2026-09-29-godot-omniplatform/program/wp/*.md",
    ],
    outputs: ["docs/research/2026-09-29-godot-omniplatform/program/INDEX.md"],
    write: [
      {
        argv: [
          "node",
          "docs/research/2026-09-29-godot-omniplatform/program/check.mjs",
          "--write-index",
        ],
      },
      {
        argv: [
          "pnpm",
          "exec",
          "prettier",
          "--write",
          "docs/research/2026-09-29-godot-omniplatform/program/INDEX.md",
        ],
      },
    ],
    check: [
      {
        argv: [
          "node",
          "docs/research/2026-09-29-godot-omniplatform/program/check.mjs",
        ],
      },
    ],
  },
  // Families below are declared so every GENERATED banner has an owner. A plain run skips them.
  {
    id: "mirrors",
    title: "Typed config mirrors for a product catalog, in five languages",
    order: 200,
    manual:
      "needs --catalog and --out-dir; no product currently emits typed mirrors",
    inputs: ["tools/gen-mirrors.ts"],
    outputs: [
      "sdks/godot/tests/config/catalog_generated.gd",
      "sdks/kotlin/config/src/test/kotlin/im/plrs/key/config/mirror/ConfigSchema.generated.kt",
    ],
    write: [tsx("tools/gen-mirrors.ts")],
  },
  {
    id: "sdk-samples",
    title: "`pkey sdk` configuration samples, one per SDK",
    order: 210,
    manual:
      "written and checked by the CLI suite (packages/cli/test/sdkConfig.test.ts)",
    inputs: [
      "packages/cli/src/sdkConfig.ts",
      "packages/cli/test/sdkConfig.test.ts",
    ],
    outputs: [
      "conformance/runners/node/sdkConfigSample.ts",
      "packages/sdk-react/test/sdkConfigSample.ts",
      "sdks/python/tests/sdk_config_sample.py",
      "sdks/swift/Tests/PolarisKeyTests/SdkConfigSample.swift",
      "sdks/kotlin/sdk/src/test/kotlin/polaris/generated/PolarisConfig.kt",
      "sdks/godot/tests/sdk_config/polaris_key_config.gd",
    ],
    write: [
      {
        argv: [
          "pnpm",
          "--filter",
          "@polaris-key/cli",
          "exec",
          "vitest",
          "run",
          "test/sdkConfig.test.ts",
        ],
        env: { PKEY_UPDATE_SAMPLES: "1" },
      },
    ],
    check: [
      {
        argv: [
          "pnpm",
          "--filter",
          "@polaris-key/cli",
          "exec",
          "vitest",
          "run",
          "test/sdkConfig.test.ts",
        ],
      },
    ],
  },
  {
    id: "docs-csp",
    title: "Docs-site CSP hashes",
    order: 220,
    manual:
      "written by the docs build (packages/docs/scripts/collect-csp-hashes.mjs); the Worker suite checks it",
    inputs: [
      "packages/docs/scripts/collect-csp-hashes.mjs",
      "packages/docs/src/**",
    ],
    outputs: ["packages/worker/src/docsCsp.generated.ts"],
  },
  {
    id: "design-mockups",
    title: "Static design mockups built from their _src directories",
    order: 230,
    manual: "design artefacts built by their own scripts, not part of any gate",
    inputs: [
      "docs/design/console-product-card/_src/**",
      "docs/design/sign-in/prototype/**",
    ],
    outputs: [
      "docs/design/console-product-card/*.html",
      "docs/design/console-product-card/_src/accents.generated.css",
      "docs/design/sign-in/prototype/standalone.html",
    ],
    write: [
      { argv: ["node", "docs/design/console-product-card/_src/build.mjs"] },
    ],
  },
  {
    id: "ux-coverage",
    title: "UX coverage and wave pages from ux-coverage.json",
    order: 240,
    manual: "produced by a scratch script that is not in the repository yet",
    inputs: [
      "docs/research/2026-09-29-godot-omniplatform/program/ux-coverage.json",
      "docs/research/2026-09-29-godot-omniplatform/program/workpackages.json",
    ],
    outputs: [
      "docs/research/2026-09-29-godot-omniplatform/program/ux-coverage.md",
      "docs/research/2026-09-29-godot-omniplatform/program/ux-waves.md",
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Globs: `**` any depth, `*` within one path segment, `{a,b}` alternatives. A pattern ending in `/`
// matches everything below that directory.

export function globToRegExp(glob: string): RegExp {
  let g = glob.endsWith("/") ? `${glob}**` : glob;
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      const alts = g
        .slice(i + 1, end)
        .split(",")
        .map(escape);
      out += `(?:${alts.join("|")})`;
      i = end;
    } else if (c === "?") out += "[^/]";
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

function escape(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function matchesAny(globs: string[], file: string): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** The family that owns `file` as an output, if any. */
export function ownerOf(file: string): Generator | undefined {
  return GENERATORS.find((g) => matchesAny(g.outputs, file));
}

/** The families to run for a plain `pnpm gen`: not manual, not an alias, in order. */
export function defaultFamilies(): Generator[] {
  return GENERATORS.filter((g) => !g.manual && !g.via).sort(
    (a, b) => a.order - b.order,
  );
}

/** A family's check steps: its own, or the last write step with `--check` appended. */
export function checkSteps(g: Generator): Cmd[] {
  if (g.check) return g.check;
  const last = g.write?.[g.write.length - 1];
  if (!last) return [];
  return [{ ...last, argv: [...last.argv, "--check"] }];
}

/** The families whose inputs or outputs include any of `files`. A family that is `via` another
 *  runs through its parent. */
export function familiesTouching(files: string[]): Generator[] {
  const hit = new Set<string>();
  for (const g of GENERATORS) {
    if (files.some((f) => matchesAny(g.inputs, f) || matchesAny(g.outputs, f)))
      hit.add(g.via ?? g.id);
  }
  return GENERATORS.filter((g) => hit.has(g.id) && !g.manual && !g.via).sort(
    (a, b) => a.order - b.order,
  );
}
