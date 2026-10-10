// Copy for the elements (UI-KITS.md §4.7, DL8): every visible string is a key of brand's
// generated kit-copy tables (kit strings plus core copy under `core.*`), formatted by ui-core's
// ICU-subset formatter. English is bundled; another launch locale loads once, on demand, and every
// element showing it re-renders when it arrives. Platform variants (macOS title case) come from
// `KIT_COPY_VARIANTS` when the theme's platform asks for them.

import {
  KIT_COPY_EN,
  KIT_COPY_VARIANTS,
  loadKitCopy,
  type KitCopyLocale,
  type KitCopyTable,
} from "@polaris-key/brand/kit-copy";
import { Copy, resolveLocale, type CopyTable } from "@polaris-key/ui-core";

const tables: Partial<Record<string, CopyTable>> & { en: CopyTable } = {
  en: KIT_COPY_EN,
};
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Called when a locale's table arrives. */
export function onCopyLoaded(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Start loading `locale`'s table (no-op for English or a loaded one). */
export function ensureLocale(locale: string): void {
  const wanted = resolveLocale(locale);
  if (tables[wanted] || loading.has(wanted)) return;
  loading.set(
    wanted,
    loadKitCopy(wanted as KitCopyLocale)
      .then((t: KitCopyTable) => {
        tables[wanted] = t;
        for (const l of [...listeners]) l();
      })
      .catch(() => {
        // A pack that fails to load leaves English: copy never breaks a screen.
      }),
  );
}

/** Register a table directly (tests, or a host that preloads a pack). */
export function provideTable(locale: string, table: CopyTable): void {
  tables[resolveLocale(locale)] = table;
  for (const l of [...listeners]) l();
}

/** The platform's verb variants, as English overrides (`common.signOut` → "Sign Out" on macOS). */
function variantOverrides(platform: string | null): Record<string, string> {
  if (!platform) return {};
  const out: Record<string, string> = {};
  for (const [key, variants] of Object.entries(KIT_COPY_VARIANTS)) {
    const v = variants[platform];
    if (v) out[key] = v;
  }
  return out;
}

/** One locale's view of the catalog, with the theme's overrides. */
export function copyFor(
  locale: string,
  overrides: Partial<Record<string, Readonly<Record<string, string>>>> = {},
  platform: string | null = null,
): Copy {
  ensureLocale(locale);
  const variants = variantOverrides(platform);
  const merged = Object.keys(variants).length
    ? { ...overrides, en: { ...variants, ...(overrides.en ?? {}) } }
    : overrides;
  return new Copy({ tables, locale, overrides: merged });
}
