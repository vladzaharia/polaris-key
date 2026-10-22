// Express (v4 and v5) drop-in (framework drop-ins plan §5.4):
//
//   app.use(polarisKey({ config: polarisConfig }));
//   app.get("/api/export", requireEntitlement("export.pdf"), (req, res) => …);
//
// `polarisKey()` authenticates every request and attaches `req.polaris`; it never refuses, so a
// route with no `require*` stays open. The `require*` middleware refuse. Neither reads
// `Authorization`, a cookie or a query parameter.

import type { NextFunction, Request, RequestHandler, Response } from "express";
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `polarisKey()`. */
      polaris?: PolarisAuth;
    }
  }
}

const NOT_INSTALLED =
  "polarisKey() has not run for this request: add `app.use(polarisKey({ config: polarisConfig }))` above the route (or router) that uses requireLicense(), requireEntitlement() or requireSignIn()";

export interface PolarisKeyExpressOptions extends PolarisAdapterOptions {
  /** Answer a refusal yourself: you must end the response. For example
   *  `(problem, req, res) => res.status(problem.status).json({ error: problem.body.detail })`.
   *  `errors: "throw"` passes a `PolarisKeyError` to Express's error pipeline instead. */
  onRefusal?: (problem: Problem, req: Request, res: Response) => void;
}

interface Installed {
  core: PolarisKey;
  options: PolarisKeyExpressOptions;
}

const installed = new WeakMap<Request, Installed>();

/** Authenticate the request and attach `req.polaris`. Install it before any `require*`. */
export function polarisKey(options: PolarisKeyExpressOptions): RequestHandler {
  const core = createPolarisKey(options);
  return (req, _res, next) => {
    // `rawHeaders` keeps repeated fields apart, which the verdict counts (§14.1).
    core.authenticate(fieldsOf(req)).then((auth) => {
      req.polaris = auth;
      installed.set(req, { core, options });
      next();
    }, next);
  };
}

/** The request's context. Throws when `polarisKey()` has not run. */
export function getPolarisAuth(req: Request): PolarisAuth {
  if (!req.polaris) throw new Error(NOT_INSTALLED);
  return req.polaris;
}

/**
 * The verified licence of a request behind a `require*` gate, typed non-null. Throws when the
 * request carries none, which means the route is not gated: add `requireLicense()` before it.
 */
export function getPolarisLicense(req: Request): PolarisLicense {
  const license = getPolarisAuth(req).license;
  if (license === null)
    throw new Error(
      "this request has no verified license: put requireLicense() (or another require*) before the handler that calls getPolarisLicense()",
    );
  return license;
}

function fieldsOf(req: Request): [string, string][] {
  const fields: [string, string][] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
    fields.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
  return fields;
}

function gate(requirements: readonly Requirement[]): RequestHandler {
  return (req, res, next) => {
    const setup = installed.get(req);
    if (!req.polaris || !setup) {
      next(new Error(NOT_INSTALLED));
      return;
    }
    const fields = fieldsOf(req);
    // A CORS preflight carries no credential: let the cors middleware (or the router's own
    // OPTIONS answer) have it.
    if (
      setup.options.preflight !== "gate" &&
      isCorsPreflight(req.method, fields)
    ) {
      next();
      return;
    }
    const auth = setup.core.require(req.polaris, requirements, fields);
    req.polaris = auth;
    if (auth.problem === null) {
      // A gated answer is about this caller: keep shared caches out unless the route says so.
      if (!res.hasHeader("Cache-Control"))
        res.setHeader("Cache-Control", "private");
      next();
      return;
    }
    refuse(auth.problem, setup.options, req, res, next);
  };
}

function refuse(
  problem: Problem,
  options: PolarisKeyExpressOptions,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (options.errors === "throw") {
    next(new PolarisKeyError(problem));
    return;
  }
  if (options.onRefusal) {
    options.onRefusal(problem, req, res);
    return;
  }
  res.statusCode = problem.status;
  for (const [name, value] of Object.entries(problem.headers))
    res.setHeader(name, value);
  res.end(JSON.stringify(problem.body));
}

/** Refuse unless the request carries a valid, fresh licence document. */
export function requireLicense(): RequestHandler {
  return gate([]);
}

/** Refuse unless the document grants boolean entitlement `name`. `test` receives a valued
 *  entitlement instead, e.g. `requireEntitlement("seats", (v) => v >= 5)`. */
export function requireEntitlement(
  name: string,
  test?: (value: any) => boolean,
): RequestHandler {
  return gate([requirement.entitlement(name, test)]);
}

/** Refuse unless the license's tier is one of `tiers`: `requireTier("pro", "team")`. */
export function requireTier(...tiers: string[]): RequestHandler {
  return gate([requirement.tier(...tiers)]);
}

/** Refuse unless every requirement holds, checked in order:
 *  `requireAll(requirement.signIn(), requirement.tier("pro"))`. */
export function requireAll(...requirements: Requirement[]): RequestHandler {
  return gate(requirements);
}

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export function requireSignIn(): RequestHandler {
  return gate([{ kind: "signIn" }]);
}
