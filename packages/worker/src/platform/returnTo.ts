/**
 * The one check behind every sign-in flow's `returnTo`: where may the browser be sent after a
 * successful sign-in without this being an open redirect?
 *
 * ONE implementation (P0-15). The three copies it replaced agreed on the core rule (the target
 * must be same-origin with the request) but not on three details, and each detail is reachable
 * from a crafted link, so each caller names the policy it had instead of inheriting a merged
 * one. There is deliberately no default policy: a new flow has to choose.
 *
 * A leaf module: it imports nothing else in `src/`.
 */

export interface ReturnToPolicy {
  /** Resolve a relative value against the request URL; otherwise only an absolute URL is read. */
  readonly relative: boolean;
  /** Refuse any path under `/manage`: the console is never a customer's return target. */
  readonly refuseConsole: boolean;
  /** Answer path + query + fragment instead of the absolute URL. */
  readonly pathOnly: boolean;
}

/** Product OIDC sign-in (`services/identity/oidc.ts`): any absolute same-origin URL. */
export const PRODUCT_SIGNIN_RETURN_TO: ReturnToPolicy = {
  relative: false,
  refuseConsole: false,
  pathOnly: false,
};

/** Portal and hosted-provider sign-in: an absolute same-origin URL, never under `/manage`. */
export const PORTAL_SIGNIN_RETURN_TO: ReturnToPolicy = {
  relative: false,
  refuseConsole: true,
  pathOnly: false,
};

/** Sign-in card (email, passkey): absolute or relative, outside the console, as a path. */
export const CARD_RETURN_TO: ReturnToPolicy = {
  relative: true,
  refuseConsole: true,
  pathOnly: true,
};

/** A permitted return target for `raw` under `policy`, or `undefined` to fall back. */
export function safeReturnTo(
  req: Request,
  raw: unknown,
  policy: ReturnToPolicy,
): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const parsed = policy.relative ? new URL(raw, req.url) : new URL(raw);
    const here = new URL(req.url);
    if (parsed.origin !== here.origin) return undefined;
    if (policy.refuseConsole && parsed.pathname.startsWith("/manage"))
      return undefined;
    return policy.pathOnly
      ? parsed.pathname + parsed.search + parsed.hash
      : parsed.toString();
  } catch {
    return undefined;
  }
}
