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
  PolarisKeyError,
  type PolarisKey,
  type PolarisKeyOptions,
  type Requirement,
} from "./core.js";
import type { PolarisAuth, Problem } from "./context.js";

export { POLARIS_REQUEST_HEADERS } from "@polaris-key/protocol/core";
export { PolarisKeyError } from "./core.js";
export type { PolarisAuth, Problem } from "./context.js";
export type { PolarisServerConfig } from "./core.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `polarisKey()`. */
      polaris?: PolarisAuth;
    }
  }
}

export interface PolarisKeyExpressOptions extends PolarisKeyOptions {
  /** `"throw"` passes a `PolarisKeyError` to Express's error pipeline instead of answering. */
  errors?: "respond" | "throw";
  /** Answer a refusal yourself. */
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
    const fields: [string, string][] = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
      fields.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
    core.authenticate(fields).then((auth) => {
      req.polaris = auth;
      installed.set(req, { core, options });
      next();
    }, next);
  };
}

/** The request's context. Throws when `polarisKey()` has not run. */
export function getPolarisAuth(req: Request): PolarisAuth {
  if (!req.polaris)
    throw new Error("polarisKey() must run before this route (app.use)");
  return req.polaris;
}

function gate(requirements: readonly Requirement[]): RequestHandler {
  return (req, res, next) => {
    const setup = installed.get(req);
    if (!req.polaris || !setup) {
      next(new Error("polarisKey() must run before this route (app.use)"));
      return;
    }
    const fields: [string, string][] = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
      fields.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
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
  return gate([{ kind: "entitlement", name, ...(test ? { test } : {}) }]);
}

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export function requireSignIn(): RequestHandler {
  return gate([{ kind: "signIn" }]);
}
