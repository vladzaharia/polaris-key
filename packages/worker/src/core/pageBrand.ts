/**
 * The Polaris Locker identity for the Worker's customer pages (LK-07; plans/LK-00.md §7.12, A3
 * §14.2). Ninety-odd call sites draw a branded page (`core/brandHtml.ts`) and none of them is
 * async, so none reads the `customer.host` switch. The dispatcher does, once, on the way out:
 * while the switch is on, a Key brand page answered to a customer-facing path is rewritten to the
 * page `renderBrandPage({ brand: "locker" })` draws (`lockerizeBrandPageHtml`; the equality is a
 * test), and its CSP names the Locker stylesheet's hash. Off, nothing here reads a byte.
 *
 * Not touched: the console and the docs (`/manage`, `/docs`), which are developer surfaces and
 * brand ungated (LK-14, LK-15), and any response that is not a Key brand page.
 */

import type { Db } from "../db/types.js";
import type { Env } from "../platform/env.js";
import { brandPageStyleSource, lockerizeBrandPageHtml } from "./brandHtml.js";
import { customerHostMode } from "./licensing/manageUrl.js";

const DEVELOPER_PREFIXES = ["/manage", "/docs"] as const;

function isDeveloperPath(pathname: string): boolean {
  return DEVELOPER_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** `res`, or its Polaris Locker form: see the header. */
export async function applyPageBrand(
  req: Request,
  res: Response,
  env: Env,
  db: Db,
): Promise<Response> {
  const keyStyle = brandPageStyleSource();
  const csp = res.headers.get("content-security-policy");
  if (
    csp === null ||
    !csp.includes(keyStyle) ||
    !(res.headers.get("content-type") ?? "").startsWith("text/html") ||
    isDeveloperPath(new URL(req.url).pathname)
  )
    return res;
  if ((await customerHostMode(env, db)) === "off") return res;
  const html = await res.text();
  const lockerHtml = lockerizeBrandPageHtml(html);
  const out = new Response(lockerHtml ?? html, res);
  if (lockerHtml !== null) {
    out.headers.set(
      "content-security-policy",
      csp.replace(keyStyle, brandPageStyleSource("locker")),
    );
    out.headers.delete("content-length");
  }
  return out;
}
