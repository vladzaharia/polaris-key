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

import { CLOUD_SYNC_CEILINGS, CLOUD_SYNC_DEFAULTS } from "@polaris-key/catalog";
import {
  DEFAULT_RESERVED_DISPLAY_NAMES_MODE,
  DEFAULT_RESERVED_NAMES_MODE,
  IDENTITY_KEY_ENTRY_LIMIT,
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

/**
 * I-04 §8 Q7: the key-entry limit is 1–100, default 10, and never unlimited while Identity is on.
 * The manifest rule `invalid_identity_key_entry_limit` uses the same numbers (I-09).
 */
export const KEY_ENTRY_LIMIT_MIN = IDENTITY_KEY_ENTRY_LIMIT.min;
export const KEY_ENTRY_LIMIT_MAX = IDENTITY_KEY_ENTRY_LIMIT.max;
export const KEY_ENTRY_LIMIT_DEFAULT = IDENTITY_KEY_ENTRY_LIMIT.default;

/** The console's offline-window bound (`admin/lib/writeChecks.ts` `MAX_OFFLINE_DAYS`; a test pins them). */
export const OFFLINE_DAYS_MAX = 365;
/** The column defaults of `products.default_max_offline_days` / `default_device_limit` (0001). */
export const DEFAULT_MAX_OFFLINE_DAYS = 30;
export const DEFAULT_DEVICE_LIMIT = 5;
/** No device-limit maximum exists today; the registry bounds the value so it stays an integer. */
export const DEVICE_LIMIT_MAX = 1_000_000;

/**
 * HA-10 (notes/S-20 owner decision 9): the hosting quotas' defaults and bounds. The defaults are
 * S-20's (512 MiB of images, 100 GiB of mirrored release files); the maxima only keep the value a
 * bounded integer (1 TiB, 10 TiB). Per-file caps are code constants (`core/hostedAssets.ts`
 * `SLOT_CLASSES`), never settings: they are security bounds (S-18 §5.6).
 */
export const ASSET_MEDIA_QUOTA_DEFAULT = 512 * 1024 * 1024;
export const ASSET_MEDIA_QUOTA_MAX = 1024 ** 4;
export const ASSET_RELEASE_QUOTA_DEFAULT = 100 * 1024 ** 3;
export const ASSET_RELEASE_QUOTA_MAX = 10 * 1024 ** 4;

/** The page that explains hosted assets, their switches and their quotas. */
export const ASSETS_DOCS = "/docs/operate/console/presentation/";

const PLATFORM_DOCS = "/docs/operate/platform/settings/";

/** The lowest platform default quota (1 MiB, the licence-less quota): below it no person could
 *  keep even the settings budget's worth of data. */
export const CLOUD_SYNC_QUOTA_DEFAULT_MIN =
  CLOUD_SYNC_DEFAULTS.unlicensedQuotaBytes;

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
    docs: "/docs/operate/platform/settings/",
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

  // PX-W13 (§8 Q4, as amended): terms the platform reserves on top of the code's floor
  // (`RESERVED_DISPLAY_TERMS` in @polaris-key/manifest). It can only add terms, never remove one.
  // PX-W13b wires it into the validator and the Worker's reserved-name check.
  setting({
    key: "identity.reservedDisplayTerms",
    scope: "platform",
    service: "platform",
    area: "identity",
    label: "Extra reserved display terms",
    description:
      "Platform or store names, beyond the built-in list, that a product or developer name may not use.",
    keywords: ["reserved", "display name", "spoofing"],
    docs: "/docs/operate/platform/settings/",
    value: { kind: "list", of: { kind: "string", maxLength: 64 }, max: 64 },
    defaultValue: [],
    merge: "cascade",
    ownership: "operator",
    confirm: { change: "L1" },
    storage: { kind: "scalar" },
    pending: { wp: "PX-W13b" },
  }),

  // ── Identity (registered for I-09 and I-10a; I-04 §7 step 3, S-18 §5.5) ────────────────
  // PX-W9 (plans/PX-W9.md §3) made the refusal switch an A-13 store entry. Its row and `[vars]`
  // name is `KEYENTRY_REFUSALS`, "key entry" as one word and no `IDENTITY_` prefix: a `KEY` token
  // or a `_KEY` would read as key material to the AT-2 deny-list (`rules.ts`,
  // `test/platformSettings.test.ts`). Counting runs whatever it says; it decides
  // only whether a licence past its limit is refused (WIRE-CONTRACT-V4 §12.2 step 4). I-09 adds
  // its own reader (`license_owned`).
  setting({
    key: "identity.keyEntryRefusals",
    aliases: ["KEYENTRY_REFUSALS"],
    scope: "platform",
    service: "platform",
    area: "identity",
    label: "Key-entry refusals",
    description:
      "Lets Identity products refuse key entry past the per-licence limit and on owned licences. Counting runs either way; turn it on once the SDKs that show the refusals are released.",
    keywords: ["key entry", "key_entry_limit", "license_owned", "rollout"],
    docs: "/docs/features/sign-in/",
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    // Off is the permissive side: with refusals off, every key entry is admitted.
    widensWhen: "off",
    varName: "KEYENTRY_REFUSALS",
    precedence: "runtime",
    ownership: "operator",
    confirm: { on: "L1", off: "L1" },
    wire: ["refusal"],
    readers: ["core/keyEntries.ts"],
    storage: { kind: "scalar", storedAs: "KEYENTRY_REFUSALS" },
  }),
  setting({
    key: "identity.keyEntry.limit",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Key-entry limit ceiling",
    description:
      "The most key entries any product may allow per licence that is in no account. A product may set a lower limit, never a higher one; there is no unlimited value while Identity is on.",
    keywords: ["key entry", "activations", "floating licence"],
    docs: "/docs/features/sign-in/",
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

  // ── The Polaris Key storefront (PS-02, notes/S-21 §6.2) ─────────────────────────────────
  setting({
    key: "storefront.polarisKey.enabled",
    scope: "platform",
    service: "platform",
    area: "storefront",
    label: "Polaris Key storefront",
    description:
      "Lets products be listed in the Polaris Key library (Discover and the storefront page). Off hides every listing on this deployment; licences, sign-in and auto-issue keep working.",
    keywords: ["discover", "library", "storefront", "kill switch"],
    docs: "/docs/features/sign-in/customer-portal/",
    value: { kind: "switch" },
    defaultValue: "on",
    merge: "cascade",
    widensWhen: "on",
    ownership: "operator",
    confirm: { on: "L2", off: "L2" },
    // A `platform_settings` row under the registry key itself (no A-13 alias); ST-05 writes it.
    storage: { kind: "scalar" },
    since: "PS-02",
    // The storefront engine's candidate set (S-21 §6.3 "Candidates", PS-03).
    readers: [
      "core/storefrontSwitch.ts",
      "services/identity/portal/store/obtain.ts",
    ],
  }),

  // ── Hosted assets (HA-10, notes/S-20 §6.8 "Rollback", §6.10, owner decision 9) ───────────
  // The kill switch. Not a security gate: off only returns every image surface to what it did
  // before HA-07 (the portal's GitHub-only media proxy, the developer's URLs in the feeds, no icon
  // on the download page) and stops release-file mirroring: no new copy is made and the legacy
  // download streams from GitHub, while the byte routes keep serving copies already made (their
  // `r2` locations are hash-pinned). The stored copies and their refs stay either way. An A-13 store entry, so the console's Platform → Settings switches
  // it and a deploy can set it. `runtime` (S-20 §6.10): a console value wins, then `[vars]`, then
  // the default `on`; an unreadable store is not an off, so an outage never forces the rollback.
  setting({
    key: "assets.hosting.enabled",
    aliases: ["ASSET_HOSTING"],
    scope: "platform",
    service: "platform",
    area: "delivery",
    label: "Hosted assets",
    description:
      "Serves Polaris Key's own copies of products' images from the image host and mirrors their release files. Off returns every image surface to the developer's own URLs and copies no new release file; release files already copied keep serving from their copies, and every stored copy stays.",
    keywords: ["image host", "img", "mirror", "kill switch", "rollback"],
    docs: ASSETS_DOCS,
    value: { kind: "switch" },
    defaultValue: "on",
    merge: "cascade",
    varName: "ASSET_HOSTING",
    precedence: "runtime",
    ownership: "operator",
    confirm: { on: "L1", off: "L1" },
    readers: [
      "core/assetHosting.ts",
      "core/hostedImages.ts",
      "services/release/mirrorSwitch.ts",
    ],
    storage: { kind: "scalar", storedAs: "ASSET_HOSTING" },
    since: "HA-10",
  }),
  // Every product's default hosting quotas (owner decision 9). A product inherits them live
  // (`assets.quota.*` at product scope) unless an operator sets its own. Stored under the
  // registry key itself (no A-13 alias); ST-05's generic API and ST-16's platform defaults are
  // their console writers, so until then the code default applies everywhere.
  setting({
    key: "assets.quota.mediaBytes",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Default media quota",
    description:
      "How many bytes of hosted images (originals and their sizes, not release files) a product may hold when it sets no quota of its own. Past it, a new image is refused and the current copy keeps serving.",
    keywords: ["hosted assets", "storage", "quota", "images"],
    docs: ASSETS_DOCS,
    value: {
      kind: "integer",
      unit: "bytes",
      min: 0,
      max: ASSET_MEDIA_QUOTA_MAX,
    },
    defaultValue: ASSET_MEDIA_QUOTA_DEFAULT,
    merge: "cascade",
    productLink: { default: true, bound: false },
    ownership: "operator",
    confirm: { up: "L1", down: "L1" },
    readers: ["core/assetSettings.ts", "core/assetQuota.ts"],
    storage: { kind: "scalar" },
    since: "HA-10",
  }),
  setting({
    key: "assets.quota.releaseBytes",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Default release-file quota",
    description:
      "How many bytes of mirrored release files a product may hold when it sets no quota of its own. Past it, mirroring stops and GitHub keeps serving the files.",
    keywords: ["hosted assets", "storage", "quota", "mirror", "releases"],
    docs: ASSETS_DOCS,
    value: {
      kind: "integer",
      unit: "bytes",
      min: 0,
      max: ASSET_RELEASE_QUOTA_MAX,
    },
    defaultValue: ASSET_RELEASE_QUOTA_DEFAULT,
    merge: "cascade",
    productLink: { default: true, bound: false },
    ownership: "operator",
    confirm: { up: "L1", down: "L1" },
    readers: ["core/assetSettings.ts", "core/assetQuota.ts"],
    storage: { kind: "scalar" },
    since: "HA-10",
  }),

  // ── Cloud Sync (plans/U-01b.md D5, D6, R1; U-05 adds the readers) ───────────────────────
  // The deployment's one Cloud Sync kill switch. Pausing restricts (no write lands), so the
  // permissive side is off; a platform lock, never a product value. Reads keep working and
  // nothing is deleted: a device keeps its journal and retries after the pause (`writes_paused`).
  setting({
    key: "cloudSync.writesPaused",
    scope: "platform",
    service: "platform",
    area: "cloudSync",
    label: "Pause Cloud Sync writes",
    description:
      "Pauses every Cloud Sync write on this deployment. Reads keep working, devices keep their unsynced changes and retry after the pause, and nothing is deleted.",
    keywords: ["cloud sync", "kill switch", "pause", "writes_paused"],
    docs: "/docs/features/cloud-sync/",
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    // Off is the permissive side: with the pause off, every write is admitted.
    widensWhen: "off",
    ownership: "operator",
    critical: true,
    confirm: { on: "L2", off: "L1" },
    storage: { kind: "scalar" },
    since: "U-01b",
    pending: { wp: "U-05" },
  }),
  // The quota a person gets when no tier, licence override or add-on sets `pkey.cloudSync.bytes`.
  // Clamped to the per-person ceiling; lowering it deletes nothing (a person over it can still
  // read, clear and delete). One write reaches every product with Cloud Sync on, so it takes the
  // passkey confirm with ST-16's fan-out dialog. LX-34 later adopts it as the registry default of
  // the `pkey.cloudSync.bytes` entitlement.
  setting({
    key: "cloudSync.quota.defaultBytes",
    scope: "platform",
    service: "platform",
    area: "cloudSync",
    label: "Default Cloud Sync quota",
    description:
      "How many bytes of Cloud Sync data one person may keep on a product when no tier, licence or add-on sets pkey.cloudSync.bytes. A change reaches every product with Cloud Sync on; lowering it deletes nothing.",
    keywords: ["cloud sync", "quota", "storage", "pkey.cloudSync.bytes"],
    docs: "/docs/features/cloud-sync/",
    value: {
      kind: "integer",
      unit: "bytes",
      min: CLOUD_SYNC_QUOTA_DEFAULT_MIN,
      max: CLOUD_SYNC_CEILINGS.perPerson.bytes,
    },
    defaultValue: CLOUD_SYNC_DEFAULTS.quotaBytes,
    merge: "cascade",
    ownership: "operator",
    critical: true,
    confirm: { up: "L2", down: "L2" },
    storage: { kind: "scalar" },
    since: "U-01b",
    pending: { wp: "U-05" },
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
    docs: "/docs/features/licensing/access/",
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
    docs: "/docs/features/licensing/access/",
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
