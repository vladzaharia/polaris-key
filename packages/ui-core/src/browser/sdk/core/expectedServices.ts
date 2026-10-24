// The adapters' `expectedServices` option (SP-35.17, L5): a list of slugs, the same shape as
// `config.expectedServices` and the Node client's option. The 0.8 name, `expectServices` (a
// ServicesMap), is refused rather than quietly read.

import { PolarisError } from "./types.js";
import {
  copyServices,
  defaultServices,
  servicesFromList,
  type ServiceSlug,
  type ServicesMap,
} from "./services.js";

/** The adapter's pre-discovery belief: the stated list, else licence + config; never all-true. */
export function expectedServicesOf(opts: {
  expectedServices?: readonly ServiceSlug[];
}): ServicesMap {
  if ("expectServices" in opts) {
    throw new PolarisError(
      "invalid-options",
      "expectServices was removed in 0.9; use expectedServices",
    );
  }
  return opts.expectedServices
    ? servicesFromList(opts.expectedServices)
    : copyServices(defaultServices());
}
