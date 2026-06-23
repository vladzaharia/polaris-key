// The context the Provider publishes: the live adapter plus the resolved theme. Hooks read
// from here. Kept in its own module (no JSX) so it can be imported without pulling the
// component tree.

import { createContext } from "react";
import type { PolarisAdapter } from "../core/index.js";
import type { PolarisTheme } from "../components/theme.js";

export interface PolarisContextValue {
  adapter: PolarisAdapter;
  theme: PolarisTheme;
}

/** Null until a `<PolarisKeyProvider>` mounts — hooks throw a clear error otherwise. */
export const PolarisContext = createContext<PolarisContextValue | null>(null);
