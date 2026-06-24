// The declarative config catalog types. A product's catalog is authored as data
// (JSON), versioned, stored in D1, and served at `/<product>/schema`. The admin SPA and
// every SDK read it at runtime; optional codegen (tools/gen-mirrors.ts) emits typed
// mirrors. This is the generalized shape of djdl's `src/core/configSchema.ts` — no
// product-specific keys live in code anymore.

export type ConfigKind = "config" | "secret" | "flag";

/** Per-key MDM-style management state — applies to `config` keys only. */
export type ManagementState = "unmanaged" | "managed" | "hidden";

/** rjsf/SwiftUI rendering hints — never affect validation, only presentation. */
export interface UiHints {
  widget?: "password" | "select" | "textarea" | "switch" | "stepper";
  help?: string;
  placeholder?: string;
  order?: number;
  /** Admin scopes where the value is meaningful (omitted ⇒ all). */
  scopes?: ("profile" | "license" | "device")[];
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
}

/** A complete product catalog, as served at `/<product>/schema`. */
export interface ProductCatalog {
  /** Matches the signed doc's `schemaVersion`; bumped on incompatible shape changes. */
  schemaVersion: number;
  entries: ConfigEntry[];
}
