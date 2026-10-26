// The declarative config catalog types. A product's catalog is authored as data
// (JSON), versioned, stored in D1, and served at `/<product>/schema`. The admin SPA and
// every SDK read it at runtime; optional codegen (tools/gen-mirrors.ts) emits typed
// mirrors. This is the generalized shape of djdl's `src/core/configSchema.ts` — no
// product-specific keys live in code anymore.

import type { SecretDelivery } from "@polaris-key/protocol/config";

/** The console's types over the stored kind: `config` is a Setting, `secret` a Secret, and
 *  `secret` with `delivery: "edgeMint"` a Minted token. `flag` is an entitlement (Licensing's). */
export type ConfigKind = "config" | "secret" | "flag";

/** Per-key MDM-style management state — applies to `config` keys only. The console says
 *  "In the app": `default` is Editable (people can change it), `enforced` is Read-only (server
 *  wins, listed), `hidden` is Hidden (enforced + withheld from user-facing enumeration). */
export type ManagementState = "default" | "enforced" | "hidden";

/** rjsf/SwiftUI rendering hints — never affect validation, only presentation. */
export interface UiHints {
  widget?: "password" | "select" | "textarea" | "switch" | "stepper";
  help?: string;
  placeholder?: string;
  order?: number;
  /** Admin scopes where the value is meaningful (omitted ⇒ all). `user` is a hint only: where a
   *  synced setting roams is `ConfigEntry.user.sync` (plans/U-01b.md D2). */
  scopes?: ("profile" | "license" | "device" | "user")[];
  advanced?: boolean;
  unit?: string;
  optionLabels?: Record<string, string>;
  adminSection?: string;
}

/** A minimal JSON Schema fragment the catalog's Draft-07 subset interpreter supports. */
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
  /** Retired: `kind: "secret"` says it. Redundant on a secret entry (dropped at ingest); on a
   *  `config` entry it still seals the value, and the validator warns to use `kind: "secret"`. */
  secret?: boolean;
  /** How a SECRET reaches a runtime (default `clientScoped`). `serverOnly` is retired (the
   *  validator warns: a Worker-only secret belongs in the product's secrets); it is never signed
   *  into a device document. `edgeMint` marks the
   *  Config-service capability that mints short-lived third-party tokens (D-19). */
  delivery?: SecretDelivery;
  /**
   * A Minted token's recipe (`kind: "secret"`, `delivery: "edgeMint"`; U-31). The entry's key is
   * the recipe id. Authoring only: the manifest and the console's publish lift it out into the
   * product's recipes, which an operator approves, so the served catalog never carries it. The
   * console reads it back from the recipes, and an entry published without one leaves the
   * product's recipe as it is.
   */
  mint?: MintBlock;
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
  /** Tunes a **synced setting** (plans/U-01b.md D2). Every Editable `config` key (no
   *  `managementDefault` of `enforced` or `hidden`) is a synced setting whether or not it has this
   *  block; the block only changes where the value roams, how concurrent edits resolve and whether
   *  a settings panel lists it. The operator can still lock the key (`managementDefault` stays the
   *  operator's), and a block on a locked key is a no-op. */
  user?: UserSettingPolicy;
}

/** A Minted token's recipe: what the Worker signs when the app calls `mintToken(key)`. */
export interface MintBlock {
  /** `ES256`, `RS256` or `EdDSA`. */
  alg: string;
  /** The product secret holding the signing key: a stable uppercase name. */
  signingKeySecret: string;
  kid?: string;
  claimsTemplate?: Record<string, unknown>;
  /** Seconds, at most one hour; omitted means one hour. */
  ttlSeconds?: number;
  audience?: string | null;
  /** Who may mint: `none`, `registered` or `licensed` (omitted means `licensed`). */
  requires?: "none" | "registered" | "licensed";
  /** A catalog flag the caller's payload must carry, truthy. */
  requiredEntitlement?: string | null;
}

/** Where a synced setting's value roams. `user` roams to every device of the person; `platform`
 *  within a platform family (`desktop`, `mobile`, `console`, `web`); `local` never leaves the
 *  device. (`device` is retired: a reinstall gets a new device id, so a per-device scope cannot
 *  survive it. Use `local`.) */
export type UserSettingSync = "user" | "platform" | "local";

/** How concurrent writes to one synced setting resolve. `max` and `min` need a number schema;
 *  `merge` an object schema, merged one top-level member at a time. Never `union` or
 *  `revision`, which are record policies. */
export type UserSettingConflict = "lastWrite" | "max" | "min" | "merge";

/** A config entry's `user` block. Every member is optional; an absent block means
 *  `{sync: "user", conflict: "lastWrite", listed: true}`. */
export interface UserSettingPolicy {
  /** Default `user`. */
  sync?: UserSettingSync;
  /** Default `lastWrite`. */
  conflict?: UserSettingConflict;
  /** Shown in the UI kits' settings panels. Default `true`. */
  listed?: boolean;
}

/** A complete product catalog, as served at `/<product>/schema`. */
export interface ProductCatalog {
  /** Matches the signed doc's `schemaVersion`; bumped on incompatible shape changes. */
  schemaVersion: number;
  entries: ConfigEntry[];
  /** The DATA SHAPE of the product's Cloud Sync records: its collections and the catalog
   *  migrations the server applies to synced values (plans/U-01b.md §3.1). The quota is the
   *  `pkey.cloudSync.bytes` entitlement, never a catalog or manifest member. */
  cloudSync?: CatalogCloudSync;
}

/** Who may read and write a collection's records. `owner`: the signed-in person's devices. Only
 *  `owner` exists in v1 (D7); `ownerRead`, `server` and `public` are deferred (U-16, U-17). */
export type CloudSyncAccess = "owner";

/** The one conflict vocabulary of both stores (plans/U-01b.md §2.2). Settings take `lastWrite`,
 *  `max`, `min` and `merge`; records take all six. The server applies every policy. */
export type SyncConflict =
  | "lastWrite"
  | "max"
  | "min"
  | "merge"
  | "union"
  | "revision";

/** A record template: `saves` (save slots, each record may carry one file) and `session`. */
export type CloudSyncTemplate = "saves" | "session";

/** One declared collection (or a `prefix.*` pattern of them). A template supplies every member
 *  the declaration leaves out; a `saves` collection's `maxRecords` is pinned to the template's. */
export interface CloudSyncCollection {
  /** Key charset `[A-Za-z0-9._:-]`, at most 128 bytes; a trailing `.*` makes it a pattern. */
  name: string;
  /** Shown in the console and the portal. Default: the template's label, else the name. */
  label?: string;
  template?: CloudSyncTemplate;
  /** Default `owner`, the only value. */
  access?: CloudSyncAccess;
  /** Default `revision` (compare-and-swap), or the template's. */
  conflict?: SyncConflict;
  /** For `max` and `min` only: the number property the server compares. */
  conflictField?: string;
  /** A Draft-07-subset schema every record value must satisfy. */
  schema?: JsonSchema;
  /** The most records one person may keep here (at most 10,000). Not allowed on a `saves`
   *  collection, whose slots are a platform constant. */
  maxRecords?: number;
  /** The one file a record may carry. `delta` sends only the changed chunks of a new version
   *  (default `true` for a `saves` collection, `false` otherwise). */
  files?: { maxBytes?: number; keepRevisions?: number; delta?: boolean };
  /** An entitlement the anchor licence must grant before a record is written. */
  requires?: string;
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

/** How a product's synced data is stored: `e2e` (the default; the server holds ciphertext only)
 *  or `server` (readable by the server, a per-product opt-out; V5 §13.10). */
export type CloudSyncEncryption = "e2e" | "server";

/** A catalog's `cloudSync` block. */
export interface CatalogCloudSync {
  /** Default `e2e`. `server` lets the server read synced values, so `mapValues` migrations
   *  work. */
  encryption?: CloudSyncEncryption;
  collections?: CloudSyncCollection[];
  migrations?: CloudSyncMigration[];
}
