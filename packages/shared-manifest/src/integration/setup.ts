/**
 * `renderSdkSetup`: everything an app needs to start with Polaris Key, per SDK (SP-33a): the
 * install from our own feeds (through `renderFeedSetup`, so the routing line always comes first),
 * the generated configuration module with the trust pins, and a kit-first start with a headless
 * block beside it. The console's Integration page, `pkey sdk add` and the docs call it; none keeps
 * a second copy.
 *
 * The start is the drop-in only. The headless block is the same feature on the library (your own
 * UI); the console links it, the docs render it. Both carry the docs page that explains them.
 */

import { renderFeedSetup, type FeedSnippet } from "../feedSetup.js";
import type { PackageEcosystem } from "../packages.js";
import type { ServiceSlug } from "../services.generated.js";
import { SDK_IDS, type SdkFit, type SdkHost, type SdkId } from "./fit.js";
import {
  SDK_CONFIG_DEFAULT_OUT,
  renderSdkConfig,
  type SdkConfigFacts,
} from "./sdkConfig.js";
import {
  renderUsage,
  usageFrameworks,
  type IntegrationBlock,
  type UsageContext,
  type UsageLanguage,
} from "./usage.js";

/** Where every SDK is published, and nowhere else (RUNBOOK "Releasing our SDKs to the feeds"). */
export const SDK_REGISTRY_ORIGIN = "https://pkg.plrs.im";

/** The production control plane, which every SDK defaults to. */
export const DEFAULT_BASE_URL = "https://key.plrs.im";

/** The platform's own product, which owns the SDK feeds. */
const FEED_OWNER = "polaris-key";

export const SDK_LABELS: Record<SdkId, string> = {
  node: "Node",
  react: "React and web",
  python: "Python",
  swift: "Swift",
  kotlin: "Kotlin and Android",
  godot: "Godot",
};

/** One pinned key: `kid` and its raw Ed25519 public key (base64url). */
export interface TrustPin {
  kid: string;
  publicKey: string;
}

/** Per SDK: the platform feed, its namespace (the Worker's `SYSTEM_FEEDS`), the package, and
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
    snippets: ["registries-json", "package-swift", "xcode"],
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

/** The Node server lane: the Fetch-core verifier, on the same npm feed as the SDK. */
const SERVER_INSTALL = {
  ...INSTALL.node,
  name: "@polaris-key/server",
};

/** The install snippets for one SDK, from the platform feed's setup. */
export function sdkInstall(
  sdk: SdkId,
  host: SdkHost | null | undefined = "app",
): FeedSnippet[] {
  // A Node server verifies with `@polaris-key/server`, which is what its start block imports.
  const spec =
    sdk === "node" && host === "server" ? SERVER_INSTALL : INSTALL[sdk];
  const all = renderFeedSetup(spec.ecosystem, {
    origin: SDK_REGISTRY_ORIGIN,
    owner: FEED_OWNER,
    namespace: spec.namespace,
    package: { name: spec.name },
  });
  return spec.snippets.flatMap((id) => all.filter((s) => s.id === id));
}

/** A line after the install snippets, where one is needed to finish installing. */
export function sdkInstallNote(
  sdk: SdkId,
  host: SdkHost | null | undefined = "app",
  framework: string | null = null,
): string | null {
  if (host === "server") {
    if (sdk === "python")
      return `Install the extra for your framework: polaris-key[${framework ?? "fastapi"}].`;
    if (sdk === "kotlin")
      return framework === "spring"
        ? "Add im.plrs.key:polaris-key-spring-boot-starter from the same feed."
        : "Add im.plrs.key:polaris-key-server-ktor from the same feed.";
  }
  if (sdk === "godot")
    return "Then install the Polaris Key addon from the editor's asset library and enable it under Project Settings, Plugins.";
  return null;
}

export interface SdkSetupContext {
  /** The product's slug. */
  slug: string;
  /** The console's origin; the production default when omitted. */
  origin?: string;
  /** Every active and staged signing key the product trusts, active first. */
  pins: readonly TrustPin[];
  /** The release keys the app pins (`.pkey/release`); none is a warning when Update is on. */
  releaseKeys?: readonly TrustPin[];
  services: readonly ServiceSlug[];
  /** Host and framework, from `sdkFit` or the developer's pick. */
  fit?: Partial<Pick<SdkFit, "host" | "target" | "framework">>;
  /** The product's real names for the usage blocks. */
  usage?: Partial<UsageContext>;
  /** Kotlin only: the package of the generated file. */
  kotlinPackage?: string;
}

export interface SdkConfigFile {
  filename: string;
  language: UsageLanguage | "text";
  code: string;
}

export interface SdkSetup {
  sdk: SdkId;
  install: FeedSnippet[];
  installNote: string | null;
  /** The configuration module, with the trust pins. */
  config: SdkConfigFile;
  /** The drop-in start for the host. */
  start: IntegrationBlock;
  /** The same feature on the library, for your own UI; null when the SDK renders none yet. */
  headless: IntegrationBlock | null;
  /** Things to fix before shipping, in the reader's terms. */
  warnings: string[];
}

const CONFIG_LANGUAGE: Record<SdkId, UsageLanguage | "text"> = {
  node: "ts",
  react: "ts",
  python: "python",
  swift: "swift",
  kotlin: "kotlin",
  godot: "gdscript",
};

const PLACEHOLDER_PIN: TrustPin = {
  kid: "<kid>",
  publicKey: "<public key>",
};

/** The pick of start block for a host: the drop-in, or the library where there is no screen. */
function startFor(
  sdk: SdkId,
  fit: NonNullable<SdkSetupContext["fit"]>,
  ctx: Partial<UsageContext>,
): { start: IntegrationBlock; headless: IntegrationBlock | null } {
  const framework =
    sdk === "node" && fit.target === "electron"
      ? "electron"
      : (fit.framework ?? null);
  const library = renderUsage("licensing", sdk, "library", null, ctx);
  let start: IntegrationBlock | null = null;
  if (fit.host === "server") {
    // The framework's own variant; else the framework-free core; else the SDK's first drop-in.
    start =
      renderUsage("licensing", sdk, "server", framework, ctx) ??
      renderUsage("licensing", sdk, "server", null, ctx) ??
      renderUsage(
        "licensing",
        sdk,
        "server",
        usageFrameworks(sdk, "server")[0] ?? null,
        ctx,
      ) ??
      library;
  } else {
    start =
      renderUsage("licensing", sdk, "kit", framework, ctx) ??
      renderUsage("licensing", sdk, "kit", null, ctx) ??
      library;
  }
  if (!start) throw new Error(`renderSdkSetup: no start block for ${sdk}`);
  return { start, headless: library && library !== start ? library : null };
}

/**
 * Render the setup for one SDK. Throws only on a programming error (an unknown SDK); a product
 * with no signing key yet renders placeholders and a warning.
 */
export function renderSdkSetup(sdk: SdkId, o: SdkSetupContext): SdkSetup {
  if (!SDK_IDS.includes(sdk))
    throw new Error(`renderSdkSetup: unknown SDK ${String(sdk)}`);
  const origin = (o.origin ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const pins = o.pins.length > 0 ? o.pins : [PLACEHOLDER_PIN];
  const facts: SdkConfigFacts = {
    product: o.slug,
    baseUrl: origin,
    discoveryUrl: `${origin}/${o.slug}/.well-known/polaris.json`,
    pinnedKeys: Object.fromEntries(pins.map((p) => [p.kid, p.publicKey])),
    pinnedReleaseKeys: Object.fromEntries(
      (o.releaseKeys ?? []).map((p) => [p.kid, p.publicKey]),
    ),
    services: [...o.services],
  };
  const lang = sdk;
  const out = SDK_CONFIG_DEFAULT_OUT[lang];
  const code = renderSdkConfig(lang, facts, {
    out,
    ...(o.kotlinPackage ? { kotlinPackage: o.kotlinPackage } : {}),
  });
  const fit = o.fit ?? { host: "app" as const, target: null, framework: null };
  const { start, headless } = startFor(sdk, fit, o.usage ?? {});

  const warnings: string[] = [];
  if (o.pins.length === 0)
    warnings.push(
      "This product has no signing key yet. Create one in the console, then copy the file again.",
    );
  if (o.services.includes("update") && (o.releaseKeys ?? []).length === 0)
    warnings.push(
      "Update is on but no release key is pinned, so the app refuses every release. Run pkey sdk in the product repo: it reads the keys from .pkey/release.",
    );

  return {
    sdk,
    install: sdkInstall(sdk, fit.host),
    installNote: sdkInstallNote(sdk, fit.host, fit.framework ?? null),
    config: { filename: out, language: CONFIG_LANGUAGE[sdk], code },
    start,
    headless,
    warnings,
  };
}
