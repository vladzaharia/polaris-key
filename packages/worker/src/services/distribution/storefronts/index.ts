/**
 * The flow runtimes, one line per store that has one (A-18j; `runtime.ts`). A storefront adapter
 * without a line here still appears in the flow from its declaration alone.
 */

import {
  STOREFRONT_ADAPTERS,
  type StorefrontAdapter,
} from "../../../core/storefront/adapter.js";
import { APP_STORE_FLOW } from "./appStore.js";
import type { FlowRuntime, FlowStore } from "./runtime.js";

/** THE REGISTRY: one line per flow runtime. */
export const FLOW_RUNTIMES: readonly FlowRuntime[] = [APP_STORE_FLOW];

/** Every registered storefront, with its runtime when it has one. */
export function flowStores(
  adapters: readonly StorefrontAdapter[] = STOREFRONT_ADAPTERS,
  runtimes: readonly FlowRuntime[] = FLOW_RUNTIMES,
): FlowStore[] {
  return adapters.map((adapter) => ({
    adapter,
    runtime: runtimes.find((r) => r.id === adapter.id) ?? null,
  }));
}
