/**
 * The adapter base every integration with an external ecosystem extends (notes/S-15 §6.1, owner
 * requirement 2026-10-04): one interface, one capability declaration, and the shared gate and
 * ledger an adapter cannot bypass. Two families use it:
 *
 *   - `FeedAdapter` (`services/distribution/registry/adapter.ts`): one per package ecosystem on
 *     the registry host. The gate is the access ladder (`feedRoute`), the ledger the render queue
 *     and its stamps;
 *   - `StorefrontAdapter` (`core/storefront/adapter.ts`, A-18a): one per store. The gate is the
 *     store-agnostic write gate (`core/storefront/gate.ts`), the ledger `store_operations`.
 *
 * Types only: no behaviour lives here, so Core and every service can share it (rule 6 allows
 * service → core). The shapes below are S-15's sketch; `test/storefront/conformance.test.ts` holds
 * every adapter of either family to them.
 */

/** Where an operation runs. */
export type Plane = "worker" | "ci" | "pr";

/** How an adapter performs one operation. The console renders this; it never hard-codes one. */
export type Support =
  /** Through the Worker, behind the family's gate: `rules` names what the gate allows (a feed's
   *  route names; a store's gate allow rules). */
  | {
      readonly mode: "api";
      readonly plane: "worker";
      readonly rules: readonly string[];
    }
  | {
      readonly mode: "ci";
      readonly plane: "ci";
      readonly tool: string;
      readonly commands: readonly string[];
    }
  | { readonly mode: "pr"; readonly plane: "pr"; readonly repo: string }
  | {
      readonly mode: "deep-link";
      readonly link: string;
      readonly verify:
        | {
            readonly read: string;
            readonly every: number;
            readonly until: number;
          }
        | "operator-assertion";
    }
  /**
   * Polaris Key performs it on its own tables (S-21 §6.1, PS-01): no credential, no gate, no vendor
   * call. `handler` names the first-party handler (`core/storefront/firstParty.ts`). Only an
   * adapter with no credential and no gate may declare it (the conformance suite's first-party
   * branch); the console renders it as "Built in".
   */
  | {
      readonly mode: "first-party";
      readonly plane: "worker";
      readonly handler: string;
    }
  /** The protocol has no such operation (F-01's `unsupported_by_ecosystem`). */
  | { readonly mode: "unsupported"; readonly reason: string };

/** How an adapter's upstream rate-limits it. */
export interface RateSpec {
  readonly kind: "header" | "per-minute" | "per-day" | "retry-after" | "none";
  readonly limit?: number;
  readonly stopOn403?: boolean;
}

/** What an adapter declares it can do: one `Support` per operation, its rate and its limits. */
export interface Capabilities<Op extends string> {
  readonly ops: Readonly<Record<Op, Support>>;
  readonly rate: RateSpec;
  readonly limits: Readonly<Record<string, number>>;
}

/** The vendor contract a gate is classified against (storefronts). */
export interface SpecPin {
  readonly title: string;
  readonly version: string;
  readonly sha256: string;
}

/** The base of every adapter. */
export interface Adapter<Id extends string, Op extends string> {
  readonly id: Id;
  readonly capabilities: Capabilities<Op>;
  readonly specPin?: SpecPin;
}

/** Does the adapter perform `op` at all (any mode but `unsupported`; `first-party` counts)? */
export function supports<Op extends string>(
  capabilities: Capabilities<Op>,
  op: Op,
): boolean {
  return capabilities.ops[op].mode !== "unsupported";
}
