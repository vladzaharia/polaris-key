// The link offer's surface on the adapter (identity.link): after a redirect sign-in, offer to add
// the platform identity to the account. Types only; the engine is `browser/bearer/link.ts`,
// loaded on first use.

/** One platform identity the account could add. `reach` is what the link would cover. */
export interface LinkOfferEntry {
  kind: "google" | "apple";
  reach: "global" | "developer" | null;
}

/** `link.offer()`: `unavailable` where the product, the page or the sign-in has no offer. */
export type LinkOfferResult =
  | { kind: "ok"; offer: readonly LinkOfferEntry[] }
  | { kind: "unavailable" };

/** `link.accept()`. `refused.code` is the Worker's: `step_up_required` (sign in again),
 *  `link_conflict` (the identity belongs to another account), `invalid_grant`, `not_found`. */
export type LinkAcceptResult =
  | {
      kind: "linked";
      linked: { kind: "google" | "apple"; reach: string | null };
    }
  | { kind: "refused"; status: number; code: string }
  | { kind: "unavailable" };

export interface LinkClient {
  /** True after a redirect sign-in (or a held link handle) until the person answers. */
  pending(): boolean;
  /** `GET link`: the kinds the account could add; `unavailable` where there is none to make,
   *  and after the person declined it for this account on this device. */
  offer(): Promise<LinkOfferResult>;
  /**
   * Link. With the handle the exchange left (no second provider prompt), else with a fresh
   * provider token for a fresh nonce (one prompt). The handle is spent either way.
   */
  accept(): Promise<LinkAcceptResult>;
  /** Remember `sha256(issuer ‖ sub)` on this device: the offer is not shown again for it. */
  decline(): Promise<void>;
  /** Not now: forget the offer for this tab without remembering a decline (Escape, Close). */
  dismiss(): void | Promise<void>;
}
