// The catalog fetch for the browser transport: `GET /<product>/config/schema` (P1b-07, PARITY
// §5.3 `config.schema`), pinned by the config-schema-fetch transcript.
//
// Unsigned, unauthenticated and DIAGNOSTIC — nothing security-relevant is ever read from it (the
// values a client acts on arrive in the signed config document) — so every failure is `null`:
// a refusal, a dropped connection, a body that is not a catalog. It never throws.

import type { ProductCatalog } from "@polaris-key/catalog";

export interface CatalogRequestOptions {
  baseUrl: string;
  product: string;
  fetchImpl: typeof fetch;
  /** Extra request headers (the adapter's `X-PKey-*` metadata). */
  headers?: Record<string, string>;
}

/** The catalog's outer shape. The entries are the product's own data; the client does not
 *  validate them, because nothing it decides depends on them. */
export function isCatalog(v: unknown): v is ProductCatalog {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return typeof c.schemaVersion === "number" && Array.isArray(c.entries);
}

/** `GET /<product>/config/schema`, or `null` on any failure. */
export async function fetchCatalog(
  opts: CatalogRequestOptions,
): Promise<ProductCatalog | null> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(opts.product)}/config/schema`;
  try {
    const res = await opts.fetchImpl(url, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json", ...(opts.headers ?? {}) },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isCatalog(body) ? body : null;
  } catch {
    return null;
  }
}
