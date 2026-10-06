/**
 * The settings registry (ST-03, notes/S-18 §4.2): the rules hold over the real composition root,
 * each rule refuses what it should, service slices arrive only through descriptors (rule 6), and
 * A-13's four keys resolve through their aliases.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICES, SETTINGS } from "../src/mount.js";
import { SERVICE_SLUGS } from "../src/core/services.js";
import {
  buildSettingsRegistry,
  type SettingsContributor,
} from "../src/core/settings/registry.js";
import { setting } from "../src/core/settings/define.js";
import {
  checkRegistry,
  deniedCategories,
  DENIED_PLATFORM_NAMES,
  SYSTEM_LOCKED_KEYS,
} from "../src/core/settings/rules.js";
import { CORE_SLICE } from "../src/core/settings/core.js";
import {
  KEY_ENTRY_LIMIT_DEFAULT,
  KEY_ENTRY_LIMIT_MAX,
  KEY_ENTRY_LIMIT_MIN,
  OFFLINE_DAYS_MAX,
  PLATFORM_SLICE,
} from "../src/core/settings/platform.js";
import type { SettingDef } from "../src/core/settings/types.js";
import { LICENSING_SETTINGS } from "../src/services/license/licensingSettings.js";
import {
  PLATFORM_SETTINGS,
  platformSettingDef,
} from "../src/core/platformSettings.js";
import { MAX_OFFLINE_DAYS } from "../src/admin/lib/writeChecks.js";
import { DEPRECATED_SPELLINGS, spellingPath } from "@polaris-key/manifest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");
const REPO = join(HERE, "..", "..", "..");
const DOCS = join(REPO, "packages", "docs", "src", "content", "docs");
const SCHEMAS = join(REPO, "packages", "shared-manifest", "schemas", "v1");

/** A minimal valid product entry in `ns`, owned by `service`. */
function product(
  key: string,
  service: SettingDef["service"],
  over: Partial<SettingDef> = {},
): SettingDef {
  return setting({
    key,
    scope: "product",
    service,
    area: "test",
    label: key,
    description: key,
    docs: "/docs/admin/products/",
    value: { kind: "integer", unit: "count", min: 0, max: 10 },
    defaultValue: 1,
    merge: "cascade",
    ownership: "operator",
    confirm: { up: "L0", down: "L0" },
    readers: ["core/products.ts"],
    storage: { kind: "scalar" },
    ...over,
  });
}

/** A minimal valid platform entry. */
function platform(key: string, over: Partial<SettingDef> = {}): SettingDef {
  return setting({
    key,
    scope: "platform",
    service: "platform",
    area: "test",
    label: key,
    description: key,
    docs: "/docs/admin/platform-settings/",
    value: { kind: "integer", unit: "count", min: 0, max: 10 },
    defaultValue: 1,
    merge: "cascade",
    ownership: "operator",
    confirm: { up: "L0", down: "L0" },
    readers: ["core/blobGc.ts"],
    storage: { kind: "scalar" },
    ...over,
  });
}

/** The issues of a registry made of the real slices plus `extra` for `slug`. */
function issuesWith(
  slug: SettingsContributor["slug"],
  extra: SettingDef[],
  opts: { namespaces?: string[]; platform?: SettingDef[] } = {},
): string[] {
  const contributors: SettingsContributor[] = [...SERVICES.values()].map((d) =>
    d.slug === slug
      ? {
          slug,
          settings: {
            namespaces: opts.namespaces ?? d.settings?.namespaces ?? [slug],
            entries: [...(d.settings?.entries ?? []), ...extra],
          },
        }
      : d,
  );
  return checkRegistry(
    buildSettingsRegistry(contributors, {
      platform: opts.platform
        ? [...PLATFORM_SLICE, ...opts.platform]
        : undefined,
    }),
  );
}

/**
 * Follow a manifest path (`product:web.origins`) through a JSON Schema's properties and refs.
 * `"deprecated"` when a step of it is a property the schema marks deprecated (ST-19).
 */
function schemaHasPath(path: string): boolean | "deprecated" {
  const [doc, dotted] = path.split(":") as [string, string];
  const root = JSON.parse(
    readFileSync(join(SCHEMAS, `${doc}.schema.json`), "utf8"),
  ) as Record<string, unknown>;
  const deref = (node: unknown): Record<string, unknown>[] => {
    if (!node || typeof node !== "object") return [];
    const n = node as Record<string, unknown>;
    const out: Record<string, unknown>[] = [n];
    if (typeof n.$ref === "string" && n.$ref.startsWith("#/")) {
      let t: unknown = root;
      for (const seg of n.$ref.slice(2).split("/"))
        t = (t as Record<string, unknown>)[seg];
      out.push(...deref(t));
    }
    for (const k of ["allOf", "anyOf", "oneOf"])
      if (Array.isArray(n[k]))
        for (const s of n[k] as unknown[]) out.push(...deref(s));
    return out;
  };
  let nodes = deref(root);
  let deprecated = false;
  for (const seg of dotted.split(".")) {
    const next: Record<string, unknown>[] = [];
    for (const n of nodes) {
      const props = n.properties as Record<string, unknown> | undefined;
      if (props && seg in props) next.push(...deref(props[seg]));
    }
    if (next.length === 0) return false;
    if (next.some((n) => n.deprecated === true)) deprecated = true;
    nodes = next;
  }
  return deprecated ? "deprecated" : true;
}

/** Every manifest field an entry names: `manifest.path`, then `manifest.alsoPaths` (ST-19b). */
function manifestPaths(e: SettingDef): string[] {
  return e.manifest ? [e.manifest.path, ...(e.manifest.alsoPaths ?? [])] : [];
}

function docsPageExists(link: string): boolean {
  const m = /^\/docs\/(.+?)\/?(#.*)?$/.exec(link);
  if (!m) return false;
  const base = join(DOCS, m[1]!);
  return [".md", ".mdx", "/index.md", "/index.mdx"].some((ext) =>
    existsSync(base + ext),
  );
}

describe("the settings registry (ST-03)", () => {
  it("breaks no rule over the real composition root", () => {
    expect(checkRegistry(SETTINGS)).toEqual([]);
    expect(SETTINGS.entries.length).toBeGreaterThan(30);
  });

  it("takes every service slice from its descriptor (rule 6)", () => {
    const owners = SETTINGS.slices.map((s) => s.owner);
    expect(owners.slice(0, 2)).toEqual(["platform", "core"]);
    for (const slug of SERVICE_SLUGS) {
      const d = SERVICES.get(slug)!;
      expect(d.settings, `${slug} contributes a slice`).toBeDefined();
      const slice = SETTINGS.slices.find((s) => s.owner === slug)!;
      expect(slice.entries).toBe(d.settings!.entries);
    }
    // Core assembles the registry without naming a service: nothing under core/settings imports
    // one, so the only way a service's settings arrive is its descriptor.
    const dir = join(SRC, "core", "settings");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/from\s+["'][^"']*services\//);
    }
  });

  it("resolves A-13's four keys (and LX-05's reserved-names mode) through their aliases", () => {
    const pairs: Array<[string, string]> = [
      ["LAZY_DELTAS", "deltas.lazy.mode"],
      ["LAZY_DELTA_MAX_BYTES", "deltas.lazy.maxBytes"],
      ["BLOB_GC_MODE", "blobs.gc.mode"],
      ["BLOB_GC_GRACE_DAYS", "blobs.gc.graceDays"],
      ["LICENSING_RESERVED_NAMES", "licensing.reservedNames"],
      // PX-W13: the reserved display-name severity, an ordered enum like LX-05's.
      ["IDENTITY_RESERVED_DISPLAY_NAMES", "identity.reservedDisplayNames"],
      // PX-W9: the key-entry refusal switch (WIRE-CONTRACT-V4 §12.2 step 4).
      ["KEYENTRY_REFUSALS", "identity.keyEntryRefusals"],
    ];
    for (const [alias, key] of pairs) {
      expect(SETTINGS.canonicalKey(alias)).toBe(key);
      expect(SETTINGS.get(alias)?.key).toBe(key);
      expect(SETTINGS.get(alias, "platform")?.key).toBe(key);
      expect(SETTINGS.get(alias, "product")).toBeUndefined();
      // The A-13 store is derived from the registry: same entry, row key = the alias.
      const a13 = platformSettingDef(alias)!;
      expect(a13.registryKey).toBe(key);
      const reg = SETTINGS.get(key, "platform")!;
      expect(reg.storage).toEqual({ kind: "scalar", storedAs: alias });
      expect(a13.label).toBe(reg.label);
      expect(a13.precedence).toBe(reg.precedence);
      expect(a13.defaultValue).toBe(reg.defaultValue);
    }
    expect(PLATFORM_SETTINGS.map((d) => d.key)).toEqual(pairs.map(([a]) => a));
    expect(SETTINGS.canonicalKey("NOT_A_SETTING")).toBeUndefined();
    // LX-05's ordered enum becomes the A-13 store's choice kind: up (toward error) is L1.
    const reserved = platformSettingDef("LICENSING_RESERVED_NAMES")!;
    expect(reserved.kind).toBe("choice");
    if (reserved.kind === "choice") {
      expect(reserved.options.map((o) => o.value)).toEqual(["warn", "error"]);
      expect(reserved.confirm).toEqual({ warn: "L0", error: "L1" });
    }
  });

  it("registers the key-entry settings for I-09 and I-10a", () => {
    const refusals = SETTINGS.get("identity.keyEntryRefusals", "platform")!;
    expect(refusals.value).toEqual({ kind: "switch" });
    expect(refusals.defaultValue).toBe("off");
    expect(refusals.productLink).toBeUndefined(); // platform-only
    const cap = SETTINGS.get("identity.keyEntry.limit", "platform")!;
    const limit = SETTINGS.get("identity.keyEntry.limit", "product")!;
    for (const d of [cap, limit]) {
      expect(d.allowUnset).toBe(false);
      expect(d.policyBound).toBe("max");
      expect(d.widensWhen).toBe("higher");
      expect(d.value).toMatchObject({
        min: KEY_ENTRY_LIMIT_MIN,
        max: KEY_ENTRY_LIMIT_MAX,
      });
    }
    expect([KEY_ENTRY_LIMIT_MIN, KEY_ENTRY_LIMIT_MAX]).toEqual([1, 100]);
    expect(limit.defaultValue).toBe(KEY_ENTRY_LIMIT_DEFAULT);
    expect(KEY_ENTRY_LIMIT_DEFAULT).toBe(10);
    expect(limit.ownership).toBe("claimable");
    expect(limit.wire).toEqual(["discovery", "refusal"]);
    expect(cap.productLink).toEqual({ default: false, bound: true });
  });

  it("seeds S-19's licensing settings as claimable, from one module", () => {
    // The product-scope ones: LX-05's `licensing.reservedNames` is a platform entry (above).
    const licensing = SETTINGS.entries.filter(
      (e) => e.key.startsWith("licensing.") && e.scope === "product",
    );
    expect(
      SETTINGS.entries
        .filter((e) => e.key.startsWith("licensing.") && e.scope !== "product")
        .map((e) => e.key),
    ).toEqual(["licensing.reservedNames"]);
    expect(licensing.map((e) => e.key).sort()).toEqual(
      LICENSING_SETTINGS.map((e) => e.key).sort(),
    );
    expect(licensing.map((e) => e.key.split(".")[1]).sort()).toEqual([
      "anchorPolicy",
      "clampGraceToExpiry",
      "dunningGraceDays",
      "entitlementHolder",
      "entitlementModel",
      "reanchor",
      "refundGraceHours",
    ]);
    // LX-06 made them live, row-backed (`core/rowSettings.ts`); only the billing-retry grace
    // stays hidden until LX-23 builds it.
    for (const e of licensing) {
      expect(e.ownership).toBe("claimable");
      expect(e.service).toBe("license");
      expect(e.storage).toEqual({ kind: "scalar" });
      expect(e.manifest?.path).toBe(`product:${e.key}`);
      if (e.key === "licensing.dunningGraceDays")
        expect(e.pending).toEqual({ wp: "LX-23" });
      else {
        expect(e.pending).toBeUndefined();
        expect(e.readers.length).toBeGreaterThan(0);
      }
    }
    // plans/LX-01.md §8 Q2: the derived default for the entitlement model.
    expect(
      licensing.find((e) => e.key === "licensing.entitlementModel"),
    ).toMatchObject({
      defaultValue: "combined",
      legacyDefault: { value: "legacy" },
    });
    // S-18 D20 / S-19 model OC: the account is not a settings scope.
    for (const e of SETTINGS.entries) expect("accountMerge" in e).toBe(false);
  });

  it("registers the Polaris Key storefront's listing settings (PS-02, S-21 §6.2)", () => {
    const keys = SETTINGS.entries
      .filter((e) => e.key.startsWith("storefront."))
      .map((e) => `${e.scope} ${e.key}`);
    expect(keys).toEqual([
      "platform storefront.polarisKey.enabled",
      "product storefront.polarisKey.listed",
      "product storefront.polarisKey.audience",
      "product storefront.polarisKey.offerPaths",
      "product storefront.polarisKey.groupLabels",
    ]);
    // Core's slice owns the namespace: every product can list, Distribution on or off.
    const core = SETTINGS.slices.find((s) => s.owner === "core")!;
    expect(core.namespaces).toContain("storefront");

    const enabled = SETTINGS.get("storefront.polarisKey.enabled", "platform")!;
    expect(enabled).toMatchObject({
      value: { kind: "switch" },
      defaultValue: "on",
      ownership: "operator",
      confirm: { on: "L2", off: "L2" },
    });
    // PS-03 wired it: the storefront engine's candidate set reads it (no longer pending).
    expect(enabled.pending).toBeUndefined();
    expect(enabled.readers).toEqual([
      "core/storefrontSwitch.ts",
      "services/identity/portal/store/obtain.ts",
    ]);
    expect(enabled.productLink).toBeUndefined(); // platform-only
    // Not an A-13 store key: it has no row alias, so the A-13 route cannot write it.
    expect(platformSettingDef("storefront.polarisKey.enabled")).toBeUndefined();

    const listed = SETTINGS.get("storefront.polarisKey.listed", "product")!;
    expect(listed).toMatchObject({
      service: "core",
      value: { kind: "enum", values: ["auto", "listed", "unlisted"] },
      defaultValue: "auto",
      ownership: "operator",
      confirm: { change: "L1" },
      storage: {
        kind: "column",
        table: "portal_product_settings",
        column: "store_listed",
      },
    });
    expect(listed.manifest).toBeUndefined();

    const audience = SETTINGS.get("storefront.polarisKey.audience", "product")!;
    expect(audience).toMatchObject({
      value: { kind: "enum", values: ["eligible", "everyone"] },
      defaultValue: "eligible",
      ownership: "operator",
      widensWhen: "higher",
      critical: true,
      confirm: { up: "L2", down: "L0" },
      storage: { column: "store_audience" },
    });

    const paths = SETTINGS.get("storefront.polarisKey.offerPaths", "product")!;
    expect(paths).toMatchObject({
      defaultValue: null,
      allowUnset: true,
      ownership: "operator",
      confirm: { change: "L1" },
      storage: { column: "store_offer_paths_json" },
    });
    expect(paths.value).toEqual({
      kind: "list",
      of: {
        kind: "enum",
        values: [
          "group",
          "auto_issue",
          "open",
          "store_owned",
          "product_idp",
          "email_domain",
        ],
      },
      max: 6,
    });

    const labels = SETTINGS.get(
      "storefront.polarisKey.groupLabels",
      "product",
    )!;
    expect(labels).toMatchObject({
      value: { kind: "json" },
      defaultValue: {},
      confirm: { change: "L0" },
      storage: { column: "store_group_labels_json" },
    });
    // Operator-owned until `.pkey/product` carries `storefront.groupLabels` (S-21 §6.2).
    expect(labels.ownership).toBe("operator");

    for (const e of [listed, audience, paths, labels]) {
      expect(e.since).toBe("PS-02");
      expect(e.pending).toBeUndefined();
      expect(e.readers).toContain(
        "services/identity/portal/storefrontListing.ts",
      );
    }
    // S-18 D22's `identity.discover.listed` is superseded and never registered.
    expect(SETTINGS.canonicalKey("identity.discover.listed")).toBeUndefined();
  });

  it("names only canonical manifest spellings (ST-19 registry ↔ manifest parity)", () => {
    const deprecated = new Set(DEPRECATED_SPELLINGS.map(spellingPath));
    for (const e of SETTINGS.entries) {
      for (const path of manifestPaths(e)) {
        expect(deprecated.has(path), `${e.key} ${path}`).toBe(false);
        // No step of the path is an old spelling either (a pending entry's path may not exist in
        // the schema yet, but it must not run through a deprecated property).
        expect(schemaHasPath(path), `${e.key} ${path}`).not.toBe("deprecated");
      }
    }
    // The check has teeth: an old spelling is caught.
    expect(schemaHasPath("product:tiers")).toBe("deprecated");
    expect(schemaHasPath("release:release.ghOwner")).toBe("deprecated");
    expect(deprecated.has("product:tiers")).toBe(true);
  });

  it("names readers that exist, docs pages that exist and manifest paths the schema has", () => {
    for (const e of SETTINGS.entries) {
      for (const r of e.readers)
        expect(existsSync(join(SRC, r)), `${e.key} reader ${r}`).toBe(true);
      expect(docsPageExists(e.docs), `${e.key} docs ${e.docs}`).toBe(true);
      if (!e.pending)
        for (const path of manifestPaths(e))
          expect(
            schemaHasPath(path),
            `${e.key} ${path} (a canonical spelling, ST-19)`,
          ).toBe(true);
    }
    expect(OFFLINE_DAYS_MAX).toBe(MAX_OFFLINE_DAYS);
  });
});

describe("the registry rules refuse", () => {
  it("a product-scope entry on a platform-only key (rule 5)", () => {
    const issues = issuesWith("identity", [
      product("identity.keyEntryRefusals", "identity", {
        value: { kind: "switch" },
        defaultValue: "off",
        confirm: { on: "L1", off: "L1" },
      }),
    ]);
    expect(issues).toEqual([
      expect.stringMatching(
        /product identity\.keyEntryRefusals: .*platform-only key/,
      ),
    ]);
  });

  it("a product entry that disagrees with the platform bound or default it shares a key with", () => {
    expect(
      issuesWith("license", [], {
        platform: [
          platform("license.test.cap", {
            merge: "policy",
            policyBound: "max",
            widensWhen: "higher",
            productLink: { default: false, bound: true },
          }),
        ],
      }),
    ).toEqual([expect.stringMatching(/productLink names no product entry/)]);
    expect(
      issuesWith("license", [product("license.test.cap", "license")], {
        platform: [
          platform("license.test.cap", {
            merge: "policy",
            policyBound: "max",
            widensWhen: "higher",
            productLink: { default: false, bound: true },
          }),
        ],
      }),
    ).toEqual([expect.stringMatching(/same policyBound and widensWhen/)]);
    expect(
      issuesWith("license", [
        product("license.test.orphan", "license", { inherits: "platform" }),
      ]),
    ).toEqual([expect.stringMatching(/does not exist/)]);
  });

  it("every AT-2 deny-listed name and category at platform scope (rule 1)", () => {
    for (const name of DENIED_PLATFORM_NAMES)
      expect(
        issuesWith("license", [], {
          platform: [platform("email.sender", { aliases: [name] })],
        }).length,
        name,
      ).toBeGreaterThan(0);
    for (const key of [
      "console.origin",
      "access.adminGroup",
      "access.oidcIssuer",
      "access.issuerAllowlist",
      "keys.kekActive",
      "auth.key",
      "admin.sessionDays",
      "portal.sessionTtl",
      "api.rateLimit",
      "audit.retentionDays",
      "blobs.bucketName",
    ])
      expect(deniedCategories(key), key).not.toEqual([]);
    // Short words stay exact: these are not key material or sessions.
    for (const key of [
      "identity.keyEntry.limit",
      "identity.keyEntryRefusals",
      "deltas.lazy.mode",
      "blobs.gc.graceDays",
      "LAZY_DELTA_MAX_BYTES",
    ])
      expect(deniedCategories(key), key).toEqual([]);
  });

  it("a security-widening product setting that is not critical, inherits, or confirms below L1 (rule 2)", () => {
    const base = {
      ownership: "operator" as const,
      value: {
        kind: "list" as const,
        of: { kind: "string" as const, maxLength: 9 },
        max: 3,
      },
      defaultValue: [],
      confirm: { change: "L1" as const },
      securityWidening: true,
      widensWhen: "any" as const,
      critical: true,
    };
    expect(
      issuesWith("identity", [
        product("identity.redirectPaths", "identity", base),
      ]),
    ).toEqual([]);
    expect(
      issuesWith("identity", [
        product("identity.redirectPaths", "identity", {
          ...base,
          critical: false,
        }),
      ]),
    ).toEqual([expect.stringMatching(/is critical \(rule 2\)/)]);
    expect(
      issuesWith("identity", [
        product("identity.redirectPaths", "identity", {
          ...base,
          confirm: { change: "L0" },
        }),
      ]),
    ).toEqual([expect.stringMatching(/at least L1/)]);
    expect(
      issuesWith("identity", [
        product("identity.redirectPaths", "identity", {
          ...base,
          securityWidening: false,
        }),
      ]),
    ).toEqual([expect.stringMatching(/must be securityWidening/)]);
  });

  it("a session length a product could lengthen (rule 3)", () => {
    const issues = issuesWith("identity", [
      product("identity.portalSessionDays", "identity", {
        value: { kind: "integer", unit: "days", min: 1, max: 60 },
        defaultValue: 30,
        merge: "policy",
        policyBound: "max",
        widensWhen: "higher",
      }),
    ]);
    expect(issues).toEqual([expect.stringMatching(/shorten-only/)]);
  });

  it("a policy bound on the restrictive side, or none (rule 4)", () => {
    expect(
      issuesWith("license", [
        product("license.test.limit", "license", {
          merge: "policy",
          policyBound: "min",
          widensWhen: "higher",
        }),
      ]),
    ).toEqual([expect.stringMatching(/not on the permissive side/)]);
    expect(
      issuesWith("license", [
        product("license.test.limit", "license", { merge: "policy" }),
      ]),
    ).toEqual([expect.stringMatching(/declares policyBound and widensWhen/)]);
  });

  it("structural breakage: namespaces, owners, aliases, defaults, ownership, readers, accountMerge", () => {
    const cases: Array<
      [string, SettingsContributor["slug"], SettingDef, RegExp]
    > = [
      [
        "foreign namespace",
        "config",
        product("license.x.y", "config"),
        /does not own namespace "license"/,
      ],
      [
        "wrong service",
        "config",
        product("config.x.y", "license"),
        /declares service license/,
      ],
      [
        "duplicate key",
        "config",
        product("config.catalog", "config"),
        /registered twice/,
      ],
      [
        "alias taken",
        "config",
        product("config.x.y", "config", { aliases: ["LAZY_DELTAS"] }),
        /already names deltas\.lazy\.mode/,
      ],
      [
        "null default",
        "config",
        product("config.x.y", "config", { defaultValue: null }),
        /needs allowUnset/,
      ],
      [
        "default out of range",
        "config",
        product("config.x.y", "config", { defaultValue: 11 }),
        /does not fit/,
      ],
      [
        "claimable without manifest",
        "config",
        product("config.x.y", "config", { ownership: "claimable" }),
        /needs manifest\.path/,
      ],
      [
        "malformed second manifest field (ST-19b)",
        "config",
        product("config.x.y", "config", {
          ownership: "manifest",
          manifest: { path: "product:web.origins", alsoPaths: ["web origins"] },
        }),
        /manifest\.alsoPaths must be/,
      ],
      [
        "repeated manifest field (ST-19b)",
        "config",
        product("config.x.y", "config", {
          ownership: "manifest",
          manifest: {
            path: "product:web.origins",
            alsoPaths: ["product:web.origins"],
          },
        }),
        /manifest\.alsoPaths repeats a path/,
      ],
      [
        "no readers",
        "config",
        product("config.x.y", "config", { readers: [] }),
        /names at least one reader/,
      ],
      [
        "accountMerge",
        "config",
        {
          ...product("config.x.y", "config"),
          accountMerge: "sum",
        } as unknown as SettingDef,
        /accountMerge is reserved/,
      ],
      [
        "platform entry from a service",
        "config",
        platform("config.x.y", { service: "platform" }),
        /may not contribute a platform-scope entry/,
      ],
    ];
    for (const [name, slug, def, re] of cases)
      expect(issuesWith(slug, [def]), name).toContainEqual(
        expect.stringMatching(re),
      );
    expect(
      issuesWith("config", [], { namespaces: ["config", "license"] }),
    ).toContainEqual(
      expect.stringMatching(/claimed by both license and config/),
    );
    expect(
      issuesWith("config", [], { namespaces: ["config", "core"] }),
    ).toContainEqual(expect.stringMatching(/"core" is reserved/));
  });
});

describe("the system-lock rule (ST-20, S-18 §4.5 item 8)", () => {
  const KEY = "core.manifest.authoritative";
  const withCore = (core: readonly SettingDef[]) =>
    checkRegistry(buildSettingsRegistry(SERVICES.values(), { core }));

  it("locks manifest-authoritative mode on for the system product, in the registry", () => {
    expect(SYSTEM_LOCKED_KEYS).toEqual({ [KEY]: true });
    expect(SETTINGS.get(KEY, "product")).toMatchObject({
      ownership: "operator",
      defaultValue: false,
      systemLock: { value: true },
    });
  });

  it("refuses a registry whose locked entry lost its lock, changed it, or is gone", () => {
    const edit = (over: Partial<SettingDef>) =>
      CORE_SLICE.map((e) => (e.key === KEY ? { ...e, ...over } : e));
    const locked = `product ${KEY}: the system product's value is locked to true (systemLock)`;
    expect(withCore(edit({ systemLock: undefined }))).toContain(locked);
    expect(withCore(edit({ systemLock: { value: false } }))).toContain(locked);
    expect(withCore(CORE_SLICE.filter((e) => e.key !== KEY))).toContain(
      `product ${KEY}: locked for the system product, so it must be registered`,
    );
  });

  it("refuses a lock on a platform entry, and a lock that does not fit the value", () => {
    expect(
      issuesWith("license", [
        product("license.test.locked", "license", {
          value: { kind: "boolean" },
          defaultValue: false,
          confirm: { on: "L0", off: "L0" },
          systemLock: { value: "on" },
        }),
      ]),
    ).toContain(
      "product license.test.locked: systemLock.value does not fit its value spec",
    );
    expect(
      issuesWith("license", [], {
        platform: [platform("blobs.test.locked", { systemLock: { value: 2 } })],
      }),
    ).toContain(
      "platform blobs.test.locked: systemLock is declared on product entries only",
    );
  });
});
