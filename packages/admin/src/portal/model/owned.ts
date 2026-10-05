/**
 * Discover never shows what the library holds (G24). The Worker already leaves held products out
 * of `GET /api/discover` and out of `discoverCount`; this is the portal's own guard, for an answer
 * that crossed a licence change in flight (a key added in another tab, a store purchase landing)
 * or an older Worker: an offer whose product is in the library is dropped before it is shown.
 */
export function withoutHeld<T extends { product: string }>(
  offers: readonly T[],
  library: readonly { product: string }[] | undefined,
): T[] {
  if (!library || library.length === 0) return [...offers];
  const held = new Set(library.map((p) => p.product));
  return offers.filter((o) => !held.has(o.product));
}

/**
 * The Discover count the nav may show: a whole, non-negative number from the Worker, else `null`
 * (Discover stays out of the nav). `0` is a real answer: Discover stays in the nav with no count
 * pill and no phone-bar dot.
 */
export function discoverCountFrom(count: unknown): number | null {
  return typeof count === "number" && Number.isInteger(count) && count >= 0
    ? count
    : null;
}
