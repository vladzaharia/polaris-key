// Next.js App Router drop-in (framework drop-ins plan §5.4), for route handlers. It is
// header-only in v1: the credential is `X-PKey-License`, never a cookie. It imports nothing from
// `next`, so it runs wherever a route handler is a `(Request) => Response`.
//
//   // lib/polaris.ts
//   export const polaris = createNextPolarisKey({ config: polarisConfig });
//   // app/api/export/route.ts
//   export const GET = polaris.requireEntitlement("export.pdf",
//     async (req, { license }) => Response.json({ tier: license.tier }));
//   // middleware.ts: a coarse gate in front of whole path prefixes
//   export const middleware = polaris.middleware([{ path: "/api/pro/*", require: [requirement.tier("pro")] }]);

import type { BackendRefusalCode } from "@polaris-key/client-core/backend";
import {
  createPolarisKey,
  isCorsPreflight,
  PolarisKeyError,
  requirement,
  type PolarisAdapterOptions,
  type PolarisKey,
  type Requirement,
} from "./core.js";
import type { PolarisAuth, PolarisLicense, Problem } from "./context.js";

export { POLARIS_REQUEST_HEADERS } from "@polaris-key/protocol/core";
export { PolarisKeyError } from "./core.js";
export type { PolarisAuth, Problem } from "./context.js";
export type { PolarisServerConfig, Requirement } from "./core.js";
export { requirement } from "./core.js";

export interface NextPolarisKeyOptions extends PolarisAdapterOptions {
  /** `errors: "throw"` raises a `PolarisKeyError` (Next shows its error page) instead of
   *  answering. Answer a refusal yourself with `onRefusal`. */
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

/** One rule of `middleware(...)`: the first whose `path` matches the request decides it. */
export interface MiddlewareRule {
  /** A pathname (`/api/export`), a prefix (`/api/pro/*`), a RegExp or a predicate. Absent:
   *  every request that reaches the middleware. */
  path?: string | RegExp | ((pathname: string) => boolean);
  /** What the request needs; empty means a valid, fresh license. */
  require?: readonly Requirement[];
}

function matches(rule: MiddlewareRule, pathname: string): boolean {
  const p = rule.path;
  if (p === undefined) return true;
  if (typeof p === "function") return p(pathname);
  if (p instanceof RegExp)
    return new RegExp(p.source, p.flags.replace(/[gy]/g, "")).test(pathname);
  return p.endsWith("/*")
    ? pathname === p.slice(0, -2) || pathname.startsWith(p.slice(0, -1))
    : pathname === p;
}

export interface NextPolarisKey {
  /** A Next.js `middleware.ts` export: refuse before the route runs. It passes (returns
   *  `undefined`) when the request is allowed, a CORS preflight, or matches no rule. With no
   *  rules every request needs a valid license. It cannot hand the license to the route:
   *  a route that needs it wraps its handler with `requireLicense` too (the verdict is cached). */
  middleware(
    rules?: MiddlewareRule | readonly MiddlewareRule[],
  ): (req: Request) => Promise<Response | undefined>;
  /** Refuse unless the license's tier is one of `tiers`. */
  requireTier<C = unknown>(
    tiers: readonly string[],
    handler: GatedHandler<C>,
  ): (req: Request, routeContext: C) => Promise<Response>;
  /** Refuse unless every requirement holds, checked in order. */
  requireAll<C = unknown>(
    requirements: readonly Requirement[],
    handler: GatedHandler<C>,
  ): (req: Request, routeContext: C) => Promise<Response>;
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
    middleware: (rules) => {
      const list: readonly MiddlewareRule[] = Array.isArray(rules)
        ? rules
        : rules
          ? [rules as MiddlewareRule]
          : [{}];
      return async (req) => {
        if (options.preflight !== "gate" && isCorsPreflight(req.method, req))
          return undefined;
        const pathname = new URL(req.url).pathname;
        const rule = list.find((r) => matches(r, pathname));
        if (!rule) return undefined;
        const auth = core.require(
          await core.authenticate(req),
          rule.require ?? [],
          req,
        );
        if (auth.problem === null) return undefined;
        return answer(auth.problem, req);
      };
    },
    requireTier: (tiers, handler) =>
      gate([requirement.tier(...tiers)], handler),
    requireAll: (requirements, handler) => gate(requirements, handler),
    auth: (req) => core.authenticate(req),
    refuse: (problem, req) => core.refuse(problem, req),
    requireLicense: (handler) => gate([], handler),
    requireEntitlement: (name, handler, test) =>
      gate([requirement.entitlement(name, test)], handler),
    requireSignIn: (handler) => gate([{ kind: "signIn" }], handler),
  };
}
