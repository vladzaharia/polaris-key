/**
 * The Commerce facet of a store (P0-27.4; CM-29 D3). Core declares the store
 * (`core/stores/<store>/adapter.ts`, its `commerce` member) and each service registers its own
 * facet by id; Distribution and Commerce never import each other (rule 6). A test binds the two.
 *
 * P0-27.5: the device claim, the binding listing, both hooks and the recheck tick reach a store
 * only through its facet (`commerceFacetFor(store)`, or `COMMERCE_FACETS[adapter]`).
 */

import type { ServiceContext } from "../../../core/registry.js";
import type { Store } from "../../../core/licensing/storeGrants.js";
import type { StorefrontId } from "../../../core/storefront/adapter.js";
import type { CommerceSettings } from "../settings.js";
import type { RecordOutcome, VerifiedPurchase } from "../state.js";

export type FacetServiceContext = Pick<ServiceContext, "env" | "db" | "now"> & {
  product: { slug: string };
};

/** A verified purchase, and what the store still owes once it is recorded (`settle`). */
export interface ClaimVerified {
  readonly purchase: VerifiedPurchase;
  /** After `recordPurchase` granted or recorded: a refusal reason, or null. Play acknowledges
   *  here (after the record, never before); Steam refuses a non-owner. */
  readonly settle?: (
    out: Extract<RecordOutcome, { ok: true }>,
  ) => Promise<string | null>;
}

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
  /** Is the store's settings block present (the binding listing shows only such stores)? */
  readonly enabled: (settings: CommerceSettings) => boolean;
  readonly claim: {
    readonly parse: (body: Record<string, unknown>) => ClaimParse<I>;
    /** A refusal reason decided BEFORE any store call (Steam's mapped-app oracle guard). */
    readonly guard?: (ctx: C, input: I) => Promise<string | null>;
    readonly verify: (
      ctx: C,
      input: I,
      binding: string,
    ) => Promise<ClaimVerified>;
    /** The refusal reason of the store's own rejection error, or null for any other error. */
    readonly rejection: (e: unknown) => string | null;
  };
  /** The store's push-notification verifiers. Absent for Steam. */
  readonly notification?: N;
  /** The store's periodic re-check primitives. */
  readonly recheck?: R;
}
