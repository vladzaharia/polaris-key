/**
 * A-18i — the PR-plane storefront generators and steps: golden files for winget (validated
 * against the published 1.12.0 schemas), the Homebrew cask, the Scoop manifest and Flathub's
 * MetaInfo and first-submission skeleton, all from one fixture release and listing
 * (`prFixtures.ts`); the PR plane's conformance over the generated copy of the Worker's
 * declaration; and the step runner against a fake Worker and a fake GitHub. The Worker side (the
 * inputs read, the re-check, the ledger row with `plane = 'pr'`) is
 * `packages/worker/test/storefront/prPlane.test.ts`.
 *
 * Rewrite the golden files after an intended change: `UPDATE_GOLDENS=1 pnpm test storefrontsPr`.
 */

import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import { CI_PLANE } from "../src/storefronts/ciPlane.generated.js";
import { ciLiterals, matchCiCommand } from "../src/storefronts/allowList.js";
import {
  developerId,
  FLATHUB_RUNTIME_VERSION,
  generateFlathubSkeleton,
  generateMetainfo,
  isHostedAsset,
  metainfoMarkup,
  oarsAttributes,
  updateFlathubManifest,
} from "../src/storefronts/flathub.js";
import { generateCask, rubyString } from "../src/storefronts/homebrew.js";
import type { GeneratedFile, PrInputs } from "../src/storefronts/prInputs.js";
import {
  checkPrCommand,
  checkPrPaths,
  prNaturalKey,
  prPathAllowed,
  prStore,
  prVerdict,
} from "../src/storefronts/prPlane.js";
import { planPr, runPrStatus, runPrStep } from "../src/storefronts/prRun.js";
import { generateScoop, withHashAutoupdate } from "../src/storefronts/scoop.js";
import {
  generateWinget,
  wingetInstallerType,
} from "../src/storefronts/winget.js";
import {
  BASE,
  FLATHUB_INPUTS,
  HOMEBREW_INPUTS,
  SCOOP_INPUTS,
  WINGET_INPUTS,
} from "./prFixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "fixtures/pr-golden");
const SCHEMAS = path.join(HERE, "fixtures/winget-schema-1.12.0");
const WINGET_OPTS = { portable: "Diceroll/diceroll.exe", command: "diceroll" };
const CI_TOKEN = `pkeyci_${"A".repeat(43)}`;
const ENV = {
  PKEY_CI_TOKEN: CI_TOKEN,
  PKEY_PR_TOKEN: "github_pat_fake",
  GITHUB_RUN_ID: "424242",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "vlad/diceroll",
};

async function golden(store: string, files: readonly GeneratedFile[]) {
  for (const f of files) {
    const target = path.join(GOLDEN, store, f.path);
    if (process.env.UPDATE_GOLDENS === "1") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.content, "utf8");
      continue;
    }
    expect(existsSync(target), `${store}/${f.path} has a golden file`).toBe(
      true,
    );
    expect(f.content, `${store}/${f.path}`).toBe(
      await readFile(target, "utf8"),
    );
  }
  if (process.env.UPDATE_GOLDENS !== "1") {
    const want = new Set(files.map((f) => f.path));
    const walk = async (dir: string, rel = ""): Promise<string[]> =>
      (
        await Promise.all(
          (await readdir(dir, { withFileTypes: true })).map((e) =>
            e.isDirectory()
              ? walk(path.join(dir, e.name), `${rel}${e.name}/`)
              : [`${rel}${e.name}`],
          ),
        )
      ).flat();
    expect(
      (await walk(path.join(GOLDEN, store))).filter((p) => !want.has(p)),
      `stray golden files for ${store}`,
    ).toEqual([]);
  }
}

// ── Golden files ─────────────────────────────────────────────────────────────────────────────

describe("PR-plane generators: golden files (A-18i)", () => {
  it("winget: version, installer, default and extra locale manifests", async () => {
    const files = generateWinget(WINGET_INPUTS, WINGET_OPTS);
    expect(files.map((f) => f.path)).toEqual([
      "manifests/v/Vlad/Diceroll/1.2.0/Vlad.Diceroll.yaml",
      "manifests/v/Vlad/Diceroll/1.2.0/Vlad.Diceroll.installer.yaml",
      "manifests/v/Vlad/Diceroll/1.2.0/Vlad.Diceroll.locale.en-US.yaml",
      "manifests/v/Vlad/Diceroll/1.2.0/Vlad.Diceroll.locale.de.yaml",
    ]);
    await golden("winget", files);
  });

  it("homebrew: the cask for the own tap", async () => {
    await golden("homebrew", [generateCask(HOMEBREW_INPUTS)]);
  });

  it("scoop: the feed's manifest for the own bucket, with autoupdate", async () => {
    const file = generateScoop(SCOOP_INPUTS);
    expect(JSON.parse(file.content)).toEqual(
      withHashAutoupdate(SCOOP_INPUTS.scoop as object),
    );
    await golden("scoop", [file]);
  });

  it("flathub: the MetaInfo, and the first submission's skeleton", async () => {
    const { files, warnings } = generateFlathubSkeleton(FLATHUB_INPUTS);
    expect(warnings).toEqual([
      "content descriptors with no OARS attribute, left out: lootBoxes",
    ]);
    expect(files.map((f) => f.path)).toEqual([
      "gg.vlad.Diceroll.yml",
      "gg.vlad.Diceroll.metainfo.xml",
      "gg.vlad.Diceroll.desktop",
    ]);
    await golden("flathub", files);
  });
});

// ── winget schema 1.12.0 ─────────────────────────────────────────────────────────────────────

describe("winget manifests validate against the published schema 1.12.0 (A-18i)", () => {
  // ajv and ajv-formats are CommonJS: their default export is the module or its `default`.
  type Validate = ((doc: unknown) => boolean) & { errors?: unknown };
  type AjvLike = {
    compile(schema: object): Validate;
    errorsText(errors: unknown): string;
  };
  const Ajv = ((AjvModule as unknown as { default?: unknown }).default ??
    AjvModule) as new (opts: object) => AjvLike;
  const addFormats = ((addFormatsModule as unknown as { default?: unknown })
    .default ?? addFormatsModule) as (ajv: AjvLike) => void;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validators: Record<string, Validate> = {};
  for (const kind of ["version", "installer", "defaultLocale", "locale"])
    validators[kind] = ajv.compile(
      JSON.parse(
        readFileSync(
          path.join(SCHEMAS, `manifest.${kind}.1.12.0.json`),
          "utf8",
        ),
      ) as object,
    );

  const check = (files: readonly GeneratedFile[]) => {
    for (const f of files) {
      const doc = parseYaml(f.content) as { ManifestType: string };
      const validate = validators[doc.ManifestType];
      expect(
        validate,
        `${f.path}: ManifestType ${doc.ManifestType}`,
      ).toBeDefined();
      const ok = validate!(doc);
      expect(ok, `${f.path}: ${ajv.errorsText(validate!.errors)}`).toBe(true);
    }
  };

  it("the golden fixture's four files", () => {
    check(generateWinget(WINGET_INPUTS, WINGET_OPTS));
  });

  it("the validator refuses a manifest the schema refuses (it is not vacuous)", () => {
    const [, installer] = generateWinget(WINGET_INPUTS, WINGET_OPTS);
    const doc = parseYaml(installer!.content) as {
      Installers: Record<string, unknown>[];
    };
    delete doc.Installers[0]!.InstallerSha256;
    doc.Installers[1]!.Architecture = "x86_64";
    expect(validators.installer!(doc)).toBe(false);
  });

  it("portable .exe, .msi and .msix builds", () => {
    const builds = [
      ["Dice-1.2.0-x64.exe", "x86_64"],
      ["Dice-1.2.0-arm64.msi", "arm64"],
      ["Dice-1.2.0-x86.msix", "x86"],
    ].map(([name, arch], n) => ({
      platform: "windows",
      arch: arch!,
      name: name!,
      url: `${BASE}/b/${n}`,
      sha256: String(n).repeat(64),
      size: 1,
    }));
    const files = generateWinget(
      {
        ...WINGET_INPUTS,
        release: { ...WINGET_INPUTS.release!, builds, publishedAt: null },
      },
      { command: "dice", license: "MIT" },
    );
    check(files);
    const installer = parseYaml(files[1]!.content) as {
      Installers: { InstallerType: string; InstallerSha256: string }[];
    };
    expect(installer.Installers.map((x) => x.InstallerType)).toEqual([
      "portable",
      "msi",
      "msix",
    ]);
    expect(installer.Installers[0]!.InstallerSha256).toBe("0".repeat(64));
  });
});

// ── Generator rules ──────────────────────────────────────────────────────────────────────────

describe("PR-plane generator rules (A-18i)", () => {
  it("winget refuses a zip with no --portable, a plain-HTTP URL and a blocked projection", () => {
    expect(() => generateWinget(WINGET_INPUTS)).toThrow(/--portable/);
    const http = structuredClone(WINGET_INPUTS);
    http.release!.builds[0]!.url = "http://insecure.example.test/x.zip";
    expect(() => generateWinget(http, WINGET_OPTS)).toThrow(/HTTPS/);
    const blocked: PrInputs = {
      ...WINGET_INPUTS,
      listing: {
        exists: false,
        status: "red",
        payload: null,
        issues: [
          {
            field: "Publisher",
            locale: null,
            issue: "missing",
            severity: "block",
          },
        ],
      },
    };
    expect(() => generateWinget(blocked, WINGET_OPTS)).toThrow(
      /blocked \(the product has no listing yet\): Publisher: missing/,
    );
    expect(() =>
      generateWinget({ ...WINGET_INPUTS, release: null }, WINGET_OPTS),
    ).toThrow(/serves no release/);
    expect(() =>
      generateWinget(WINGET_INPUTS, { ...WINGET_OPTS, portable: "../x.exe" }),
    ).toThrow(/relative path/);
    expect(wingetInstallerType("x.tar.gz")).toBeNull();
  });

  it("the cask covers split arm64 and x86_64 builds, a non-stable channel and Ruby escaping", () => {
    const split = structuredClone(HOMEBREW_INPUTS);
    split.channel = "beta";
    split.selfUpdates = false;
    split.release!.builds = [
      { ...split.release!.builds[0]!, arch: "arm64", name: "D-arm64.dmg" },
      {
        ...split.release!.builds[0]!,
        arch: "x86_64",
        name: "D-x64.zip",
        sha256: "f".repeat(64),
      },
    ];
    const cask = generateCask(split, { app: "Dice Roll.app" }).content;
    expect(cask).toContain("  on_arm do\n");
    expect(cask).toContain("  on_intel do\n");
    expect(cask).toContain('skip "follows the beta channel');
    expect(cask).not.toContain("auto_updates");
    expect(cask).toContain('app "Dice Roll.app"');
    expect(rubyString('a "#{x}" \\')).toBe('"a \\"\\#{x}\\" \\\\"');
    expect(() => generateCask(split, { app: "../evil.app" })).toThrow(/--app/);
  });

  it("scoop refuses a feed without a manifest or for another version", () => {
    expect(() => generateScoop({ ...SCOOP_INPUTS, scoop: null })).toThrow(
      /no manifest/,
    );
    expect(() =>
      generateScoop({
        ...SCOOP_INPUTS,
        scoop: { ...(SCOOP_INPUTS.scoop as object), version: "1.1.0" },
      }),
    ).toThrow(/serves 1\.1\.0/);
    expect(generateScoop(SCOOP_INPUTS, { app: "dice" }).path).toBe(
      "bucket/dice.json",
    );
  });

  it("scoop autoupdate follows a content-addressed feed through checkver's captures", () => {
    const feed = SCOOP_INPUTS.scoop as {
      architecture: Record<string, { url: string; hash: string }>;
      checkver: { url: string };
    };
    const m = withHashAutoupdate(feed) as {
      checkver: { url: string; regex: string; jsonpath?: string };
      autoupdate: {
        architecture: Record<string, { url: string; hash: unknown }>;
      };
    };
    expect(m.checkver.url).toBe(feed.checkver.url);
    expect(m.checkver.jsonpath).toBeUndefined();
    expect(m.autoupdate.architecture).toEqual({
      "64bit": {
        url: feed.architecture["64bit"]!.url.replace(
          /[0-9a-f]{64}$/,
          "$matchHashx",
        ),
        hash: { url: feed.checkver.url, jsonpath: "$.architecture.64bit.hash" },
      },
      arm64: {
        url: feed.architecture.arm64!.url.replace(
          /[0-9a-f]{64}$/,
          "$matchHasharm",
        ),
        hash: { url: feed.checkver.url, jsonpath: "$.architecture.arm64.hash" },
      },
    });
    // The next release's feed, as the Worker serialises it (two-space JSON) and compactly: the
    // regex (the .NET and JavaScript named-group syntax agree) captures its version and hashes,
    // and Scoop's `$match<Name>` substitution yields that release's URLs.
    const next = {
      ...feed,
      version: "1.3.0",
      architecture: {
        "64bit": {
          url: feed.architecture["64bit"]!.url.replace(
            /[0-9a-f]{64}$/,
            "d".repeat(64),
          ),
          hash: "d".repeat(64),
        },
        arm64: {
          url: feed.architecture.arm64!.url.replace(
            /[0-9a-f]{64}$/,
            "e".repeat(64),
          ),
          hash: "e".repeat(64),
        },
      },
    };
    for (const page of [JSON.stringify(next, null, 2), JSON.stringify(next)]) {
      const g = new RegExp(m.checkver.regex).exec(page)?.groups;
      expect(g).toEqual({
        version: "1.3.0",
        hashx: "d".repeat(64),
        hasharm: "e".repeat(64),
      });
      const sub = (u: string) =>
        u
          .replace("$matchHashx", g!.hashx!)
          .replace("$matchHasharm", g!.hasharm!);
      expect(sub(m.autoupdate.architecture["64bit"]!.url)).toBe(
        next.architecture["64bit"].url,
      );
      expect(sub(m.autoupdate.architecture.arm64!.url)).toBe(
        next.architecture.arm64.url,
      );
    }
    // A feed that already has autoupdate (version-templated URLs), or a URL that is not
    // `…/blobs/sha256/<its hash>`, is left as the feed wrote it.
    const templated = { ...feed, autoupdate: { url: "x" } };
    expect(withHashAutoupdate(templated)).toBe(templated);
    const external = {
      ...feed,
      architecture: {
        ...feed.architecture,
        arm64: {
          url: "https://cdn.example.test/d-1.2.0.zip",
          hash: "a".repeat(64),
        },
      },
    };
    expect(withHashAutoupdate(external)).toBe(external);
  });

  it("flathub's skeleton pins a supported runtime branch, overridable", () => {
    const yml = (o?: { runtimeVersion?: string }) =>
      parseYaml(
        generateFlathubSkeleton(FLATHUB_INPUTS, o).files[0]!.content,
      ) as {
        "runtime-version": string;
      };
    expect(yml()["runtime-version"]).toBe(FLATHUB_RUNTIME_VERSION);
    expect(FLATHUB_RUNTIME_VERSION).toBe("25.08");
    expect(yml({ runtimeVersion: "26.08" })["runtime-version"]).toBe("26.08");
    expect(() => yml({ runtimeVersion: "latest" })).toThrow(
      /--runtime-version/,
    );
  });

  it("maps content descriptors to OARS 1.1, and writes description markup", () => {
    expect(
      oarsAttributes({
        violenceCartoon: "mild",
        "drugs-alcohol": "INTENSE",
        chat: "frequent",
        sexNudity: "sometimes",
        made_up: "mild",
      }),
    ).toEqual({
      attributes: [
        ["drugs-alcohol", "intense"],
        ["social-chat", "intense"],
        ["violence-cartoon", "mild"],
      ],
      unmapped: ["made_up", "sexNudity"],
    });
    expect(metainfoMarkup("A & B\nC\n\n- one\n* <two>", "")).toEqual([
      "<p>A &amp; B C</p>",
      "<ul>",
      "  <li>one</li>",
      "  <li>&lt;two&gt;</li>",
      "</ul>",
    ]);
    expect(developerId("gg.vlad.Diceroll")).toBe("gg.vlad");
  });

  it("the MetaInfo warns about missing branding, screenshots and developer", () => {
    const bare = structuredClone(FLATHUB_INPUTS);
    bare.app.tint = null;
    bare.app.screenshots = [];
    bare.app.developerName = null;
    bare.app.contentDescriptors = null;
    delete bare.listing!.payload!.app.developerName;
    const { file, warnings } = generateMetainfo(bare);
    expect(warnings).toHaveLength(3);
    expect(file.content).toContain('<content_rating type="oars-1.1"/>');
    expect(file.content).not.toContain("<branding>");
  });

  it("the MetaInfo never emits a raw listing URL or a dl blob URL (S-20 §4.2 L6)", () => {
    const raw = structuredClone(FLATHUB_INPUTS);
    raw.app.screenshots = [
      "https://cdn.example.test/diceroll/1.png",
      `https://dl.plrs.im/diceroll/blobs/${"3c".repeat(32)}`,
      `https://img.plrs.im.evil.test/diceroll/a/${"4d".repeat(32)}`,
      `https://img.plrs.im/diceroll/a/${"5e".repeat(32)}?x=1`,
      "http://img.plrs.im/diceroll/a/" + "6f".repeat(32),
    ];
    const { file, warnings } = generateMetainfo(raw);
    expect(file.content).not.toContain("<screenshots>");
    expect(file.content).not.toContain("cdn.example.test");
    expect(file.content).not.toContain("dl.plrs.im");
    expect(file.content).not.toContain("evil.test");
    expect(
      warnings.some((w) => w.startsWith("screenshots not on the media host")),
    ).toBe(true);
    expect(warnings.some((w) => w.startsWith("no screenshots"))).toBe(true);

    const mixed = structuredClone(FLATHUB_INPUTS);
    mixed.app.screenshots = [
      "https://cdn.example.test/diceroll/1.png",
      ...FLATHUB_INPUTS.app.screenshots,
    ];
    const kept = generateMetainfo(mixed).file.content;
    expect(kept).not.toContain("cdn.example.test");
    expect(kept.match(/<image>/g)).toHaveLength(2);
    expect(isHostedAsset(FLATHUB_INPUTS.app.screenshots[0]!)).toBe(true);
  });

  it("updates an app repository's manifest in place, keeping comments", () => {
    const yml = [
      "# maintained by hand",
      "id: gg.vlad.Diceroll",
      "modules:",
      "  - name: diceroll",
      "    sources:",
      "      - type: extra-data # the game",
      "        filename: diceroll-x86_64.tar.gz",
      "        only-arches: [x86_64]",
      "        url: https://old.example.test/x",
      "        sha256: old",
      "        size: 1",
      "      - type: file",
      "        path: keep.txt",
      "",
    ].join("\n");
    const out = updateFlathubManifest(
      yml,
      "gg.vlad.Diceroll.yml",
      FLATHUB_INPUTS,
    );
    expect(out).toContain("# maintained by hand");
    expect(out).toContain("# the game");
    expect(out).toContain(`sha256: ${"e".repeat(64)}`);
    expect(out).toContain("size: 51000000");
    expect(out).toContain("path: keep.txt");
    const json = updateFlathubManifest(
      JSON.stringify({
        id: "gg.vlad.Diceroll",
        modules: [
          {
            name: "d",
            sources: [
              {
                type: "extra-data",
                "only-arches": ["aarch64"],
                url: "x",
                sha256: "y",
                size: 1,
              },
            ],
          },
        ],
      }),
      "gg.vlad.Diceroll.json",
      FLATHUB_INPUTS,
    );
    expect(JSON.parse(json).modules[0].sources[0].sha256).toBe("d".repeat(64));
    expect(() =>
      updateFlathubManifest("id: x\nmodules: []\n", "x.yml", FLATHUB_INPUTS),
    ).toThrow(/no extra-data source/);
  });
});

// ── The PR plane's conformance over the generated copy ───────────────────────────────────────

describe("the PR plane in the CLI (A-18i)", () => {
  it("declares the four PR-plane stores", () => {
    expect(CI_PLANE.prStores.map((s) => s.store)).toEqual([
      "winget",
      "homebrew",
      "scoop",
      "flathub",
    ]);
  });

  for (const s of CI_PLANE.prStores)
    it(`${s.store}: refuses every never-list line, spells no never-token, and admits each generator's paths`, () => {
      for (const argv of s.never)
        expect(matchCiCommand(s.list, argv), argv.join(" ")).toBeNull();
      const literals = ciLiterals(s.list).map((l) => l.toLowerCase());
      for (const t of s.neverTokens)
        expect(
          literals.filter((l) => l.includes(t)),
          t,
        ).toEqual([]);
      expect(Object.keys(s.list.commands).sort()).toEqual([
        "pull-request",
        "status",
      ]);
      expect(s.list.tool).toBe("github");
    });

  it("binds the repository to the outlet identity and the files to the store's templates", async () => {
    const cases: [string, PrInputs, GeneratedFile[]][] = [
      ["winget", WINGET_INPUTS, generateWinget(WINGET_INPUTS, WINGET_OPTS)],
      ["homebrew", HOMEBREW_INPUTS, [generateCask(HOMEBREW_INPUTS)]],
      ["scoop", SCOOP_INPUTS, [generateScoop(SCOOP_INPUTS)]],
      [
        "flathub",
        FLATHUB_INPUTS,
        generateFlathubSkeleton(FLATHUB_INPUTS).files.slice(0, 2),
      ],
    ];
    for (const [id, inputs, files] of cases) {
      const store = prStore(id)!;
      const plan = await planPr(store, inputs, WINGET_OPTS, null);
      checkPrCommand(store, "pull-request", plan.argv, inputs.outlet.identity);
      checkPrPaths(
        store,
        plan.argv,
        files.map((f) => f.path),
      );
      expect(prNaturalKey(store, "pull-request", plan.argv)).toMatch(
        /^pr:.+:1\.2\.0$/,
      );
    }
    const homebrew = prStore("homebrew")!;
    const tapArgv = (repo: string) => [
      "pull-request",
      "--repo",
      repo,
      "--cask",
      "diceroll",
      "--version",
      "1.2.0",
    ];
    expect(() =>
      checkPrCommand(
        homebrew,
        "pull-request",
        tapArgv("Homebrew/homebrew-cask"),
        HOMEBREW_INPUTS.outlet.identity,
      ),
    ).toThrow(/refuses/);
    expect(() =>
      checkPrCommand(
        homebrew,
        "pull-request",
        tapArgv("evil/homebrew-games"),
        HOMEBREW_INPUTS.outlet.identity,
      ),
    ).toThrow(/identity does not declare/);
    const argv = tapArgv("vlad/homebrew-games");
    expect(prPathAllowed(homebrew, argv, "Casks/diceroll.rb")).toBe(true);
    expect(prPathAllowed(homebrew, argv, "Casks/other.rb")).toBe(false);
    expect(
      prPathAllowed(homebrew, argv, "Casks/../.github/workflows/x.yml"),
    ).toBe(false);
    expect(() =>
      checkPrPaths(homebrew, argv, [".github/workflows/x.yml"]),
    ).toThrow(/not a path/);
    const winget = prStore("winget")!;
    expect(
      prVerdict(winget, {
        state: "open",
        merged: false,
        labels: ["Validation-Domain"],
      }),
    ).toBe("validation-issue");
    expect(
      prVerdict(winget, {
        state: "open",
        merged: false,
        labels: ["Needs-Author-Feedback"],
      }),
    ).toBe("needs-author-feedback");
    expect(
      prVerdict(winget, {
        state: "open",
        merged: false,
        labels: ["Validation-Completed"],
      }),
    ).toBe("in-review");
  });
});

// ── The step runner ──────────────────────────────────────────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const PR_RAW = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  html_url: `https://github.com/microsoft/winget-pkgs/pull/${n}`,
  state: "open",
  merged_at: null,
  labels: [{ name: "Azure-Pipeline-Passed" }],
  title: "New version: Vlad.Diceroll version 1.2.0",
  ...over,
});

/** A fake Worker (inputs read, report-back) and a fake GitHub, one fetch. */
function fakeWorld(
  inputs: PrInputs,
  github: (s: Seen) => [number, unknown] | null = () => null,
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const s: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
    };
    seen.push(s);
    let answer: [number, unknown] | null = null;
    if (s.url.startsWith(`${BASE}/diceroll/distribution/pr/`))
      answer = [200, { ok: true, inputs }];
    else if (s.url === `${BASE}/diceroll/distribution/report`)
      answer = [
        200,
        {
          ok: true,
          type: "store-step",
          step: {
            opId: "op1",
            state: s.body.state,
            replayed: false,
            verdict: "in-review",
          },
        },
      ];
    else if (s.url.startsWith("https://api.github.com/")) {
      answer = github(s);
      if (!answer) {
        const p = s.url.slice("https://api.github.com".length);
        if (p === "/user") answer = [200, { login: "vlad" }];
        else if (/^\/repos\/[^/]+\/[^/]+$/.test(p) && s.method === "GET")
          answer = [200, { default_branch: "master" }];
        else if (p.endsWith("/forks"))
          answer = [202, { full_name: "vlad/winget-pkgs" }];
        else if (p.endsWith("/merge-upstream")) answer = [200, {}];
        else if (p.includes("/git/ref/heads/master"))
          answer = [200, { object: { sha: "base0" } }];
        else if (p.includes("/git/ref/heads/"))
          answer = [404, { message: "Not Found" }];
        else if (p.includes("/git/commits/"))
          answer = [200, { tree: { sha: "tree0" } }];
        else if (p.endsWith("/git/trees")) answer = [201, { sha: "tree1" }];
        else if (p.endsWith("/git/commits")) answer = [201, { sha: "commit1" }];
        else if (p.endsWith("/git/refs")) answer = [201, {}];
        else if (p.includes("/pulls?")) answer = [200, []];
        else if (p.startsWith("/search/issues")) answer = [200, { items: [] }];
        else if (p.includes("/contents/"))
          answer = [404, { message: "Not Found" }];
        else if (p.endsWith("/pulls") && s.method === "POST")
          answer = [201, PR_RAW(9001, { title: s.body.title })];
      }
    }
    if (!answer) throw new Error(`unexpected ${s.method} ${s.url}`);
    return new Response(JSON.stringify(answer[1]), {
      status: answer[0],
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function sink() {
  let text = "";
  return {
    out: { write: (s: string) => ((text += s), true) } as never,
    text: () => text,
  };
}

const stepOptions = (store: string, fetchImpl: typeof fetch, over = {}) => {
  const stdout = sink();
  const stderr = sink();
  return {
    stdout,
    stderr,
    o: {
      store,
      product: "diceroll",
      channel: "stable",
      generator: WINGET_OPTS,
      baseUrl: BASE,
      env: ENV,
      stdout: stdout.out,
      stderr: stderr.out,
      fetchImpl,
      sleep: async () => {},
      cwd: tmpdir(),
      ...over,
    },
  };
};

const reports = (seen: Seen[]) =>
  seen.filter((s) => s.url.endsWith("/distribution/report")).map((s) => s.body);

describe("pkey storefront <store> pr (A-18i)", () => {
  it("winget: forks, commits the four files on a pkey branch, opens the PR and reports it", async () => {
    const w = fakeWorld(WINGET_INPUTS);
    const { o, stdout } = stepOptions("winget", w.fetchImpl);
    const r = await runPrStep(o);
    expect(r.outcome).toBe("opened");
    expect(r.plan.title).toBe("New package: Vlad.Diceroll version 1.2.0");
    const tree = w.seen.find((s) =>
      s.url.endsWith("/repos/vlad/winget-pkgs/git/trees"),
    )!;
    expect(
      (tree.body.tree as { path: string }[]).map((t) => t.path),
    ).toHaveLength(4);
    const opened = w.seen.find(
      (s) =>
        s.method === "POST" &&
        s.url.endsWith("/repos/microsoft/winget-pkgs/pulls"),
    )!;
    expect(opened.body).toMatchObject({
      head: "vlad:pkey/Vlad.Diceroll-1.2.0",
      base: "master",
    });
    const sent = reports(w.seen);
    expect(sent.map((b) => b.state)).toEqual(["pending", "done"]);
    expect(sent[1]).toMatchObject({
      store: "winget",
      op: "release",
      command: "pull-request",
      argv: [
        "pull-request",
        "--repo",
        "microsoft/winget-pkgs",
        "--package",
        "Vlad.Diceroll",
        "--version",
        "1.2.0",
      ],
      outlet: "winget",
      runId: "gh-424242-1",
      pr: {
        number: 9001,
        url: "https://github.com/microsoft/winget-pkgs/pull/9001",
        state: "open",
        merged: false,
        labels: ["Azure-Pipeline-Passed"],
      },
    });
    expect(
      (sent[1]!.files as { sha256: string }[]).every((f) =>
        /^[0-9a-f]{64}$/.test(f.sha256),
      ),
    ).toBe(true);
    // The GitHub token goes to GitHub only: never in a report or on stdout.
    expect(JSON.stringify(sent)).not.toContain("github_pat_fake");
    expect(stdout.text()).not.toContain("github_pat_fake");
    for (const s of w.seen.filter(
      (x) => x.method !== "GET" && x.url.startsWith("https://api.github.com/"),
    ))
      expect(s.url, "no merge, close or delete").not.toMatch(
        /merge$|\/close|delete/,
      );
  });

  it("an open or merged PR for the version is the step, done with existing: true", async () => {
    const w = fakeWorld(WINGET_INPUTS, (s) =>
      s.url.includes("/search/issues")
        ? [
            200,
            {
              items: [
                PR_RAW(77, {
                  state: "closed",
                  pull_request: { merged_at: "2026-10-01T00:00:00Z" },
                }),
              ],
            },
          ]
        : null,
    );
    const { o } = stepOptions("winget", w.fetchImpl);
    const r = await runPrStep(o);
    expect(r.outcome).toBe("existing");
    expect(r.verdict).toBe("merged");
    expect(w.seen.some((s) => s.url.endsWith("/git/trees"))).toBe(false);
    expect(reports(w.seen)[1]).toMatchObject({
      state: "done",
      existing: true,
      pr: { number: 77, merged: true, state: "closed" },
    });
  });

  it("homebrew: a branch in the tap itself, and nothing when the tap already carries the cask", async () => {
    const cask = generateCask(HOMEBREW_INPUTS).content;
    const w = fakeWorld(HOMEBREW_INPUTS);
    const { o } = stepOptions("homebrew", w.fetchImpl);
    const r = await runPrStep(o);
    expect(r.outcome).toBe("opened");
    expect(w.seen.some((s) => s.url.endsWith("/forks"))).toBe(false);
    const opened = w.seen.find(
      (s) => s.method === "POST" && s.url.endsWith("/pulls"),
    )!;
    expect(opened.url).toBe(
      "https://api.github.com/repos/vlad/homebrew-games/pulls",
    );
    expect(opened.body.head).toBe("pkey/diceroll-1.2.0");

    const same = fakeWorld(HOMEBREW_INPUTS, (s) =>
      s.url.includes("/contents/Casks/diceroll.rb")
        ? [
            200,
            {
              type: "file",
              encoding: "base64",
              content: Buffer.from(cask).toString("base64"),
            },
          ]
        : null,
    );
    const r2 = await runPrStep(stepOptions("homebrew", same.fetchImpl).o);
    expect(r2.outcome).toBe("unchanged");
    expect(reports(same.seen)).toEqual([]);
  });

  it("flathub: updates the app repository's manifest and MetaInfo", async () => {
    const yml =
      "id: gg.vlad.Diceroll\nmodules:\n  - name: d\n    sources:\n      - type: extra-data\n        only-arches: [x86_64]\n        url: x\n        sha256: y\n        size: 1\n";
    const w = fakeWorld(FLATHUB_INPUTS, (s) =>
      s.url.includes("/contents/gg.vlad.Diceroll.yml")
        ? [
            200,
            {
              type: "file",
              encoding: "base64",
              content: Buffer.from(yml).toString("base64"),
            },
          ]
        : null,
    );
    const r = await runPrStep(stepOptions("flathub", w.fetchImpl).o);
    expect(r.plan.files.map((f) => f.path)).toEqual([
      "gg.vlad.Diceroll.yml",
      "gg.vlad.Diceroll.metainfo.xml",
    ]);
    expect(r.plan.repo).toBe("flathub/gg.vlad.Diceroll");
    expect(reports(w.seen)[1]!.files).toHaveLength(2);
  });

  it("refuses with no GitHub token, reports a failure after pending, and writes a dry run's files", async () => {
    const w = fakeWorld(SCOOP_INPUTS);
    await expect(
      runPrStep(
        stepOptions("scoop", w.fetchImpl, { env: { PKEY_CI_TOKEN: CI_TOKEN } })
          .o,
      ),
    ).rejects.toThrow(/PKEY_PR_TOKEN is not set/);

    const broken = fakeWorld(SCOOP_INPUTS, (s) =>
      s.url.endsWith("/git/trees") ? [422, { message: "tree invalid" }] : null,
    );
    await expect(
      runPrStep(stepOptions("scoop", broken.fetchImpl).o),
    ).rejects.toThrow(/tree invalid/);
    expect(reports(broken.seen).map((b) => b.state)).toEqual([
      "pending",
      "failed",
    ]);

    const out = await mkdtemp(path.join(tmpdir(), "pkey-pr-"));
    const dry = fakeWorld(SCOOP_INPUTS);
    const r = await runPrStep(
      stepOptions("scoop", dry.fetchImpl, {
        dryRun: true,
        outDir: out,
        env: { PKEY_CI_TOKEN: CI_TOKEN },
      }).o,
    );
    expect(r.outcome).toBe("dry-run");
    expect(
      JSON.parse(
        await readFile(path.join(out, "bucket/diceroll.json"), "utf8"),
      ),
    ).toEqual(withHashAutoupdate(SCOOP_INPUTS.scoop as object));
    expect(
      dry.seen.every((s) => !s.url.startsWith("https://api.github.com/")),
    ).toBe(true);
    expect(reports(dry.seen)).toEqual([]);
  });
});

describe("pkey storefront <store> status (A-18i)", () => {
  it("reads the PR's labels as a verdict and reports a status step", async () => {
    const w = fakeWorld(WINGET_INPUTS, (s) =>
      s.url.includes("/search/issues")
        ? [
            200,
            {
              items: [
                PR_RAW(55, { labels: [{ name: "Needs-Author-Feedback" }] }),
              ],
            },
          ]
        : null,
    );
    const { o, stdout } = stepOptions("winget", w.fetchImpl);
    const r = await runPrStatus(o);
    expect(r.verdict).toBe("needs-author-feedback");
    expect(stdout.text()).toContain("pull/55: needs-author-feedback");
    expect(reports(w.seen)).toEqual([
      expect.objectContaining({
        op: "status",
        command: "status",
        state: "done",
        argv: [
          "status",
          "--repo",
          "microsoft/winget-pkgs",
          "--package",
          "Vlad.Diceroll",
          "--version",
          "1.2.0",
        ],
        pr: expect.objectContaining({
          number: 55,
          labels: ["Needs-Author-Feedback"],
        }),
      }),
    ]);
  });

  it("fails when no pull request exists for the version", async () => {
    const w = fakeWorld(HOMEBREW_INPUTS);
    await expect(
      runPrStatus(stepOptions("homebrew", w.fetchImpl).o),
    ).rejects.toThrow(/No pull request for pr:diceroll:1\.2\.0/);
  });
});

describe("the pkey storefront command line (A-18i)", () => {
  it("routes pr, status and flathub init, and refuses a store with no PR plane", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pkey-pr-cli-"));
    const w = fakeWorld(FLATHUB_INPUTS);
    const out = sink();
    const err = sink();
    const code = await runPkey(
      [
        "storefront",
        "flathub",
        "init",
        "--product",
        "diceroll",
        "--base-url",
        BASE,
        "--out",
        "fh",
      ],
      {
        cwd,
        stdout: out.out,
        stderr: err.out,
        env: ENV,
        fetchImpl: w.fetchImpl,
        sleep: async () => {},
      },
    );
    expect(code, err.text()).toBe(0);
    expect(
      await readFile(path.join(cwd, "fh/gg.vlad.Diceroll.yml"), "utf8"),
    ).toContain("x-checker-data");
    expect(out.text()).toContain("new-pr");
    const bad = sink();
    expect(
      await runPkey(["storefront", "itch", "pr", "--product", "diceroll"], {
        cwd,
        stdout: sink().out,
        stderr: bad.out,
        env: ENV,
        fetchImpl: w.fetchImpl,
      }),
    ).not.toBe(0);
    expect(bad.text()).toContain("not a PR-plane store");
  });
});
