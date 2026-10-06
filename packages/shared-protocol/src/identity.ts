// @polaris-key/protocol/identity — Identity on the wire. Types and constants only, no runtime,
// no crypto. Created by PX-W17 (plans/PX-W17.md §2); I-09 adds the account contract here
// (the pairwise-subject pattern, the claim refusals).
//
// Identity is a per-product service: one Polaris Key account per person, platform-wide, and a
// product's `identity` toggle gates only sign-in THROUGH that product. With it off, device and
// JSON routes under `/<p>/identity/*` answer `not_found` and `POST /<p>/devices/register`
// keeps its single `registration_closed` body; only a person sees `identity_disabled`
// (WIRE-CONTRACT-V4 §12.7).

/**
 * The `error` query value of the friendly sign-in card, and the code of the portal passthrough
 * context's `403`: a browser navigation to an app-sign-in entry of an Identity-off product is
 * answered `303 Location: <origin>/signin?product=<slug>&error=identity_disabled`.
 */
export const IDENTITY_DISABLED_ERROR_PARAM = "identity_disabled";
