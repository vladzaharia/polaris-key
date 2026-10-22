/**
 * Platform → Activity's own filter lists (ST-51-fix B4). The product Activity's lists name product
 * areas; the platform trail writes other actions and targets. Each entry below is a prefix the
 * Worker writes to `platform_audit`: `console/handlers/{apiTokens,accountTokens,
 * platformStoreConnections,overrideMigration,products}.ts`, `console/auth.ts`,
 * `core/settings/write.ts` (`platform.setting.*`), `core/notify/alertDestinations.ts`.
 */

import { ACTION_GROUPS, TARGET_KINDS } from "../../core/model/activityVerbs.js";

type Option = { value: string; label: string };

/** The action prefixes of the platform trail. The Worker matches an action by prefix. */
export const PLATFORM_ACTION_GROUPS: Option[] = [
  { value: "platform.setting.", label: "Platform settings" },
  { value: "kek.", label: "Key encryption" },
  { value: "api_token.", label: "API tokens" },
  { value: "account_token.", label: "Personal tokens" },
  { value: "admin.signin", label: "Console sign-ins" },
  { value: "store_connection.", label: "Store connections" },
  { value: "platform_credential.", label: "Channel credentials" },
  { value: "platform_store_setting.", label: "Store settings" },
  { value: "trust_policy.", label: "Trust policy" },
  { value: "notify.destination.", label: "Alert destinations" },
  { value: "overrideMigration.", label: "Override migration" },
  { value: "feed.", label: "Package feeds" },
];

/** The target kinds of the platform trail (the audit's own `target_kind` values). */
export const PLATFORM_TARGET_KINDS: Option[] = [
  { value: "setting", label: "Setting" },
  { value: "kek", label: "Encryption key" },
  { value: "api_token", label: "API token" },
  { value: "account_token", label: "Personal token" },
  { value: "platform_credential", label: "Channel credential" },
  { value: "platform_store_setting", label: "Store setting" },
  { value: "store_app", label: "Store app" },
  { value: "notify-destination", label: "Alert destination" },
  { value: "feed", label: "Package feed" },
];

const union = (a: Option[], b: Option[]): Option[] => [
  ...a,
  ...b.filter((o) => !a.some((x) => x.value === o.value)),
];

/**
 * The lists for the Product facet's choice: the platform's own by default, a product's when one
 * is chosen, both for Any product.
 */
export function filterListsFor(product: string): {
  actions: Option[];
  kinds: Option[];
} {
  if (!product || product === "platform")
    return { actions: PLATFORM_ACTION_GROUPS, kinds: PLATFORM_TARGET_KINDS };
  if (product === "all")
    return {
      actions: union(PLATFORM_ACTION_GROUPS, ACTION_GROUPS),
      kinds: union(PLATFORM_TARGET_KINDS, TARGET_KINDS),
    };
  return { actions: ACTION_GROUPS, kinds: TARGET_KINDS };
}
