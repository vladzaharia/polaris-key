/**
 * The fake identity provider `pkey dev` signs people in with: an OIDC authorize page with an
 * Approve button, a token endpoint and a JWKS, all on the dev origin under `/__idp/`. The product's
 * Identity service reaches it as a custom OIDC provider, so device-code and browser sign-in run
 * the Worker's real code on either side of one fake person.
 */
import { signJws } from "@polaris-key/jws";
import type { IdpFacts } from "./world.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f9;--fg:#15151a;--mut:#5d5d68;--card:#fff;--line:#d8d8e0;--acc:#4b4bd6;--accfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#101014;--fg:#ececf2;--mut:#a0a0ac;--card:#1a1a20;--line:#2e2e38;--acc:#8c8cf5;--accfg:#10101a}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{width:min(26rem,100%);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:.25rem 0 1rem;color:var(--mut)}
.who{border:1px solid var(--line);border-radius:8px;padding:.75rem;margin:0 0 1rem}.who b{display:block}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
button{font:inherit;padding:.6rem 1rem;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.go{background:var(--acc);color:var(--accfg);border-color:var(--acc)}
small{display:block;margin-top:1rem;color:var(--mut)}
</style><main>${body}</main></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * The Worker only dials an https issuer without a port on a public-looking host
 * (`core/oidc/client.ts`), so every dev server supplies a unique https `.test` issuer. The dev
 * server answers the Worker's own requests to it in-process, and rewrites browser redirects to
 * its `/__idp/` path.
 */

/** A tiny in-memory code store: one-shot, 5 minutes. */
interface Pending {
  nonce: string;
  redirectUri: string;
  at: number;
}

export function createIdp(facts: IdpFacts, opts: { autoApprove: boolean }) {
  const codes = new Map<string, Pending>();
  const base = facts.issuer ?? "";

  function approve(
    params: URLSearchParams,
    result: "approve" | "deny",
  ): Response {
    const redirect = params.get("redirect_uri") ?? "";
    let back: URL;
    try {
      back = new URL(redirect);
    } catch {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    if (result === "deny") {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = `dev${crypto.randomUUID().replace(/-/g, "")}`;
      codes.set(code, {
        nonce: params.get("nonce") ?? "",
        redirectUri: redirect,
        at: Date.now(),
      });
      back.searchParams.set("code", code);
    }
    const state = params.get("state");
    if (state) back.searchParams.set("state", state);
    back.searchParams.set("iss", base);
    return new Response(null, {
      status: 302,
      headers: { location: back.toString(), "cache-control": "no-store" },
    });
  }

  /** `path` is the IdP's own (`/authorize`), however the request reached it. */
  return async function handleIdp(
    req: Request,
    url: URL,
    path: string,
  ): Promise<Response> {
    if (!facts.issuer) return json({ error: "no_identity_service" }, 404);

    if (path === "/authorize" && req.method === "GET") {
      if (opts.autoApprove) return approve(url.searchParams, "approve");
      const fields = [...url.searchParams]
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
        )
        .join("");
      return page(
        "Sign in",
        `<h1>Sign in with the dev identity provider</h1>
<p>A fake provider run by pkey dev. Its one person is made up, and its address counts as verified.</p>
<div class="who"><b>${esc(facts.person.name)}</b>${esc(facts.person.email)}</div>
<form method="post" action="/__idp/authorize">${fields}
<div class="row"><button class="go" name="result" value="approve">Approve</button><button name="result" value="deny">Deny</button></div></form>
<small>Pass --auto-approve to skip this page.</small>`,
      );
    }
    if (path === "/authorize" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      return approve(form, form.get("result") === "deny" ? "deny" : "approve");
    }
    if (path === "/.well-known/openid-configuration")
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["EdDSA"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const code = form.get("code") ?? "";
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending || Date.now() - pending.at > 300_000)
        return json({ error: "invalid_grant" }, 400);
      const t = Math.floor(Date.now() / 1000);
      const idToken = await signJws(
        {
          iss: facts.issuer,
          aud: facts.clientId,
          iat: t,
          exp: t + 300,
          nonce: pending.nonce,
          ...facts.person,
          // The dev provider vouches for its own made-up address, so the Worker's verifier, which
          // trusts an email only when `email_verified === true`, keeps it. Production is untouched.
          email_verified: true,
        },
        facts.pem,
        facts.kid,
      );
      return json({ id_token: idToken, token_type: "Bearer" });
    }
    if (path === "/.well-known/jwks.json") return json({ keys: [facts.jwk] });
    return json({ error: "not_found" }, 404);
  };
}
