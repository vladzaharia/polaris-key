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
  validateIngestDocuments,
  validateManifestDocuments,
} from "../src/index.js";

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

type Docs = {
  product: Record<string, unknown> | undefined;
  schema?: unknown;
  release?: unknown;
};

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
        defaultDeviceLimit: 5,
        defaultMaxOfflineDays: 30,
      },
      modules: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
      },
      devices: { registration: "requires-license" },
      web: { origins: ["https://app.acme.example", "http://localhost:8060"] },
      licensing: {
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
      },
      // NOTE: at the release-document ROOT, not inside the `release` wrapper — the validator
      // reads edgeMint from `manifest.release` directly (it does not unwrap through
      // releaseRoot() for this block), so a nested copy would be silently invisible.
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
} {
  return {
    product: validateProduct(docs.product) === true,
    schema:
      docs.schema === undefined || validateSchemaDoc(docs.schema) === true,
    release:
      docs.release === undefined || validateRelease(docs.release) === true,
  };
}

type Mutation = {
  code: string;
  /** Which document the schema check targets. */
  file: "product" | "schema" | "release";
  /** Can JSON Schema express this rule? "accepts" documents validator-only rules. */
  schema: "rejects" | "accepts";
  mutate: (d: Docs) => void;
};

const p = (d: Docs) => d.product as Record<string, any>;
const rel = (d: Docs) => (d.release as Record<string, any>).release;
const mint = (d: Docs) => (d.release as Record<string, any>).edgeMint[0];

/** One entry per validator error code (asserted complete against the source below). */
const MUTATIONS: Mutation[] = [
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
    mutate: (d) => (p(d).product.defaultDeviceLimit = -1),
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
    code: "update_requires_release",
    file: "product",
    schema: "rejects",
    mutate: (d) => {
      p(d).modules = { update: { enabled: true } };
      delete d.release;
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
  {
    code: "invalid_edge_mint_id",
    file: "release",
    schema: "rejects",
    mutate: (d) => (mint(d).id = "bad id!"),
  },
  {
    code: "invalid_edge_mint_kid",
    file: "release",
    schema: "rejects",
    mutate: (d) => (mint(d).kid = "bad kid!"),
  },
  {
    code: "invalid_edge_mint_audience",
    file: "release",
    schema: "rejects",
    mutate: (d) => (mint(d).audience = "x".repeat(300)),
  },
  {
    code: "invalid_edge_mint_alg",
    file: "release",
    schema: "rejects",
    mutate: (d) => (mint(d).alg = "HS256"),
  },
  {
    code: "invalid_ttl",
    file: "release",
    schema: "rejects",
    mutate: (d) => (mint(d).ttlSeconds = 0),
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
];

describe("valid manifests pass both validators", () => {
  it("the rich base fixture", () => {
    const docs = base();
    expect(tsCodes(docs)).toEqual([]);
    expect(schemaAccepts(docs)).toEqual({
      product: true,
      schema: true,
      release: true,
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

  it("the alias shapes (flattened root, licensing nesting, clientSecretRef, tier.profile)", () => {
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
    expect(tsCodes(docs)).toEqual([]);
    expect(schemaAccepts(docs)).toEqual({
      product: true,
      schema: true,
      release: true,
    });
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
  });
});

describe("every validator code has a mutation, and the schemas catch what they claim", () => {
  it("the mutation table covers every code the validator source emits", () => {
    const source = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
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

/** snake_case string literals in the source that are NOT validator error codes. */
const EXTRACTION_NOISE: ReadonlySet<string> = new Set([
  "pkey_admin", // doc-comment examples
  "well_known",
  "requires_identity",
  "requires_license",
]);
