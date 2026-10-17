// The context the Provider publishes: its live adapter. Presentation is intentionally owned by
// the kit theme boundary, so a transport provider has no styling side effects.

import { createContext } from "react";
import type { PolarisAdapter } from "../core/index.js";
import type { BackendOptions } from "../core/backend.js";

export interface PolarisContextValue {
  adapter: PolarisAdapter;
  /** `config.backend`: the origins `usePolarisFetch()` may send the licence to. */
  backend?: BackendOptions;
}

/** Null until a `<PolarisKeyProvider>` mounts — hooks throw a clear error otherwise. */
export const PolarisContext = createContext<PolarisContextValue | null>(null);
