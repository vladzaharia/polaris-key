/// <reference types="@cloudflare/workers-types" />
/**
 * SwiftPM's registry login (F-21, plans/F-20.md §6.3 and §6.4; `Registry.md` §4.1):
 * `swift package-registry login https://pkg.plrs.im/swift/<owner> --token <t>` posts here with
 * `Authorization: Bearer <t>` (or Basic, with `--username`/`--password`), and SwiftPM stores the
 * credential (keychain, or `~/.netrc` on Linux) only when this answers 200.
 *
 *   200  the token is a live registry token (or `pkeyci_`) of this owner, valid for Swift, and a
 *        licence-bound token's licence is usable; empty body, `Content-Version: 1`
 *   401  anything else: no credential, a malformed, unknown, expired or revoked one, another
 *        owner's, one narrowed away from Swift (problem+json with the Basic challenge)
 *   404  the owner's Swift feed does not answer at all (the host's not-found)
 *   429  the `registryLogin` budget (per IP, fail closed)
 *
 * It reads no package, so it is a credential route (`feedAuthRoute`), not a feed read. The feed's
 * access mode does not matter: a public feed's clients may log in too, and the token is then
 * simply never looked up on their reads.
 */

import { licenseUsable } from "../../../../core/devices.js";
import { clientIp, rateLimitOk } from "../../../../core/rateLimit.js";
import type { RegistryRoute } from "../../../../core/registryHost.js";
import {
  feedAnswering,
  feedRefusal,
  resolveFeedPrincipal,
} from "../authorize.js";
import { feedAuthRoute, feedReadContext, requestCredential } from "../serve.js";
import { SWIFT_API_VERSION } from "./protocol.js";

const LOGIN = /^\/swift\/([a-z0-9-]{1,64})\/login$/;

/** `registryLogin` (§6.6): per client IP, fail closed. */
const LOGIN_LIMIT = { limit: 30, windowSec: 60 };

export const SWIFT_LOGIN_ROUTE: RegistryRoute = feedAuthRoute({
  name: "swift.login",
  ecosystem: "swift",
  methods: ["POST"],
  match(pathname) {
    const m = LOGIN.exec(pathname);
    return m ? { owner: m[1]!, params: {} } : null;
  },
  async handle(req, ctx) {
    const owner = ctx.product.slug;
    const target = { env: ctx.env, ecosystem: "swift" as const, owner };
    if (
      !(await rateLimitOk(
        ctx.env,
        owner,
        { bucket: "registryLogin", id: clientIp(req), ...LOGIN_LIMIT },
        ctx.now,
      ))
    )
      return feedRefusal("rate-limited", target);
    const readCtx = feedReadContext(req, ctx);
    if ((await feedAnswering(readCtx, owner, "swift")) === null)
      return feedRefusal("not-found", target);
    const principal = await resolveFeedPrincipal(
      readCtx,
      requestCredential(req, ctx),
      owner,
      "swift",
    );
    if (principal === "rate-limited")
      return feedRefusal("rate-limited", target);
    const valid =
      principal.kind !== "anonymous" &&
      principal.product === owner &&
      (principal.kind === "ci" ||
        principal.ecosystems === null ||
        principal.ecosystems.includes("swift")) &&
      (principal.kind !== "license" ||
        licenseUsable(principal.license, ctx.now));
    if (!valid) return feedRefusal("basic", target);
    return new Response(null, {
      status: 200,
      headers: {
        "content-version": SWIFT_API_VERSION,
        "cache-control": "no-store",
      },
    });
  },
});
