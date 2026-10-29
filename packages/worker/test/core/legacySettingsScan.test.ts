/**
 * The legacy-settings scan (ST-25.1, plans/P0-25b-ST-25-slices.md §3). The legacy stores and
 * names ST-25 retires (`admin_group`, `release_config.artifacts_access`, `products.branding_json`,
 * the dead portal switch columns, `legacyDefault`, ...) may only shrink. A token in a file that
 * `KNOWN` does not list fails; a `KNOWN` file that no longer names its token fails too (stale),
 * so the slice that removes a reference deletes its row in the same change.
 *
 * Value = the slice that removes the reference: ST-25.2 ... ST-25.7, `ST-25b` (the release-N+1
 * drops), or `PERMANENT: <reason>`. Migrations and `scripts/rollback/` are not scanned: history
 * names every column it ever created.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT } from "../paths.js";

const REPO = join(TEST_ROOT, "..", "..", "..");
const ROOTS = [
  "packages/worker/src",
  "packages/worker/scripts",
  "packages/admin/src",
  "packages/cli/src",
  "packages/shared-manifest/src",
];
const SKIP_DIRS = new Set(["node_modules", "migrations", "rollback"]);
const SOURCE = /\.(ts|tsx|mjs|js)$/;
const SLICE = /^(ST-25\.[2-7]|ST-25b|PERMANENT: .+)$/;

export const TOKENS = [
  "admin_group",
  "adminGroup",
  "artifacts_access",
  "branding_json",
  "lazy_delta_settings",
  "email_product_caps",
  "portal_enabled",
  "key_reissue_enabled",
  "claim_by_key",
  "oidc_enabled",
  "magic_enabled",
  "license_key_claim_enabled",
  "releases_enabled",
  "auto_link_enabled",
  "legacyDefault",
] as const;

export const KNOWN: Record<string, Record<string, string>> = {
  admin_group: {
    "packages/worker/src/console/lib/shape.ts": "ST-25.6",
    "packages/worker/src/console/systemProduct.ts": "ST-25.6",
    "packages/worker/src/core/ingest/core.ts": "ST-25.6",
    "packages/worker/src/core/ops/settingsBackfill.ts": "ST-25.6",
    "packages/worker/src/core/products.ts": "ST-25.6",
    "packages/worker/src/core/products/store.ts": "ST-25.6",
    "packages/worker/src/core/repo.ts": "ST-25.6",
    "packages/worker/src/core/settings/columns.ts": "ST-25.6",
    "packages/worker/src/core/settings/core.ts": "ST-25.6",
    "packages/admin/src/console/settings.generated.ts": "ST-25.6",
    "packages/worker/scripts/registry-clients/seed.mjs": "ST-25b",
    "packages/shared-manifest/src/index.test.ts":
      "PERMANENT: the refusal's test names the retired field's code",
    "packages/worker/scripts/settings-coverage.ts":
      "PERMANENT: the NOT_A_SETTING row for the retired manifest field names its code",
    "packages/shared-manifest/src/index.ts":
      "PERMANENT: ST-32's refusal names the retired field and its replacement",
  },
  adminGroup: {
    "packages/worker/src/console/lib/shape.ts": "ST-25.6",
    "packages/worker/src/core/products.ts": "ST-25.6",
    "packages/worker/src/core/settings/columns.ts": "ST-25.6",
    "packages/worker/src/core/settings/core.ts": "ST-25.6",
    "packages/worker/src/core/settings/rules.ts": "ST-25.6",
    "packages/worker/src/core/settingsClaims.ts": "ST-25.6",
    "packages/admin/src/console/api/products.ts": "ST-25.6",
    "packages/admin/src/console/sections/core/model/settingHomes.ts": "ST-25.6",
    "packages/admin/src/console/sections/core/pages/Settings.tsx": "ST-25.6",
    "packages/admin/src/console/settings.generated.ts": "ST-25.6",
    "packages/admin/src/kit/stories/forms.tsx": "ST-25.6",
    "packages/shared-manifest/src/index.test.ts":
      "PERMANENT: ST-32's refusal names the retired field and its replacement",
    "packages/shared-manifest/src/index.ts":
      "PERMANENT: ST-32's refusal names the retired field and its replacement",
    "packages/worker/scripts/settings-coverage.ts":
      "PERMANENT: the NOT_A_SETTING row for the retired manifest field names it",
  },
  artifacts_access: {
    "packages/worker/src/services/release/descriptor.ts":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/src/services/release/packs/ingest.ts":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/src/services/release/packages/ingest.ts":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/src/services/release/store.ts":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/src/services/release/resolve.ts":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/scripts/registry-clients/clients/swift.seed.mjs":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/scripts/registry-clients/fixtures/maven.mjs":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
    "packages/worker/scripts/registry-clients/fixtures/npm.mjs":
      "PERMANENT: the truth-store column release_metadata.artifacts_access / release_artifacts.access (CHECK-bound, D6)",
  },
  branding_json: {
    "packages/worker/src/services/identity/admin.ts":
      "PERMANENT: the live portal_product_settings.branding_json (the portal's presentation row)",
    "packages/worker/src/services/identity/portal/api.ts":
      "PERMANENT: the live portal_product_settings.branding_json (the portal's presentation row)",
    "packages/worker/src/services/identity/portal/branding.ts":
      "PERMANENT: the live portal_product_settings.branding_json (the portal's presentation row)",
    "packages/worker/src/services/identity/portal/repo.ts":
      "PERMANENT: the live portal_product_settings.branding_json (the portal's presentation row)",
    "packages/worker/src/services/identity/signInSettings.ts":
      "PERMANENT: the live portal_product_settings.branding_json (the portal's presentation row)",
  },
  legacyDefault: {
    "packages/worker/src/core/rowSettings.ts": "ST-25.7",
    "packages/worker/src/core/settings/resolve.ts": "ST-25.7",
    "packages/worker/src/core/settings/rules.ts": "ST-25.7",
    "packages/worker/src/core/settings/types.ts": "ST-25.7",
    "packages/worker/src/services/identity/passthrough/anchor.ts": "ST-25.7",
    "packages/worker/src/services/license/licensingSettings.ts": "ST-25.7",
    "packages/worker/scripts/gen-settings.ts": "ST-25.7",
  },
  portal_enabled: {
    "packages/worker/src/services/identity/admin.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/licenseChoice.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/passthrough/choice.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/api.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/dataRoutes.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/downloads.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/freeDevice.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/library.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/media.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/selfService.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/store/panelStatus.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/supportCode.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/core/storefront/stores/polarisKeyReadiness.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/repo.ts": "ST-25.3",
  },
  key_reissue_enabled: {
    "packages/worker/src/services/identity/admin.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/api.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/selfService.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/repo.ts": "ST-25.3",
  },
  claim_by_key: {
    "packages/worker/src/services/identity/accounts/claim.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/admin.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/selfService.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/settings.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/signInSettings.ts":
      "PERMANENT: a field of the registry-backed getPortalProductSettings overlay, not the dropped column",
    "packages/worker/src/services/identity/portal/repo.ts": "ST-25.3",
    "packages/shared-manifest/src/index.test.ts":
      "PERMANENT: the manifest field name claimByKey in a test expectation",
    "packages/shared-manifest/src/index.ts":
      "PERMANENT: the manifest error code invalid_identity_claim_by_key",
  },
};

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

/** token -> the repo-relative files that name it. */
export function hitsOf(
  files: ReadonlyMap<string, string>,
  tokens: readonly string[] = TOKENS,
): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const [file, text] of files) {
    for (const token of tokens) {
      if (text.includes(token)) (hits[token] ??= []).push(file);
    }
  }
  return hits;
}

/** What differs between the scan and `known`: new hits and stale rows. */
export function diffKnown(
  hits: Record<string, string[]>,
  known: Record<string, Record<string, string>>,
): { fresh: string[]; stale: string[] } {
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const [token, files] of Object.entries(hits)) {
    for (const file of files) {
      if (!known[token]?.[file]) fresh.push(`${token} in ${file}`);
    }
  }
  for (const [token, files] of Object.entries(known)) {
    for (const file of Object.keys(files)) {
      if (!hits[token]?.includes(file)) stale.push(`${token} in ${file}`);
    }
  }
  return { fresh: fresh.sort(), stale: stale.sort() };
}

function scanRepo(): Record<string, string[]> {
  const files = new Map<string, string>();
  for (const root of ROOTS) {
    for (const path of walk(join(REPO, root), [])) {
      files.set(relative(REPO, path), readFileSync(path, "utf8"));
    }
  }
  return hitsOf(files);
}

describe("legacy settings scan (ST-25)", () => {
  it("every reference of a legacy token is listed in KNOWN", () => {
    const { fresh } = diffKnown(scanRepo(), KNOWN);
    expect(
      fresh,
      "a new reference to a retired store or name: use the registry, or name the removing slice in KNOWN",
    ).toEqual([]);
  });

  it("no KNOWN row is stale (the slice that removes a reference deletes its row)", () => {
    const { stale } = diffKnown(scanRepo(), KNOWN);
    expect(stale).toEqual([]);
  });

  it("every KNOWN value names a slice or a PERMANENT reason, for a scanned token", () => {
    for (const [token, files] of Object.entries(KNOWN)) {
      expect(TOKENS as readonly string[]).toContain(token);
      for (const [file, slice] of Object.entries(files)) {
        expect(slice, `${token} in ${file}`).toMatch(SLICE);
      }
    }
  });

  it("probe: a new reference and a stale row both fail", () => {
    const files = new Map([
      ["a.ts", "SELECT admin_group FROM products"],
      ["b.ts", "nothing here"],
    ]);
    const hits = hitsOf(files);
    expect(diffKnown(hits, {})).toEqual({
      fresh: ["admin_group in a.ts"],
      stale: [],
    });
    expect(
      diffKnown(hits, {
        admin_group: { "a.ts": "ST-25.6", "b.ts": "ST-25.6" },
      }),
    ).toEqual({ fresh: [], stale: ["admin_group in b.ts"] });
    expect(diffKnown(hits, { admin_group: { "a.ts": "ST-25.6" } })).toEqual({
      fresh: [],
      stale: [],
    });
  });
});
