/**
 * Platform → Connections (I-31; plans/I-27.md §2.3): the operator's side of the platform's
 * upstream OpenID Connect providers, and the status of the other sign-in plumbing.
 *
 *   GET    /api/platform/connections                 the page: connections with their domains,
 *                                                    the built-in providers, email and Turnstile
 *                                                    status, and the redirect URI to register
 *   GET    /api/platform/connections/:id             one connection
 *   POST   /api/platform/connections                 add (step-up)
 *   PATCH  /api/platform/connections/:id             change, rotate the secret, enable/disable (step-up)
 *   DELETE /api/platform/connections/:id             delete (step-up; refused while people sign in through it)
 *   POST   /api/platform/connections/discover        run discovery for an issuer (nothing saved)
 *   POST   /api/platform/connections/test/start      begin a test sign-in; sets the flow's binding cookie
 *   GET    /api/platform/connections/test/result     the test's claims preview, once, to its operator
 *   POST   /api/platform/connections/:id/domains              claim a domain (step-up)
 *   POST   /api/platform/connections/:id/domains/verify       check the TXT record now (step-up)
 *   PATCH  /api/platform/connections/:id/domains/:domain      require the connection for it (step-up)
 *   DELETE /api/platform/connections/:id/domains/:domain      release it (step-up)
 *
 * The route table (`../routes.ts`) holds the area (`platform`) and the step-up; this handler
 * never sees a secret in a response: a client secret goes in, sealed, and only "set" comes out.
 * Discovery, the test and DNS checks are rate-limited per operator. Every change is audited in
 * `platform_audit` (`identity.connection.*`), in the batch that makes it. Admin API routes are
 * narrative-only under AGENTS.md rule 10 (`adminApi` in `routeCoverage.test.ts`).
 */

import { ErrorCode } from "../../core/errors.js";
import { actorOf } from "../../core/audit.js";
import { customerSiteOrigin } from "../../core/hosts.js";
import { emailConfigured } from "../../core/notify/destinations.js";
import {
  AdminBodyError,
  adminJson,
  err,
  readBody,
} from "../../core/console/respond.js";
import { credentialCheckAllowed } from "../../core/stores/credentialCheck.js";
import {
  accountRealmCookie,
  PORTAL_SSO_COOKIE,
} from "../../core/accounts/accountCookies.js";
import {
  changeDomain,
  connectionView,
  createConnection,
  deleteConnection,
  listConnectionViews,
  previewDiscovery,
  SIGNIN_PROVIDER_KINDS,
  signInProviderConfigured,
  signInRegistration,
  signInRegistrations,
  signInSites,
  startConnectionTest,
  takeTestResult,
  turnstileEnabled,
  updateConnection,
  type ConnectionRefusal,
  type DomainAction,
} from "../../services/identity/public.js";
import { isSuperadmin } from "../../core/rbac/can.js";
import type { AdminCtx } from "../routes.js";

const BUILTIN_LABELS = {
  google: "Google",
  apple: "Apple",
  steam: "Steam",
} as const;

/** A path segment as text; a malformed escape is a name no domain has. */
const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

const refusal = (r: ConnectionRefusal): Response =>
  err(r.status, r.code, r.message, r.fields ? { fields: r.fields } : undefined);

const tooMany = (): Response =>
  err(
    429,
    "rate_limited",
    "Too many checks. Wait a few minutes, then try again.",
  );

async function page(c: AdminCtx): Promise<Response> {
  const url = new URL(c.req.url);
  // Primary first: the customer origin (Polaris Locker) when set, then this console's own.
  const sites = signInSites(url.origin, customerSiteOrigin(c.env));
  return adminJson({
    connections: await listConnectionViews(c.db),
    redirectUri: `${(sites[0] ?? { origin: url.origin }).origin}/callback`,
    redirectUris: sites.map((s) => ({
      site: s.site,
      label: s.label,
      value: `${s.origin}/callback`,
    })),
    builtIns: SIGNIN_PROVIDER_KINDS.map((kind) => ({
      kind,
      label: BUILTIN_LABELS[kind],
      configured: signInProviderConfigured(c.env, kind),
      // What to register at the provider: one exact URI (Steam: the realm), from the same
      // helper the login flow builds its own with.
      registration: signInRegistration(kind, sites[0]!.origin),
      registrations: signInRegistrations(kind, sites),
    })),
    email: { configured: emailConfigured(c.env) },
    turnstile: { enabled: turnstileEnabled(c.env) },
  });
}

export async function handlePlatformConnections(
  c: AdminCtx,
): Promise<Response> {
  try {
    return await route(c);
  } catch (e) {
    if (e instanceof AdminBodyError)
      return err(e.status, e.code, e.message, e.extra);
    throw e;
  }
}

async function route(c: AdminCtx): Promise<Response> {
  const { req, env, db, session, now } = c;
  const actor = actorOf(session);
  const rest = c.segments.slice(2); // after platform/connections
  // An operator-audience connection is what access rules trust: only a Superadmin writes one.
  const gate = { superadmin: isSuperadmin(session.principal) };
  const method = req.method;
  const [a, b, d] = rest;

  if (rest.length === 0) {
    if (method === "GET") return page(c);
    const body = await readBody(req);
    const r = await createConnection(env, db, body, actor, now, gate);
    return r.ok
      ? adminJson({ ok: true, connection: r.connection }, 201)
      : refusal(r);
  }
  if (a === "discover" && rest.length === 1) {
    const body = await readBody(req);
    if (!(await credentialCheckAllowed(env, session.sub, now)))
      return tooMany();
    const r = await previewDiscovery(body, new URL(req.url).origin);
    return r.ok ? adminJson({ ok: true, discovery: r.preview }) : refusal(r);
  }
  if (a === "test") {
    if (b === "start" && method === "POST") {
      const body = await readBody(req);
      if (!(await credentialCheckAllowed(env, session.sub, now)))
        return tooMany();
      const draftId = typeof body.draftId === "string" ? body.draftId : "";
      const r = await startConnectionTest(
        env,
        db,
        {
          sub: session.sub,
          draftId,
          ...(typeof body.connectionId === "string"
            ? { connectionId: body.connectionId }
            : {}),
          issuer: body.issuer,
          clientId: body.clientId,
          clientSecret: body.clientSecret,
          jwksUri: body.jwksUri,
          ...(body.claimMap !== undefined ? { claimMap: body.claimMap } : {}),
        },
        new URL(req.url).origin,
      );
      if (!r.ok)
        return err(
          r.status,
          r.code,
          r.message,
          r.fields ? { fields: r.fields } : undefined,
        );
      return adminJson({ ok: true, url: r.url, state: r.state }, 200, {
        "set-cookie": accountRealmCookie(PORTAL_SSO_COOKIE, r.binding, 600),
      });
    }
    if (b === "result" && method === "GET") {
      const q = new URL(req.url).searchParams;
      const result = await takeTestResult(env, {
        sub: session.sub,
        draftId: q.get("draft") ?? "",
        state: q.get("state") ?? "",
      });
      if (!result)
        return err(
          404,
          ErrorCode.NotFound,
          "No test result. Run the test again.",
        );
      return adminJson({ ok: true, result });
    }
    return err(404, ErrorCode.NotFound);
  }
  const id = a!;
  if (rest.length === 1) {
    if (method === "GET") {
      const v = await connectionView(db, id);
      return v ? adminJson({ connection: v }) : err(404, ErrorCode.NotFound);
    }
    if (method === "PATCH") {
      const r = await updateConnection(
        env,
        db,
        id,
        await readBody(req),
        actor,
        now,
        gate,
      );
      return r.ok
        ? adminJson({ ok: true, connection: r.connection })
        : refusal(r);
    }
    if (method === "DELETE") {
      const r = await deleteConnection(db, id, actor, now);
      return r.ok ? adminJson({ ok: true }) : refusal(r);
    }
    return err(405, "method_not_allowed", "method not allowed");
  }
  if (b === "domains") {
    let action: DomainAction | null = null;
    if (rest.length === 2 && method === "POST") {
      action = { op: "add", domain: (await readBody(req)).domain };
    } else if (rest.length === 3 && d === "verify" && method === "POST") {
      const body = await readBody(req);
      if (typeof body.domain !== "string") {
        return err(422, "invalid_domain", "Name the domain.", {
          fields: ["domain"],
        });
      }
      if (!(await credentialCheckAllowed(env, session.sub, now)))
        return tooMany();
      action = { op: "verify", domain: body.domain };
    } else if (rest.length === 3 && method === "DELETE") {
      action = { op: "remove", domain: decoded(d!) };
    } else if (rest.length === 3 && method === "PATCH") {
      const body = await readBody(req);
      if (typeof body.enforce !== "boolean") {
        return err(422, "invalid_enforce", "Enforce is true or false.", {
          fields: ["enforce"],
        });
      }
      action = {
        op: "enforce",
        domain: decoded(d!),
        enforce: body.enforce,
      };
    }
    if (!action) return err(404, ErrorCode.NotFound);
    const r = await changeDomain(db, id, action, actor, now, gate);
    return r.ok
      ? adminJson({
          ok: true,
          connection: r.connection,
          ...(r.verify ? { verify: r.verify } : {}),
        })
      : refusal(r);
  }
  return err(404, ErrorCode.NotFound);
}
