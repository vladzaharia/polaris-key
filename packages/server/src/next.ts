// Next.js App Router drop-in (framework drop-ins plan §5.4), for route handlers. It is
// header-only in v1: the credential is `X-PKey-License`, never a cookie. It imports nothing from
// `next`, so it runs wherever a route handler is a `(Request) => Response`.
//
//   // lib/polaris.ts
//   export const polaris = createNextPolarisKey({ config: polarisConfig });
//   // app/api/export/route.ts
//   export const GET = polaris.requireEntitlement("export.pdf",
//     async (req, { license }) => Response.json({ tier: license.tier }));

import type { BackendRefusalCode } from "@polaris-key/client-core/backend";
import {
  createPolarisKey,
  PolarisKeyError,
  type PolarisKey,
  type PolarisKeyOptions,
  type Requirement,
} from "./core.js";
import type { PolarisAuth, PolarisLicense, Problem } from "./context.js";

export { POLARIS_REQUEST_HEADERS } from "@polaris-key/protocol/core";
export { PolarisKeyError } from "./core.js";
export type { PolarisAuth, Problem } from "./context.js";
export type { PolarisServerConfig } from "./core.js";

export interface NextPolarisKeyOptions extends PolarisKeyOptions {
  /** `"throw"` raises a `PolarisKeyError` (Next shows its error page) instead of answering. */
  errors?: "respond" | "throw";
  /** Answer a refusal yourself. */
  onRefusal?: (problem: Problem, req: Request) => Response | Promise<Response>;
}

/** The context a gated handler receives: the licence is present. */
export type GatedAuth = PolarisAuth & { license: PolarisLicense };

/** A gated route handler: Next passes `(request, routeContext)`; yours also gets the auth. */
export type GatedHandler<C = unknown> = (
  req: Request,
  auth: GatedAuth,
  routeContext: C,
) => Response | Promise<Response>;

export interface NextPolarisKey {
  /** The request's context; decide inside the handler. */
  auth(req: Request): Promise<PolarisAuth>;
  /** The refusal as a Response. */
  refuse(problem: Problem | BackendRefusalCode, req?: Request): Response;
  requireLicense<C = unknown>(
    handler: GatedHandler<C>,
  ): (req: Request, routeContext: C) => Promise<Response>;
  requireEntitlement<C = unknown>(
    name: string,
    handler: GatedHandler<C>,
    test?: (value: any) => boolean,
  ): (req: Request, routeContext: C) => Promise<Response>;
  requireSignIn<C = unknown>(
    handler: GatedHandler<C>,
  ): (req: Request, routeContext: C) => Promise<Response>;
}

export function createNextPolarisKey(
  options: NextPolarisKeyOptions,
): NextPolarisKey {
  const core: PolarisKey = createPolarisKey(options);

  const answer = async (problem: Problem, req: Request): Promise<Response> => {
    if (options.errors === "throw") throw new PolarisKeyError(problem);
    if (options.onRefusal) return options.onRefusal(problem, req);
    return core.refuse(problem);
  };

  const gate =
    <C>(requirements: readonly Requirement[], handler: GatedHandler<C>) =>
    async (req: Request, routeContext: C): Promise<Response> => {
      const auth = core.require(
        await core.authenticate(req),
        requirements,
        req,
      );
      if (auth.problem !== null || auth.license === null)
        return answer(
          auth.problem ?? core.problem("license_required", req),
          req,
        );
      const res = await handler(req, auth as GatedAuth, routeContext);
      // A gated answer is about this caller: keep shared caches out unless the route says so.
      if (!res.headers.has("Cache-Control")) {
        try {
          res.headers.set("Cache-Control", "private");
        } catch {
          // An immutable response (a fetched one): leave its headers alone.
        }
      }
      return res;
    };

  return {
    auth: (req) => core.authenticate(req),
    refuse: (problem, req) => core.refuse(problem, req),
    requireLicense: (handler) => gate([], handler),
    requireEntitlement: (name, handler, test) =>
      gate([{ kind: "entitlement", name, ...(test ? { test } : {}) }], handler),
    requireSignIn: (handler) => gate([{ kind: "signIn" }], handler),
  };
}
