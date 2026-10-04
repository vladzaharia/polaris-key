import { CodeBlock } from "../../ui/CodeBlock.js";
import { DiffViewer } from "../../ui/DiffViewer.js";
import { Duration } from "../../ui/Duration.js";
import { Hash } from "../../ui/Hash.js";
import { IdChip } from "../../ui/IdChip.js";
import { JsonViewer } from "../../ui/JsonViewer.js";
import { KeyDisplay } from "../../ui/KeyDisplay.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { Version } from "../../ui/Version.js";
import { EntityLink } from "../../console/components/EntityLink.js";
import type { Story } from "../types.js";

/** A fixed "now" so stories render the same every time: 3 Oct 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SNIPPET_TS = `import { PolarisKey } from "@polaris-key/node";

// One client per process.
const pk = new PolarisKey({ product: "djdl", configUrl: "https://key.plrs.im/djdl" });
const license = await pk.activate(process.env.LICENSE_KEY, { retries: 3 });`;

const SNIPPET_TOML = `[product]
slug = "djdl"
name = "DJDL"

[services.license]
enabled = true # devices need a key`;

const SNIPPET_YAML = `channels:
  - id: stable
    includes: []
  - id: beta
    includes: [stable]
critical: false`;

const SNIPPET_JSON = `{
  "schemaVersion": 8,
  "entries": [{ "key": "network.proxy.url", "kind": "config", "default": null }]
}`;

const TRUST_SET = {
  product: "djdl",
  keys: [
    {
      kid: "pk-2026-03",
      alg: "EdDSA",
      status: "active",
      x: "MCowBQYDK2VwAyEA3mQ9fP0aX1",
    },
    {
      kid: "pk-2026-10",
      alg: "EdDSA",
      status: "staged",
      activateAfter: 1790000000,
    },
  ],
  releaseKeys: { ci: "rk-2026-09" },
  issuedAt: 1790000000,
  revoked: [],
};

const BIG = {
  devices: Array.from(
    { length: 250 },
    (_, i) => `dev_${String(i).padStart(4, "0")}`,
  ),
};

const CATALOG_BEFORE = [
  {
    key: "network.proxy.url",
    kind: "config",
    label: "Proxy",
    category: "Network",
  },
  {
    key: "telemetry.legacy",
    kind: "flag",
    label: "Legacy telemetry",
    category: "Telemetry",
  },
  {
    key: "license.hd_textures",
    kind: "flag",
    label: "HD textures",
    category: "Content",
  },
];
const CATALOG_AFTER = [
  {
    key: "network.proxy.url",
    kind: "config",
    label: "Proxy URL",
    category: "Network",
  },
  {
    key: "license.hd_textures",
    kind: "flag",
    label: "HD textures",
    category: "Content",
  },
  {
    key: "network.timeout",
    kind: "config",
    label: "Timeout",
    category: "Network",
    default: 30,
  },
];

const SHA = "3f9a1c0e7b2d4f6a8c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d8d02";

export const stories: Story[] = [
  {
    id: "code-block",
    group: "Values",
    title: "CodeBlock",
    description:
      "Static highlighting for ts, json, sh, toml and yaml; copy, wrap toggle, line numbers.",
    render: () => (
      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBlock
          language="ts"
          code={SNIPPET_TS}
          filename="polaris.ts"
          lineNumbers
        />
        <CodeBlock
          language="sh"
          code={`export PKEY_TOKEN=$CI_TOKEN\npnpm exec pkey release publish --channel beta # from CI`}
        />
        <CodeBlock
          language="toml"
          code={SNIPPET_TOML}
          filename=".pkey/product"
        />
        <CodeBlock language="yaml" code={SNIPPET_YAML} wrap />
        <CodeBlock language="json" code={SNIPPET_JSON} copy={false} />
      </div>
    ),
  },
  {
    id: "json-viewer",
    group: "Values",
    title: "JsonViewer",
    description:
      "An ARIA tree: expanded to depth 2, collapsed to depth 0, and a 250-item array paged by 100.",
    render: () => (
      <div className="grid gap-4 lg:grid-cols-3">
        <JsonViewer label="Trust set" value={TRUST_SET} />
        <JsonViewer
          label="Trust set (collapsed)"
          value={TRUST_SET}
          collapsedDepth={0}
        />
        <JsonViewer
          label="Device ids"
          value={BIG}
          collapsedDepth={2}
          copy={false}
        />
      </div>
    ),
  },
  {
    id: "diff-structured",
    group: "Values",
    title: "DiffViewer: structured",
    description:
      "Catalog entries by key: added, removed (breaking: still referenced) and changed fields.",
    render: () => (
      <div className="space-y-6">
        <DiffViewer
          mode="structured"
          before={CATALOG_BEFORE}
          after={CATALOG_AFTER}
          entryKey="key"
          referencedBy={{
            "telemetry.legacy": ["profile base-pro", "profile studio"],
          }}
        />
        <DiffViewer
          mode="structured"
          before={CATALOG_AFTER}
          after={CATALOG_AFTER}
          entryKey="key"
        />
      </div>
    ),
  },
  {
    id: "diff-text",
    group: "Values",
    title: "DiffViewer: text",
    description:
      "A unified line diff of a YAML draft; the toggle switches to side by side.",
    render: () => (
      <div className="space-y-4">
        <DiffViewer
          mode="text"
          label="Channels YAML"
          before={SNIPPET_YAML}
          after={SNIPPET_YAML.replace(
            "critical: false",
            "critical: true\nminimumSupported: 2.0.0",
          )}
        />
        <DiffViewer
          mode="text"
          view="split"
          label="Catalog JSON"
          before={SNIPPET_JSON}
          after={SNIPPET_JSON.replace(
            '"schemaVersion": 8',
            '"schemaVersion": 9',
          )}
        />
      </div>
    ),
  },
  {
    id: "key-display",
    group: "Values",
    title: "KeyDisplay",
    description:
      "Public keys show in full; stored secrets never show a value; signing keys carry the gold glyph and status.",
    render: () => (
      <div className="grid gap-4 lg:grid-cols-2">
        <KeyDisplay
          label="Public key"
          kind="public"
          value="MCowBQYDK2VwAyEA3mQ9fP0aX1rT7vYw2zKq8nB4cD6eF0gH2iJ4kL6mN8o="
        />
        <KeyDisplay
          label="Signing key"
          kind="signing"
          kid="pk-2026-03"
          status="active"
          value="MCowBQYDK2VwAyEA3mQ9fP0aX1rT7vYw2zKq8nB4cD6eF0gH2iJ4kL6mN8o="
        />
        <KeyDisplay
          label="Staged key"
          kind="signing"
          kid="pk-2026-10"
          status="staged"
          value="MCowBQYDK2VwAyEAq8nB4cD6eF0gH2iJ4kL6mN8o3mQ9fP0aX1rT7vYw2zK="
        />
        <KeyDisplay
          label="Webhook secret"
          kind="secret"
          configured
          updatedAt={NOW - 30 * DAY}
        />
        <KeyDisplay
          label="OIDC client secret"
          kind="secret"
          configured={false}
        />
      </div>
    ),
  },
  {
    id: "hash-and-id",
    group: "Values",
    title: "Hash and IdChip",
    description:
      "Middle-truncated, copyable; the full value is in a popover, never only a title.",
    render: () => (
      <div className="flex flex-wrap items-center gap-6">
        <Hash value={SHA} label="SHA-256" />
        <Hash value={SHA} chars={12} label="SHA-256" />
        <IdChip value="lic_01J9ZK4Q7M2V8X3B5N6P" noun="license id" />
        <IdChip value="dev_8f2c" noun="device id" />
      </div>
    ),
  },
  {
    id: "timestamps",
    group: "Values",
    title: "Timestamp and Duration",
    description:
      "Table (relative under 7 days, with the absolute instant in a tooltip and sr-only), detail, date.",
    render: () => (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-fg-muted">Table, 3 h ago</dt>
        <dd>
          <Timestamp at={NOW - 3 * HOUR} now={NOW} timeZone="UTC" />
        </dd>
        <dt className="text-fg-muted">Table, 9 days ago</dt>
        <dd>
          <Timestamp at={NOW - 9 * DAY} now={NOW} timeZone="UTC" />
        </dd>
        <dt className="text-fg-muted">Detail</dt>
        <dd>
          <Timestamp
            at={NOW - 2 * HOUR}
            now={NOW}
            format="detail"
            timeZone="UTC"
          />
        </dd>
        <dt className="text-fg-muted">Date</dt>
        <dd>
          <Timestamp
            at={NOW + 361 * DAY}
            now={NOW}
            format="date"
            timeZone="UTC"
          />
        </dd>
        <dt className="text-fg-muted">Duration until</dt>
        <dd>
          <Duration ms={2 * DAY} mode="until" />
        </dd>
        <dt className="text-fg-muted">Duration for</dt>
        <dd>
          <Duration ms={14 * DAY} />
        </dd>
      </dl>
    ),
  },
  {
    id: "versions",
    group: "Values",
    title: "Version",
    description: "Mono; a yanked version is struck through AND labelled.",
    render: () => (
      <div className="flex flex-wrap items-center gap-6">
        <Version value="2.4.0" channel="stable" />
        <Version value="2.4.0-rc.2" channel="beta" />
        <Version value="2.3.9" yanked />
      </div>
    ),
  },
  {
    id: "entity-links",
    group: "Values",
    title: "EntityLink",
    description:
      "Typed links to every entity route; with no label the id shows in mono.",
    render: () => (
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        <li>
          License:{" "}
          <EntityLink
            slug="djdl"
            kind="license"
            id="lic_01J9"
            label="Studio Pro"
          />
        </li>
        <li>
          License keys tab:{" "}
          <EntityLink slug="djdl" kind="license" id="lic_01J9" tab="keys" />
        </li>
        <li>
          Tier: <EntityLink slug="djdl" kind="tier" id="pro" label="Pro" />
        </li>
        <li>
          Profile: <EntityLink slug="djdl" kind="profile" id="base-pro" />
        </li>
        <li>
          Release:{" "}
          <EntityLink slug="djdl" kind="release" id="rel_412" label="2.4.0" />
        </li>
        <li>
          Deliverable:{" "}
          <EntityLink slug="djdl" kind="deliverable" id="textures" />
        </li>
        <li>
          Pack release:{" "}
          <EntityLink
            slug="djdl"
            kind="pack-release"
            deliverable="textures"
            id="pr_13"
            label="textures 1.3.0"
          />
        </li>
        <li>
          Device: <EntityLink slug="djdl" kind="device" id="dev_8f2c" />
        </li>
        <li>
          Catalog key:{" "}
          <EntityLink slug="djdl" kind="catalog-key" id="network.proxy.url" />
        </li>
        <li>
          Outlet:{" "}
          <EntityLink
            slug="djdl"
            kind="outlet"
            id="appstore"
            label="App Store"
          />
        </li>
        <li>
          Rollout:{" "}
          <EntityLink
            slug="djdl"
            kind="rollout"
            release="rel_412"
            outlet="play"
            label="2.4.0 × Google Play"
          />
        </li>
      </ul>
    ),
  },
];
