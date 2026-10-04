/// <reference types="@cloudflare/workers-types" />
/**
 * OCI's token service, `GET /v2/token` (F-21, plans/F-20.md §6.4; the distribution token spec,
 * https://distribution.github.io/distribution/spec/auth/token/). The realm every non-public OCI
 * feed's Bearer challenge names, and the one owner-less route on the registry host: the owners
 * are in the `scope` parameters, so the handler loads each one itself (at most four scopes).
 *
 *   `docker login pkg.plrs.im -u __token__ --password-stdin` → `GET /v2/` (401 Bearer) →
 *   `GET /v2/token?service=pkg.plrs.im` with `Basic __token__:<pkeyr_…>` → a pull token →
 *   `GET /v2/` with `Bearer <pull token>` → 200. A pull then asks for
 *   `scope=repository:<owner>/<repo>:pull` and presents the pull token on every request.
 *
 * WHAT IS GRANTED. Pull, per scope, when the access ladder (`authorizeFeedRead`) admits the
 * caller for that repository: with no credential only public repositories (an anonymous token,
 * which keeps public pulls working once `/v2/` challenges), with Basic `__token__:<pkeyr_ or
 * pkeyci_>` per §6.2. A scope is all or nothing: a request any of whose scopes is refused gets
 * no token. `push`, `delete`, `*` and `registry:catalog:*` are refused (F-23 adds push).
 *
 * REFUSALS, so it is no oracle. No credential, or one that resolves to nothing, is 401 with a
 * Basic challenge, the same for an unknown, disabled or private owner. A valid credential
 * refused a scope (another owner's private repository, a licence not entitled, a non-pull
 * action) is 403 `DENIED`. A missing `REGISTRY_TOKEN_KEY` is 503 `UNAVAILABLE`. The
 * `registryOciToken` budget (per IP, fail closed) is 429 `TOOMANYREQUESTS`.
 *
 * THE PULL TOKEN carries identity only (`core/registryTokens.ts`): every OCI request re-resolves
 * its subject and re-runs the ladder, so revocation and a tightened feed take effect within 30 s.
 */

import { clientIp, rateLimitOk } from "../../../../core/rateLimit.js";
import {
  registryHostname,
  type OwnerlessRegistryRoute,
} from "../../../../core/registryHost.js";
import { json } from "../../../../core/errors.js";
import {
  isPullToken,
  lookupRegistryCredential,
  principalOf,
  registryTokenKeyConfigured,
  signPullToken,
} from "../../../../core/registryTokens.js";
import {
  authorizeFeedRead,
  extractFeedCredential,
  type FeedPrincipal,
} from "../authorize.js";
import { OCI_REPOSITORY_RE } from "./render.js";
import { ociDeliverable } from "./source.js";
import { OCI_API_VERSION } from "./routes.js";

/** The most scopes one token request may name. */
export const MAX_TOKEN_SCOPES = 4;

/** `registryOciToken` (§6.6): per client IP, fail closed (the route mints). */
const TOKEN_LIMIT = { limit: 120, windowSec: 60 };

/** The limiter object the owner-less route counts in (there is no owner to key on). */
const LIMITER = "registry";

const HEADERS = {
  "docker-distribution-api-version": OCI_API_VERSION,
} as const;

function ociRefusal(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    { errors: [{ code, message }] },
    { status, headers: { ...HEADERS, ...headers } },
  );
}

/** One parsed `repository:<owner>/<repo>:<actions>` scope. */
interface Scope {
  readonly owner: string;
  readonly repository: string;
  readonly pullOnly: boolean;
}

/** The scopes a request names, or `null` when one is not a repository scope we know. */
function parseScopes(url: URL): Scope[] | null {
  const raw = url.searchParams
    .getAll("scope")
    .flatMap((s) => s.split(" "))
    .filter((s) => s !== "");
  const out: Scope[] = [];
  for (const s of raw) {
    const m = /^repository:([a-z0-9-]{1,64})\/(.+):([a-z*,]+)$/.exec(s);
    if (!m || !OCI_REPOSITORY_RE.test(m[2]!)) return null;
    const actions = m[3]!.split(",").filter((a) => a !== "");
    out.push({
      owner: m[1]!,
      repository: m[2]!,
      pullOnly: actions.length > 0 && actions.every((a) => a === "pull"),
    });
  }
  return out;
}

export const OCI_TOKEN_ROUTE: OwnerlessRegistryRoute = {
  ownerless: true,
  name: "oci.token",
  ecosystem: "oci",
  matches: (pathname) => pathname === "/v2/token",
  async handle(req, ctx) {
    const head = req.method === "HEAD";
    const host = registryHostname(ctx.env) ?? "pkg.plrs.im";
    const ip = clientIp(req);
    const unauthorized = () =>
      ociRefusal(401, "UNAUTHORIZED", "authentication required", {
        "www-authenticate": `Basic realm="${host}"`,
      });
    const denied = () =>
      ociRefusal(403, "DENIED", "requested access to the resource is denied");
    if (
      !(await rateLimitOk(
        ctx.env,
        LIMITER,
        { bucket: "registryOciToken", id: ip, ...TOKEN_LIMIT },
        ctx.now,
      ))
    )
      return ociRefusal(429, "TOOMANYREQUESTS", "too many requests", {
        "retry-after": "60",
      });
    if (!registryTokenKeyConfigured(ctx.env))
      return ociRefusal(
        503,
        "UNAVAILABLE",
        "the token service is not configured",
      );
    const url = new URL(req.url);
    const service = url.searchParams.get("service");
    if (service !== null && service !== host) return unauthorized();
    // `registry:catalog:*` and any other scope kind are refused.
    const scopes = parseScopes(url);
    if (scopes === null || scopes.length > MAX_TOKEN_SCOPES) return denied();

    // The credential: Basic `__token__:<token>` (docker, oras, crane), or any header shape the
    // extractor reads. A pull token is not a credential for minting another.
    const credential = extractFeedCredential(req);
    let principal: FeedPrincipal = { kind: "anonymous" };
    if (credential !== null) {
      if (isPullToken(credential.token)) return unauthorized();
      const { resolved, miss } = await lookupRegistryCredential(
        ctx.env,
        ctx.db,
        credential.token,
        ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {},
      );
      if (
        miss &&
        !(await rateLimitOk(
          ctx.env,
          LIMITER,
          {
            bucket: "registryCredentialMiss",
            id: ip,
            limit: 30,
            windowSec: 60,
          },
          ctx.now,
        ))
      )
        return ociRefusal(429, "TOOMANYREQUESTS", "too many requests", {
          "retry-after": "60",
        });
      // A URL token (Godot's) is never an OCI credential.
      if (
        resolved === null ||
        (resolved.kind !== "ci" && resolved.presentation !== "header")
      )
        return unauthorized();
      principal = principalOf(resolved);
      if (principal.kind === "anonymous") return unauthorized();
    }
    const anonymous = principal.kind === "anonymous";
    const refuse = () => (anonymous ? unauthorized() : denied());

    const repos: string[] = [];
    for (const scope of scopes) {
      if (!scope.pullOnly) return refuse();
      const owner = await ctx.ownerContext(scope.owner, "oci", {
        repository: scope.repository,
      });
      if (!owner) return refuse();
      const catalog = owner.hooks.releaseCatalog();
      const deliverable = catalog
        ? await ociDeliverable(catalog, scope.repository)
        : null;
      const decision = await authorizeFeedRead(
        {
          db: owner.db,
          env: owner.env,
          services: owner.product.services,
          repository: scope.repository,
          ip,
          ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
        },
        credential,
        owner.product.slug,
        "oci",
        deliverable?.id ?? null,
      );
      if (!decision.ok) {
        if (decision.challenge === "rate-limited")
          return ociRefusal(429, "TOOMANYREQUESTS", "too many requests", {
            "retry-after": "60",
          });
        return refuse();
      }
      repos.push(`${scope.owner}/${scope.repository}`);
    }
    const signed = await signPullToken(
      ctx.env,
      {
        sub:
          principal.kind === "anonymous"
            ? "anonymous"
            : principal.kind === "ci"
              ? `ci:${principal.tokenId}`
              : principal.tokenId,
        own: principal.kind === "anonymous" ? null : principal.product,
        repos,
      },
      ctx.now,
    );
    if (!signed)
      return ociRefusal(
        503,
        "UNAVAILABLE",
        "the token service is not configured",
      );
    const body = JSON.stringify({
      token: signed.token,
      access_token: signed.token,
      expires_in: signed.expiresIn,
      issued_at: new Date(signed.issuedAt * 1000).toISOString(),
    });
    return new Response(head ? null : body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...HEADERS,
      },
    });
  },
};
