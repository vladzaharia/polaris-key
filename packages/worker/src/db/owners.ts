/**
 * Table ownership (P0-18). The one declaration of which owner holds which D1 table: `core` or a
 * service slug (`tools/services.json`). Ownership is logical, with one database. The docs data-model
 * generator (`packages/docs/scripts/gen-reference.mjs`) and the worker's table-crossing test
 * (`test/tableCrossings.test.ts`) both import it; nothing at runtime does. Plain data, no imports,
 * so the generator can load it.
 *
 * A table is written only from its owner's directory; the permitted exceptions are `SEAMS` in the
 * crossing test, each with a reason and the work package that removes it.
 */

export const TABLE_OWNERS: Readonly<Record<string, readonly string[]>> = {
  core: [
    "products",
    "product_keys",
    "product_secrets",
    "outlet_credentials",
    // P0-27a: the store infrastructure in core/stores/ (webhook events, per-product connector settings).
    "dist_connector_events",
    "dist_connector_settings",
    "devices",
    "license_refusals",
    "license_auto_attach_blocks",
    "license_key_entries",
    "device_fingerprints",
    "device_facts",
    "audit",
    "product_sync_state",
    "product_manifest_snapshot",
    "product_settings",
    "settings_backfill_reports",
    "schema_index_assertion",
    "blob_objects",
    "blob_refs",
    "blob_gc_log",
    "hosted_assets",
    "ci_publishers",
    "ci_tokens",
    "ci_upload_tickets",
    "lazy_delta_settings",
    "delta_demand_devices",
    "delta_demand",
    "platform_deploys",
    "platform_credentials",
    "platform_credential_pins",
    "platform_store_settings",
    "platform_audit",
    "registry_render_queue",
    "registry_tokens",
    "admin_api_tokens",
    "platform_settings",
    "platform_job_runs",
    "platform_heartbeats",
    "store_operations",
    "email_suppressions",
    "email_product_caps",
    // LX-08 (plans/LX-01.md §6.1): the licensing model. Written only through
    // src/core/licensing/grants.ts (grants, grant_entitlements) and Core (the rest).
    "grants",
    "grant_entitlements",
    "device_store_identities",
    "holder_versions",
    "entitlement_events",
    // ST-28 (plans/ST-28.md §10): operator-owned console role bindings; the migration is ST-31's.
    "console_role_bindings",
  ],
  license: [
    "licenses",
    "keys_index",
    "tiers",
    "license_profiles",
    "license_store_grants",
    "license_batches",
  ],
  config: [
    "product_schema",
    "profiles",
    "edge_mint_config",
    "edge_mint_approvals",
    // U-03: the account override layer and the licence-override migration (S-17 §5.12).
    "account_overrides",
    "override_migration_report",
    "override_migration",
  ],
  release: [
    "release_config",
    "release_metadata",
    "release_artifacts",
    "release_channels",
    "release_channel_floors",
    "release_health",
    "release_download_tokens",
    "release_deliverables",
    "release_builds",
    "release_channel_policy",
    "release_yanks",
    "release_records",
    "release_pins",
    "release_sets",
    "release_set_state",
    "release_holds",
    "release_pack_floors",
    "release_revocations",
    "release_delegations",
    "release_delegated_records",
    "release_lazy_deltas",
    "release_packages",
    "release_native_uploads",
    "release_package_prunes",
    "release_package_retention",
    "release_package_retention_notices",
    "release_mirrors",
  ],
  distribution: [
    "dist_outlets",
    "dist_listing",
    "dist_transports",
    "dist_rollouts",
    "dist_access",
    "dist_availability",
    "dist_submissions",
    "dist_keys",
    "dist_connector_objects",
    "dist_feed_files",
    "dist_readiness",
    "dist_store_products",
    "dist_purchase_bindings",
    "dist_purchase_binding_aliases",
    "dist_purchases",
    // LX-08: the licensing model's commerce tables.
    "dist_store_product_entitlements",
    "dist_holder_bindings",
    "dist_binding_aliases",
    "dist_registry_owners",
    "dist_registry_feeds",
    "dist_registry_policy",
    "dist_listings",
    "dist_listing_locales",
    "dist_listing_assets",
    "dist_listing_release_notes",
    "dist_listing_overrides",
    "store_edit_leases",
  ],
  update: ["update_feed_state", "update_feed_ceiling", "update_feed_docs"],
  identity: [
    "oidc_config",
    "provisioning_config",
    // I-05 (plans/I-04.md §6.1): the Polaris Key account. Core reads the subject rows through
    // src/core/accounts/accountSubjects.ts only; `licenses.account_id` stays License's column and
    // `devices.subject`/`bound_by` Core's.
    "accounts",
    "account_links",
    "account_product_subjects",
    "account_product_subject_aliases",
    "account_tombstones",
    // SEC-WP-04: the progress record of an account erasure that has not finished.
    "account_erasures",
    // I-11: a holder's cancellable, fourteen-day account-deletion request.
    "account_deletions",
    "subject_events",
    "account_sessions",
    "account_product_grants",
    "account_passkeys",
    // PX-W15: terms accepted at the email gate, per account, product and terms version.
    "account_terms_acceptances",
    // I-12: the developer relink tool's history and 72-hour undo.
    "license_relinks",
    // PX-W16: account pictures, re-encoded and content-addressed (renditions in R2 `avatars/`).
    "account_avatars",
    // PS-04: the storefront's library entries (open products, no licence) and its daily
    // aggregates with their two-day keyed-hash impression dedupe.
    "library_entries",
    "storefront_daily",
    "storefront_seen",
    // PX-W12: account joins and their 72-hour undo.
    "account_merges",
    // I-30 (plans/I-27.md §2.3): connections and their DNS-verified email domains. Other code
    // reads them only through src/core/oidc/connections.ts.
    "identity_connections",
    "identity_connection_domains",
    "portal_accounts",
    "portal_account_emails",
    "portal_account_identities",
    "portal_license_links",
    "portal_product_settings",
    "portal_audit",
  ],
};
