/**
 * The registry rules (ST-03, notes/S-18 §4.2 "Registry rules", §4.15 item 1).
 *
 * `checkRegistry` answers every way the registry breaks a rule, as readable strings. It never
 * throws: `test/settings-registry.test.ts` runs it over the real composition root
 * (`mount.ts` `SETTINGS`) and expects nothing back, and runs it over deliberately broken
 * registries to prove each rule bites.
 *
 *   1. **The AT-2 deny-list** (S-13 §8.2, THREAT-MODEL "Platform settings and operations"): no
 *      platform-scope entry may be an origin, the privilege root, the admin IdP, a security gate,
 *      key material, a session length, a rate limit, retention or a bucket name. S-13's name list
 *      plus categories matched against every word of the key, its aliases and its `[vars]` name.
 *   2. **The product-scope analogue:** a security-widening product setting (web origins, an OIDC
 *      issuer, trust policy, redirect paths, a role map, access modes) is `critical`, never
 *      `inherits: "platform"` (one platform write must not widen every product), and needs at
 *      least L1 in its widening direction. Known keys and name patterns must carry the flag.
 *   3. **Sessions are shorten-only:** a product session length is `policy`, bounded `max`, widens
 *      when higher, and its maximum is its default (the code constant).
 *   4. **Bounds sit on the permissive side:** every `policy` entry declares `policyBound` and
 *      `widensWhen`; `higher` allows only `max`/`lock`, `lower` only `min`/`lock`, anything else
 *      only `lock`.
 *   5. **Platform-only keys stay platform-only:** a product-scope entry may share a key with a
 *      platform entry only when that platform entry declares `productLink` (a default products
 *      inherit, or a bound that clamps them), and the two must agree.
 *   6. **System-product locks hold** (the system-lock rule): every key `SYSTEM_LOCKED_KEYS` names
 *      is registered at product scope with exactly that `systemLock` value (ST-20:
 *      `core.manifest.authoritative` is on for the system product, S-18 §4.5 item 8), and only
 *      product entries declare one.
 *
 * Plus the structural rules every consumer relies on: unique keys per scope, unique aliases,
 * slices owning only their own namespaces (rule 6), defaults that fit their value spec, confirm
 * forms that fit the value, manifest paths where ownership needs them, readers on every live
 * entry, and no `accountMerge` (S-18 D20, resolved by S-19's model OC).
 *
 * Adding an entry is a THREAT-MODEL §9 review trigger even when these rules pass.
 */

import type { RegisteredSlice, SettingsRegistry } from "./registry.js";
import type {
  ConfirmLevel,
  SettingConfirm,
  SettingDef,
  ValueSpec,
} from "./types.js";

/** S-13 §8.2's names: deploy-time forever, at any spelling (the A-13 deny-list, carried over). */
export const DENIED_PLATFORM_NAMES: readonly string[] = [
  "BLOB_ORIGIN",
  "CONSOLE_ORIGIN",
  "PKG_ORIGIN",
  "IMG_ORIGIN",
  "PLATFORM_ADMIN_GROUP",
  "PLATFORM_OIDC_ISSUER",
  "PLATFORM_OIDC_CLIENT_ID",
  "PLATFORM_OIDC_CLIENT_SECRET",
  "ADMIN_OIDC_ISSUER",
  "ADMIN_OIDC_CLIENT_ID",
  "ADMIN_OIDC_CLIENT_SECRET",
  "OIDC_ISSUER_ALLOWLIST",
  // The KEK keyring. PLATFORM_KEK is the legacy single key: on its own it is the whole ring;
  // beside PLATFORM_KEK_KEYS it is the legacy key, open-only, under the kid PLATFORM_KEK_ID
  // names (src/keyvault.ts). Every one of the four is key material or kid selection.
  "PLATFORM_KEK",
  "PLATFORM_KEK_KEYS",
  "PLATFORM_KEK_ACTIVE",
  "PLATFORM_KEK_ID",
  "KEY_HASH_PEPPER",
  "ADMIN_SESSION_SECRET",
  "PORTAL_SESSION_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "R2_ACCOUNT_ID",
  "R2_PARENT_ACCESS_KEY_ID",
  "R2_PARENT_SECRET_ACCESS_KEY",
  "REGISTRY_TOKEN_KEY",
  "BLOBS_BUCKET_NAME",
  "PKEY_ENVIRONMENT",
  "PKEY_RELEASE_TAG",
  "PKEY_GIT_SHA",
  "CF_ANALYTICS_TOKEN",
  "ADMIN_SESSION_TTL_SECONDS",
  "AUDIT_RETENTION_SECONDS",
  "BLOB_LOCK_AGE_SECONDS",
];

/**
 * The deny-list categories. A platform entry's key, aliases and `[vars]` name are split into
 * tokens on `.`, `_` and `-` and lower-cased; `contains` matches anywhere in a token, `token`
 * matches a whole token, `word` matches one camel-case hump (`sessionTtl` → `session`, `ttl`).
 * `token` keeps short words exact, so `keyEntry` is not "key material" while `key` is.
 */
export const DENIED_PLATFORM_CATEGORIES: ReadonlyArray<{
  category: string;
  contains?: RegExp;
  token?: RegExp;
  word?: RegExp;
}> = [
  { category: "an origin", contains: /origin/ },
  { category: "the privilege root", contains: /admin|group/, word: /^roles?$/ },
  {
    category: "the admin identity provider",
    contains: /oidc|issuer/,
    word: /^(idp|sso)$/,
  },
  { category: "a security gate", contains: /allowlist|denylist/ },
  {
    category: "key material",
    contains: /kek|pepper|secret|signing|keyring|credential|privatekey|apikey/,
    token: /^(key|keys|kid)$/,
  },
  { category: "a session length", contains: /session/, word: /^ttl$/ },
  { category: "a rate limit", contains: /ratelimit|throttle/, word: /^rate$/ },
  { category: "a retention period", contains: /retention/, word: /^retain$/ },
  { category: "a bucket name", contains: /bucket/ },
];

/** The deny-list categories `name` falls into (exported for the rules test). */
export function deniedCategories(name: string): string[] {
  const found = new Set<string>();
  for (const raw of name.split(/[._-]+/).filter(Boolean)) {
    const token = raw.toLowerCase();
    const humps = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(" ")
      .map((w) => w.toLowerCase());
    for (const c of DENIED_PLATFORM_CATEGORIES)
      if (
        c.contains?.test(token) ||
        c.token?.test(token) ||
        (c.word && humps.some((h) => c.word!.test(h)))
      )
        found.add(c.category);
  }
  return [...found];
}

/** Product keys that widen access and so must be `securityWidening` whenever registered. */
export const SECURITY_WIDENING_KEYS: readonly string[] = [
  "core.adminGroup",
  "core.web.origins",
  "core.trustPolicy",
  "identity.oidc",
  "identity.redirectPaths",
  "identity.issuer.clients",
  "identity.exchange.oidc",
  "identity.exchange.firebase",
  "release.sparkleEd25519Pub",
  "update.metadataAccess",
  "distribution.access",
];

/**
 * Product keys whose value is fixed for the system product (`system = 1`) by a registry rule (the
 * system-lock rule). ST-20 (S-18 §4.5 item 8, owner decision D2): the system product is
 * manifest-authoritative, so two environments deployed from the same commit have the same
 * settings. Dropping an entry here, or the entry's `systemLock`, fails the registry test.
 */
export const SYSTEM_LOCKED_KEYS: Readonly<Record<string, unknown>> = {
  "core.manifest.authoritative": true,
};

/** Name patterns that mark a product key as security-widening even when it is not listed. */
const SECURITY_WIDENING_PATTERN =
  /(origin|issuer|redirect|groupRoleMap|trustPolicy|oidc|exchange|access$)/i;

const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const MANIFEST_PATH_RE =
  /^(product|release|schema|distribution):[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;
const WP_RE = /^[A-Z]+[0-9]*-[0-9]+[a-z]?$/;
const CAPABILITY_RE = /^settings\.(platform|product|entity)\.[a-zA-Z]+\.write$/;
const LEVELS: readonly ConfirmLevel[] = ["L0", "L1", "L2", "L3"];

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[._\s-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function maxLevel(a: ConfirmLevel, b: ConfirmLevel): ConfirmLevel {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/** The confirm level of the change that widens access (rule 2). */
export function wideningConfirm(def: SettingDef): ConfirmLevel {
  const c: SettingConfirm = def.confirm;
  if ("change" in c) return c.change;
  if ("up" in c)
    return def.widensWhen === "higher"
      ? c.up
      : def.widensWhen === "lower"
        ? c.down
        : maxLevel(c.up, c.down);
  return def.widensWhen === "on"
    ? c.on
    : def.widensWhen === "off"
      ? c.off
      : maxLevel(c.on, c.off);
}

/** Whether `value` is a value of `spec` (`null` is never one; see `allowUnset`). */
export function fitsValueSpec(spec: ValueSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "switch":
      return value === "on" || value === "off";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= spec.min &&
        value <= spec.max
      );
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "string":
      return (
        typeof value === "string" &&
        value.length <= spec.maxLength &&
        (spec.pattern === undefined || new RegExp(spec.pattern).test(value))
      );
    case "list":
      return (
        Array.isArray(value) &&
        value.length <= spec.max &&
        value.every((v) => fitsValueSpec(spec.of, v))
      );
    case "json":
      return value !== undefined && value !== null;
  }
}

function confirmFits(spec: ValueSpec, c: SettingConfirm): boolean {
  switch (spec.kind) {
    case "switch":
    case "boolean":
      return "on" in c;
    case "integer":
      return "up" in c;
    case "enum":
      return "change" in c || "up" in c;
    default:
      return "change" in c;
  }
}

function checkEntry(def: SettingDef, out: string[]): void {
  const at = `${def.scope} ${def.key}`;
  if (!KEY_RE.test(def.key))
    out.push(
      `${at}: key must be dotted lowerCamel segments (<namespace>.<group>.<name>)`,
    );
  if ("accountMerge" in def)
    out.push(
      `${at}: accountMerge is reserved and not built (S-18 D20, S-19 model OC)`,
    );
  if ((def.scope === "entity") !== (def.entity !== undefined))
    out.push(`${at}: entity is required for, and only for, entity scope`);
  if (def.scope === "platform" && def.service !== "platform")
    out.push(`${at}: a platform-scope entry belongs to service "platform"`);
  if (def.scope !== "platform" && def.service === "platform")
    out.push(`${at}: service "platform" is for platform-scope entries only`);
  if (def.productLink && def.scope !== "platform")
    out.push(`${at}: productLink is declared on platform entries only`);
  if (def.inherits && def.scope !== "product")
    out.push(`${at}: inherits is declared on product entries only`);
  if (def.precedence && def.scope !== "platform")
    out.push(
      `${at}: precedence (A-13's deploy step) applies to platform entries only`,
    );

  // Value and default.
  if (def.defaultValue === null) {
    if (def.allowUnset !== true)
      out.push(`${at}: a null default needs allowUnset: true`);
  } else if (!fitsValueSpec(def.value, def.defaultValue))
    out.push(`${at}: defaultValue does not fit its value spec`);
  if (def.value.kind === "integer" && def.value.min > def.value.max)
    out.push(`${at}: integer min is above max`);
  if (def.sensitivity === "secret" && def.defaultValue !== null)
    out.push(`${at}: a secret has no default value`);
  if (!confirmFits(def.value, def.confirm))
    out.push(`${at}: confirm form does not fit a ${def.value.kind} value`);

  // Ownership and manifest.
  const needsManifest =
    def.ownership === "manifest" ||
    def.ownership === "claimable" ||
    def.ownership === "narrow-only";
  if (needsManifest && !def.manifest)
    out.push(`${at}: ${def.ownership} ownership needs manifest.path`);
  if (!needsManifest && def.manifest)
    out.push(
      `${at}: ${def.ownership} ownership may not declare a manifest path`,
    );
  if (def.manifest && !MANIFEST_PATH_RE.test(def.manifest.path))
    out.push(`${at}: manifest.path must be <document>:<dotted path>`);
  if (def.scope === "platform" && needsManifest)
    out.push(`${at}: platform settings have no manifest`);

  // Rule 4: policy bounds sit on the permissive side.
  if (def.merge === "policy") {
    if (!def.policyBound || !def.widensWhen)
      out.push(
        `${at}: a policy entry declares policyBound and widensWhen (rule 4)`,
      );
    else {
      const ok =
        def.policyBound === "lock" ||
        (def.widensWhen === "higher" && def.policyBound === "max") ||
        (def.widensWhen === "lower" && def.policyBound === "min");
      if (!ok)
        out.push(
          `${at}: policyBound "${def.policyBound}" is not on the permissive side of widensWhen "${def.widensWhen}" (rule 4)`,
        );
    }
  } else if (def.policyBound)
    out.push(`${at}: policyBound is for policy entries only`);

  // Rule 1: the AT-2 deny-list.
  if (def.scope === "platform") {
    const names = [
      def.key,
      ...(def.aliases ?? []),
      ...(def.varName ? [def.varName] : []),
    ];
    for (const n of names) {
      if (DENIED_PLATFORM_NAMES.includes(n))
        out.push(`${at}: "${n}" is deploy-time forever (S-13 §8.2, AT-2)`);
      for (const category of deniedCategories(n))
        out.push(
          `${at}: "${n}" names ${category}, which stays deploy-time (rule 1, AT-2)`,
        );
    }
  }

  // Rule 2: security-widening product settings.
  if (def.scope !== "platform") {
    const mustWiden =
      SECURITY_WIDENING_KEYS.includes(def.key) ||
      SECURITY_WIDENING_PATTERN.test(def.key);
    if (mustWiden && !def.securityWidening)
      out.push(`${at}: widens access, so it must be securityWidening (rule 2)`);
  } else if (def.securityWidening)
    out.push(
      `${at}: a security-widening knob cannot be a platform setting (rule 1)`,
    );
  if (def.securityWidening) {
    if (!def.critical)
      out.push(`${at}: a security-widening setting is critical (rule 2)`);
    if (def.inherits)
      out.push(
        `${at}: a security-widening setting never inherits from platform (rule 2)`,
      );
    if (!def.widensWhen)
      out.push(
        `${at}: a security-widening setting declares widensWhen (rule 2)`,
      );
    if (LEVELS.indexOf(wideningConfirm(def)) < 1)
      out.push(`${at}: widening a security setting needs at least L1 (rule 2)`);
  }

  // Rule 3: sessions are shorten-only.
  if (def.scope !== "platform" && words(def.key).includes("session")) {
    const ok =
      def.merge === "policy" &&
      (def.policyBound === "max" || def.policyBound === "lock") &&
      def.widensWhen === "higher" &&
      def.value.kind === "integer" &&
      def.value.max === def.defaultValue;
    if (!ok)
      out.push(
        `${at}: a session length is shorten-only: policy, bound max, widens higher, max = the default (rule 3)`,
      );
  }

  // Liveness, capability.
  if (def.pending) {
    if (!WP_RE.test(def.pending.wp))
      out.push(`${at}: pending.wp must be a work-package id`);
  } else if (def.readers.length === 0)
    out.push(`${at}: a live entry names at least one reader (or is pending)`);
  if (!CAPABILITY_RE.test(def.capability))
    out.push(`${at}: capability must be settings.<scope>.<owner>.write`);
  if (def.visibleWhen?.service && def.visibleWhen.service !== def.service)
    out.push(`${at}: visibleWhen.service must be the owning service`);

  // The system-lock rule: a lock is a product value, and a value of the entry's spec.
  if (def.systemLock) {
    if (def.scope !== "product")
      out.push(`${at}: systemLock is declared on product entries only`);
    if (!fitsValueSpec(def.value, def.systemLock.value))
      out.push(`${at}: systemLock.value does not fit its value spec`);
  }
}

function checkSlice(slice: RegisteredSlice, out: string[]): void {
  for (const def of slice.entries) {
    const at = `${def.scope} ${def.key}`;
    if (slice.owner === "platform") {
      if (def.scope !== "platform")
        out.push(`${at}: the platform slice holds platform-scope entries only`);
      continue;
    }
    if (def.scope === "platform")
      out.push(
        `${at}: ${slice.owner} may not contribute a platform-scope entry`,
      );
    if (def.service !== slice.owner)
      out.push(
        `${at}: contributed by ${slice.owner} but declares service ${def.service}`,
      );
    const ns = def.key.split(".")[0]!;
    if (!slice.namespaces.includes(ns))
      out.push(`${at}: ${slice.owner} does not own namespace "${ns}"`);
  }
}

/** Every rule the registry breaks; empty when it is sound. */
export function checkRegistry(registry: SettingsRegistry): string[] {
  const out: string[] = [];

  // Namespaces: each owned once; services may not take Core's or the platform's.
  const nsOwner = new Map<string, string>();
  for (const s of registry.slices) {
    if (s.owner !== "core" && s.owner !== "platform")
      for (const ns of s.namespaces)
        if (ns === "core" || ns === "platform")
          out.push(`slice ${s.owner}: namespace "${ns}" is reserved`);
    for (const ns of s.namespaces) {
      const prev = nsOwner.get(ns);
      if (prev && prev !== s.owner)
        out.push(`namespace "${ns}" is claimed by both ${prev} and ${s.owner}`);
      nsOwner.set(ns, s.owner);
    }
    checkSlice(s, out);
  }

  // Unique keys per scope; unique aliases.
  const seen = new Set<string>();
  const keys = new Set(registry.entries.map((e) => e.key));
  const aliasOwner = new Map<string, string>();
  for (const def of registry.entries) {
    const id = `${def.scope} ${def.key}`;
    if (seen.has(id)) out.push(`${id}: registered twice`);
    seen.add(id);
    for (const a of def.aliases ?? []) {
      if (keys.has(a)) out.push(`${id}: alias "${a}" is also a registry key`);
      const prev = aliasOwner.get(a);
      if (prev !== undefined && prev !== def.key)
        out.push(`${id}: alias "${a}" already names ${prev}`);
      aliasOwner.set(a, def.key);
    }
    checkEntry(def, out);
  }

  // The system-lock rule: every locked key is registered, at product scope, with its lock.
  for (const [key, value] of Object.entries(SYSTEM_LOCKED_KEYS)) {
    const def = registry.entries.find(
      (e) => e.scope === "product" && e.key === key,
    );
    if (!def)
      out.push(
        `product ${key}: locked for the system product, so it must be registered`,
      );
    else if (
      !def.systemLock ||
      JSON.stringify(def.systemLock.value) !== JSON.stringify(value)
    )
      out.push(
        `product ${key}: the system product's value is locked to ${JSON.stringify(value)} (systemLock)`,
      );
  }

  // Rule 5: platform-only keys, and the platform ↔ product link.
  const platform = new Map(
    registry.entries
      .filter((e) => e.scope === "platform")
      .map((e) => [e.key, e]),
  );
  const product = new Map(
    registry.entries
      .filter((e) => e.scope === "product")
      .map((e) => [e.key, e]),
  );
  for (const [key, p] of product) {
    const at = `product ${key}`;
    const plat = platform.get(key);
    if (!plat) {
      if (p.inherits)
        out.push(`${at}: inherits from a platform entry that does not exist`);
      continue;
    }
    if (!plat.productLink) {
      out.push(
        `${at}: "${key}" is a platform-only key; a product entry may not share it (rule 5)`,
      );
      continue;
    }
    if (p.inherits && !plat.productLink.default)
      out.push(
        `${at}: inherits, but the platform entry is not a product default`,
      );
    if (plat.productLink.default && !p.inherits)
      out.push(
        `${at}: the platform entry is a product default; declare inherits: "platform"`,
      );
    if (plat.productLink.bound) {
      if (
        p.merge !== "policy" ||
        p.policyBound !== plat.policyBound ||
        p.widensWhen !== plat.widensWhen
      )
        out.push(
          `${at}: the platform entry bounds it, so it is policy with the same policyBound and widensWhen`,
        );
    }
  }
  for (const [key, plat] of platform) {
    if (!plat.productLink) continue;
    const at = `platform ${key}`;
    if (!plat.productLink.default && !plat.productLink.bound)
      out.push(
        `${at}: productLink links nothing; omit it for a platform-only key`,
      );
    if (!product.has(key))
      out.push(`${at}: productLink names no product entry of the same key`);
    if (plat.productLink.bound && plat.merge !== "policy")
      out.push(`${at}: a platform bound is a policy entry`);
    if (plat.productLink.default && plat.productLink.bound)
      out.push(
        `${at}: a default and a bound are two values; register the bound under its own key`,
      );
  }

  return out;
}
