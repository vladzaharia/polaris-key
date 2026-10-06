/**
 * The settings registry (ST-03, notes/S-18 §4.2): the platform slice, Core's product slice and
 * every service's slice, assembled once by the composition root.
 *
 * Core never names a service here. `buildSettingsRegistry` walks whatever descriptors it is
 * handed and takes each one's `settings` slice, the same way dispatch and the descriptor hooks
 * work (`core/registry.ts`, `core/hooks.ts`), so the boundaries test (AGENTS.md rule 6) holds.
 *
 * Lookups go through `get(keyOrAlias, scope)`: a key that is an alias (A-13's `LAZY_DELTAS`)
 * resolves to its entry (`deltas.lazy.mode`). The same key may be registered at platform and at
 * product scope (a platform default or bound and the product value it governs); aliases are
 * unique across the registry.
 *
 * Building never throws: `rules.ts`' `checkRegistry` is what refuses a bad entry, run by
 * `test/settings-registry.test.ts` over the real composition root.
 */

import type { ServiceSlug } from "../services.js";
import type {
  ServiceSettingsSlice,
  SettingDef,
  SettingScope,
} from "./types.js";
import { PLATFORM_SLICE } from "./platform.js";
import { CORE_SLICE } from "./core.js";

export { setting } from "./define.js";

/** What `buildSettingsRegistry` needs of a descriptor: its slug and optional slice. */
export interface SettingsContributor {
  slug: ServiceSlug;
  settings?: ServiceSettingsSlice;
}

/** One slice as assembled, with the owner it came from. */
export interface RegisteredSlice {
  owner: ServiceSlug | "core" | "platform";
  namespaces: readonly string[];
  entries: readonly SettingDef[];
}

export interface SettingsRegistry {
  /** Every entry, platform first, then Core, then services in the order given. */
  readonly entries: readonly SettingDef[];
  /** The slices as contributed (the rules test checks each against its owner). */
  readonly slices: readonly RegisteredSlice[];
  /**
   * The entry for `keyOrAlias` at `scope`, or `undefined`. Without `scope`, a key registered at
   * one scope only answers that entry; a key registered at both answers the product entry.
   */
  get(keyOrAlias: string, scope?: SettingScope): SettingDef | undefined;
  /** The canonical key an alias (or a key) names, or `undefined`. */
  canonicalKey(keyOrAlias: string): string | undefined;
}

/**
 * Assemble the registry from the descriptors given. `base` replaces the platform or Core slice;
 * only the rules test passes it, to prove a rule refuses a bad platform entry.
 */
export function buildSettingsRegistry(
  contributors: Iterable<SettingsContributor>,
  base: {
    platform?: readonly SettingDef[];
    core?: readonly SettingDef[];
  } = {},
): SettingsRegistry {
  const slices: RegisteredSlice[] = [
    {
      owner: "platform",
      namespaces: [],
      entries: base.platform ?? PLATFORM_SLICE,
    },
    {
      owner: "core",
      namespaces: ["core", "storefront"],
      entries: base.core ?? CORE_SLICE,
    },
  ];
  for (const c of contributors)
    if (c.settings)
      slices.push({
        owner: c.slug,
        namespaces: c.settings.namespaces,
        entries: c.settings.entries,
      });
  const entries = slices.flatMap((s) => s.entries);

  const byScope = new Map<SettingScope, Map<string, SettingDef>>();
  const aliasTo = new Map<string, string>();
  for (const e of entries) {
    let m = byScope.get(e.scope);
    if (!m) byScope.set(e.scope, (m = new Map()));
    if (!m.has(e.key)) m.set(e.key, e);
    for (const a of e.aliases ?? []) if (!aliasTo.has(a)) aliasTo.set(a, e.key);
  }

  const canonicalKey = (k: string): string | undefined => {
    if (entries.some((e) => e.key === k)) return k;
    return aliasTo.get(k);
  };

  return {
    entries,
    slices,
    canonicalKey,
    get(keyOrAlias, scope) {
      const key = canonicalKey(keyOrAlias);
      if (key === undefined) return undefined;
      if (scope) return byScope.get(scope)?.get(key);
      return (
        byScope.get("product")?.get(key) ??
        byScope.get("platform")?.get(key) ??
        byScope.get("entity")?.get(key)
      );
    },
  };
}
