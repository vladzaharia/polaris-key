/**
 * Settings coverage (ST-06, notes/S-18 §4.13 item 2): the evidence for "configure everything".
 *
 * Four kinds of thing can hold a setting without the registry knowing:
 *
 *   - `column:<table>.<column>`: every ownership marker in the migrated D1 schema (a column named
 *     `source` or ending in `_source`);
 *   - `table:<name>`: every settings-shaped table (`SETTINGS_SHAPED_TABLES`, plus any table whose
 *     name ends in `_settings`, `_config`, `_policy` or `_policies`);
 *   - `env:<NAME>`: every `Env` member in the platform inventory (ST-02), which its own gate keeps
 *     a superset of every name `src/` reads off the env;
 *   - `manifest:<document>:<field>`: every top-level field of the four `.pkey/` documents
 *     (`product`, `schema`, `release`, `distribution`).
 *
 * Each must be declared by a registry entry (`declaredByRegistry`), explained by a
 * `NOT_A_SETTING` row, or listed in `PENDING` with the work package that will register it.
 * `PENDING` may only shrink: `checkCoverage` refuses an entry that is already declared (remove
 * it), an entry that names nothing that exists, and a list longer or shorter than
 * `PENDING_CEILING`. ST-25 closes with `PENDING` empty (S-18 §4.13).
 *
 * Data plus pure checks: `test/settings-coverage.test.ts` reads the schema, the inventory and
 * the manifest schemas and runs `checkCoverage`; `scripts/gen-settings.ts` publishes
 * `NOT_A_SETTING` on the generated reference page and in the console's search index, so search
 * can explain why a thing is fixed. Nothing here is read at runtime, which is why it lives under
 * `scripts/` and not `src/`: it names every settings-shaped table, the credential tables among
 * them, and only the allowlisted Worker files may name those (`test/outletCredentialReach.test.ts`).
 */

import type { InventoryKind } from "../src/platformInventory.js";
import type { SettingDef } from "../src/core/settings/types.js";

/** One thing that could hold a setting, with what the checks need to know about it. */
export interface CoverageTarget {
  /** `column:<table>.<column>`, `table:<name>`, `env:<NAME>` or `manifest:<doc>:<field>`. */
  id: string;
  /** For `env:` targets: the inventory kind (bindings and secrets are explained as a class). */
  inventoryKind?: InventoryKind;
}

/** A thing that looks configurable but is fixed on purpose (S-18 Appendix A.4). */
export interface NotASetting {
  thing: string;
  reason: string;
  /** Where an operator meets it instead (a page, a read-only list, docs). */
  shows: string;
  /** The coverage targets this row explains: exact ids, and/or every env name of a kind. */
  covers?: {
    ids?: readonly string[];
    inventoryKinds?: readonly InventoryKind[];
  };
}

/** A target no registry entry declares yet, and the work package that will register it. */
export interface PendingEntry {
  target: string;
  /** The registered work package that removes this entry when it registers the setting. */
  owner: string;
  note?: string;
}

/** The two scalar stores the registry itself owns: declared by construction. */
export const REGISTRY_STORES: readonly string[] = [
  "platform_settings",
  "product_settings",
];

/**
 * Tables that hold settings, whatever their name. Tables whose name ends in `_settings`,
 * `_config`, `_policy` or `_policies` are added by pattern (`settingsShapedTables`), so a new
 * one cannot slip past by omission.
 */
export const SETTINGS_SHAPED_TABLES: readonly string[] = [
  "ci_publishers",
  "dist_access",
  "dist_connector_settings",
  "dist_listings",
  "dist_outlets",
  "dist_registry_feeds",
  "dist_registry_policy",
  "dist_store_products",
  "dist_transports",
  "edge_mint_config",
  "email_product_caps",
  "lazy_delta_settings",
  "oidc_config",
  "outlet_credentials",
  "platform_credentials",
  "platform_settings",
  "platform_store_settings",
  "portal_product_settings",
  "product_keys",
  "product_schema",
  "product_secrets",
  "profiles",
  "provisioning_config",
  "release_channel_floors",
  "release_channel_policy",
  "release_config",
  "release_pack_floors",
  "tiers",
];

const SETTINGS_TABLE_RE = /_(settings|config|policy|policies)$/;

/** The settings-shaped tables among `tables`: the explicit list plus every name-pattern match. */
export function settingsShapedTables(tables: readonly string[]): string[] {
  const set = new Set(SETTINGS_SHAPED_TABLES);
  return tables.filter((t) => set.has(t) || SETTINGS_TABLE_RE.test(t)).sort();
}

/**
 * Legacy ownership markers and the value column each one governs (S-18 §4.2, the eleven legacy
 * columns): the marker is declared when the registry declares its value column. Row-level
 * `source` columns on a table the registry reads through an adapter are declared by the adapter.
 */
export const SOURCE_MARKERS: Readonly<Record<string, string>> = {
  "products.services_source": "products.services_json",
  "products.compat_source": "products.compat_min",
  "products.fingerprint_policy_source": "products.fingerprint_policy_json",
  "products.auto_issue_source": "products.auto_issue_json",
  "products.trust_policy_source": "products.trust_policy_json",
  "release_config.access_source": "release_config.metadata_access",
};

/** Every coverage target one registry entry declares. */
export function declaredByEntry(e: SettingDef): string[] {
  const out: string[] = [];
  const s = e.storage;
  if (s.kind === "column") {
    out.push(`column:${s.table}.${s.column}`, `table:${s.table}`);
    for (const [marker, value] of Object.entries(SOURCE_MARKERS))
      if (value === `${s.table}.${s.column}`) out.push(`column:${marker}`);
  }
  if (s.kind === "rich") out.push(`table:${s.adapter}`, `rows:${s.adapter}`);
  if (e.varName) out.push(`env:${e.varName}`);
  if (e.manifest) {
    const [doc, dotted] = e.manifest.path.split(":") as [string, string];
    out.push(`manifest:${doc}:${dotted.split(".")[0]}`);
  }
  return out;
}

/** Is `id` declared by the registry? (`rows:<table>` covers that table's row-level markers.) */
export function declaredByRegistry(
  entries: readonly SettingDef[],
): (id: string) => boolean {
  const declared = new Set<string>(REGISTRY_STORES.map((t) => `table:${t}`));
  for (const e of entries) for (const d of declaredByEntry(e)) declared.add(d);
  return (id) => {
    if (declared.has(id)) return true;
    const col = /^column:([^.]+)\.(?:[a-z_]+_)?source$/.exec(id);
    return col !== null && declared.has(`rows:${col[1]}`);
  };
}

/**
 * Fixed on purpose. The first rows are S-18 Appendix A.4 verbatim (concepts search explains);
 * the rest explain the concrete targets the coverage test finds.
 */
export const NOT_A_SETTING: readonly NotASetting[] = [
  {
    thing: "Refund, void and chargeback handling",
    reason:
      "Always revokes that one grant (S-19 decision 5); a keep-access-after-refund switch would override a store's revocation.",
    shows: "Distribution → Commerce",
  },
  {
    thing: "Relink undo window (72 hours)",
    reason:
      "Owner decision (S-16); it bounds a security-sensitive support action.",
    shows: "Docs",
  },
  {
    thing:
      "Rate-limit buckets, admin session (8 hours), audit retention (180 days), blob lock age, CI and registry token lifetimes, body caps",
    reason: "The S-13 §8.2 deny-list: deploy-time forever.",
    shows: "Docs",
  },
  {
    thing:
      "Wire constants (document expiry, size and count maximums), discovery cache (300 s)",
    reason: "Changing one is a wire event (AGENTS.md rule 2), not a setting.",
    shows: "Docs: the reference section",
  },
  {
    thing: "Dormant account deletion (36 months)",
    reason:
      "Platform retention is deny-listed; a product may only shorten its own data's retention.",
    shows: "Docs",
  },
  {
    thing: "Subject-feed cursor retention",
    reason: "Part of I-04's pull contract.",
    shows: "Docs",
  },
  {
    thing: "Grants, entitlements, catalog flags and account overrides",
    reason: "Customer data and customer configuration, not Polaris behaviour.",
    shows: "License → Licenses; Config → Catalog",
  },
  {
    thing:
      "Cloudflare bindings (D1, KV, R2, queues, Durable Objects, rate limiters)",
    reason:
      "Infrastructure wiring declared in wrangler.toml and the platform inventory (ST-02), changed by a deploy.",
    shows: "Platform → Settings (the read-only inventory)",
    covers: { inventoryKinds: ["binding"] },
  },
  {
    thing:
      "Credential and key material (the KEK, pepper, session secrets, OIDC client secrets, store and GitHub App keys)",
    reason:
      "Key material (the AT-2 deny-list): reported as present or absent, never as a value. Store credential slots are console-managed through platform_credentials, a settings-shaped table.",
    shows:
      "Platform → Settings (secrets, by presence); Platform → Store connections",
    covers: { inventoryKinds: ["secret"] },
  },
  {
    thing: "Origins (console, blob, package and image hosts)",
    reason: "The S-13 §8.2 deny-list: an origin is deploy-time forever.",
    shows: "Platform → Settings (the read-only inventory)",
    covers: {
      ids: [
        "env:CONSOLE_ORIGIN",
        "env:BLOB_ORIGIN",
        "env:PKG_ORIGIN",
        "env:IMG_ORIGIN",
      ],
    },
  },
  {
    thing:
      "The privilege root and the admin identity provider (admin group, platform and admin OIDC issuer and client, issuer allowlist)",
    reason: "The S-13 §8.2 deny-list: who may administer is fixed at deploy.",
    shows: "Platform → Settings (the read-only inventory)",
    covers: {
      ids: [
        "env:PLATFORM_ADMIN_GROUP",
        "env:PLATFORM_OIDC_ISSUER",
        "env:PLATFORM_OIDC_CLIENT_ID",
        "env:ADMIN_OIDC_ISSUER",
        "env:ADMIN_OIDC_CLIENT_ID",
        "env:OIDC_ISSUER_ALLOWLIST",
      ],
    },
  },
  {
    thing:
      "The login card's platform sign-in clients (Google client id, Apple Services ID, team and key id) and the Turnstile site key",
    reason:
      "Deploy-time platform identity configuration (I-06, I-07): each pairs with a sealed secret set from the RUNBOOK, and the site key is public by design.",
    shows: "Platform → Settings (the read-only inventory)",
    covers: {
      ids: [
        "env:SIGNIN_GOOGLE_CLIENT_ID",
        "env:SIGNIN_APPLE_SERVICES_ID",
        "env:SIGNIN_APPLE_TEAM_ID",
        "env:SIGNIN_APPLE_KEY_ID",
        "env:TURNSTILE_SITE_KEY",
      ],
    },
  },
  {
    thing: "Key-encryption key identity (active key id and flag)",
    reason:
      "Key material (the AT-2 deny-list); rotated by the keyring runbook.",
    shows: "Platform → Settings (the KEK keyring)",
    covers: { ids: ["env:PLATFORM_KEK_ID", "env:PLATFORM_KEK_ACTIVE"] },
  },
  {
    thing: "Storage location (blob bucket name, R2 parent account)",
    reason:
      "A bucket name is on the S-13 §8.2 deny-list; both are fixed by the deployment.",
    shows: "Platform → Settings (the read-only inventory)",
    covers: { ids: ["env:BLOBS_BUCKET_NAME", "env:R2_ACCOUNT_ID"] },
  },
  {
    thing:
      "Deployment identity (environment, release tag, git SHA, platform repository and deploy environment, GitHub App id)",
    reason: "Written by the deploy pipeline; it describes the running build.",
    shows: "Platform → Deployment",
    covers: {
      ids: [
        "env:PKEY_ENVIRONMENT",
        "env:PKEY_RELEASE_TAG",
        "env:PKEY_GIT_SHA",
        "env:PLATFORM_REPOSITORY",
        "env:PLATFORM_REPOSITORY_ID",
        "env:PLATFORM_REPOSITORY_OWNER_ID",
        "env:PLATFORM_DEPLOY_ENVIRONMENT",
        "env:GITHUB_APP_ID",
      ],
    },
  },
  {
    thing:
      "Release yanks, deprecations, rollouts, readiness overrides and submissions",
    reason: "Operational actions on records, not configuration.",
    shows: "Release → Releases; Distribution → Rollouts and Matrix",
    covers: {
      ids: [
        "column:dist_rollouts.source",
        "column:dist_readiness.source",
        "column:dist_submissions.source",
        "column:dist_availability.source",
      ],
    },
  },
  {
    thing: "Sync and link records (how a product was linked and last synced)",
    reason:
      "Records of what happened: release_source says whether a product is linked to a repository (changed by Link and Unlink), product_sync_state.source says whether a sync was manual or a webhook.",
    shows: "Core → Settings; Core → Overview",
    covers: {
      ids: [
        "column:products.release_source",
        "column:product_sync_state.source",
      ],
    },
  },
  {
    thing: "Customer licence links",
    reason:
      "Customer data: how a portal account came to hold a licence, not Polaris behaviour.",
    shows: "License → Licenses",
    covers: { ids: ["column:portal_license_links.source"] },
  },
  {
    thing: "Outlet signing-key fingerprints",
    reason:
      "Key-material records, registered by an operator or observed at an outlet; they describe keys, not behaviour.",
    shows: "Distribution → Outlets & feeds",
    covers: { ids: ["column:dist_keys.source"] },
  },
  {
    thing: "Document versions (apiVersion, schemaVersion) and the product slug",
    reason:
      "The slug is the product's identity and never changes; apiVersion selects a manifest shape; schemaVersion stamps the catalog and is written with it (config.catalog) as one unit.",
    shows: "Core → Overview; pkey validate",
    covers: {
      ids: [
        "manifest:product:apiVersion",
        "manifest:product:slug",
        "manifest:schema:schemaVersion",
        "manifest:distribution:apiVersion",
      ],
    },
  },
];

/**
 * Not registered yet. Remove an entry in the change that registers it; `checkCoverage` fails
 * while a registered thing is still listed. Never add one: a new setting is registered when it
 * lands (lower `PENDING_CEILING` with every removal).
 */
export const PENDING: readonly PendingEntry[] = [
  // SQL-only stores (S-18 §2.2).
  { target: "table:lazy_delta_settings", owner: "ST-11" },
  { target: "table:email_product_caps", owner: "ST-11" },
  {
    target: "env:EMAIL_PRODUCT_DAILY_CAP",
    owner: "ST-11",
    note: "email.dailyCapDefault",
  },
  // API-only stores (S-18 §2.2).
  { target: "table:platform_store_settings", owner: "ST-12" },
  { target: "table:platform_credentials", owner: "ST-12" },
  { target: "table:outlet_credentials", owner: "ST-12" },
  { target: "table:dist_store_products", owner: "ST-12" },
  { target: "column:dist_store_products.source", owner: "ST-12" },
  {
    target: "env:PLATFORM_APPLE_TEAM_ID",
    owner: "ST-12",
    note: "stores.appStore.teamId",
  },
  // Storefront listing (S-18 D11).
  { target: "table:dist_listings", owner: "ST-13" },
  { target: "column:dist_listings.source", owner: "ST-13" },
  { target: "column:dist_listing_assets.source", owner: "ST-13" },
  { target: "column:dist_listing_locales.source", owner: "ST-13" },
  { target: "column:dist_listing_overrides.source", owner: "ST-13" },
  { target: "column:dist_listing_release_notes.source", owner: "ST-13" },
  { target: "manifest:distribution:listing", owner: "ST-13" },
  // Portal settings.
  { target: "table:portal_product_settings", owner: "ST-14" },
  // Platform settings area.
  {
    target: "table:dist_registry_policy",
    owner: "ST-09",
    note: "feeds.<eco> policy",
  },
  {
    target: "table:dist_registry_feeds",
    owner: "ST-09",
    note: "distribution.feeds.<eco>",
  },
  { target: "env:EMAIL_SENDER_ADDRESS", owner: "ST-09", note: "email.sender" },
  {
    target: "env:PORTAL_EMAIL_FROM",
    owner: "ST-09",
    note: "older spelling of email.sender",
  },
  { target: "env:EMAIL_APPLE_RELAY", owner: "ST-09", note: "email.appleRelay" },
  // Operator-owned product objects the settings hub hosts.
  { target: "table:product_keys", owner: "ST-08", note: "core.keys" },
  { target: "table:product_secrets", owner: "ST-08", note: "core.secrets" },
  {
    target: "table:release_channel_floors",
    owner: "ST-08",
    note: "release.channelFloors",
  },
  {
    target: "table:release_pack_floors",
    owner: "ST-08",
    note: "release.channelFloors (packs)",
  },
  { target: "column:release_pack_floors.source", owner: "ST-08" },
  // Manifest-declared settings with no entry yet: the registry ↔ manifest parity package.
  {
    target: "table:ci_publishers",
    owner: "ST-19",
    note: "release.publishing.trustedPublisher",
  },
  { target: "column:ci_publishers.source", owner: "ST-19" },
  {
    target: "table:release_channel_policy",
    owner: "ST-19",
    note: "release.channelPolicy",
  },
  { target: "column:release_channel_policy.source", owner: "ST-19" },
  {
    target: "column:release_deliverables.def_source",
    owner: "ST-19",
    note: "release.deliverables",
  },
  {
    target: "table:provisioning_config",
    owner: "ST-19",
    note: "identity.provisioning",
  },
  {
    target: "table:dist_transports",
    owner: "ST-19",
    note: "distribution.transports",
  },
  {
    target: "manifest:product:product",
    owner: "ST-19",
    note: "duplicate spelling (the productCore wrapper)",
  },
  {
    target: "manifest:product:compatMax",
    owner: "ST-19",
    note: "second field of release.compatWindow",
  },
  {
    target: "manifest:product:defaultDeviceLimit",
    owner: "ST-19",
    note: "duplicate spelling of licensing.defaultDeviceLimit",
  },
  {
    target: "manifest:product:defaultMaxOfflineDays",
    owner: "ST-19",
    note: "duplicate spelling of licensing.defaultMaxOfflineDays",
  },
  {
    target: "manifest:product:devices",
    owner: "ST-19",
    note: "core.registration",
  },
  {
    target: "manifest:product:provisioning",
    owner: "ST-19",
    note: "identity.provisioning",
  },
  {
    target: "manifest:product:secrets",
    owner: "ST-19",
    note: "core.secrets (names only)",
  },
  {
    target: "manifest:product:release",
    owner: "ST-19",
    note: "the release document inlined",
  },
  {
    target: "manifest:schema:catalog",
    owner: "ST-19",
    note: "duplicate spelling of entries",
  },
  {
    target: "manifest:release:release",
    owner: "ST-19",
    note: "duplicate spelling (the wrapper)",
  },
  {
    target: "manifest:release:provider",
    owner: "ST-19",
    note: "release.github",
  },
  {
    target: "manifest:release:ghOwner",
    owner: "ST-19",
    note: "release.github",
  },
  { target: "manifest:release:ghRepo", owner: "ST-19", note: "release.github" },
  { target: "manifest:release:binaryName", owner: "ST-19" },
  { target: "manifest:release:channelWorkflow", owner: "ST-19" },
  { target: "manifest:release:betaBranch", owner: "ST-19" },
  { target: "manifest:release:summaryMarker", owner: "ST-19" },
  { target: "manifest:release:manualChannels", owner: "ST-19" },
  { target: "manifest:release:stableTagPattern", owner: "ST-19" },
  { target: "manifest:release:ignoreTags", owner: "ST-19" },
  {
    target: "manifest:release:deliverables",
    owner: "ST-19",
    note: "release.deliverables",
  },
  { target: "manifest:release:edgeMint", owner: "ST-19" },
  {
    target: "manifest:release:publishing",
    owner: "ST-19",
    note: "release.publishing.trustedPublisher",
  },
  {
    target: "manifest:release:releaseKeys",
    owner: "ST-19",
    note: "release.keys",
  },
  {
    target: "manifest:distribution:transports",
    owner: "ST-19",
    note: "distribution.transports",
  },
];

/** `PENDING.length`, written down: lower it with every removal; raising it needs a review. */
export const PENDING_CEILING = 59;

export interface CoverageInputs {
  targets: readonly CoverageTarget[];
  entries: readonly SettingDef[];
  notASetting?: readonly NotASetting[];
  pending?: readonly PendingEntry[];
  ceiling?: number;
  /** Registered work-package ids; a PENDING owner must be one of them. */
  workPackages?: ReadonlySet<string>;
}

/** Every coverage failure, as readable strings. Empty = "configure everything" holds so far. */
export function checkCoverage(inputs: CoverageInputs): string[] {
  const {
    targets,
    entries,
    notASetting = NOT_A_SETTING,
    pending = PENDING,
    ceiling = PENDING_CEILING,
    workPackages,
  } = inputs;
  const errors: string[] = [];
  const registered = declaredByRegistry(entries);
  const byId = new Map(targets.map((t) => [t.id, t]));

  const explainedIds = new Map<string, string>();
  const explainedKinds = new Map<InventoryKind, string>();
  for (const n of notASetting) {
    for (const id of n.covers?.ids ?? []) {
      if (explainedIds.has(id))
        errors.push(`NOT_A_SETTING explains ${id} twice`);
      explainedIds.set(id, n.thing);
      if (!byId.has(id))
        errors.push(
          `NOT_A_SETTING "${n.thing}" names ${id}, which no longer exists: remove it`,
        );
      else if (registered(id))
        errors.push(
          `NOT_A_SETTING "${n.thing}" names ${id}, which a registry entry declares: remove it`,
        );
    }
    for (const k of n.covers?.inventoryKinds ?? [])
      explainedKinds.set(k, n.thing);
  }
  const explained = (t: CoverageTarget): boolean =>
    explainedIds.has(t.id) ||
    (t.inventoryKind !== undefined && explainedKinds.has(t.inventoryKind));

  const pendingIds = new Set<string>();
  for (const p of pending) {
    if (pendingIds.has(p.target))
      errors.push(`PENDING lists ${p.target} twice`);
    pendingIds.add(p.target);
    const t = byId.get(p.target);
    if (!t)
      errors.push(
        `PENDING lists ${p.target}, which no longer exists: remove it (and lower PENDING_CEILING)`,
      );
    else if (registered(p.target))
      errors.push(
        `PENDING lists ${p.target}, which a registry entry now declares: remove it (and lower PENDING_CEILING)`,
      );
    else if (explained(t))
      errors.push(
        `PENDING lists ${p.target}, which NOT_A_SETTING explains: remove it from one of them`,
      );
    if (workPackages && !workPackages.has(p.owner))
      errors.push(
        `PENDING ${p.target}: owner ${p.owner} is not a registered work package`,
      );
  }
  if (pending.length !== ceiling)
    errors.push(
      pending.length > ceiling
        ? `PENDING has ${pending.length} entries, above PENDING_CEILING (${ceiling}): the list only shrinks; register the setting instead`
        : `PENDING has ${pending.length} entries: lower PENDING_CEILING from ${ceiling} to ${pending.length}`,
    );

  for (const t of targets)
    if (!registered(t.id) && !explained(t) && !pendingIds.has(t.id))
      errors.push(
        `${t.id} has no home: register it (core/settings or a service's settings slice) or explain it in NOT_A_SETTING`,
      );
  return errors;
}
