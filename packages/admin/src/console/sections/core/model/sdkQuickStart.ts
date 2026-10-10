/**
 * Overview's SDK quick start (UX-59; docs/design/SETUP.md §3.3, §3.4): what an app needs to talk
 * to this product, per SDK.
 *
 * - **Install** comes only from Polaris Key's own feeds on `pkg.plrs.im`, through
 *   `renderFeedSetup` (the bytes `pkey feeds setup --owner polaris-key` prints), and always
 *   routes the namespace to the feed before anything is installed. A bare
 *   `npm install @polaris-key/node` would resolve against npmjs: dependency confusion (D17).
 * - **Initialise** pins every signing key the product trusts now, the active one and any staged
 *   for rotation, so a build made during a staged rotation trusts both (D16). The pins come from
 *   the authenticated admin API (`GET …/keys`), never from discovery.
 * - The version an app sends is **its own**, never the latest release's: the snippets carry a
 *   marked placeholder, and Godot's resource leaves it empty so the project setting is used.
 *
 * Interim until UX-60's `renderSdkSetup` and UX-61's Connect your app replace it.
 */

import {
  renderFeedSetup,
  SYSTEM_PRODUCT_SLUG,
  type FeedSnippet,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import type { ServiceSlug, SigningKeyDto } from "../../../../api.js";
import type { CodeLanguage } from "../../../../lib/highlight.js";

export type SdkId = "node" | "react" | "python" | "swift" | "kotlin" | "godot";

export const SDK_OPTIONS: readonly { value: SdkId; label: string }[] = [
  { value: "node", label: "Node" },
  { value: "react", label: "React and web" },
  { value: "python", label: "Python" },
  { value: "swift", label: "Swift" },
  { value: "kotlin", label: "Kotlin and Android" },
  { value: "godot", label: "Godot" },
];

/** The DOM id of the SDK chooser in Overview's quick start; the palette's SDK rows focus it. */
export const SDK_QUICK_START_ID = "sdk-quick-start";

/** Where every SDK is published, and nowhere else (RUNBOOK "Releasing our SDKs to the feeds"). */
export const SDK_REGISTRY_ORIGIN = "https://pkg.plrs.im";

/** The production control plane, which every SDK defaults to. */
const DEFAULT_BASE_URL = "https://key.plrs.im";

/** The marked placeholder for the app's own version. */
const APP_VERSION = "1.0.0";

/** Per SDK: the platform feed, its namespace (the worker's `SYSTEM_FEEDS`), the package, and
 *  which of the feed's snippets to show, in order. */
const INSTALL: Record<
  SdkId,
  {
    ecosystem: PackageEcosystem;
    namespace: Record<string, unknown>;
    name: string;
    snippets: readonly string[];
  }
> = {
  node: {
    ecosystem: "npm",
    namespace: { scope: "@polaris-key" },
    name: "@polaris-key/node",
    snippets: ["npmrc", "install"],
  },
  react: {
    ecosystem: "npm",
    namespace: { scope: "@polaris-key" },
    name: "@polaris-key/react",
    snippets: ["npmrc", "install"],
  },
  python: {
    ecosystem: "pypi",
    namespace: { names: ["polaris-key"], prefixes: [] },
    name: "polaris-key",
    snippets: ["uv", "pip"],
  },
  swift: {
    ecosystem: "swift",
    namespace: { scope: "polaris-key" },
    name: "polaris-key.PolarisKey",
    snippets: ["registries-json"],
  },
  kotlin: {
    ecosystem: "maven",
    namespace: { groupPrefixes: ["im.plrs.key"] },
    name: "im.plrs.key:polaris-key-sdk",
    snippets: ["gradle", "gradle-dependency"],
  },
  godot: {
    ecosystem: "godot",
    namespace: { publisher: "polaris-key" },
    name: "polaris_key",
    snippets: ["editor-4.7", "editor-4.6"],
  },
};

/** The install snippets for one SDK, from the platform feed's setup. */
export function sdkInstall(sdk: SdkId): FeedSnippet[] {
  const spec = INSTALL[sdk];
  const all = renderFeedSetup(spec.ecosystem, {
    origin: SDK_REGISTRY_ORIGIN,
    owner: SYSTEM_PRODUCT_SLUG,
    namespace: spec.namespace,
    package: { name: spec.name },
  });
  return spec.snippets.flatMap((id) => all.filter((s) => s.id === id));
}

/** A line after the install snippets, where one is needed to finish installing. */
export function sdkInstallNote(sdk: SdkId): string | null {
  if (sdk === "swift")
    return "Then add the package to Package.swift by its registry identity, polaris-key.PolarisKey, and depend on its PolarisKey product.";
  if (sdk === "godot")
    return "Then install the Polaris Key addon from the editor's asset library and enable it under Project Settings, Plugins.";
  return null;
}

/** One pinned key: `kid` and its raw Ed25519 public key (base64url). */
export interface TrustPin {
  kid: string;
  publicKey: string;
}

/**
 * The keys an app pins: every active and staged signing key, active first. Falls back to the
 * product row's active key while the inventory loads or when it cannot be read.
 */
export function trustPins(
  keys: readonly SigningKeyDto[] | undefined,
  active: { kid: string; publicKey?: string } | null,
): TrustPin[] {
  const fromInventory = (keys ?? [])
    .filter((k) => k.status === "active" || k.status === "staged")
    .sort((a, b) =>
      a.status === b.status ? 0 : a.status === "active" ? -1 : 1,
    )
    .map((k) => ({ kid: k.kid, publicKey: k.publicKey }));
  if (fromInventory.length > 0) return fromInventory;
  return active?.publicKey
    ? [{ kid: active.kid, publicKey: active.publicKey }]
    : [];
}

export interface SdkInitInput {
  slug: string;
  /** The console's origin; omitted from the snippet when it is the production default. */
  origin: string;
  pins: readonly TrustPin[];
  services: readonly ServiceSlug[];
}

export interface SdkInit {
  code: string;
  language: CodeLanguage;
  filename: string;
  /** What to do with the file, when it is not plain source. */
  hint?: string;
}

const q = (s: string): string => JSON.stringify(s);

/** The initialisation snippet for one SDK. */
export function sdkInit(sdk: SdkId, o: SdkInitInput): SdkInit {
  const base = o.origin && o.origin !== DEFAULT_BASE_URL ? o.origin : null;
  const pins = o.pins.length
    ? o.pins
    : [{ kid: "<kid>", publicKey: "<public key>" }];
  const versionNote = "your app's version, not Polaris Key's";
  switch (sdk) {
    case "react":
      return {
        filename: "App.tsx",
        language: "ts",
        code: [
          'import type { ReactNode } from "react";',
          'import { PolarisKeyProvider } from "@polaris-key/react";',
          "",
          `const APP_VERSION = ${q(APP_VERSION)}; // ${versionNote}`,
          "",
          "export function App({ children }: { children: ReactNode }) {",
          "  return (",
          "    <PolarisKeyProvider",
          `      productSlug=${q(o.slug)}`,
          ...(base ? [`      baseUrl=${q(base)}`] : []),
          "      version={APP_VERSION}",
          // Bearer mode (a page on its own origin, or Tauri) verifies every document in the
          // page, and reports `invalid-options` without pins (P0-47).
          "      trust={{",
          "        pinnedKeys: {",
          ...pins.map((p) => `          ${q(p.kid)}: ${q(p.publicKey)},`),
          "        },",
          "      }}",
          `      expectServices={[${o.services.map(q).join(", ")}]}`,
          "    >",
          "      {children}",
          "    </PolarisKeyProvider>",
          "  );",
          "}",
        ].join("\n"),
      };
    case "python":
      return {
        filename: "app.py",
        language: "text",
        code: [
          "from polaris_key import PolarisKeyClient",
          "",
          "client = PolarisKeyClient.create(",
          `    product_slug=${q(o.slug)},`,
          ...(base ? [`    base_url=${q(base)},`] : []),
          `    version=${q(APP_VERSION)},  # ${versionNote}`,
          "    trust={",
          ...pins.map((p) => `        ${q(p.kid)}: ${q(p.publicKey)},`),
          "    },",
          `    expected_services=[${o.services.map(q).join(", ")}],`,
          ")",
          "client.discover()",
          "client.sync()",
        ].join("\n"),
      };
    case "swift":
      return {
        filename: "main.swift",
        language: "text",
        code: [
          "import PolarisKey",
          "",
          "let client = try await PolarisKeyClient.create(options: .init(",
          `    productSlug: ${q(o.slug)},`,
          ...(base ? [`    baseUrl: ${q(base)},`] : []),
          `    version: ${q(APP_VERSION)}, // ${versionNote}`,
          "    pinnedKeys: [",
          ...pins.map((p) => `        ${q(p.kid)}: ${q(p.publicKey)},`),
          "    ],",
          `    expectedServices: [${o.services.map((s) => `.${s}`).join(", ")}]`,
          "))",
          "_ = await client.discover()",
          "_ = await client.sync()",
        ].join("\n"),
      };
    case "kotlin":
      return {
        filename: "PolarisKey.kt",
        language: "text",
        code: [
          "import im.plrs.key.core.CoreOptions",
          "import im.plrs.key.core.ServiceSlug",
          "import im.plrs.key.sdk.PolarisKeyClient",
          "import im.plrs.key.sdk.PolarisKeyClientOptions",
          "",
          "suspend fun startPolarisKey(): PolarisKeyClient {",
          "    val client = PolarisKeyClient.create(",
          "        PolarisKeyClientOptions(",
          "            core = CoreOptions(",
          `                productSlug = ${q(o.slug)},`,
          ...(base ? [`                baseUrl = ${q(base)},`] : []),
          `                version = ${q(APP_VERSION)}, // ${versionNote}; BuildConfig.VERSION_NAME on Android`,
          "                pinnedKeys = mapOf(",
          ...pins.map(
            (p) => `                    ${q(p.kid)} to ${q(p.publicKey)},`,
          ),
          "                ),",
          `                expectedServices = listOf(${o.services.map((s) => `ServiceSlug.${s}`).join(", ")}),`,
          "            ),",
          "        ),",
          "    )",
          "    client.discover()",
          "    client.sync()",
          "    return client",
          "}",
        ].join("\n"),
      };
    case "godot":
      return {
        filename: "polaris_key.tres",
        language: "text",
        hint: "Save it as res://polaris_key.tres, or enter the same values in the Polaris Key setup dock. The version is left empty, so the game sends its Project Settings version (application/config/version).",
        code: [
          '[gd_resource type="Resource" script_class="PKeyOptions" load_steps=2 format=3]',
          "",
          '[ext_resource type="Script" path="res://addons/polaris_key/core/options.gd" id="1"]',
          "",
          "[resource]",
          'script = ExtResource("1")',
          `product = ${q(o.slug)}`,
          ...(base ? [`base_url = ${q(base)}`] : []),
          "pinned_trust_keys = {",
          pins.map((p) => `${q(p.kid)}: ${q(p.publicKey)}`).join(",\n"),
          "}",
          `expected_services = PackedStringArray(${o.services.map(q).join(", ")})`,
        ].join("\n"),
      };
    case "node":
    default:
      return {
        filename: "client.ts",
        language: "ts",
        code: [
          'import { PolarisKeyClient } from "@polaris-key/node";',
          "",
          "const client = await PolarisKeyClient.create({",
          `  productSlug: ${q(o.slug)},`,
          ...(base ? [`  baseUrl: ${q(base)},`] : []),
          `  version: ${q(APP_VERSION)}, // ${versionNote}`,
          "  trust: {",
          "    pinnedKeys: {",
          ...pins.map((p) => `      ${q(p.kid)}: ${q(p.publicKey)},`),
          "    },",
          "  },",
          `  expectedServices: [${o.services.map(q).join(", ")}],`,
          "});",
          "await client.discover();",
          "await client.sync();",
        ].join("\n"),
      };
  }
}
