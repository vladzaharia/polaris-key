/**
 * The Commerce facet of a store (P0-27.4; CM-29 D3). Core declares the store
 * (`core/stores/<store>/adapter.ts`, its `commerce` member) and each service registers its own
 * facet by id; Distribution and Commerce never import each other (rule 6). A test binds the two.
 *
 * Declared only: `bridge.ts` and `recheck.ts` still dispatch on the wire store id; P0-27.5
 * switches them over to `COMMERCE_FACETS`.
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { Store } from "../../../core/licensing/storeGrants.js";
import type { StorefrontId } from "../../../core/storefront/adapter.js";
import type { CommerceSettings } from "../settings.js";
import type { VerifiedPurchase } from "../state.js";

export type FacetServiceContext = Pick<ServiceContext, "env" | "db" | "now"> & {
  product: { slug: string };
};

/** A claim body parsed for one store: the input to `verify`, or the `bad_body` message. */
export type ClaimParse<I> =
  | { ok: true; input: I }
  | { ok: false; message: string };

export interface CommerceFacet<
  C = unknown,
  I = unknown,
  N = unknown,
  R = unknown,
> {
  /** The wire store id of the device claim (`STORES`). Never changes. */
  readonly store: Store;
  /** The channel adapter id: the key of `COMMERCE_FACETS` (decision P10). */
  readonly adapter: StorefrontId;
  /** The store context a product is set up for, or null when it is not. */
  readonly context: (
    ctx: FacetServiceContext,
    settings: CommerceSettings,
  ) => Promise<C | null>;
  readonly claim: {
    readonly parse: (body: Record<string, unknown>) => ClaimParse<I>;
    readonly verify: (
      ctx: C,
      input: I,
      binding: string,
    ) => Promise<VerifiedPurchase>;
  };
  /** The store's push-notification verifiers. Absent for Steam. */
  readonly notification?: N;
  /** The store's periodic re-check primitives. */
  readonly recheck?: R;
}
