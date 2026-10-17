/// <reference types="@cloudflare/workers-types" />
/**
 * The service route table (P0-25; the admin table's counterpart, `console/routes.ts`).
 *
 * A service declares every route it serves as a row: the path under `/<product>/<slug>`, the
 * methods, how the caller proves who it is, and the handler. `serviceRoutes` turns the rows into
 * the three things a service used to write by hand and keep in step:
 *
 *   - `handle`, the descriptor's dispatch. Deny by default: a path no row matches is `null`
 *     (Core's not-found, byte-identical to a disabled service); a path a row matches with a method
 *     the row does not list is refused before any handler runs.
 *   - `surface`, the OpenAPI path templates `routeCoverage` pins against the spec. It is derived
 *     from the rows, so a route cannot be served and not declared, or declared and not served.
 *   - the metadata `test/serviceRouteTables.test.ts` walks: every row names its auth, and a row
 *     that takes a CI token names the scope and the body cap.
 *
 * What a row does for the handler that follows it:
 *
 *   - `path` is relative to the service. `:name` is one segment (handed over raw, undecoded,
 *     exactly as `ctx.rest` carried it), a trailing `**` is the rest. The most specific row wins:
 *     a literal beats a parameter and a parameter beats `**` (`./pathMatch.ts`).
 *   - `methods` is the whole set the route answers. Any other method on a matching path is
 *     `other`: `"405"` (the plain `405 Method Not Allowed`, the default) or `"none"` (`null`, the
 *     not-found), whichever the hand dispatch answered. Handlers keep their own method guard as
 *     a second lock; the row is the first, and a row never lists a method its handler refuses.
 *   - `params` constrains a `:name` segment. A segment that fails is no match at all (`null`),
 *     checked before the method gate and before any credential, as the hand dispatch did.
 *   - `auth: { kind: "ci", scope }` is ENFORCED here: the dispatcher runs `requireCiScope` after
 *     the method gate and before the handler, and hands the principal over. A CI route cannot be
 *     written without its scope, and cannot reach its handler without the token. Every other
 *     `auth` kind is DECLARED, and enforced where it always was (the handler, which owns that
 *     credential's shape); the declaration is what the table test and a reviewer read.
 *   - `bodyCap` is the largest JSON body the route reads. `match.readJson()` reads it under that
 *     cap, after auth, so an unauthenticated caller is refused before a body is read.
 *
 * A handler returns `null` for "nothing here after all" (an unknown store, a missing record), as
 * before: only Core decides what no-route means (`core/registry.ts`).
 */

import type { ServiceContext, ServiceDescriptor } from "../registry.js";
import type { ServiceSlug } from "../services.js";
import { methodNotAllowed } from "../errors.js";
import {
  readCiJson,
  requireCiScope,
  type CiPrincipal,
  type CiScope,
} from "../ciScope.js";
import {
  compareSpecificity,
  matchPath,
  patternSegments,
  type MatchedPath,
} from "./pathMatch.js";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who a route answers.
 *
 * `none` takes no credential (a public document, a sign-in page). `ci` is a `pkeyci_` token with
 * one of the scopes, enforced by the dispatcher. The rest name the credential the handler checks:
 * `device` the `pkeyt_` bearer, `session` the product browser session cookie, `signature` a
 * payload signed by a third party (a store webhook), `code` a user or device code from the flow
 * that issued it, `handler` a gate that is none of those and is documented at the handler.
 */
export type RouteAuth =
  | { kind: "none" }
  | { kind: "ci"; scope: CiScope | readonly CiScope[] }
  | { kind: "device" }
  | { kind: "session" }
  | { kind: "signature" }
  | { kind: "code" }
  | { kind: "handler" };

/** What a handler is given beside the service context. */
export interface RouteMatch {
  /** The `:name` segments, raw. */
  params: Readonly<Record<string, string>>;
  /** The segments a trailing `**` covered. */
  rest: readonly string[];
  /** The verified CI principal, for a `ci` route; `undefined` otherwise. */
  principal: CiPrincipal | undefined;
  /** The row, for the handler that wants its declared cap or scope. */
  route: ServiceRouteDecl;
  /** The JSON object body under the row's `bodyCap`, or the 400/413 to answer with. */
  readJson(): Promise<Record<string, unknown> | Response>;
}

export type ServiceRouteHandler = (
  ctx: ServiceContext,
  match: RouteMatch,
) => Promise<Response | null>;

export interface ServiceRouteDecl {
  /** Relative to `/<product>/<slug>`; `:name` is one segment, a trailing `**` is the rest. */
  path: string;
  /** The methods the route documents (the OpenAPI operations). */
  methods: readonly HttpMethod[];
  /**
   * The route also answers HEAD though the spec lists GET only: the hand dispatch let a HEAD
   * through to the handler, which serves it as the GET with no body, and a probe may rely on it.
   * Declared rather than implied, so a route that never answered HEAD cannot start to.
   */
  alsoHead?: true;
  auth: RouteAuth;
  /** A `:name` segment that must match, else the route does not match at all. */
  params?: Readonly<Record<string, RegExp>>;
  /** Largest JSON body the route reads, in bytes. Required for a `ci` route that reads one. */
  bodyCap?: number;
  /**
   * A path the row matches but this check refuses, as no match at all (`null`): for a segment
   * whose validity needs more than a pattern (a store id, a byte target the bytes host parses
   * with the same function). Runs before the method gate and before any credential.
   */
  accept?: (
    ctx: ServiceContext,
    params: Readonly<Record<string, string>>,
  ) => boolean;
  /**
   * A method the row does not list: the plain 405 (default), `null` (the not-found), `"handler"`
   * (the handler's own method policy answers, for a route whose handler already refuses with a
   * richer response and is shared with another host), or a refusal to send instead.
   */
  other?: "405" | "none" | "handler" | (() => Response);
  /**
   * The OpenAPI path under `/{product}/<slug>/`, when it cannot be derived from `path` (a
   * template that varies inside a segment, `{buildId}.AppImage.zsync`; or `**`). `false` leaves
   * the row out of the spec on purpose (it must say why, in a comment).
   */
  doc?: string | readonly string[] | false;
  handler: ServiceRouteHandler;
}

export interface ServiceRoutes {
  readonly rows: readonly ServiceRouteDecl[];
  handle(ctx: ServiceContext): Promise<Response | null>;
  /** The OpenAPI templates and lower-case methods `routeCoverage` pins. */
  readonly surface: ServiceDescriptor["surface"];
}

/** `:name` becomes `{name}`; the OpenAPI spelling. */
function openApiTail(path: string): string {
  return patternSegments(path)
    .map((s) => (s.startsWith(":") ? `{${s.slice(1)}}` : s))
    .join("/");
}

export function serviceRoutes(
  slug: ServiceSlug,
  rows: readonly ServiceRouteDecl[],
): ServiceRoutes {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.path))
      throw new Error(`${slug}: route ${r.path} is declared twice`);
    seen.add(r.path);
    if (r.methods.length === 0)
      throw new Error(`${slug}: route ${r.path} answers no method`);
    if (r.path.includes("**") && r.doc === undefined)
      throw new Error(`${slug}: route ${r.path} needs a doc path (or false)`);
    // A CI route that is not a read must say how big a body it may be sent.
    if (
      r.auth.kind === "ci" &&
      r.bodyCap === undefined &&
      r.methods.some((m) => m !== "GET" && m !== "HEAD")
    )
      throw new Error(`${slug}: CI route ${r.path} needs a bodyCap`);
  }

  const surface = rows.flatMap((r) => {
    if (r.doc === false) return [];
    const tails =
      r.doc === undefined
        ? [openApiTail(r.path)]
        : typeof r.doc === "string"
          ? [r.doc]
          : r.doc;
    return tails.map((tail) => ({
      path: `/{product}/${slug}${tail === "" ? "" : `/${tail}`}`,
      methods: r.methods.map((m) => m.toLowerCase()),
    }));
  });

  async function handle(ctx: ServiceContext): Promise<Response | null> {
    // The best row by path, then the method; a failed `params` check is no match.
    let best: { row: ServiceRouteDecl; matched: MatchedPath } | null = null;
    for (const row of rows) {
      const matched = matchPath(row.path, ctx.rest);
      if (!matched) continue;
      if (best === null || compareSpecificity(row.path, best.row.path) < 0)
        best = { row, matched };
    }
    if (best === null) return null;
    const { row, matched } = best;
    for (const [name, re] of Object.entries(row.params ?? {}))
      if (!re.test(matched.params[name] ?? "")) return null;
    if (row.accept && !row.accept(ctx, matched.params)) return null;
    const method = ctx.req.method;
    if (
      !(row.methods as readonly string[]).includes(method) &&
      !(row.alsoHead && method === "HEAD") &&
      row.other !== "handler"
    ) {
      if (row.other === "none") return null;
      return typeof row.other === "function" ? row.other() : methodNotAllowed();
    }

    let principal: CiPrincipal | undefined;
    if (row.auth.kind === "ci") {
      const checked = await requireCiScope(
        ctx.req,
        ctx.env,
        ctx.db,
        ctx.product.slug,
        row.auth.scope,
        ctx.now,
      );
      if (checked instanceof Response) return checked;
      principal = checked;
    }
    return row.handler(ctx, {
      params: matched.params,
      rest: matched.rest,
      principal,
      route: row,
      readJson: async () => {
        if (row.bodyCap === undefined)
          throw new Error(`${slug}: ${row.path} reads a body with no bodyCap`);
        return readCiJson(ctx.req, row.bodyCap);
      },
    });
  }

  return { rows, handle, surface };
}
