// The link offer's kit-side pieces (identity.link, I-46.13): the offer as the form's outcome, and
// Help's address. Lazy with the form: the gate's boot path never loads it.

import type { AutoOutcome } from "../../signInModel.js";
import type { PolarisAdapter } from "./core/index.js";

/** Help: joining two accounts, what the link conflict step points to. */
export const JOIN_ACCOUNTS_URL = "https://key.plrs.im/docs/help/join-accounts/";

/** The link offer after a redirect sign-in (identity.link), in the form's outcome; `null` when
 *  there is none to make: no pending sign-in, no Google entry (the web asks Google only), or the
 *  person declined it for this account. Never throws. */
export async function linkOfferOutcome(
  a: PolarisAdapter,
): Promise<AutoOutcome | null> {
  const link = a.link;
  if (!link || !link.pending()) return null;
  try {
    const r = await link.offer();
    if (r.kind !== "ok") return null;
    const entry = r.offer.find((e) => e.kind === "google");
    if (!entry || (await link.declined())) return null;
    return {
      kind: "linkOffer",
      input: { ...(entry.reach ? { reach: entry.reach } : {}) },
    };
  } catch {
    return null;
  }
}
