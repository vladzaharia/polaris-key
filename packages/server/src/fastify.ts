// Fastify (v4 and v5) drop-in (framework drop-ins plan §12.1):
//
//   await app.register(polarisKey, { config: polarisConfig });
//   app.get("/api/export", { preHandler: requireEntitlement("export.pdf") }, (req) => …);
//
// The plugin authenticates every request and sets `req.polaris`; it never refuses, so a route
// with no `require*` stays open. The `require*` hooks refuse. Neither reads `Authorization`, a
// cookie or a query parameter. The plugin is not encapsulated (`skip-override`), so the hook
// covers the whole app, not only the scope that registered it.

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
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

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `polarisKey` plugin. */
    polaris?: PolarisAuth;
  }
}

const NOT_INSTALLED =
  "the polarisKey plugin has not run for this request: add `await app.register(polarisKey, { config: polarisConfig })` before the route that uses requireLicense(), requireEntitlement() or requireSignIn()";

export interface PolarisKeyFastifyOptions extends PolarisAdapterOptions {
  /** Answer a refusal yourself: you must send the reply, for example
   *  `(problem, req, reply) => reply.code(problem.status).send({ error: problem.code })`.
   *  `errors: "throw"` passes a `PolarisKeyError` to Fastify's error handler instead. */
  onRefusal?: (
    problem: Problem,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => unknown | Promise<unknown>;
}

interface Installed {
  core: PolarisKey;
  options: PolarisKeyFastifyOptions;
}

const installed = new WeakMap<FastifyRequest, Installed>();

function fieldsOf(req: FastifyRequest): [string, string][] {
  // `rawHeaders` keeps repeated fields apart, which the verdict counts (§14.1).
  const raw = req.raw.rawHeaders;
  const fields: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2)
    fields.push([raw[i]!, raw[i + 1]!]);
  return fields;
}

/** Register with `app.register(polarisKey, { config })`. Install it before any `require*`. */
export async function polarisKey(
  app: FastifyInstance,
  options: PolarisKeyFastifyOptions,
): Promise<void> {
  const core = createPolarisKey(options);
  app.decorateRequest("polaris", undefined);
  app.addHook("onRequest", async (req) => {
    req.polaris = await core.authenticate(fieldsOf(req));
    installed.set(req, { core, options });
  });
}
// fastify-plugin's marker: the hook and decoration reach the parent scope.
(polarisKey as unknown as Record<symbol, unknown>)[
  Symbol.for("skip-override")
] = true;
(polarisKey as unknown as Record<symbol, unknown>)[
  Symbol.for("fastify.display-name")
] = "polaris-key";

/** The request's context. Throws when the plugin has not run. */
export function getPolarisAuth(req: FastifyRequest): PolarisAuth {
  if (!req.polaris) throw new PolarisKeyConfigError(NOT_INSTALLED);
  return req.polaris;
}

/**
 * The verified licence of a request behind a `require*` gate, typed non-null. Throws when the
 * request carries none, which means the route is not gated: add `requireLicense()` before it.
 */
export function getPolarisLicense(req: FastifyRequest): PolarisLicense {
  const license = getPolarisAuth(req).license;
  if (license === null)
    throw new PolarisKeyConfigError(
      "this request has no verified license: put requireLicense() (or another require*) before the handler that calls getPolarisLicense()",
    );
  return license;
}

function gate(
  requirements: readonly Requirement[],
): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    const setup = installed.get(req);
    if (!req.polaris || !setup) throw new PolarisKeyConfigError(NOT_INSTALLED);
    const fields = fieldsOf(req);
    // A CORS preflight carries no credential: let the cors plugin (or the router's own OPTIONS
    // answer) have it.
    if (
      setup.options.preflight !== "gate" &&
      isCorsPreflight(req.method, fields)
    )
      return;
    const auth = setup.core.require(req.polaris, requirements, fields);
    req.polaris = auth;
    if (auth.problem === null) {
      // A gated answer is about this caller: keep shared caches out unless the route says so.
      if (!reply.hasHeader("cache-control"))
        reply.header("cache-control", "private");
      return;
    }
    const problem = auth.problem;
    if (setup.options.errors === "throw") throw new PolarisKeyError(problem);
    if (setup.options.onRefusal) {
      await setup.options.onRefusal(problem, req, reply);
      return reply;
    }
    reply.code(problem.status);
    for (const [name, value] of Object.entries(problem.headers))
      reply.header(name, value);
    return reply.send(JSON.stringify(problem.body));
  };
}

/** Refuse unless the request carries a valid, fresh licence document. */
export function requireLicense(): preHandlerAsyncHookHandler {
  return gate([]);
}

/** Refuse unless the document grants boolean entitlement `name`. `test` receives a valued
 *  entitlement instead, e.g. `requireEntitlement("seats", (v) => v >= 5)`. */
export function requireEntitlement(
  name: string,
  test?: (value: any) => boolean,
): preHandlerAsyncHookHandler {
  return gate([requirement.entitlement(name, test)]);
}

/** Refuse unless the license's tier is one of `tiers`: `requireTier("pro", "team")`. */
export function requireTier(...tiers: string[]): preHandlerAsyncHookHandler {
  return gate([requirement.tier(...tiers)]);
}

/** Refuse unless every requirement holds, checked in order:
 *  `requireAll(requirement.signIn(), requirement.tier("pro"))`. */
export function requireAll(
  ...requirements: Requirement[]
): preHandlerAsyncHookHandler {
  return gate(requirements);
}

/** Refuse unless a person is signed in on the device (`profile.user.subject`). */
export function requireSignIn(): preHandlerAsyncHookHandler {
  return gate([{ kind: "signIn" }]);
}
