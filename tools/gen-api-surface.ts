// The SDK API surface test generator (SP-35.2, P0-42 family `api`).
//
//   pnpm gen api            # (re)write the three generated surface tests
//   pnpm gen api --check    # regenerate in memory; exit 1 if any differs
//
// Input: conformance/parity/api.json. Every concept row an SDK lists becomes an assertion in that
// SDK's own test (Node, React, Python, Swift, Kotlin and Godot), and every
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
export const SWIFT_OUT =
  "sdks/swift/Tests/PolarisKeyTests/APISurface.generated.swift";
export const KOTLIN_OUT =
  "sdks/kotlin/sdk/src/test/kotlin/polaris/generated/ApiSurface.kt";
export const GODOT_OUT = "sdks/godot/tests/suite_api_surface.gd";

type Sdk = "node" | "react" | "python" | "swift" | "kotlin" | "godot";

interface SdkEntry {
  spelling?: string;
  path?: string;
  reason?: string;
  shape?: string;
  labels?: string[];
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
    } else if (sdk === "python" || sdk === "godot") leaf = camelToSnake(leaf);
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
  entitlements: "EntitlementsClient",
  identity: "IdentityClient",
  cloudConnect: "CloudConnect",
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
    } else if (r.id === "identity.signIn.start") {
      // `signIn` is a getter on the client; `start` is its one verb.
      lines.push(
        `it(${q(r.id)}, () => expect("signIn" in IdentityClient.prototype).toBe(true));`,
      );
    } else if (r.id.startsWith("identity.signIn.session.")) {
      // The sessions `signIn.start` answers: device code (wait, reopen, cancel), redirect (complete, cancel).
      const cls =
        r.name === "complete" ? "RedirectSession" : "DeviceCodeSession";
      lines.push(
        `it(${q(r.id)}, () => expect(${q(r.name)} in ${cls}.prototype).toBe(true));`,
      );
    } else if (r.id.startsWith("identity.choice.")) {
      // The licence choice an app shows itself: licenses, devices, complete, cancel live on `identity.choice`.
      lines.push(
        `it(${q(r.id)}, () => expect(${q(r.name)} in ChoiceClient.prototype).toBe(true));`,
      );
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
    `  ChoiceClient,`,
    `  CloudConnect,`,
    `  ConfigClient,`,
    `  DeviceCodeSession,`,
    `  EntitlementsClient,`,
    `  IdentityClient,`,
    `  LicenseClient,`,
    `  PolarisKeyClient,`,
    `  RedirectSession,`,
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
  entitlements: "EntitlementsClient",
  identity: "IdentityClient",
  cloudConnect: "CloudConnect",
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
    } else if (r.id === "identity.signIn") {
      // sign_in is a property on the identity client; start is its one verb.
      attrs.push(`(${q(r.id)}, "IdentityClient", "sign_in")`);
    } else if (r.id === "identity.signIn.start") {
      attrs.push(`(${q(r.id)}, "SignInNamespace", "start")`);
    } else if (r.id.startsWith("identity.signIn.session.")) {
      attrs.push(`(${q(r.id)}, "SignInSession", ${q(r.name)})`);
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
from polaris_key.connect.cloud_connect import CloudConnect
from polaris_key.identity.client import IdentityClient
from polaris_key.identity.sign_in import SignInNamespace, SignInSession
from polaris_key.license.client import LicenseClient
from polaris_key.license.entitlements import EntitlementsClient

CLASSES = {
    "PolarisKeyClient": PolarisKeyClient,
    "ConfigClient": ConfigClient,
    "ConfigSetting": ConfigSetting,
    "IdentityClient": IdentityClient,
    "SignInNamespace": SignInNamespace,
    "SignInSession": SignInSession,
    "LicenseClient": LicenseClient,
    "EntitlementsClient": EntitlementsClient,
    "CloudConnect": CloudConnect,
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

// ── Swift ───────────────────────────────────────────────────────────────────────────────────────

const SWIFT_TYPE: Record<string, string> = {
  client: "PolarisKeyClient",
  config: "ConfigClient",
  license: "LicenseClient",
  entitlements: "EntitlementsClient",
  identity: "IdentityClient",
  events: "PolarisKeyClient",
  devices: "DevicesClient",
  release: "ReleaseClient",
  update: "UpdateClient",
  distribution: "DistributionClient",
  commerce: "CommerceClient",
  packs: "PacksClient",
  cloudConnect: "CloudConnect",
  SignInNamespace: "SignInNamespace",
  SignInSession: "SignInSession",
  ChoiceNamespace: "ChoiceNamespace",
};
/** Rows with no compile-only reference: actor-isolated properties have no key path, and an unapplied generic method cannot infer `T`. */
const SWIFT_UNASSERTED = new Set([
  "identity.useLicenseChoice", // a @MainActor model class (PolarisKeyUICore), not a member of the umbrella
  "commerce.listening",
  "commerce.products",
  "config.decode",
]);
/** The handle's async properties: no key path reaches them, so each is read inside an async closure. */
const SWIFT_ASYNC_HANDLE = new Set([
  "config.setting.value",
  "config.setting.source",
  "config.setting.locked",
  "config.setting.visibility",
]);
/**
 * Synchronous methods on the client actor: Swift 6.3 refuses an unapplied reference to one from a
 * nonisolated context, so each is called (all-default arguments) inside an async closure that is never run.
 */
const SWIFT_ACTOR_SYNC = new Set([
  "client.startRefresh",
  "client.close",
  "client.syncOnForeground",
  "client.stopForegroundSync",
  "commerce.startTransactionUpdates",
  "commerce.stopTransactionUpdates",
]);
const SWIFT_OPTION_HOLDER: Record<string, string> = {
  core: "CoreOptions",
  pinnedReleaseKeys: "PolarisKeyClientOptions",
};

/** An argument-label suffix the way Swift writes an unapplied reference: `(_:default:)`. */
function swiftLabels(labels: string[] | undefined): string {
  return labels ? `(${labels.map((l) => `${l}:`).join("")})` : "";
}

function renderSwift(api: Api): string {
  const lines: string[] = [];
  for (const r of rowsFor(api, "swift")) {
    const ref = `${r.name}${swiftLabels(r.entry.labels)}`;
    if (SWIFT_UNASSERTED.has(r.id)) continue;
    if (r.kind === "option") {
      const holder =
        r.path !== undefined
          ? (SWIFT_OPTION_HOLDER[r.path.split(".")[0]!] ?? "CoreOptions")
          : (SWIFT_OPTION_HOLDER[r.name] ?? "CoreOptions");
      lines.push(`_ = \\${holder}.${r.name}  // ${r.id}`);
    } else if (SWIFT_ACTOR_SYNC.has(r.id)) {
      lines.push(
        `_ = { (c: ${SWIFT_TYPE[r.ns] ?? "PolarisKeyClient"}) async in await c.${r.name}() }  // ${r.id}`,
      );
    } else if (r.handle && SWIFT_ASYNC_HANDLE.has(r.id)) {
      lines.push(
        `_ = { (s: ConfigSetting) async in _ = await s.${r.name} }  // ${r.id}`,
      );
    } else if (r.handle) {
      lines.push(
        r.entry.shape === "property"
          ? `_ = \\ConfigSetting.${r.name}  // ${r.id}`
          : `_ = ConfigSetting.${ref}  // ${r.id}`,
      );
    } else if (r.kind === "stream" || r.entry.shape === "property") {
      lines.push(
        `_ = \\${SWIFT_TYPE[r.ns] ?? "PolarisKeyClient"}.${r.name}  // ${r.id}`,
      );
    } else if (SWIFT_TYPE[r.ns]) {
      lines.push(`_ = ${SWIFT_TYPE[r.ns]}.${ref}  // ${r.id}`);
    }
  }
  return [
    BANNER("//"),
    `import PolarisKey`,
    `import PolarisKeyPacks`,
    `import PolarisKeyUpdate`,
    ``,
    `/// Compile-only and never called: a renamed or removed symbol fails the test target's build.`,
    `func apiSurface() async {`,
    ...lines.map((l) => `    ${l}`),
    `}`,
    ``,
  ].join("\n");
}

// ── Kotlin ──────────────────────────────────────────────────────────────────────────────────────

const KOTLIN_TYPE: Record<string, string> = {
  client: "PolarisKeyClient",
  config: "ConfigClient",
  license: "LicenseClient",
  entitlements: "EntitlementsClient",
  identity: "IdentityClient",
  SignInNamespace: "SignInNamespace",
  SignInSession: "SignInSession",
  ChoiceClient: "ChoiceClient",
  events: "PolarisKeyClient",
  devices: "PolarisKeyClient.DevicesFacet",
  release: "ReleaseClient",
  distribution: "DistributionClient",
  update: "UpdateClient",
  commerce: "CommerceClient",
  backend: "BackendClient",
  packs: "PacksClient",
  presentation: "PresentationSource",
  cloudConnect: "CloudConnect",
  cloudSync: "CloudSyncClient",
};
/** Rows built by the Android and Desktop bootstrap objects (PolarisKeyAndroid, PolarisKeyDesktop): not on the client, and the Android module is not in the JVM build. */
const KOTLIN_UNASSERTED = new Set([
  "client.client",
  "client.playPacks",
  "client.flavor",
]);
/** Extension functions on the client, declared top-level in the sdk package (Boot.kt). */
const KOTLIN_EXTENSION = new Set(["client.boot", "client.bootHost"]);
/** Entry points that live on the client's companion. */
const KOTLIN_COMPANION = new Set([
  "client.create",
  "client.createLocal",
  "client.createFromBundle",
]);
const KOTLIN_OPTION_HOLDER: Record<string, string> = {
  core: "CoreOptions",
  update: "UpdateClientOptions",
  cloudSync: "CloudSyncHostOptions",
};

function renderKotlin(api: Api): string {
  const lines: string[] = [];
  for (const r of rowsFor(api, "kotlin")) {
    if (KOTLIN_UNASSERTED.has(r.id)) continue;
    if (r.kind === "option") {
      const holder =
        r.path !== undefined
          ? (KOTLIN_OPTION_HOLDER[r.path.split(".")[0]!] ?? "CoreOptions")
          : "CoreOptions";
      lines.push(`${holder}::${r.name}  // ${r.id}`);
    } else if (KOTLIN_COMPANION.has(r.id)) {
      lines.push(`PolarisKeyClient.Companion::${r.name}  // ${r.id}`);
    } else if (KOTLIN_EXTENSION.has(r.id)) {
      lines.push(`PolarisKeyClient::${r.name}  // ${r.id}`); // an extension function
    } else if (r.handle) {
      continue; // Kotlin has no setting handle until U-07 (a StateFlow today)
    } else if (KOTLIN_TYPE[r.ns]) {
      lines.push(`${KOTLIN_TYPE[r.ns]}::${r.name}  // ${r.id}`);
    }
  }
  return [
    BANNER("//"),
    `@file:Suppress("unused", "UNUSED_EXPRESSION")`,
    ``,
    `package polaris.generated`,
    ``,
    `import im.plrs.key.config.ConfigClient`,
    `import im.plrs.key.core.CoreOptions`,
    `import im.plrs.key.core.PresentationSource`,
    `import im.plrs.key.identity.ChoiceClient`,
    `import im.plrs.key.identity.IdentityClient`,
    `import im.plrs.key.identity.SignInNamespace`,
    `import im.plrs.key.identity.SignInSession`,
    `import im.plrs.key.license.EntitlementsClient`,
    `import im.plrs.key.license.LicenseClient`,
    `import im.plrs.key.packs.PacksClient`,
    `import im.plrs.key.release.DistributionClient`,
    `import im.plrs.key.release.ReleaseClient`,
    `import im.plrs.key.sdk.BackendClient`,
    `import im.plrs.key.sdk.CloudConnect`,
    `import im.plrs.key.sdk.CloudSyncClient`,
    `import im.plrs.key.sdk.CloudSyncHostOptions`,
    `import im.plrs.key.sdk.CommerceClient`,
    `import im.plrs.key.sdk.PolarisKeyClient`,
    ...[
      ...new Set(
        rowsFor(api, "kotlin")
          .filter((r) => KOTLIN_EXTENSION.has(r.id))
          .map((r) => r.name),
      ),
    ]
      .sort()
      .map((n) => `import im.plrs.key.sdk.${n}`),
    `import im.plrs.key.update.UpdateClient`,
    `import im.plrs.key.update.UpdateClientOptions`,
    ``,
    `/** Compile-only and never called: a renamed or removed symbol fails the test source set's build. */`,
    `internal suspend fun apiSurface() {`,
    ...lines.map((l) => `    ${l}`),
    `}`,
    ``,
  ].join("\n");
}

// ── Godot ───────────────────────────────────────────────────────────────────────────────────────

const GODOT_SCRIPT: Record<string, string> = {
  client: `SDK`,
  PolarisKey: `SDK`,
  events: `SDK`,
  config: `"res://addons/polaris_key/services/config.gd"`,
  license: `"res://addons/polaris_key/services/license.gd"`,
  entitlements: `"res://addons/polaris_key/services/entitlements.gd"`,
  identity: `"res://addons/polaris_key/services/identity.gd"`,
  PKeySignInNamespace: `"res://addons/polaris_key/services/identity/sign_in_namespace.gd"`,
  PKeySignInSession: `"res://addons/polaris_key/services/identity/sign_in_session.gd"`,
  devices: `"res://addons/polaris_key/services/devices.gd"`,
  release: `"res://addons/polaris_key/services/release.gd"`,
  distribution: `"res://addons/polaris_key/services/distribution.gd"`,
  update: `"res://addons/polaris_key/services/update.gd"`,
  commerce: `"res://addons/polaris_key/services/commerce.gd"`,
  backend: `"res://addons/polaris_key/services/backend.gd"`,
  packs: `"res://addons/polaris_key/services/packs.gd"`,
  presentation: `"res://addons/polaris_key/core/presentation.gd"`,
  options: `"res://addons/polaris_key/core/options.gd"`,
};
const GODOT_HANDLE = `"res://addons/polaris_key/services/config/setting.gd"`;
const GODOT_OPTIONS = `"res://addons/polaris_key/core/options.gd"`;

function renderGodot(api: Api): string {
  const rows: string[] = [];
  for (const r of rowsFor(api, "godot")) {
    let script: string | undefined;
    let how: string;
    if (r.kind === "option") {
      script = GODOT_OPTIONS;
      how = "property";
    } else if (r.handle) {
      script = GODOT_HANDLE;
      how =
        r.entry.shape === "signal"
          ? "signal"
          : r.kind === "property"
            ? "property"
            : "method";
    } else {
      script = GODOT_SCRIPT[r.ns];
      how =
        r.entry.shape === "signal"
          ? "signal"
          : r.entry.shape === "property"
            ? "property"
            : "method";
    }
    if (script === undefined) continue;
    rows.push(`\t[${q(r.id)}, ${script}, ${q(how)}, ${q(r.name)}],`);
  }
  const gone: string[] = [];
  for (const rm of api.removed.filter((x) => x.sdk === "godot")) {
    const m = /^([A-Za-z]+)\.([a-z_]+)$/.exec(rm.from);
    const script = m && GODOT_SCRIPT[m[1]!];
    if (script) gone.push(`\t[${q(rm.from)}, ${script}, ${q(m![2]!)}],`);
  }
  return `extends RefCounted
${BANNER("#")}
# The api_surface suite (SP-35.3): every api.json row the Godot SDK ships exists under its own name,
# checked on the scripts (methods, properties, signals), and every \`removed\` name is gone.

const SDK := preload("res://addons/polaris_key/polaris_key.gd")

## [concept, script, kind, name]
const ROWS := [
${rows.join("\n")}
]

## [concept, script, name]
const REMOVED := [
${gone.join("\n")}
]


func _names(script: Script, kind: String) -> PackedStringArray:
	var list: Array[Dictionary]
	match kind:
		"method":
			list = script.get_script_method_list()
		"signal":
			list = script.get_script_signal_list()
		_:
			list = script.get_script_property_list()
	var out := PackedStringArray()
	for d in list:
		out.append(String(d["name"]))
	return out


func run(t: PKeyTestContext, _args: PackedStringArray) -> bool:
	for row in ROWS:
		var script: Script = load(row[1]) if row[1] is String else row[1]
		t.check("%s: %s %s" % [row[0], row[2], row[3]], script != null and _names(script, row[2]).has(row[3]), str(row[1]))
	for row in REMOVED:
		var script: Script = load(row[1]) if row[1] is String else row[1]
		var present := false
		for kind in ["method", "signal", "property"]:
			present = present or _names(script, kind).has(row[2])
		t.check("removed: %s" % row[0], not present, str(row[1]))
	return true
`;
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
    [SWIFT_OUT, renderSwift(api)],
    [KOTLIN_OUT, renderKotlin(api)],
    [GODOT_OUT, renderGodot(api)],
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
