// The context the Provider publishes: its live adapter. Presentation is intentionally owned by
// the kit theme boundary, so a transport provider has no styling side effects.

import { createContext } from "react";
import type { PolarisAdapter } from "../core/index.js";
import type { BackendOptions } from "../core/backend.js";

export interface PolarisContextValue {
  adapter: PolarisAdapter;
  /** `config.backend`: the origins `usePolarisFetch()` may send the licence to. */
  backend?: BackendOptions;
  /** The host app's version (`config.version`): the kit's About and update prompt name it. */
  version?: string;
  /** The control-plane origin (`config.baseUrl`): the only API origin the kit hands a held license
   *  key to (UK-42). Absent: the default origin. */
  baseUrl?: string;
  /** The product slug (`config.productSlug`): the kit's diagnostics name it. */
  productSlug?: string;
  /** False when the Provider's `autoSignIn={false}`: the gate does not try automatic sign-in. */
  autoSignIn?: false;
}

/** Null until a `<PolarisKeyProvider>` mounts — hooks throw a clear error otherwise. */
export const PolarisContext = createContext<PolarisContextValue | null>(null);
