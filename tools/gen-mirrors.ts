// The monorepo's schema-mirror generator. The renderers live in @polaris-key/cli
// (packages/cli/src/mirrors.ts) so `pkey mirror` gives adopters the same output outside the
// monorepo; this front end keeps the committed samples and `pnpm gen mirrors`.
//
//   tsx tools/gen-mirrors.ts --catalog <path> --out-dir <dir> --lang ts,python,swift,gdscript,kotlin
//                            [--kotlin-package com.example.catalog]
//   tsx tools/gen-mirrors.ts ... --check     # CI drift guard (exit 1 if stale)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProductCatalog } from "@polaris-key/catalog";
import {
  DEFAULT_KOTLIN_PACKAGE,
  MIRROR_FILENAME,
  renderMirror,
  type MirrorLang,
} from "@polaris-key/cli/mirrors";

export {
  DEFAULT_KOTLIN_PACKAGE,
  gdStr,
  gdValue,
  ktStr,
  renderGdscript,
  renderKotlin,
  renderPython,
  renderSwift,
  renderTs,
  sortedJson,
  settingPolicies,
  type SettingPolicy,
} from "@polaris-key/cli/mirrors";

type Lang = MirrorLang;
const RENDER: Record<Lang, (c: ProductCatalog) => string> = {
  ts: (c) => renderMirror("ts", c),
  python: (c) => renderMirror("python", c),
  swift: (c) => renderMirror("swift", c),
  gdscript: (c) => renderMirror("gdscript", c),
  kotlin: (c) =>
    renderMirror("kotlin", c, {
      kotlinPackage: arg("--kotlin-package") ?? DEFAULT_KOTLIN_PACKAGE,
    }),
};
const FILENAME = MIRROR_FILENAME;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function writeIfNeeded(path: string, content: string, check: boolean): boolean {
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === content) return false;
  if (check) {
    console.error(`stale: ${path} — run \`pnpm gen mirrors\``);
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
  return false;
}

async function main(): Promise<void> {
  const catalogPath = arg("--catalog");
  const outDir = arg("--out-dir");
  const langs = (arg("--lang") ?? "ts,python,swift").split(",") as Lang[];
  const check = process.argv.includes("--check");
  if (!catalogPath || !outDir) {
    console.error(
      "usage: gen-mirrors --catalog <path> --out-dir <dir> [--lang ts,python,swift,gdscript,kotlin] [--kotlin-package <pkg>] [--check]",
    );
    process.exit(2);
  }
  const catalog = JSON.parse(
    readFileSync(catalogPath, "utf8"),
  ) as ProductCatalog;
  let stale = 0;
  for (const lang of langs) {
    const render = RENDER[lang];
    if (!render) {
      console.error(`unknown lang: ${lang}`);
      process.exit(2);
    }
    stale += Number(
      writeIfNeeded(join(outDir, FILENAME[lang]), render(catalog), check),
    );
  }
  if (check && stale > 0) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
