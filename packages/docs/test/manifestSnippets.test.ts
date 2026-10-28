/**
 * Every manifest fence on the docs site passes the validator the platform applies (docs plan
 * section 4). A fence titled `.pkey/product`, `.pkey/schema`, `.pkey/release` or
 * `.pkey/distribution` is merged over a minimal valid manifest, then validated with
 * `validateManifestDocuments`: an error fails, a warning does not. A fragment may be a bare
 * catalog entry or a `"key": { ... }` member.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateManifestDocuments } from "../../shared-manifest/src/index";

const ROOT = join(__dirname, "../src/content/docs");
type Doc = "product" | "schema" | "release" | "distribution";

interface Fence {
  file: string;
  line: number;
  doc: Doc;
  lang: string;
  code: string;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.mdx?$/.test(name)) yield full;
  }
}

export function manifestFences(): Fence[] {
  const out: Fence[] = [];
  for (const path of walk(ROOT)) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const open =
        /^(\s*)```(jsonc?|ya?ml)\s+.*title="\.pkey\/(product|schema|release|distribution)"/.exec(
          lines[i] ?? "",
        );
      if (!open) continue;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j] ?? "")) {
        body.push((lines[j] ?? "").slice((open[1] ?? "").length));
        j += 1;
      }
      out.push({
        file: relative(ROOT, path),
        line: i + 1,
        doc: open[3] as Doc,
        lang: open[2] ?? "",
        code: body.join("\n"),
      });
      i = j;
    }
  }
  return out;
}

/** Drops `//` comments outside strings and trailing commas, so JSONC parses as JSON. */
function jsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else out += c;
  }
  const cleaned = out.replace(/,(\s*[}\]])/g, "$1");
  const t = cleaned.trim();
  return JSON.parse(/^["]/.test(t) ? `{${t.replace(/,$/, "")}}` : cleaned);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: Obj, extra: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(extra))
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Obj, v) : v;
  return out;
}

const BASE_PRODUCT: Obj = {
  apiVersion: "pkey.dev/v1",
  product: { slug: "tidewater", name: "Tidewater Studio" },
  modules: { license: { enabled: true }, config: { enabled: true } },
  licensing: {
    profiles: [{ id: "default", name: "Default" }],
    tiers: [
      { id: "free", label: "Free", profileId: "default" },
      { id: "pro", label: "Pro", profileId: "default" },
    ],
  },
};
const flag = (key: string): Obj => ({
  key,
  kind: "flag",
  category: "Access",
  label: key,
  description: key,
  schema: { type: "boolean" },
  default: false,
});
const BASE_SCHEMA: Obj = {
  schemaVersion: 1,
  entries: [flag("cloudSaves"), flag("extras.diceSkins")],
};
const BASE_RELEASE: Obj = {
  release: { provider: { type: "github", owner: "acme", repo: "tidewater" } },
};

/** The release a distribution fence reads: the app and the `tidewater.foes` pack the docs' depot maps name. */
const DISTRIBUTION_RELEASE: Obj = merge(BASE_RELEASE, {
  release: {
    deliverables: {
      app: {
        kind: "app",
        content: { contentApi: 3 },
        artifacts: [
          {
            id: "macos",
            platform: "macos",
            arch: "universal",
            format: "dmg",
            match: "Tidewater-*-macos.dmg",
          },
        ],
      },
      "tidewater.foes": {
        kind: "pack",
        type: "godot.pck",
        binding: "compatible",
        handler: { prefixes: ["res://foes/"] },
        requires: { engine: "godot-4.7", contentApi: { app: ">=3 <4" } },
      },
    },
  },
});

export function documentsFor(f: Fence): {
  product: Obj;
  schema?: Obj;
  release?: Obj;
  distribution?: Obj;
} {
  const parsed = (
    f.lang.startsWith("y") ? yaml.load(f.code) : jsonc(f.code)
  ) as Obj;
  const product = BASE_PRODUCT;
  switch (f.doc) {
    case "product":
      return {
        product: merge(BASE_PRODUCT, parsed),
        schema: BASE_SCHEMA,
        release: BASE_RELEASE,
      };
    case "schema": {
      const doc =
        "key" in parsed && "kind" in parsed ? { entries: [parsed] } : parsed;
      return {
        product,
        schema: {
          ...BASE_SCHEMA,
          ...doc,
          entries: [
            ...(BASE_SCHEMA.entries as unknown[]),
            ...((doc.entries as unknown[]) ?? []),
          ],
        },
      };
    }
    case "release":
      return {
        product: merge(BASE_PRODUCT, {
          modules: { release: { enabled: true } },
        }),
        schema: BASE_SCHEMA,
        release:
          "release" in parsed
            ? merge(BASE_RELEASE, parsed)
            : merge(BASE_RELEASE, { release: parsed }),
      };
    case "distribution":
      return {
        product: merge(BASE_PRODUCT, {
          modules: {
            release: { enabled: true },
            distribution: { enabled: true },
          },
        }),
        schema: BASE_SCHEMA,
        release: DISTRIBUTION_RELEASE,
        distribution: parsed,
      };
  }
}

describe("manifest fences", () => {
  const fences = manifestFences();

  it("finds the fences", () => {
    expect(fences.length).toBeGreaterThan(5);
  });

  for (const f of fences)
    it(`${f.file}:${f.line} validates`, () => {
      const result = validateManifestDocuments(documentsFor(f));
      expect(
        result.errors.map((e) => `${e.code} at ${e.path}: ${e.message}`),
      ).toEqual([]);
    });
});
