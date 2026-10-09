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
