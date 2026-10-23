// The SDK API surface test generator (SP-35.2, P0-42 family `api`).
//
//   pnpm gen api            # (re)write the three generated surface tests
//   pnpm gen api --check    # regenerate in memory; exit 1 if any differs
//
// Input: conformance/parity/api.json. Every concept row an SDK lists becomes an assertion in that
// SDK's own test (Node, React, Python here; Swift, Kotlin and Godot follow in SP-35.3), and every
// `removed` row becomes an assertion that the name is absent. A symbol that does not exist today
// (`planned` with no `spelling`) and a `reserved` concept are skipped: the spelling is not yet
// fixed by any code. A `planned` entry with a `spelling` asserts the SDK's CURRENT name.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_PATH = "conformance/parity/api.json";

export const NODE_OUT = "packages/sdk-node/test/apiSurface.generated.test.ts";
export const REACT_OUT = "packages/sdk-react/test/apiSurface.generated.test.ts";
export const PYTHON_OUT = "sdks/python/tests/test_api_surface.py";

type Sdk = "node" | "react" | "python";

interface SdkEntry {
  spelling?: string;
  path?: string;
  reason?: string;
  shape?: string;
  sdkOnly?: boolean;
  planned?: string;
}
interface Concept {
  id: string;
  kind: string;
  reserved?: string;
  sdks?: Record<string, SdkEntry>;
}
interface Removed {
  sdk: string;
  from: string;
}
export interface Api {
  concepts: Concept[];
  removed: Removed[];
}

/** One required symbol. `ns` is the namespace (first id segment), `name` the SDK's own spelling. */
interface Row {
  id: string;
  kind: string;
  ns: string;
  /** For `config.setting.*`: the handle's member. */
  handle: boolean;
  name: string;
  path?: string;
  entry: SdkEntry;
}

const camelToSnake = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function rowsFor(api: Api, sdk: Sdk): Row[] {
  const out: Row[] = [];
  for (const c of api.concepts) {
    const entry = c.sdks?.[sdk];
    if (!entry || c.reserved) continue;
    // Absent today: the symbol is added by the package named in `planned`.
    if (entry.planned && !entry.spelling) continue;
    const segs = c.id.split(".");
    let ns = segs[0]!;
    let leaf = segs[segs.length - 1]!;
    const handle =
      segs[0] === "config" && segs[1] === "setting" && segs.length === 3;
    if (entry.spelling) {
      const sp = entry.spelling;
      const dot = /^([A-Za-z]+)\.([A-Za-z_]+)$/.exec(sp);
      if (dot && dot[1] !== "") {
        ns = dot[1]!;
        leaf = dot[2]!;
      } else leaf = sp;
    } else if (sdk === "python") leaf = camelToSnake(leaf);
    out.push({
      id: c.id,
      kind: c.kind,
      ns,
      handle,
      name: leaf,
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      entry,
    });
  }
  return out;
}

const q = (s: string): string => JSON.stringify(s);
const BANNER = (c: string): string =>
  `${c} GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with \`pnpm gen api\`.`;

// ── Node ────────────────────────────────────────────────────────────────────────────────────────

const NODE_CLASS: Record<string, string> = {
  client: "PolarisKeyClient",
  config: "ConfigClient",
  license: "LicenseClient",
  identity: "IdentityClient",
};

function typePath(root: string, path: string): string {
  return path
    .split(".")
    .reduce(
      (t, seg, i) =>
        i === 0 ? `${t}[${q(seg)}]` : `NonNullable<${t}>[${q(seg)}]`,
      root,
    );
}

function renderNode(api: Api): string {
  const lines: string[] = [];
  const types: string[] = [];
  for (const r of rowsFor(api, "node")) {
    if (r.kind === "option") {
      types.push(typePath("Options", r.path ?? r.name));
    } else if (r.id === "client.create") {
      lines.push(
        `it(${q(r.id)}, () => expect(typeof PolarisKeyClient.create).toBe("function"));`,
      );
    } else if (r.id === "events") {
      types.push(`PolarisKeyClient["events"]`);
    } else if (r.handle) {
      types.push(`ConfigSetting[${q(r.name)}]`);
    } else if (NODE_CLASS[r.ns]) {
      lines.push(
        `it(${q(r.id)}, () => expect(${q(r.name)} in ${NODE_CLASS[r.ns]}.prototype).toBe(true));`,
      );
    }
  }
  for (const rm of api.removed.filter((x) => x.sdk === "node")) {
    const m = /^([A-Za-z]+)\.([A-Za-z]+)$/.exec(rm.from);
    const cls =
      m &&
      (NODE_CLASS[m[1]!] ??
        (Object.values(NODE_CLASS).includes(m[1]!) ? m[1] : undefined));
    if (!cls) continue;
    lines.push(
      `it(${q(`removed: ${rm.from}`)}, () => expect(${q(m![2]!)} in ${cls}.prototype).toBe(false));`,
    );
  }
  return [
    BANNER("//"),
    `import { expect, it } from "vitest";`,
    `import {`,
    `  ConfigClient,`,
    `  IdentityClient,`,
    `  LicenseClient,`,
    `  PolarisKeyClient,`,
    `  type ConfigSetting,`,
    `  type PolarisKeyClientOptions,`,
    `} from "../src/index.js";`,
    ``,
    `type Options = PolarisKeyClientOptions;`,
    `// Type-level: each member exists (tsc fails when one is renamed away).`,
    `export type Surface = [${types.join(", ")}];`,
    ``,
    ...lines,
  ].join("\n");
}

// ── React ───────────────────────────────────────────────────────────────────────────────────────

function renderReact(api: Api): string {
  const lines: string[] = [];
  const types: string[] = [];
  const hooks = new Set<string>();
  for (const r of rowsFor(api, "react")) {
    const sp = r.entry.spelling ?? "";
    if (sp.includes(" ")) continue; // prose, not a symbol
    if (r.kind === "option") {
      // An option an adapter (not the Provider config) takes is out of this file's reach.
      if (r.entry.planned || (r.entry.reason && !r.entry.sdkOnly)) continue;
      types.push(typePath("PolarisKeyConfig", r.path ?? r.name));
      continue;
    }
    const hook = /^(use[A-Za-z]+)\(\)\.([A-Za-z]+)$/.exec(sp);
    if (hook) {
      hooks.add(hook[1]!);
      types.push(`ReturnType<typeof ${hook[1]}>[${q(hook[2]!)}]`);
    } else if (/^(use|Polaris)[A-Za-z]+$/.test(sp)) {
      hooks.add(sp);
      lines.push(
        `it(${q(r.id)}, () => expect(typeof ${sp}).toBe("function"));`,
      );
    } else if (r.handle) {
      types.push(`ReturnType<typeof useConfigSetting>[${q(r.name)}]`);
    } else if (r.ns === "config") {
      types.push(`ReturnType<typeof useManagedConfig>[${q(r.name)}]`);
    } else if (r.id === "identity.signOut") {
      types.push(`ReturnType<typeof usePolarisAuth>["signOut"]`);
    }
  }
  const imports = new Set([
    ...hooks,
    "useConfigSetting",
    "useManagedConfig",
    "usePolarisAuth",
  ]);
  return [
    BANNER("//"),
    `import { expect, it } from "vitest";`,
    `import {`,
    ...[...imports].sort().map((n) => `  ${n},`),
    `  type PolarisKeyConfig,`,
    `} from "../src/index.js";`,
    ``,
    `// Type-level: each hook member and config key exists.`,
    `export type Surface = [${types.join(", ")}];`,
    ``,
    ...lines,
  ].join("\n");
}

// ── Python ──────────────────────────────────────────────────────────────────────────────────────

const PY_CLASS: Record<string, string> = {
  client: "PolarisKeyClient",
  config: "ConfigClient",
  license: "LicenseClient",
  identity: "IdentityClient",
};

function renderPython(api: Api): string {
  const attrs: string[] = [];
  const params: string[] = [];
  for (const r of rowsFor(api, "python")) {
    if (r.kind === "option") {
      // Dotted paths: the first segment is the constructor parameter.
      params.push(`(${q(r.id)}, ${q((r.path ?? r.name).split(".")[0]!)})`);
    } else if (r.id === "events") {
      continue; // an instance attribute set in __init__
    } else if (r.handle) {
      attrs.push(`(${q(r.id)}, "ConfigSetting", ${q(r.name)})`);
    } else if (PY_CLASS[r.ns]) {
      attrs.push(`(${q(r.id)}, ${q(PY_CLASS[r.ns]!)}, ${q(r.name)})`);
    }
  }
  const gone: string[] = [];
  for (const rm of api.removed.filter((x) => x.sdk === "python")) {
    const m = /^([A-Za-z]+)\.([a-z_]+)$/.exec(rm.from);
    if (m && PY_CLASS[m[1]!])
      gone.push(`(${q(rm.from)}, ${q(PY_CLASS[m[1]!]!)}, ${q(m[2]!)})`);
  }
  const list = (n: string, xs: string[]): string =>
    xs.length === 0
      ? ""
      : `${n} = [\n${xs.map((a) => `    ${a},`).join("\n")}\n]`;
  return `${BANNER("#")}
import inspect

import pytest

from polaris_key.client import PolarisKeyClient
from polaris_key.config.client import ConfigClient, ConfigSetting
from polaris_key.identity.client import IdentityClient
from polaris_key.license.client import LicenseClient

CLASSES = {
    "PolarisKeyClient": PolarisKeyClient,
    "ConfigClient": ConfigClient,
    "ConfigSetting": ConfigSetting,
    "IdentityClient": IdentityClient,
    "LicenseClient": LicenseClient,
}

${list("ATTRS", attrs)}
${list("OPTION_PARAMS", params)}
${list("REMOVED", gone)}

@pytest.mark.parametrize("concept,cls,name", ATTRS)
def test_present(concept, cls, name):
    assert hasattr(CLASSES[cls], name), concept


@pytest.mark.parametrize("concept,name", OPTION_PARAMS)
def test_option(concept, name):
    assert name in inspect.signature(PolarisKeyClient.__init__).parameters, concept
${
  gone.length === 0
    ? ""
    : `

@pytest.mark.parametrize("concept,cls,name", REMOVED)
def test_removed(concept, cls, name):
    assert not hasattr(CLASSES[cls], name), concept
`
}`;
}

// ── driver ──────────────────────────────────────────────────────────────────────────────────────

export function loadApi(root = ROOT): Api {
  return JSON.parse(readFileSync(join(root, API_PATH), "utf8")) as Api;
}

export async function renderAll(api: Api): Promise<Map<string, string>> {
  const fmt = (s: string) => prettier.format(s, { parser: "typescript" });
  return new Map([
    [NODE_OUT, await fmt(renderNode(api))],
    [REACT_OUT, await fmt(renderReact(api))],
    [PYTHON_OUT, renderPython(api)],
  ]);
}

/** Write (or, with `check`, compare) the outputs. Returns the stale paths. */
export async function run(opts: {
  check: boolean;
  root?: string;
  api?: Api;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const stale: string[] = [];
  for (const [path, content] of await renderAll(opts.api ?? loadApi(root))) {
    const abs = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(path);
    if (opts.check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return stale;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const stale = await run({ check });
  if (check) {
    for (const p of stale) console.error(`stale: ${p} — run \`pnpm gen api\``);
    if (stale.length > 0) process.exit(1);
    console.log("up to date: the generated API surface tests");
    return;
  }
  for (const p of stale) console.log(`wrote ${p}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
