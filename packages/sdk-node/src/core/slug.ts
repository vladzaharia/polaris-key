import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";

/** The product slug shape (mirrors `PRODUCT_SLUG_PATTERN` in `@polaris-key/manifest`): it is
 *  joined into URLs and into the state directory, so a `/`, `..` or `?` must never get there. */
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertProductSlug(slug: string): void {
  if (typeof slug !== "string" || !PRODUCT_SLUG_PATTERN.test(slug)) {
    throw new PolarisError(
      ErrorCode.badRequest,
      "productSlug must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit.",
    );
  }
}

/** The host production runs on; its state keeps the bare product name. */
export const DEFAULT_STORE_HOST = "key.plrs.im";

/**
 * The name a product's local state (directories, keyring entry) goes under: the slug for the
 * default host (production names are unchanged), `<slug>@<host>` for any other base URL, so a
 * `pkey dev` run never reads or overwrites production state on the same machine.
 */
export function storeNamespace(
  slug: string,
  baseUrl: string | undefined,
): string {
  if (!baseUrl) return slug;
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return slug;
  }
  if (host === DEFAULT_STORE_HOST) return slug;
  return `${slug}@${host.replace(/[^a-z0-9.-]/g, "_")}`;
}
