/**
 * The stable `reason`s the release policy routes refuse with (worker `release/policy.ts`), as
 * the console words them. One table, as `SERVICE_ERROR_MESSAGES` is for services (re-exported by `api.ts`; kept apart so a test that mocks `api.js` still gets the copy); a reason not
 * listed here falls back to the server's own message.
 */
export const RELEASE_POLICY_ERROR_MESSAGES: Record<string, string> = {
  unknown_channel: "This product cannot serve that channel.",
  unknown_deliverable: "That deliverable no longer exists.",
  unknown_release: "That release is not in the store any more — reload.",
  bad_release: "Choose a release.",
  release_yanked:
    "A yanked release cannot be promoted. Unyank it, or pin it explicitly.",
  pin_without_pointer: "A pinned channel needs a release to point at.",
  bad_min_supported:
    "The minimum supported version must be a version in the deliverable's scheme.",
  bad_reason: "A yank needs a reason (500 characters at most).",
  not_yanked: "This release is not yanked.",
  no_policy:
    "This channel has no operator policy to hand back — it already follows the manifest.",
  empty_update: "Nothing to change.",
  unknown_field: "The server refused a field it does not know.",
};
