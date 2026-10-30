import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/limits.js";
import { TEST_ROOT } from "../paths.js";

/**
 * The limits inventory (ST-09). `src/limits.ts` lists the code constants the console's Limits
 * section shows, each imported from its owner so the page cannot drift from the code. This test
 * keeps the list whole: a limit-shaped numeric constant exported from Core, the platform layer,
 * the console or a top-level module must be a row there or be named in `INTERNAL` below (batch
 * sizes, per-call timeouts and response ceilings an operator is never asked about). Services'
 * constants are out of reach of the console by the layer rule, so they are not scanned.
 */

const SRC = join(TEST_ROOT, "..", "src");
const NAME =
  /(SECONDS|TTL|BYTES|_MAX\b|^MAX_|_MAX_|LIMIT|CAP\b|_CAP_|_PER_|DAYS|RETENTION|GRACE|_MS\b|WINDOW|BUDGET|TIMEOUT)/;

/** Exported numeric constants that are implementation tuning, by file. A new one needs a row in `LIMITS` instead. */
const INTERNAL: Record<string, string[]> = {
  "assetQueue.ts": ["MIRROR_BATCH_BUDGET_MS"],
  "core/deviceEntry.ts": [
    "DEVICE_ENTRY_WIDE_LIMIT",
    "DEVICE_ENTRY_WIDE_WINDOW_SEC",
  ],
  "core/signInBind.ts": ["BIND_TTL_SECONDS"],
  // The 30 days a reset keeps the replaced ring, fixed by the wire contract (V5 §13.11.4).
  "core/keyring/store.ts": ["PREVIOUS_RING_SECONDS"],
  // The `keys` proof skew, fixed by the wire contract (V5 §15.8), not an operator setting.
  "core/devices/proof.ts": ["KEY_POP_SKEW_SECONDS"],
  // The size of one `console.access` document (the rules list and a rule's label), validated at
  // write time (ST-32.2), and the clock skew an `asserted_at` may show, not an operator setting.
  "core/rbac/claimMatcher.ts": ["MAX_ACCESS_RULES", "MAX_RULE_LABEL"],
  "core/rbac/ruleGrants.ts": ["ASSERTED_SKEW_SECONDS"],
  // The floating-major Cache-Control max-age of the elements CDN: a cache header, not a limit.
  "core/elements.ts": ["ELEMENTS_MAJOR_MAX_AGE"],
  "console/handlers/access.ts": ["ACCESS_ADMINS_LIMIT"],
  "console/handlers/bundles.ts": ["BUNDLE_IMPORT_WINDOW_SECONDS"],
  "console/handlers/devices.ts": ["DEVICE_PAGE_MAX"],
  "console/handlers/github.ts": ["REPOSITORY_CACHE_SECONDS"],
  "console/handlers/polarisKeyStorefront.ts": [
    "PERSONA_GROUPS_MAX",
    "PERSONA_STORES_MAX",
  ],
  "console/handlers/refusals.ts": ["REFUSED_SINCE_DEFAULT_SECONDS"],
  "console/handlers/search.ts": [
    "SEARCH_KIND_CAP",
    "SEARCH_PER_MINUTE",
    "SEARCH_QUERY_MAX",
  ],
  "console/handlers/supportCodes.ts": ["SUPPORT_CODE_LOOKUPS_PER_MINUTE"],
  "console/lib/operatorNotices.ts": ["NOTICE_CAP"],
  "console/passkeySignin.ts": ["CONSOLE_PASSKEY_PER_NETWORK_MINUTE"],
  "console/settingsBackfill.ts": ["BATCH_LIMIT"],
  "core/accounts/accountSubjects.ts": ["MERGE_REDIRECT_SECONDS"],
  "core/accounts/erasureFence.ts": ["ERASURE_CLEAR_TTL_SECONDS"],
  "core/accounts/personalTokens.ts": [
    "PERSONAL_TOKEN_MIN_DAYS",
    "PERSONAL_TOKEN_LABEL_MAX",
    "PERSONAL_TOKEN_RETENTION_SECONDS",
    "ADMIN_TOKEN_LIST_LIMIT",
  ],
  "core/ascProvisioning.ts": [
    "MAX_BUNDLE_PAGES",
    "EXPIRY_WARNING_DAYS",
    "MAX_SIGNING_PAGES",
  ],
  "core/assets/blobGc.ts": [
    "GC_INDEX_READS_PER_TICK",
    "GC_DROPS_PER_PRODUCT",
    "GC_STALE_CLAIM_SECONDS",
  ],
  "core/assets/blobs.ts": ["MAX_REF_HOLDERS", "MAX_LAZY_DELTA_KEYS"],
  "core/assets/deltaDemand.ts": [
    "MAX_PACK_INSTALLS",
    "PACK_INSTALL_STRING_MAX",
    "HOT_WINDOW_SECONDS",
    "MAX_DEMAND_ROWS_PER_DEVICE",
  ],
  "core/assets/hostedAssetPulls.ts": [
    "PULL_BACKOFF_CAP_SECONDS",
    "RECHECK_MAX_PER_RUN",
    "RECHECK_MAX_PAGES",
  ],
  "core/assets/hostedAssetUploads.ts": [
    "IMAGE_HEADER_BYTES",
    "MAX_PUSH_ASSETS",
    "MAX_PUSH_BODY_BYTES",
  ],
  "core/assets/hostedAssets.ts": ["PULL_BACKOFF_BASE_SECONDS"],
  "core/assets/imgHost.ts": ["IMG_MAX_SCREENSHOT"],
  "core/assets/sniff.ts": ["SNIFF_BYTES"],
  "core/cappedBody.ts": ["DEFAULT_BODY_CAP"],
  "core/console/session.ts": [
    "STEP_UP_MAX_AGE_SECONDS",
    "BREAK_GLASS_TTL_SECONDS",
  ],
  "core/console/writeChecks.ts": ["MIN_OFFLINE_DAYS", "MAX_OFFLINE_DAYS"],
  "core/integration/sightings.ts": ["SIGHTING_WRITE_INTERVAL_SECONDS"],
  "core/licensing/licenseDelete.ts": ["LICENSE_IDS_PER_QUERY"],
  "core/licensing/refusals.ts": [
    "REFUSAL_DEBOUNCE_SECONDS",
    "REFUSAL_LABEL_MAX",
  ],
  "core/migrate/runner.ts": [
    "MIGRATION_LEASE_SECONDS",
    "MIGRATION_REPORT_MAX_AGE_SECONDS",
  ],
  "core/notify/alertDestinations.ts": [
    "MAX_DESTINATIONS_PER_SCOPE",
    "TEST_INTERVAL_SECONDS",
    "TESTS_PER_HOUR",
  ],
  "core/notify/alertWebhook.ts": ["WEBHOOK_TIMEOUT_MS"],
  "core/notify/emailLimits.ts": ["EMAIL_LOCKOUT_WINDOW_SECONDS"],
  "core/notify/emailSender.ts": ["SENDER_APP_NAME_MAX"],
  "core/notify/templates.ts": ["NOTICE_VALUE_MAX"],
  "core/oidc/client.ts": ["OIDC_MAX_BYTES", "OIDC_TIMEOUT_MS"],
  "core/oidc/connections.ts": ["CLAIM_MAP_MAX_CLAIMS"],
  "core/ops/operations.ts": ["PROBE_TIMEOUT_MS"],
  "core/ops/platformOps.ts": [
    "ERROR_SUMMARY_MAX",
    "SUMMARY_NAMES_MAX",
    "D1_MAX_BOUND_PARAMS",
  ],
  "core/ops/settingsBackfill.ts": ["EVIDENCE_PER_ITEM"],
  "core/outboundGuard.ts": [
    "OUTBOUND_MAX_REDIRECTS",
    "OUTBOUND_TIMEOUT_MS",
    "OUTBOUND_MAX_BYTES",
  ],
  "core/outletTokens.ts": ["MAX_GOOGLE_TOKEN_RESPONSE_BYTES"],
  "core/publisher.ts": [
    "OIDC_CLOCK_SKEW_SECONDS",
    "JWKS_CACHE_SECONDS",
    "JWKS_REFETCH_MIN_SECONDS",
    "JWKS_MAX_STALE_SECONDS",
  ],
  "core/qr.ts": ["QR_MAX_VERSION"],
  "core/registry/registryQueue.ts": ["SELF_CHECK_BUDGET"],
  "core/registry/registryVocabulary.ts": [
    "REGISTRY_PUBLISH_TOKEN_DEFAULT_DAYS",
    "REGISTRY_TOKEN_MIN_DAYS",
    "REGISTRY_TOKEN_DEFAULT_DAYS",
    "REGISTRY_URL_TOKEN_DEFAULT_DAYS",
    "REGISTRY_TOKEN_LABEL_MAX",
    "REGISTRY_TOKEN_TTL_SECONDS",
    "REGISTRY_PULL_TOKEN_TTL_SECONDS",
  ],
  "core/rowSettings.ts": ["MAX_SETTING_REASON"],
  "core/safeFetch.ts": [
    "SAFE_FETCH_MAX_REDIRECTS",
    "SAFE_FETCH_TIMEOUT_MS",
    "SAFE_FETCH_FILE_TIMEOUT_MS",
    "SAFE_FETCH_MAX_URL",
  ],
  "core/settings/authority.ts": ["BREAK_GLASS_REASON_MAX"],
  "core/settings/platform.ts": [
    "LAZY_DELTA_MAX_BYTES_FLOOR",
    "ASSET_MEDIA_QUOTA_MAX",
    "ASSET_RELEASE_QUOTA_MAX",
  ],
  "core/settings/setupShape.ts": ["SETUP_LIST_MAX"],
  "core/settings/write.ts": ["MAX_SETTING_REASON"],
  "core/storefront/budget.ts": ["RATE_WINDOW"],
  "core/storefront/listingModel.ts": ["MAX_STORE_SCREENSHOTS"],
  "core/storefront/polarisKeyListing.ts": [
    "GROUP_LABEL_MAX",
    "GROUP_NAME_MAX",
    "GROUP_LABELS_MAX",
  ],
  "core/storefront/rules/appStore.ts": [
    "ASC_SCREENSHOTS_PER_SET",
    "ASC_SCREENSHOT_MAX_BYTES",
  ],
  "core/storefront/rules/googlePlay.ts": ["PLAY_IMAGE_MAX_BYTES"],
  "core/stores/apple/client.ts": ["MAX_RESPONSE_BYTES"],
  "core/stores/events.ts": ["MAX_STORED_PAYLOAD"],
  "core/stores/http.ts": ["MAX_STORE_RESPONSE_BYTES"],
  "core/stores/microsoftStore/client.ts": [
    "MAX_RESPONSE_BYTES",
    "MAX_FLIGHT_PAGES",
  ],
  "core/stores/microsoftStore/credentials.ts": ["MAX_TOKEN_RESPONSE_BYTES"],
  "core/stores/platformApps.ts": ["PLATFORM_APPS_TTL_SECONDS"],
  "core/stores/play/client.ts": ["MAX_RESPONSE_BYTES"],
  "core/stores/steam/client.ts": ["MAX_STEAM_RESPONSE_BYTES"],
  "core/stores/steam/publisher.ts": ["MAX_STEAM_APPS"],
  "core/trust/attestation.ts": ["ATTEST_CHALLENGE_TTL"],
  "core/trust/deviceTrust.ts": ["TRUST_AUDIT_WINDOW"],
  "core/trust/playIntegrity.ts": ["MAX_VERDICT_AGE", "MAX_CLOCK_SKEW"],
  "core/updateHealth.ts": ["MAX_UPDATE_EVENTS", "MAX_REPORT_GROUPS"],
  "core/updateHealthDo.ts": [
    "RETENTION_SECONDS",
    "MAX_DEVICE_EVENTS",
    "MAX_DEVICE_PAIRS",
    "MAX_READ_KEYS",
    "SWEEP_RESUME_MS",
    "SWEEP_BUDGET_MS",
  ],
  "platform/kv.ts": ["TOKEN_RECORD_TTL_SECONDS"],
  "scheduled.ts": ["PRUNE_MAX_BATCHES", "SWEEP_MAX_PRODUCTS"],
  "singleUseDo.ts": ["MAX_TTL_SECONDS"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.ts$/.test(n) && !/generated/.test(n) ? [p] : [];
  });
}

/** Every `file#NAME` of a limit-shaped numeric export outside the services. */
function limitShaped(): string[] {
  const out: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    if (rel.startsWith("services/")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(
      /^export const ([A-Z][A-Z0-9_]*)(?: *: *[A-Za-z<>[\]| ]+)? *= *[0-9(][^;]*;/gm,
    ))
      if (NAME.test(m[1]!)) out.push(`${rel}#${m[1]}`);
  }
  return out;
}

describe("the limits inventory", () => {
  const listed = new Set(LIMITS.map((l) => `${l.source}#${l.name}`));
  const internal = new Set(
    Object.entries(INTERNAL).flatMap(([f, ns]) => ns.map((n) => `${f}#${n}`)),
  );

  it("has a row for every limit-shaped constant, or says it is internal", () => {
    const missing = limitShaped().filter(
      (k) => !listed.has(k) && !internal.has(k),
    );
    expect(
      missing,
      "add a row to src/limits.ts (or name it in INTERNAL if no operator is asked about it)",
    ).toEqual([]);
  });

  it("names no constant twice, in the inventory and as internal", () => {
    expect([...listed].filter((k) => internal.has(k))).toEqual([]);
  });

  it("lists only constants that exist", () => {
    const shaped = new Set(limitShaped());
    const stale = [...internal].filter((k) => !shaped.has(k));
    expect(stale, "remove from INTERNAL").toEqual([]);
    for (const l of LIMITS) {
      const text = readFileSync(join(SRC, l.source), "utf8");
      expect(text, `${l.source} exports ${l.name}`).toMatch(
        new RegExp(`^export const ${l.name}\\b`, "m"),
      );
    }
  });

  it("holds numbers, one row each, worded for the page", () => {
    const keys = LIMITS.map((l) => `${l.source}#${l.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(LIMITS.map((l) => l.name)).size).toBe(LIMITS.length);
    for (const l of LIMITS) {
      expect(Number.isFinite(l.value) && l.value > 0, l.name).toBe(true);
      expect(l.label.length, l.name).toBeGreaterThan(0);
      expect(l.help.endsWith("."), l.name).toBe(true);
    }
    expect(LIMITS.length).toBeGreaterThanOrEqual(40);
  });
});
