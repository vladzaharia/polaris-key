// The `unsupported` a hook reports when Cloud Sync cannot run: the typed N/A as the hooks hold it.

import type { Unsupported } from "@polaris-key/client-core";
import { UnsupportedError } from "../core/caps.js";

/** The N/A a thrown `UnsupportedError` carries; any other error is rethrown. */
export function unsupportedOf(e: unknown): Unsupported {
  if (!(e instanceof UnsupportedError)) throw e;
  return {
    supported: false,
    feature: e.feature,
    reason: e.reason,
    detail: e.detail,
  };
}
