/**
 * FIRST-PARTY STOREFRONT HANDLERS (PS-01; notes/S-21 §6.1). An operation an adapter declares
 * `{mode: "first-party", handler}` runs here, against Polaris Key's own tables, never against a
 * vendor: there is no credential to mint, no write gate to pass and no HTTP request to send.
 *
 * Each handler is a thin dispatcher over `FirstPartyPorts`, the seam the owning packages fill:
 *
 *   - `readListing`, `writeListing`: the shared listing model and its `polaris-key` override
 *     (A-18b's tables; PS-06 wires the console);
 *   - `setListing`: the listing state and audience (`storefront.polarisKey.*`, PS-02);
 *   - `status`: listing state, readiness and the offers visible today (PS-03, PS-06);
 *   - `audit`: the one audit row of a write (`audit.ts`'s product trail).
 *
 * The rules every handler keeps, which the conformance suite's first-party branch checks with
 * `fetch` replaced by a thrower:
 *
 *   1. no handler reaches the network (it only calls its ports);
 *   2. a read (`writes: false`, every `READ_OPS` op among them) writes no audit row; a write
 *      writes exactly one, after the port succeeds;
 *   3. a typed op (`TYPED_OPS`: `submit`, which lists the product) refuses without the caller's
 *      `typedConfirmation`, exactly as the gate does for a vendor (owner rule; `confirm.ts`).
 *
 * Pure: it imports only the declaration layer (`test/boundaries.test.ts`), so it stays as
 * dependency-free as the declarations that name it.
 */

import type { StorefrontOp } from "./adapter.js";
import { StoreWriteDenied } from "./errors.js";

/** The listing parts a first-party write changes. */
export type FirstPartyListingPart = "text" | "assets" | "category";

/** One audit row of a first-party write (product scope: `distribution.polaris-key.<op>`). */
export interface FirstPartyAuditEntry {
  readonly op: StorefrontOp;
  readonly product: string;
  readonly target: { readonly kind: string; readonly id: string };
  readonly summary: string;
}

/** What a handler may touch. Every implementation lives in the service that owns the table. */
export interface FirstPartyPorts {
  readListing(product: string): Promise<unknown>;
  writeListing(
    product: string,
    part: FirstPartyListingPart,
    input: unknown,
  ): Promise<unknown>;
  setListing(product: string, input: unknown): Promise<unknown>;
  status(product: string): Promise<unknown>;
  audit(entry: FirstPartyAuditEntry): Promise<void>;
}

export interface FirstPartyContext {
  /** The product slug: on Polaris Key the product IS the app. */
  readonly product: string;
  readonly input?: unknown;
  /** Set by the route only after `typedConfirmationRefusal` passed (`confirm.ts`). */
  readonly typedConfirmation?: boolean;
  readonly ports: FirstPartyPorts;
}

/** One handler: whether it writes (and so audits once), and what it runs. */
export interface FirstPartyHandler {
  readonly writes: boolean;
  readonly run: (ctx: FirstPartyContext) => Promise<unknown>;
}

const read = (
  run: (ctx: FirstPartyContext) => Promise<unknown>,
): FirstPartyHandler => ({ writes: false, run });

/** The handler name an op of the first-party store declares. */
export const firstPartyHandlerName = (op: StorefrontOp): string =>
  `polaris-key.${op}`;

const write = (
  op: StorefrontOp,
  run: (ctx: FirstPartyContext) => Promise<unknown>,
  summary: string,
  opts: { typed?: boolean } = {},
): FirstPartyHandler => ({
  writes: true,
  run: async (ctx) => {
    if (opts.typed && ctx.typedConfirmation !== true)
      throw new StoreWriteDenied(
        "polaris-key",
        "LIST",
        ctx.product,
        "typed_confirmation_required",
      );
    const result = await run(ctx);
    await ctx.ports.audit({
      op,
      product: ctx.product,
      target: { kind: "product", id: ctx.product },
      summary,
    });
    return result;
  },
});

/**
 * THE HANDLERS, by name. `connect`, `listApps` and `identifiers` need no port: the storefront is
 * always connected and the product is its own app record.
 */
export const FIRST_PARTY_HANDLERS: Readonly<Record<string, FirstPartyHandler>> =
  {
    [firstPartyHandlerName("connect")]: read(async () => ({ connected: true })),
    [firstPartyHandlerName("listApps")]: read(async (ctx) => [
      { id: ctx.product, product: ctx.product },
    ]),
    // Nothing to register: the product slug is the identifier, so this only answers it.
    [firstPartyHandlerName("identifiers")]: read(async (ctx) => ({
      identifiers: [ctx.product],
    })),
    [firstPartyHandlerName("readListing")]: read((ctx) =>
      ctx.ports.readListing(ctx.product),
    ),
    [firstPartyHandlerName("writeListingText")]: write(
      "writeListingText",
      (ctx) => ctx.ports.writeListing(ctx.product, "text", ctx.input),
      "Updated the Polaris Key listing text",
    ),
    [firstPartyHandlerName("writeListingAssets")]: write(
      "writeListingAssets",
      (ctx) => ctx.ports.writeListing(ctx.product, "assets", ctx.input),
      "Updated the Polaris Key listing art",
    ),
    [firstPartyHandlerName("category")]: write(
      "category",
      (ctx) => ctx.ports.writeListing(ctx.product, "category", ctx.input),
      "Set the Polaris Key category",
    ),
    [firstPartyHandlerName("submit")]: write(
      "submit",
      (ctx) => ctx.ports.setListing(ctx.product, ctx.input),
      "Changed how the product is listed on Polaris Key",
      { typed: true },
    ),
    [firstPartyHandlerName("status")]: read((ctx) =>
      ctx.ports.status(ctx.product),
    ),
  };

/** A handler by name, or null. */
export function firstPartyHandler(name: string): FirstPartyHandler | null {
  return Object.hasOwn(FIRST_PARTY_HANDLERS, name)
    ? FIRST_PARTY_HANDLERS[name]!
    : null;
}
