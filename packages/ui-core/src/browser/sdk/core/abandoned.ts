// What a Cloud Sync host does when the machine abandoned a request that was on the wire.

/** What `CloudSyncMachine.receive` throws when no request is in flight (client-core). */
const NO_REQUEST_IN_FLIGHT = "respond: no request is in flight";

/**
 * `.catch` handler for one exchange. A request the machine abandoned while it was away
 * (`accountRequired()` from a key-ring or file route, a sign-out) has no one to take its answer:
 * the answer is dropped, and nothing it carried reaches the journal. Any other failure is thrown on.
 */
export function dropAbandoned(e: unknown): void {
  if (e instanceof Error && e.message === NO_REQUEST_IN_FLIGHT) return;
  throw e;
}
