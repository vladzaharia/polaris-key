/**
 * The platform slice (ST-03, notes/S-18 §4.2 and Appendix A.1): instance-wide settings, and the
 * platform defaults and bounds that product settings of the same key inherit (`productLink`).
 *
 * A-13's four editable keys (and LX-05's `licensing.reservedNames`) live here now, under their
 * registry keys, with their old SCREAMING_CASE names as aliases (S-18 §4.1). Their
 * `platform_settings` rows keep the old names (`storage.storedAs`), so no migration rewrites them
 * and the A-13 store and admin route (`core/platformSettings.ts`, which derives `PLATFORM_SETTINGS`
 * from this slice) are unchanged.
 *
 * Everything here is reviewed against AT-2 (THREAT-MODEL "Platform settings and operations"):
 * `rules.ts` refuses an origin, the privilege root, the admin IdP, a security gate, key
 * material, a session length, a rate limit, retention and bucket names at platform scope.
 * Adding an entry is a THREAT-MODEL §9 review trigger.
 */

import {
  DEFAULT_RESERVED_DISPLAY_NAMES_MODE,
  DEFAULT_RESERVED_NAMES_MODE,
} from "@polaris-key/manifest";
import { setting } from "./define.js";
import type { SettingDef } from "./types.js";

/**
 * The lazy-delta consumer's per-side ceiling: 32 MiB, measured (notes/S-08 §4.2) against the
 * consumer's 128 MB isolate. A runtime value may only lower it, and "lower" is measured against
 * THIS constant, not against the deploy-time `[vars]` value.
 */
export const LAZY_DELTA_MAX_BYTES_CEILING = 33_554_432;
/** The lowest runtime per-side cap (1 MiB): below it no delta could save `MIN_SAVING_BYTES`. */
export const LAZY_DELTA_MAX_BYTES_FLOOR = 1_048_576;

/** I-04 §8 Q7: the key-entry limit is 1–100, default 10, and never unlimited while Identity is on. */
export const KEY_ENTRY_LIMIT_MIN = 1;
export const KEY_ENTRY_LIMIT_MAX = 100;
export const KEY_ENTRY_LIMIT_DEFAULT = 10;

/** The console's offline-window bound (`admin/lib/writeChecks.ts` `MAX_OFFLINE_DAYS`; a test pins them). */
export const OFFLINE_DAYS_MAX = 365;
/** The column defaults of `products.default_max_offline_days` / `default_device_limit` (0001). */
export const DEFAULT_MAX_OFFLINE_DAYS = 30;
export const DEFAULT_DEVICE_LIMIT = 5;
/** No device-limit maximum exists today; the registry bounds the value so it stays an integer. */
export const DEVICE_LIMIT_MAX = 1_000_000;

const PLATFORM_DOCS = "/docs/admin/platform-settings/";

export const PLATFORM_SLICE: readonly SettingDef[] = [
  // ── A-13's four (live) ──────────────────────────────────────────────────────────────────
  setting({
    key: "deltas.lazy.mode",
    aliases: ["LAZY_DELTAS"],
    scope: "platform",
    service: "platform",
    area: "background-jobs",
    label: "Lazy deltas",
    description:
      "Lets products opted in to lazy hot-pair deltas count demand and generate deltas. Off stops the subsystem in both Worker scripts.",
    keywords: ["delta", "patch", "kill switch"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "LAZY_DELTAS",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    readers: [
      "core/deltaDemand.ts",
      "services/release/packs/deltas/consumer.ts",
      "services/release/packs/deltas/sweep.ts",
    ],
    storage: { kind: "scalar", storedAs: "LAZY_DELTAS" },
    since: "A-13",
  }),
  setting({
    key: "deltas.lazy.maxBytes",
    aliases: ["LAZY_DELTA_MAX_BYTES"],
    scope: "platform",
    service: "platform",
    area: "background-jobs",
    label: "Lazy delta size cap",
    description:
      "The largest payload, on either side of a pair, the delta consumer will encode. It can only be lowered below the measured 32 MiB ceiling.",
    docs: PLATFORM_DOCS,
    value: {
      kind: "integer",
      unit: "bytes",
      min: LAZY_DELTA_MAX_BYTES_FLOOR,
      max: LAZY_DELTA_MAX_BYTES_CEILING,
    },
    defaultValue: LAZY_DELTA_MAX_BYTES_CEILING,
    merge: "cascade",
    varName: "LAZY_DELTA_MAX_BYTES",
    precedence: "runtime",
    ownership: "operator",
    confirm: { up: "L1", down: "L0" },
    readers: ["services/release/packs/deltas/consumer.ts"],
    storage: { kind: "scalar", storedAs: "LAZY_DELTA_MAX_BYTES" },
    since: "A-13",
  }),
  setting({
    key: "blobs.gc.mode",
    aliases: ["BLOB_GC_MODE"],
    scope: "platform",
    service: "platform",
    area: "background-jobs",
    label: "Blob collector",
    description:
      "Runs the nightly collector that deletes blob-store objects nothing has referenced for the grace period. Off only costs storage.",
    keywords: ["garbage collection", "gc", "storage", "kill switch"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "on",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "BLOB_GC_MODE",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    readers: ["core/blobGc.ts"],
    storage: { kind: "scalar", storedAs: "BLOB_GC_MODE" },
    since: "A-13",
  }),
  setting({
    key: "blobs.gc.graceDays",
    aliases: ["BLOB_GC_GRACE_DAYS"],
    scope: "platform",
    service: "platform",
    area: "background-jobs",
    label: "Blob collector grace period",
    description:
      "How long an object stays unreferenced before the collector may delete it. The bucket's 180-day age lock still bounds every deletion.",
    docs: PLATFORM_DOCS,
    value: { kind: "integer", unit: "days", min: 1, max: 365 },
    defaultValue: 30,
    merge: "cascade",
    varName: "BLOB_GC_GRACE_DAYS",
    precedence: "runtime",
    ownership: "operator",
    confirm: { up: "L0", down: "L1" },
    readers: ["core/blobGc.ts"],
    storage: { kind: "scalar", storedAs: "BLOB_GC_GRACE_DAYS" },
    since: "A-13",
  }),

  // ── Licensing (LX-05, S-19 §7.4, decision 15) ───────────────────────────────────────────
  // How an incompatible declaration of a reserved entitlement name (`channels`, `deviceLimit`,
  // `app.*`, `license.*`, `pkey.*`) is treated at manifest ingest and on console catalog writes.
  // `warn` for the window (two minor releases or 60 days, whichever is later); LX-05b flips the
  // default to `error`. Neither value changes what a device is signed: the Worker's policy
  // injection still overwrites every system key after the merge. Platform-only (no productLink).
  setting({
    key: "licensing.reservedNames",
    aliases: ["LICENSING_RESERVED_NAMES"],
    scope: "platform",
    service: "platform",
    area: "licensing",
    label: "Reserved entitlement names",
    description:
      "How a product catalog flag that declares a system key (channels, deviceLimit, app.*, license.*, pkey.*) with an incompatible type is treated: warn and accept it, or refuse the manifest or catalog.",
    keywords: ["reserved", "entitlement", "system key", "catalog"],
    docs: PLATFORM_DOCS,
    // Ordered: `up` is toward `error`. Refusing can stop a product's next resync, so it is
    // confirmed; relaxing is not.
    value: { kind: "enum", values: ["warn", "error"] },
    defaultValue: DEFAULT_RESERVED_NAMES_MODE,
    merge: "cascade",
    varName: "LICENSING_RESERVED_NAMES",
    precedence: "runtime",
    ownership: "operator",
    confirm: { up: "L1", down: "L0" },
    readers: ["core/reservedNames.ts"],
    storage: { kind: "scalar", storedAs: "LICENSING_RESERVED_NAMES" },
    since: "LX-05",
  }),

  // ── Identity: reserved display names (PX-W13, plans/PX-W13.md §8 Q4 as amended) ─────────
  // How an app or developer name that uses a platform or store name (`reserved_display_name`) is
  // treated at manifest ingest and on console listing claims. `warn` for the S-19 decision-15
  // window (two minor releases or 60 days after PX-W13 ships, whichever is later); then the lead
  // flips it to `error`. Either way the sign-in card's render-time re-check shows such a name in
  // the neutral frame. Platform-only (no productLink).
  setting({
    key: "identity.reservedDisplayNames",
    aliases: ["IDENTITY_RESERVED_DISPLAY_NAMES"],
    scope: "platform",
    service: "platform",
    area: "identity",
    label: "Reserved display names",
    description:
      "How a product name or listing name that uses a platform or store name (Polaris Key, Apple, Google Play, Steam and others) is treated: warn and accept it, or refuse the manifest or listing.",
    keywords: ["reserved", "display name", "spoofing", "sign-in"],
    docs: "/docs/admin/platform-settings/",
    // Ordered: `up` is toward `error`. Refusing can stop a product's next resync, so it is
    // confirmed; relaxing is not.
    value: { kind: "enum", values: ["warn", "error"] },
    defaultValue: DEFAULT_RESERVED_DISPLAY_NAMES_MODE,
    merge: "cascade",
    varName: "IDENTITY_RESERVED_DISPLAY_NAMES",
    precedence: "runtime",
    ownership: "operator",
    confirm: { up: "L1", down: "L0" },
    readers: ["core/reservedDisplayNames.ts"],
    storage: { kind: "scalar", storedAs: "IDENTITY_RESERVED_DISPLAY_NAMES" },
    since: "PX-W13",
  }),

  // ── Identity (registered for I-09 and I-10a; I-04 §7 step 3, S-18 §5.5) ────────────────
  setting({
    key: "identity.keyEntryRefusals",
    scope: "platform",
    service: "platform",
    area: "identity",
    label: "Key-entry refusals",
    description:
      "Lets Identity products refuse key entry past the per-licence limit and on owned licences. Counting runs either way; turn it on once the SDKs that show the refusals are released.",
    keywords: ["key entry", "key_entry_limit", "license_owned", "rollout"],
    docs: "/docs/services/identity/",
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    // Off is the permissive side: with refusals off, every key entry is admitted.
    widensWhen: "off",
    precedence: "runtime",
    ownership: "operator",
    confirm: { on: "L1", off: "L1" },
    wire: ["refusal"],
    storage: { kind: "scalar" },
    pending: { wp: "I-09" },
  }),
  setting({
    key: "identity.keyEntry.limit",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Key-entry limit ceiling",
    description:
      "The most key entries any product may allow per floating licence. A product may set a lower limit, never a higher one; there is no unlimited value while Identity is on.",
    keywords: ["key entry", "activations", "floating licence"],
    docs: "/docs/services/identity/",
    value: {
      kind: "integer",
      unit: "count",
      min: KEY_ENTRY_LIMIT_MIN,
      max: KEY_ENTRY_LIMIT_MAX,
    },
    defaultValue: KEY_ENTRY_LIMIT_MAX,
    allowUnset: false,
    merge: "policy",
    policyBound: "max",
    widensWhen: "higher",
    productLink: { default: false, bound: true },
    ownership: "operator",
    confirm: { up: "L1", down: "L2" },
    storage: { kind: "scalar" },
    pending: { wp: "ST-16" },
  }),

  // ── Product defaults (ST-16 wires them; owner decision 2: live inheritance) ─────────────
  setting({
    key: "license.defaults.deviceLimit",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Default device limit",
    description:
      "The device limit a product starts from when it sets none of its own. A change reaches every product that inherits it.",
    keywords: ["seats", "devices"],
    docs: "/docs/services/license/policy/",
    value: { kind: "integer", unit: "count", min: 1, max: DEVICE_LIMIT_MAX },
    defaultValue: DEFAULT_DEVICE_LIMIT,
    merge: "cascade",
    productLink: { default: true, bound: false },
    ownership: "operator",
    confirm: { up: "L2", down: "L2" },
    storage: { kind: "scalar" },
    pending: { wp: "ST-16" },
  }),
  setting({
    key: "license.defaults.maxOfflineDays",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Default offline window",
    description:
      "How many days a device may run offline when its product sets no window of its own. A change reaches every product that inherits it.",
    keywords: ["grace", "offline", "graceUntil"],
    docs: "/docs/services/license/policy/",
    value: { kind: "integer", unit: "days", min: 0, max: OFFLINE_DAYS_MAX },
    defaultValue: DEFAULT_MAX_OFFLINE_DAYS,
    // S-18 A.1 also names a platform MAXIMUM for this key. A default and a bound are two values,
    // so the bound needs its own entry; ST-16 adds it with the bound-direction resolver tests.
    merge: "cascade",
    productLink: { default: true, bound: false },
    ownership: "operator",
    confirm: { up: "L2", down: "L2" },
    wire: ["document"],
    storage: { kind: "scalar" },
    pending: { wp: "ST-16" },
  }),
];
