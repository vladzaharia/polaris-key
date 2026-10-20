/// <reference types="@cloudflare/workers-types" />

// `GET /signin`: the address the Worker hands out for "sign in" (`license_owned`'s `signInUrl`,
// the licence-key email, the identity gate's card, the account-link step). The full login card
// lands with PX-12 and PX-14; until then this sends the browser to the sign-in the portal
// already has: the portal's SPA shows its sign-in page at any of its own paths while signed out
// (and the page itself once signed in), reading `product` from the query.
//
//   - `?product=<slug>`: kept, as the portal's product context (shape-checked, nothing looked up).
//   - `?return_to=<path>`: honoured only as a same-origin relative path the portal serves (`/`
//     or `/activate`, with query and fragment), checked by the card policy: no scheme, `//`,
//     backslash, control character, traversal or console path, plain or percent-encoded. Anything
//     else is dropped and the person lands on the portal root.
//   - `?error=identity_disabled`: the portal has no "sign-in is off for this product" screen, so
//     it lands on the portal root with the product context, like a plain sign-in.
//   - `?request=<handle>`: PX-14's address, which needs the card; a 404 until then.
//
// A 302 with no-store: nothing here is a credential, but the query can carry a return target.

import { CARD_RETURN_TO, safeReturnTo } from "../platform/returnTo.js";
import { notFound, methodNotAllowed } from "./errors.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PORTAL_PATHS = new Set(["/", "/activate"]);

export function handleSignInEntry(req: Request): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const q = new URL(req.url).searchParams;
  if (q.has("request")) return notFound();

  const raw = q.get("return_to");
  const safe = safeReturnTo(req, raw, CARD_RETURN_TO);
  let target = new URL("https://portal.invalid/");
  if (safe) {
    const t = new URL(safe, "https://portal.invalid");
    if (PORTAL_PATHS.has(t.pathname)) target = t;
  }
  const product = q.get("product");
  if (product && SLUG.test(product) && !target.searchParams.has("product"))
    target.searchParams.set("product", product);
  const location = target.pathname + target.search + target.hash;
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
