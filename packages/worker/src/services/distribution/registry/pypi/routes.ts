/// <reference types="@cloudflare/workers-types" />
/**
 * The PyPI feed's routes on the registry host (F-05, plans/F-01.md §6.2 and §6.8): the Simple
 * Repository API (PEP 503, 691 at API 1.1, 700), PEP 658/714 metadata and PEP 592 yank.
 *
 *   GET|HEAD /pypi/<owner>/simple/                        the project list
 *   GET|HEAD /pypi/<owner>/simple/<normalised>/           one project page
 *   GET|HEAD /pypi/<owner>/files/<sha256>/<filename>      a wheel or an sdist
 *   GET|HEAD /pypi/<owner>/files/<sha256>/<wheel>.metadata  the wheel's core metadata (PEP 658)
 *
 * EVERY ANSWER GOES THROUGH `serveFeedRead`, so the ladder (kill switch, Distribution,
 * `packageFeeds`, the feed, the mode) runs before the cache and before anything is disclosed.
 * A path naming no project or file still runs the feed-level check (`deliverableId: null`) and
 * then answers the not-found, so an unknown name answers exactly what a feed that is off, or a
 * non-public feed, answers for a known one: nothing about what exists can be probed.
 *
 * NEGOTIATION (PEP 691): the JSON form whenever `Accept` lists `application/vnd.pypi.simple.v1+json`
 * (or `…latest+json`) with a non-zero q; otherwise the inert HTML form, unless the feed's
 * `ext_json.htmlFallback` is `false`, when a client that admits JSON only through a wildcard (or
 * sends no `Accept`) still gets JSON and one that cannot take JSON gets 406. pip (22.2 and later)
 * and uv always list the JSON type first, so they always get JSON; the HTML form is for
 * clients that ask for HTML alone. Both forms vary on `Accept`, and the cache key carries it
 * (`cache.ts`).
 *
 * REDIRECTS: `simple`, `simple/<name>` and any non-normalised name answer 301 to the PEP 503
 * normalised URL with its trailing slash. The redirect is computed from the path alone, after
 * the feed-level check, so it discloses nothing.
 */

import { sha256Hex } from "../../../../core/platform.js";
import type {
  RegistryRoute,
  RegistryRouteContext,
} from "../../../../core/registryHost.js";
import type { CatalogPackageDeliverable } from "../../../../core/hooks.js";
import { registryNotFound } from "../../../../core/registryHost.js";
import { blobKey, blobResponse, hasRef } from "../../../../core/blobs.js";
import { ErrorCode, errorResponse } from "../../../../core/errors.js";
import { authorizeFeedRead } from "../authorize.js";
import { registryCacheHeaders } from "../cache.js";
import { feedReadContext, feedRoute, requestCredential } from "../serve.js";
import { cachedRegistrySettings, d1RegistrySettings } from "../settings.js";
import type { PackageFile, RegistryPackage } from "../materialise.js";
import {
  PYPI_HTML_TYPE,
  PYPI_JSON_TYPE,
  indexHtml,
  indexJson,
  isProjectName,
  normalizeProjectName,
  projectPageKey,
} from "./render.js";
import {
  findProject,
  freshPageResponse,
  loadPypiPackage,
  pypiProjects,
} from "./source.js";

/**
 * The policy the HTML form is served under: an opaque origin with nothing allowed, no base, no
 * form target. `core/registryHost.ts` admits the page only when `inertDocumentPolicy` accepts
 * this exact header (THREAT-MODEL §3).
 */
export const PYPI_DOCUMENT_CSP =
  "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** An owner segment: a product slug. */
const OWNER = "([a-z0-9-]{1,64})";

/** Which form a request gets. */
export type SimpleForm = "json" | "html" | "not-acceptable";

const JSON_TYPES = new Set([
  PYPI_JSON_TYPE,
  "application/vnd.pypi.simple.latest+json",
]);

/** The media ranges of an `Accept` header with their q-values (malformed q reads as 0). */
function mediaRanges(accept: string): Array<{ type: string; q: number }> {
  return accept
    .split(",")
    .map((part) => {
      const [type = "", ...params] = part.split(";");
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
        if (m) q = Number.isFinite(Number(m[1])) ? Number(m[1]) : 0;
      }
      return { type: type.trim().toLowerCase(), q };
    })
    .filter((r) => r.type !== "");
}

/** PEP 691 negotiation, as this feed applies it (see the file comment). */
export function negotiateSimple(
  accept: string | null,
  htmlFallback: boolean,
): SimpleForm {
  const ranges = accept === null ? [] : mediaRanges(accept);
  if (ranges.some((r) => JSON_TYPES.has(r.type) && r.q > 0)) return "json";
  if (htmlFallback) return "html";
  const wildcard =
    accept === null ||
    ranges.some(
      (r) => (r.type === "*/*" || r.type === "application/*") && r.q > 0,
    );
  return wildcard ? "json" : "not-acceptable";
}

/** The feed's `htmlFallback` (default on), from the 30-second settings cache. */
async function htmlFallback(ctx: RegistryRouteContext): Promise<boolean> {
  const { feed } = await cachedRegistrySettings(
    d1RegistrySettings(ctx.db),
    ctx.product.slug,
    "pypi",
  );
  return feed?.ext.htmlFallback !== false;
}

/** The form for this request, or the 406 a client that cannot take JSON gets. */
async function chosenForm(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<SimpleForm> {
  const accept = req.headers.get("accept");
  // Only the HTML outcome depends on the setting; skip the read when JSON is listed.
  const first = negotiateSimple(accept, true);
  if (first === "json") return first;
  return negotiateSimple(accept, await htmlFallback(ctx));
}

/** 406 with the existing `bad_request` code: a new wire code would be an every-SDK change
 *  (`conformance/parity/errors.json`), and no device SDK ever reads the registry host. */
function notAcceptable(): Response {
  return errorResponse(
    406,
    ErrorCode.BadRequest,
    `This index answers ${PYPI_JSON_TYPE}.`,
  );
}

/** Add the headers both simple forms carry: `Vary: Accept`, and the policy on the HTML one. */
function simpleHeaders(res: Response, form: "json" | "html"): Response {
  const headers = new Headers(res.headers);
  headers.set("vary", "Accept");
  if (form === "html")
    headers.set("content-security-policy", PYPI_DOCUMENT_CSP);
  return new Response(res.body, { status: res.status, headers });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { location, "cache-control": "no-store" },
  });
}

/** What a path names, read before the ladder: an unknown name and a redirect read as a list
 *  document (`deliverableId: null`), so only the feed-level check decides them. */
type Named<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "redirect"; readonly location: string }
  | ({ readonly kind: "found" } & T);

function namedId<T extends { project: { id: string } }>(
  _params: Record<string, string>,
  state: Named<T>,
): string | null {
  return state.kind === "found" ? state.project.id : null;
}

// ── The project list ──────────────────────────────────────────────────────────────────────────

const simpleIndex: RegistryRoute = feedRoute({
  name: "pypi.simple.index",
  ecosystem: "pypi",
  inertDocument: true,
  match(pathname) {
    const m = new RegExp(`^/pypi/${OWNER}/simple(/?)$`).exec(pathname);
    return m ? { owner: m[1]!, params: { slash: m[2]! } } : null;
  },
  // A list document: only the feed's mode decides (§6.6 step 3). A project whose own delivery
  // access is stricter than the list's is omitted from it.
  deliverableId: () => null,
  async serve(req, ctx, cache) {
    const owner = ctx.product.slug;
    if (ctx.params.slash !== "/") return redirect(`/pypi/${owner}/simple/`);
    const form = await chosenForm(req, ctx);
    if (form === "not-acceptable") return notAcceptable();
    const listed = [];
    for (const project of await pypiProjects(ctx)) {
      const decision = await authorizeFeedRead(
        feedReadContext(req, ctx),
        requestCredential(req, ctx),
        owner,
        "pypi",
        project.id,
      );
      if (!decision.ok || decision.cache !== cache) continue;
      if (!(await loadPypiPackage(ctx, project))) continue;
      listed.push({
        name: project.name,
        nameNorm: normalizeProjectName(project.name),
      });
    }
    const body = form === "json" ? indexJson(listed) : indexHtml(listed);
    return simpleHeaders(
      new Response(body, {
        status: 200,
        headers: {
          "content-type": form === "json" ? PYPI_JSON_TYPE : PYPI_HTML_TYPE,
          ...registryCacheHeaders(cache, "index", await sha256Hex(body)),
        },
      }),
      form,
    );
  },
});

// ── One project page ──────────────────────────────────────────────────────────────────────────

type ProjectState = Named<{
  readonly project: CatalogPackageDeliverable;
  readonly norm: string;
}>;

const simpleProject: RegistryRoute = feedRoute<ProjectState>({
  name: "pypi.simple.project",
  ecosystem: "pypi",
  inertDocument: true,
  match(pathname) {
    const m = new RegExp(`^/pypi/${OWNER}/simple/([^/]+)(/?)$`).exec(pathname);
    return m ? { owner: m[1]!, params: { name: m[2]!, slash: m[3]! } } : null;
  },
  async resolve(_req, ctx): Promise<ProjectState> {
    let name: string;
    try {
      name = decodeURIComponent(ctx.params.name!);
    } catch {
      return { kind: "absent" };
    }
    if (!isProjectName(name)) return { kind: "absent" };
    const norm = normalizeProjectName(name);
    if (name !== norm || ctx.params.slash !== "/")
      return {
        kind: "redirect",
        location: `/pypi/${ctx.product.slug}/simple/${norm}/`,
      };
    const project = await findProject(ctx, norm);
    return project ? { kind: "found", project, norm } : { kind: "absent" };
  },
  deliverableId: namedId,
  async serve(req, ctx, cache, state) {
    if (state.kind === "absent") return registryNotFound("pypi");
    if (state.kind === "redirect") return redirect(state.location);
    const form = await chosenForm(req, ctx);
    if (form === "not-acceptable") return notAcceptable();
    const pkg = await loadPypiPackage(ctx, state.project);
    if (!pkg) return registryNotFound("pypi");
    const res = await freshPageResponse(
      ctx,
      pkg,
      projectPageKey(state.norm, form),
      cache,
    );
    return res ? simpleHeaders(res, form) : registryNotFound("pypi");
  },
});

// ── Files and their PEP 658 metadata ─────────────────────────────────────────────────────────

/** What a file URL names inside one package: the bytes to serve and the name to give them. */
interface FileHit {
  readonly file: PackageFile;
}

/**
 * The file `<sha256>/<filename>` names in `pkg`: a listed wheel or sdist with that name and hash,
 * or, for `<wheel>.metadata`, the `core-metadata` file of the wheel with that name and hash.
 */
export function fileIn(
  pkg: RegistryPackage,
  sha256: string,
  filename: string,
): FileHit | null {
  const metadata = filename.endsWith(".metadata");
  const wanted = metadata ? filename.slice(0, -".metadata".length) : filename;
  for (const v of pkg.versions) {
    const owner = v.files.find(
      (f) =>
        f.name === wanted &&
        f.sha256 === sha256 &&
        (metadata
          ? f.type === "wheel"
          : f.type === "wheel" || f.type === "sdist"),
    );
    if (!owner) continue;
    if (!metadata) return { file: owner };
    const meta = v.files.find(
      (f) => f.name === filename && f.type === "core-metadata",
    );
    return meta ? { file: meta } : null;
  }
  return null;
}

/** The owner's projects a filename could belong to, longest name first (`foo-bar` before `foo`). */
async function candidateProjects(ctx: RegistryRouteContext, filename: string) {
  const norm = normalizeProjectName(filename);
  return (await pypiProjects(ctx))
    .filter((d) => norm.startsWith(`${normalizeProjectName(d.name)}-`))
    .sort((a, b) => b.name.length - a.name.length);
}

type FileState = Named<{
  readonly project: CatalogPackageDeliverable;
  readonly hit: FileHit;
}>;

const files: RegistryRoute = feedRoute<FileState>({
  name: "pypi.files",
  ecosystem: "pypi",
  match(pathname) {
    const m = new RegExp(`^/pypi/${OWNER}/files/([0-9a-f]{64})/([^/]+)$`).exec(
      pathname,
    );
    return m ? { owner: m[1]!, params: { sha256: m[2]!, file: m[3]! } } : null;
  },
  async resolve(_req, ctx): Promise<FileState> {
    let filename: string;
    try {
      filename = decodeURIComponent(ctx.params.file!);
    } catch {
      return { kind: "absent" };
    }
    const sha256 = ctx.params.sha256!;
    for (const project of await candidateProjects(ctx, filename)) {
      const pkg = await loadPypiPackage(ctx, project);
      const hit = pkg ? fileIn(pkg, sha256, filename) : null;
      if (hit) return { kind: "found", project, hit };
    }
    return { kind: "absent" };
  },
  deliverableId: namedId,
  async serve(req, ctx, cache, state) {
    if (state.kind !== "found") return registryNotFound("pypi");
    const { hit } = state;
    const bucket = ctx.env.BLOBS;
    if (!bucket) return registryNotFound("pypi");
    // The bytes are this owner's: the package names them, and the owner must hold the
    // ref too (`hasRef`), so no feed can serve an object it never published.
    for (const gated of [false, true]) {
      const key = blobKey(hit.file.sha256, { gated });
      if (!(await hasRef(ctx.db, ctx.product.slug, key))) continue;
      const res = await blobResponse(req, bucket, key, {
        sha256: hit.file.sha256,
        gated: gated || cache !== "public",
        env: ctx.env,
        host: "console",
        filename: hit.file.name,
      });
      return res.status === 404 ? registryNotFound("pypi") : res;
    }
    return registryNotFound("pypi");
  },
});

/** Every PyPI route, in match order. */
export const PYPI_ROUTES: readonly RegistryRoute[] = [
  simpleIndex,
  simpleProject,
  files,
];
