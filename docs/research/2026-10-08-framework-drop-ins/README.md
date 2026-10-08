# Framework drop-ins: servers, CLIs and terminal apps (2026-10-08)

The owner, 2026-10-08:

> "For servers, can we have drop ins in the form of libraries/helpers for specific frameworks?
> Stuff like authentication middleware for Hono/ExpressJS, etc"
>
> "TUI/CLI frameworks also exist and would be a great drop-in as well"

This reverses one line of the SDK usability review: "Servers need none: there the library is the
drop-in" (`docs/research/2026-10-08-sdk-usability/README.md` §3 item 1 and the "Node, server" row of
§4.2, on branch `research/sdk-usability`). It also widens that review's CLI packages, UK-46 and
UK-48, rather than duplicating them.

**Scope.** The languages that already have server-capable SDKs: Node, Python, Swift and Kotlin/JVM.
No Go SDK or middleware (owner, 2026-10-08). This is a plan only; nothing in it is implemented.

**Ids.** `main` ends at SP-40 and UK-44. The SDK usability review registered SP-41 to SP-52 and
UK-45 to UK-50 on `program/dx-plans-w0`, so this plan takes **SP-53 to SP-68** and **UK-51 to
UK-54**, which fit `check.mjs`'s `ID_RE`. Names in code samples are proposals; SP-35's `api.json`
registers them with a `layer` of `server` or `cli`.

---

## 1. Summary

- **A drop-in is the framework's own shape:** middleware, a guard, a dependency or a plugin for a
  server; a mounted command group plus a gate for a CLI. Each is a thin adapter over one core per
  language.
- **The server credential already exists.** The app sends its signed licence document
  (`pkey-license+jws`) in a new `X-PKey-License` header. The backend verifies it offline against
  the product's pinned keys and the signed trust manifest. There is no new Polaris Key endpoint.
- **The default freshness is the document's own one-hour expiry**, plus 300 s of skew. A revoked
  device stops getting fresh documents, so a revocation reaches every backend within about 65
  minutes. `maxAgeSeconds` tightens this.
- **The client half ships in all six SDKs:** `client.backend.fetch()` and `client.backend.headers()`.
  They refresh a document that is about to expire, send it only to allowed origins, and retry once
  on `license_stale`.
- **Wire impact.** The Worker↔SDK wire does not change, and `PROTOCOL_VERSION` stays 4. Two changes
  need plan mode:
  - a new cross-SDK contract (SP-53): the header, the verdict order, four error codes and a
    generated `backend-matrix.json`;
  - one optional member in a signed document (SP-54): `profile.user.subject` on every signed-in
    device, which `requireSignIn()` needs.
- **Node packaging:** one new package, `@polaris-key/server`. Its root is a Web-Fetch core that runs
  on edge runtimes, and each framework is a subpath with an optional peer dependency.
- **Must tier.**
  - Servers: Express, Hono and Next.js; FastAPI/Starlette, Django with DRF, and Flask; Ktor.
  - CLIs: Commander, yargs, argparse, click and typer.
- **20 new packages**, about **20–27 engineer-weeks** in total. The must tier is about 9–13 weeks.
  Nineteen existing packages get edits (§12.2).
- **Webhooks:** Polaris Key sends none today, so `polarisWebhook()` waits for a deferred plan
  (SP-66) on Standard Webhooks.

## 2. What exists today

### 2.1 Server-side code, per SDK

| SDK                                    | What a server can call                                                                                                                                                                                                                                                                                                                                                                                                                        | Gaps                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Node                                   | `verifyLicenseDocument(jws, {trust, product, deviceId, now})` from `@polaris-key/node/server` (`packages/sdk-node/src/server.ts`). It checks signature, audience, device binding and the gate (`ok`, `grace` or `expired`) and returns `ageSeconds`, `isEntitled` and `entitlementValue`. It passes `checkFreshness: false`, so a document is good until `graceUntil`. `crashTagsFor` builds Sentry tags and has nothing to do with requests. | No middleware, no trust-manifest refresh, no error body. The package needs Node ≥ 22.13 and pulls in the client.                           |
| client-core                            | `verifyLicenseDoc` (`packages/client-core/src/verify.ts:145`) checks freshness by default: `expiresAt` plus 300 s.                                                                                                                                                                                                                                                                                                                            | Verification only.                                                                                                                         |
| Python                                 | `verify_license_doc(jws, pinned_keys, expected_aud=, device_id=)` (`sdks/python/src/polaris_key/__init__.py:231`).                                                                                                                                                                                                                                                                                                                            | No server module. The recipe page says a server helper "is planned".                                                                       |
| Swift                                  | `verifyLicenseDoc` in `PolarisKeyCore`.                                                                                                                                                                                                                                                                                                                                                                                                       | macOS 14 and iOS 17 only, on CryptoKit (`sdks/swift/Package.swift`, `JWSVerifier.swift:41`). It does not build on Linux, where Vapor runs. |
| Kotlin                                 | `:core` `Verify.kt` on the JVM (JCA, Tink).                                                                                                                                                                                                                                                                                                                                                                                                   | No server API.                                                                                                                             |
| `examples/node-express/server.ts`      | A hand-written `requireLicense()`. It reads `X-PKey-License` and `X-PKey-Device`, bounds the age at 3 days and answers `{error:{code}}`.                                                                                                                                                                                                                                                                                                      | Its comment points at `getSyncState().doc`, which holds the decoded document and cannot give back the JWS.                                 |
| `build/recipes/server-verification.md` | The client-core path (one hour) and the Python path.                                                                                                                                                                                                                                                                                                                                                                                          | Says a client getter for the document "is planned".                                                                                        |

### 2.2 What a backend can verify, per service

| Service                | Artefact a backend could check                                                                                                                                                                                                                                                                                                | Verifiable offline today?                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licensing              | The licence document (WIRE-CONTRACT-V4 §2.1): `licenseId`, `deviceId`, the holder's `profile` (name and email), and `entitlements`, which include the enforced `license.tier`.                                                                                                                                                | **Yes**, against the pins plus the signed trust manifest (`/<p>/.well-known/polaris-trust.jws`, `packages/worker/src/router.ts:186`). The document expires an hour after it is signed (`DOC_EXPIRY_SECONDS`, `shared-protocol/src/core.ts:304`). Revocation is not visible offline (V4 §4.3).                                                                                                                                                               |
| Identity and sign-in   | Polaris Key is an OIDC **relying party** today: it verifies IdP ID tokens (`services/identity/oidc.ts`, `idToken.ts`) and issues none. Devices hold `pkeyt_` tokens, which are hash-stored and must never be forwarded. The browser session is a cookie on `key.plrs.im` (`services/identity/doc.ts`) and retires with SP-40. | **No.** The licence document names the holder, not the person signed in. `devices.subject`, the pairwise `ps_…`, never leaves the Worker except to the console. I-08 adds OAuth-shaped `authorize` and `token`, but they return a device token (`openid` answers `invalid_scope` until I-21). I-21 adds a per-product issuer with an RS256 JWKS. I-24 (deferred) puts `profile.user` in the document, but only for named-user seats (`plans/I-24.md` §2.1). |
| Managed config, flags  | The config document is per device and carries `secrets`, so it must never be forwarded.                                                                                                                                                                                                                                       | Only if the server is a device itself (§5.7). Entitlement flags already ride the licence document.                                                                                                                                                                                                                                                                                                                                                          |
| Webhooks, events       | None are sent. `subject_events` (`services/identity/accounts/events.ts`) and `entitlement_events` (`core/entitlementEvents.ts`) are **pull** feeds by owner decision (`plans/I-04.md` Q8, `plans/LX-01.md` Q4).                                                                                                               | No. CM-22 plans a `purchase.refunded` webhook and ST-27 plans signed operator alerts. No signing format is fixed.                                                                                                                                                                                                                                                                                                                                           |
| Commerce               | Store purchases become licences and entitlements (CM-25). Receipts never reach a backend.                                                                                                                                                                                                                                     | Through the licence document's entitlements.                                                                                                                                                                                                                                                                                                                                                                                                                |
| A backend's own access | There is no product server credential. `pkeyci_` tokens carry release and distribution scopes only (`core/ciVocabulary.ts`). LX-13 and U-16 need a server credential (SDK-PARITY-PASS §6 W12). Edge mint (`services/config/mint.ts`) signs third-party tokens with static claims; it is not a per-user credential.            | Online checks wait for LX-13.                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 2.3 How an app sends credentials to its own backend today

- **No SDK has a helper.**
  - Node exposes only the decoded document (`client.ts:492`); the JWS stays in its cache
    (`core/cache.ts:166`).
  - Swift and Kotlin reach the JWS through Core's public `CachedDoc.jws`
    (`CoreContext.swift:163`, `CoreContext.kt:89`), which is undocumented.
  - Python, React and Godot do not expose the JWS at all.
- **The only convention is the example's** `X-PKey-License` plus `X-PKey-Device`. It is not in
  `shared-protocol`: `core.ts:311-317` lists the Worker's headers only.
- **Today's materials give three different freshness answers:** one hour (client-core and the
  recipe), until `graceUntil` (`node/server`) and three days (the example).

### 2.4 CLIs and terminal apps today

- **Node, `@polaris-key/node/cli`:**
  - commander: `registerPolarisCommands(program, factory, options)` (`cli/commander.ts:78`);
  - yargs: `registerYargsCommands` and `polarisCommandModule` (`cli/yargs.ts:75`, `:204`).
  - Both share `runKitVerb` (`cli/adapter.ts`) over 25 verbs (`CLI_VERBS`, `cli/kit.ts:618`).
  - The parity pass names citty, but it is not built.
  - Every verb is mounted, a name collision throws, and there is no gate helper. UK-46 fixes this.
- **Python, `polaris_key.cli`:**
  - `register_argparse`, `polaris_click_group` and `polaris_typer_app` (`cli/__init__.py:59-73`)
    run over one verb table (`cli/verbs.py`);
  - there is a full-screen Textual app (`ui/terminal/textual_app.py`) and the extras `click`,
    `typer`, `cli` and `tui` (`pyproject.toml:30`);
  - every verb asks for `--product`, and there is no gate. UK-48 fixes this.
- **Swift** has no CLI kit. **Kotlin** has only a hand-rolled sample (`samples/cli/…/Main.kt`).
- **Exit codes:** `EXIT = {ok: 0, failed: 1, usage: 2, interrupted: 130}` (`cli/json.ts:22`).
  `status` exits 1 when the licence is not usable (`cli/models.ts:494`).

## 3. Prior art, and what we take from it

| Pattern                                                  | Seen in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | What we do                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticate everywhere, refuse per route                | Clerk's `clerkMiddleware()` attaches `req.auth`, read with `getAuth(req)`; Clerk deprecated `requireAuth()` because it redirected [S1]. Auth0's `auth()` answers 401, then `requiredScopes` and `claimCheck` refine it [S4].                                                                                                                                                                                                                                                                                                                   | `polarisKey()` attaches and never refuses. `requireLicense()`, `requireEntitlement(name)` and `requireSignIn()` refuse, and none of them redirects. |
| Use each framework's own seam                            | Hono `createMiddleware`, typed `Variables`, `c.var` [S9] · Fastify `decorateRequest` with `fastify-plugin` [S10] · Nest `CanActivate` and `createParamDecorator` [S11] · FastAPI `Depends` and `Annotated` [S13] · Flask decorators and `g` [S14] · Django middleware; DRF `authenticate()` returns `(user, auth)`, and a 401 must carry `WWW-Authenticate` [S15] · Vapor `Authenticatable` and `req.auth.require` [S16] · Ktor `install(Authentication)`, `challenge`, `call.principal` [S17] · Spring Security filters and authorities [S18] | One adapter per framework (§5.4). Each is native and has no wrapper DSL.                                                                            |
| Next.js: verify in the handler                           | Next 16 renamed `middleware` to `proxy` (Node runtime) and says "Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone" [S12].                                                                                                                                                                                                                                                                                                                                                         | The Next.js adapter wraps route handlers and ships no proxy gate.                                                                                   |
| Verify locally; refresh keys; go online only when needed | Clerk's networkless `jwtKey` and `authorizedParties` [S2] · Supabase's `getClaims()` (local, cached JWKS) versus `getUser()` (a network call) [S6] · Keygen's signed licence files, and its advice to reject responses older than five minutes [S19].                                                                                                                                                                                                                                                                                          | Verify locally, and refresh the signed trust manifest on a schedule and on an unknown `kid`. Online checks come later (§13 Q7).                     |
| Short-lived credentials                                  | Clerk's session tokens live 60 s and are refreshed every minute [S3].                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Our document lives an hour. `maxAgeSeconds` tightens it, and the client half refreshes ahead of expiry.                                             |
| Machine-readable refusals that the app can override      | RFC 6750 `WWW-Authenticate` with `invalid_token` and `insufficient_scope`; Auth0 hands the error to Express's error handler [S4] · RFC 9457 problem details [S20].                                                                                                                                                                                                                                                                                                                                                                             | A `problem+json` body with a stable `code`, a `PKey-License` challenge, an `onRefusal` hook and `errors: "throw"`.                                  |
| Webhooks                                                 | Stripe's `constructEvent` needs the raw body and allows 5 minutes of tolerance [S7] · Standard Webhooks `webhook-id`/`-timestamp`/`-signature`, `v1` HMAC (`whsec_`), `v1a` Ed25519 (`whpk_`), rotation by sending several signatures [S8] · Lemon Squeezy's `X-Signature` with `timingSafeEqual` [S21] · RevenueCat's Authorization header, optional HMAC and 5 retries [S22].                                                                                                                                                                | Standard Webhooks, deferred (§5.8).                                                                                                                 |
| Packaging                                                | Clerk ships one package per framework over `@clerk/backend`. Hono keeps third-party middleware in `@hono/*` (`@hono/clerk-auth`) [S5].                                                                                                                                                                                                                                                                                                                                                                                                         | One package with subpaths (§8), because of the feed's lockstep cost.                                                                                |
| Test helpers                                             | Clerk Testing Tokens [S3]; Stripe's test header strings [S7].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A `/testing` entry signs test documents with a throwaway key.                                                                                       |
| Peers' server-side checks                                | Keygen: the online `validate` action, plus offline signed licence files [S19]. Lemon Squeezy: an online License API, 60 requests a minute [S21]. RevenueCat: REST calls with a secret key [S22].                                                                                                                                                                                                                                                                                                                                               | Polaris Key verifies a device-bound signed document offline, so a backend needs no secret and makes no call.                                        |
| Mounting into a host CLI                                 | commander `addCommand`; yargs command modules; oclif plugins in `oclif.plugins` with `init` and `prerun` hooks [S23] · click `add_command` and entry-point plugins [S24]; Typer `add_typer` [S25] · Clikt `subcommands()` and context objects [S26]; picocli `addSubcommand` and execution strategies [S27] · ArgumentParser `subcommands:` [S28] · Textual `push_screen` [S29]; Ink `render` [S30].                                                                                                                                           | A mount helper and a gate per framework (§7.3).                                                                                                     |
| CLI sign-in                                              | `gh auth login`: a browser flow, the token in the credential store, `--with-token`, and exit code **4** for "requires authentication" [S31] · `wrangler login`: a localhost callback, `--device` (RFC 8628) and `--use-keyring` [S32] · WorkOS CLI Auth and Clerk-as-IdP use the device grant [S33].                                                                                                                                                                                                                                           | The kits already do the browser and device-code flows with keychain storage. A refused gate exits 4.                                                |

## 4. Use cases, ranked

| #   | Use case                                                                                      | Drop-in                                                        | Tier   |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| 1   | Gate an API route on a valid licence or an entitlement                                        | `requireLicense()`, `requireEntitlement("pro")`                | must   |
| 2   | Attach the verified licence (tier, entitlements, holder) to the request for handlers and logs | `polarisKey()` and the framework's context                     | must   |
| 3   | The app sends its credential to its own backend                                               | `client.backend.fetch()` / `headers()` (§6)                    | must   |
| 4   | A CLI mounts the licence and account verbs and gates its own commands                         | `registerPolarisCommands(...)`, `requireLicense(handler)` (§7) | must   |
| 5   | Require a signed-in Polaris Key user, and key the app's own data by pairwise subject          | `requireSignIn()`, `auth.user.subject`                         | should |
| 6   | Read managed config and flags on the server                                                   | `serverClient()` (§5.7)                                        | should |
| 7   | Verify Polaris Key webhooks                                                                   | `verifyWebhook()`, `polarisWebhook()` (§5.8)                   | later  |
| 8   | Online checks: immediate revocation, a subject's entitlements                                 | waits for LX-13 and a server credential                        | later  |

## 5. Servers

### 5.1 The credential and the verdict

The app sends these headers to its own backend:

| Header                   | Value                                     | Rule                                                                                         |
| ------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `X-PKey-License` (new)   | The compact `pkey-license+jws`, unchanged | Required on gated routes. At most 16 384 bytes.                                              |
| `X-PKey-Device` (exists) | The device id                             | Optional. When sent, it must equal the document's `deviceId`. It is not proof of possession. |

The app never sends the `pkeyt_` token or the config document, and the drop-ins never read
`Authorization`, which stays the app's own.

**The verdict.** Steps run in order, and `backend-matrix.json` pins each step **[C]**:

1. No `X-PKey-License` → `license_required` (401).
2. Over 16 384 bytes, or not three base64url segments → `license_invalid` (401).
3. V4's strict verifier with `typ` `pkey-license+jws` and the key chosen by `kid` from the pins
   plus the manifest keys. Then `iss` is `key.plrs.im`, `aud` is a configured product slug,
   `X-PKey-Device` (if sent) equals `deviceId`, and `issuedAt ≤ now + 300`. Any failure →
   `license_invalid`.
4. Freshness:
   - by default, `now ≤ expiresAt + 300`;
   - with `maxAgeSeconds` set, `now − issuedAt ≤ maxAgeSeconds + 300`, never past `graceUntil`;
   - otherwise → `license_stale` (401).
5. The shared gate (`licenseState`) must be usable → else `license_stale`.
6. The route's requirement:
   - `requireEntitlement(n)`: boolean entitlement `n` must be true → else `not_entitled` (403);
   - `requireSignIn()`: `profile.user.subject` must match `^ps_[A-Za-z0-9_-]{22}$` → else
     `sign_in_required` (403).

**Trust.**

- The pins come from the generated config (`trust.pinnedKeys`).
- The core fetches the signed trust manifest from `<baseUrl>/<p>/.well-known/polaris-trust.jws`:
  - at start;
  - every 900 s;
  - on an unknown `kid`, at most once every 60 s.
- It verifies the manifest against the pins only (V4 §1). `trustRefresh: false` runs on the pins
  alone, for air-gapped servers.
- A failed fetch keeps the last verified set, and pinned keys always verify, so a Polaris Key outage
  never refuses a document signed by a pinned key.
- Because an unknown `kid` triggers at most one fetch a minute, junk headers cannot be amplified
  into requests to Polaris Key.
- The fetch sends `X-PKey-SDK: <lang>-server`, which gives the Integration page its server sighting
  (§10).
- On Workers, the refresh runs through `waitUntil`.

**Cache.** Verified documents are kept in an LRU of 1 000 entries, keyed by the header's SHA-256.
Each entry lives until its own freshness deadline.

**The context attached to the request** (one shape in every language):

```ts
interface PolarisAuth {
  license: {
    id: string;
    deviceId: string;
    tier: string | null; // license.tier
    issuedAt: number; // epoch seconds
    ageSeconds: number;
    holder: { name: string; email: string } | null; // the signed profile
    isEntitled(name: string): boolean;
    value(name: string): JSONValue | null;
  } | null;
  user: { subject: string } | null; // pairwise "ps_…", from profile.user (SP-54)
  problem: Problem | null; // set whenever license is null
}
```

### 5.2 Errors

| Code               | Status | When                                | What the client half does                        | Kind                         |
| ------------------ | ------ | ----------------------------------- | ------------------------------------------------ | ---------------------------- |
| `license_required` | 401    | No header                           | Shows its gate (`needs-activation`)              | new, `backend`               |
| `license_invalid`  | 401    | Fails step 2 or 3                   | Syncs, retries once, then shows its gate         | new, `backend`               |
| `license_stale`    | 401    | Fails step 4 or 5                   | Syncs, retries once                              | new, `backend`               |
| `not_entitled`     | 403    | Missing entitlement                 | Surfaces the error, with the upgrade link if any | existing `wire` code, reused |
| `sign_in_required` | 403    | Valid licence, no signed-in account | Offers sign-in                                   | new, `backend`               |

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
Cache-Control: no-store
WWW-Authenticate: PKey-License realm="acme", error="license_stale"

{"type":"https://key.plrs.im/docs/reference/errors/#license_stale",
 "title":"License needs refreshing","status":401,
 "detail":"Reconnect so the app can refresh your license.","code":"license_stale"}
```

- **Copy.** `title` and `detail` come from the copy catalog (`conformance/parity/copy.<locale>.json`).
  The locale is chosen from `Accept-Language` among the nine, with English as the fallback. The
  strings above are placeholders that SP-53 replaces.
- **`type` URIs.** They resolve on the public docs' error-code page.
- **Customising.**
  - `onRefusal(problem, ctx)` returns the framework's own response.
  - `errors: "throw"` raises `PolarisKeyError {status, headers, problem}` into the framework's error
    pipeline. This is the default for DRF (`AuthenticationFailed`, `PermissionDenied`) and Spring
    (`AuthenticationEntryPoint`, `AccessDeniedHandler`).
  - `onVerdict(code, step)` reports every verdict, for metrics. It carries no header and no
    document.
  - Refusals are always `no-store`. On a gated route that sets no `Cache-Control`, the adapter adds
    `private`.
  - The body never names the step that refused; only the debug log does.

### 5.3 Frameworks, tiered

| Language   | Must                                      | Should                        | Later                                                                                                |
| ---------- | ----------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Node       | Express, Hono, Next.js (App Router)       | Fastify, NestJS, Koa          | React Router (Remix), SvelteKit, Astro, Elysia: a recipe on the Fetch core (`authenticate(request)`) |
| Python     | FastAPI/Starlette, Django with DRF, Flask | —                             | Litestar, Sanic, aiohttp: a recipe on the core                                                       |
| Kotlin/JVM | Ktor                                      | Spring Boot (Spring Security) | Micronaut, Quarkus, http4k: a recipe on the core                                                     |
| Swift      | —                                         | Vapor                         | Hummingbird                                                                                          |
| Others     | —                                         | —                             | Go: ruled out for now (owner, 2026-10-08). Godot dedicated servers: later.                           |

Why the tiers:

- **Must** covers the most-used framework in each language, plus Hono and Next.js:
  - Hono because the owner named it and it runs where Express cannot (Workers, Bun, Deno);
  - Next.js because React-SDK web apps put their API in route handlers.
- **Python's three are all must**, because each adapter is about a hundred lines over one core.
- **Vapor is should**, because the Swift verifier has to build on Linux first (§13 Q6).

### 5.4 API per framework

Every adapter offers the same four names: `polarisKey(options)`, `requireLicense()`,
`requireEntitlement(name, test?)` and `requireSignIn()`.

- `test` receives a valued entitlement, as Auth0's `claimCheck` does. For example,
  `requireEntitlement("seats", (v) => v >= 5)`.
- The adapters read the configuration that `pkey sdk` already writes today (`polarisConfig`), and
  `polaris-key.json` after SP-32a.
- Each minimal form below is the whole integration. The comment under it shows the customised form.

**The core** (`@polaris-key/server`), on Web `Headers`. It runs on Node, Bun, Deno and Workers:

```ts
import { createPolarisKey } from "@polaris-key/server";
const polaris = createPolarisKey({ config: polarisConfig });
const auth = await polaris.authenticate(request.headers);
if (!auth.license?.isEntitled("export.pdf"))
  return polaris.refuse(auth.problem ?? "not_entitled", request);
```

**Express** (`@polaris-key/server/express`). `req.polaris` is typed through declaration merging.

```ts
app.use(polarisKey({ config: polarisConfig }));
app.get("/api/export", requireEntitlement("export.pdf"), (req, res) =>
  res.json({ tier: getPolarisAuth(req).license!.tier }),
);
// Customised: a tighter window, your own body, a signed-in user.
app.use(
  polarisKey({
    config: polarisConfig,
    maxAgeSeconds: 600,
    onRefusal: (p, req, res) => res.status(p.status).json({ error: p.code }),
  }),
);
app.post("/api/saves", requireSignIn(), (req, res) => {
  const { user } = getPolarisAuth(req); // user.subject: "ps_…"
});
```

**Hono** (`@polaris-key/server/hono`). It runs on Workers, Bun, Deno and Node.

```ts
const app = new Hono<PolarisEnv>();
app.use("/api/*", polarisKey({ config: polarisConfig }));
app.get("/api/export", requireEntitlement("export.pdf"), (c) =>
  c.json({ tier: c.var.polaris.license!.tier }),
);
// Customised: CORS for a browser client, and your own error handler.
app.use(
  "/api/*",
  cors({
    origin: "https://app.example.com",
    allowHeaders: [...POLARIS_REQUEST_HEADERS, "Content-Type"],
  }),
);
app.use("/api/*", polarisKey({ config: polarisConfig, errors: "throw" }));
app.onError((e, c) =>
  e instanceof PolarisKeyError
    ? c.json({ error: e.problem.code }, e.problem.status)
    : c.text("error", 500),
);
```

**Next.js App Router** (`@polaris-key/server/next`):

```ts
// lib/polaris.ts
export const polaris = createNextPolarisKey({ config: polarisConfig });
// app/api/export/route.ts
export const GET = polaris.requireEntitlement(
  "export.pdf",
  async (req, { license }) => Response.json({ tier: license.tier }),
);
// Customised: decide inside the handler.
export async function POST(req: Request) {
  const auth = await polaris.auth(req);
  if (!auth.license) return polaris.refuse(auth.problem!, req);
}
```

**Fastify** (`/fastify`). This is a `fastify-plugin`, so the `request.polaris` decorator is visible
in every scope.

```ts
await app.register(polarisKey, { config: polarisConfig });
app.get(
  "/api/export",
  { preHandler: requireEntitlement("export.pdf") },
  async (req) => ({
    tier: req.polaris.license!.tier,
  }),
);
// Customised: { config, errors: "throw" }, then app.setErrorHandler(...) shapes the reply.
```

**NestJS** (`/nestjs`). The module registers a global guard (`APP_GUARD`), and routes with no
decorator stay open.

```ts
@Module({ imports: [PolarisKeyModule.forRoot({ config: polarisConfig })] })
export class AppModule {}

@Controller("api")
export class ExportController {
  @Get("export")
  @RequireEntitlement("export.pdf")
  export(@Polaris() auth: PolarisAuth) {
    return { tier: auth.license!.tier };
  }
}
// Customised: forRoot({ config, global: false }) plus @UseGuards(PolarisKeyGuard) per controller.
// Refusals are a PolarisKeyException (an HttpException), so your exception filters apply.
```

**Koa** (`/koa`): `app.use(polarisKey({config}))`, then `ctx.state.polaris` and
`router.get("/x", requireLicense(), …)`. The customised form is
`polarisKey({ config, onRefusal: (p, ctx) => { ctx.status = p.status; ctx.body = { error: p.code }; } })`.

**FastAPI and Starlette** (`polaris_key.server.fastapi`). The dependency also declares an
`APIKeyHeader("X-PKey-License")` security scheme, so `/docs` shows it.

```python
polaris = PolarisKey(config=polaris_config)

@app.get("/api/export")
def export(auth: Annotated[PolarisAuth, Depends(polaris.require_entitlement("export.pdf"))]):
    return {"tier": auth.license.tier}

# Customised: raise into your own handler.
polaris = PolarisKey(config=polaris_config, max_age_seconds=600, errors="raise")
app.add_exception_handler(PolarisKeyError, my_handler)
```

**Flask** (`polaris_key.server.flask`), using the extension pattern:

```python
polaris = PolarisKey(config=polaris_config)
polaris.init_app(app)

@app.get("/api/export")
@polaris.require_entitlement("export.pdf")
def export():
    return {"tier": g.polaris.license.tier}

# Customised: PolarisKey(config=..., on_refusal=lambda p: ({"error": p.code}, p.status))
```

**Django and DRF** (`polaris_key.server.django`, `.drf`):

```python
# settings.py
MIDDLEWARE = [..., "polaris_key.server.django.PolarisKeyMiddleware"]
POLARIS_KEY = {"CONFIG": "myapp.polaris_config"}

@require_entitlement("export.pdf")  # a plain Django view
def export(request):
    return JsonResponse({"tier": request.polaris.license.tier})

class ExportView(APIView):  # DRF
    authentication_classes = [PolarisKeyAuthentication]  # request.auth is the PolarisAuth
    permission_classes = [has_entitlement("export.pdf")]

# Customised: POLARIS_KEY = {"CONFIG": ..., "MAX_AGE_SECONDS": 600, "ON_REFUSAL": "myapp.views.refused"}.
# DRF raises AuthenticationFailed or PermissionDenied with the code, so EXCEPTION_HANDLER shapes it.
```

**Ktor** (`im.plrs.key:polaris-key-server-ktor`):

```kotlin
install(Authentication) { polarisKey { config = PolarisConfig.fromResource("polaris-key.json") } }
routing {
    authenticate(PolarisKey.AUTH) {
        route("/api/export") {
            install(RequireEntitlement) { name = "export.pdf" }
            get { call.respond(mapOf("tier" to call.principal<PolarisLicense>()!!.tier)) }
        }
    }
}
// Customised: polarisKey { config = …; maxAgeSeconds = 600
//     challenge { p -> call.respond(HttpStatusCode.fromValue(p.status), mapOf("error" to p.code)) } }
```

**Spring Boot** (`im.plrs.key:polaris-key-spring-boot-starter`). Boolean entitlements become the
authorities `entitlement:<name>`.

```kotlin
@Bean fun api(http: HttpSecurity): SecurityFilterChain = http
    .securityMatcher("/api/**")
    .with(PolarisKeyConfigurer()) {}
    .authorizeHttpRequests { it.anyRequest().authenticated() }
    .build()

@GetMapping("/api/export") @PreAuthorize("hasAuthority('entitlement:export.pdf')")
fun export(@AuthenticationPrincipal license: PolarisLicense) = mapOf("tier" to license.tier)
// Customised: polaris-key.max-age-seconds: 600 in application.yml. Your own
// AuthenticationEntryPoint or AccessDeniedHandler bean replaces the problem body.
```

**Vapor** (registry package `polaris-key.PolarisKeyVapor`):

```swift
app.middleware.use(PolarisKeyAuthenticator(config: try .load("polaris-key.json")))
let api = app.grouped("api").grouped(PolarisLicense.guardMiddleware())
api.grouped(RequireEntitlement("export.pdf")).get("export") { req in
    ["tier": try req.auth.require(PolarisLicense.self).tier]
}
// Customised: PolarisKeyAuthenticator(config:, maxAgeSeconds: 600). PolarisKeyError is an
// AbortError, so your ErrorMiddleware shapes the body.
```

### 5.5 Security

- **What the document proves.** A Polaris Key product key signed it for this product, for that
  device id, at `issuedAt`.
- **Device binding is a consistency check, not proof of possession.** The device id is inside the
  document. Anyone holding a captured document can replay it until it goes stale: one hour by
  default, `maxAgeSeconds` if set. The docs say so plainly. TLS and the refresh rule keep the
  window short. A device-bound proof is §13 Q3.
- **Revocation and age bounds.** A revoked, expired or disabled licence stops getting documents
  (401 from the Worker). It therefore fails `license_stale` within `maxAge + 300 s`. A
  bundle-activated device holds no token and cannot refresh, so the docs tell it to activate online
  before it calls a backend.
- **Audience, issuer and `typ`.** All three are checked. A backend serving several products passes
  `products: [configA, configB]`, and the document's `aud` selects the trust set, which is
  re-checked after verification.
- **Clock skew.** 300 s (`CLOCK_SKEW_SECONDS`), as in V4. The docs require NTP on the server.
- **Configuration errors.** `createPolarisKey` throws at start when the config's
  `expectedServices` lacks `license`, rather than refusing every request later.
- **No secrets in logs.**
  - The header, the JWS and the holder's name and email never appear in a log line, an error
    message or `toJSON`.
  - Debug logs carry `kid`, `aud`, an 8-character hash of the device id, and the step that refused.
  - The docs list the header for APM header scrubbing (Sentry, Datadog, OpenTelemetry).
  - The document carries the holder's name and email to the developer's own backend; PRIVACY.md
    gets a row.
- **Constant time.** No secret is compared outside a crypto library. Ed25519 verification happens
  inside WebCrypto, `cryptography`, CryptoKit/swift-crypto and JCA. The one exception is a webhook's
  `v1` HMAC, compared with `timingSafeEqual`, `hmac.compare_digest` or `MessageDigest.isEqual`.
- **CORS and CSRF.**
  - The drop-ins never set CORS headers; that is the app's policy. They export
    `POLARIS_REQUEST_HEADERS` (`X-PKey-License`, `X-PKey-Device`) for the app's allow-list.
  - The credential is a header, never a cookie or a query parameter. It is therefore not ambient,
    and a cross-site request cannot carry it without a CORS preflight.
- **Size.** The 16 KiB cap stays under Node's default 16 KiB total-header limit for typical
  documents. The client half warns once when a document passes 8 KiB.
- **Browser storage.** In a web app the document sits in IndexedDB, as the device token already
  does. An XSS can read both, and the docs say so.

### 5.6 Sign-in on the server

- **The problem.** `requireSignIn()` needs a signed fact naming the person signed in on the device.
  Today no document carries one (§2.2).
- **SP-54** pulls one member forward from I-24's approved design: `profile.user = {"subject":
"ps_…"}`.
  - It is emitted whenever `devices.subject` is set, not only for named-user seats.
  - I-24a then adds only its policy keys.
  - Every v4 verifier already ignores unknown profile members (V4 §3.2), so old SDKs are
    unaffected.
- **Why the pairwise subject.** It is the same `sub` that I-21's issuer will put in ID tokens. A
  backend keyed on it today needs no migration when I-21 ships.
- **Limits.**
  - This needs License on, because Identity-only products get no licence document. For them,
    `requireSignIn()` accepts I-21 access tokens once I-21 ships (SP-68).
  - A key-only device has no subject and gets `sign_in_required`.

### 5.7 Managed config on a server

- **A server is a device** with its own licence, for example a `server` tier with a high device
  limit, so it never takes a customer's seat.
- **`serverClient()`** (Node and Python, SP-63) creates the normal client with:
  - a memory store;
  - a device id that stays stable across container restarts, from `PKEY_DEVICE_ID` or a volume;
  - the key from `PKEY_LICENSE_KEY`;
  - no device reports;
  - a background refresh;
  - the usual `config.get()`.
- **Per-user config is not offered.** The device's config document carries `secrets` and is never
  forwarded (§13 Q8).

### 5.8 Webhooks (later)

- **Nothing to verify yet.** Polaris Key sends no developer webhooks (§2.2).
- **SP-66 (deferred)** plans them so that CM-22, LX-13 and ST-27 do not each invent a format:
  - Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`);
  - `v1a` Ed25519 signatures under a per-product webhook key that is never a document key and is
    sealed under the KEK;
  - an optional `v1` HMAC per endpoint, for generic libraries;
  - 300 s tolerance, dedupe on `webhook-id`, and at-least-once delivery with retries on the
    Worker's queue;
  - events `subject.merged`, `subject.deleted`, `entitlements.changed`, `purchase.refunded`,
    `license.revoked` and `device.deauthorized`;
  - a console endpoints page with a test event, and `pkey webhooks listen` to forward events to
    localhost.
- **SP-67** delivers them:
  - `verifyWebhook(rawBody, headers, {keys})` in each core;
  - `polarisWebhook({ on })` in each adapter, with its raw-body recipe (`express.raw()`,
    Fastify's `rawBody`, `await c.req.text()`, `await request.body()`, `request.body`,
    `receiveText()`).

## 6. The client half

All six SDKs get one namespace, `client.backend`:

| SDK    | Call                                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `await client.backend.fetch("https://api.example.com/export")`; `await client.backend.headers()`                                             |
| React  | `const api = usePolarisFetch(); await api("/api/export")` (same origin is allowed by default). In Electron, through the bridge (SP-31 edit). |
| Python | `httpx.Client(auth=client.backend.httpx_auth())`; `requests` `auth=client.backend.requests_auth()`; `client.backend.headers()`               |
| Swift  | `try await client.backend.data(for: URLRequest(url: exportURL))`; `try await client.backend.headers()`                                       |
| Kotlin | `OkHttpClient.Builder().addInterceptor(client.backend.interceptor())`; `client.backend.headers()`                                            |
| Godot  | `var h := await PolarisKey.backend.headers()` then `http_request.request(url, h)`                                                            |

**Behaviour.** The `client` section of `backend-matrix.json` pins it **[C]**.

- **Origins.**
  - `backend.origins` is an exact list, HTTPS only except loopback. It lives in the client options
    and in `polaris-key.json` (an SP-32a edit).
  - The fetch helpers refuse any other origin with the client code `backend-origin-not-allowed`.
  - `headers()` is raw: the caller decides where it goes.
- **Freshness.**
  - Before attaching, if `effectiveNow > expiresAt − REFRESH_MARGIN_SECONDS` (1 800 s), the helper
    syncs the licence document first.
  - Concurrent callers share one sync.
  - On a 304, V4 §5's half-life rule already forces a fresh document.
- **Retry.**
  - On `license_stale` or `license_invalid`, the helper force-syncs and retries once.
  - If the sync fails (offline, or 401 from the Worker), it returns the backend's response and the
    gate shows its own state.
  - `not_entitled` and `sign_in_required` are never retried. They surface as typed errors that
    carry the copy key.
- **What it sends.** `X-PKey-License` (when a licence is held) and `X-PKey-Device`. Never the
  token, never the config document.

The developer's own `Authorization` header passes through untouched.

## 7. CLIs and terminal apps

### 7.1 What every CLI drop-in does

UK-51 pins this as the `cli` family of `ui-matrix.json`, so Node, Python and the JVM behave the
same.

- **Mount.**
  - The default is the end-user set: `activate`, `deactivate`, `status`, `login`, `logout`,
    `devices …`, `update check` and `update apply` (UK-46 and UK-48 define it as `END_USER`).
  - Developer verbs (`config`, `secret`, `mint`, `packs`, `doctor`, …) are opt-in.
  - Verbs mount at the root unless `namespace: "license"` nests them (`mytool license activate`).
- **Collisions.** A verb whose name the host already uses fails at registration with
  `polaris-verb-collision`, naming the verb and both fixes (`namespace`, or `verbs` without it).
  `onCollision: "skip"` drops the verb and warns once.
- **Help.** The host's commands come first, under the host's headings. The Polaris verbs come under
  one heading (kit copy key `cli.help.group`).
- **Configuration.** Once `config` is given, `--product`, `--trust` and `--base-url` are hidden.
- **The gate.** `requireLicense(handler, {entitlement?})` runs before the host's action.
  - Usable (`ok`, `grace`, `not-applicable`) → the action runs.
  - Interactive TTY and not `--json` → the kit's activate or sign-in flow runs inline, then the
    action.
  - Otherwise → the fix line (`mytool activate`), then **exit 4** (`EXIT.licenseRequired`, as in
    `gh`). `--json` prints the `error` code (`license_required` or `not_entitled`).
  - `polarisGate(program)` gates every host command.
- **Rendering.** Everything goes through the language's terminal kit and UK-02b's `terminal` rows:
  the same screens, copy keys and `--json` envelope (`CLI_JSON_VERSION` unchanged).

### 7.2 Frameworks, tiered

| Language   | Must                           | Should                                                                    | Later                                                                                                                                                               |
| ---------- | ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | Commander, yargs (UK-46)       | oclif (a plugin with a `prerun` gate), Ink (React components) (UK-52)     | citty, clipanion, cac. @clack/prompts is already covered: the kit is clack-style, and UK-46 adds `frame: false` so a flow sits inside a host's `intro()`/`outro()`. |
| Python     | argparse, click, typer (UK-48) | Textual screens a host app pushes (UK-53)                                 | prompt_toolkit. Rich is already covered: UK-48 accepts the host's `rich.Console`.                                                                                   |
| Kotlin/JVM | —                              | Clikt and picocli on a new JVM terminal kit rendered with Mordant (UK-54) | —                                                                                                                                                                   |
| Swift      | —                              | —                                                                         | swift-argument-parser. It needs a Swift terminal kit first.                                                                                                         |

- **oclif and Ink are should** because they carry the paid-CLI segment: Salesforce, Heroku and
  Shopify build on oclif, and recent AI CLIs on Ink.
- **The JVM pair are should** because they need a whole new terminal kit.

### 7.3 API per framework

```ts
// Commander (UK-46, with names amended here)
registerPolarisCommands(program, { config: polarisConfig, version });
program.command("export").action(requireLicense(runExport, { entitlement: "export.pdf" }));
// Customised: nest the verbs, pick them, and gate every host command.
registerPolarisCommands(program, {
  config: polarisConfig,
  version,
  namespace: "license",
  verbs: ["activate", "status", "login", "logout"],
});
polarisGate(program, { except: ["help", "license"] });

// yargs (moves to its own subpath, @polaris-key/node/cli/yargs)
yargs(hideBin(process.argv))
  .command(polarisCommands({ config: polarisConfig, version }))
  .command("export", "Export", {}, requireLicense(runExport));

// oclif (UK-52): package.json "oclif": { "plugins": ["@polaris-key/oclif"] }, plus on a command:
export default class Export extends Command {
  static polarisKey = { entitlement: "export.pdf" }; // read by the plugin's prerun hook
}

// Ink (UK-52)
render(<PolarisGate client={client} entitlement="export.pdf"><App /></PolarisGate>);
```

```python
# typer, click and argparse (UK-48)
app.add_typer(polaris_typer_app(config=polaris_config, version=__version__), name="license")
cli.add_command(polaris_click_group(config=polaris_config, version=__version__), name="license")
register_argparse(subparsers, config=polaris_config, version=__version__)

@app.command()
@require_license(entitlement="export.pdf")
def export(): ...

# Textual (UK-53)
self.push_screen(PolarisGateScreen(client, entitlement="export.pdf"), callback=self.on_gate)
```

```kotlin
// Clikt (UK-54)
MyTool().subcommands(Export(), *PolarisCommands(client).endUser()).main(args)
class Export : CliktCommand() { override fun run() { requireLicense(client, "export.pdf"); /* … */ } }

// picocli (UK-54): subcommands plus a gate execution strategy that reads @RequiresLicense
PolarisKeyPicocli.install(commandLine, client)
@RequiresLicense(entitlement = "export.pdf") @Command(name = "export") class Export : Runnable { /* … */ }
```

## 8. Packaging

Everything ships on `pkg.plrs.im` only, in the 0.9.x lockstep.

| Language | Decision                                                                                                                                                                                                                                                                                                | Reason                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node     | One new package, **`@polaris-key/server`**. Its root is the Fetch core. The subpaths `./express`, `./hono`, `./next`, `./fastify`, `./nestjs`, `./koa` and `./testing` each have an **optional peer dependency**, and `./webhooks` comes later. It depends on `client-core`, `jws` and `protocol` only. | `@polaris-key/node` needs Node ≥ 22.13, carries the keyring, CLI and Electron code, and its name misleads on Workers, Bun and Deno. Hono users live there. A package per framework would add six lockstep legs, and lockstep legs are what broke nine feed versions (P0-52). Subpaths with optional peers keep one install line. |
| Node CLI | Stays in `@polaris-key/node`: `./cli` (commander), `./cli/yargs`, `./ink`. **`@polaris-key/oclif`** is one separate package.                                                                                                                                                                            | oclif finds plugins by package name in `oclif.plugins`, so it cannot be a subpath.                                                                                                                                                                                                                                               |
| Python   | Modules in `polaris-key`: `polaris_key.server` plus `.fastapi`, `.flask`, `.django`, `.drf`. The extras `[fastapi]`, `[flask]` and `[django]` pin floor versions. The adapters import lazily.                                                                                                           | This matches the existing `click` and `typer` extras. The core needs only `cryptography` and `httpx`, which are already dependencies.                                                                                                                                                                                            |
| Kotlin   | New Gradle modules published as `im.plrs.key:polaris-key-server`, `-server-ktor`, `polaris-key-spring-boot-starter`, `-cli`, `-cli-clikt` and `-cli-picocli`.                                                                                                                                           | Separate artifacts are the JVM idiom, and the `-spring-boot-starter` suffix is Spring's naming rule.                                                                                                                                                                                                                             |
| Swift    | Product `PolarisKeyServer` inside `PolarisKey`, which builds on Linux. Vapor goes in a **separate registry package**, `polaris-key.PolarisKeyVapor`.                                                                                                                                                    | SwiftPM resolves every dependency of a package. Vapor and NIO inside `PolarisKey` would be fetched by every iOS app.                                                                                                                                                                                                             |

## 9. Wire, contract and corpus impact

All of this is plan mode under CLAUDE.md.

### 9.1 SP-53: the backend contract (executes this section once approved)

- **WIRE-CONTRACT-V4, a new §13 "Product backends":**
  - the headers (§5.1), the verdict order **[C]**, the problem body and challenge **[C]**, and the
    client refresh and retry rule **[C]**;
  - §8 rows for `X-PKey-License`, the `PKey-License` scheme and the server `sdkId` values;
  - §9: "SP-53 changes no counter; adds `backendMatrixVersion = 1`";
  - §10: a ledger entry.
- **`shared-protocol/src/core.ts`:** `HEADER_LICENSE = "X-PKey-License"`,
  `BACKEND_AUTH_SCHEME = "PKey-License"`, `BACKEND_LICENSE_MAX_BYTES = 16384`,
  `BACKEND_TRUST_REFRESH_SECONDS = 900` and `POLARIS_REQUEST_HEADERS`.
- **`conformance/parity/errors.json`:**
  - a new `kind: "backend"`: emitted by SDK server cores and read by client SDKs, and exempt from
    the generator's "the Worker must emit it" check (`errors.schema.json` and
    `tools/gen-sdk-constants.ts`);
  - four codes: `license_required`, `license_invalid`, `license_stale` and `sign_in_required`;
  - copy for each in all nine `copy.<locale>.json` files.
- **`conformance/parity/enums.json`:** `sdkId` gains `node-server`, `python-server`, `swift-server`
  and `kotlin-server`.
- **`features.json`:**
  - a family `server` with rows `server.license`, `server.signin`, `server.config` and
    `server.webhooks`;
  - `core.backend` for the client half;
  - `ui.cli.mount`.
  - Every SDK's `parity.json` records `planned`. React and Godot record N/A with reason `runtime`
    for `server.*`.
- **Corpus:** `conformance/corpus/v2/backend-matrix.json` (`backendMatrixVersion: 1`).
  - It is generated by `tools/corpus/backend.ts` against a reference in
    `tools/corpus/reference/backend.ts`.
  - It has three sections: `verdict` (headers, now and options → status, code and the context),
    `problem` (code and locale → status, challenge, `type`, title and detail) and `client` (document
    times, now and response → send, refresh-then-send, refresh-and-retry or surface).
  - The Godot mirror `sdks/godot/tests/corpus/v2/backend-matrix.json` comes with it, and AGENTS.md
    rule 1 lists the new file.
- **Code:**
  - client-core `src/backend.ts`: `backendVerdict()` and `clientBackendAction()`, the reference that
    `@polaris-key/server` and the JS client halves use;
  - the Node and browser runners replay their sections.
- **Gates:** `pnpm gen:corpus`, `gen:constants -- --check` and `parity:check`.
- **Counters:** `PROTOCOL_VERSION` 4, `corpusVersion` 2, `DISCOVERY_VERSION` 2 and `CACHE_VERSION` 3,
  all unchanged.
- **SDKs that follow:**
  - the server cores replay `verdict` and `problem`: Node (SP-55), Python (SP-56), Kotlin (SP-57)
    and Swift (SP-62);
  - the client halves replay `client`: Node, React and Python (SP-58), then Swift, Kotlin and Godot
    (SP-59).

### 9.2 SP-54: the signed-in subject in the licence document

- **Planning.** A `pkey-wire-planner` writes `plans/SP-54.md` first. It amends `plans/I-24.md` §2.1
  and §2.4: `profile.user` appears whenever `devices.subject` is set.
- **Changes:**
  - the Worker's licence document builder (`services/license/document.ts` and `docProfile`);
  - client-core `licenseUserOf` (I-24's reader, moved forward);
  - corpus `licenseDocCases` rows plus I-24's `licenseUserCases`;
  - re-recorded transcripts whose devices are signed in (`identity-attach.json` and the device-code
    ones, with the Swift and Godot mirrors);
  - THREAT-MODEL and PRIVACY rows.
- **Who follows.** The four server cores read the member. No client SDK has to change: they forward
  the JWS untouched, and I-24b adds readers when it is revived.

### 9.3 UK-51: the CLI contract

- A `cli` family in `ui-matrix.json`: verb ids and sets, mount and collision outcomes, help grouping,
  the gate outcome for each gate state × TTY × `--json`, and exit 4.
- `uiMatrixVersion` becomes 2 if UK-02b has shipped by then. Otherwise UK-02b's version 1 includes
  the family.
- `EXIT.licenseRequired = 4` is added to Node's `cli/json.ts` and to Python's exit table. `status`
  keeps exit 1.
- Followers: Node (UK-46, UK-52), Python (UK-48, UK-53) and the JVM (UK-54).

### 9.4 Deployed clients and Workers

- **Workers.**
  - SP-53 changes no Worker code: the new codes come from the SDKs.
  - ST-40's sightings accept the new `sdkId` values.
  - SP-54 changes documents only for devices whose `devices.subject` is set. Every other document
    stays byte-identical, and a Worker property test checks that over the transcript fixtures.
- **Deployed SDKs.**
  - They never send `X-PKey-License`. A backend that adopts a drop-in before its apps update sees
    `license_required`, so ship the client update first, or leave the route on `polarisKey()`
    without a `require*`.
  - Old SDKs ignore `profile.user` (V4 §3.2; every decoder is total, `plans/I-24.md` §2.4).
- **Existing hand-written backends** that use the example's headers keep working. To keep the old
  window they set `maxAgeSeconds` explicitly; the drop-in default is one hour, against the
  example's three days.
- **`@polaris-key/node/server`** is unchanged in 0.8.x. In 0.9, `verifyLicenseDocument` moves to
  `@polaris-key/server` with a `replaces` row and no alias (owner, 2026-10-07).
  `examples/node-express` is rewritten on the drop-in.

## 10. How it is presented

**The console's Integration page** (SP-33a and ST-41, through SP-64):

- **Detection.** `sdkFit(platforms, repoSignals)` returns `{sdk, host: "app" | "server" | "cli",
framework}`.
  - Server framework signals:
    - `package.json`: `express`, `hono`, `next`, `fastify`, `@nestjs/core`, `koa`;
    - `pyproject.toml` or `requirements*.txt`: `fastapi`, `starlette`, `flask`, `django`,
      `djangorestframework`;
    - Gradle: `io.ktor:ktor-server-core`, `org.springframework.boot`;
    - `Package.swift`: `vapor`.
  - CLI framework signals: `commander`, `yargs`, `@oclif/core`, `ink`; `click`, `typer`, `textual`;
    `com.github.ajalt.clikt`, `info.picocli`.
  - With no linked repo, the developer picks a host and a framework.
- **The server card.** It shows the framework's minimal snippet with the product's real config and
  its first boolean entitlement. It has two links: **"Verify on your server →"**
  (`/docs/build/servers/`) and **"Use the core directly →"** (`/docs/build/servers/#core`). It turns
  Verified on a `<lang>-server` sighting (ST-40 edit).
- **The app card** adds one line, `client.backend.fetch(...)`, when a server host is also detected.
- **The CLI card** shows the framework's mount and gate, plus **"Customise the screens →"** to the
  kit page.

**The docs** (now public, owner, 2026-10-08), as amendments to the docs plan:

- **A third lane.** `features/<f>/add-<f>/` gains a **Your server** lane for Licensing, Sign-in
  (after SP-54), Managed config and Commerce, beside the drop-in and your-own-UI lanes.
  - The page-level picker gains host and framework selects
    (`?sdk=node&lane=server&framework=express`).
  - Lanes stay the only tab set, as the docs plan §3.6 requires.
- **Server pages:**
  - `build/servers/` is the contract, freshness, revocation, replay, CORS, testing and the core;
  - one page per framework, `build/servers/<framework>/`, from Express to Vapor;
  - `features/licensing/server-verification` (DOC-09a) becomes the concepts page that links them.
- **CLI pages.** The existing kit pages gain framework sections: `build/ui/frameworks/terminal-node/`
  (commander, yargs, oclif, Ink) and `terminal-python/` (argparse, click, typer, Textual). A new
  `terminal-jvm/` covers Clikt and picocli.
- **Error reference.** The error-code page lists the four `backend` codes. Their `type` URIs resolve
  there.
- **Snippets** come from SP-33a's generator with `lane: "server"` and `framework`, as compiled
  goldens.

## 11. Testing

- **Shared cases.** Each core replays the `verdict` and `problem` sections of
  `backend-matrix.json`, and each client SDK replays `client`. Every adapter therefore gives the
  same verdicts.
- **A real minimal app per framework** (`examples/server-<framework>/`):
  - routes: one open route, one `requireEntitlement`, one `requireSignIn` and a `/whoami` probe;
  - a CI job per language boots the app and replays the matrix over real HTTP, asserting the status,
    the problem body, `WWW-Authenticate` and the attached context;
  - the clock comes from the `/testing` entry;
  - Hono runs on Node and on workerd, with a smoke run on Bun and Deno. Next.js runs
    `next build && next start`. Vapor runs on a Linux runner.
- **End-to-end (SP-65)** on `pkey dev` (SP-41), the real Worker router in process:
  - a real Node, Python or JVM client activates a test key and calls the example backend through
    `client.backend.fetch`;
  - control commands then revoke, expire and fill seats, and the test asserts `license_stale`, the
    failed re-sync, and the client's own gate state;
  - once SP-54 lands, a signed-in device passes `requireSignIn()`.
- **Unit tests in apps.** The `/testing` entries sign test documents with a throwaway key and return
  the matching pins. They share SP-42's signer once it exists.
- **CLIs** (`examples/cli-<framework>/`) run against `pkey dev` with a PTY (node-pty, pexpect) and
  with `--json`:
  - activate, status, a gated command (exit 4, then 0), a collision error, and a help golden with
    the host's group first;
  - each adapter replays the `cli` family;
  - the goldens are shared with UK-02b's `terminal` rows.
- **Budget.** Example apps run in per-language CI matrix jobs, not in the default gate. The matrix
  runners are unit-fast.

## 12. Work packages

### 12.1 New

| Id    | Title                                                                                                                              | Phase | Weeks   | Depends on                                  | Plan mode                                         | Role              | Tier                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------- | ------------------------------------------------- | ----------------- | ------------------------- |
| SP-53 | Backend credential contract: `X-PKey-License`, the verdict, `backend` codes and copy, `backend-matrix.json`, client-core `backend` | SP    | 1.0–1.4 | —                                           | yes (executes §9.1)                               | pkey-implementer  | must                      |
| SP-54 | Signed-in subject in the licence document (`profile.user` whenever `devices.subject` is set)                                       | SP    | 0.6–0.9 | I-05                                        | yes (`plans/SP-54.md` by pkey-wire-planner first) | pkey-implementer  | must                      |
| SP-55 | `@polaris-key/server`: the Fetch core, Express, Hono and Next.js, `/testing`, their example apps                                   | SP    | 1.6–2.2 | SP-53                                       | no                                                | pkey-implementer  | must                      |
| SP-56 | Python server drop-ins: `polaris_key.server` with FastAPI/Starlette, Django and DRF, Flask                                         | SP    | 1.4–1.9 | SP-53                                       | no                                                | pkey-sdk-porter   | must                      |
| SP-57 | Kotlin server drop-ins: `polaris-key-server` and the Ktor plugin                                                                   | SP    | 1.0–1.4 | SP-53                                       | no                                                | pkey-sdk-porter   | must                      |
| SP-58 | The client half: `client.backend` in Node, React and Python                                                                        | SP    | 1.0–1.4 | SP-53                                       | no                                                | pkey-sdk-porter   | must                      |
| SP-59 | The client half in Swift, Kotlin and Godot                                                                                         | SP    | 1.1–1.5 | SP-58                                       | no                                                | pkey-sdk-porter   | must                      |
| SP-60 | Node server drop-ins, should tier: Fastify, NestJS, Koa                                                                            | SP    | 0.8–1.1 | SP-55                                       | no                                                | pkey-implementer  | should                    |
| SP-61 | Spring Boot starter on Spring Security                                                                                             | SP    | 0.8–1.1 | SP-57                                       | no                                                | pkey-sdk-porter   | should                    |
| SP-62 | Swift server drop-in: `PolarisKeyServer` building on Linux, and the Vapor package                                                  | SP    | 1.2–1.7 | SP-53, SP-52                                | no                                                | pkey-sdk-porter   | should                    |
| SP-63 | Managed config on a server: `serverClient()` in Node and Python                                                                    | SP    | 0.5–0.8 | —                                           | no                                                | pkey-sdk-porter   | should                    |
| SP-64 | Framework drop-ins on the Integration page and in the docs (servers and CLIs)                                                      | SP    | 1.2–1.6 | SP-33a, SP-55, SP-56, UK-46, UK-48, DOC-03a | no                                                | pkey-implementer  | must                      |
| SP-65 | End-to-end CI: client SDK → example backend → `pkey dev`                                                                           | SP    | 0.6–0.9 | SP-41, SP-55, SP-56, SP-57, SP-58           | no                                                | pkey-implementer  | must                      |
| SP-66 | Plan developer webhooks: Standard Webhooks signing, the event catalogue, delivery                                                  | SP    | 0.4–0.6 | —                                           | yes (planning only)                               | pkey-wire-planner | later, optional, deferred |
| SP-67 | Developer webhooks: delivery, console endpoints, `verifyWebhook()` and `polarisWebhook()` in every server drop-in                  | SP    | 1.8–2.5 | SP-66, SP-55, SP-56, SP-57                  | yes (executes `plans/SP-66.md`)                   | pkey-implementer  | later, optional, deferred |
| SP-68 | `requireSignIn()` accepts I-21 issuer tokens (`Authorization: Bearer`, RS256 JWKS)                                                 | SP    | 0.5–0.8 | I-21, SP-55, SP-56, SP-57                   | no                                                | pkey-sdk-porter   | later                     |
| UK-51 | Terminal drop-in contract: the `cli` family in `ui-matrix.json`, exit 4                                                            | UK    | 0.4–0.6 | UK-02b                                      | yes (executes §7.1 and §9.3)                      | pkey-implementer  | must                      |
| UK-52 | Node CLI frameworks, should tier: the `@polaris-key/oclif` plugin and Ink components                                               | UK    | 1.2–1.6 | UK-46, UK-51                                | no                                                | pkey-implementer  | should                    |
| UK-53 | Textual screens for host apps                                                                                                      | UK    | 0.6–0.9 | UK-48, UK-51                                | no                                                | pkey-implementer  | should                    |
| UK-54 | JVM terminal kit on Mordant, with Clikt and picocli adapters                                                                       | UK    | 1.8–2.4 | UK-51, UK-02b                               | no                                                | pkey-sdk-porter   | should                    |

Totals by tier:

| Tier   | Weeks                                                              |
| ------ | ------------------------------------------------------------------ |
| Must   | 9.9–13.8                                                           |
| Should | 6.9–9.6                                                            |
| Later  | 2.7–3.9 (SP-66 and SP-67 wait for the owner's go on push webhooks) |
| All    | about 20–27                                                        |

### 12.2 Edits to existing packages

| Package                  | Change                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **UK-46**                | `withLicense` becomes `requireLicense` (one name for servers and CLIs). Adds `namespace`, `onCollision` and `frame: false`. yargs moves to `./cli/yargs`. Follows UK-51's rows and exit 4. |
| **UK-48**                | Adds `namespace` and `onCollision`, and accepts the host's `rich.Console`. Follows UK-51's rows and exit 4.                                                                                |
| **SP-33a**               | `sdkFit` hosts `server` and `cli` plus `framework` (§10). `renderUsage(feature, lang, lane, framework)` with lane `server`. Goldens for each must-tier framework.                          |
| **ST-41**                | Renders the server and CLI cards (§10).                                                                                                                                                    |
| **ST-40**                | A trust-manifest fetch with a `*-server` `sdkId` records a server sighting. That sighting is the server lane's Verified.                                                                   |
| **SP-32a**               | Adds `backend.origins` to the `polaris-key.json` schema and to `fromConfig()`.                                                                                                             |
| **SP-35**                | Adds `api.json` rows with `layer: server` or `cli` for every name in §5–§7, and the `requireLicense` family across servers and CLIs.                                                       |
| **SP-31**                | Bridge v4 gains `backendHeaders()`, so `usePolarisFetch()` works in Electron.                                                                                                              |
| **I-24, I-24a**          | `profile.user` is emitted for every subject-bound device (SP-54). I-24a adds only the policy keys.                                                                                         |
| **ST-27, CM-22, LX-13**  | Push delivery uses SP-66's format once SP-66 is approved. Until then, LX-13 keeps pull feeds and ST-27 signs with the same Standard Webhooks signer.                                       |
| **SP-36, P0-52**         | The examples tree includes `server-*` and `cli-*`. The lockstep set gains `@polaris-key/server` and `@polaris-key/oclif`.                                                                  |
| **DOC-08a, DOC-09a/b/c** | Quickstarts fork App · Server · CLI. Licensing, Sign-in and Managed config carry the server lane. `server-verification` becomes the concepts page (§10).                                   |

## 13. Open questions

Each question has a recommendation. The owner accepted every recommendation below (lead authority, 2026-10-08).

1. **Header or `Authorization`?** Recommend `X-PKey-License`. It follows the `X-PKey-*` family,
   leaves the app's own `Authorization` alone, and matches today's example.
2. **Default freshness: one hour, `graceUntil`, or five minutes?** Recommend one hour, the
   document's own `expiresAt`. A client calling its backend is online by definition, so offline
   grace does not apply. Firebase ID tokens also last an hour. `maxAgeSeconds` covers the other
   cases.
3. **A one-hour replay window, or a device-bound proof?** Recommend accepting the window in v1 and
   documenting it. A short, audience-bound assertion signed for each device would be a new endpoint
   and `typ`, with a device key. Plan it only when a customer needs it.
4. **Sign-in on the backend: `profile.user` now (SP-54), or wait for I-21?** Recommend SP-54. It is
   one optional signed member, offline, and keyed the same way I-21's `sub` will be. SP-68 adds I-21
   tokens later.
5. **Node packaging: one `@polaris-key/server`, subpaths on `@polaris-key/node`, or a package per
   framework?** Recommend `@polaris-key/server` (§8).
6. **Swift on Linux: add `apple/swift-crypto` for Linux builds?** Recommend yes, used only on Linux.
   It is Apple's API-compatible CryptoKit, and Vapor runs on Linux. The alternative is no Swift
   server drop-in.
7. **Online checks (immediate revocation, a subject's entitlements)?** Recommend leaving them out of
   this program. They need LX-13's routes and a product server credential (W12), which nobody has
   designed yet.
8. **Config on a server: "a server is a device", or a server credential?** Recommend the device
   model for v1. It needs no new contract.
9. **Next.js server components and Server Actions** cannot carry custom headers. Recommend header
   only in v1 (route handlers). An opt-in cookie mode can follow if a customer asks, after SP-40.
10. **CLI exit code for a refused gate: 4 or 1?** Recommend 4, as `gh` uses it for "requires
    authentication".
11. **Webhooks now or later?** Recommend later. SP-66 is deferred until the owner's go, and its
    format is fixed before CM-22, LX-13 or ST-27 invent one.

## 14. Self-critique

What a senior backend engineer at Clerk or Stripe would push on, and what the plan now says:

- **"An hour-long bearer is long. Ours live 60 seconds."** The plan states the window and the
  revocation bound (§5.5). It offers `maxAgeSeconds`, and it refreshes ahead of expiry on the
  client. A device-bound proof is Q3.
- **"Device binding is theatre."** Agreed. The plan calls it a consistency check and never claims
  proof of possession.
- **"Key rotation will break pinned backends."** The trust manifest refreshes on a schedule and on
  an unknown `kid` (§5.1).
- **"You're putting PII in a header on every request."** The holder's name and email do travel. The
  plan adds redaction, APM scrubbing in the docs and a PRIVACY row (§5.5).
- **"Refunds need immediate cut-off."** Not offline. The bound is about 65 minutes; immediate
  cut-off waits for LX-13 (Q7).
- **"Where do the errors go in my framework?"** `errors: "throw"` hands them to the framework, and
  DRF and Spring use their native exceptions (§5.2).
- **"A 401 without `WWW-Authenticate`."** Fixed: `PKey-License` with an `error` parameter.
- **"Test it without your servers."** `/testing` signers and `pkey dev` (§11).
- **"Edge runtimes."** The core uses WebCrypto Ed25519 only. CI covers Node and workerd, with a
  smoke run on Bun and Deno.
- **"My backend goes down when you do."** A failed manifest fetch keeps the last verified set, and
  pinned keys always verify. Only documents that go stale during a Polaris Key outage of more than
  an hour are refused, and `maxAgeSeconds` widens that window (§5.1).
- **"I need metrics on refusals without logging tokens."** `onVerdict(code, step)` (§5.2).
- **"Entitlements aren't all booleans."** `requireEntitlement(name, test)` (§5.4).
- **"Webhooks without raw body, dedupe, retries or a local forwarder are toys."** All four are in
  SP-66's scope (§5.8).
- **"Gated responses cached by a CDN."** Refusals are `no-store`, and gated responses default to
  `private` (§5.2).
- **"Header limits."** A 16 KiB cap and a client warning at 8 KiB (§5.5).
- **"Deploy order."** Ship the client half before gating routes (§9.4).

This review added to the draft:

- the customised form for every framework;
- the Bun and Deno smoke runs;
- the outage and amplification rules for the trust manifest;
- `onVerdict`, valued entitlements, a setup error when License is off, and the NTP note.

---

## Sources

- [S1] Clerk, Express SDK: `clerkMiddleware`, `getAuth`, `requireAuth` deprecated. https://clerk.com/docs/reference/express/overview
- [S2] Clerk, manual JWT verification: `jwtKey`, `authorizedParties`, `__session` versus `Authorization`. https://clerk.com/docs/backend-requests/manual-jwt
- [S3] Clerk, how Clerk works (60-second session tokens): https://clerk.com/docs/guides/how-clerk-works/overview · session token claims: https://clerk.com/docs/backend-requests/resources/session-tokens · Testing Tokens: https://clerk.com/docs/testing/overview · Next.js `clerkMiddleware`: https://clerk.com/docs/reference/nextjs/clerk-middleware · Fastify `clerkPlugin`: https://clerk.com/docs/reference/fastify/overview
- [S4] Auth0, `express-oauth2-jwt-bearer` (RFC 6750 errors, `requiredScopes`, `claimCheck`, DPoP): https://github.com/auth0/node-oauth2-jwt-bearer/tree/main/packages/express-oauth2-jwt-bearer · `express-openid-connect`: https://github.com/auth0/express-openid-connect
- [S5] Hono, `@hono/clerk-auth`: https://github.com/honojs/middleware/tree/main/packages/clerk-auth
- [S6] Supabase, server-side clients, `getClaims` versus `getUser`: https://supabase.com/docs/guides/auth/server-side/creating-a-client
- [S7] Stripe, webhooks: raw body, `constructEvent`, 5-minute tolerance. https://docs.stripe.com/webhooks · https://docs.stripe.com/webhooks/signature
- [S8] Standard Webhooks specification: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- [S9] Hono, factory helper (`createMiddleware`): https://hono.dev/docs/helpers/factory · context and `Variables`: https://hono.dev/docs/api/context · middleware guide: https://hono.dev/docs/guides/middleware
- [S10] Fastify, decorators: https://fastify.dev/docs/latest/Reference/Decorators/ · `fastify-plugin`: https://github.com/fastify/fastify-plugin
- [S11] NestJS, guards: https://docs.nestjs.com/guards · custom decorators: https://docs.nestjs.com/custom-decorators
- [S12] Next.js, Proxy (formerly Middleware; v16 rename, Node runtime, verify inside each function): https://nextjs.org/docs/app/api-reference/file-conventions/proxy · route handlers: https://nextjs.org/docs/app/api-reference/file-conventions/route
- [S13] FastAPI, dependencies: https://fastapi.tiangolo.com/tutorial/dependencies/ · security: https://fastapi.tiangolo.com/tutorial/security/get-current-user/
- [S14] Flask, view decorators: https://flask.palletsprojects.com/en/stable/patterns/viewdecorators/
- [S15] Django, middleware: https://docs.djangoproject.com/en/5.2/topics/http/middleware/ · DRF authentication (401 and `WWW-Authenticate`): https://www.django-rest-framework.org/api-guide/authentication/ · permissions: https://www.django-rest-framework.org/api-guide/permissions/
- [S16] Vapor, middleware: https://docs.vapor.codes/advanced/middleware/ · authentication: https://docs.vapor.codes/security/authentication/
- [S17] Ktor, authentication: https://ktor.io/docs/server-auth.html · JWT (`validate`, `challenge`, `principal`): https://ktor.io/docs/server-jwt.html
- [S18] Spring Security, OAuth 2.0 resource server with JWT: https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html
- [S19] Keygen, licences and the `validate` action: https://keygen.sh/docs/api/licenses/ · offline licence files: https://keygen.sh/docs/api/cryptography/ · response signatures (5-minute replay advice): https://keygen.sh/docs/api/signatures/
- [S20] RFC 9457, Problem Details for HTTP APIs: https://www.rfc-editor.org/rfc/rfc9457
- [S21] Lemon Squeezy, License API: https://docs.lemonsqueezy.com/api/license-api · webhook signing: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
- [S22] RevenueCat, webhooks (Authorization header, HMAC, retries): https://www.revenuecat.com/docs/integrations/webhooks · REST API v1: https://www.revenuecat.com/docs/api-v1
- [S23] oclif, plugins: https://oclif.io/docs/plugins · hooks (`init`, `prerun`): https://oclif.io/docs/hooks · commander: https://github.com/tj/commander.js · yargs commands: https://github.com/yargs/yargs/blob/main/docs/advanced.md · citty: https://github.com/unjs/citty · cac: https://github.com/cacjs/cac · clipanion: https://mael.dev/clipanion/docs/ · @clack/prompts: https://github.com/bombshell-dev/clack/tree/main/packages/prompts
- [S24] click, commands and groups: https://click.palletsprojects.com/en/stable/commands/ · click-plugins: https://github.com/click-contrib/click-plugins
- [S25] Typer, `add_typer`: https://typer.tiangolo.com/tutorial/subcommands/add-typer/ · callbacks: https://typer.tiangolo.com/tutorial/commands/callback/
- [S26] Clikt, commands and context objects: https://ajalt.github.io/clikt/commands/ · https://ajalt.github.io/clikt/advanced/ · Mordant: https://ajalt.github.io/mordant/
- [S27] picocli (subcommands, execution strategies, mixins): https://picocli.info/
- [S28] swift-argument-parser, commands and subcommands: https://github.com/apple/swift-argument-parser/blob/main/Sources/ArgumentParser/Documentation.docc/Articles/CommandsAndSubcommands.md
- [S29] Textual, screens: https://textual.textualize.io/guide/screens/ · prompt_toolkit full-screen apps: https://python-prompt-toolkit.readthedocs.io/en/master/pages/full_screen_apps.html
- [S30] Ink: https://github.com/vadimdemedes/ink
- [S31] GitHub CLI, `gh auth login`: https://cli.github.com/manual/gh_auth_login · exit codes: https://cli.github.com/manual/gh_help_exit-codes · extensions: https://docs.github.com/en/github-cli/github-cli/creating-github-cli-extensions
- [S32] Cloudflare Wrangler, `wrangler login`: https://developers.cloudflare.com/workers/wrangler/commands/general/ · Vercel CLI `vercel login`: https://vercel.com/docs/cli/login
- [S33] WorkOS, CLI Auth (device grant): https://workos.com/docs/user-management/cli-auth · Clerk as an identity provider (device grant): https://clerk.com/docs/advanced-usage/clerk-idp
