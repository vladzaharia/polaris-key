const DEFAULT_STORE_HOST = "key.plrs.im";

/**
 * A suffix for storage containers shared by products. Empty for the production host so existing
 * IndexedDB names remain exactly unchanged.
 */
export function storageNamespace(baseUrl?: string): string {
  if (!baseUrl) return "";
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    if (host === DEFAULT_STORE_HOST) return "";
    return `@${host.replace(/[^a-z0-9.-]/g, "_")}`;
  } catch {
    return "";
  }
}

/**
 * The durable-state name for one product. Production keeps its existing name; a local or
 * otherwise non-default control-plane host receives an unambiguous host suffix.
 */
export function storeNamespace(product: string, baseUrl?: string): string {
  const suffix = storageNamespace(baseUrl);
  return suffix === "" ? product : `${product}${suffix}`;
}

