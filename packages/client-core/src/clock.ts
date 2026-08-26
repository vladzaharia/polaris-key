// The monotonic clock floor — wire contract v3 §4.2.
//
//   highWaterMark = max(issuedAt of every currently-verified cached artifact)
//   effectiveNow  = max(systemClock, highWaterMark)
//
// The fold is over the WHOLE artifact set — license document, config document, and the trust
// manifest — not over any single one. A floor built from a document alone is provably inert:
// `doc.issuedAt < doc.graceUntil` always holds, so it can never reach the end of grace, and a
// clock wound back inside the document's own window still reads `ok`. The trust manifest is
// what makes the floor bite, which is why Core refreshes trust on its own schedule instead of
// riding a service's document fetch (§4.2). The corpus pins the defective form as
// `floor-config-doc-alone-does-not-stop-rollback` so it cannot silently return.
//
// Only RE-VERIFIED content may be folded in: a rejected artifact must contribute nothing, or
// planting a file would become a way to force every client to `expired`.

/** Anything the client has just re-verified and can therefore date. */
export interface DatedArtifact {
  issuedAt: number;
}

/**
 * Fold the verified artifact set into a single floor. Returns `0` for an empty set (a fresh
 * install has no signed clock yet, and `max(now, 0)` is just `now`).
 */
export function highWaterMark(artifacts: readonly DatedArtifact[]): number {
  let mark = 0;
  for (const a of artifacts) {
    if (a.issuedAt > mark) mark = a.issuedAt;
  }
  return mark;
}

/**
 * The time every gate comparison runs at. The floor is a MINIMUM, never a substitute: with an
 * honest clock ahead of every signed artifact this returns the system clock unchanged, so the
 * floor costs nothing when the clock is truthful.
 */
export function effectiveNow(systemNow: number, floor: number): number {
  return Math.max(systemNow, floor);
}
