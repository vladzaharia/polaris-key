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

/** `new Hono<PolarisEnv>()` types `c.var.polaris`. */
export type PolarisEnv = { Variables: { polaris: PolarisAuth } };

export interface PolarisKeyHonoOptions extends PolarisKeyOptions {
  /** `"throw"` raises a `PolarisKeyError` into `app.onError` instead of answering. */
  errors?: "respond" | "throw";
  /** Answer a refusal yourself. */
  onRefusal?: (problem: Problem, c: Context) => Response | Promise<Response>;
}

interface Installed {
  core: PolarisKey;
  options: PolarisKeyHonoOptions;
}

const installed = new WeakMap<Request, Installed>();

/** Authenticate the request and set `c.var.polaris`. On Workers the trust refresh runs through
 *  `waitUntil` automatically. */
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
): MiddlewareHandler<PolarisEnv> {
  return async (c, next) => {
    const setup = installed.get(c.req.raw);
    const current = c.get("polaris") as PolarisAuth | undefined;
    if (!setup || !current)
      throw new Error("polarisKey() must run before this route (app.use)");
    const auth = setup.core.require(current, requirements, c.req.raw);
    c.set("polaris", auth);
    if (auth.problem === null) {
      c.header("Cache-Control", "private");
      await next();
      return;
    }
    if (setup.options.errors === "throw")
      throw new PolarisKeyError(auth.problem);
    if (setup.options.onRefusal)
      return setup.options.onRefusal(auth.problem, c as Context);
    return setup.core.refuse(auth.problem);
  };
}

/** Refuse unless the request carries a valid, fresh licence document. */
export function requireLicense(): MiddlewareHandler<PolarisEnv> {
  return gate([]);
}

/** Refuse unless the document grants boolean entitlement `name`. `test` receives a valued
 *  entitlement instead, e.g. `requireEntitlement("seats", (v) => v >= 5)`. */
export function requireEntitlement(
  name: string,
  test?: (value: any) => boolean,
): MiddlewareHandler<PolarisEnv> {
  return gate([{ kind: "entitlement", name, ...(test ? { test } : {}) }]);
}

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export function requireSignIn(): MiddlewareHandler<PolarisEnv> {
  return gate([{ kind: "signIn" }]);
}
