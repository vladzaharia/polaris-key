/**
 * The platform inventory (ST-02, notes/S-18 §2.4, §4.13): every member of `Env` (`env.ts`), as
 * data. The list itself is GENERATED from the `@inventory` / `@editable` JSDoc tags in `env.ts`
 * into `platformInventory.generated.ts` by `pnpm gen platform-inventory`; this module holds its
 * types (it imports nothing, so the generator can run before the generated file exists).
 *
 * Readers: `GET /manage/api/platform/settings` (`console/handlers/platformSettings.ts`) builds its
 * deploy-time values and its secrets-presence list from here, so a name added to `Env` reaches
 * the console without a second hand-kept list. The settings registry (ST-03) and its generated
 * reference page and coverage test (ST-06) read it too.
 */

/** `binding`: a Cloudflare binding. `var`: a value the console may show. `secret`: credential
 *  material, reported as present or absent and never as a value. */
export type InventoryKind = "binding" | "var" | "secret";

export const INVENTORY_KINDS: readonly InventoryKind[] = [
  "binding",
  "var",
  "secret",
];

export type InventoryArea =
  | "deployment"
  | "identity"
  | "delivery"
  | "email"
  | "keyring"
  | "stores"
  | "jobs"
  | "licensing";

export const INVENTORY_AREAS: readonly InventoryArea[] = [
  "deployment",
  "identity",
  "delivery",
  "email",
  "keyring",
  "stores",
  "jobs",
  "licensing",
];

export interface PlatformInventoryEntry {
  /** The `Env` member name. */
  name: string;
  kind: InventoryKind;
  area: InventoryArea;
  /** `true` when the member is optional in `Env` (`NAME?:`). */
  optional: boolean;
  /** The `PLATFORM_SETTINGS` key a console value is stored under, or `null` (deploy-time only). */
  editable: string | null;
}
