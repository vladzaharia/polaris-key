/**
 * `renderUsage`: the code that uses one Polaris Key feature, per SDK and lane (SP-33a). It is the
 * one source of per-feature snippets: the console's Integration page, `pkey sdk add`, the docs'
 * generated blocks and the goldens under `test/fixtures/integration/` all read it.
 *
 * Every block imports the product's generated configuration (`pkey sdk --write`, rendered by
 * `renderSdkConfig`), so a slug, base URL or trust pin never appears in a usage snippet. The
 * TypeScript and Python blocks are compiled in the docs snippet lanes; the others render from the
 * same table and wait for their lane (SP-33b).
 *
 * Lanes: `kit` is the drop-in screens, `library` is your own UI on the SDK, `server` is a backend
 * that verifies a licence a client sends (a server has no screens). A combination the SDK cannot
 * do today renders `null`, never a guess.
 */

import type { SdkId } from "./fit.js";

export const INTEGRATION_FEATURES = [
  "licensing",
  "config",
  "identity",
  "update",
  "packs",
  "sync",
  "commerce",
] as const;
export type IntegrationFeature = (typeof INTEGRATION_FEATURES)[number];

export const INTEGRATION_LANES = ["kit", "library", "server"] as const;
export type IntegrationLane = (typeof INTEGRATION_LANES)[number];

/** The real product's names a snippet shows; defaults are the docs' example product. */
export interface UsageContext {
  /** The first boolean entitlement the product grants. */
  entitlement: string;
  /** A managed config key and the fallback the app carries for it. */
  configKey: string;
  configFallback: string | number | boolean;
  /** A secret key, and a mint recipe id. */
  secretKey: string;
  mintRecipe: string;
  /** A content pack id (`.pkey/release` packs). */
  packId: string;
  /** The licence flag a store purchase grants. */
  commerceFlag: string;
  /** The app's own command name, for a CLI. */
  appName: string;
  /** The app's own version. */
  appVersion: string;
}

export const DEFAULT_USAGE_CONTEXT: UsageContext = {
  entitlement: "pro",
  configKey: "audio.musicVolume",
  configFallback: 0.8,
  secretKey: "api.token",
  mintRecipe: "cdn",
  packId: "hd-textures",
  commerceFlag: "dlc.hd",
  appName: "tidewater",
  appVersion: "1.4.2",
};

export type UsageLanguage =
  | "ts"
  | "tsx"
  | "python"
  | "swift"
  | "kotlin"
  | "gdscript";

export interface IntegrationBlock {
  /** Stable: `<feature>.<sdk>.<lane>[.<framework>]`. */
  id: string;
  feature: IntegrationFeature;
  sdk: SdkId;
  lane: IntegrationLane;
  framework: string | null;
  title: string;
  /** The file the code goes into. */
  filename: string;
  language: UsageLanguage;
  code: string;
  /** Where the docs explain it: a site-absolute path ending in a slash. */
  docs: string;
  /**
   * Whether the block runs today. `planned` renders a block whose service has no client yet (Cloud
   * Sync syncs nothing until its routes ship), so a page never promises it.
   */
  status: "available" | "planned";
  /** Compiled in this repository's docs lane (TypeScript and Python). */
  compiled: boolean;
}

export const FEATURE_DOCS: Record<IntegrationFeature, string> = {
  licensing: "/docs/features/licensing/add-licensing/",
  config: "/docs/features/managed-config/add-config/",
  identity: "/docs/features/sign-in/add-sign-in/",
  update: "/docs/features/ship-builds/updates/",
  packs: "/docs/features/ship-builds/packs/",
  sync: "/docs/features/cloud-sync/",
  commerce: "/docs/features/commerce/",
};

/** The docs page for an SDK's own-UI lane and for its kit lane. */
export const SDK_LIBRARY_DOCS: Record<SdkId, string> = {
  node: "/docs/build/sdks/node/your-own-ui/",
  react: "/docs/build/sdks/react/your-own-ui/",
  python: "/docs/build/sdks/python/your-own-ui/",
  swift: "/docs/build/sdks/swift/your-own-ui/",
  kotlin: "/docs/build/sdks/kotlin/your-own-ui/",
  godot: "/docs/build/sdks/godot/your-own-ui/",
};
export const SDK_KIT_DOCS: Record<SdkId, string> = {
  node: "/docs/build/ui/frameworks/terminal-node/",
  react: "/docs/build/ui/frameworks/react/",
  python: "/docs/build/ui/frameworks/terminal-python/",
  swift: "/docs/build/ui/frameworks/swiftui/",
  kotlin: "/docs/build/ui/frameworks/compose/",
  godot: "/docs/build/ui/frameworks/godot/",
};
const SERVER_DOCS = "/docs/features/licensing/server-verification/";

const q = (v: string | number | boolean): string => JSON.stringify(v);
const py = (v: string | number | boolean): string =>
  typeof v === "boolean" ? (v ? "True" : "False") : JSON.stringify(v);
/** A TypeScript type for a fallback literal, so `setting<T>` is exact. */
const tsType = (v: string | number | boolean): string => typeof v;

type Maker = (c: UsageContext) => {
  title: string;
  filename: string;
  language: UsageLanguage;
  code: string;
  status?: "available" | "planned";
  compiled?: boolean;
};

const lines = (...l: string[]): string => l.join("\n");

// ── Node ─────────────────────────────────────────────────────────────────────────────────────

const NODE_HEAD = (c: UsageContext, imports = "PolarisKeyClient"): string =>
  lines(
    `import { ${imports} } from "@polaris-key/node";`,
    `import { polarisConfig } from "./polaris.config.js";`,
    ``,
    `const client = await PolarisKeyClient.create({`,
    `  ...polarisConfig,`,
    `  version: ${q(c.appVersion)}, // your app's version`,
    `});`,
  );

const NODE_LIBRARY: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Gate on the licence",
    filename: "licence.ts",
    language: "ts",
    code: lines(
      NODE_HEAD(c, "copy, PolarisKeyClient"),
      ``,
      `export async function activate(key: string): Promise<string | null> {`,
      `  const r = await client.license.activateWithKey(key);`,
      `  return r.kind === "ok" ? null : copy.activation(r.kind, { code: r.code });`,
      `}`,
      ``,
      `await client.sync();`,
      `if (!client.isLicensed()) console.log(copy.message(client.status().status));`,
      `const pro = client.license.isEntitled(${q(c.entitlement)});`,
      `console.log(pro);`,
    ),
  }),
  config: (c) => ({
    title: "Read managed config",
    filename: "config.ts",
    language: "ts",
    code: lines(
      NODE_HEAD(c),
      ``,
      `await client.sync();`,
      `const value = client.config.getConfig(${q(c.configKey)}, ${q(c.configFallback)});`,
      `const secret = client.config.getSecret(${q(c.secretKey)});`,
      `const minted = await client.config.mintToken(${q(c.mintRecipe)});`,
      `client.events.on("config", () => console.log("settings changed"));`,
      `console.log(value, secret, minted);`,
    ),
  }),
  identity: (c) => ({
    title: "Sign in in the browser",
    filename: "sign-in.ts",
    language: "ts",
    code: lines(
      NODE_HEAD(c),
      ``,
      `const result = await client.identity.signInWithBrowser({`,
      `  deviceName: ${q(`${c.appName} on this computer`)},`,
      `  onPrompt: (p) => console.log(p.userCode, p.verificationUri),`,
      `});`,
      `if (result.status === "ready") {`,
      `  const profile = client.license.getProfile();`,
      `  console.log(profile?.name, profile?.email);`,
      `}`,
    ),
  }),
  update: (c) => ({
    title: "Ask for an update",
    filename: "update.ts",
    language: "ts",
    code: lines(
      NODE_HEAD(c),
      ``,
      `const { decision } = await client.update.decide();`,
      `switch (decision.action) {`,
      `  case "binary":`,
      `  case "store":`,
      `  case "platform":`,
      `  case "code-ready":`,
      `    console.log(decision.release.version);`,
      `    break;`,
      `  case "blocked":`,
      `    console.log(decision.reason);`,
      `    break;`,
      `  default:`,
      `    break; // "none" or "packs"`,
      `}`,
    ),
  }),
  packs: (c) => ({
    title: "Install a content pack",
    filename: "packs.ts",
    language: "ts",
    code: lines(
      NODE_HEAD(c),
      ``,
      `client.update.packs.on((progress) => console.log(progress));`,
      `await client.update.packs.ensure([${q(c.packId)}]);`,
      `const dir = await client.update.packs.path(${q(c.packId)}); // null until it runs`,
      `console.log(dir);`,
    ),
  }),
  sync: (c) => ({
    title: "Save a setting the person keeps across devices",
    filename: "settings.ts",
    language: "ts",
    status: "planned",
    code: lines(
      NODE_HEAD(c),
      ``,
      `// A catalog key with a \`user.sync\` block roams once the person signs in. The routes ship`,
      `// later: today the value stays on this device.`,
      `const volume = client.config.setting<${tsType(c.configFallback)}>(${q(c.configKey)});`,
      `await volume.set(${q(c.configFallback)});`,
      `console.log(volume.get(${q(c.configFallback)}));`,
    ),
  }),
  commerce: (c) => ({
    title: "Claim a store purchase",
    filename: "commerce.ts",
    language: "ts",
    code: lines(
      NODE_HEAD(c),
      ``,
      `// Steam shown; claimAppStore and claimPlay take their store's fields.`,
      `export async function claim(ticketHex: string, dlcAppId: string) {`,
      `  const r = await client.commerce.claimSteam(ticketHex, dlcAppId);`,
      `  if (r.kind !== "ok") return r.message;`,
      `  return client.license.isEntitled(r.flag) ? "unlocked" : "pending";`,
      `}`,
      `console.log(client.license.isEntitled(${q(c.commerceFlag)}));`,
    ),
  }),
};

const NODE_KIT: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Mount the Polaris Key verbs in your CLI",
    filename: "cli.ts",
    language: "ts",
    code: lines(
      `import { Command } from "commander";`,
      `import { PolarisKeyClient } from "@polaris-key/node";`,
      `import { registerPolarisCommands } from "@polaris-key/node/cli";`,
      `import { polarisConfig } from "./polaris.config.js";`,
      ``,
      `const program = new Command(${q(c.appName)});`,
      `registerPolarisCommands(`,
      `  program,`,
      `  // Spread the generated config: a factory built from the slug and pins alone drops baseUrl`,
      `  // and the release keys, and its writes go to production.`,
      `  (o) => PolarisKeyClient.create({ ...polarisConfig, version: o.version }),`,
      `  {`,
      `    productSlug: polarisConfig.productSlug,`,
      `    version: ${q(c.appVersion)},`,
      `    pinnedKeys: polarisConfig.trust.pinnedKeys,`,
      `    expectedServices: polarisConfig.expectedServices,`,
      `  },`,
      `);`,
      `await program.parseAsync();`,
    ),
  }),
};

const NODE_ELECTRON: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: () => ({
    title: "Own the client in the main process",
    filename: "main.ts",
    language: "ts",
    code: lines(
      `import { app, ipcMain, safeStorage } from "electron";`,
      `import { PolarisKeyClient } from "@polaris-key/node";`,
      `import {`,
      `  exposePolarisBridge,`,
      `  SafeStorageStore,`,
      `} from "@polaris-key/node/electron";`,
      `import { polarisConfig } from "./polaris.config.js";`,
      ``,
      `// Do not await whenReady() at the top level: a CommonJS main has no top-level await.`,
      `void app.whenReady().then(async () => {`,
      `  const client = await PolarisKeyClient.create({`,
      `    ...polarisConfig,`,
      `    store: new SafeStorageStore(`,
      `      polarisConfig.productSlug,`,
      `      app.getPath("userData"),`,
      `      { safeStorage },`,
      `    ),`,
      `  });`,
      `  exposePolarisBridge(client, {`,
      `    ipcMain,`,
      `    allowSender: (e) => e.senderFrame?.url.startsWith("app://") === true,`,
      `  });`,
      `});`,
    ),
  }),
};

const NODE_SERVER: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Verify a licence your app sends",
    filename: "verify.ts",
    language: "ts",
    code: lines(
      `import { verifyLicenseDocument } from "@polaris-key/server";`,
      `import { polarisConfig } from "./polaris.config.js";`,
      ``,
      `// The app sends its cached licence document and its device id with the request.`,
      `export async function allowed(jws: string, deviceId: string): Promise<boolean> {`,
      `  const v = await verifyLicenseDocument(jws, {`,
      `    trust: polarisConfig.trust.pinnedKeys,`,
      `    product: polarisConfig.productSlug,`,
      `    deviceId,`,
      `  });`,
      `  return v.ok && v.usable && v.isEntitled(${q(c.entitlement)});`,
      `}`,
    ),
  }),
};

// ── React ────────────────────────────────────────────────────────────────────────────────────

const REACT_KIT: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: () => ({
    title: "Wrap the app in the gate",
    filename: "App.tsx",
    language: "tsx",
    code: lines(
      `import type { ReactNode } from "react";`,
      `import { PolarisKeyProvider } from "@polaris-key/react";`,
      `import { PolarisKeyGate } from "@polaris-key/react/kit";`,
      `import { polarisKey as productPolarisKey } from "./polaris.config";`,
      ``,
      `const polarisKey = { ...productPolarisKey, version: "1.4.2" }; // your app's version`,
      ``,
      `export function App({ children }: { children: ReactNode }) {`,
      `  return (`,
      `    <PolarisKeyProvider config={polarisKey}>`,
      `      <PolarisKeyGate>{children}</PolarisKeyGate>`,
      `    </PolarisKeyProvider>`,
      `  );`,
      `}`,
    ),
  }),
};

const REACT_LIBRARY: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Gate on the licence",
    filename: "Gate.tsx",
    language: "tsx",
    code: lines(
      `import type { ReactNode } from "react";`,
      `import { copyMessage, useEntitlement, useLicenseGate } from "@polaris-key/react";`,
      ``,
      `// Inside <PolarisKeyProvider config={polarisKey}>.`,
      `export function Gate({ children }: { children: ReactNode }) {`,
      `  const { screen, status } = useLicenseGate();`,
      `  if (screen === "loading") return <p role="status">Loading…</p>;`,
      `  if (screen === "ok" || screen === "not-applicable" || screen === "grace")`,
      `    return <>{children}</>;`,
      `  return <p role="alert">{copyMessage(status)}</p>;`,
      `}`,
      ``,
      `export function ProOnly({ children }: { children: ReactNode }) {`,
      `  return useEntitlement(${q(c.entitlement)}) ? <>{children}</> : <p>Upgrade to use this.</p>;`,
      `}`,
    ),
  }),
  config: (c) => ({
    title: "Read and set a managed setting",
    filename: "Volume.tsx",
    language: "tsx",
    code: lines(
      `import { useConfigSetting } from "@polaris-key/react";`,
      ``,
      `export function Volume() {`,
      `  const volume = useConfigSetting<${tsType(c.configFallback)}>(${q(c.configKey)}, ${q(c.configFallback)});`,
      `  return (`,
      `    <button disabled={volume.locked} onClick={() => void volume.set(${q(c.configFallback)})}>`,
      `      {String(volume.value)} ({volume.source})`,
      `    </button>`,
      `  );`,
      `}`,
    ),
  }),
  identity: () => ({
    title: "Sign in",
    filename: "SignIn.tsx",
    language: "tsx",
    code: lines(
      `import { describeError, usePolarisAuth } from "@polaris-key/react";`,
      ``,
      `export function SignIn() {`,
      `  const auth = usePolarisAuth();`,
      `  if (!auth.supportsOidcLogin) return null;`,
      `  return (`,
      `    <>`,
      `      <button disabled={auth.busy} onClick={() => void auth.signInWithOidc()}>`,
      `        Sign in`,
      `      </button>`,
      `      {auth.error && <p role="alert">{describeError(auth.error)}</p>}`,
      `    </>`,
      `  );`,
      `}`,
    ),
  }),
  update: () => ({
    title: "Show an update offer",
    filename: "UpdateBanner.tsx",
    language: "tsx",
    code: lines(
      `import { useUpdateDecision } from "@polaris-key/react";`,
      ``,
      `export function UpdateBanner() {`,
      `  const { decision, undismissable } = useUpdateDecision();`,
      `  if (!decision || decision.action === "none" || decision.action === "packs")`,
      `    return null;`,
      `  if (decision.action === "blocked")`,
      `    return <p role="alert">{decision.reason}</p>;`,
      `  return (`,
      `    <p role={undismissable ? "alert" : "status"}>`,
      `      Version {decision.release.version} is available.`,
      `    </p>`,
      `  );`,
      `}`,
    ),
  }),
};

// ── Python ───────────────────────────────────────────────────────────────────────────────────

const PY_HEAD = (c: UsageContext, imports = "PolarisKeyClient"): string =>
  lines(
    `from polaris_key import ${imports}`,
    ``,
    `import polaris_config`,
    ``,
    `client = PolarisKeyClient.create(**polaris_config.CONFIG, version=${q(c.appVersion)})  # your app's version`,
  );

const PY_LIBRARY: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Gate on the licence",
    filename: "licence.py",
    language: "python",
    code: lines(
      `from typing import Optional`,
      ``,
      `from polaris_key import ActivationOk, PolarisKeyClient`,
      `from polaris_key.copy import activation_message`,
      ``,
      `import polaris_config`,
      ``,
      `client = PolarisKeyClient.create(**polaris_config.CONFIG, version=${q(c.appVersion)})  # your app's version`,
      ``,
      ``,
      `def activate(key: str) -> Optional[str]:`,
      `    """None when activated, else what to show."""`,
      `    r = client.license.activate_with_key(key)`,
      `    return None if isinstance(r, ActivationOk) else activation_message(r.kind, code=r.code)`,
      ``,
      ``,
      `client.sync()`,
      `if not client.is_licensed():`,
      `    print(client.status().status)`,
      `pro = client.license.is_entitled(${q(c.entitlement)})`,
    ),
  }),
  config: (c) => ({
    title: "Read managed config",
    filename: "config.py",
    language: "python",
    code: lines(
      PY_HEAD(c),
      ``,
      `client.sync()`,
      `value = client.config.get_config(${q(c.configKey)}, ${py(c.configFallback)})`,
      `secret = client.config.get_secret(${q(c.secretKey)})`,
      `minted = client.config.mint_token(${q(c.mintRecipe)})`,
      `client.config.on_change(${q(c.configKey)}, lambda v: print("changed", v))`,
      `print(value, secret, minted)`,
    ),
  }),
  identity: (c) => ({
    title: "Sign in in the browser",
    filename: "sign_in.py",
    language: "python",
    code: lines(
      PY_HEAD(c),
      ``,
      `result = client.identity.sign_in_with_browser(device_name=${q(`${c.appName} on this computer`)})`,
      `if result.status == "ready":`,
      `    profile = client.license.get_profile()`,
      `    print(profile.name if profile else "Signed in")`,
    ),
  }),
  update: (c) => ({
    title: "Ask for an update",
    filename: "update.py",
    language: "python",
    code: lines(
      PY_HEAD(c),
      ``,
      `d = client.update.decide().decision`,
      `if d.action == "blocked":`,
      `    print("Update required", d.reason)`,
      `elif d.action not in ("none", "packs") and d.release:`,
      `    print(d.release.version, "is available")`,
    ),
  }),
  packs: (c) => ({
    title: "Install a content pack",
    filename: "packs.py",
    language: "python",
    code: lines(
      PY_HEAD(c),
      ``,
      `installs = client.update.packs.ensure([${q(c.packId)}])`,
      `print(installs)`,
    ),
  }),
  sync: (c) => ({
    title: "Save a setting the person keeps across devices",
    filename: "settings.py",
    language: "python",
    status: "planned",
    code: lines(
      PY_HEAD(c),
      ``,
      `# A catalog key with a \`user.sync\` block roams once the person signs in. The routes ship`,
      `# later: today the value stays on this device.`,
      `volume = client.config.setting(${q(c.configKey)}, ${py(c.configFallback)})`,
      `volume.set(${py(c.configFallback)})`,
      `print(volume.value)`,
    ),
  }),
  commerce: (c) => ({
    title: "Claim a store purchase",
    filename: "commerce.py",
    language: "python",
    code: lines(
      PY_HEAD(c),
      ``,
      `# Steam shown; claim_app_store and claim_play take their store's fields.`,
      `def claim(ticket_hex: str, dlc_app_id: str) -> str:`,
      `    r = client.commerce.claim_steam(ticket_hex, dlc_app_id)`,
      `    return "unlocked" if client.license.is_entitled(${q(c.commerceFlag)}) else str(r)`,
    ),
  }),
};

const PY_KIT: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Mount the Polaris Key verbs in your CLI",
    filename: "cli.py",
    language: "python",
    code: lines(
      `import argparse`,
      ``,
      `from polaris_key.cli import register_argparse`,
      ``,
      `import polaris_config`,
      ``,
      `parser = argparse.ArgumentParser(prog=${q(c.appName)})`,
      `register_argparse(`,
      `    parser.add_subparsers(dest="command", required=True),`,
      `    config=polaris_config.CONFIG,`,
      `    version=${q(c.appVersion)},  # your app's version`,
      `)`,
      `args = parser.parse_args()`,
      `raise SystemExit(args.func(args))`,
    ),
  }),
};

// ── Swift, Kotlin, Godot (licensing only until SP-33b) ───────────────────────────────────────

const SWIFT_KIT: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Gate the app",
    filename: "MyApp.swift",
    language: "swift",
    code: lines(
      `import PolarisKey`,
      `import PolarisKeyUI`,
      `import SwiftUI`,
      ``,
      `@main`,
      `struct MyApp: App {`,
      `    @State private var client: PolarisKeyClient?`,
      ``,
      `    var body: some Scene {`,
      `        WindowGroup {`,
      `            if let client {`,
      `                ContentView().polarisKeyGate(client)`,
      `            } else {`,
      `                ProgressView().task {`,
      `                    client = try? await PolarisKeyClient.create(`,
      `                        options: PolarisConfig.clientOptions(version: ${q(c.appVersion)}))`,
      `                }`,
      `            }`,
      `        }`,
      `    }`,
      `}`,
    ),
  }),
};
const SWIFT_LIBRARY: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Gate on the licence",
    filename: "Licence.swift",
    language: "swift",
    code: lines(
      `import PolarisKey`,
      ``,
      `let client = try await PolarisKeyClient.create(`,
      `    options: PolarisConfig.clientOptions(version: ${q(c.appVersion)}))`,
      `_ = await client.sync()`,
      `if await !client.isLicensed() {`,
      `    let result = await client.activate(key: userEnteredKey)`,
      `    print(result)`,
      `}`,
    ),
  }),
};

const KOTLIN_KIT: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: () => ({
    title: "Gate the app",
    filename: "MainActivity.kt",
    language: "kotlin",
    code: lines(
      `import android.os.Bundle`,
      `import androidx.activity.ComponentActivity`,
      `import androidx.activity.compose.setContent`,
      `import androidx.compose.material3.MaterialTheme`,
      `import androidx.compose.material3.Text`,
      `import im.plrs.key.ui.PolarisKeyApp`,
      ``,
      `class MainActivity : ComponentActivity() {`,
      `    override fun onCreate(savedInstanceState: Bundle?) {`,
      `        super.onCreate(savedInstanceState)`,
      `        setContent {`,
      `            MaterialTheme {`,
      `                PolarisKeyApp(client, signIn = true) { Text("Licensed") }`,
      `            }`,
      `        }`,
      `    }`,
      `}`,
    ),
  }),
};
const KOTLIN_LIBRARY: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: (c) => ({
    title: "Gate on the licence",
    filename: "Licence.kt",
    language: "kotlin",
    code: lines(
      `import com.acme.polaris.PolarisConfig`,
      `import im.plrs.key.desktop.PolarisKeyDesktop`,
      ``,
      `suspend fun start() {`,
      `    val client = PolarisKeyDesktop.create(PolarisConfig.clientOptions(${q(c.appVersion)}))`,
      `    println(client.status())`,
      `    client.close() // ends the client's threads so a JVM main can exit`,
      `}`,
    ),
  }),
};

const GODOT_KIT: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: () => ({
    title: "Boot Polaris Key before the first scene",
    filename: "boot.gd",
    language: "gdscript",
    code: lines(
      `extends Node`,
      ``,
      ``,
      `func _ready() -> void:`,
      `\tawait PolarisKey.boot()  # reads res://polaris_key.tres`,
      `\tget_tree().change_scene_to_file("res://game/title.tscn")`,
    ),
  }),
};
const GODOT_LIBRARY: Partial<Record<IntegrationFeature, Maker>> = {
  licensing: () => ({
    title: "React to the licence state",
    filename: "gate.gd",
    language: "gdscript",
    code: lines(
      `extends Node`,
      ``,
      ``,
      `func _ready() -> void:`,
      `\tPolarisKey.state_changed.connect(_on_state_changed)`,
      ``,
      ``,
      `func _on_state_changed(state: Dictionary) -> void:`,
      `\tvar screen := PKeyGateController.screen_for(String(state["status"]))`,
      `\tprint(screen)  # usable, grace, activation, revoked, expired, ...`,
    ),
  }),
};

// ── The table ────────────────────────────────────────────────────────────────────────────────

type Table = Partial<
  Record<
    SdkId,
    Partial<
      Record<
        IntegrationLane,
        Partial<Record<string, Partial<Record<IntegrationFeature, Maker>>>>
      >
    >
  >
>;

/** Per SDK, lane and framework (`_` is the default): the features it renders. */
const TABLE: Table = {
  node: {
    kit: { _: NODE_KIT, commander: NODE_KIT, electron: NODE_ELECTRON },
    library: { _: NODE_LIBRARY },
    server: { _: NODE_SERVER },
  },
  react: { kit: { _: REACT_KIT }, library: { _: REACT_LIBRARY } },
  python: {
    kit: { _: PY_KIT, argparse: PY_KIT },
    library: { _: PY_LIBRARY },
  },
  swift: { kit: { _: SWIFT_KIT }, library: { _: SWIFT_LIBRARY } },
  kotlin: { kit: { _: KOTLIN_KIT }, library: { _: KOTLIN_LIBRARY } },
  godot: { kit: { _: GODOT_KIT }, library: { _: GODOT_LIBRARY } },
};

const COMPILED_SDKS: ReadonlySet<SdkId> = new Set(["node", "react", "python"]);

/** The frameworks a lane renders for an SDK today (always includes the default, `null`). */
export function usageFrameworks(sdk: SdkId, lane: IntegrationLane): string[] {
  return Object.keys(TABLE[sdk]?.[lane] ?? {}).filter((f) => f !== "_");
}

/**
 * Render one feature's usage for an SDK and lane, from the product's real names (`ctx`, defaulting
 * to the docs' example product). `framework` picks a variant inside the lane (Node's kit lane has
 * `commander` and `electron`; Python's `argparse`); an unknown framework renders `null`, so a page
 * never shows another framework's code under its name. Server frameworks (Express, Hono, FastAPI,
 * Flask, Django and the rest) render `null` until the server adapter packages ship: the `server`
 * lane renders the framework-free core.
 */
export function renderUsage(
  feature: IntegrationFeature,
  sdk: SdkId,
  lane: IntegrationLane,
  framework: string | null = null,
  ctx: Partial<UsageContext> = {},
): IntegrationBlock | null {
  const group = TABLE[sdk]?.[lane];
  if (!group) return null;
  const features = group[framework ?? "_"];
  const make = features?.[feature];
  if (!make) return null;
  const made = make({ ...DEFAULT_USAGE_CONTEXT, ...ctx });
  const docs =
    lane === "server"
      ? SERVER_DOCS
      : lane === "kit"
        ? SDK_KIT_DOCS[sdk]
        : SDK_LIBRARY_DOCS[sdk];
  return {
    id: `${feature}.${sdk}.${lane}${framework ? `.${framework}` : ""}`,
    feature,
    sdk,
    lane,
    framework,
    title: made.title,
    filename: made.filename,
    language: made.language,
    code: `${made.code}\n`,
    docs,
    status: made.status ?? "available",
    compiled: made.compiled ?? COMPILED_SDKS.has(sdk),
  };
}

/** Every block that renders today, in a stable order: the goldens' and the docs' source list. */
export function allUsageBlocks(
  ctx: Partial<UsageContext> = {},
): IntegrationBlock[] {
  const out: IntegrationBlock[] = [];
  for (const sdk of [
    "node",
    "react",
    "python",
    "swift",
    "kotlin",
    "godot",
  ] as const)
    for (const lane of INTEGRATION_LANES)
      for (const fw of [null, ...usageFrameworks(sdk, lane)])
        for (const feature of INTEGRATION_FEATURES) {
          const b = renderUsage(feature, sdk, lane, fw, ctx);
          // `_` and a named default render the same code: keep the named one only.
          if (
            b &&
            !(
              fw === null &&
              usageFrameworks(sdk, lane).length > 0 &&
              sameAsNamed(b)
            )
          )
            out.push(b);
        }
  return out;
}

function sameAsNamed(b: IntegrationBlock): boolean {
  return usageFrameworks(b.sdk, b.lane).some(
    (f) => renderUsage(b.feature, b.sdk, b.lane, f)?.code === b.code,
  );
}

export { FEATURE_DOCS as USAGE_FEATURE_DOCS };
