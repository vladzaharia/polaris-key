// Koa (v2 and v3) drop-in (framework drop-ins plan §12.1):
//
//   app.use(polarisKey({ config: polarisConfig }));
//   router.get("/api/export", requireEntitlement("export.pdf"), (ctx) => …);
//
// `polarisKey()` authenticates every request and sets `ctx.state.polaris`; it never refuses, so a
// route with no `require*` stays open. The `require*` middleware refuse. Neither reads
// `Authorization`, a cookie or a query parameter.

import type { Context, DefaultState, Middleware } from "koa";
import {
  createPolarisKey,
  isCorsPreflight,
  PolarisKeyConfigError,
  PolarisKeyError,
  requirement,
  type PolarisAdapterOptions,
  type PolarisKey,
  type Requirement,
} from "./core.js";
import type { PolarisAuth, PolarisLicense, Problem } from "./context.js";

export { POLARIS_REQUEST_HEADERS } from "@polaris-key/protocol/core";
export { PolarisKeyConfigError, PolarisKeyError } from "./core.js";
export type { PolarisAuth, PolarisLicense, Problem } from "./context.js";
export type { PolarisServerConfig, Requirement } from "./core.js";
export { requirement } from "./core.js";

declare module "koa" {
  interface DefaultState {
    /** Set by `polarisKey()`. */
    polaris?: PolarisAuth;
  }
}

const NOT_INSTALLED =
  "polarisKey() has not run for this request: add `app.use(polarisKey({ config: polarisConfig }))` above the route (or router) that uses requireLicense(), requireEntitlement() or requireSignIn()";

export interface PolarisKeyKoaOptions extends PolarisAdapterOptions {
  /** Answer a refusal yourself: set `ctx.status` and `ctx.body`, for example
   *  `(problem, ctx) => { ctx.status = problem.status; ctx.body = { error: problem.code }; }`.
   *  `errors: "throw"` throws a `PolarisKeyError` into Koa's error handling instead. */
  onRefusal?: (problem: Problem, ctx: Context) => void | Promise<void>;
}

interface Installed {
  core: PolarisKey;
  options: PolarisKeyKoaOptions;
}

const installed = new WeakMap<object, Installed>();

function fieldsOf(ctx: Context): [string, string][] {
  // `rawHeaders` keeps repeated fields apart, which the verdict counts (§14.1).
  const raw = ctx.req.rawHeaders;
  const fields: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2)
    fields.push([raw[i]!, raw[i + 1]!]);
  return fields;
}

/** Authenticate the request and set `ctx.state.polaris`. Install it before any `require*`. */
export function polarisKey(options: PolarisKeyKoaOptions): Middleware {
  const core = createPolarisKey(options);
  return async (ctx, next) => {
    (ctx.state as DefaultState).polaris = await core.authenticate(
      fieldsOf(ctx),
    );
    installed.set(ctx.req, { core, options });
    await next();
  };
}

/** The request's context. Throws when `polarisKey()` has not run. */
export function getPolarisAuth(ctx: Context): PolarisAuth {
  const auth = (ctx.state as DefaultState).polaris;
  if (!auth) throw new PolarisKeyConfigError(NOT_INSTALLED);
  return auth;
}

/**
 * The verified licence of a request behind a `require*` gate, typed non-null. Throws when the
 * request carries none, which means the route is not gated: add `requireLicense()` before it.
 */
export function getPolarisLicense(ctx: Context): PolarisLicense {
  const license = getPolarisAuth(ctx).license;
  if (license === null)
    throw new PolarisKeyConfigError(
      "this request has no verified license: put requireLicense() (or another require*) before the handler that calls getPolarisLicense()",
    );
  return license;
}

function gate(requirements: readonly Requirement[]): Middleware {
  return async (ctx, next) => {
    const setup = installed.get(ctx.req);
    const current = (ctx.state as DefaultState).polaris;
    if (!setup || !current) throw new PolarisKeyConfigError(NOT_INSTALLED);
    const fields = fieldsOf(ctx);
    // A CORS preflight carries no credential: let the cors middleware have it.
    if (
      setup.options.preflight !== "gate" &&
      isCorsPreflight(ctx.method, fields)
    ) {
      await next();
      return;
    }
    const auth = setup.core.require(current, requirements, fields);
    (ctx.state as DefaultState).polaris = auth;
    if (auth.problem === null) {
      await next();
      // A gated answer is about this caller: keep shared caches out unless the route says so.
      // After the handler, so a header it set itself wins; Koa sends headers after the chain.
      if (!ctx.headerSent && !ctx.response.get("Cache-Control"))
        ctx.set("Cache-Control", "private");
      return;
    }
    const problem = auth.problem;
    if (setup.options.errors === "throw") throw new PolarisKeyError(problem);
    if (setup.options.onRefusal) {
      await setup.options.onRefusal(problem, ctx);
      return;
    }
    ctx.status = problem.status;
    for (const [name, value] of Object.entries(problem.headers))
      ctx.set(name, value);
    ctx.body = JSON.stringify(problem.body);
  };
}

/** Refuse unless the request carries a valid, fresh licence document. */
export function requireLicense(): Middleware {
  return gate([]);
}

/** Refuse unless the document grants boolean entitlement `name`. `test` receives a valued
 *  entitlement instead, e.g. `requireEntitlement("seats", (v) => v >= 5)`. */
export function requireEntitlement(
  name: string,
  test?: (value: any) => boolean,
): Middleware {
  return gate([requirement.entitlement(name, test)]);
}

/** Refuse unless the license's tier is one of `tiers`: `requireTier("pro", "team")`. */
export function requireTier(...tiers: string[]): Middleware {
  return gate([requirement.tier(...tiers)]);
}

/** Refuse unless every requirement holds, checked in order:
 *  `requireAll(requirement.signIn(), requirement.tier("pro"))`. */
export function requireAll(...requirements: Requirement[]): Middleware {
  return gate(requirements);
}

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export function requireSignIn(): Middleware {
  return gate([{ kind: "signIn" }]);
}
