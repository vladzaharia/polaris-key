// Hono drop-in (framework drop-ins plan §5.4). It runs on Workers, Bun, Deno and Node:
//
//   app.use("/api/*", polarisKey({ config: polarisConfig }));
//   app.get("/api/export", requireEntitlement("export.pdf"), (c) => …);
//
// `polarisKey()` authenticates and sets `c.var.polaris`; it never refuses. The `require*`
// middleware refuse. The drop-in sets no CORS header: add `POLARIS_REQUEST_HEADERS` to your own
// allow-list.

import type { Context, MiddlewareHandler } from "hono";
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

/** `new Hono<PolarisEnv>()` types `c.var.polaris`. */
export type PolarisEnv = { Variables: { polaris: PolarisAuth } };

/** What a handler behind a `require*` gate sees: the license is present. Hono merges it into the
 *  handler's `c.var`, so `c.var.polaris.license.tier` needs no null check. */
export type GatedAuth = PolarisAuth & { license: PolarisLicense };
export type PolarisGatedEnv = { Variables: { polaris: GatedAuth } };

const NOT_INSTALLED =
  'polarisKey() has not run for this request: add `app.use("/api/*", polarisKey({ config: polarisConfig }))` before the route that uses requireLicense(), requireEntitlement() or requireSignIn()';

export interface PolarisKeyHonoOptions extends PolarisAdapterOptions {
  /** `errors: "throw"` raises a `PolarisKeyError` into `app.onError` instead of answering.
   *  Answer a refusal yourself with `onRefusal`. */
  onRefusal?: (problem: Problem, c: Context) => Response | Promise<Response>;
}

interface Installed {
  core: PolarisKey;
  options: PolarisKeyHonoOptions;
}

const installed = new WeakMap<Request, Installed>();

/** Authenticate the request and set `c.var.polaris`. On Workers, pass `waitUntil` in the options
 *  so the trust refresh outlives the response; nothing wires it automatically. */
export function polarisKey(
  options: PolarisKeyHonoOptions,
): MiddlewareHandler<PolarisEnv> {
  const core = createPolarisKey(options);
  return async (c, next) => {
    const auth = await core.authenticate(c.req.raw);
    c.set("polaris", auth);
    installed.set(c.req.raw, { core, options });
    await next();
  };
}

function gate(
  requirements: readonly Requirement[],
): MiddlewareHandler<PolarisGatedEnv> {
  return async (c, next) => {
    const setup = installed.get(c.req.raw);
    const current = c.get("polaris") as PolarisAuth | undefined;
    if (!setup || !current) throw new Error(NOT_INSTALLED);
    // A CORS preflight carries no credential: let the cors middleware have it.
    if (
      setup.options.preflight !== "gate" &&
      isCorsPreflight(c.req.method, c.req.raw)
    ) {
      await next();
      return;
    }
    const auth = setup.core.require(current, requirements, c.req.raw);
    c.set("polaris", auth as GatedAuth);
    if (auth.problem === null) {
      await next();
      // A gated answer is about this caller: keep shared caches out unless the route says so.
      // After the handler, so a Response it built itself gets the header too; a streaming body
      // is unaffected because its headers are not sent until the first chunk.
      if (!c.res.headers.has("Cache-Control")) {
        try {
          c.res.headers.set("Cache-Control", "private");
        } catch {
          // An immutable response (a fetched one): leave its headers alone.
        }
      }
      return;
    }
    if (setup.options.errors === "throw")
      throw new PolarisKeyError(auth.problem);
    if (setup.options.onRefusal)
      return setup.options.onRefusal(auth.problem, c as unknown as Context);
    return setup.core.refuse(auth.problem, c.req.raw);
  };
}

/** Refuse unless the request carries a valid, fresh licence document. */
export function requireLicense(): MiddlewareHandler<PolarisGatedEnv> {
  return gate([]);
}

/** Refuse unless the document grants boolean entitlement `name`. `test` receives a valued
 *  entitlement instead, e.g. `requireEntitlement("seats", (v) => v >= 5)`. */
export function requireEntitlement(
  name: string,
  test?: (value: any) => boolean,
): MiddlewareHandler<PolarisGatedEnv> {
  return gate([requirement.entitlement(name, test)]);
}

/** Refuse unless the license's tier is one of `tiers`: `requireTier("pro", "team")`. */
export function requireTier(
  ...tiers: string[]
): MiddlewareHandler<PolarisGatedEnv> {
  return gate([requirement.tier(...tiers)]);
}

/** Refuse unless every requirement holds, checked in order:
 *  `requireAll(requirement.signIn(), requirement.tier("pro"))`. */
export function requireAll(
  ...requirements: Requirement[]
): MiddlewareHandler<PolarisGatedEnv> {
  return gate(requirements);
}

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export function requireSignIn(): MiddlewareHandler<PolarisGatedEnv> {
  return gate([{ kind: "signIn" }]);
}
