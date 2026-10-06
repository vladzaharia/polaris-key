/// <reference types="@cloudflare/workers-types" />

// The account realm's cookies (I-07; S-16 §5.4 item 7, "Sessions"): the Polaris Key account
// session and the short-lived login-card cookies that bind a sign-in to the browser that started
// it (the email flow, the email gate and, since I-16, the passkey challenge). All are host-only on
// key.plrs.im (`__Host-`, `Path=/`, no `Domain`), `HttpOnly`, `Secure` and `SameSite=Lax`.
//
// A host-only `Path=/` cookie is sent by the browser to EVERY path on the host, product routes
// included; the browser cannot be told otherwise without scoping the portal under a path. So the
// rule "never readable or settable by product routes" is enforced where the request enters a
// product: the dispatcher hands every product route a request with these cookies removed
// (`withoutAccountCookies`), and drops any `Set-Cookie` for them from the product's response
// (`withoutAccountSetCookies`). A product route therefore cannot read the account session even
// by accident, and a bug in one cannot plant or clear it.

/** The Polaris Key account session (portal and login card). */
export const ACCOUNT_SESSION_COOKIE = "__Host-pkey_portal";
/** The login card's pending email sign-in, bound to the browser that started it. */
export const SIGNIN_FLOW_COOKIE = "__Host-pkey_signin";
/** The first-provider-sign-in email gate (the interstitial), bound to its browser. */
export const EMAIL_GATE_COOKIE = "__Host-pkey_gate";
/** The login card's pending passkey sign-in (I-16): names the WebAuthn challenge this browser
 *  was given, so the assertion completes only here, once. Same attributes as the other two. */
export const PASSKEY_FLOW_COOKIE = "__Host-pkey_passkey";

/** Every cookie of the account realm. */
export const ACCOUNT_REALM_COOKIES: readonly string[] = [
  ACCOUNT_SESSION_COOKIE,
  SIGNIN_FLOW_COOKIE,
  EMAIL_GATE_COOKIE,
  PASSKEY_FLOW_COOKIE,
];

function isAccountCookie(name: string): boolean {
  return ACCOUNT_REALM_COOKIES.includes(name.trim());
}

/** `cookie` with every account-realm cookie removed; `null` when nothing is left. */
export function stripAccountCookies(cookie: string | null): string | null {
  if (!cookie) return cookie;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !isAccountCookie(part.split("=")[0]!));
  return kept.length > 0 ? kept.join("; ") : null;
}

/** The request a product route sees: the same request without the account realm's cookies. */
export function withoutAccountCookies(req: Request): Request {
  const cookie = req.headers.get("cookie");
  if (!cookie) return req;
  const stripped = stripAccountCookies(cookie);
  if (stripped === cookie) return req;
  const headers = new Headers(req.headers);
  if (stripped === null) headers.delete("cookie");
  else headers.set("cookie", stripped);
  return new Request(req, { headers });
}

/** A product route's response with any `Set-Cookie` for an account-realm cookie dropped. */
export function withoutAccountSetCookies(res: Response): Response {
  const getAll = (res.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies =
    typeof getAll === "function"
      ? getAll.call(res.headers)
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")!]
        : [];
  const dropped = cookies.filter((c) => isAccountCookie(c.split("=")[0]!));
  if (dropped.length === 0) return res;
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  for (const c of cookies) {
    if (!isAccountCookie(c.split("=")[0]!)) headers.append("set-cookie", c);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** One cookie's value from a `Cookie` header; `null` when absent or present more than once
 *  (a duplicate can be a planted copy, so it fails closed, as the session cookies do: R1-08). */
export function readCookie(cookie: string | null, name: string): string | null {
  if (!cookie) return null;
  const values = new Set<string>();
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) values.add(rest.join("="));
  }
  if (values.size !== 1) return null;
  const value = values.values().next().value ?? "";
  return value === "" ? null : value;
}

/** A host-only account-realm cookie. */
export function accountRealmCookie(
  name: string,
  value: string,
  maxAgeSec: number,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ].join("; ");
}

/** The cookie that clears `name`. */
export function clearAccountRealmCookie(name: string): string {
  return accountRealmCookie(name, "", 0);
}
