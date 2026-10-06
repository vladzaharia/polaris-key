// The declarative config catalog types. A product's catalog is authored as data
// (JSON), versioned, stored in D1, and served at `/<product>/schema`. The admin SPA and
// every SDK read it at runtime; optional codegen (tools/gen-mirrors.ts) emits typed
// mirrors. This is the generalized shape of djdl's `src/core/configSchema.ts` — no
// product-specific keys live in code anymore.

import type { SecretDelivery } from "@polaris-key/protocol/config";

export type ConfigKind = "config" | "secret" | "flag";

/** Per-key MDM-style management state — applies to `config` keys only.
 *  `default` (overridable by user/env) | `enforced` (server wins, read-only) |
 *  `hidden` (enforced + withheld from user-facing enumeration). */
export type ManagementState = "default" | "enforced" | "hidden";

/** rjsf/SwiftUI rendering hints — never affect validation, only presentation. */
export interface UiHints {
  widget?: "password" | "select" | "textarea" | "switch" | "stepper";
  help?: string;
  placeholder?: string;
  order?: number;
  /** Admin scopes where the value is meaningful (omitted ⇒ all). `user` is a hint only: the
   *  enforced field for a user setting is `ConfigEntry.user.sync` (plans/U-01.md §3). */
  scopes?: ("profile" | "license" | "device" | "user")[];
  advanced?: boolean;
  unit?: string;
  optionLabels?: Record<string, string>;
  adminSection?: string;
}

/** A minimal JSON Schema fragment (Draft-07 subset Ajv understands). */
export type JsonSchema = Record<string, unknown>;

/** One declarable item. `key` is dotted; for `config`/`secret` it maps to a client
 *  config field via `accessor`, for `flag` the value lives in the entitlements map. */
export interface ConfigEntry {
  key: string;
  kind: ConfigKind;
  category: string;
  label: string;
  description: string;
  schema: JsonSchema;
  examples?: unknown[];
  default?: unknown;
  secret?: boolean;
  /** How a SECRET reaches a runtime (default `clientScoped`). `serverOnly` values are
   *  consumed by the worker and never signed into a device document; `edgeMint` marks the
   *  Config-service capability that mints short-lived third-party tokens (D-19). */
  delivery?: SecretDelivery;
  /** State a freshly-minted key gets if the admin doesn't override it. CONFIG only. */
  managementDefault?: ManagementState;
  /** A `flag` surfaced to the user as an included capability ("Included with your license"). */
  userGrant?: boolean;
  grantLabel?: string;
  ui?: UiHints;
  dependsOn?: { key: string; equals: unknown };
  appliesTo?: ("cli" | "app")[];
  /** Dotted path into the client's config object for config/secret kinds. */
  accessor?: string;
  deprecated?: boolean;
  since?: string;
  /** Makes a CONFIG key a **user setting** (S-17 §5.3, plans/U-01.md §3): its chosen value is
   *  persisted on the device by the Config SDK and, for a signed-in device with Cloud Sync on,
   *  synced. The operator can still enforce it (`managementDefault` stays the operator's). */
  user?: UserSettingPolicy;
}

/** Where a user setting's value roams (S-17 §5.3). `user` roams everywhere; `platform` within a
 *  platform family (`desktop`, `mobile`, `console`, `web`); `device` is stored per device and
 *  never roams; `local` never leaves the device. */
export type UserSettingSync = "user" | "platform" | "device" | "local";

/** How concurrent writes to one user setting resolve. `max` and `min` need a number schema;
 *  `merge` an object schema, merged one top-level member at a time. Never `union`. */
export type UserSettingConflict = "lastWrite" | "max" | "min" | "merge";

/** A config entry's `user` block. */
export interface UserSettingPolicy {
  sync: UserSettingSync;
  /** Default `lastWrite`. */
  conflict?: UserSettingConflict;
  /** Shown in `listUserConfig` and the UI kits' settings panels. Default `true`. */
  listed?: boolean;
}

/** A complete product catalog, as served at `/<product>/schema`. */
export interface ProductCatalog {
  /** Matches the signed doc's `schemaVersion`; bumped on incompatible shape changes. */
  schemaVersion: number;
  entries: ConfigEntry[];
  /** The DATA SHAPE of the product's Cloud Sync data: collections, saves and the catalog
   *  migrations the server applies to synced values (plans/U-01.md §3). Limits and access policy
   *  are settings in `.pkey/product`'s `cloudSync` block, never here. */
  cloudSync?: CatalogCloudSync;
}

/** Who may write a collection's records. `owner`: the signed-in person's devices; `ownerRead`:
 *  devices read, the console or the developer backend writes; `server`: never delivered to
 *  devices. (`public` is reserved for U-17.) */
export type CloudSyncAccess = "owner" | "ownerRead" | "server";

/** How concurrent writes to one record resolve. `union` needs an array schema with
 *  `uniqueItems`; `merge` merges top-level fields. Default `revision` (compare-and-swap). */
export type CollectionConflict = "revision" | "lastWrite" | "merge" | "union";

/** What happens to a device's local records at its first sign-in. Default `prompt`. */
export type CollectionOnAttach = "keepCloud" | "keepLocal" | "merge" | "prompt";

/** How two divergent saves of one slot resolve, in the SDK, on metadata. Default `prompt`. */
export type SaveConflictPolicy =
  | "prompt"
  | "mostRecent"
  | "longestPlaytime"
  | "highestProgress";

/** One declared collection (or a `prefix.*` pattern of them). */
export interface CloudSyncCollection {
  /** Key charset `[A-Za-z0-9._:-]`, at most 128 bytes; a trailing `.*` makes it a pattern. */
  name: string;
  access: CloudSyncAccess;
  conflict?: CollectionConflict;
  /** A Draft-07-subset schema every record value must satisfy. */
  schema?: JsonSchema;
  onAttach?: CollectionOnAttach;
}

/** The save-slot data shape (slot counts and sizes are limits, in `.pkey/product`). */
export interface CloudSyncSaves {
  conflict?: SaveConflictPolicy;
  /** A catalog `flag` the person's effective entitlements must grant for saves to be written. */
  requiresFlag?: string;
  metadata?: {
    schema?: JsonSchema;
    playtimeField?: string;
    progressField?: string;
  };
  thumbnail?: { maxBytes?: number };
  format?: { refuseNewer?: boolean };
}

/** A catalog migration the server applies to synced values when the catalog reaches
 *  `toSchemaVersion`: keys renamed (`old → new`), string values remapped per key, keys dropped. */
export interface CloudSyncMigration {
  toSchemaVersion: number;
  rename?: Record<string, string>;
  /** Per (new) key, a map from an old string value to its replacement. */
  mapValues?: Record<string, Record<string, unknown>>;
  drop?: string[];
}

/** A catalog's `cloudSync` block. */
export interface CatalogCloudSync {
  collections?: CloudSyncCollection[];
  /** `true`: undeclared collection names are allowed at default limits. Default `false`. */
  open?: boolean;
  saves?: CloudSyncSaves;
  migrations?: CloudSyncMigration[];
}
