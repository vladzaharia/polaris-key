/**
 * The settings registry's types (ST-03, notes/S-18 §4.2).
 *
 * One registry describes every platform, product and service setting. It is DATA: search, the
 * generated docs reference (ST-06), history, export and the coverage test all read it, and the
 * resolver (ST-04) and the generic admin API (ST-05) are built on it. Nothing in this file reads
 * or writes a value.
 *
 * Who contributes what:
 *
 *   - Core owns the types, the rules (`rules.ts`), the platform slice (`platform.ts`) and the
 *     Core product slice (`core.ts`);
 *   - each service contributes its own product-scope slice through its descriptor
 *     (`ServiceDescriptor.settings`, `core/registry.ts`), so Core never imports a service
 *     (AGENTS.md rule 6) and adding a service's settings is an edit in that service's directory;
 *   - the composition root (`mount.ts`) assembles the registry once (`buildSettingsRegistry`).
 *
 * Scopes (S-18 §4.1): `platform` (one deployment), `product` (one product; a "service setting" is
 * a product setting whose key starts with the service's namespace) and `entity` (a tier, licence,
 * channel, …). The account is NOT a settings scope: S-19's model OC was adopted (S-18 owner
 * decision 5), so `accountMerge` stays reserved and is not built.
 *
 * Adding an entry is a THREAT-MODEL §9 review trigger ("Platform settings and operations",
 * AT-2): see `rules.ts` for what the registry refuses by construction.
 */

import type { ServiceSlug } from "../services.js";

export type SettingScope = "platform" | "product" | "entity";

/** The entity an `entity`-scope setting belongs to (S-18 §4.1). */
export type SettingEntity =
  | "tier"
  | "license"
  | "channel"
  | "feed"
  | "outlet"
  | "pack";

/** `cascade`: the nearest scope wins. `policy`: the strictest bound wins (or a locked value). */
export type SettingMerge = "cascade" | "policy";

/** Who may write a product setting (S-18 §4.2, model C: owner decision 1). */
export type SettingOwnership =
  /** Console or API only; no manifest path. */
  | "operator"
  /** Manifest only; the console shows a read-out ("edit in .pkey/…"). */
  | "manifest"
  /** The manifest seeds it; a console write claims it; Revert returns it to the manifest. */
  | "claimable"
  /**
   * The manifest sets it; the console may only narrow it. (Outlet capabilities, which S-18 A.2
   * cites as the example, are operator-owned instead: the manifest may not name them.)
   */
  | "narrow-only"
  /** Neither: a code constant, a deploy value or a value derived from other settings. */
  | "read-only";

/** Where an effective value came from (the resolver's source chain, ST-04). */
export type SettingSource =
  | "default"
  | "deploy"
  | "platform"
  | "manifest"
  | "console"
  | "derived";

/** ADMIN.md §5.2 destructive levels. L2 and above require a typed confirmation. */
export type ConfirmLevel = "L0" | "L1" | "L2" | "L3";

/** Units an integer setting is measured in (display and docs only). */
export type SettingUnit =
  | "bytes"
  | "days"
  | "hours"
  | "months"
  | "count"
  | "perDay"
  | "perHour";

/** The shape of a setting's value. `null` is never a value of a spec: see `allowUnset`. */
export type ValueSpec =
  /** `"on"` | `"off"`. */
  | { kind: "switch" }
  | { kind: "boolean" }
  /** An integer within inclusive bounds. */
  | { kind: "integer"; unit: SettingUnit; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string"; pattern?: string; maxLength: number }
  | { kind: "list"; of: ValueSpec; max: number }
  /** A structured value validated elsewhere; `schema` names the validator or schema. */
  | { kind: "json"; schema: string };

/**
 * The confirm level a change needs. `up`/`down` for ordered values (an integer, an ordered enum),
 * `on`/`off` for switches and booleans, `change` for unordered values (a list, an object).
 */
export type SettingConfirm =
  | { up: ConfirmLevel; down: ConfirmLevel }
  | { on: ConfirmLevel; off: ConfirmLevel }
  | { change: ConfirmLevel };

/**
 * Which change widens access (rule 4): a larger value, a smaller one, turning it on or off, or any
 * change at all (an origin list, a redirect path set).
 */
export type WidensWhen = "higher" | "lower" | "on" | "off" | "any";

/** The device-visible channels that carry a setting's value (S-18 §4.11). */
export type SettingWire = "document" | "discovery" | "refusal" | "header";

/** Where the value lives. */
export type SettingStorage =
  /**
   * One scalar row: `platform_settings` for platform scope, `product_settings` (ST-01b) for
   * product scope. `storedAs` is the row key when it differs from the registry key (A-13's four
   * keep their SCREAMING_CASE row keys, so no migration rewrites them).
   */
  | { kind: "scalar"; storedAs?: string }
  /** A column, until ST-01b and later packages move it into `product_settings`. */
  | { kind: "column"; table: string; column: string }
  /** A typed table read and written through a descriptor adapter (tiers, profiles, outlets). */
  | { kind: "rich"; adapter: string }
  /** Not stored: a code constant, a deploy value, or derived from other settings. */
  | { kind: "none" };

/**
 * One setting. `T` is the value type; registry entries use `SettingDef` (`unknown`) and the
 * resolver narrows by `value.kind`.
 */
export interface SettingDef<T = unknown> {
  /** `<namespace>.<group>.<name>`, e.g. `license.defaults.deviceLimit`. */
  key: string;
  /**
   * Older spellings that still resolve to this entry (A-13's `LAZY_DELTAS` ⇄ `deltas.lazy.mode`),
   * so `[vars]`, audit history and docs links keep working.
   */
  aliases?: readonly string[];
  scope: SettingScope;
  /** Required for, and only for, `entity` scope. */
  entity?: SettingEntity;
  /** The owner: a service (product scope), `core`, or `platform` (every platform-scope entry). */
  service: ServiceSlug | "core" | "platform";
  /** The settings-hub section, e.g. `license.policy`, `background-jobs`. */
  area: string;
  label: string;
  description: string;
  /** Search synonyms (ST-10). */
  keywords?: readonly string[];
  /** The docs page (and optional anchor) that explains it, e.g. `/docs/admin/platform-settings/`. */
  docs: string;
  value: ValueSpec;
  /** `null` only when `allowUnset` is true (`null` reads as "unset" / "unlimited"). */
  defaultValue: T | null;
  /**
   * Product scope only: a different default for products registered before a cut-over, so a new
   * default never changes an existing product's behaviour (plans/LX-01.md §8 Q2:
   * `licensing.entitlementModel` is `legacy` for products created before LX-06 and `combined`
   * after). `createdBefore` is epoch seconds, compared with `products.created_at`. Still DATA:
   * the resolver (ST-04) applies it, with source `default`; a manifest value or a console claim
   * overrides it like any default.
   */
  legacyDefault?: { createdBefore: number; value: T };
  merge: SettingMerge;
  /**
   * Product scope only: the product value inherits the platform entry of the same key (D5, live
   * inheritance). The platform entry must declare `productLink.default`.
   */
  inherits?: "platform";
  /**
   * For `merge: "policy"`: the side a higher scope bounds. `max` when a larger value is more
   * permissive (device limit, key-entry limit, session days), `min` when a smaller one is, `lock`
   * when a higher scope may enforce one value. Must sit on the permissive side (rule 4).
   */
  policyBound?: "min" | "max" | "lock";
  /** Which change widens access. Required for `policy` entries and security-widening ones. */
  widensWhen?: WidensWhen;
  /** False (the default): the value can never be null / "unlimited" (the key-entry limit). */
  allowUnset?: boolean;
  /**
   * Reserved, not built (S-18 D20, resolved by S-19 decision 1: model OC). Under OC an account ×
   * product never aggregates a per-licence value, so no entry may declare it.
   */
  accountMerge?: never;
  /**
   * Platform scope only: how product settings of the same key relate to this one. `default`: the
   * platform value is every product's default (products `inherits: "platform"`); `bound`: the
   * platform value bounds product values (products are `policy` with the same bound). A platform
   * entry without `productLink` is PLATFORM-ONLY: no product-scope entry may share its key.
   */
  productLink?: { default: boolean; bound: boolean };
  /** The `[vars]` name read as the deploy-time value, if any. */
  varName?: string;
  /** A-13's semantics for the deploy step: `ceiling` = a deploy-time `off` is a hard off. */
  precedence?: "runtime" | "ceiling";
  /** The manifest field that seeds or sets it: `<document>:<dotted path>`, e.g. `product:web.origins`. */
  manifest?: { path: string };
  /**
   * Who writes it (S-18 §4.2 places this inside `manifest`; it is top-level here so operator-only
   * and read-only entries carry it too). `manifest` / `claimable` / `narrow-only` need
   * `manifest.path`; `operator` and `read-only` may not have one.
   */
  ownership: SettingOwnership;
  confirm: SettingConfirm;
  /** A reason is required on every write. */
  critical?: boolean;
  /**
   * A product security setting whose change can widen access (web origins, an OIDC issuer, trust
   * policy, redirect paths, access modes): `critical`, never inherited from platform, and at least
   * L1 in its widening direction (rule 2).
   */
  securityWidening?: boolean;
  /** `secret`: only presence is ever shown or audited, never a value. */
  sensitivity: "config" | "secret";
  /** The capability a write needs (ST-21), e.g. `settings.product.license.write`. */
  capability: string;
  /** When the owning service is off: hide the row, show it read-only, or show it as usual. */
  visibleWhen?: {
    service?: ServiceSlug;
    offBehaviour: "hide" | "readOnly" | "visible";
  };
  /** Device-visible channels carrying the value (the console says "devices see this"). */
  wire?: readonly SettingWire[];
  /** Worker files (under `src/`) or Worker scripts (`deltas`) that read the value. */
  readers: readonly string[];
  storage: SettingStorage;
  /** The work package that registered it. */
  since: string;
  /**
   * Registered ahead of the work package that wires it (no reader yet). The console must not
   * offer it and ST-06's coverage test treats it as declared. Removed by `wp` when it lands.
   */
  pending?: { wp: string };
  deprecated?: { replacedBy: string };
}

/**
 * One service's settings, contributed through its descriptor (`ServiceDescriptor.settings`).
 * `namespaces` are the key prefixes the service owns (its slug, plus any it was given by design:
 * License owns `licensing.*`, S-19 §7.13). Two slices may not claim the same namespace.
 */
export interface ServiceSettingsSlice {
  namespaces: readonly string[];
  entries: readonly SettingDef[];
}
