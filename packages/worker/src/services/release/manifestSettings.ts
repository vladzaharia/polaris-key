/**
 * Release's manifest-declared settings (ST-19b, notes/S-18 Appendix A.2 `release.*`): the
 * `.pkey/release` fields ST-06's coverage test parked under ST-19, which plans/ST-19.md (owner
 * decision Q1) split out to this package. Spread into `RELEASE_SETTINGS_SLICE` (`settings.ts`).
 *
 * Each entry describes today's storage; nothing moves (no migration):
 *
 *   - the `release_config` block (`channel_workflow`, `beta_branch`, `binary_name`,
 *     `summary_marker`, `manual_channels_json`, `release_keys_json`) is rewritten whole by link and
 *     every resync (`linkRepo.ts`, `resync.ts`). There is no per-field release API in the admin
 *     surface, so each is `manifest`-owned: editing `.pkey/release` is the edit path;
 *   - the per-row tables are `rich`, one adapter per table, which is also how their row-level
 *     source markers find a home: `release_deliverables.def_source`, `release_channel_policy.source`
 *     and `ci_publishers.source`.
 *
 * Two are claimable because the code already lets an operator write them: the channel policy
 * (promote, pin, yank, floors; the console and CI, `policy.ts`) and the trusted publisher (the
 * console's `PUT …/ci-publisher`, `admin/handlers/ciPublishing.ts`).
 *
 * `wire` is set only where the value already reaches a signed document: deliverables (pack ids
 * and version schemes in the feed's `packSets` and `packFloors`) and the channel policy (its
 * pointer, pin and `min_supported` floor decide what the feed names). None changes a document's
 * shape or discovery.
 */

import { setting } from "../../core/settings/define.js";
import type { SettingDef } from "../../core/settings/types.js";

const VISIBLE = { service: "release", offBehaviour: "hide" } as const;
const BLOCK_DOCS = "/docs/services/release/github-sync/";
const releaseConfig = (column: string) =>
  ({ kind: "column", table: "release_config", column }) as const;

export const RELEASE_MANIFEST_SETTINGS: readonly SettingDef[] = [
  setting({
    key: "release.github",
    scope: "product",
    service: "release",
    area: "release.sync",
    label: "GitHub repository",
    description:
      "The GitHub repository releases are read from, named in .pkey/release as provider: { type: github, owner, repo }. The stored coordinates are those of the repository the product is linked to, written with its GitHub App installation when it is linked.",
    keywords: ["provider", "owner", "repo", "repository", "link"],
    docs: BLOCK_DOCS,
    value: { kind: "json", schema: "provider (release.schema.json)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    // Read-only in the console: Link and Unlink change which repository is linked, never a
    // settings write. The platform's own product must name the platform repository
    // (`admin/systemProduct.ts`). Storage holds one column: `gh_repo` and `gh_installation_id`
    // sit beside `gh_owner` and are written with it.
    ownership: "manifest",
    manifest: { path: "release:release.provider" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: [
      "services/release/config.ts",
      "services/release/gateway.ts",
      "services/release/sync.ts",
      "admin/systemProduct.ts",
    ],
    storage: releaseConfig("gh_owner"),
    since: "ST-19b",
  }),
  setting({
    key: "release.binaryName",
    scope: "product",
    service: "release",
    area: "release.sync",
    label: "Binary name",
    description:
      "The executable's name in artifact file names and in the install script users pipe into sh. Unset means the repository's name.",
    keywords: ["executable", "install.sh", "artifact names"],
    docs: BLOCK_DOCS,
    value: {
      kind: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      maxLength: 64,
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "release:release.binaryName" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: [
      "services/release/source.ts",
      "services/release/install.ts",
      "services/update/feed.ts",
    ],
    storage: releaseConfig("binary_name"),
    since: "ST-19b",
  }),
  setting({
    key: "release.channelWorkflow",
    scope: "product",
    service: "release",
    area: "release.channels",
    label: "Channel workflow",
    description:
      "The GitHub Actions workflow (a file name or numeric id) whose successful runs make the beta and pr-<n> channels: beta is the newest tag a run built from the beta branch, pr-<n> the newest from that pull request. Unset, both fall back to prerelease tags.",
    keywords: ["beta", "pull request", "actions", "workflow runs"],
    docs: BLOCK_DOCS,
    value: {
      kind: "string",
      pattern: "^(?:[0-9]{1,20}|[A-Za-z0-9._-]{1,100}\\.ya?ml)$",
      maxLength: 105,
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "release:release.channelWorkflow" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: ["services/release/channels.ts", "services/release/gateway.ts"],
    storage: releaseConfig("channel_workflow"),
    since: "ST-19b",
  }),
  setting({
    key: "release.betaBranch",
    scope: "product",
    service: "release",
    area: "release.channels",
    label: "Beta branch",
    description:
      "The branch whose channel-workflow runs make the beta channel. Used only with a channel workflow.",
    keywords: ["beta", "branch"],
    docs: BLOCK_DOCS,
    value: {
      kind: "string",
      pattern: "^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$",
      maxLength: 255,
    },
    defaultValue: "main",
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "release:release.betaBranch" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: ["services/release/gateway.ts"],
    storage: releaseConfig("beta_branch"),
    since: "ST-19b",
  }),
  setting({
    key: "release.summaryMarker",
    scope: "product",
    service: "release",
    area: "release.sync",
    label: "Summary marker",
    description:
      "The HTML-comment marker that fences a release's summary in its GitHub release notes (<!-- pkey:summary --> … <!-- /pkey:summary -->). The changelog route and the appcast show the fenced text, else the first paragraph above the first ## heading.",
    keywords: ["changelog", "release notes", "summary"],
    docs: BLOCK_DOCS,
    value: {
      kind: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$",
      maxLength: 64,
    },
    defaultValue: "pkey:summary",
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "release:release.summaryMarker" },
    confirm: { change: "L0" },
    visibleWhen: VISIBLE,
    readers: ["services/release/surfaces.ts", "services/update/feed.ts"],
    storage: releaseConfig("summary_marker"),
    since: "ST-19b",
  }),
  setting({
    key: "release.manualChannels",
    scope: "product",
    service: "release",
    area: "release.channels",
    label: "Manual channels",
    description:
      "Named channels beyond stable and beta, each matching release tags by an anchored regular expression (a nightly or canary line). Licences grant them and SDKs request them like any other channel.",
    keywords: ["nightly", "canary", "channels", "regex"],
    docs: BLOCK_DOCS,
    value: { kind: "json", schema: "manualChannels (release.schema.json)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "release:release.manualChannels" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: [
      "services/release/channels.ts",
      "services/release/resolve.ts",
      "services/update/compose.ts",
    ],
    storage: releaseConfig("manual_channels_json"),
    since: "ST-19b",
  }),
  setting({
    key: "release.deliverables",
    scope: "product",
    service: "release",
    area: "release.deliverables",
    label: "Deliverables",
    description:
      "What the product releases: its app (versioning, channels and artifact map), its packs and its packages. Unset means one implicit app deliverable whose files are classified by name.",
    keywords: ["app", "packs", "packages", "artifact map", "versioning"],
    docs: "/docs/build/manifest/authoring/",
    value: { kind: "json", schema: "deliverables (release.schema.json)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    // `def_source` is always 'manifest' today: nothing but link and resync writes a declaration.
    ownership: "manifest",
    manifest: { path: "release:release.deliverables" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    readers: [
      "services/release/deliverables.ts",
      "services/release/model.ts",
      "services/release/descriptor.ts",
      "services/release/resolve.ts",
    ],
    storage: { kind: "rich", adapter: "release_deliverables" },
    since: "ST-19b",
  }),
  setting({
    key: "release.channelPolicy",
    scope: "product",
    service: "release",
    area: "release.channels",
    label: "Channel policy",
    description:
      "Per deliverable and channel: the pointer, the pin, the channels it includes, the device floor and the critical flag. The manifest declares includes; a promote, pin or floor change from the console or CI claims that row until Revert.",
    keywords: ["promote", "pin", "yank", "floor", "includes", "minSupported"],
    docs: "/docs/services/release/channels/",
    value: { kind: "json", schema: "release_channel_policy rows (model.ts)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    // Claimed per row (`source = 'admin'`), the tiers precedent; Revert hands the row back.
    ownership: "claimable",
    manifest: { path: "release:release.deliverables.app.channels" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    readers: [
      "services/release/policy.ts",
      "services/release/model.ts",
      "services/release/resolve.ts",
      "services/update/packParts.ts",
    ],
    storage: { kind: "rich", adapter: "release_channel_policy" },
    since: "ST-19b",
  }),
  setting({
    key: "release.publishing.trustedPublisher",
    scope: "product",
    service: "release",
    area: "release.publishing",
    label: "Trusted publisher",
    description:
      "Which GitHub Actions workflow and environment may exchange their OIDC token for a short-lived pkeyci_ token, and with which scopes. Pointing it at another workflow or environment changes who can publish.",
    keywords: ["ci", "oidc", "pkeyci", "publish", "workflow", "environment"],
    docs: "/docs/services/release/artifacts/",
    value: { kind: "json", schema: "ci_publishers row (core/publisher.ts)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    // The console's `PUT …/ci-publisher` claims the row (`source = 'admin'`) and is the only way
    // to grant `release:yank`; resync leaves a claimed row alone. No revert route exists yet.
    ownership: "claimable",
    manifest: { path: "release:release.publishing.trustedPublisher" },
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L2" },
    visibleWhen: VISIBLE,
    readers: [
      "core/publisher.ts",
      "admin/handlers/ciPublishing.ts",
      "services/release/resync.ts",
    ],
    storage: { kind: "rich", adapter: "ci_publishers" },
    since: "ST-19b",
  }),
  setting({
    key: "release.keys",
    scope: "product",
    service: "release",
    area: "release.signing",
    label: "Release keys",
    description:
      "The Ed25519 public keys CI signs release records with (pkey-release+jws), one to four. A record is accepted only when signed by one of them, and a release without one is never a feed target, so whoever holds a matching private key can publish releases devices are offered. Public keys only.",
    keywords: ["releaseKeys", "release records", "signing", "kid"],
    docs: "/docs/services/update/signed-feed/",
    value: { kind: "json", schema: "releaseKeys (release.schema.json)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "manifest",
    manifest: { path: "release:release.releaseKeys" },
    securityWidening: true,
    widensWhen: "any",
    critical: true,
    confirm: { change: "L2" },
    visibleWhen: VISIBLE,
    readers: [
      "services/release/records.ts",
      "services/release/packs/delegations.ts",
      "services/update/simulate.ts",
    ],
    storage: releaseConfig("release_keys_json"),
    since: "ST-19b",
  }),
];
