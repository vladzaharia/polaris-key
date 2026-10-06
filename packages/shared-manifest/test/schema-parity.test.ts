/**
 * Schema ↔ validator parity — the drift gate that keeps the published JSON Schemas honest.
 *
 * `schemas/v1/*.schema.json` exist for editors and machine consumers; `validateManifestDocuments`
 * is authoritative. This suite pins three properties:
 *
 *  1. **Valid stays valid.** Every valid fixture — including the real `products/djdl/*` files —
 *     passes BOTH the TypeScript validator and the schemas.
 *  2. **Every error code has a case.** The table below carries one mutation per validator error
 *     code; a completeness sweep extracts the codes from the validator SOURCE, so adding a rule
 *     without a table entry fails here — the gate the docs plan demands ("adding a validator
 *     rule without a fixture is visible").
 *  3. **The schema catches what it claims to.** Each mutation declares whether the schema can
 *     express the rule (`schema: "rejects"`) or not (`schema: "accepts"` — cross-references
 *     like unknown_profile_ref are beyond JSON Schema). Rejecting entries must fail Ajv;
 *     accepting entries document the validator-only rules explicitly instead of silently.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  ARTIFACT_ROLES,
  BUILD_NUMBER_SOURCES,
  CHANNEL_ALIAS_NAMES,
  RELEASE_ARCHES,
  RELEASE_PLATFORMS,
  VERSION_SCHEMES,
  LOCATION_PROVIDERS,
  ANDROID_ABIS,
  OUTLET_IDENTITY_FIELDS,
  OUTLET_KINDS,
  TRANSPORTS,
  TRANSPORT_OUTLET_KINDS,
  parseManifest,
  validateIngestDocuments,
  validateManifestDocuments,
  validateReleaseDescriptor,
  MAX_PACK_DELIVERABLES,
  PACK_BASELINES,
  PACK_BINDINGS,
  PACK_FIELDS_NOT_SUPPORTED,
  PACK_PATCH_STRATEGIES,
  PROVIDES_FILE_PATTERN,
  CUSTOM_PACK_TYPE_PATTERN,
  MANIFEST_PACK_TYPES,
  MAX_PACK_FORMAT_VERSION,
  MAX_PACKAGE_DELIVERABLES,
  PACKAGE_ECOSYSTEMS,
  PACKAGE_FILE_TYPES,
  PACKAGE_NAME_MAX_LENGTH,
  PACKAGE_NAME_PATTERNS,
  PACKAGE_REFUSED_FIELDS,
  DEPRECATED_SPELLINGS,
  type DeprecatedSpelling,
  type DescriptorManifest,
  type ParsedManifest,
} from "../src/index.js";
import {
  PACK_ACTIVATIONS,
  PACK_DELIVERIES,
  PACK_TYPES,
  VARIANT_AXES,
} from "@polaris-key/protocol/packs";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "schemas", "v1");
const repoRoot = join(here, "..", "..", "..");

// `strict: false` because the schemas deliberately mirror the validator's tolerance of
// unknown keys and mix conditional keywords; format assertions are not used (the validator's
// URL rules are richer than `format: "uri"` — the schemas use patterns instead).
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateProduct = ajv.compile(
  JSON.parse(readFileSync(join(schemasDir, "product.schema.json"), "utf8")),
);
const validateSchemaDoc = ajv.compile(
  JSON.parse(readFileSync(join(schemasDir, "schema.schema.json"), "utf8")),
);
const validateRelease = ajv.compile(
  JSON.parse(readFileSync(join(schemasDir, "release.schema.json"), "utf8")),
);
const validateDistributionDoc = ajv.compile(
  JSON.parse(
    readFileSync(join(schemasDir, "distribution.schema.json"), "utf8"),
  ),
);

type Docs = {
  product: Record<string, unknown> | undefined;
  schema?: unknown;
  release?: unknown;
  distribution?: unknown;
};

/** Raw Ed25519 keys in base64url: RFC 8032 test vectors 1 and 2, the order-1 point, and y = p. */
const RELEASE_KEY_A = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const RELEASE_KEY_B = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
const SMALL_ORDER_KEY = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NON_CANONICAL_KEY = "7f_______________________________________38";

/** A rich, fully-valid manifest exercising every block the validator knows. */
function base(): Docs {
  return {
    product: {
      apiVersion: "pkey.dev/v1",
      product: {
        slug: "acme",
        name: "Acme",
        adminGroup: "admins",
        compatMin: "1.0.0",
        compatMax: "99.0.0",
      },
      modules: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
      },
      devices: { registration: "requires-license" },
      web: { origins: ["https://app.acme.example", "http://localhost:8060"] },
      presentation: {
        icon: { src: "./.pkey/art/icon.png", sha256: "a".repeat(64) },
        accent: "#3b1f1f",
        accentDark: "#E8B4B4",
      },
      // ST-19: the canonical spellings (plans/ST-19.md §3.1); `base()` emits no warning.
      licensing: {
        defaultDeviceLimit: 5,
        defaultMaxOfflineDays: 30,
        profiles: [
          { id: "base", name: "Base profile", payload: { config: {} } },
        ],
        tiers: [
          {
            id: "free",
            label: "Free",
            profileId: "base",
            policyDeviceLimit: 2,
            policyFingerprint: "normal",
            channels: ["stable"],
            minVersion: "1.0.0",
          },
          { id: "pro", label: "Pro" },
        ],
      },
      oidc: {
        provider: "custom",
        issuer: "https://id.example.com",
        clientId: "acme-app",
        clientSecretSecret: "OIDC_CLIENT_SECRET",
        redirectUris: ["https://key.plrs.im/acme/identity/auth/callback"],
        groupRoleMap: { staff: { tier: "pro" } },
      },
      provisioning: [
        {
          claim: "vpnAccess",
          entitlementKey: "acmeVpn",
          entitlementValue: true,
        },
      ],
      fingerprint: {
        enabled: true,
        defaultMode: "normal",
        probes: [
          {
            id: "companion",
            label: "Companion app",
            macos: "/Applications/Companion.app",
          },
        ],
      },
      autoIssue: {
        enabled: true,
        tierId: "free",
        mode: "both",
        rateLimitPerHour: 10,
      },
      secrets: { required: ["OIDC_CLIENT_SECRET"] },
      // ST-19 row 17: edge-mint recipes belong in `.pkey/product`. The release document's root
      // copy is the deprecated spelling (and a copy under its `release:` wrapper is never read).
      edgeMint: [
        {
          id: "applemusic",
          alg: "ES256",
          signingKeySecret: "APPLE_MUSIC_KEY",
          kid: "ABC123",
          claimsTemplate: { iss: "TEAMID" },
          ttlSeconds: 3600,
        },
      ],
    },
    schema: {
      schemaVersion: 1,
      entries: [
        {
          key: "run.concurrency",
          kind: "config",
          category: "Run",
          label: "Parallel downloads",
          description: "How many downloads run at once.",
          schema: { type: "integer", minimum: 1, maximum: 8 },
          default: 3,
          managementDefault: "default",
          ui: { widget: "stepper" },
        },
        {
          key: "api.token",
          kind: "secret",
          secret: true,
          category: "Secrets",
          label: "API token",
          description: "Delivered to the OS keyring.",
          schema: { type: "string", minLength: 1 },
          delivery: "clientScoped",
        },
        {
          key: "acmeVpn",
          kind: "flag",
          category: "VPN",
          label: "VPN",
          description: "An entitlement.",
          schema: { type: "boolean" },
          userGrant: true,
        },
      ],
    },
    release: {
      release: {
        provider: { type: "github", owner: "acme", repo: "desktop" },
        binaryName: "acme",
        channelWorkflow: "channel.yml",
        betaBranch: "main",
        summaryMarker: "pkey:summary",
        sparkleEd25519Pub: "AbCd1234",
        // P3-03: the CI-held release keys (RFC 8032 test vector 1's public key).
        releaseKeys: [{ kid: "ci-2026", publicKey: RELEASE_KEY_A }],
        manualChannels: [{ name: "nightly", regex: "v.*-nightly\\..*" }],
        stableTagPattern: "v\\d+\\.\\d+\\.\\d+",
        ignoreTags: ["channels", "packs"],
        artifactPolicy: {
          channels: ["stable", "beta"],
          architectures: ["arm64", "x86_64"],
          requireDmg: true,
          requireCli: true,
          allowAmbiguousAssets: false,
        },
        access: { metadata: "public", artifacts: "licensed" },
        // P2-02: the trusted publisher (only the workflow and environment are manifest fields).
        publishing: {
          trustedPublisher: {
            workflow: ".github/workflows/release.yml",
            environment: "release",
          },
        },
        // P2-04: the declared app deliverable. Its tag filters stay at the root above (the
        // legacy spelling); `conflicting_versioning` is what declaring them here too would be.
        deliverables: {
          app: {
            kind: "app",
            versioning: { scheme: "semver", buildNumber: "descriptor" },
            // P4-02: the content shape the app's code expects (required once a pack exists).
            // P4-28: what packs may attach.
            content: {
              contentApi: 3,
              attachable: [
                "res://scripts/die.gd",
                "res://scripts/dice/",
                "uid://dw1",
              ],
            },
            channels: { beta: { includes: ["stable"] }, nightly: {} },
            artifacts: [
              {
                id: "macos",
                platform: "macos",
                arch: "universal",
                format: "dmg",
                match: "Acme-*-macos.dmg",
                // P4-02: the store build ships the core pack embedded.
                embeds: ["acme.core3d"],
              },
              {
                id: "win-zip",
                platform: "windows",
                arch: "x86_64",
                format: "zip",
                role: "payload",
                match: "Acme-*-windows-x86_64.zip",
              },
              // P2b-02: the two builds the distribution document's sideload outlets name.
              {
                id: "apk",
                platform: "android",
                arch: "any",
                format: "apk",
                match: "Acme-*-android.apk",
              },
              {
                id: "ipa-sideload",
                platform: "ios",
                arch: "arm64",
                format: "ipa",
                match: "Acme-*-ios-sideload.ipa",
              },
            ],
          },
          // P4-02: pack deliverables in the v1 subset (plans/P4-01.md §3): a required,
          // embedded godot.pck pack with two texture variants, and a gated files.tree pack
          // whose entitlement assertion names the schema's flag.
          "acme.core3d": {
            kind: "pack",
            type: "godot.pck",
            binding: "pinned",
            baseline: "embedded",
            required: true,
            delivery: "essential",
            contentPolicy: { dataOnly: true },
            handler: {
              mountOrder: 1,
              prefixes: ["res://assets/core/"],
              activation: "restart",
            },
            variants: { texture: ["s3tc", "etc2"] },
            requires: { engine: "godot-4.7" },
            patch: { strategies: ["delta", "file", "chunk"], deltaBases: 1 },
            versioning: { scheme: "semver" },
            // P4-20: a publish without the content-id list fails.
            provides: { required: true, from: ".pkey/provides.json" },
          },
          "acme.l10n": {
            kind: "pack",
            type: "files.tree",
            delivery: "prefetch",
            handler: { activation: "hot" },
            variants: { locale: ["en", "fr"] },
            entitlement: "acmeVpn",
          },
          // P4-16: the v3 types.
          "acme.strings": {
            kind: "pack",
            type: "l10n.table",
            formatVersion: 1,
            variants: { locale: ["en", "pt-BR", "zh-Hant-TW"] },
          },
          "acme.balance": {
            kind: "pack",
            type: "data.json",
            formatVersion: 2,
          },
          "acme.mods": {
            kind: "pack",
            type: "godot.zip",
            handler: { prefixes: ["res://mods/"] },
            requires: { engine: "godot-4.7" },
          },
          "acme.dialogue": {
            kind: "pack",
            type: "custom.dialogue",
            formatVersion: 3,
          },
          // F-03: a package deliverable (plans/F-01.md §3.1).
          "acme.sdk": {
            kind: "package",
            ecosystem: "npm",
            name: "@acme/sdk",
            artifacts: { tarball: { match: "acme-sdk-*.tgz" } },
          },
        },
      },
    },
    // P2b-02: a Diceroll-shaped `.pkey/distribution` (README §3.12) — every outlet kind, a
    // non-kind id (`altstore-beta`), the three detection-only fields, both numeric-id spellings,
    // transports at all three levels, and a listing with a per-outlet override.
    distribution: {
      apiVersion: "pkey.dev/v1",
      outlets: {
        direct: {
          platforms: ["macos", "windows", "linux"],
          homebrewCask: "acme",
          homebrewFormula: "acme@2",
          scoop: {
            bin: "Acme/acme.exe",
            shortcuts: [["Acme/acme.exe", "Acme"]],
          },
        },
        "app-store": { appleId: "1234567890", bundleId: "com.acme.desktop" },
        testflight: { bundleId: "com.acme.desktop", publicLink: "AbCdEf12" },
        altstore: { artifact: "ipa-sideload", bundleId: "com.acme.desktop" },
        "altstore-beta": {
          kind: "altstore",
          artifact: "ipa-sideload",
          listing: { subtitle: "Beta builds" },
        },
        "altstore-pal": {
          artifact: "ipa-sideload",
          marketplaceId: "com.acme.marketplace",
        },
        play: {
          packageName: "com.acme.desktop",
          tracks: { stable: "production", beta: "beta" },
        },
        "play-testing": { packageName: "com.acme.desktop" },
        obtainium: { artifact: "apk" },
        "fdroid-repo": { artifact: "apk", packageName: "com.acme.desktop" },
        "ms-store": {
          productId: "9NBLGGH4NNS1",
          packageFamilyName: "Acme.Desktop_abcdefghjkmnp",
          flights: { beta: "Beta testers" },
        },
        "app-installer": {
          packageFamilyName: "Acme.Desktop_1a2b3c4d5e6f7",
          publisher: "CN=Acme Corporation, O=Acme Corporation, C=US",
          updateSettings: {
            hoursBetweenUpdateChecks: 12,
            showPrompt: true,
            updateBlocksActivation: true,
            automaticBackgroundTask: true,
          },
        },
        steam: { appId: 480, branches: { beta: "beta", nightly: "nightly" } },
        itch: { target: "acme/desktop", gameId: "1001" },
        flathub: { appId: "com.acme.Desktop" },
        snap: { name: "acme-desktop" },
        winget: { packageIdentifier: "Acme.Desktop" },
        web: {},
      },
      transports: {
        default: "pkey-cdn",
        packs: {
          "app-store": "apple-ba",
          play: "play-pad",
          steam: "steam-depot",
          flathub: "flatpak-ext",
          "ms-store": "msix-optional",
        },
        deliverables: { app: { web: "web", direct: "embedded" } },
      },
      listing: {
        name: "Acme",
        subtitle: "A cozy desktop",
        description: "Line one.\nLine two.",
        icon: "https://acme.example/icon.png",
        header: { src: "art/header.webp" },
        tintColor: "#3b1f1f",
        category: "games",
        screenshots: ["https://acme.example/1.png", "art/shots/2.jpg"],
        website: "https://acme.example",
        developerName: "Acme Inc.",
        supportUrl: "https://acme.example/support",
        supportEmail: "help@acme.example",
      },
    },
  };
}

function tsCodes(docs: Docs): string[] {
  // The ingest rule is a superset of the author-side check (it adds document presence), so
  // every code either emits is reachable through it.
  const res = validateIngestDocuments(docs);
  return [...res.errors, ...res.warnings].map((e) => e.code);
}

function schemaAccepts(docs: Docs): {
  product: boolean;
  schema: boolean;
  release: boolean;
  distribution: boolean;
} {
  return {
    product: validateProduct(docs.product) === true,
    schema:
      docs.schema === undefined || validateSchemaDoc(docs.schema) === true,
    release:
      docs.release === undefined || validateRelease(docs.release) === true,
    distribution:
      docs.distribution === undefined ||
      validateDistributionDoc(docs.distribution) === true,
  };
}

type Mutation = {
  code: string;
  /** Which document the schema check targets. */
  file: "product" | "schema" | "release" | "distribution";
  /** Can JSON Schema express this rule? "accepts" documents validator-only rules. */
  schema: "rejects" | "accepts";
  mutate: (d: Docs) => void;
  /** ST-19: the `DEPRECATED_SPELLINGS` row (plans/ST-19.md §3.1) this mutation exercises. */
  row?: number;
};

const p = (d: Docs) => d.product as Record<string, any>;
const rel = (d: Docs) => (d.release as Record<string, any>).release;
const mint = (d: Docs) => p(d).edgeMint[0];
const app = (d: Docs) => rel(d).deliverables.app;
const core3d = (d: Docs) => rel(d).deliverables["acme.core3d"];
const l10n = (d: Docs) => rel(d).deliverables["acme.l10n"];
const strings = (d: Docs) => rel(d).deliverables["acme.strings"];
const balance = (d: Docs) => rel(d).deliverables["acme.balance"];
const mods = (d: Docs) => rel(d).deliverables["acme.mods"];
const sdk = (d: Docs) => rel(d).deliverables["acme.sdk"];
const entry = (d: Docs) => app(d).artifacts[0];
const dist = (d: Docs) => d.distribution as Record<string, any>;
const outlet = (d: Docs, id: string) => dist(d).outlets[id];
/** ST-19: the base product with its `product:` wrapper flattened into the root (rows 1–2). */
const flatten = (d: Docs) => {
  Object.assign(p(d), p(d).product);
  delete p(d).product;
};
/** ST-19: the base release document with its `release:` wrapper removed (rows 14–16). */
const unwrap = (d: Docs) => {
  d.release = { ...(d.release as Record<string, any>).release };
};

/** One entry per validator error code (asserted complete against the source below). */
const MUTATIONS: Mutation[] = [
  {
    code: "invalid_trusted_publisher_workflow",
    file: "release",
    schema: "rejects",
    mutate: (d) =>
      (rel(d).publishing.trustedPublisher.workflow = "../../evil.yml"),
  },
  {
    // A workflow path outside .github/workflows is the same code: the manifest names a file
    // GitHub's job_workflow_ref could never carry.
    code: "invalid_trusted_publisher_workflow",
    file: "release",
    schema: "rejects",
    mutate: (d) => delete rel(d).publishing.trustedPublisher.workflow,
  },
  {
    code: "invalid_trusted_publisher_environment",
    file: "release",
    schema: "rejects",
    mutate: (d) =>
      (rel(d).publishing.trustedPublisher.environment = "prod;rm -rf"),
  },
  {
    code: "invalid_api_version",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).apiVersion = "pkey.dev/v2"),
  },
  {
    code: "invalid_slug",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).product.slug = "Bad Slug!"),
  },
  {
    code: "reserved_slug",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).product.slug = "docs"),
  },
  {
    code: "reserved_slug",
    file: "product",
    schema: "rejects",
    // PX-W1: the portal's media proxy is a root path too.
    mutate: (d) => (p(d).product.slug = "media"),
  },
  {
    code: "reserved_slug",
    file: "product",
    schema: "rejects",
    // PX-W16 (G33): `/media/avatar/<asset>` must never be a product's media path.
    mutate: (d) => (p(d).product.slug = "avatar"),
  },
  {
    code: "missing_name",
    file: "product",
    schema: "rejects",
    mutate: (d) => delete p(d).product.name,
  },
  {
    code: "invalid_name",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).product.name = "x".repeat(300)),
  },
  {
    code: "invalid_admin_group",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).product.adminGroup = "bad group"),
  },
  {
    code: "invalid_semver",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).product.compatMin = "one.two"),
  },
  {
    code: "invalid_number",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.defaultDeviceLimit = -1),
  },
  {
    code: "missing_schema",
    file: "product",
    schema: "accepts",
    mutate: (d) => delete d.schema,
  },
  {
    // Ingest requires the schema even with Config off; only validateIngestDocuments (which
    // tsCodes uses) reports it, and the schema cannot express a missing sibling document.
    code: "missing_schema",
    file: "product",
    schema: "accepts",
    mutate: (d) => {
      p(d).modules.config = { enabled: false };
      delete d.schema;
    },
  },
  {
    // A missing document has no JSON to validate; the product schema rejects `undefined` as
    // "not an object", which is the closest the schema gets.
    code: "missing_product",
    file: "product",
    schema: "rejects",
    mutate: (d) => (d.product = undefined),
  },
  {
    code: "invalid_schema",
    file: "schema",
    schema: "rejects",
    mutate: (d) => (d.schema = { schemaVersion: 1 }),
  },
  {
    code: "invalid_catalog_shape",
    file: "schema",
    schema: "rejects",
    mutate: (d) => ((d.schema as any).entries[0].kind = "toggle"),
  },
  {
    code: "invalid_catalog_shape",
    file: "schema",
    schema: "rejects",
    // managementDefault is CONFIG-only; entries[1] is the secret entry.
    mutate: (d) => ((d.schema as any).entries[1].managementDefault = "default"),
  },
  {
    // Warnings share the table: a warning is still a code the validator emits. The JSON schema
    // tolerates unknown tier keys, so it accepts.
    code: "tier_ignored_field",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).licensing.tiers[0].deviceLimit = 5),
  },
  {
    code: "tier_ignored_field",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).licensing.tiers[0].maxOfflineDays = 14),
  },
  {
    // P0-04: a name `CHANNEL_RE` accepts but the canonical alphabet (WIRE-CONTRACT-V3 §5.1)
    // does not. A warning, and the schemas keep `CHANNEL_RE`, so they accept.
    code: "noncanonical_channel_name",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).licensing.tiers[0].channels = ["Beta.2"]),
  },
  {
    // S-19 §7.4 (LX-05): a flag declaring a system key with an incompatible type. A warning in
    // the default mode (the platform's LICENSING_RESERVED_NAMES flips it to an error, LX-05b);
    // the type of a key's values is beyond the schema document, so it accepts.
    code: "incompatible_reserved_name",
    file: "schema",
    schema: "accepts",
    mutate: (d) =>
      (d.schema as any).entries.push({
        key: "deviceLimit",
        kind: "flag",
        category: "Seats",
        label: "Seats",
        description: "A string where the platform sets an integer.",
        schema: { type: "string" },
      }),
  },
  {
    // P0-04: a manual channel a built-in takes over. A warning, so the schema accepts.
    code: "reserved_channel_name",
    file: "release",
    schema: "accepts",
    mutate: (d) => (rel(d).manualChannels[0].name = "beta"),
  },
  {
    code: "invalid_profile_id",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.profiles[0].id = "bad id!"),
  },
  {
    code: "duplicate_profile_id",
    file: "product",
    schema: "accepts",
    mutate: (d) => p(d).licensing.profiles.push({ id: "base" }),
  },
  {
    code: "invalid_profile_name",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.profiles[0].name = "x".repeat(300)),
  },
  {
    code: "invalid_profile_description",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.profiles[0].description = "x".repeat(2100)),
  },
  {
    code: "invalid_payload",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.profiles[0].payload = "not-an-object"),
  },
  {
    code: "invalid_tier_id",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.tiers[0].id = "bad id!"),
  },
  {
    code: "duplicate_tier_id",
    file: "product",
    schema: "accepts",
    mutate: (d) => p(d).licensing.tiers.push({ id: "free" }),
  },
  {
    code: "invalid_profile_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.tiers[0].profileId = 42),
  },
  {
    code: "unknown_profile_ref",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).licensing.tiers[0].profileId = "ghost"),
  },
  {
    code: "invalid_device_limit",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.tiers[0].policyDeviceLimit = 1.5),
  },
  {
    code: "invalid_tier_label",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.tiers[0].label = "x".repeat(300)),
  },
  {
    code: "invalid_channel",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.tiers[0].channels = ["bad channel!"]),
  },
  {
    code: "invalid_tier_fingerprint_mode",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).licensing.tiers[0].policyFingerprint = "paranoid"),
  },
  {
    code: "invalid_oidc",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).oidc = "custom"),
  },
  {
    code: "invalid_oidc_provider",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).oidc.provider = "github"),
  },
  {
    code: "invalid_oidc_issuer",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).oidc.issuer = "https://10.0.0.1/oidc"),
  },
  {
    code: "missing_oidc_client_id",
    file: "product",
    schema: "rejects",
    mutate: (d) => delete p(d).oidc.clientId,
  },
  {
    code: "invalid_oidc_client_id",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).oidc.clientId = "bad client id!"),
  },
  {
    code: "invalid_group_name",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).oidc.groupRoleMap = { "bad group": {} }),
  },
  {
    code: "invalid_secret_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).oidc.clientSecretSecret = "lowercase"),
  },
  {
    code: "too_many_redirect_uris",
    file: "product",
    schema: "rejects",
    mutate: (d) =>
      (p(d).oidc.redirectUris = Array(21).fill("https://a.example/cb")),
  },
  {
    code: "invalid_redirect_uri",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).oidc.redirectUris = ["not-a-url"]),
  },
  {
    code: "invalid_claim",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).provisioning[0].claim = "__proto__"),
  },
  {
    code: "invalid_entitlement_key",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).provisioning[0].entitlementKey = "bad key!"),
  },
  {
    code: "invalid_secret_key",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).provisioning[0].secretKey = "bad key!"),
  },
  {
    code: "invalid_secret_url_template",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).provisioning[0].secretUrlTemplate = "ftp://x/{claim}"),
  },
  {
    code: "invalid_allowed_host",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).provisioning[0].allowedHosts = ["bad host!"]),
  },
  {
    code: "invalid_fingerprint",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).fingerprint = "on"),
  },
  {
    code: "invalid_fingerprint_enabled",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).fingerprint.enabled = "yes"),
  },
  {
    code: "invalid_fingerprint_mode",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).fingerprint.defaultMode = "stricht"),
  },
  {
    code: "invalid_probe_id",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).fingerprint.probes[0].id = "bad id!"),
  },
  {
    code: "invalid_probe_label",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).fingerprint.probes[0].label = "x".repeat(300)),
  },
  {
    code: "invalid_probe_target",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).fingerprint.probes[0].macos = "x".repeat(600)),
  },
  {
    code: "invalid_auto_issue",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).autoIssue.enabled = "yes"),
  },
  {
    code: "invalid_auto_issue_mode",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).autoIssue.mode = "sponsored"),
  },
  {
    code: "missing_auto_issue_tier",
    file: "product",
    schema: "rejects",
    mutate: (d) => delete p(d).autoIssue.tierId,
  },
  // The empty-string arm specifically: `typeof` alone passes "", every later gate skips it,
  // and Ajv rejects it via the identifier pattern — the parity break the code review caught.
  {
    code: "missing_auto_issue_tier",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).autoIssue.tierId = ""),
  },
  {
    code: "unknown_auto_issue_tier_ref",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).autoIssue.tierId = "ghost"),
  },
  {
    code: "invalid_tier_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).autoIssue.tierId = "bad tier!"),
  },
  {
    code: "invalid_rate_limit",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).autoIssue.rateLimitPerHour = -5),
  },
  {
    code: "distribution_requires_release",
    file: "product",
    schema: "rejects",
    mutate: (d) => {
      p(d).modules = {
        distribution: { enabled: true },
        update: { enabled: true },
      };
      delete d.release;
    },
  },
  {
    code: "update_requires_distribution",
    file: "product",
    schema: "rejects",
    mutate: (d) => {
      p(d).modules = { release: { enabled: true }, update: { enabled: true } };
    },
  },
  {
    code: "invalid_registration_policy",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).devices.registration = "invite-only"),
  },
  {
    code: "config_without_activation",
    file: "product",
    schema: "accepts",
    mutate: (d) => {
      p(d).modules = { config: { enabled: true } };
      delete d.release;
    },
  },
  {
    code: "missing_release",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete d.release,
  },
  {
    code: "unsupported_release_provider",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).provider.type = "gitlab"),
  },
  {
    code: "missing_github_repo",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete rel(d).provider.repo,
  },
  {
    code: "invalid_github_owner",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).provider.owner = "bad owner!"),
  },
  {
    code: "invalid_github_repo",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).provider.repo = "bad repo!"),
  },
  {
    code: "invalid_binary_name",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).binaryName = "bad binary!"),
  },
  {
    code: "invalid_channel_workflow",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).channelWorkflow = "not-a-workflow.txt"),
  },
  {
    code: "invalid_beta_branch",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).betaBranch = "-bad"),
  },
  {
    code: "invalid_summary_marker",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).summaryMarker = "bad marker!"),
  },
  {
    code: "invalid_sparkle_pub",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).sparkleEd25519Pub = "not base64!!"),
  },
  // P3-03: release keys (plans/P3-01.md §3).
  {
    code: "invalid_release_key",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).releaseKeys[0].publicKey = "short"),
  },
  {
    code: "invalid_release_key",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).releaseKeys[0].kid = "-leading-dash"),
  },
  {
    code: "invalid_release_key",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).releaseKeys = []),
  },
  {
    // The order-1 point: well-formed base64url, and a key no v4 verifier accepts.
    code: "weak_release_key",
    file: "release",
    schema: "accepts",
    mutate: (d) => (rel(d).releaseKeys[0].publicKey = SMALL_ORDER_KEY),
  },
  {
    // y = p: a non-canonical encoding.
    code: "weak_release_key",
    file: "release",
    schema: "accepts",
    mutate: (d) => (rel(d).releaseKeys[0].publicKey = NON_CANONICAL_KEY),
  },
  {
    code: "duplicate_release_key",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      rel(d).releaseKeys.push({ kid: "ci-2026", publicKey: RELEASE_KEY_B }),
  },
  {
    code: "duplicate_release_key",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      rel(d).releaseKeys.push({ kid: "ci-2027", publicKey: RELEASE_KEY_A }),
  },
  {
    // The same raw key as the Sparkle archive key, spelled in standard base64.
    code: "release_key_reused",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      (rel(d).sparkleEd25519Pub =
        "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="),
  },
  {
    code: "content_keys_not_supported",
    file: "release",
    schema: "accepts",
    mutate: (d) => (rel(d).contentKeys = [{ kid: "content" }]),
  },
  {
    code: "invalid_architecture",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).artifactPolicy.architectures = ["bad arch!"]),
  },
  {
    code: "invalid_architecture",
    file: "release",
    schema: "rejects",
    // The length bound: CHANNEL_RE allows 64 characters in total, so 65 is out for both.
    mutate: (d) => (rel(d).artifactPolicy.architectures = ["a".repeat(65)]),
  },
  {
    code: "invalid_manual_channel",
    file: "release",
    schema: "rejects",
    // The schema-expressible half: the regex source-length cap (maxLength 80).
    mutate: (d) => (rel(d).manualChannels[0].regex = "a".repeat(81)),
  },
  {
    code: "invalid_manual_channel",
    file: "release",
    schema: "accepts",
    // The validator-only half: JSON Schema cannot test that a regex COMPILES.
    mutate: (d) => (rel(d).manualChannels[0].regex = "(unclosed"),
  },
  {
    code: "invalid_stable_tag_pattern",
    file: "release",
    schema: "rejects",
    // The schema-expressible half: the same 80-character cap as a manual-channel regex.
    mutate: (d) => (rel(d).stableTagPattern = "a".repeat(81)),
  },
  {
    code: "invalid_stable_tag_pattern",
    file: "release",
    schema: "accepts",
    // The validator-only half (regex safety rule): JSON Schema cannot test that it COMPILES.
    mutate: (d) => (rel(d).stableTagPattern = "v(unclosed"),
  },
  {
    code: "invalid_ignore_tags",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).ignoreTags = "channels"),
  },
  {
    code: "invalid_ignore_tags",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).ignoreTags = ["has space"]),
  },
  {
    code: "invalid_release_access",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).access.artifacts = "entitled"),
  },
  // ── deliverables and the artifact map (P2-04) ──
  {
    code: "invalid_deliverable_id",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).deliverables["Bad_Id"] = { kind: "pack" }),
  },
  {
    code: "invalid_deliverable_id",
    file: "release",
    schema: "rejects",
    mutate: (d) => (rel(d).deliverables = ["app"]),
  },
  {
    code: "invalid_deliverable_kind",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).kind = "game"),
  },
  {
    code: "invalid_deliverable_kind",
    file: "release",
    schema: "rejects",
    // `app` is the application; a pack may not take its name.
    mutate: (d) => (app(d).kind = "pack"),
  },
  {
    code: "invalid_deliverable_kind",
    file: "release",
    schema: "rejects",
    // ...and no other id may be kind app.
    mutate: (d) => (rel(d).deliverables["acme.tools"] = { kind: "app" }),
  },
  // ── package deliverables (F-03, plans/F-01.md §3.1) ──
  {
    code: "invalid_package_ecosystem",
    file: "release",
    schema: "rejects",
    mutate: (d) => (sdk(d).ecosystem = "cpan"),
  },
  {
    code: "invalid_package_name",
    file: "release",
    schema: "rejects",
    // npm names are scoped: the scope is the feed's namespace.
    mutate: (d) => (sdk(d).name = "acme-sdk"),
  },
  {
    code: "invalid_package_name",
    file: "release",
    schema: "rejects",
    mutate: (d) => {
      sdk(d).ecosystem = "swift";
      sdk(d).name = "acme";
    },
  },
  {
    code: "invalid_package_name",
    file: "release",
    schema: "rejects",
    mutate: (d) => {
      sdk(d).ecosystem = "maven";
      sdk(d).name = "gg.acme";
    },
  },
  {
    // PEP 503: Acme_SDK and acme-sdk are one PyPI project.
    code: "package_name_collision",
    file: "release",
    schema: "accepts",
    mutate: (d) => {
      sdk(d).ecosystem = "pypi";
      sdk(d).name = "Acme_SDK";
      rel(d).deliverables["acme.sdk2"] = {
        kind: "package",
        ecosystem: "pypi",
        name: "acme-sdk",
        artifacts: { wheel: { match: "*.whl" } },
      };
    },
  },
  {
    // npm compares case-insensitively.
    code: "package_name_collision",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      (rel(d).deliverables["acme.sdk2"] = {
        kind: "package",
        ecosystem: "npm",
        name: "@acme/sdk",
        artifacts: { tarball: { match: "other-*.tgz" } },
      }),
  },
  {
    code: "invalid_package_field",
    file: "release",
    schema: "rejects",
    // A package has no platform: its ecosystem says what it is.
    mutate: (d) => (sdk(d).platform = "macos"),
  },
  {
    code: "invalid_package_field",
    file: "release",
    schema: "rejects",
    mutate: (d) => (sdk(d).type = "godot.zip"),
  },
  {
    code: "invalid_package_field",
    file: "release",
    schema: "rejects",
    mutate: (d) => (sdk(d).artifacts = { tarball: { glob: "*.tgz" } }),
  },
  {
    code: "invalid_package_field",
    file: "release",
    schema: "rejects",
    mutate: (d) => delete sdk(d).artifacts,
  },
  {
    // Counted first, like packs: one error for the whole map. The schema's maxProperties bounds
    // the map as a whole (app + 64 + 64), not packages alone.
    code: "too_many_package_deliverables",
    file: "release",
    schema: "accepts",
    mutate: (d) => {
      for (let i = 0; i < 64; i++)
        rel(d).deliverables[`acme.npm${i}`] = {
          kind: "package",
          ecosystem: "npm",
          name: `@acme/p${i}`,
          artifacts: { tarball: { match: `p${i}-*.tgz` } },
        };
    },
  },
  // ── pack deliverables (P4-02, plans/P4-01.md §3) ──
  {
    // Counted before any pack is validated: one error for the whole map. The schema's
    // maxProperties bounds the whole map (app + 64 packs + 64 packages since F-03), so it rejects
    // only a map past that: 128 more packs here.
    code: "too_many_pack_deliverables",
    file: "release",
    schema: "rejects",
    mutate: (d) => {
      for (let i = 0; i < 128; i++)
        rel(d).deliverables[`acme.extra${i}`] = {
          kind: "pack",
          type: "files.tree",
        };
    },
  },
  {
    code: "invalid_pack_type",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).type = "audio.banks"),
  },
  {
    // custom.<name> is lowercase (P4-16).
    code: "invalid_pack_type",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).type = "custom.Dialogue"),
  },
  // ── formatVersion, mounted types, locales (P4-16) ──
  {
    code: "invalid_pack_format_version",
    file: "release",
    schema: "rejects",
    mutate: (d) => (balance(d).formatVersion = 0),
  },
  {
    // godot.pck's format version is its PCK header's.
    code: "invalid_pack_format_version",
    file: "release",
    schema: "accepts",
    mutate: (d) => (core3d(d).formatVersion = 3),
  },
  {
    // data.json declares the JSON Schema version of its documents.
    code: "invalid_pack_format_version",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete balance(d).formatVersion,
  },
  {
    // A godot.zip mounts directories like a godot.pck.
    code: "invalid_pack_handler",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete mods(d).handler,
  },
  {
    code: "invalid_pack_requires",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete mods(d).requires,
  },
  {
    // A variant value pattern holds it, BCP-47 does not (a 10-letter language subtag).
    code: "invalid_pack_locale",
    file: "release",
    schema: "accepts",
    mutate: (d) => (strings(d).variants.locale = ["en", "abcdefghij"]),
  },
  {
    code: "invalid_pack_type",
    file: "release",
    schema: "rejects",
    mutate: (d) => delete l10n(d).type,
  },
  {
    // pinned, compatible or standalone (P4-12).
    code: "invalid_pack_binding",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).binding = "floating"),
  },
  {
    code: "invalid_pack_policy",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).delivery = "onDemand"),
  },
  {
    code: "invalid_pack_policy",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).baseline = "bundled"),
  },
  {
    // A data-only pack only: script policy false is refused in v1 (S-07 row 13).
    code: "invalid_pack_policy",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).contentPolicy = { dataOnly: false }),
  },
  {
    code: "invalid_pack_policy",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).required = "yes"),
  },
  {
    // A required pack is essential and ungated.
    code: "invalid_pack_policy",
    file: "release",
    schema: "accepts",
    mutate: (d) => (l10n(d).required = true),
  },
  {
    code: "invalid_pack_handler",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).handler.mountOrder = 1001),
  },
  {
    code: "invalid_pack_handler",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).handler.prefixes = ["assets/core/"]),
  },
  {
    code: "invalid_pack_handler",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).handler.activation = "reload"),
  },
  {
    // A godot.pck pack mounts directories and activates on restart.
    code: "invalid_pack_handler",
    file: "release",
    schema: "accepts",
    mutate: (d) => (core3d(d).handler.activation = "hot"),
  },
  {
    // A files.tree pack mounts nothing into res://.
    code: "invalid_pack_handler",
    file: "release",
    schema: "accepts",
    mutate: (d) => (l10n(d).handler.mountOrder = 2),
  },
  {
    code: "invalid_pack_variants",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).variants = { gpu: ["adreno"] }),
  },
  {
    code: "invalid_pack_variants",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).variants.texture = ["s3tc", "s3tc"]),
  },
  {
    // 3 × 3 × 4 = 36 combinations, over the 32-variant bound.
    code: "invalid_pack_variants",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      (core3d(d).variants = {
        texture: ["s3tc", "etc2", "astc"],
        locale: ["en", "fr", "de"],
        quality: ["low", "mid", "high", "ultra"],
      }),
  },
  {
    // features has no meaning yet (P4-12 adds contentApi and packs only).
    code: "invalid_pack_requires",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).requires.features = ["physics"]),
  },
  {
    // A contentApi range is comparators over levels, not a semver range.
    code: "invalid_pack_requires",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).requires.contentApi = { app: "^3.0" }),
  },
  {
    code: "invalid_pack_requires",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).requires.packs = { "acme.l10n": "~1.2" }),
  },
  {
    // requires.packs names a compatible or standalone pack: acme.l10n is pinned.
    code: "invalid_pack_requires",
    file: "release",
    schema: "accepts",
    mutate: (d) => (core3d(d).requires.packs = { "acme.l10n": ">=1.0.0" }),
  },
  // ── compatible and standalone (P4-12) ──
  {
    code: "missing_content_api_range",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).binding = "compatible"),
  },
  {
    code: "standalone_with_content_api",
    file: "release",
    schema: "rejects",
    mutate: (d) => {
      core3d(d).binding = "standalone";
      core3d(d).requires.contentApi = { app: ">=3" };
    },
  },
  {
    // Keyed by app deliverable; the product's only one is app.
    code: "unknown_content_api_app",
    file: "release",
    schema: "accepts",
    mutate: (d) => {
      core3d(d).binding = "compatible";
      core3d(d).requires.contentApi = { client: ">=3" };
    },
  },
  {
    code: "invalid_pack_conflicts",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).conflicts = ["app"]),
  },
  {
    // conflicts names other declared packs.
    code: "invalid_pack_conflicts",
    file: "release",
    schema: "accepts",
    mutate: (d) => (core3d(d).conflicts = ["acme.audio"]),
  },
  {
    // The pack path of the existing code: a pack's channels are canonical names.
    code: "invalid_channel",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).channels = ["Events"]),
  },
  {
    code: "invalid_pack_channels",
    file: "release",
    schema: "rejects",
    mutate: (d) =>
      (app(d).content = { contentApi: 3, packChannels: { "acme.*": "Ev" } }),
  },
  {
    // A packChannels key matches a declared pack that publishes to its channel.
    code: "unknown_pack_channels_target",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      (app(d).content = {
        contentApi: 3,
        packChannels: { "other.*": "events" },
      }),
  },
  {
    // P4-28: an attachable entry is a res:// path or directory, or a canonical uid://.
    code: "invalid_app_attachable",
    file: "release",
    schema: "rejects",
    mutate: (d) =>
      (app(d).content = { contentApi: 3, attachable: ["scripts/die.gd"] }),
  },
  {
    code: "invalid_app_attachable",
    file: "release",
    schema: "rejects",
    mutate: (d) =>
      (app(d).content = {
        contentApi: 3,
        attachable: ["res://scripts/../tools/debug.gd"],
      }),
  },
  {
    code: "invalid_app_attachable",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).content = { contentApi: 3, attachable: [] }),
  },
  {
    // A Windows device name and a non-canonical UID: validator-only.
    code: "invalid_app_attachable",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      (app(d).content = { contentApi: 3, attachable: ["res://con/die.gd"] }),
  },
  {
    code: "invalid_app_attachable",
    file: "release",
    schema: "accepts",
    mutate: (d) =>
      (app(d).content = { contentApi: 3, attachable: ["uid://adw1"] }),
  },
  {
    code: "invalid_pack_requires",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).requires.engine = "4.7"),
  },
  {
    code: "invalid_pack_requires",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete core3d(d).requires,
  },
  {
    code: "unknown_entitlement_ref",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).entitlement = "extras diceSkins"),
  },
  {
    // An assertion must name a flag of the product's schema.
    code: "unknown_entitlement_ref",
    file: "release",
    schema: "accepts",
    mutate: (d) => (l10n(d).entitlement = "extras.diceSkins"),
  },
  {
    code: "invalid_pack_patch",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).patch.strategies = ["bsdiff"]),
  },
  {
    code: "invalid_pack_patch",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).patch.deltaBases = 9),
  },
  {
    code: "pack_field_not_supported",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).removes = ["res://x/"]),
  },
  // ── provides (P4-20) ──
  {
    // A policy object, not the list itself.
    code: "invalid_pack_provides",
    file: "release",
    schema: "rejects",
    mutate: (d) => (l10n(d).provides = ["foe.goblin"]),
  },
  {
    code: "invalid_pack_provides",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).provides.required = "yes"),
  },
  {
    // A misspelt member is refused, never ignored.
    code: "invalid_pack_provides",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).provides.requried = true),
  },
  {
    // Repo-relative, never escaping the repository.
    code: "invalid_pack_provides",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).provides.from = "../content/ids.json"),
  },
  {
    code: "invalid_pack_provides",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).provides.from = "/etc/ids.json"),
  },
  {
    // The pack path of the existing code.
    code: "invalid_version_scheme",
    file: "release",
    schema: "rejects",
    mutate: (d) => (core3d(d).versioning.scheme = "calver"),
  },
  {
    code: "invalid_app_content",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).content = { contentApi: 0 }),
  },
  {
    code: "invalid_app_content",
    file: "release",
    schema: "rejects",
    // Holds are chosen per app release at publish, never declared.
    mutate: (d) => (app(d).content = { contentApi: 3, holds: [] }),
  },
  {
    // Required whenever a pack is declared.
    code: "invalid_app_content",
    file: "release",
    schema: "accepts",
    mutate: (d) => delete app(d).content,
  },
  {
    code: "invalid_build_embeds",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).embeds = ["app"]),
  },
  {
    code: "invalid_build_embeds",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).embeds = ["acme.core3d", "acme.core3d"]),
  },
  {
    // Each names a declared pack.
    code: "invalid_build_embeds",
    file: "release",
    schema: "accepts",
    mutate: (d) => (entry(d).embeds = ["acme.audio"]),
  },
  {
    code: "invalid_version_scheme",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).versioning.scheme = "calver"),
  },
  {
    code: "invalid_version_scheme",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).versioning.buildNumber = "tag"),
  },
  {
    code: "invalid_stable_tag_pattern",
    file: "release",
    schema: "accepts",
    // The nested spelling runs the same rule (validator-only half: it must COMPILE).
    mutate: (d) => {
      delete rel(d).stableTagPattern;
      delete rel(d).ignoreTags;
      app(d).versioning.stableTagPattern = "v(unclosed";
    },
  },
  {
    code: "invalid_ignore_tags",
    file: "release",
    schema: "rejects",
    mutate: (d) => {
      delete rel(d).stableTagPattern;
      delete rel(d).ignoreTags;
      app(d).versioning.ignoreTags = ["has space"];
    },
  },
  {
    code: "conflicting_versioning",
    file: "release",
    schema: "accepts",
    // The root already declares stableTagPattern and ignoreTags (the P0-02 spelling).
    mutate: (d) => (app(d).versioning.ignoreTags = ["packs"]),
  },
  {
    code: "invalid_channel",
    file: "release",
    schema: "rejects",
    // Stored as written, so only canonical names: no upper case, no alias.
    mutate: (d) => (app(d).channels["Beta.2"] = {}),
  },
  {
    code: "invalid_channel",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).channels.staging = { includes: ["stable"] }),
  },
  {
    code: "invalid_channel_includes",
    file: "release",
    schema: "accepts",
    mutate: (d) => (app(d).channels.beta.includes = ["ghost"]),
  },
  {
    code: "invalid_channel_includes",
    file: "release",
    schema: "accepts",
    mutate: (d) => {
      app(d).channels.beta.includes = ["nightly"];
      app(d).channels.nightly = { includes: ["beta"] };
    },
  },
  {
    code: "invalid_channel_includes",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).channels.beta.includes = "stable"),
  },
  {
    code: "invalid_channel_includes",
    file: "release",
    schema: "rejects",
    // A manual channel P0-04 accepts with a warning is still not a canonical includes name:
    // includes are stored as written.
    mutate: (d) => {
      rel(d).manualChannels = [{ name: "Nightly.2", regex: "nightly-.*" }];
      app(d).channels.beta.includes = ["Nightly.2"];
    },
  },
  {
    code: "invalid_channel_includes",
    file: "release",
    schema: "rejects",
    mutate: (d) => {
      rel(d).manualChannels = [{ name: "staging", regex: "staging-.*" }];
      app(d).channels.beta.includes = ["staging"];
    },
  },
  {
    code: "invalid_artifact_entry",
    file: "release",
    schema: "rejects",
    mutate: (d) => delete entry(d).format,
  },
  {
    code: "invalid_artifact_entry",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).id = "Mac OS"),
  },
  {
    code: "invalid_artifact_entry",
    file: "release",
    schema: "rejects",
    mutate: (d) => (app(d).artifacts = { macos: {} }),
  },
  {
    code: "duplicate_artifact_id",
    file: "release",
    schema: "accepts",
    mutate: (d) => (app(d).artifacts[1].id = "macos"),
  },
  {
    // A build named by its arch alone shows as a bare "arm64" wherever its id is shown. A
    // warning: the id is valid, so the schema accepts.
    code: "bare_arch_artifact_id",
    file: "release",
    schema: "accepts",
    mutate: (d) => (entry(d).id = "arm64"),
  },
  {
    code: "invalid_artifact_platform",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).platform = "darwin"),
  },
  {
    code: "invalid_artifact_arch",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).arch = "amd64"),
  },
  {
    code: "invalid_artifact_role",
    file: "release",
    schema: "rejects",
    // README §3.12's `portable` is a FORMAT (zip versus exe/msi), not a role.
    mutate: (d) => (app(d).artifacts[1].role = "portable"),
  },
  {
    code: "invalid_artifact_match",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).match = ""),
  },
  {
    code: "invalid_artifact_match",
    file: "release",
    schema: "rejects",
    mutate: (d) => (entry(d).match = "*".repeat(129)),
  },
  {
    code: "invalid_edge_mint_id",
    file: "product",
    schema: "rejects",
    mutate: (d) => (mint(d).id = "bad id!"),
  },
  {
    code: "invalid_edge_mint_kid",
    file: "product",
    schema: "rejects",
    mutate: (d) => (mint(d).kid = "bad kid!"),
  },
  {
    code: "invalid_edge_mint_audience",
    file: "product",
    schema: "rejects",
    mutate: (d) => (mint(d).audience = "x".repeat(300)),
  },
  {
    code: "invalid_edge_mint_alg",
    file: "product",
    schema: "rejects",
    mutate: (d) => (mint(d).alg = "HS256"),
  },
  {
    code: "invalid_ttl",
    file: "product",
    schema: "rejects",
    mutate: (d) => (mint(d).ttlSeconds = 0),
  },
  // HA-04: `.pkey/product` `presentation { icon, accent, accentDark }`.
  {
    code: "invalid_presentation",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).presentation = "brand.png"),
  },
  {
    code: "invalid_presentation",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).presentation.accent = "teal"),
  },
  {
    code: "invalid_presentation",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).presentation.accentDark = "#12345"),
  },
  {
    code: "invalid_asset_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).presentation.icon = "../shared/icon.png"),
  },
  {
    code: "invalid_asset_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).presentation.icon = "ftp://acme.example/icon.png"),
  },
  {
    code: "invalid_asset_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) =>
      (p(d).presentation.icon = { src: "icon.png", hash: "a".repeat(64) }),
  },
  {
    code: "invalid_asset_ref",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).presentation.icon = `${"a/".repeat(260)}icon.png`),
  },
  {
    code: "invalid_web_origins",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).web = "https://app.acme.example"),
  },
  {
    code: "invalid_web_origins",
    file: "product",
    schema: "rejects",
    // One over the cap of 16, every entry individually valid and distinct.
    mutate: (d) =>
      (p(d).web.origins = Array.from(
        { length: 17 },
        (_, i) => `https://app${i}.acme.example`,
      )),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).web.origins[0] = "https://app.acme.example/play"),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).web.origins[0] = "https://*.acme.example"),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).web.origins[0] = "https://APP.acme.example"),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "rejects",
    // Plain http is for the two loopback hosts only.
    mutate: (d) => (p(d).web.origins[0] = "http://app.acme.example"),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "rejects",
    mutate: (d) => (p(d).web.origins[0] = "https://user@app.acme.example"),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "rejects",
    mutate: (d) => p(d).web.origins.push("https://app.acme.example"),
  },
  {
    code: "invalid_web_origin",
    file: "product",
    schema: "accepts",
    // The validator-only half: the pattern admits an explicit port, but only the URL round
    // trip knows that :443 is https's default and a browser would never send it.
    mutate: (d) => (p(d).web.origins[0] = "https://app.acme.example:443"),
  },

  // ── value_not_representable (P3-12, plans/P3-01.md §2.2) ──
  // Validator-only: JSON Schema cannot say "no lone surrogate", "no U+0000 in a member name",
  // "no two names equal after NFC" or "no number below 1e-307" over arbitrary values, and these
  // land on the values the manifest sync alone writes (provisioning values, catalog defaults,
  // edge-mint claims templates), which the schemas type loosely on purpose.
  {
    code: "value_not_representable",
    file: "product",
    schema: "accepts",
    mutate: (d) =>
      (p(d).provisioning[0].entitlementValue = { "a\u0000b": true }),
  },
  {
    code: "value_not_representable",
    file: "product",
    schema: "accepts",
    mutate: (d) => (p(d).provisioning[0].entitlementValue = "x\ud800"),
  },
  {
    code: "value_not_representable",
    file: "schema",
    schema: "accepts",
    mutate: (d) =>
      ((d.schema as Record<string, any>).entries[0].examples = [
        { "\u00e9": 1, "e\u0301": 2 },
      ]),
  },
  {
    code: "value_not_representable",
    file: "schema",
    schema: "accepts",
    mutate: (d) =>
      ((d.schema as Record<string, any>).entries[0].examples = [1e-320]),
  },
  {
    code: "value_not_representable",
    file: "product",
    schema: "accepts",
    mutate: (d) => (mint(d).claimsTemplate = { sub: "\udc00" }),
  },

  // ── .pkey/distribution (P2b-02) ──
  {
    code: "invalid_distribution",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (d.distribution = ["direct"]),
  },
  {
    code: "invalid_api_version",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).apiVersion = "pkey.dev/v2"),
  },
  {
    code: "invalid_outlet_id",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).outlets["Steam_Main"] = { kind: "steam" }),
  },
  {
    code: "invalid_outlet_id",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).outlets = ["direct"]),
  },
  {
    code: "unknown_outlet_kind",
    file: "distribution",
    schema: "rejects",
    // An id that is not itself a kind must say which kind it is.
    mutate: (d) => (dist(d).outlets["mystery-store"] = {}),
  },
  {
    code: "unknown_outlet_kind",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "altstore-beta").kind = "altstore-classic"),
  },
  {
    code: "outlet_kind_mismatch",
    file: "distribution",
    schema: "rejects",
    // An id that IS a kind cannot be re-kinded: that would swap the App Store outlet's store
    // capability defaults for the self-hosted ones.
    mutate: (d) => (outlet(d, "app-store").kind = "web"),
  },
  {
    code: "outlet_kind_mismatch",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).outlets.steam = { kind: "direct" }),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).outlets.web = "yes"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "app-store").bundleId = "not a bundle id"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "play").packageName = "1acme"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "steam").appId = "0480"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    // A Flatpak id on steam is the wrong kind of appId: `appId` is numeric there.
    mutate: (d) => (outlet(d, "steam").appId = "com.acme.Desktop"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    // ...and a numeric one on flathub.
    mutate: (d) => (outlet(d, "flathub").appId = 480),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    // itch.gameId (notes/S-06): the receipt's numeric game id, never the butler slug.
    mutate: (d) => (outlet(d, "itch").gameId = "acme/desktop"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "itch").gameId = -3),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "itch").target = "desktop"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    // packageFamilyName (notes/S-06): <Name>_<PublisherId>, a 13-character publisher id.
    mutate: (d) =>
      (outlet(d, "ms-store").packageFamilyName = "Acme.Desktop_abc"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "app-installer").packageFamilyName = "Acme.Desktop"),
  },
  {
    // app-installer.publisher (P3-09): the certificate subject DN, CN= first.
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "app-installer").publisher = "O=Acme, CN=Acme"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "app-installer").updateSettings = {
        hoursBetweenUpdateChecks: 256,
      }),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "app-installer").updateSettings = {
        forceUpdateFromAnyVersion: true,
      }),
  },
  {
    // UpdateBlocksActivation is ignored without ShowPrompt.
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "app-installer").updateSettings = {
        updateBlocksActivation: true,
      }),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    // direct.homebrewCask (notes/S-06): lower-case letters, digits, -, . and @ only.
    mutate: (d) => (outlet(d, "direct").homebrewCask = "Acme Desktop"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    // direct.homebrewFormula (P3-11): lower-case, starting with a letter or digit.
    mutate: (d) => (outlet(d, "direct").homebrewFormula = "Acme/Formula"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "direct").platforms = ["macos", "amiga"]),
  },
  {
    // direct.scoop (P2b-05): a relative path, never one that climbs out of the archive.
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "direct").scoop = { bin: "..\\evil.exe" }),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "direct").scoop = { shortcuts: [["acme.exe", "A/B"]] }),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "direct").scoop = { bin: [], extra: 1 }),
  },
  {
    // A Scoop install is a Windows install.
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "direct").platforms = ["macos", "linux"]),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "ms-store").productId = "9NBL"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "snap").name = "Acme_Desktop"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "winget").packageIdentifier = "AcmeDesktop"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "altstore-pal").marketplaceId = "-bad"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "app-store").appleId = 1.5),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "obtainium").artifact = "Not An Id"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "testflight").publicLink = "join/AbCd"),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "play").tracks = { stable: "" }),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "steam").branches = ["beta"]),
  },
  {
    code: "invalid_outlet_identity",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "ms-store").flights = { beta: "-beta" }),
  },
  {
    code: "unknown_artifact_ref",
    file: "distribution",
    schema: "accepts",
    mutate: (d) => (outlet(d, "altstore").artifact = "ipa-appstore"),
  },
  {
    code: "unknown_channel_ref",
    file: "distribution",
    schema: "accepts",
    mutate: (d) => (outlet(d, "play").tracks.canary = "internal"),
  },
  {
    code: "unknown_channel_ref",
    file: "distribution",
    schema: "accepts",
    mutate: (d) => (outlet(d, "steam").branches.events = "events"),
  },
  {
    code: "unknown_channel_ref",
    file: "distribution",
    schema: "accepts",
    mutate: (d) => (outlet(d, "ms-store").flights.canary = "Canary ring"),
  },
  {
    // F-03 (plans/F-01.md §3.3): a package is served only by its feed, never by a transport.
    code: "invalid_transport_deliverable",
    file: "distribution",
    schema: "accepts",
    mutate: (d) =>
      (dist(d).transports.deliverables["acme.sdk"] = { steam: "embedded" }),
  },
  {
    code: "unknown_deliverable_ref",
    file: "distribution",
    schema: "accepts",
    mutate: (d) =>
      (dist(d).transports.deliverables["acme.levels"] = { steam: "embedded" }),
  },
  {
    code: "invalid_transport",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).transports.packs.steam = "carrier-pigeon"),
  },
  {
    code: "invalid_transport",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).transports = "pkey-cdn"),
  },
  {
    code: "invalid_transport",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).transports.default = "bittorrent"),
  },
  {
    code: "transport_not_allowed",
    file: "distribution",
    schema: "accepts",
    // apple-ba is App Store / TestFlight only; which kind an outlet id has is a cross-reference.
    mutate: (d) => (dist(d).transports.packs.play = "apple-ba"),
  },
  {
    code: "transport_not_allowed",
    file: "distribution",
    schema: "rejects",
    // `default` applies to every outlet, so it is limited to the transports any outlet carries.
    mutate: (d) => (dist(d).transports.default = "steam-depot"),
  },
  {
    code: "unknown_outlet_ref",
    file: "distribution",
    schema: "accepts",
    mutate: (d) => (dist(d).transports.packs["epic-store"] = "pkey-cdn"),
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.iconUrl = "http://acme.example/icon.png"),
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.tintColor = "red"),
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.name = "two\nlines"),
  },
  {
    code: "invalid_asset_ref",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (dist(d).listing.screenshots = ["https://a.example/1.png", 7]),
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    // More than 16 screenshots is the list's shape, not one ref's spelling.
    mutate: (d) =>
      (dist(d).listing.screenshots = Array.from(
        { length: 17 },
        (_, i) => `art/${i}.png`,
      )),
  },
  // HA-04: listing art as asset refs (an https URL or a repo path, optionally { src, sha256 }).
  {
    code: "invalid_asset_ref",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.icon = "http://acme.example/icon.png"),
  },
  {
    code: "invalid_asset_ref",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.header = "art/../../secrets/header.png"),
  },
  {
    code: "invalid_asset_ref",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.header = { src: "/etc/header.png" }),
  },
  {
    code: "invalid_asset_ref",
    file: "distribution",
    schema: "rejects",
    // SVG is never an accepted image (it can carry script).
    mutate: (d) => (dist(d).listing.screenshots = ["art/shot.svg"]),
  },
  {
    code: "invalid_asset_ref",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "altstore-beta").listing = {
        icon: { src: "icon.png", sha256: "ABC" },
      }),
  },
  {
    code: "listing_field_conflict",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (dist(d).listing.iconUrl = "https://acme.example/old-icon.png"),
  },
  {
    code: "listing_field_conflict",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (outlet(d, "altstore-beta").listing = {
        header: "art/beta-header.png",
        headerUrl: "https://acme.example/beta-header.png",
      }),
  },
  {
    // A warning, not an error: the alias still validates and normalises into `icon`.
    code: "listing_url_field_deprecated",
    file: "distribution",
    schema: "accepts",
    mutate: (d) => {
      delete dist(d).listing.icon;
      dist(d).listing.iconUrl = "https://acme.example/icon.png";
    },
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "altstore-beta").listing = { subtitle: 3 }),
  },
  // PX-W1: the portal's support links (G16).
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.supportUrl = "mailto:help@acme.example"),
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).listing.supportEmail = "help at acme.example"),
  },
  {
    code: "invalid_listing",
    file: "distribution",
    schema: "rejects",
    mutate: (d) =>
      (dist(d).listing.supportEmail = `${"a".repeat(250)}@acme.example`),
  },
  {
    code: "capabilities_not_manifest_writable",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (outlet(d, "steam").capabilities = { codeUpdates: true }),
  },
  {
    code: "capabilities_not_manifest_writable",
    file: "distribution",
    schema: "rejects",
    mutate: (d) => (dist(d).capabilities = { direct: { commerce: "own" } }),
  },
  {
    code: "capabilities_not_manifest_writable",
    file: "distribution",
    schema: "rejects",
    // A kind-less id goes through the explicit-kind branch of the schema; still refused.
    mutate: (d) =>
      (outlet(d, "altstore-beta").capabilities = { downloadedScripts: true }),
  },
  // ── ST-19: duplicate spellings (plans/ST-19.md §3.3). Warnings, and the schemas still accept
  //    every old spelling (they only mark it `deprecated`), so every entry is "accepts". ──
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 1,
    mutate: flatten,
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 2,
    mutate: (d) => {
      p(d).adminGroup = p(d).product.adminGroup;
      delete p(d).product.adminGroup;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 3,
    mutate: (d) => {
      p(d).product.defaultDeviceLimit = p(d).licensing.defaultDeviceLimit;
      delete p(d).licensing.defaultDeviceLimit;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 4,
    mutate: (d) => {
      p(d).defaultMaxOfflineDays = p(d).licensing.defaultMaxOfflineDays;
      delete p(d).licensing.defaultMaxOfflineDays;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 5,
    mutate: (d) => {
      p(d).tiers = p(d).licensing.tiers;
      delete p(d).licensing.tiers;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 6,
    mutate: (d) => {
      p(d).profiles = p(d).licensing.profiles;
      delete p(d).licensing.profiles;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 7,
    mutate: (d) => {
      const tier = p(d).licensing.tiers[0];
      tier.profile = tier.profileId;
      delete tier.profileId;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 8,
    mutate: (d) => (p(d).licensing.tiers[0].expiryDays = 30),
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 9,
    mutate: (d) => {
      const profile = p(d).licensing.profiles[0];
      profile.label = profile.name;
      delete profile.name;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 10,
    mutate: (d) => {
      p(d).oidc.clientSecretRef = p(d).oidc.clientSecretSecret;
      delete p(d).oidc.clientSecretSecret;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 11,
    mutate: (d) => {
      p(d).release = rel(d);
      delete d.release;
    },
  },
  {
    code: "deprecated_spelling",
    file: "product",
    schema: "accepts",
    row: 12,
    mutate: (d) => {
      p(d).modules.licensing = p(d).modules.license;
      delete p(d).modules.license;
    },
  },
  {
    code: "deprecated_spelling",
    file: "schema",
    schema: "accepts",
    row: 13,
    mutate: (d) => {
      const schema = d.schema as Record<string, any>;
      schema.catalog = schema.entries;
      delete schema.entries;
    },
  },
  {
    code: "deprecated_spelling",
    file: "release",
    schema: "accepts",
    row: 14,
    mutate: unwrap,
  },
  {
    code: "deprecated_spelling",
    file: "release",
    schema: "accepts",
    row: 15,
    mutate: (d) => {
      rel(d).ghOwner = rel(d).provider.owner;
      rel(d).ghRepo = rel(d).provider.repo;
      delete rel(d).provider;
    },
  },
  {
    code: "deprecated_spelling",
    file: "release",
    schema: "accepts",
    row: 17,
    mutate: (d) => {
      (d.release as Record<string, any>).edgeMint = p(d).edgeMint;
      delete p(d).edgeMint;
    },
  },
  {
    code: "conflicting_spelling",
    file: "product",
    schema: "accepts",
    row: 3,
    mutate: (d) => (p(d).defaultDeviceLimit = 9),
  },
  {
    code: "conflicting_spelling",
    file: "schema",
    schema: "accepts",
    row: 13,
    mutate: (d) => ((d.schema as Record<string, any>).catalog = []),
  },
  {
    code: "conflicting_spelling",
    file: "release",
    schema: "accepts",
    row: 15,
    mutate: (d) => (rel(d).ghOwner = "acme-org"),
  },
];

describe("valid manifests pass both validators", () => {
  it("the rich base fixture", () => {
    const docs = base();
    expect(tsCodes(docs)).toEqual([]);
    // ST-19: `base()` is written in the canonical spellings only.
    expect(tsCodes(docs)).not.toContain("deprecated_spelling");
    expect(schemaAccepts(docs)).toEqual({
      product: true,
      schema: true,
      release: true,
      distribution: true,
    });
  });

  it("an architecture longer than 32 characters (the validator's CHANNEL_RE bound, P0-01)", () => {
    // The schema used to cap architectures at 32 characters while the authoritative validator
    // allowed 64, so an editor flagged manifests the platform accepts. Pin both ends of the
    // validator's range so the drift cannot return.
    for (const arch of ["a".repeat(40), "a".repeat(64)]) {
      const docs = base();
      rel(docs).artifactPolicy.architectures = ["arm64", arch];
      expect(tsCodes(docs)).toEqual([]);
      expect(
        validateRelease(docs.release),
        JSON.stringify(validateRelease.errors),
      ).toBe(true);
    }
  });

  it("the alias shapes (flattened root, licensing nesting, clientSecretRef, tier.profile) stay valid and warn (ST-19)", () => {
    const docs: Docs = {
      product: {
        slug: "acme",
        name: "Acme",
        compatMin: "1.0.0",
        profiles: [{ id: "base", label: "Base" }],
        tiers: [{ id: "free", profile: "base", expiryDays: 30 }],
        oidc: {
          provider: "platform",
          clientSecretRef: "OIDC_SECRET",
          redirectUris: [],
        },
      },
      schema: { schemaVersion: 1, catalog: [] },
    };
    const res = validateIngestDocuments(docs);
    expect(res.errors).toEqual([]);
    expect(
      res.warnings.map((w) => `${w.code} ${w.file}${w.path}`).sort(),
    ).toEqual(
      [
        "product/slug",
        "product/name",
        "product/compatMin",
        "product/tiers",
        "product/profiles",
        "product/tiers/0/profile",
        "product/tiers/0/expiryDays",
        "product/profiles/0/label",
        "product/oidc/clientSecretRef",
        "schema/catalog",
      ]
        .map((at) => `deprecated_spelling ${at}`)
        .sort(),
    );
    expect(schemaAccepts(docs)).toEqual({
      product: true,
      schema: true,
      release: true,
      distribution: true,
    });
  });

  it("the nested versioning spelling, and a Diceroll-shaped artifact map (README §3.12)", () => {
    const docs = base();
    delete rel(docs).stableTagPattern;
    delete rel(docs).ignoreTags;
    rel(docs).deliverables = {
      app: {
        kind: "app",
        versioning: {
          scheme: "semver",
          stableTagPattern: "v\\d+\\.\\d+\\.\\d+",
          ignoreTags: ["channels", "packs"],
          buildNumber: "descriptor",
        },
        channels: { beta: { includes: ["stable"] } },
        artifacts: [
          ["macos", "macos", "universal", "dmg", "Diceroll-*-macos.dmg"],
          [
            "win-zip",
            "windows",
            "x86_64",
            "zip",
            "Diceroll-*-windows-x86_64.zip",
          ],
          [
            "linux-x64",
            "linux",
            "x86_64",
            "tar.gz",
            "Diceroll-*-linux-x86_64.tar.gz",
          ],
          ["apk", "android", "any", "apk", "Diceroll-*-android.apk"],
          [
            "ipa-sideload",
            "ios",
            "arm64",
            "ipa",
            "Diceroll-*-ios-sideload.ipa",
          ],
          ["web", "web", "wasm32", "zip", "Diceroll-*-web.zip"],
        ].map(([id, platform, arch, format, match]) => ({
          id,
          platform,
          arch,
          format,
          match,
        })),
      },
    };
    expect(tsCodes(docs)).toEqual([]);
    expect(
      validateRelease(docs.release),
      JSON.stringify(validateRelease.errors),
    ).toBe(true);
  });

  it("the schema's vocabularies are exactly the validator's constants", () => {
    const schema = JSON.parse(
      readFileSync(join(schemasDir, "release.schema.json"), "utf8"),
    );
    const entry = schema.$defs.artifactEntry.properties;
    expect(entry.platform.enum).toEqual([...RELEASE_PLATFORMS]);
    expect(entry.arch.enum).toEqual([...RELEASE_ARCHES]);
    expect(entry.role.enum).toEqual([...ARTIFACT_ROLES]);
    const app = schema.$defs.appDeliverable.properties;
    expect(app.versioning.properties.scheme.enum).toEqual([...VERSION_SCHEMES]);
    expect(app.versioning.properties.buildNumber.enum).toEqual([
      ...BUILD_NUMBER_SOURCES,
    ]);
    expect(app.channels.propertyNames.not.enum).toEqual([
      ...CHANNEL_ALIAS_NAMES,
    ]);
  });

  it("the distribution schema's vocabularies are exactly the validator's constants", () => {
    const schema = JSON.parse(
      readFileSync(join(schemasDir, "distribution.schema.json"), "utf8"),
    );
    expect(schema.$defs.outletKind.enum).toEqual([...OUTLET_KINDS]);
    expect(Object.keys(schema.properties.outlets.properties)).toEqual([
      ...OUTLET_KINDS,
    ]);
    expect(schema.$defs.transport.enum).toEqual([...TRANSPORTS]);
    expect(schema.$defs.transports.properties.default.enum).toEqual(
      TRANSPORTS.filter((t) => TRANSPORT_OUTLET_KINDS[t] === null),
    );
    expect(schema.$defs.platforms.items.enum).toEqual([...RELEASE_PLATFORMS]);
    for (const kind of OUTLET_KINDS) {
      const props = schema.$defs[`outlet_${kind}`].properties;
      // An id that is itself a kind may only repeat it (outlet_kind_mismatch).
      expect(props.kind, kind).toEqual({ const: kind });
      expect(schema.properties.outlets.properties[kind], kind).toEqual({
        $ref: `#/$defs/outlet_${kind}`,
      });
      const fields = Object.keys(props).filter(
        (k) => k !== "kind" && k !== "listing" && k !== "capabilities",
      );
      expect(fields, kind).toEqual([...OUTLET_IDENTITY_FIELDS[kind]]);
    }
  });

  it("a minimal distribution document, and none at all", () => {
    for (const distribution of [
      undefined,
      {},
      { listing: { name: "Acme" } },
      { outlets: {} },
      { outlets: { "itch-demo": { kind: "itch", gameId: 1001 } } },
    ]) {
      const docs = base();
      docs.distribution = distribution;
      expect(tsCodes(docs), JSON.stringify(distribution)).toEqual([]);
      expect(schemaAccepts(docs).distribution).toBe(true);
    }
  });

  it("a distribution document is validated with the distribution service off", () => {
    const docs = base();
    delete p(docs).modules.distribution;
    delete p(docs).modules.update;
    outlet(docs, "steam").capabilities = { codeUpdates: true };
    expect(tsCodes(docs)).toContain("capabilities_not_manifest_writable");
  });

  it("the real djdl fixtures in products/", () => {
    const product = JSON.parse(
      readFileSync(join(repoRoot, "products", "djdl", "product.json"), "utf8"),
    );
    const catalog = JSON.parse(
      readFileSync(join(repoRoot, "products", "djdl", "catalog.json"), "utf8"),
    );
    expect(
      validateProduct(product),
      JSON.stringify(validateProduct.errors),
    ).toBe(true);
    expect(
      validateSchemaDoc(catalog),
      JSON.stringify(validateSchemaDoc.errors),
    ).toBe(true);
    const res = validateManifestDocuments({ product, schema: catalog });
    expect(res.errors).toEqual([]);
    // ST-19 (plans/ST-19.md §3.3): the fixture mirrors djdl's flat product.json, so it warns on
    // exactly the deprecated spellings it uses (rows 1–5 and 11; it declares no profiles).
    expect(res.warnings.map((w) => `${w.code} ${w.file}${w.path}`)).toEqual(
      [
        "/slug",
        "/name",
        "/adminGroup",
        "/compatMin",
        "/compatMax",
        "/defaultDeviceLimit",
        "/defaultMaxOfflineDays",
        "/tiers",
        "/release",
      ].map((at) => `deprecated_spelling product${at}`),
    );
  });
});

describe("compatible and standalone packs (P4-12)", () => {
  it("a Diceroll-shaped set of bindings, requires, conflicts, channels and packChannels passes both", () => {
    const docs = base();
    rel(docs).deliverables["acme.foes"] = {
      kind: "pack",
      type: "files.tree",
      binding: "compatible",
      requires: {
        contentApi: { app: ">=3 <5" },
        packs: { "acme.lore": ">=1.0.0 <2.0.0" },
      },
      conflicts: ["acme.audio"],
    };
    rel(docs).deliverables["acme.lore"] = {
      kind: "pack",
      type: "files.tree",
      binding: "standalone",
    };
    rel(docs).deliverables["acme.audio"] = {
      kind: "pack",
      type: "files.tree",
      binding: "compatible",
      requires: { contentApi: { app: "3" } },
    };
    rel(docs).deliverables["acme.events.halloween"] = {
      kind: "pack",
      type: "files.tree",
      binding: "compatible",
      channels: ["events"],
      requires: { contentApi: { app: ">=3" } },
    };
    app(docs).content = {
      contentApi: 3,
      packChannels: { "acme.events.*": "events" },
    };
    expect(tsCodes(docs)).toEqual([]);
    expect(
      validateRelease(docs.release),
      JSON.stringify(validateRelease.errors),
    ).toBe(true);
    const m = parseManifest({
      product: JSON.stringify(docs.product),
      schema: JSON.stringify(docs.schema),
      release: JSON.stringify(docs.release),
    });
    if (!m.ok) throw new Error(m.errors.join("; "));
    const foes = m.manifest.release!.packDeliverables.find(
      (p) => p.id === "acme.foes",
    )!;
    expect(foes.binding).toBe("compatible");
    expect(foes.requires).toEqual({
      contentApi: { app: ">=3 <5" },
      packs: { "acme.lore": ">=1.0.0 <2.0.0" },
    });
    expect(foes.conflicts).toEqual(["acme.audio"]);
    expect(
      m.manifest.release!.packDeliverables.find(
        (p) => p.id === "acme.events.halloween",
      )!.channels,
    ).toEqual(["events"]);
    expect(m.manifest.release!.app!.content).toEqual({
      contentApi: 3,
      packChannels: { "acme.events.*": "events" },
    });
  });
});

describe("the pack schema's vocabularies are the validator's constants (P4-02)", () => {
  it("packDeliverable enums", () => {
    const schema = JSON.parse(
      readFileSync(join(schemasDir, "release.schema.json"), "utf8"),
    );
    const pack = schema.$defs.packDeliverable.properties;
    expect(pack.type.anyOf[0].enum).toEqual([...MANIFEST_PACK_TYPES]);
    expect(pack.type.anyOf[1].pattern).toBe(CUSTOM_PACK_TYPE_PATTERN.source);
    expect(pack.formatVersion.maximum).toBe(MAX_PACK_FORMAT_VERSION);
    for (const t of PACK_TYPES) expect(MANIFEST_PACK_TYPES).toContain(t);
    expect(pack.binding.enum).toEqual([...PACK_BINDINGS]);
    expect(pack.baseline.enum).toEqual([...PACK_BASELINES]);
    expect(pack.delivery.enum).toEqual([...PACK_DELIVERIES]);
    expect(pack.handler.properties.activation.enum).toEqual([
      ...PACK_ACTIVATIONS,
    ]);
    expect(pack.variants.propertyNames.enum).toEqual([...VARIANT_AXES]);
    expect(pack.patch.properties.strategies.items.enum).toEqual([
      ...PACK_PATCH_STRATEGIES,
    ]);
    // app + the packs + (F-03) the packages, each counted by the validator.
    expect(schema.$defs.deliverables.maxProperties).toBe(
      MAX_PACK_DELIVERABLES + MAX_PACKAGE_DELIVERABLES + 1,
    );
    for (const field of PACK_FIELDS_NOT_SUPPORTED)
      expect(pack[field]).toBe(false);
    expect(pack.provides.properties.from.pattern).toBe(
      PROVIDES_FILE_PATTERN.source.replaceAll("\\/", "/"),
    );
  });
});

describe("every validator code has a mutation, and the schemas catch what they claim", () => {
  it("the mutation table covers every code the validator source emits", () => {
    // `.pkey/distribution`'s rules live in their own module (P2b-02), and the duplicate-spelling
    // pass in its own (ST-19), but both are part of the same validator, so every source is swept.
    const source = ["index.ts", "distribution.ts", "spellings.ts"]
      .map((f) => readFileSync(join(here, "..", "src", f), "utf8"))
      .join("\n");
    // Codes appear as the 4th argument of add(...) and the 5th of the constrained/bounded
    // helpers; both shapes put the code as the first "snake_case" string literal after the
    // path argument. Prettier keeps these calls stable enough for a literal sweep.
    const emitted = new Set(
      [...source.matchAll(/"((?:[a-z]+_)+[a-z]+)"/g)]
        .map((m) => m[1]!)
        .filter((code) => !EXTRACTION_NOISE.has(code)),
    );
    const covered = new Set(MUTATIONS.map((m) => m.code));
    const missing = [...emitted].filter((code) => !covered.has(code));
    expect(
      missing,
      `validator codes without a mutation: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  for (const mutation of MUTATIONS) {
    it(`${mutation.code} (schema ${mutation.schema})`, () => {
      const docs = base();
      mutation.mutate(docs);
      expect(tsCodes(docs), "TS validator must emit the code").toContain(
        mutation.code,
      );

      const accepted = schemaAccepts(docs);
      if (mutation.schema === "rejects") {
        expect(
          accepted[mutation.file],
          "schema claimed to catch this and did not",
        ).toBe(false);
      } else {
        // Validator-only rule (cross-reference / cross-document): the schema accepting it is
        // the DOCUMENTED state, not an accident — this branch is what makes that explicit.
        expect(accepted[mutation.file]).toBe(true);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ST-19: every row of DEPRECATED_SPELLINGS (plans/ST-19.md §3.3). For each spelling: its code is
// emitted at its pointer, its conflict code when the canonical spelling is also set, the parsed
// value is the side the row says wins, and its row has a hand-written mutation above.
// ═══════════════════════════════════════════════════════════════════════════════════════════

type DocName = DeprecatedSpelling["doc"];

/** A concrete pointer (no `*`) inside `docs[doc]`; `""` is the whole document. */
function getAt(docs: Docs, doc: DocName, pointer: string): unknown {
  let node: unknown = docs[doc];
  for (const seg of pointer.split("/").slice(1))
    node = (node as Record<string, unknown> | undefined)?.[seg];
  return node;
}
function putAt(docs: Docs, doc: DocName, pointer: string, value: unknown) {
  if (pointer === "") {
    (docs as Record<string, unknown>)[doc] = value;
    return;
  }
  const segs = pointer.split("/").slice(1);
  let node = docs[doc] as Record<string, unknown>;
  for (const seg of segs.slice(0, -1)) {
    if (typeof node[seg] !== "object" || node[seg] === null) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs.at(-1)!] = structuredClone(value);
}
function delAt(docs: Docs, doc: DocName, pointer: string) {
  if (pointer === "") {
    delete (docs as Record<string, unknown>)[doc];
    return;
  }
  const segs = pointer.split("/").slice(1);
  const parent = getAt(
    docs,
    doc,
    `/${segs.slice(0, -1).join("/")}`.replace(/\/$/, ""),
  );
  if (parent && typeof parent === "object")
    delete (parent as Record<string, unknown>)[segs.at(-1)!];
}

interface SpellingCase {
  /** Applied in both scenarios, before anything else. */
  setup?: (d: Docs) => void;
  /** Applied only when the old spelling stands alone. */
  setupAlone?: (d: Docs) => void;
  /** The value written at the old spelling (omitted: leave what the setup wrote). */
  old?: unknown;
  /** The value written at the canonical spelling when both are set (omitted: keep base's). */
  canon?: unknown;
  /** Where the parsed manifest exposes the value, and what each scenario must yield. */
  read?: (m: ParsedManifest) => unknown;
  alone?: unknown;
  both?: unknown;
  /** A concrete path for a `*` that is not an array index (row 18's outlet id). */
  at?: string;
  canonAt?: string;
}

const baseRelease = () => rel(base());
const tiersWithLabel = (label: string) => {
  const tiers = structuredClone(p(base()).licensing.tiers);
  tiers[0].label = label;
  return tiers;
};
const profilesWithName = (name: string) => {
  const profiles = structuredClone(p(base()).licensing.profiles);
  profiles[0].name = name;
  return profiles;
};
const altProfile = (d: Docs) =>
  p(d).licensing.profiles.push({ id: "alt", name: "Alt" });
const rootTiers = (d: Docs) => {
  altProfile(d);
  p(d).tiers = p(d).licensing.tiers;
  delete p(d).licensing.tiers;
};
const rootProfiles = (d: Docs) => {
  p(d).profiles = p(d).licensing.profiles;
  delete p(d).licensing.profiles;
};
const mintAs = (id: string) => [
  { ...structuredClone(p(base()).edgeMint[0]), id },
];

const SPELLING_CASES: Record<string, SpellingCase> = {
  "product/slug": {
    setupAlone: flatten,
    old: "acme2",
    canon: "acme",
    read: (m) => m.product.slug,
    alone: "acme2",
    both: "acme",
  },
  "product/name": {
    setupAlone: flatten,
    old: "Old",
    canon: "Acme",
    read: (m) => m.product.name,
    alone: "Old",
    both: "Acme",
  },
  "product/adminGroup": {
    old: "ops",
    canon: "admins",
    read: (m) => m.product.adminGroup,
    alone: "ops",
    both: "admins",
  },
  "product/compatMin": {
    old: "2.0.0",
    canon: "1.0.0",
    read: (m) => m.product.compatMin,
    alone: "2.0.0",
    both: "1.0.0",
  },
  "product/compatMax": {
    old: "50.0.0",
    canon: "99.0.0",
    read: (m) => m.product.compatMax,
    alone: "50.0.0",
    both: "99.0.0",
  },
  "product/product/defaultDeviceLimit": {
    old: 7,
    canon: 5,
    read: (m) => m.product.defaultDeviceLimit,
    alone: 7,
    both: 7,
  },
  "product/defaultDeviceLimit": {
    old: 8,
    canon: 5,
    read: (m) => m.product.defaultDeviceLimit,
    alone: 8,
    both: 8,
  },
  "product/product/defaultMaxOfflineDays": {
    old: 40,
    canon: 30,
    read: (m) => m.product.defaultMaxOfflineDays,
    alone: 40,
    both: 40,
  },
  "product/defaultMaxOfflineDays": {
    old: 45,
    canon: 30,
    read: (m) => m.product.defaultMaxOfflineDays,
    alone: 45,
    both: 45,
  },
  "product/tiers": {
    old: tiersWithLabel("Old"),
    read: (m) => m.tiers[0]?.label,
    alone: "Old",
    both: "Old",
  },
  "product/profiles": {
    old: profilesWithName("Old"),
    read: (m) => m.profiles[0]?.name,
    alone: "Old",
    both: "Old",
  },
  "product/licensing/tiers/*/profile": {
    setup: altProfile,
    old: "alt",
    canon: "base",
    read: (m) => m.tiers[0]?.profileId,
    alone: "alt",
    both: "base",
  },
  "product/tiers/*/profile": {
    setup: rootTiers,
    old: "alt",
    canon: "base",
    read: (m) => m.tiers[0]?.profileId,
    alone: "alt",
    both: "base",
  },
  "product/licensing/tiers/*/expiryDays": {
    old: 10,
    canon: 20,
    read: (m) => m.tiers[0]?.policyExpiryDays,
    alone: 10,
    both: 20,
  },
  "product/tiers/*/expiryDays": {
    setup: rootTiers,
    old: 10,
    canon: 20,
    read: (m) => m.tiers[0]?.policyExpiryDays,
    alone: 10,
    both: 20,
  },
  "product/licensing/profiles/*/label": {
    old: "Old",
    read: (m) => m.profiles[0]?.name,
    alone: "Old",
    both: "Base profile",
  },
  "product/profiles/*/label": {
    setup: rootProfiles,
    old: "Old",
    read: (m) => m.profiles[0]?.name,
    alone: "Old",
    both: "Base profile",
  },
  "product/oidc/clientSecretRef": {
    old: "OTHER_SECRET",
    read: (m) => m.oidc?.clientSecretSecret,
    alone: "OTHER_SECRET",
    both: "OIDC_CLIENT_SECRET",
  },
  "product/release": {
    old: { ...baseRelease(), binaryName: "inline" },
    read: (m) => m.release?.binaryName,
    alone: "inline",
    both: "acme",
  },
  "product/modules/licensing": {
    setupAlone: (d) => delete p(d).modules.license,
    old: { enabled: true },
    read: (m) => m.services.license.enabled,
    alone: true,
  },
  "product/modules/releases": {
    setupAlone: (d) => delete p(d).modules.release,
    old: { enabled: true },
    read: (m) => m.services.release.enabled,
    alone: true,
  },
  "product/modules/oidc": {
    setupAlone: (d) => delete p(d).modules.identity,
    old: { enabled: true },
    read: (m) => m.services.identity.enabled,
    alone: true,
  },
  "product/modules/edgeMint": {
    setupAlone: (d) => delete p(d).modules.config,
    old: { enabled: true },
    read: (m) => m.services.config.enabled,
    alone: true,
  },
  "schema/catalog": {
    old: [...(base().schema as { entries: unknown[] }).entries].reverse(),
    read: (m) => m.catalog.entries[0]?.key,
    alone: "acmeVpn",
    both: "run.concurrency",
  },
  "release/release/ghOwner": {
    old: "acme-org",
    canon: "acme",
    read: (m) => m.release?.ghOwner,
    alone: "acme-org",
    both: "acme-org",
  },
  "release/release/ghRepo": {
    old: "app",
    canon: "desktop",
    read: (m) => m.release?.ghRepo,
    alone: "app",
    both: "app",
  },
  "release/ghOwner": {
    setup: unwrap,
    old: "acme-org",
    canon: "acme",
    read: (m) => m.release?.ghOwner,
    alone: "acme-org",
    both: "acme-org",
  },
  "release/ghRepo": {
    setup: unwrap,
    old: "app",
    canon: "desktop",
    read: (m) => m.release?.ghRepo,
    alone: "app",
    both: "app",
  },
  "release/release/stableTagPattern": {
    canon: "v\\d+",
    read: (m) => m.release?.stableTagPattern,
    alone: "v\\d+\\.\\d+\\.\\d+",
  },
  "release/stableTagPattern": {
    setup: unwrap,
    canon: "v\\d+",
    read: (m) => m.release?.stableTagPattern,
    alone: "v\\d+\\.\\d+\\.\\d+",
  },
  "release/release/ignoreTags": {
    canon: ["x"],
    read: (m) => m.release?.ignoreTags,
    alone: ["channels", "packs"],
  },
  "release/ignoreTags": {
    setup: unwrap,
    canon: ["x"],
    read: (m) => m.release?.ignoreTags,
    alone: ["channels", "packs"],
  },
  "release/edgeMint": {
    old: mintAs("other"),
    read: (m) => m.edgeMint.map((e) => e.id),
    alone: ["other"],
    both: ["applemusic"],
  },
  "release/release/edgeMint": {
    setupAlone: (d) => delete p(d).edgeMint,
    old: mintAs("other"),
    read: (m) => m.edgeMint.map((e) => e.id),
    alone: [],
  },
  "distribution/listing/iconUrl": {
    old: "https://acme.example/i.png",
    read: (m) => m.distribution?.listing?.icon?.src,
    alone: "https://acme.example/i.png",
  },
  "distribution/listing/headerUrl": {
    old: "https://acme.example/h.png",
    read: (m) => m.distribution?.listing?.header?.src,
    alone: "https://acme.example/h.png",
  },
  "distribution/outlets/*/listing/iconUrl": {
    at: "/outlets/direct/listing/iconUrl",
    canonAt: "/outlets/direct/listing/icon",
    old: "https://acme.example/i.png",
    canon: "https://acme.example/j.png",
  },
  "distribution/outlets/*/listing/headerUrl": {
    at: "/outlets/direct/listing/headerUrl",
    canonAt: "/outlets/direct/listing/header",
    old: "https://acme.example/h.png",
    canon: "https://acme.example/k.png",
  },
};
// Row 14: a root release field is the base value moved out of the wrapper (alone), or a value
// next to the wrapper that nothing reads (both). Either way the parsed release is base's.
for (const s of DEPRECATED_SPELLINGS.filter((s) => s.row === 14))
  SPELLING_CASES[`release${s.pointer}`] = {
    setupAlone: unwrap,
    old: undefined,
    canon: undefined,
    read: (m) => m.release,
  };

function parsedOf(docs: Docs): ParsedManifest {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(docs))
    if (v !== undefined) files[k] = JSON.stringify(v);
  const res = parseManifest(files);
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest;
}

describe("deprecated spellings warn, keep their precedence, and each row has a mutation (ST-19)", () => {
  const baseParsed = parsedOf(base());
  for (const s of DEPRECATED_SPELLINGS) {
    const key = `${s.doc}${s.pointer}`;
    const c = SPELLING_CASES[key];
    const at = c?.at ?? s.pointer.replace(/\*/g, "0");
    const canonAt =
      c?.canonAt ?? s.canonicalPointer?.pointer.replace(/\*/g, "0");

    it(`row ${s.row}: ${key}`, () => {
      expect(c, `no SPELLING_CASES entry for ${key}`).toBeDefined();
      // A row-14 alone case writes nothing new: the unwrap moved base's value to the root.
      const isRow14 = s.row === 14;

      // The old spelling on its own.
      const alone = base();
      c!.setup?.(alone);
      c!.setupAlone?.(alone);
      if (c!.old !== undefined) putAt(alone, s.doc, at, c!.old);
      if (s.canonicalPointer && canonAt !== undefined && !isRow14)
        delAt(alone, s.canonicalPointer.doc, canonAt);
      const resAlone = validateIngestDocuments(alone);
      expect(resAlone.errors, "the old spelling still validates").toEqual([]);
      const hits = resAlone.warnings.filter((w) => w.path === at);
      if (s.code === null)
        expect(hits.map((w) => w.code)).not.toContain("deprecated_spelling");
      else
        expect(
          hits.map((w) => `${w.file} ${w.code}`),
          "warned at the old pointer",
        ).toContain(`${s.doc} ${s.code}`);
      if (s.wins === "ignored")
        expect(hits.find((w) => w.code === s.code)?.message).toContain(
          "ignored",
        );
      if (c!.read) {
        const m = parsedOf(alone);
        if (isRow14) expect(m.release).toEqual(baseParsed.release);
        else expect(c!.read(m), "the old spelling is read").toEqual(c!.alone);
      }

      // Both spellings at once.
      if (!s.canonicalPointer || !s.conflictCode) return;
      const both = base();
      c!.setup?.(both);
      putAt(both, s.doc, at, c!.old ?? (isRow14 ? "IGNORED" : undefined));
      if (c!.canon !== undefined)
        putAt(both, s.canonicalPointer.doc, canonAt!, c!.canon);
      expect(
        getAt(both, s.canonicalPointer.doc, canonAt!),
        "the case sets the canonical spelling",
      ).toBeDefined();
      const resBoth = validateIngestDocuments(both);
      if (s.wins === "refused") {
        expect(resBoth.errors.map((e) => e.code)).toContain(s.conflictCode);
        return;
      }
      expect(resBoth.errors).toEqual([]);
      const conflict = resBoth.warnings.find(
        (w) => w.path === at && w.code === s.conflictCode,
      );
      expect(conflict, "conflict reported at the old pointer").toBeDefined();
      if (isRow14) {
        expect(parsedOf(both).release).toEqual(baseParsed.release);
      } else if (c!.read) {
        expect(c!.read(parsedOf(both)), `${s.wins} wins`).toEqual(c!.both);
      }
    });
  }

  it("every row with a warning of its own has a hand-written mutation", () => {
    const rows = new Set(
      MUTATIONS.filter((m) => m.code === "deprecated_spelling").map(
        (m) => m.row,
      ),
    );
    const want = new Set(
      DEPRECATED_SPELLINGS.filter((s) => s.code === "deprecated_spelling").map(
        (s) => s.row,
      ),
    );
    expect([...want].filter((r) => !rows.has(r))).toEqual([]);
    expect([...want].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17,
    ]);
    // Rows 16 and 18 keep the codes they had, which have mutations of their own.
    for (const code of [
      "conflicting_versioning",
      "listing_url_field_deprecated",
      "listing_field_conflict",
      "conflicting_spelling",
    ])
      expect(
        MUTATIONS.some((m) => m.code === code),
        code,
      ).toBe(true);
  });

  it("the schemas mark every old spelling the coverage reaches as deprecated", () => {
    const schemas: Record<string, any> = {
      product: JSON.parse(
        readFileSync(join(schemasDir, "product.schema.json"), "utf8"),
      ),
      schema: JSON.parse(
        readFileSync(join(schemasDir, "schema.schema.json"), "utf8"),
      ),
      release: JSON.parse(
        readFileSync(join(schemasDir, "release.schema.json"), "utf8"),
      ),
    };
    // Root properties, and properties one level into a wrapper the schema defines by $ref.
    const deref = (root: any, node: any) =>
      node?.$ref
        ? node.$ref
            .slice(2)
            .split("/")
            .reduce((n: any, k: string) => n[k], root)
        : node;
    for (const s of DEPRECATED_SPELLINGS) {
      if (s.doc === "distribution") continue; // P2b-02 marked these already.
      const segs = s.pointer.split("/").slice(1);
      if (segs.includes("*") || segs.length > 2) continue;
      const root = schemas[s.doc];
      let node = root.properties[segs[0]!];
      if (segs.length === 2) node = deref(root, node)?.properties?.[segs[1]!];
      expect(node?.deprecated, `${s.doc}${s.pointer}`).toBe(true);
    }
  });
});

/** snake_case string literals in the source that are NOT validator error codes. */
const EXTRACTION_NOISE: ReadonlySet<string> = new Set([
  "pkey_admin", // doc-comment examples
  "well_known",
  "requires_identity",
  "requires_license",
]);

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The release descriptor (P2-04): the same three properties over `src/descriptor.ts` and
// `schemas/v1/release-descriptor.schema.json`.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const validateDescriptorSchema = ajv.compile(
  JSON.parse(
    readFileSync(join(schemasDir, "release-descriptor.schema.json"), "utf8"),
  ),
);

/** The base manifest, parsed — the declaration every descriptor below is checked against —
 *  with its declared pack ids as the validator context's `release.packs` (P4-02), the way the
 *  CLI's `descriptorManifestOf` and the Worker's `planDescriptorIngest` fill it. */
function descriptorManifest(): DescriptorManifest {
  const docs = base();
  const res = parseManifest({
    product: JSON.stringify(docs.product),
    schema: JSON.stringify(docs.schema),
    release: JSON.stringify(docs.release),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  const m: ParsedManifest = res.manifest;
  return {
    product: m.product,
    release: {
      app: m.release?.app ?? null,
      manualChannels: m.release?.manualChannels ?? [],
      packs: (m.release?.packDeliverables ?? []).map((p) => p.id),
      packages: m.release?.packageDeliverables ?? [],
    },
  };
}

/** A fully-valid package release descriptor for the base manifest's `acme.sdk` (F-03). */
function basePackageDescriptor(): Record<string, any> {
  return {
    descriptorVersion: 1,
    product: "acme",
    deliverable: "acme.sdk",
    kind: "package",
    version: "1.4.0",
    channel: "stable",
    seq: 3,
    package: {
      ecosystem: "npm",
      name: "@acme/sdk",
      files: [
        {
          name: "acme-sdk-1.4.0.tgz",
          role: "payload",
          type: "npm-tarball",
          sha256: SHA_A,
          size: 48213,
          locations: [{ provider: "r2", key: `blobs/sha256/${SHA_A}` }],
        },
      ],
      metadata: {
        name: "@acme/sdk",
        version: "1.4.0",
        dependencies: { "@acme/core": "^1.0.0" },
        engines: { node: ">=22" },
      },
    },
  };
}

/** Turn a mutation's descriptor (the app base) into the package base, then edit it. */
function asPackage(
  d: Record<string, any>,
  edit: (p: Record<string, any>) => void = () => {},
): void {
  for (const k of Object.keys(d)) delete d[k];
  Object.assign(d, basePackageDescriptor());
  edit(d);
}

/** A well-formed `content` for the base manifest (P4-02). */
const CONTENT = (): Record<string, any> => ({
  contentApi: 3,
  pins: [
    {
      pack: "acme.core3d",
      release: { sha256: SHA_A, seq: 12, version: "1.4.0" },
    },
  ],
  expects: [{ pack: "acme.core3d", required: true, delivery: "essential" }],
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** A fully-valid descriptor for the base manifest's `macos` and `win-zip` builds. */
function baseDescriptor(): Record<string, any> {
  return {
    descriptorVersion: 1,
    product: "acme",
    deliverable: "app",
    kind: "app",
    version: "1.2.3",
    seq: 7,
    tag: "v1.2.3",
    channel: "beta",
    title: "Acme 1.2.3",
    notes: "Fixes.\nMore fixes.",
    publishedAt: "2026-09-30T12:00:00Z",
    provenance: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      workflowRun: "https://github.com/acme/desktop/actions/runs/1",
    },
    builds: [
      {
        id: "macos",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        buildNumber: "4021",
        minOS: "13.0",
        artifacts: [
          {
            name: "Acme-1.2.3-macos.dmg",
            role: "payload",
            sha256: SHA_A,
            size: 1024,
            contentType: "application/x-apple-diskimage",
            locations: [
              { provider: "r2", key: `blobs/sha256/${SHA_A}` },
              { provider: "github", asset: "Acme-1.2.3-macos.dmg" },
            ],
          },
          {
            name: "Acme-1.2.3-macos.dmg.sig",
            role: "signature",
            sha256: SHA_B,
            size: 96,
            locations: [
              { provider: "github", asset: "Acme-1.2.3-macos.dmg.sig" },
            ],
          },
        ],
      },
      {
        id: "win-zip",
        platform: "windows",
        arch: "x86_64",
        format: "zip",
        artifacts: [
          {
            name: "Acme-1.2.3-windows-x86_64.zip",
            role: "payload",
            sha256: SHA_B,
            size: 2048,
            locations: [
              { provider: "external", url: "https://cdn.acme.example/w.zip" },
              { provider: "store" },
            ],
          },
        ],
      },
    ],
  };
}

/** A well-formed iOS build's metadata (P2b-05). */
const IOS_META = (): Record<string, any> => ({
  bundleIdentifier: "gg.acme.app",
  version: "1.2.3",
  buildVersion: "4021",
  minOSVersion: "16.0",
  appPermissions: {
    entitlements: ["com.apple.developer.game-center", "get-task-allow"],
    privacy: { NSCameraUsageDescription: "Scan a QR code." },
  },
});

/** A well-formed Android build's metadata (P2b-05). */
const ANDROID_META = (): Record<string, any> => ({
  packageName: "gg.acme.app",
  versionCode: 10203,
  versionName: "1.2.3",
  minSdk: 24,
  targetSdk: 35,
  nativecode: ["arm64-v8a", "armeabi-v7a"],
  signerSha256: SHA_A,
});

type DescriptorMutation = {
  code: string;
  schema: "rejects" | "accepts";
  mutate: (d: Record<string, any>) => void;
};

const mac = (d: Record<string, any>) => d.builds[0];
const dmg = (d: Record<string, any>) => d.builds[0].artifacts[0];

/** One entry per descriptor validator code (asserted complete against the source below). */
const DESCRIPTOR_MUTATIONS: DescriptorMutation[] = [
  // ── package releases (F-03, plans/F-01.md §3.2) ──
  {
    // A package release carries package, never builds.
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => asPackage(d, (p) => (p.builds = d.builds ?? [])),
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => asPackage(d, (p) => delete p.package),
  },
  {
    // ...and an app release never carries package.
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => (d.package = basePackageDescriptor().package),
  },
  {
    // A package's release id is always <deliverable>@<version>: no tag.
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => asPackage(d, (p) => (p.tag = "v1.4.0")),
  },
  {
    // Locations are r2 only.
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) =>
      asPackage(d, (p) => {
        p.package.files[0].locations = [
          { provider: "external", url: "https://cdn.acme.example/x.tgz" },
        ];
      }),
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => asPackage(d, (p) => (p.package.files[0].type = "tarball")),
  },
  {
    // A type from another ecosystem's vocabulary: the schema's enum is the union.
    code: "invalid_descriptor",
    schema: "accepts",
    mutate: (d) => asPackage(d, (p) => (p.package.files[0].type = "wheel")),
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => asPackage(d, (p) => (p.package.files[0].role = "signature")),
  },
  {
    // The metadata must agree with the descriptor: another version was packed.
    code: "invalid_descriptor",
    schema: "accepts",
    mutate: (d) => asPackage(d, (p) => (p.package.metadata.version = "1.3.9")),
  },
  {
    code: "invalid_descriptor",
    schema: "accepts",
    mutate: (d) =>
      asPackage(d, (p) => (p.package.metadata.postinstall = "curl | sh")),
  },
  {
    // npm versions are semver.
    code: "invalid_descriptor",
    schema: "accepts",
    mutate: (d) =>
      asPackage(d, (p) => {
        p.version = "1.4";
        p.package.metadata.version = "1.4";
      }),
  },
  {
    // The block must name the declared package.
    code: "invalid_descriptor",
    schema: "accepts",
    mutate: (d) =>
      asPackage(d, (p) => {
        p.package.name = "@acme/other";
        p.package.metadata.name = "@acme/other";
      }),
  },
  {
    code: "duplicate_artifact_name",
    schema: "accepts",
    mutate: (d) =>
      asPackage(d, (p) =>
        p.package.files.push({ ...p.package.files[0], sha256: SHA_B }),
      ),
  },
  {
    code: "r2_key_not_content_addressed",
    schema: "accepts",
    mutate: (d) =>
      asPackage(d, (p) => {
        p.package.files[0].locations = [
          { provider: "r2", key: `blobs/sha256/${SHA_B}` },
        ];
      }),
  },
  {
    // kind package naming the app deliverable.
    code: "unsupported_deliverable_kind",
    schema: "accepts",
    mutate: (d) => asPackage(d, (p) => (p.deliverable = "app")),
  },
  {
    // kind app naming a package deliverable.
    code: "unsupported_deliverable_kind",
    schema: "accepts",
    mutate: (d) => (d.deliverable = "acme.sdk"),
  },
  {
    code: "unknown_deliverable",
    schema: "accepts",
    mutate: (d) => asPackage(d, (p) => (p.deliverable = "acme.nothing")),
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => delete d.version,
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => (d.product = "Acme!"),
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => (d.builds = []),
  },
  {
    code: "invalid_descriptor",
    schema: "rejects",
    mutate: (d) => (d.kind = "game"),
  },
  {
    // Over the serialised cap; the schema has no byte-size keyword.
    code: "invalid_descriptor",
    schema: "accepts",
    mutate: (d) => (mac(d).requires = { blob: "x".repeat(70000) }),
  },
  {
    code: "unsupported_descriptor_version",
    schema: "rejects",
    mutate: (d) => (d.descriptorVersion = 2),
  },
  {
    code: "unsupported_deliverable_kind",
    schema: "rejects",
    mutate: (d) => (d.kind = "pack"),
  },
  // ── content and embeds (P4-02, plans/P4-01.md §3 decision 37) ──
  {
    code: "invalid_descriptor_content",
    schema: "rejects",
    mutate: (d) => (d.content = { ...CONTENT(), contentApi: 0 }),
  },
  {
    // A hold is a pin's shape (P4-12).
    code: "invalid_descriptor_content",
    schema: "rejects",
    mutate: (d) =>
      (d.content = { ...CONTENT(), holds: [{ pack: "acme.l10n" }] }),
  },
  {
    code: "invalid_descriptor_content",
    schema: "rejects",
    mutate: (d) =>
      (d.content = { ...CONTENT(), packChannels: { "acme.*": "Ev" } }),
  },
  {
    // packChannels is the manifest's, stamped as declared.
    code: "invalid_descriptor_content",
    schema: "accepts",
    mutate: (d) =>
      (d.content = { ...CONTENT(), packChannels: { "acme.*": "events" } }),
  },
  {
    // A held pack is a declared one.
    code: "invalid_descriptor_content",
    schema: "accepts",
    mutate: (d) =>
      (d.content = {
        ...CONTENT(),
        holds: [
          {
            pack: "acme.audio",
            release: { sha256: "c".repeat(64), seq: 2, version: "1.0.1" },
          },
        ],
      }),
  },
  {
    code: "invalid_descriptor_content",
    schema: "rejects",
    mutate: (d) => {
      d.content = CONTENT();
      d.content.pins[0].release.seq = 0;
    },
  },
  {
    // contentApi must be the one .pkey/release declares.
    code: "invalid_descriptor_content",
    schema: "accepts",
    mutate: (d) => (d.content = { ...CONTENT(), contentApi: 4 }),
  },
  {
    // A pin names a declared pack.
    code: "invalid_descriptor_content",
    schema: "accepts",
    mutate: (d) => {
      d.content = CONTENT();
      d.content.pins[0].pack = "acme.audio";
    },
  },
  {
    code: "invalid_descriptor_embeds",
    schema: "rejects",
    mutate: (d) => (mac(d).embeds = ["app"]),
  },
  {
    // Each names a declared pack.
    code: "invalid_descriptor_embeds",
    schema: "accepts",
    mutate: (d) => (mac(d).embeds = ["acme.audio"]),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.seq = 0),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.tag = "v 1.2.3"),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.channel = "staging"),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.channel = "Beta"),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.publishedAt = "yesterday"),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.provenance.commit = "abc"),
  },
  {
    code: "invalid_descriptor_field",
    schema: "rejects",
    mutate: (d) => (d.title = "x".repeat(201)),
  },
  {
    code: "invalid_descriptor_build",
    schema: "rejects",
    mutate: (d) => (mac(d).platform = "darwin"),
  },
  {
    code: "invalid_descriptor_build",
    schema: "rejects",
    mutate: (d) => (mac(d).arch = "amd64"),
  },
  {
    code: "invalid_descriptor_build",
    schema: "rejects",
    mutate: (d) => delete mac(d).artifacts,
  },
  {
    code: "invalid_descriptor_build",
    schema: "rejects",
    mutate: (d) => (mac(d).buildNumber = 4021),
  },
  {
    code: "duplicate_build_id",
    schema: "accepts",
    mutate: (d) => (d.builds[1].id = "macos"),
  },
  {
    code: "invalid_descriptor_artifact",
    schema: "rejects",
    mutate: (d) => (dmg(d).sha256 = "A".repeat(64)),
  },
  {
    code: "invalid_descriptor_artifact",
    schema: "rejects",
    mutate: (d) => (dmg(d).size = -1),
  },
  {
    code: "invalid_descriptor_artifact",
    schema: "rejects",
    mutate: (d) => (dmg(d).role = "portable"),
  },
  {
    code: "invalid_descriptor_artifact",
    schema: "rejects",
    mutate: (d) => (dmg(d).name = "dir/file.dmg"),
  },
  {
    code: "invalid_descriptor_artifact",
    schema: "rejects",
    mutate: (d) => (dmg(d).locations = []),
  },
  {
    code: "invalid_delta_from",
    schema: "rejects",
    mutate: (d) => {
      dmg(d).role = "delta";
      dmg(d).deltaFrom = "1.2 3";
    },
  },
  {
    code: "invalid_delta_from",
    schema: "accepts",
    mutate: (d) => (dmg(d).deltaFrom = "4020"),
  },
  {
    code: "duplicate_artifact_name",
    schema: "accepts",
    mutate: (d) => (mac(d).artifacts[1].name = dmg(d).name),
  },
  {
    code: "invalid_artifact_location",
    schema: "rejects",
    mutate: (d) => (dmg(d).locations[0] = { provider: "s3", key: "x" }),
  },
  {
    code: "invalid_artifact_location",
    schema: "rejects",
    mutate: (d) =>
      (d.builds[1].artifacts[0].locations[0].url =
        "http://cdn.acme.example/w.zip"),
  },
  {
    // A store location carries no bytes.
    code: "invalid_artifact_location",
    schema: "rejects",
    mutate: (d) =>
      (d.builds[1].artifacts[0].locations[1].url = "https://apps.apple.com/x"),
  },
  {
    code: "invalid_artifact_location",
    schema: "accepts",
    // Validator-only: a github location names the artifact itself.
    mutate: (d) => (dmg(d).locations[1].asset = "Other.dmg"),
  },
  {
    code: "r2_key_not_content_addressed",
    schema: "rejects",
    mutate: (d) => (dmg(d).locations[0].key = `staging/acme/t1/${SHA_A}`),
  },
  {
    code: "r2_key_not_content_addressed",
    schema: "accepts",
    // Validator-only: well-formed, but named by another file's hash.
    mutate: (d) => (dmg(d).locations[0].key = `blobs/sha256/${SHA_B}`),
  },
  {
    code: "product_mismatch",
    schema: "accepts",
    mutate: (d) => (d.product = "other"),
  },
  {
    code: "unknown_deliverable",
    schema: "accepts",
    mutate: (d) => (d.deliverable = "acme.core3d"),
  },
  {
    code: "invalid_version_for_scheme",
    schema: "accepts",
    mutate: (d) => {
      d.version = "1.2";
      delete d.tag;
    },
  },
  {
    code: "tag_version_mismatch",
    schema: "accepts",
    mutate: (d) => (d.tag = "release-1.2.3"),
  },
  {
    code: "unknown_channel",
    schema: "accepts",
    mutate: (d) => (d.channel = "canary"),
  },
  {
    code: "undeclared_build",
    schema: "accepts",
    mutate: (d) => (mac(d).id = "macos-arm64"),
  },
  {
    code: "build_mismatch",
    schema: "accepts",
    mutate: (d) => (mac(d).arch = "arm64"),
  },
  {
    code: "build_mismatch",
    schema: "accepts",
    mutate: (d) => (d.builds[1].format = "msi"),
  },
  {
    code: "artifact_name_mismatch",
    schema: "accepts",
    mutate: (d) => {
      dmg(d).name = "acme-1.2.3-macos.dmg";
      dmg(d).locations = [{ provider: "r2", key: `blobs/sha256/${SHA_A}` }];
    },
  },
  {
    code: "invalid_build_payload",
    schema: "accepts",
    mutate: (d) => (mac(d).artifacts[1].role = "payload"),
  },
  {
    // P2b-05: only ios and android builds carry metadata.
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => (mac(d).metadata = ANDROID_META()),
  },
  {
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => {
      mac(d).platform = "ios";
      mac(d).metadata = { ...IOS_META(), bundleIdentifier: "nodots" };
    },
  },
  {
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => {
      mac(d).platform = "ios";
      mac(d).metadata = IOS_META();
      mac(d).metadata.appPermissions.privacy = { NSCamera: "x" };
    },
  },
  {
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => {
      mac(d).platform = "android";
      mac(d).metadata = { ...ANDROID_META(), versionCode: 0 };
    },
  },
  {
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => {
      mac(d).platform = "android";
      mac(d).metadata = { ...ANDROID_META(), signerSha256: "A".repeat(64) };
    },
  },
  {
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => {
      mac(d).platform = "android";
      mac(d).metadata = { ...ANDROID_META(), nativecode: ["arm64"] };
    },
  },
  {
    code: "invalid_build_metadata",
    schema: "rejects",
    mutate: (d) => {
      mac(d).platform = "android";
      mac(d).metadata = { ...ANDROID_META(), targetSdk: 0 };
    },
  },
];

describe("release descriptor: valid stays valid", () => {
  it("the base descriptor passes both the validator and the schema", () => {
    const res = validateReleaseDescriptor(
      baseDescriptor(),
      descriptorManifest(),
    );
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(res.ok && res.releaseId).toBe("v1.2.3");
    expect(
      validateDescriptorSchema(baseDescriptor()),
      JSON.stringify(validateDescriptorSchema.errors),
    ).toBe(true);
  });

  it("a minimal store-only, untagged descriptor (release id <deliverable>@<version>)", () => {
    const d = {
      descriptorVersion: 1,
      product: "acme",
      deliverable: "app",
      kind: "app",
      version: "1.2.4",
      builds: [
        {
          id: "macos",
          platform: "macos",
          arch: "universal",
          format: "dmg",
          buildNumber: "4022",
          artifacts: [],
        },
      ],
    };
    const res = validateReleaseDescriptor(d, descriptorManifest());
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(res.ok && res.releaseId).toBe("app@1.2.4");
    expect(
      validateDescriptorSchema(d),
      JSON.stringify(validateDescriptorSchema.errors),
    ).toBe(true);
  });

  it("content and embeds (P4-02) pass both the validator and the schema", () => {
    const d = baseDescriptor();
    d.content = CONTENT();
    mac(d).embeds = ["acme.core3d"];
    const res = validateReleaseDescriptor(d, descriptorManifest());
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(
      validateDescriptorSchema(d),
      JSON.stringify(validateDescriptorSchema.errors),
    ).toBe(true);
  });

  it("the over-cap refusal names the bytes content and metadata take", () => {
    const d = baseDescriptor();
    d.content = CONTENT();
    mac(d).requires = { blob: "x".repeat(70000) };
    const res = validateReleaseDescriptor(d, descriptorManifest());
    const msg = res.ok ? "" : (res.errors[0]?.message ?? "");
    expect(msg).toMatch(
      /content takes \d+ bytes and builds\[\]\.metadata 0 in all/,
    );
  });

  it("ios and android build metadata pass both the validator's shape check and the schema", () => {
    const d = baseDescriptor();
    d.builds.push(
      {
        id: "ios",
        platform: "ios",
        arch: "arm64",
        format: "ipa",
        metadata: IOS_META(),
        artifacts: [],
      },
      {
        id: "apk",
        platform: "android",
        arch: "universal",
        format: "apk",
        metadata: ANDROID_META(),
        artifacts: [],
      },
    );
    const res = validateReleaseDescriptor(d, descriptorManifest());
    // The base manifest declares neither build, so the cross-check refuses them — but never
    // their metadata.
    const codes = res.ok ? [] : res.errors.map((e) => e.code);
    expect(codes).not.toContain("invalid_build_metadata");
    expect(codes).toContain("undeclared_build");
    expect(
      validateDescriptorSchema(d),
      JSON.stringify(validateDescriptorSchema.errors),
    ).toBe(true);
  });

  it("the schema's ABI list is exactly the validator's", () => {
    const schema = JSON.parse(
      readFileSync(join(schemasDir, "release-descriptor.schema.json"), "utf8"),
    );
    expect(
      schema.$defs.androidMetadata.properties.nativecode.items.enum,
    ).toEqual([...ANDROID_ABIS]);
  });

  it("the schema's vocabularies are exactly the validator's constants", () => {
    const schema = JSON.parse(
      readFileSync(join(schemasDir, "release-descriptor.schema.json"), "utf8"),
    );
    expect(schema.$defs.build.properties.platform.enum).toEqual([
      ...RELEASE_PLATFORMS,
    ]);
    expect(schema.$defs.build.properties.arch.enum).toEqual([
      ...RELEASE_ARCHES,
    ]);
    expect(schema.$defs.artifact.properties.role.enum).toEqual([
      ...ARTIFACT_ROLES,
    ]);
    expect(
      schema.$defs.location.oneOf.map((b: any) => b.properties.provider.const),
    ).toEqual([...LOCATION_PROVIDERS]);
  });
});

describe("package release descriptors (F-03)", () => {
  it("the base package descriptor passes both the validator and the schema", () => {
    const res = validateReleaseDescriptor(
      basePackageDescriptor(),
      descriptorManifest(),
    );
    expect(res.ok ? [] : res.errors).toEqual([]);
    expect(res.ok && res.releaseId).toBe("acme.sdk@1.4.0");
    expect(res.ok && res.descriptor.kind).toBe("package");
    expect(
      validateDescriptorSchema(basePackageDescriptor()),
      JSON.stringify(validateDescriptorSchema.errors),
    ).toBe(true);
  });

  it("the schemas' package vocabularies are exactly the validator's constants", () => {
    const desc = JSON.parse(
      readFileSync(join(schemasDir, "release-descriptor.schema.json"), "utf8"),
    );
    expect(desc.$defs.packageBlock.properties.ecosystem.enum).toEqual([
      ...PACKAGE_ECOSYSTEMS,
    ]);
    expect(desc.$defs.packageFile.properties.type.enum).toEqual(
      PACKAGE_ECOSYSTEMS.flatMap((e) => PACKAGE_FILE_TYPES[e]),
    );
    const release = JSON.parse(
      readFileSync(join(schemasDir, "release.schema.json"), "utf8"),
    );
    const pkg = release.$defs.packageDeliverable;
    expect(pkg.properties.ecosystem.enum).toEqual([...PACKAGE_ECOSYSTEMS]);
    expect(pkg.not.anyOf.map((r: any) => r.required[0])).toEqual([
      ...PACKAGE_REFUSED_FIELDS,
    ]);
    expect(
      pkg.allOf.map((b: any) => [
        b.if.properties.ecosystem.const,
        b.then.properties.name.pattern,
        b.then.properties.name.maxLength,
      ]),
    ).toEqual(
      PACKAGE_ECOSYSTEMS.map((e) => [
        e,
        PACKAGE_NAME_PATTERNS[e].source.replace(/\\\//g, "/"),
        PACKAGE_NAME_MAX_LENGTH[e],
      ]),
    );
    expect(release.$defs.deliverables.maxProperties).toBe(
      1 + MAX_PACK_DELIVERABLES + MAX_PACKAGE_DELIVERABLES,
    );
  });

  it("a valid descriptor of every ecosystem passes both validators", () => {
    const cases: Array<[string, string, Record<string, any>[], string]> = [
      [
        "pypi",
        "acme-sdk",
        [
          { type: "wheel", name: "acme_sdk-1.4.0-py3-none-any.whl" },
          {
            type: "core-metadata",
            name: "acme_sdk-1.4.0-py3-none-any.whl.metadata",
          },
        ],
        "1.4.0",
      ],
      [
        "swift",
        "acme.AcmeKit",
        [
          { type: "source-archive", name: "AcmeKit-1.4.0.zip" },
          { type: "source-archive-signature", name: "AcmeKit-1.4.0.sig" },
          { type: "manifest", name: "Package.swift" },
        ],
        "1.4.0",
      ],
      [
        "maven",
        "gg.acme:acme-sdk",
        [
          { type: "maven-file", name: "acme-sdk-1.4.0.jar", extension: "jar" },
          {
            type: "maven-file",
            name: "acme-sdk-1.4.0-sources.jar",
            extension: "jar",
            classifier: "sources",
          },
        ],
        "1.4.0",
      ],
      [
        "oci",
        "pkey",
        [
          {
            type: "oci-index",
            name: "index.json",
            mediaType: "application/vnd.oci.image.index.v1+json",
          },
        ],
        "1.4.0",
      ],
      [
        "godot",
        "acme_sdk",
        [
          { type: "godot-zip", name: "acme_sdk-1.4.0.zip" },
          { type: "godot-icon", name: "icon.png" },
        ],
        "1.4.0",
      ],
      [
        "go",
        "go.acme.dev/sdk/v2",
        [
          { type: "go-zip", name: "v2.4.0.zip" },
          { type: "go-mod", name: "go.mod" },
        ],
        "2.4.0",
      ],
    ];
    for (const [ecosystem, name, files, version] of cases) {
      const manifest = descriptorManifest();
      manifest.release!.packages = [
        { id: "acme.sdk", ecosystem: ecosystem as any, name },
      ];
      const d = basePackageDescriptor();
      d.version = version;
      d.package = {
        ecosystem,
        name,
        files: files.map((f, i) => {
          const sha = String(i)
            .repeat(64)
            .slice(0, 64)
            .replace(/[^0-9]/g, "0");
          return {
            role: "payload",
            sha256: sha,
            size: 10,
            locations: [{ provider: "r2", key: `blobs/sha256/${sha}` }],
            ...f,
          };
        }),
        metadata: { name, version },
      };
      const res = validateReleaseDescriptor(d, manifest);
      expect(res.ok ? [] : res.errors, ecosystem).toEqual([]);
      expect(
        validateDescriptorSchema(d),
        `${ecosystem}: ${JSON.stringify(validateDescriptorSchema.errors)}`,
      ).toBe(true);
    }
  });

  it("a Go version is semver without build metadata, its major agrees with the path, and its files are one zip and one go.mod", () => {
    const run = (name: string, version: string, types: string[]) => {
      const manifest = descriptorManifest();
      manifest.release!.packages = [{ id: "acme.sdk", ecosystem: "go", name }];
      const d = basePackageDescriptor();
      d.version = version;
      d.package = {
        ecosystem: "go",
        name,
        files: types.map((type, i) => {
          const sha = String(i + 1).repeat(64);
          return {
            name: type === "go-mod" ? `go${i}.mod` : `v${i}.zip`,
            role: "payload",
            type,
            sha256: sha,
            size: 1,
            locations: [{ provider: "r2", key: `blobs/sha256/${sha}` }],
          };
        }),
        metadata: { name, version },
      };
      const res = validateReleaseDescriptor(d, manifest);
      return res.ok ? [] : res.errors.map((e) => `${e.path} ${e.code}`);
    };
    const pair = ["go-zip", "go-mod"];
    expect(run("go.acme.dev/sdk", "1.4.0", pair)).toEqual([]);
    expect(run("go.acme.dev/sdk", "0.3.0-beta.1", pair)).toEqual([]);
    expect(run("go.acme.dev/sdk/v3", "3.0.0", pair)).toEqual([]);
    // Build metadata, a v prefix, a v2+ module without its suffix and a suffix on v1 are refused.
    expect(run("go.acme.dev/sdk", "1.4.0+build.1", pair)).toEqual([
      "/version invalid_descriptor",
    ]);
    expect(run("go.acme.dev/sdk", "v1.4.0", pair)).toEqual([
      "/version invalid_descriptor",
    ]);
    expect(run("go.acme.dev/sdk", "2.0.0", pair)).toEqual([
      "/version invalid_descriptor",
    ]);
    expect(run("go.acme.dev/sdk/v2", "1.0.0", pair)).toEqual([
      "/version invalid_descriptor",
    ]);
    expect(run("go.acme.dev/sdk/v1", "1.0.0", pair)).toEqual([
      "/version invalid_descriptor",
    ]);
    // Exactly one module zip and one go.mod.
    expect(run("go.acme.dev/sdk", "1.4.0", ["go-zip"])).toEqual([
      "/package/files invalid_descriptor",
    ]);
  });

  it("an OCI version carries no '+', and a non-Maven file no classifier", () => {
    const manifest = descriptorManifest();
    manifest.release!.packages = [
      { id: "acme.sdk", ecosystem: "oci", name: "pkey" },
    ];
    const d = basePackageDescriptor();
    d.version = "1.4.0+build.7";
    d.package = {
      ecosystem: "oci",
      name: "pkey",
      files: [
        {
          name: "index.json",
          role: "payload",
          type: "oci-index",
          mediaType: "application/vnd.oci.image.index.v1+json",
          sha256: SHA_A,
          size: 1,
          classifier: "x",
          locations: [{ provider: "r2", key: `blobs/sha256/${SHA_A}` }],
        },
      ],
      metadata: { name: "pkey", version: "1.4.0+build.7" },
    };
    const res = validateReleaseDescriptor(d, manifest);
    const paths = res.ok ? [] : res.errors.map((e) => e.path);
    expect(paths).toContain("/version");
    expect(paths).toContain("/package/files/0");
  });
});

describe("release descriptor: every code has a mutation, and the schema catches what it claims", () => {
  it("the mutation table covers every code descriptor.ts emits", () => {
    const source = readFileSync(
      join(here, "..", "src", "descriptor.ts"),
      "utf8",
    );
    const emitted = new Set(
      [...source.matchAll(/"((?:[a-z0-9]+_)+[a-z0-9]+)"/g)].map((m) => m[1]!),
    );
    const covered = new Set(DESCRIPTOR_MUTATIONS.map((m) => m.code));
    const missing = [...emitted].filter((code) => !covered.has(code));
    expect(
      missing,
      `descriptor codes without a mutation: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  for (const mutation of DESCRIPTOR_MUTATIONS) {
    it(`${mutation.code} (schema ${mutation.schema})`, () => {
      const d = baseDescriptor();
      mutation.mutate(d);
      const res = validateReleaseDescriptor(d, descriptorManifest());
      expect(res.ok ? [] : res.errors.map((e) => e.code)).toContain(
        mutation.code,
      );
      expect(validateDescriptorSchema(d)).toBe(mutation.schema === "accepts");
    });
  }
});
