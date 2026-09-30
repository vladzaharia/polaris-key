# R10 — Denial of service, resource exhaustion, availability

**Scope.** Worker CPU/memory/subrequest limits, D1/KV/DO quotas and cost, rate-limit bypass
and rate-limiter fragility, crash-the-request bugs.

**Why availability is a security property here.** Polaris Key gates paid software. An outage
of `GET /<product>/config` or `POST /<product>/activate` blocks paying customers from using
software they already bought; an outage of `/<product>/appcast.xml` or `/<product>/dmg/…`
blocks security updates from reaching installed clients.

**PoC.** `packages/worker/test/attack/R10-dos.test.ts` — 28 tests, all passing (i.e. all
attacks reproduce). Run:

```
export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"
cd packages/worker && npx vitest run test/attack/R10-dos.test.ts
```

**A note on the test harness.** Vitest runs under Node, where `Function(string)` codegen
works. Production runs under workerd, where it does not. Tests marked "on workerd" install a
`globalThis.Function` proxy that throws the exact `EvalError: Code generation from strings
disallowed for this context` workerd raises, so the production failure mode is reproduced
faithfully in Node.

---

## Severity summary

| ID     | Title                                                                           | Severity     |
| ------ | ------------------------------------------------------------------------------- | ------------ |
| R10-01 | Ajv runtime codegen on `/config` ⇒ every managed-config request 500s on workerd | **Critical** |
| R10-02 | `aarch64` / `amd64` arch aliases ⇒ guaranteed unhandled `TypeError` (500)       | **High**     |
| R10-03 | `rateLimitOk` has no fail mode — a DO blip becomes a licensing outage           | **High**     |
| R10-04 | Single-shard `RateLimitDO` with unbounded, never-collected storage              | **High**     |
| R10-05 | Unauthenticated GitHub-subrequest amplifier on the public release surface       | **High**     |
| R10-06 | `POST /<p>/session/license` is an unrate-limited `/activate` clone              | **Medium**   |
| R10-07 | Unauthenticated KV-write amplification on `/<p>/auth/*`                         | **Medium**   |
| R10-08 | `/webhooks/github` buffers the entire request body before authenticating it     | **Medium**   |
| R10-09 | Manual-channel regex ReDoS — the 80-char cap is not a guard                     | **Medium**   |
| R10-10 | `GET /<p>/config` is unrate-limited and writes D1 on every poll                 | **Medium**   |
| R10-11 | Uncapped request headers written verbatim into D1 device rows                   | **Medium**   |
| R10-12 | KV token records have no TTL and are resurrected by _rejected_ requests         | **Medium**   |
| R10-13 | Portal API: two full `licenses` table scans + writes per request, unmetered     | **Medium**   |
| R10-14 | Admin API 403s write a D1 audit row, unmetered                                  | **Low**      |
| R10-15 | Unbounded `.sig` asset read inlined into the appcast XML                        | **Low**      |
| R10-16 | No JWS _header_ size cap in any implementation (SDK-side)                       | **Low**      |
| R10-17 | GitHub-controlled sleep (≤5.25 s) inside the request path                       | **Info**     |

---

## R10-01 — Ajv runtime codegen on the licensing hot path ⇒ `/config` always 500s on workerd

**Severity: Critical.** This is not a degradation, it is a total outage of the product's
core function, triggered by every single legitimate request, with no attacker required.

**Location**

- `packages/shared-catalog/src/catalog.ts:28` (`new Ajv({allErrors:true, strict:false})`),
  `:47-58` (`compileAll` / `validatorFor` → `this.ajv.compile(entry.schema)`)
- `packages/worker/src/licensing.ts:509-523` — `new Catalog(JSON.parse(schemaRow.catalog_json))`
  constructed **inside** `handleConfig`, then `validatePayload`
- `packages/worker/src/configDoc.ts:45` — `catalog.validateKeyValue(key, entry.value)`
- `packages/worker/src/licenseCore.ts:157-183` — `catalogDefaultPayload` seeds the payload with
  every catalog `config` entry that has a `default`, guaranteeing the validate path is entered
- `packages/worker/src/admin/handlers/schema.ts:40`, `admin/handlers/products.ts:86-87`,
  `admin/lib/overrides.ts:55`
- `node_modules/.../ajv/dist/compile/index.js:89` — Ajv builds `makeValidate` with the dynamic
  `Function` constructor over generated source text

**The runtime fact.** The module header at `catalog.ts:3-7` says workerd forbids codegen
outside startup. That is **still true, and the header understates it**: Cloudflare's
`allow_eval_during_startup` compatibility flag (default since 2025-06-01) carves out an
exception _for the startup phase only_. Inside a request handler, `Function(string)` throws
`EvalError: Code generation from strings disallowed for this context`. There is no
`unsafe-eval` escape hatch for Workers. `wrangler.toml` sets
`compatibility_date = "2026-04-07"` with no opt-out flag, so this applies.

The header's own mitigation ("call `compileAll()` when a catalog is first loaded, cache the
Catalog per product+schemaVersion") **was never implemented**. Nothing caches a `Catalog`;
all six construction sites build a fresh instance inside a request.

**Impact chain**

1. `GET /<product>/config` — `resolveEffective` populates `payload.config` from the catalog's
   defaults, `validatePayload` then compiles a validator per key. The first compile throws. The
   `try/catch` at `licensing.ts:516-522` converts it to
   **HTTP 500 `catalog_unavailable`**. Every device, every poll, every product whose catalog
   has at least one `config` entry — which is every real product; the shipped
   `products/djdl/catalog.json` has 16 such entries. **The managed-config endpoint is
   100% down in production.**
2. `PUT /manage/api/products/<slug>/schema` — `compileAll()` throws, caught at
   `schema.ts:41-45`, returns **422 "invalid catalog"** for _every_ catalog, including
   valid ones. Operators can never publish a schema.
3. `POST /manage/api/products` — same, via `compileSchema` (`products.ts:85-93`).
4. `PATCH` license/profile overrides — `overrides.ts:55` is **not** wrapped; the `EvalError`
   escapes `handleProductScoped` (only `AdminBodyError` is caught at `admin/api.ts:191-195`)
   ⇒ unhandled 500.
5. `browserSession.ts:185-195` catches and _fails open_ — browser sessions silently skip
   catalog validation entirely, so the defence-in-depth prune described in
   `configDoc.ts:28-32` never runs there. (Cross-lane note for whoever owns integrity.)

**Amplifier, secondarily.** Even where codegen is permitted, this is a per-request
compile-and-throw-away: the PoC measures **≥16 Ajv compilations per `/config` request**, with
zero reuse between two identical back-to-back requests. Ajv codegen is one of the most
expensive things a request can do; on a 10 ms CPU budget this alone is a self-inflicted CPU
DoS on the hottest endpoint. A product admin who publishes a 64 KiB catalog with hundreds of
entries multiplies it further.

**PoC status: PROVEN.**

- `R10-01 > GET /<product>/config runs dynamic codegen on every request` (≥16 compiles)
- `R10-01 > the codegen is NOT cached: a second identical request recompiles from scratch`
- `R10-01 > on workerd (no runtime codegen) GET /config returns 500 catalog_unavailable`
- `R10-01 > on workerd, publishing ANY catalog via the admin API is rejected 422`
- `R10-01 > even a trivial {type:'string'} fragment needs codegen (no interpreted path)`

**Fix direction**

- Replace Ajv with an interpreting validator (`@cfworker/json-schema` is the standard
  workerd-safe drop-in), **or** precompile catalogs to standalone modules at build time.
  Ajv's `code: {source:false}` does _not_ avoid dynamic codegen — verify any claimed
  workaround against the proxy in the PoC.
- Independently: cache `Catalog` instances keyed by `(product, catalog_version)` in module
  scope so parse+compile happens once per isolate, not once per request.
- Independently: `handleConfig`'s catch converting _any_ validation failure into a 500 is a
  hair-trigger; distinguish "catalog is malformed" from "validator unavailable".

---

## R10-02 — `aarch64` / `amd64` arch aliases produce a guaranteed unhandled `TypeError`

**Severity: High.** Unauthenticated, deterministic 500 on the public download surface, on
exactly the URLs a Linux/macOS `uname -m` produces.

**Location**

- `packages/worker/src/router.ts:51` — `const ARCH = /^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$/`
  captures four tokens; `:153` / `:159` return the captured token verbatim as `arch`.
- `packages/worker/src/index.ts:154,159` — `arch: route.arch as Arch`. The cast is a lie:
  `Arch = "arm64" | "x86_64"` (`release/assets.ts:14`).
- `packages/worker/src/release/assets.ts:17-20,52-55` — `ARCH_TOKENS[arch]` is `undefined` for
  `"aarch64"`/`"amd64"`; `[...wanted]` throws `TypeError: wanted is not iterable`.
- `packages/worker/src/release/index.ts:256-258` — `handleRelease` catches **only**
  `NotFoundError` and rethrows everything else ⇒ unhandled ⇒ 500.

**Preconditions.** A product with a `release_config`, and at least one release asset with the
requested extension (any `.dmg` for the dmg route; any extension-less asset for the cli
route). `archMatches` is short-circuited behind the extension check, so a release with zero
matching-extension assets 404s instead — but any product actually shipping DMGs or bare
binaries is vulnerable.

**Exploit.** `GET https://key.plrs.im/<product>/dmg/1.2.3/anything-aarch64.dmg` → 500. `GET https://key.plrs.im/<product>/cli/1.2.3/anything-amd64` → 500.

**Impact.** Deterministic 500 per request; each one first burns a GitHub App installation
token fetch plus a `resolveRelease`/`listReleases` subrequest (see R10-05), so it is also the
cheapest way to burn the product's GitHub API quota. Note this is _also_ a correctness bug:
installers and CI that use `uname -m` output (`aarch64` on Linux ARM, `amd64` in the Go/Docker
world) hit a hard 500 rather than a redirect.

**PoC status: PROVEN.** `R10-02 > the router hands aarch64/amd64 through verbatim`,
`… /dmg/<v>/<name>-aarch64.dmg throws out of handleRelease`,
`… /cli/<v>/<bin>-amd64 throws out of handleRelease`, plus a control test showing
`arm64` succeeds.

**Fix direction.** Normalize in the router (map `aarch64→arm64`, `amd64→x86_64`) and make
`Arch` a parsed type rather than a cast. Add a catch-all in `handleRelease` that maps unknown
throws to a 500 with no detail (or a 404) instead of letting them escape. Make the
`ARCH_TOKENS` lookup total (`?? new Set()`).

---

## R10-03 — `rateLimitOk` has neither a fail-open nor a fail-closed path

**Severity: High.**

**Location.** `packages/worker/src/rateLimit.ts:17-36`. No `try`/`catch`; line 34 destructures
`(await res.json())` with no guard on status or content type.

**Failure modes that reach production.** `stub.fetch()` rejects on: DO overload, "Durable
Object reset because its code was updated" (i.e. **every deploy**), transient network errors
to the DO's colo, and DO exceptions. Any of these throws straight out of `handleActivate`,
`handleToken`, `handleEnroll`, `handleMintToken`, `handleAdminLogin`, `handleAdminCallback`,
`handlePortalLogin`, `handleMagicStart`, and the portal action limiters — as an unhandled
exception ⇒ HTTP 500.

**Impact.** The rate limiter is a hard dependency of the credential-minting hot path with no
degraded mode. A DO incident, or merely a code-update reset landing on an in-flight request,
converts into 500s on `/activate` and `/token` for every product. Because `rateLimitOk` runs
_before_ any auth check on `/activate` (`licensing.ts:298`), there is no path that bypasses
it. The 500 also leaks a stack-trace-shaped failure rather than a clean 429/503.

**PoC status: PROVEN.** `R10-03 > a DO error escapes rateLimitOk unhandled`,
`… a non-JSON DO response also escapes (res.json() destructure)`,
`… POST /<p>/activate throws (⇒ 500) instead of degrading when the DO is down`.

**Fix direction.** Wrap in `try/catch`, validate `res.ok` and the parsed shape, and pick an
explicit documented policy — fail-open for licensing (availability wins: a paying customer
must not be locked out by a limiter outage) and fail-closed for admin/portal login. Emit a
metric either way. Consider Cloudflare's native Rate Limiting binding, which has defined
failure semantics, instead of a hand-rolled DO.

---

## R10-04 — `RateLimitDO`: one global shard per product, storage that is never reclaimed

**Severity: High** (combined availability + unbounded cost).

**Location.** `packages/worker/src/rateLimitDo.ts:22-50`; `rateLimit.ts:23`
(`env.RL.get(env.RL.idFromName(product))`).

### 4a — Single global shard (availability)

`idFromName(product)` yields exactly **one** Durable Object per product, world-wide, for every
bucket and every client. Admin and portal collapse further: `admin/auth.ts:151,196` and
`portal/auth.ts:174,311` + `portal/api.ts:275` all use the literal shards `"_admin"` and
`"_portal"` — one object each, for the entire platform.

A DO is single-threaded and pinned to one colo, and every check performs a storage
read + write. Consequences:

- Every `/activate` and `/token` request world-wide pays a round trip to that one colo before
  any work happens (tens to hundreds of ms of added tail latency).
- An attacker who saturates that one object's throughput queues (and eventually errors) every
  legitimate `/activate` and `/token` for that product — and via R10-03 those errors surface
  as **500s, not 429s**. One product's DO is a global kill switch for that product's
  licensing.
- `"_portal"` and `"_admin"` are cross-tenant: saturating them locks _all_ operators out of
  the admin console.

The header comment "One Durable Object instance per product … so storage stays bounded by the
active client set" documents the sharding as intentional; the availability consequence is not
acknowledged anywhere.

### 4b — Storage grows without bound (cost)

`this.state.storage.put(key, counter)` at `:43` with key `` `${bucket}:${id}` ``. There is
no `expirationTtl`, no `alarm()`, no `deleteAll`, no sweep anywhere in the class or the repo.
The comment's claim that a counter "rolls over when the window advances, so storage stays
bounded by the active client set" is **false**: rollover overwrites the _value_, it never
deletes the _key_. A key created by one request from one IP in 2026 is still resident in 2030.

`id` is `clientIp(req)`. Over IPv6 an attacker with a routed /64 controls 2^64 distinct source
addresses at zero cost, each one minting a permanent DO storage key.

Quantified (KV-backed DO pricing — `wrangler.toml` uses `new_classes`, not
`new_sqlite_classes`): key `activate:<ipv6>` ≈ 48 B, value ≈ 30 B, plus per-key overhead.

- 1 M distinct IPs ⇒ 1 M storage writes ($1.00/M) + ~100 MB resident, billed monthly, forever.
- 100 M ⇒ ~10 GB permanent, ~$2/month accruing indefinitely, and a DO whose storage index the
  runtime must keep paging.

It is a slow-burn cost/reliability problem rather than an instant outage, but it never
self-heals and there is no operator-facing way to clear it short of deleting the DO class.

**PoC status: PROVEN.** `R10-04 > each distinct client id leaves a permanent stored key`
(500 IPv6 addresses ⇒ 500 keys, 500 writes),
`… keys from an expired window are never deleted — they just sit there` (a counter one year
stale is still resident), `… the DO is a single global shard per product`.

**Fix direction.**

- Shard: `idFromName(`${product}:${bucket}:${hash(id) % N}`)` — or use the native Rate Limiting
  binding, which is edge-local and needs no storage.
- Bound storage: pass `{ expirationTtl }` on `put` under SQLite-backed storage, or set an
  `alarm()` that deletes keys whose `window` is older than the current one.
- Consider not persisting at all: an in-memory `Map` in the DO with a periodic alarm sweep is
  sufficient for a fixed-window limiter and costs nothing.

---

## R10-05 — Unauthenticated GitHub-subrequest amplifier on the public release surface

**Severity: High.** Cheapest request-to-damage ratio in the whole worker.

**Location.** `packages/worker/src/release/index.ts:279-322` (`resolveSelector` →
`listReleases(…, 100, …)` / `resolveRelease`), `:447-454` (changelog: `listReleases(…, 50)`),
`:563-572` (appcast: `token` + `fetchTextAsset`), `:507-515` (binary: `streamAsset`, up to two
upstream fetches). Access defaults to `public` (`index.ts:86-90,97-99`).

**Preconditions.** None. `GET /<p>/appcast.xml`, `/version`, `/changelog`, `/cli/…`,
`/dmg/…` are unauthenticated by default and **not rate-limited** (no `rateLimitOk` call
anywhere under `release/`).

**No cache absorbs this.** The handlers set `cache-control: public, max-age=300`, but there is
no `caches.default` / Cache API use anywhere in `packages/worker/src` (verified by grep) and
Workers responses are not CDN-cached by default on a custom-domain route. Every request
executes the handler and issues its GitHub subrequests.

**Impact, quantified.** A GitHub App installation token is limited to **5,000 REST requests
per hour** per installation. `/appcast.xml` costs ≥2 GitHub calls (list + `.sig` text fetch).
A single client at ~1 req/s exhausts the hour's quota in roughly **20 minutes**. Once
exhausted, `listReleases`/`resolveRelease` see 403/429, throw `NotFoundError`
(`github.ts:68,84`), and **every release endpoint for that product returns 404** —
`install.sh`, `/version`, `/changelog`, the Sparkle appcast, and all binary downloads. Auto
updaters stop seeing updates; new installs fail. That is a security-update delivery outage,
achievable from one laptop, with no credentials.

Secondary: Workers subrequest limits (50/request Free, 1000 Paid) and the 30 s wall clock are
consumed per request; `handleBinary` proxies the _entire_ asset body through the Worker
(`index.ts:520`), so egress and duration scale with artifact size (DMGs are commonly
100 MB – 2 GB) with no per-IP cap.

**PoC status: PARTIAL** — the subrequest fan-out is visible in the existing
`packages/worker/test/release.test.ts` fetch-stub call logs; the GitHub-quota exhaustion is
reasoned from documented GitHub limits, not executed against GitHub.

**Fix direction.** Add `rateLimitOk` to the release surface keyed by `(product, clientIp)`;
put `caches.default` in front of `resolveSelector`/`listReleases` results keyed by
`(product, selector)` with a short TTL; return 503 (not 404) when GitHub signals rate
limiting so operators can tell exhaustion from "no such release".

---

## R10-06 — `POST /<p>/session/license` is an unrate-limited `/activate`

**Severity: Medium.**

**Location.** `packages/worker/src/browserSession.ts:250-292`. Compare
`licensing.ts:298-307`, where the equivalent key-redemption path _is_ limited to 30/min/IP.

Per unauthenticated request it performs: `loadProduct` (3 D1 reads + an AES-GCM key unseal),
`hashKey`, `getKey`, `getLicense`, then `createBrowserSession` → `authorizeDevice`
(`getTier`, `getDevice`, `resolveEffective`, `countActiveDevices`, `upsertDevice` **write**,
`putTokenRecord` **KV write**) + a second **KV write** for the session record + `touchKey`
**D1 write**. That is ~8 D1 reads, 2 D1 writes and 2 KV writes for one anonymous POST, with
no limiter.

**Impact.** (a) Cost/throughput amplifier against shared D1 and KV. (b) It is also the
unmetered sibling of the rate-limited `/activate` — the same license-key oracle without the
30/min brake. Cross-lane note for the credential-attack owner: `/activate` being limited while
`/session/license` is not means the brute-force control is bypassable by changing the URL.

**PoC status: NOT WRITTEN** (the D1/KV cost is directly readable from the call graph; the
missing limiter is a two-line grep — `rateLimitOk` does not appear in `browserSession.ts`).

**Fix direction.** Apply the `activate` bucket (same limit, same key) to
`handleBrowserSessionLicense`.

---

## R10-07 — Unauthenticated KV-write amplification on `/<p>/auth/*`

**Severity: Medium.**

**Location.** `packages/worker/src/oidc.ts:508-510` (`beginAuthFlow` → 1 KV put),
`:584-588` (`handleAuthDeviceStart` → a _second_ KV put), `:626-630`
(`handleAuthDeviceVerify?confirm=1` → a third), `:814-816` (callback rewrite). None of these
handlers calls `rateLimitOk`; `index.ts:118-133` routes them with no gate.

**Exploit.** `POST /<p>/auth/device/start` with `{"deviceId":"x"}` — no credentials needed
beyond the product existing. Each request writes **2 KV records** (`p:<p>:flow:<state>` and
`p:<p>:device-flow:<code>`) plus ~4 D1 reads (`loadProduct` + `oidc_config`).
`GET /<p>/auth/start` writes 1.

**Quantified.** KV writes bill at $5.00 per million. A single host sustaining 1,000 req/s
writes 2,000 KV records/s ⇒ 7.2 M writes/hour ⇒ **~$36/hour**, indefinitely, from
unauthenticated traffic. TTL is 600 s so _storage_ stays bounded, but the _write_ cost does
not. Workers request billing and D1 row-read billing stack on top.

**PoC status: PROVEN.** `R10-05 > POST /<p>/auth/device/start costs 2 KV writes per anonymous
request` (25 requests ⇒ 50 KV records, no 429),
`… GET /<p>/auth/start costs 1 KV write per anonymous request`.

**Fix direction.** Rate-limit the flow-start endpoints per IP (they are the only `/auth/*`
routes that _create_ state; poll/callback only read it). A 10/min/IP bucket is generous for a
human sign-in.

---

## R10-08 — `/webhooks/github` buffers the entire request body before authenticating it

**Severity: Medium.**

**Location.** `packages/worker/src/githubWebhook.ts:118-124`:

```ts
const raw = new Uint8Array(await req.arrayBuffer());
const ok = await verifySignature(
  secret,
  raw,
  req.headers.get("x-hub-signature-256"),
);
if (!ok) return errorResponse(401, "unauthorized", "invalid signature");
```

HMAC over the body inherently requires the body, so the read _must_ precede verification —
but nothing bounds it first. There is no `content-length` precheck and no streaming cap,
unlike `/config/report`, which checks `content-length` _and_ re-checks the decoded length
against 16 KiB (`licensing.ts:580-585`), or `/activate` (`licensing.ts:120-128`).

**Impact.** An unauthenticated POST pins its whole body in isolate memory (Worker memory limit
is 128 MB; Cloudflare's request body limit is 100 MB on Free/Pro, 500 MB on Business) and then
pays a full-body HMAC-SHA-256 before rejecting it. Concurrent large bodies OOM the isolate,
which terminates **other in-flight requests sharing it**. Even below OOM it is a pure CPU
burn: HMAC over 100 MB is well past the CPU budget.

**PoC status: PROVEN.** `R10-06 > a multi-megabyte unsigned body is fully read + HMAC'd before
the 401` (4 MiB fully consumed, then 401), `… there is no Content-Length precheck on the
webhook`.

**Fix direction.** Reject on `content-length` above a small cap (GitHub push payloads are
bounded; 1 MiB is generous) before touching the body, and read via a size-capped stream so a
lying or absent `content-length` cannot bypass it. Note that short-circuiting on the
`x-github-event` header first is _not_ a safe substitute — that header is unauthenticated.

---

## R10-09 — Manual-channel regex ReDoS: `MAX_REGEX_SOURCE = 80` is not a guard

**Severity: Medium.**

**Location.** `packages/worker/src/release/channels.ts:38` (`const MAX_REGEX_SOURCE = 80`),
`:81-89` (`compileChannelRegex`), `:163-167` (`resolveChannel` → `re.test(r.tag_name)` for up
to 100 releases per request).

**The cap does not do what its comment claims.** The comment says "short patterns can't
catastrophically backtrack". They absolutely can: `(x+x+)+y` is **8 characters** and exhibits
textbook exponential backtracking. Anchoring (`^(?:…)$`) does not help — it forces the engine
to explore the full failure tree.

**Measured (PoC, Node 22 on an M-series laptop):**

| tag length | wall time for ONE `.test()` |
| ---------- | --------------------------- |
| 22 x's     | ~10 ms                      |
| 27 x's     | ~330 ms                     |
| 28 x's     | ~2.4 s                      |
| 34 x's     | ~57 s                       |

Doubling per character. Git tag names may be far longer than 34 characters, so this is
unbounded in practice. `resolveChannel` multiplies it by the release-list length: up to 100
releases per request as audited, and more since P0-02 (see "Widened by P0-02" below).

**Preconditions.** A product admin (or a `.pkey/release.yaml` in a linked repo, applied by the
webhook resync path) sets `manual_channels_json`. `parseManualChannels` accepts the pattern —
it only checks length and compilability, never complexity. Triggering it is then
**unauthenticated**: `GET /<p>/<channel>/appcast.xml` (`router.ts:169-171`).

**Impact.** One unauthenticated request burns 2.4 s – minutes of CPU. Workers CPU limits
terminate the request (so it is a self-limiting 500 rather than an infinite hang), but a burst
of them exhausts the account's CPU budget and takes the release surface down. Because the
regex is admin-supplied, this is primarily an operator-footgun / insider vector rather than a
pure outsider attack — but it is also reachable by anyone who can land a `.pkey/release.yaml`
change in a linked repo.

**PoC status: PROVEN.** `R10-07 > an 8-character pattern under the cap backtracks
catastrophically`, `… runtime doubles per extra input character (exponential, not linear)`,
`… cost is multiplied by the release list length`.

**Widened by P0-02 (release resolution, 2026-09).** This finding is still open, and P0-02 made
its reach larger in two ways. Neither changes the precondition: write access to a linked repo's
`.pkey/release`, or a product admin.

1. **A second sink under the same non-guard.** `release.stableTagPattern` (column
   `release_config.stable_tag_pattern`) is compiled by `compileManualChannelRegex`, which applies
   the same length cap and compile check as a manual channel, and nothing else
   (`resolutionPolicy`, `packages/worker/src/services/release/channels.ts`). It is not confined to
   a manual channel's traffic. It runs against every non-draft, non-ignored, semver-parseable tag
   on every `latest`/`stable` resolution, and on every `beta` resolution that falls back to
   prereleases because no channel workflow is set. Those resolutions serve the ordinary
   unauthenticated appcast, `/version` and download routes. It also runs in
   `checkReleaseHealth` and in every truth-store sync.
2. **A longer release list.** Live resolution now reads up to `RELEASE_PAGE_CAP.live` = 3 pages
   of 100. The early-stop test looks at each new page once, and the pick then scans every
   release read, so one moving-selector resolution runs the pattern up to about **600** times
   (up to 300 releases, each tested twice). As audited it was 100. `checkReleaseHealth` adds a
   pre-check over the listed releases and one more full resolution for each floored channel that
   looks regressed. A sync reads up to `RELEASE_PAGE_CAP.sync` = 10 pages, so it tests up to
   **1,000 releases per channel**. Manual-channel regexes get the same larger lists.

What P0-02 does to limit this. It is ordering only, not a guard. The operator regex runs last,
after the draft, `ignoreTags`, semver-parse and (on the stable path) `!prerelease` checks have
each had the chance to reject a tag. Because an attacker with repo write access also controls the
tags, this cuts the cost of normal repos but does not bound the attack.

**Any fix for R10-09 must cover `stableTagPattern` as well as `manualChannels`.** Both go through
`compileManualChannelRegex` (the validator's rule, `shared-manifest`) and both are matched in
`channels.ts`. The same holds for the input-length cap on `tag_name`.

**Fix direction.** Do not compile operator regexes at all — a glob/prefix matcher covers the
real use case (`v*-nightly.*`). If regexes must stay, use a linear-time engine (RE2-style) or
statically reject nested quantifiers (`(…+)+`, `(…*)*`, alternations over overlapping
branches) and cap the _input_ (`tag_name`) length, not just the pattern length.

**Related, downgraded:** `packages/admin/src/SchemaForm.tsx:66-70` does
`new RegExp(schema.pattern).test(s)` with no cap. That runs in the operator's own browser tab
against a catalog the operator is editing; worst case it hangs one admin tab. Low, noted for
completeness. Server-side, Ajv would compile `pattern` from the same source — but see R10-01:
Ajv cannot compile at all under workerd, so there is no server-side ReDoS via catalog
patterns today. Fixing R10-01 with an interpreting validator will _introduce_ that exposure
unless the replacement caps pattern complexity.

---

## R10-10 — `GET /<p>/config` is unrate-limited and performs a D1 write on every poll

**Severity: Medium.**

**Location.** `packages/worker/src/licensing.ts:475-566`. No `rateLimitOk` call. Line 486
performs an unconditional `upsertDevice` (a D1 **write**) purely to stamp `last_seen`.

**Measured cost per request (PoC instrumentation):** 5 D1 reads + 1 D1 write inside
`handleConfig`, plus 3 more D1 reads in `loadProduct` (`product.ts:92-102`) and an AES-GCM
unseal of the signing key, plus an Ed25519 signature, plus ≥16 Ajv compilations (R10-01).
**8 D1 reads + 1 D1 write per poll**, and this is the endpoint every SDK polls on a timer.

**Impact.** (a) A single valid license key, activated once, gives an attacker an unmetered
D1-write faucet. (b) **All products share one D1 database** (`wrangler.toml` binds a single
`polaris_key_prod`), so one abusive tenant's `/config` traffic consumes the write capacity of
every other tenant — a cross-tenant availability coupling. (c) There is no ETag short-circuit
before the expensive work: `computeETag` runs after the full resolve/validate, so a 304
costs nearly as much as a 200 (`licensing.ts:553-556`).

**PoC status: PROVEN.** `R10-10 > each poll costs multiple D1 reads plus a device row write`
(logs the exact counts), `… 200 consecutive polls from one IP are all served — there is no 429
path`.

**Fix direction.** Rate-limit `/config` per device token (generously — say 60/min — so honest
clients never see it). Skip the `upsertDevice` when `last_seen` is within N minutes. Cache the
`Product` and `Catalog` per isolate. Move the ETag check earlier where possible.

---

## R10-11 — Uncapped request headers written verbatim into D1 device rows

**Severity: Medium.**

**Location.** `packages/worker/src/licensing.ts:65-81` (`deviceMetadata` — six raw
`req.headers.get()` calls, no truncation), consumed at `:485-495` (`handleConfig` →
`upsertDevice`), `:328` (`/activate`), `enroll.ts:189`, `browserSession.ts:95-103`.

**The inconsistency is the tell.** The report path caps every string at 128 chars
(`licensing.ts:213-215`), caps probe ids at 64, caps probe counts at `MAX_DEVICE_PROBES`, and
enforces a 16 KiB body limit — all of which is bypassed by putting the same data in a header
instead.

**Exploit.** `GET /<p>/config` with `user-agent`, `x-pkey-platform`, `x-pkey-arch`,
`x-pkey-version`, `x-pkey-sdk`, `x-pkey-sdk-version` each 16 KiB. Cloudflare permits ~16 KiB
per header and ~32 KiB of headers total, so roughly **32 KiB of attacker text lands in one
`devices` row per request**, overwriting the previous value each time (so it is bounded per
device, but multiplied by the device count an attacker can create). Every admin/portal view
that lists devices then serializes those columns into a JSON response
(`licensing.ts:244-259`, `portal/api.ts:209-221`) — a device list of 100 such rows is a
multi-megabyte response built entirely in isolate memory.

**PoC status: PROVEN.** `R10-08 > GET /config writes 16 KiB header values verbatim into
devices` (all six columns exactly 16384 chars), `… /activate has the same unbounded write`.

**Fix direction.** Truncate in `deviceMetadata` with the same 128-char rule the report path
uses — one `.slice(0,128)` per field, applied at the single choke point.

---

## R10-12 — KV token records have no TTL and are resurrected by _rejected_ requests

**Severity: Medium** (cost + a revocation-durability smell worth flagging cross-lane).

**Location.** `packages/worker/src/kv.ts:27-34` — `env.HOT.put(pk(...), JSON.stringify(rec))`
with no third argument. Every other KV writer in the codebase passes `{ expirationTtl }`:
`browserSession.ts:129-133` (30 d), `oidc.ts:508-510,584-588` (600 s),
`admin/auth.ts:168-170`, `portal/auth.ts:196-198,353-355`, `githubApp.ts:233-237`.

**Second, worse half — resurrection.** `licenseCore.ts:454-464`:

```ts
let device = rec ? await getDevice(...) : await getDeviceByTokenHash(db, product.slug, tokenHash);
if (!rec && device) { rec = {...}; await putTokenRecord(env, product.slug, tokenHash, rec); }  // ← 463
...
if (!device || device.status !== "authorized") return { error: "unauthorized" };                 // ← 467
```

The KV write at 463 happens **before** the status check at 467. `setDeviceStatus` does not
clear `devices.token_hash` (`repo.ts:957-974`), so a deauthorized device's hash stays in D1
forever. Therefore: deauthorize a device (which deletes the KV record), then replay the old
token → the request is correctly rejected 401, but the KV record for the revoked credential is
**written back, permanently, with no TTL**, on every replay.

**Impact.** (a) One KV write per replayed-stale-token request, on `/config`, `/account`,
`/devices`, `/deauthorize` — all unrate-limited — so it is a KV-write cost amplifier available
to anyone holding any once-valid token. (b) Because there is no TTL, those resurrected records
accumulate forever with no sweeper. (c) Cross-lane: a revocation mechanism that
re-materializes the artifact it just deleted is fragile; if any future code path trusts the KV
record's mere existence, revocation silently stops working.

**PoC status: PROVEN.** `R10-09 > putTokenRecord is called with no options object at all`
(asserts the call has exactly 2 arguments), `… replaying a revoked token rewrites the KV
record it was supposed to purge`.

**Fix direction.** Pass `{ expirationTtl }` on `putTokenRecord` (e.g. the doc/grace window).
Move the `device.status !== "authorized"` check above the rehydration write. Clear
`devices.token_hash` in `setDeviceStatus` when deauthorizing.

---

## R10-13 — Portal API: two full `licenses` table scans plus writes on every request

**Severity: Medium.**

**Location.** `packages/worker/src/portal/repo.ts:265-310` (`syncAccountLicenseLinks`),
called at `portal/api.ts:609` on **every** authenticated portal API request, and _again_
inside `handleMe` (`:294`) and `handleLicenses` (`:330`) — so twice per request.

Both inner queries are unindexed:

- `SELECT product, id FROM licenses WHERE lower(email) = ?` — there is no index on
  `licenses(email)` or on `lower(email)` in any migration ⇒ **full table scan**.
- `SELECT product, id FROM licenses WHERE sub = ?` — the only relevant index is
  `idx_licenses_sub ON licenses(product, sub)` (`0001_init.sql:81`), whose leading column is
  `product`; SQLite cannot use it for a `sub`-only predicate ⇒ **full table scan**.

Each match then issues a `linkLicense` upsert — a D1 **write** per matched license per
request.

**Impact.** Every portal page load scans the entire cross-tenant `licenses` table two to four
times and writes a row per linked license. There is no rate limit on portal reads
(`requireActionRateLimit` is applied only to claim / device-disconnect / download-token). With
1 M licenses that is ~4 M rows read per request, billed and slow, on the shared D1. This scales
with total platform size, not with the requesting account.

Related N+1s on the same surface: `handleLicenses` (`api.ts:333-339`) calls
`getPortalProductSettings` + `shapeLicenseSummary` (which itself calls `listVisibleKeys`,
`listVisibleDevices`, `resolveEffective`, `getActiveSchema`) per license; `handleReleases`
(`api.ts:482-508`) calls `getPortalProductSettings` per product and `listPortalArtifacts` per
release.

**PoC status: NOT WRITTEN** (verified by reading the queries and grepping every
`CREATE INDEX` in `packages/worker/migrations/`).

**Fix direction.** Add `CREATE INDEX idx_licenses_email ON licenses(lower(email))` and
`CREATE INDEX idx_licenses_sub_only ON licenses(sub) WHERE sub IS NOT NULL`. Call
`syncAccountLicenseLinks` once per request (or once per session per N minutes, stamped on the
account row), not two-to-four times. Batch the `linkLicense` upserts.

---

## R10-14 — Admin API 403s write a D1 audit row

**Severity: Low.**

**Location.** `packages/worker/src/admin/api.ts:68-82`.

Every authenticated-but-unauthorized product access writes an audit row. The comment at
`:69-72` shows the authors already reasoned about this ("we intentionally do NOT audit the
unauthenticated credential-path 401s — that would be a D1-write DoS amplifier") and concluded
the authenticated case is "low-volume + high-signal". That reasoning holds _if_ the admin API
is rate-limited. **It is not** — `handleAdminApi` (`api.ts:147-199`) has no `rateLimitOk`;
only `/manage/login` and `/manage/callback` do.

So any operator holding a valid session for _any_ product (the lowest-privilege admin on the
platform) can loop `GET /manage/api/products/<other-slug>/licenses` and drive one D1 write per
request, unmetered, plus flood the audit log of a product they do not administer with
attributable-but-useless noise (an audit-log-poisoning angle for whoever owns that lane).

**PoC status: NOT WRITTEN** (single call site; the missing limiter is a grep).

**Fix direction.** Rate-limit the admin API per session; or dedupe `access.denied` audits
(one row per actor+target per hour).

---

## R10-15 — Unbounded `.sig` asset read inlined into the appcast XML

**Severity: Low** (requires a hostile or compromised release pipeline).

**Location.** `packages/worker/src/release/github.ts:200-222` — `fetchTextAsset` ends with
`return res.text()` with no `content-length` check and no cap. Consumed at
`release/index.ts:568-572` and interpolated into an XML attribute at
`release/appcast.ts:70-71,78`.

**Impact.** A GitHub release asset may be up to 2 GB. A `<dmg>.sig` sidecar of, say, 200 MB is
read fully into a JS string (~400 MB as UTF-16) and then `xmlEscape`d into another string
inside a 128 MB isolate ⇒ OOM, killing co-tenant requests in that isolate. Triggering it is an
unauthenticated `GET /<p>/appcast.xml`; _creating_ it requires write access to the product's
release repo, so the attacker is a repo maintainer or someone who compromised CI.

Same shape, milder: `fetchRepoFile` (`github.ts:168-197`) does `atob` plus a byte-by-byte loop
over the base64 payload. GitHub's Contents API refuses blobs over 1 MB, so that one is
implicitly capped.

**PoC status: NOT WRITTEN** (allocating 200 MB in vitest is not a useful test; the missing cap
is evident at `github.ts:221`).

**Fix direction.** Check `res.headers.get("content-length")` against a small cap (a Sparkle
EdDSA signature is ~100 bytes; 4 KiB is generous) and read via a capped stream so an absent
`content-length` cannot bypass it.

---

## R10-16 — No JWS _header_ size cap in any implementation

**Severity: Low** (client-side; not a Worker availability issue).

**Location.** `packages/shared-jws/src/index.ts:143-152` — `MAX_DOC_BYTES = 65536` is checked
against `payloadBytes.byteLength` only. The **header** segment is base64url-decoded and
`JSON.parse`d at `:149` with no size check whatsoever. Same gap in
`sdks/python/src/polaris_key/verify.py` (`MAX_PAYLOAD_BYTES = 65536`, payload only).

Additionally the SDKs read the whole response body into a string before `verifyJws` sees it,
so the 64 KiB payload cap is enforced _after_ an arbitrarily large body has already been
buffered.

**Impact.** A hostile or compromised Polaris Key deployment (or anything that can serve the
`/config` response — i.e. an attacker who already holds a stronger position) can hang or OOM a
client SDK with a multi-hundred-megabyte JWS header. Real but narrow.

**PoC status: NOT WRITTEN.**

**Fix direction.** Cap the header segment (1 KiB is ample) and cap the _encoded_ compact-JWS
string length before splitting; enforce a `content-length` / stream cap in each SDK's fetch.

---

## R10-17 — GitHub-controlled sleep inside the request path

**Severity: Informational.**

**Location.** `packages/worker/src/release/githubApp.ts:169-183,225-228`. On a GitHub
rate-limit signal the handler does `await sleep(backoffMillis(res))` **inside the request**,
honouring GitHub's `Retry-After` / `X-RateLimit-Reset`.

It **is** correctly capped: `Math.min(secs, 5) * 1000 + jitter()` and
`Math.min(resetMs, 5000) + jitter()`, so the worst case is 5.25 s. That is bounded and safe
from unbounded stalling, but it is still up to 5.25 s of held request slot per affected
release request, which compounds R10-05 (an attacker who exhausts the GitHub quota also makes
every subsequent release request ~5 s slower). Noted, not a finding to fix on its own.

---

# REFUTED / not confirmed

### "The DO stores one key per `(bucket,id)` FOREVER" (seeded hypothesis 2, second half)

**CONFIRMED**, see R10-04b. Listed here only to record _why_ the source comment is wrong:
window rollover overwrites the value, it does not delete the key.

### "The ENTIRE `/manage/api/*` surface is unrate-limited" (hypothesis 3)

**CONFIRMED as a fact but DOWNGRADED.** Every route behind it requires a verified signed
session cookie (`admin/api.ts:154-155`) and CSRF on mutations (`:163-166`). It is an
authenticated-insider cost amplifier (R10-14), not an anonymous DoS surface. `/manage/login`
and `/manage/callback` — the only anonymous doors — _are_ limited (20/min/IP).

### "`/magic/verify` and `/download/<token>` are high-cost" (hypothesis 3)

**REFUTED as high-cost.** `/magic/verify` (`portal/auth.ts:370-397`) costs one D1 aggregate
(`portalAuthCapabilities`) plus one KV read before short-circuiting on an invalid token; the
expensive tail (account creation, `syncAccountLicenseLinks`, audit write) requires a valid
600 s-TTL token the attacker cannot forge. `/download/<token>` (`portal/api.ts:640-649`) costs
one `hashKey` plus one indexed D1 lookup, then 404s. Both are ordinary unauthenticated read
endpoints. Real, but low.

### "Ajv in the request path: availability bug on publish, or DoS amplifier?" (hypothesis 4)

**BOTH, and much worse than framed** — see R10-01. It is not merely a publish-path bug: the
same codegen sits on `GET /config`, the licensing hot path, where it produces a guaranteed 500.

### "`compileChannelRegex` caps source at 80 chars — is that sufficient?" (hypothesis 5)

**Definitively insufficient**, see R10-09 (8-character pattern, 57 s of CPU). The
`SchemaForm.tsx` half is **downgraded to Low**: it executes in the operator's own browser on a
catalog the operator is editing. The claimed server-side Ajv `pattern`/`format` ReDoS is
**currently unreachable**, because Ajv cannot compile at all under workerd (R10-01) — but it
becomes reachable the moment R10-01 is fixed, so the fix must not reintroduce it.

### "SDK fetches read the whole body before the 64 KiB JWS cap applies" (hypothesis 6)

**CONFIRMED but Low**, see R10-16. The `.sig` half is R10-15. `fetchRepoFile` is implicitly
capped by GitHub's 1 MB Contents API limit.

### "Token records accumulate FOREVER, unbounded" (hypothesis 8)

**PARTIALLY REFUTED.** The missing `expirationTtl` is real (R10-12), but the steady-state count
is _not_ unbounded-per-request: `authorizeDevice` deletes the prior hash
(`licenseCore.ts:356-358`), `rotateDeviceToken` deletes the old one (`:487`), and every
deauthorize path calls `deleteTokenRecord`. The population is therefore bounded by the device
count — **except** for the resurrection bug at `licenseCore.ts:463`, which is the part that
actually matters and is written up as R10-12.

### "`yaml` parsing of untrusted `.pkey/` manifests: size cap, alias bombs, deep nesting" (hypothesis 9)

**REFUTED.** Verified empirically against the installed `yaml@2.9.0`:

- **Alias/anchor bomb:** rejected. `maxAliasCount` defaults to `100`
  (`yaml/dist/nodes/Node.js:28`, `doc/Document.js:300`); a 7-level billion-laughs payload throws
  `"Excessive alias count indicates a resource exhaustion attack"`.
- **Deep nesting:** 20,000 nested `[` throws a **catchable** `YAMLParseError`
  ("Maximum call stack size exceeded"), and both call sites wrap `parseYaml` in `try/catch`
  (`shared-manifest/src/index.ts:960-974`, `admin/handlers/products.ts:76-82`).
- **Size:** no explicit byte cap, but inputs are bounded upstream — the GitHub Contents API
  refuses blobs over 1 MB (`github.ts:168-197`), and the admin body cap is 64 KiB
  (`admin/lib/respond.ts:71-84`). Worth adding an explicit cap for defence in depth, but not a
  finding.

### "Webhook fan-out exceeds the Workers subrequest limit"

**NOT CONFIRMED as attacker-controlled.** `handleGithubWebhook` loops
`listProductsByGithubRepo` and calls `resyncRepo` per product, each costing ~10 GitHub
subrequests (1 token + up to 9 `readPkeyFile` probes) — so ~5 products sharing one repo
exceeds the 50-subrequest Free-plan limit, ~90 exceeds the 1,000 Paid limit. But the product
count is set by operators, not attackers, and the endpoint is HMAC-gated. Operational footgun,
not a vulnerability. Worth bounding anyway (short-circuit `readPkeyFile` on the first
extension that exists rather than probing all three).

### "`hashKey` is a CPU-exhaustion vector"

**REFUTED.** `crypto.ts:75-90` is a single SHA-256 (or one HMAC-SHA-256 with the pepper) — no
KDF, no iteration count. Constant, negligible cost.

### "`clientIp` can be spoofed to bypass the rate limiter"

**REFUTED.** `rateLimit.ts:44-46` reads `cf-connecting-ip` only and explicitly refuses to fall
back to `x-forwarded-for`; the comment documents the reasoning and `test/rateLimit.test.ts`
covers it. (IPv6 address rotation is a separate, real issue — see R10-04b — but that is
address abundance, not header spoofing.)

---

## Remediation

### R10-01 — Ajv runtime codegen on the licensing hot path

**Status: FIXED.** Verified on real workerd, not in Node. See §"workerd re-verification".

**Approach chosen: replace schema _compilation_ with schema _interpretation_, in-tree.**

The three options were weighed as follows.

1. _Ajv standalone / precompiled mode_ — **rejected.** It emits validator source at build time,
   but catalogs are product data supplied at runtime (admin publish, `.pkey/schema` in a linked
   repo). There is nothing to precompile. Ajv exposes no interpreting mode.
2. _A dependency-free interpreter for the subset the catalog uses_ — **chosen.**
3. _Swap to a non-codegen validator such as `@cfworker/json-schema`_ — **rejected.** It would fix
   the outage, but it delegates `pattern` to the host `RegExp`, so it would have shipped the
   ReDoS the verification warned about (§7) and still needed a wrapper. It also adds a runtime
   dependency to the very package R7 wants dependency-light. The chosen route _removes_ two
   (`ajv`, `ajv-formats`), leaving `@polaris-key/catalog` with zero runtime dependencies.

**The subset was determined empirically, not guessed.** Every schema fragment in the repo was
swept: `products/djdl/catalog.json` (28 entries) uses exactly `type` (30), `maxLength` (8),
`minimum` (7), `maximum` (7), `minLength` (7), `enum` (4), `items` (2), `uniqueItems` (2),
`pattern` (2), `minItems` (1), `format: "uri"` (1). `packages/admin/src/SchemaForm.tsx:15-24`
documents the intended contract as "type / enum / minimum / maximum / minLength / maxLength /
pattern", and `shared-manifest`'s `validateCatalogShape` only constrains `schema.type`. The
implementation covers that subset plus the rest of Draft-07's structural core (`const`,
`exclusiveMinimum/Maximum`, `multipleOf`, tuple `items`/`additionalItems`, `contains`,
`properties`/`required`/`additionalProperties`/`patternProperties`/`propertyNames`,
`min/maxProperties`, `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`), so operator catalogs
are unlikely to meet the fail-closed edge.

**Files**

| File                                                   | Change                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `packages/shared-catalog/src/validate.ts`              | **new** — the interpreter (`prepareSchema` / `validatePrepared`)         |
| `packages/shared-catalog/src/regex.ts`                 | **new** — the linear-time `pattern` matcher                              |
| `packages/shared-catalog/src/catalog.ts`               | Ajv removed; `validatorFor`/`ajv.compile` → `analyse`/`validatePrepared` |
| `packages/shared-catalog/src/index.ts`                 | exports the new surface                                                  |
| `packages/shared-catalog/package.json`                 | `ajv` + `ajv-formats` dropped (zero runtime deps)                        |
| `packages/worker/src/configDoc.ts`                     | contract note: the prune is codegen-free and fails closed                |
| `packages/shared-catalog/src/{regex,validate}.test.ts` | **new** — 90 tests incl. a RegExp differential corpus                    |
| `packages/worker/test/attack/R10-dos.test.ts`          | the 5 R10-01 PoCs inverted + 5 ReDoS knock-on tests                      |

**Behaviour changes worth knowing.**

- `compileAll()` survives with a narrower meaning: it _analyses_ every fragment and throws on
  the first one that cannot be interpreted, so `PUT …/schema` and `POST …/products` still 422 a
  bad catalog. It no longer generates code, and it is now cheap.
- **Unknown keywords fail closed.** Ajv ran with `strict: false`, which silently _ignores_ an
  unrecognised keyword — an operator writing `dependencies` or `$ref` would have believed a
  constraint was in force when it was not. `prepareSchema` now throws instead, and a stored
  catalog carrying one marks its values invalid so they are pruned before signing rather than
  signed unchecked. Same policy for an unknown `format` and an unknown `type`.
- `format: "uri"` no longer uses ajv-formats' RFC-3986 mega-regex (itself a backtracking
  hazard). The replacement rejects control characters and spaces, requires a scheme, then defers
  to the WHATWG `URL` parser. Its agreement with `ajv-formats@3.0.1` is pinned as a table in
  `validate.test.ts`.
- All 20 pre-existing `catalog.test.ts` assertions pass **unmodified**, which is the main
  evidence that validation semantics did not drift.

### Required companion: the `pattern` ReDoS cap (R10-09 knock-on)

The verification (§7) is explicit that server-side `pattern` ReDoS is unreachable _because of_
R10-01 and becomes live the moment R10-01 is fixed, so the cap had to ship in the same change.

R10-09 already proved a source-length cap is not a guard: `(x+x+)+y` is **8 characters** — far
under `channels.ts`'s `MAX_REGEX_SOURCE = 80` — and measured **57 s** against a 34-character
input. Static "reject nested quantifiers" analysis is also leaky: `(a|a)*` has star height 1 and
is still exponential, and `a*a*a*a*b` is polynomial. So `pattern` is not handed to the host
`RegExp` at all. `regex.ts` is a Thompson/Pike NFA simulation — the whole state set advances one
code point at a time, so matching is O(instructions × input) with **no backtracking, for every
pattern including adversarial ones**.

Layered, in order:

1. **Linear-time matcher** — the primary control. `(x+x+)+y` against 4 000 characters: **4 ms**.
2. **Constructs that cannot be matched linearly are refused** at prepare time, not silently
   ignored: backreferences, lookahead, lookbehind, `\b`/`\B`, `\p{…}`.
3. **Input-length cap** — `MAX_PATTERN_INPUT = 4096` code points; a longer value fails the
   `pattern` assertion (fail closed) instead of being matched.
4. **Compile budgets** — `MAX_PATTERN_SOURCE = 300`, `{n,m}` bound ≤ 100,
   `MAX_PATTERN_PROGRAM = 2000` instructions, so `(?:(?:a{100}){100}){100}` is rejected rather
   than expanded.
5. **Validation work budget** — `MAX_VALIDATION_STEPS`, plus a `MAX_UNIQUE_ITEMS = 1000` cap so
   `uniqueItems` cannot be driven quadratic.

Semantics are pinned by a differential test: 36 patterns × 41 inputs compared against
`new RegExp(source, "u")` (the exact dialect Ajv used — `unicodeRegExp` defaults to `true`),
**1 476 comparisons, 0 mismatches**.

### workerd re-verification

A Node test cannot prove this fixed — `packages/worker/vitest.config.ts` sets
`environment: "node"`, which is precisely the blind spot that let the bug through CI. The
reproduction from `VERIFY-R10-01.md` was therefore rebuilt and re-run on **real workerd**
(`wrangler 4.104.0 --local`), same scratch-worker method, `compatibility_date = "2026-04-07"`
and `compatibility_flags = ["nodejs_compat"]` copied from `packages/worker/wrangler.toml`, the
real `products/djdl/catalog.json`, the real built `Catalog`, and verbatim copies of
`licenseCore#catalogDefaultPayload`, `configDoc#validatePayload` and the `licensing.ts:509-522`
try/catch.

**Before (reproduces VERIFY-R10-01 §3 exactly):**

```
$ curl -s http://127.0.0.1:8811/
{
  "request_dynamic_function":           "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_eval":                       "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_new_RegExp":                 "OK: true",
  "step1_catalogDefaultPayload":        "OK: seeded 16 config keys",
  "step2_handleConfig_validatePayload": "THREW: EvalError: Code generation from strings disallowed for this context",
  "simulated_http_status":              "500 catalog_unavailable",
  "step3_adminPublish_compileAll":      "THREW: EvalError: Code generation from strings disallowed for this context",
  "simulated_publish_status":           "422 invalid catalog",
  "step4_overrides_uncaught":           "THREW (uncaught in real code => 500): EvalError: Code generation from strings disallowed for this context",
  "boundary": {
    "A_djdl_catalog_with_16_defaults": "500 catalog_unavailable <- EvalError: Code generation from strings disallowed for this context",
    "B_djdl_catalog_empty_payload":    "200 OK (0 config keys signed)",
    "C_empty_catalog_empty_payload":   "200 OK (0 config keys signed)",
    "D_single_config_key":             "500 catalog_unavailable <- EvalError: Code generation from strings disallowed for this context",
    "E_repeat_same_request":           "500 catalog_unavailable <- EvalError: Code generation from strings disallowed for this context"
  }
}
```

**After (same harness, same workerd, fixed `@polaris-key/catalog`):**

```
$ curl -s http://127.0.0.1:8813/
{
  "request_dynamic_function":           "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_eval":                       "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_new_RegExp":                 "OK: true",
  "step1_catalogDefaultPayload":        "OK: seeded 16 config keys",
  "step2_handleConfig_validatePayload": "OK: 16 config keys survived prune",
  "simulated_http_status":              "200 OK",
  "step3_adminPublish_compileAll":      "OK: catalog accepted",
  "simulated_publish_status":           "200 published",
  "step4_overrides_uncaught":           "OK: valid-accepted=true invalid-rejected=true",
  "boundary": {
    "A_djdl_catalog_with_16_defaults": "200 OK (16 config keys signed)",
    "B_djdl_catalog_empty_payload":    "200 OK (0 config keys signed)",
    "C_empty_catalog_empty_payload":   "200 OK (0 config keys signed)",
    "D_single_config_key":             "200 OK (1 config keys signed)",
    "E_repeat_same_request":           "200 OK (16 config keys signed)"
  },
  "redos_publish":               "OK: accepted (legal JSON Schema) — defused, not rejected",
  "redos_34_char_input":         "OK: false in 0ms",
  "redos_40_char_input":         "OK: false in 1ms",
  "redos_4000_char_input":       "OK: false in 4ms",
  "redos_backreference_refused": "OK: {\"ok\":false,\"errors\":[\"evil pattern: backreferences are not supported (they require backtracking) (at offset 5) at /pattern\"]}",
  "long_input_result":           "OK: {\"ok\":false,\"errors\":[\"app.minVersion must match pattern \\\"^\\\\d+…\\\"\"]}",
  "long_input_ms":               0
}
```

Reading the evidence:

- `request_dynamic_function` and `request_eval` **still throw**, so the isolate genuinely
  forbids request-phase codegen. The harness is not accidentally running somewhere permissive —
  it is the same restriction that produced the original 500, and the catalog path simply no
  longer trips it.
- `step2_handleConfig_validatePayload` moved from `THREW: EvalError…` to
  `OK: 16 config keys survived prune`, and `simulated_http_status` from
  `500 catalog_unavailable` to `200 OK`. That is the outage closed.
- Boundary case **A** (the whole djdl catalog) and **D** (a single config key — the original
  trigger threshold) both return 200. **B** and **C** were the only safe cases before; now all
  five are.
- `step4` shows the override PATCH path both accepting a valid value and _rejecting_ an
  out-of-range one — the prune still enforces, it did not fail open to buy the 200.
- `request_new_RegExp: OK` is why the ReDoS mitigation was mandatory: `RegExp` construction from
  a string is **not** "code generation from strings", so workerd permits it. The bug was masking
  a live ReDoS surface, exactly as the verification predicted.

Scratch worker: `/tmp/wd-r1001-fix` (before on port 8811, after on 8813). No repository source
outside the table above was modified; no request was made to `key.plrs.im`.

### Test status

| Finding                                                   | Fixed?                 | Test                                                                                                         |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| R10-01 `/config` 500s on workerd                          | yes                    | `R10-01 catalog validation no longer generates code at request time` (6 tests, inverted) + workerd run above |
| R10-01 admin publish 422s                                 | yes                    | `with codegen disabled, publishing a catalog via the admin API succeeds`                                     |
| R10-01 override PATCH 500s                                | yes                    | `step4_overrides_uncaught` (workerd)                                                                         |
| R10-09 knock-on: catalog `pattern` ReDoS                  | yes (pre-emptively)    | `R10-01 knock-on: catalog pattern cannot be turned into a CPU bomb` (5 tests) + `regex.test.ts` ReDoS block  |
| R10-07 manual-channel regex ReDoS (`release/channels.ts`) | **no — not this lane** | still reproduces; see below                                                                                  |

`pnpm --filter @polaris-key/catalog test` → **110 passed** (was 20).
`pnpm --filter @polaris-key/worker test` → **656 passed / 38 files**.
Typecheck and prettier clean on every file touched.

### Reported, not fixed (owned by other lanes)

1. **`browserSession.ts:184-195` fails open.** Confirmed. The `catch` around `validatePayload`
   proceeds _without_ catalog validation, so the defence-in-depth prune silently never runs on
   the browser-session lane. Fixing R10-01 closes the `EvalError` route into that catch — it is
   now reachable only when `catalog_json` is unparseable — but **the fail-open catch itself is
   untouched** and should be tightened on its own merits: `/config` fails closed (500
   `catalog_unavailable`) on the same condition, so the comment claiming the two are "aligned"
   is inaccurate. Left alone to avoid a behaviour change on a handler this lane does not own.
2. **`release/linkRepo.ts:210-215` and `release/resync.ts:184-194` insert `catalog_json` with no
   structural validation at all**, while `PUT …/schema` and `POST …/products` validate via
   `compileAll()`. The repo-sync path therefore accepts catalogs the admin API would reject —
   and, now that `compileAll()` also screens `pattern` complexity and unsupported keywords, it is
   the one remaining way to install a catalog that has never been screened. The fix is one line
   at each site (`new Catalog(parsed).compileAll()` inside the existing validation, 422/error on
   throw). **For the release lane.**
3. **`packages/admin/src/SchemaForm.tsx:66-70`** still does `new RegExp(schema.pattern).test(s)`
   with no cap. Browser-side and already downgraded to Low in R10-07, but it is now the only
   uncapped `pattern` compile left in the repo; `compileLinearPattern` is exported from
   `@polaris-key/catalog` if the admin lane wants it.

### Recommendation: a workerd test lane (not added unilaterally)

This bug was a guaranteed 100% outage of the product's core endpoint, it sat in `main` across 37
commits, and CI was green the whole time — because `packages/worker/vitest.config.ts` uses
`environment: "node"`, where `Function(string)` works. No Node test can catch this class of
defect. The `withoutCodegen` proxy in `R10-dos.test.ts` is a useful approximation and has been
kept, but it only catches codegen that goes through `globalThis.Function`; it would miss, say, a
dependency reaching for `eval` or a WASM/`unsafe-eval` path.

Recommended, for a maintainer to decide on rather than for this change to impose:

- Add `@cloudflare/vitest-pool-workers` (not currently a dependency) and run at minimum
  `test/attack/R10-dos.test.ts` and the `/config` happy path under it. That is the highest-value
  option: it runs the real workerd with the real compat date.
- Cheaper alternative: a `wrangler dev --local` smoke job that activates a device and asserts
  `GET /<product>/config` returns 200 with a three-part JWS.
- Either way it should gate `deploy.yml`, which currently triggers only on `push: tags: ["v*"]`
  and has never run.

---

# Remediation — release lane (R5-03, R12-03, R10-05, R10-15)

A second remediation pass, scoped to the release engine's GitHub credential handling and the
public delivery surface. Files touched: `release/githubApp.ts`, `release/github.ts`,
`release/index.ts`, `kv.ts`, `rateLimit.ts` (one bucket registration).

## R5-03 — installation tokens minted un-scoped, cache scope inconsistent

**Order mattered.** The mint fix alone would have been defeated by the cache: `installId` is
identical for every product on an org-wide installation, and the only other component of the
key was a caller-supplied string. So the key derivation was fixed first.

**Cache key (`kv.ts` `ghInstallationTokenKey`, `githubApp.ts` `installationTokenSlot`).** The
key is now `gh:install:<id>:token:<owner>/<repo>`, derived **inside** `getInstallationToken`
from `(installId, requested down-scope)`. The caller's second argument no longer reaches the
key at all, so it is correct regardless of what callers pass. `pk()` is not used: an
installation token has no product dimension, and the `gh:` prefix keeps it out of the `p:`
namespace where a real slug could collide with it.

**The mint.** `POST /app/installations/{id}/access_tokens` now carries
`{"repositories": ["<repo>"], "permissions": {…}}`. GitHub enforces both server-side.
Permissions verified against actual usage:

| Endpoint used                                                             | Permission            |
| ------------------------------------------------------------------------- | --------------------- |
| `/releases`, `/releases/latest`, `/releases/tags/*`, `/releases/assets/*` | `contents: read`      |
| `/contents/*` (the `.pkey/` manifests)                                    | `contents: read`      |
| — (mandatory for every App)                                               | `metadata: read`      |
| `/actions/workflows/{wf}/runs` (`channelTagsFor`)                         | `actions: read`       |
| `/pulls/{n}` (`pr-<n>` selectors)                                         | `pull_requests: read` |

Nothing on this path writes, so nothing asks for write. The last two are requested **only**
when the product has a `channel_workflow`, because GitHub 422s a request for a permission the
App was never granted.

**Fallback ladder** (availability; a 422 here takes the whole release surface down):

1. requested repo + requested permissions;
2. same repo, base permissions — for an App never granted actions/pull_requests;
3. installation-wide but still read-only — **only** for the legacy bare-string caller form.

A caller that passes structured coordinates (`{owner, repo}`) never falls back to step 3: a
422 there is a hard failure, so a correctly-wired caller can never be silently widened.

## R12-03 — installation token cached in KV as plaintext

The cached record is `seal()`ed under the platform KEK before `HOT.put`, with the AAD bound to
`(installId, down-scope)` — a blob sealed for one repo scope cannot be opened as another's.
On read, a blob that will not open (rotated KEK, tampered ciphertext, a pre-fix plaintext
record) is treated as a cache **miss** and re-minted, never as a usable token. If sealing is
impossible (no usable KEK) the token is served but **not cached** — an extra round trip is the
right price; persisting a plaintext credential is not.

`keyvault.ts` was **not** modified: `SealContext.kind` already admits `"product-secret"`, so
the existing `seal`/`open` were sufficient. `kv.ts`'s header comment was updated, as the
finding asked.

## R10-05 — unauthenticated GitHub-subrequest amplifier

Three layers, all in `release/index.ts` unless noted.

**1. Cloudflare Cache API** in front of the metadata reads (`appcast`, `channelAppcast`,
`version`, `changelog`), and only when the product's effective access mode for that surface is
`public`, so a cache hit can never bypass `enforceReleaseAccess`. The key is **synthesised**
(`/__pkey-release-cache?p=&k=&v=&c=`), not `req.url`: keying on the real URL would let
`?cachebust=N` mint unbounded entries that all miss, turning the cache into the amplifier it is
meant to stop. `caches.default` is absent outside workerd, so the lookup degrades to "no cache"
rather than throwing.

`cli`/`dmg` are deliberately **not** cached — they stream artifact bodies up to 2 GB with Range
and If-None-Match passed through end-to-end.

**2. Per-IP rate limit** on cache **misses** only (a hit issues no GitHub subrequest and no
limiter round-trip, so serving it is the most available thing we can do). Two buckets, both
registered `"open"` in `rateLimit.ts`'s `FAIL_MODE` — matching the control-plane lane's
convention that read surfaces fail open, since a limiter outage must not become a
software-distribution outage:

- `release` — 30/min/IP for metadata, matching `/activate`.
- `releaseArtifact` — 120/min/IP for `cli`/`dmg`. Deliberately loose: the legitimate shape is
  bursty (a NAT'd office on release day, parallel Range requests for a resume), and GitHub's
  storage host — not our API quota — absorbs the bytes.

**3. 503, not 404, on upstream quota exhaustion** (`github.ts`). A new
`UpstreamRateLimitedError` is thrown for GitHub's two quota signals (429; or 403 with
`x-ratelimit-remaining: 0` or a `retry-after`) and mapped to `503 upstream_rate_limited` with
`Retry-After`. A _bare_ 403 — private repo, no access — still maps to `NotFoundError`/404, so
"private" and "absent" stay indistinguishable. This is what makes exhaustion diagnosable
instead of looking like a withdrawn release.

## R10-15 — unbounded `.sig` read

`fetchTextAsset` now takes `maxBytes` (default `MAX_TEXT_ASSET_BYTES = 4096`; a Sparkle EdDSA
signature is ~100 bytes and a `shasum` line ~90). The declared `Content-Length` is rejected
first, then the body is read through a **capped stream** that cancels the moment the running
total passes the cap — an absent or lying `Content-Length` cannot bypass it. Over-large
sidecars are refused rather than truncated: a truncated signature or digest would be a silently
wrong value, and callers already fail closed on the throw.

## Test status

| Finding                                      | Fixed? | Test                                                                                                                      |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| R5-03 mint is un-scoped                      | yes    | `R5-isolation.test.ts` → `R5-03 GitHub installation tokens are down-scoped to one repo` (7 tests)                         |
| R5-03 cache key derived from caller argument | yes    | same block + `R9-injection.test.ts` → `the installation-token cache key no longer comes from the caller's scope argument` |
| R12-03 token cached in plaintext             | yes    | `R12-secrets.test.ts` → `R12-03 GitHub installation token is sealed in KV` (3 tests, original inverted)                   |
| R10-05 no cache in front of GitHub           | yes    | `R10-dos.test.ts` → `R10-05 public release surface no longer amplifies into GitHub` (10 tests)                            |
| R10-05 no rate limit                         | yes    | same block (per-IP 429, artifact lane, fail-open, cache-hit-not-metered)                                                  |
| R10-05 403 → 404 hides exhaustion            | yes    | same block (`503 upstream_rate_limited`; bare 403 still 404s)                                                             |
| R10-15 uncapped `.sig` read                  | yes    | `R10-dos.test.ts` → `R10-15 sidecar text assets are size-capped` (4 tests)                                                |

`pnpm --filter @polaris-key/worker test` → **736 passed / 39 files**. Typecheck and prettier
clean on every file touched.

## Reported, not fixed (owned by other lanes)

1. **The caller inconsistency itself is still there.** `getInstallationToken`'s scope argument
   is the **GitHub repo name** at `release/linkRepo.ts:125` and `release/resync.ts:104`, and
   the **product slug** at `release/health.ts:166`. Those three files are outside this lane, so
   the key derivation was made caller-argument-independent instead — but the argument should be
   a typed `{owner, repo}` at all four call sites. Two consequences remain, both benign:
   - `health.ts` passes a slug. When slug ≠ repo name the scoped mint 422s and falls back to a
     permission-minimised **installation-wide** token (step 3 above). This is the one caller
     this lane could not fully down-scope. Fixing it is one line in `health.ts`:
     `getInstallationToken(env, { owner: cfg.gh_owner, repo: cfg.gh_repo }, …)`.
   - `linkRepo`/`resync` pass a bare repo name, so their descriptor is `?/<repo>` where
     `index.ts`'s is `<owner>/<repo>`. Both are correctly scoped; they simply occupy two cache
     entries and mint twice per 55 minutes for the same repo. Cosmetic, not a correctness or
     isolation issue.
2. **`rateLimit.ts` was edited from this lane** (two `FAIL_MODE` registrations — `release` and
   `releaseArtifact`). Unknown buckets fail **closed**, so registering them was mandatory: an
   unregistered `release` bucket would have turned a DO blip into the exact 100% delivery
   outage this finding describes. No other line of that file changed.
3. **`R10-17` (GitHub-controlled sleep) is untouched and now slightly more reachable.** The
   token-mint fallback ladder can issue up to three POSTs, each with its own capped
   rate-limit retry, so the worst-case in-request stall on the mint path rises from ~5.25 s to
   ~15.75 s. Still bounded, still only on the error path, and only on a cache miss — but it is
   the one place this lane made R10-17 worse rather than better.
4. **The 5,000/hr quota is per _installation_, and the fix is per _IP_.** A distributed source
   can still exhaust it. The Cache API is what actually bounds steady-state consumption; the
   rate limit bounds a single client. A genuinely resilient answer needs an
   installation-level circuit breaker (stop calling GitHub, serve stale) — out of scope here,
   and worth a finding of its own if the operator cares about that threat model.

---

## Remediation (SPA + workerd lane)

Closes the two residuals the previous remediation left open: the last uncapped `pattern`
compile (its item 3) and the missing workerd test lane (its closing recommendation). Scope was
`packages/admin/**`, the worker's test configuration, and `ci.yml`. No file under
`packages/worker/src/**` was modified.

### Residual 4 — `SchemaForm.tsx` was the last uncapped `new RegExp` in the repo

`packages/admin/src/SchemaForm.tsx:66-70` did `new RegExp(schema.pattern).test(s)` with no
length cap and no timeout, on every keystroke and every render. `schema.pattern` is
operator-supplied and does not have to pass through review to get there: `release/resync.ts`
applies a catalog straight out of `.pkey/` in a linked repo on a webhook trigger
(VERIFY-R10-01 §5a). The measured cost of the eight-character `(x+x+)+y` against a
41-character input is ~54 s of single-threaded work; the SPA has no worker thread and no
abort, so that is a frozen operator tab.

Fixed by **reusing** `compileLinearPattern` from `@polaris-key/catalog` — the Thompson/Pike
NFA the worker already validates with — rather than adding a second, differently-shaped cap in
the console. `@polaris-key/catalog` is now a dependency of `@polaris-key/admin`
(`workspace:*`); it is dependency-free and browser-safe, and adds ~7 kB to the `manage` bundle
(177.5 kB, 44.8 kB gzipped). Three properties follow from reuse rather than from new code:

- **Same verdict.** The console and the server run the same matcher over the same source, so a
  value the form accepts is a value `validatePayload` will not prune.
- **Same failure mode.** A pattern the engine refuses (backreference, lookaround, oversized
  source) now shows `unsupported pattern — the server rejects any value` instead of silently
  passing. That mirrors `Catalog#validateEntryValue`, which marks an uninterpretable fragment
  rejected and fails every value under it. It never falls back to `RegExp`.
- **Same input ceiling.** `test()` returns `false` past `MAX_PATTERN_INPUT` (4096), which is
  fail-closed on both sides.

Compilation is memoised by pattern source (bounded at 256 entries) because `validate` runs per
keystroke.

### Residual 5 — a real-workerd lane, wired into CI as its own job

`packages/worker/vitest.config.ts` sets `environment: "node"`, which permits the runtime
codegen workerd forbids. That is not a coverage gap, it is a category error: no number of Node
tests can observe R10-01, and 396 of them did not.

Added `packages/worker/vitest.workers.config.ts` — `@cloudflare/vitest-pool-workers` driving
genuine workerd, reading the worker's own `wrangler.toml` so bindings, compat flags and the
module graph are the ones that ship. Tests live in `packages/worker/test-workerd/`, which the
Node lane's `include` does not match, so neither config needs an `exclude`. **9 tests, ~1 s**,
covering only what differs between the two runtimes:

| What it proves                                                                                                      | Why Node cannot                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Request-phase `Function(src)` / `eval` throw `EvalError`                                                            | Node permits both                                                                  |
| The exact Ajv-shaped `Function("data", src)` throws                                                                 | the literal construction that caused R10-01                                        |
| Real djdl catalog: `validateKeyValue`, `compileAll`, `validatePayload` over all 16 defaulted keys                   | these are what threw in-request                                                    |
| `(x+x+)+y` answered in bounded time (R10-09)                                                                        | no fallback to the host `RegExp` in the isolate                                    |
| WebCrypto Ed25519 sign + verify (`@polaris-key/jws`)                                                                | Node has had Ed25519 for years                                                     |
| `POST /activate` then `GET /djdl/config` over `SELF.fetch` → 200 `application/jwt`, verifiable JWS, defaults intact | real D1 (migrated), real KV, real Durable Object rate limiter, real `src/index.ts` |

The first three are the canary: if workerd ever stopped refusing codegen, the catalog
assertions would stop being evidence, and those tests fail first and say so.

CI gets a separate `workerd` job (`.github/workflows/ci.yml`), not a step inside `js`, so
"this does not work in the runtime it ships to" is legible instead of buried in a 700-test
log. It runs `pnpm build` (the worker imports workspace `dist`, and the assets binding needs
`packages/admin/dist`), then `typecheck:workerd`, then `test:workerd`.

**Known gap, stated rather than hidden.** `@cloudflare/vitest-pool-workers` supports
vitest 3.2.x only up to `0.12.21`, which pins workerd `1.20260310.1`. `wrangler.toml` asks for
`compatibility_date = 2026-04-07`, so miniflare warns and falls back to `2026-03-10` on every
run. Two things bound it: VERIFY-R10-01 §E3 showed request-phase codegen throws at **every**
compat date from 2024-01-01 to 2026-04-07, so the canary does not depend on the date; and the
lane asserts WebCrypto Ed25519 — the one feature `wrangler.toml` names as its reason for
2026-04-07 — directly, so a regression fails loudly rather than passing silently. Closing it
requires moving the workspace to vitest 4.

### Stale SPA affordances (the phantom per-product admin model, and neighbours)

`admin/authz.ts` has one privilege level, and `admin/auth.ts` gates session issuance on
`hasAnyAdminGrant`, which is the _same predicate_ as `isPlatformAdmin` — so `platformAdmin` is
`true` for every session that can render the console, and `handleMe` returns every product or
none. The control-plane lane's cleanup reached `Settings.tsx`, `ProductOverview.tsx`,
`Releases.tsx` and `portal/App.tsx`; five files kept the removed model alive.

| Site                                                                             | Was                                                        | Now                                                                                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `views/products/EditProductDialog.tsx`, `views/products/CreateProductDialog.tsx` | "Admin group" / "OIDC group that administers this product" | "Admin group (metadata only)" + "Grants no access…", matching the read-only wording already adopted in `ProductOverview.tsx` |
| `views/Dashboard.tsx`                                                            | `"Platform administrator" : "Product administrator"`       | one persona                                                                                                                  |
| `views/Dashboard.tsx`                                                            | a two-valued `Role` stat tile                              | `Access · All products`                                                                                                      |
| `views/Dashboard.tsx`                                                            | "Ask a platform admin to grant access"                     | removed — no endpoint, table or UI can issue such a grant                                                                    |
| `components/Shell.tsx`, `views/Dashboard.tsx`                                    | three affordances gated on `me.platformAdmin`              | ungated; the predicate was a constant                                                                                        |
| `App.tsx`                                                                        | "Not authorized — you do not administer X"                 | "Unknown product" — the only reachable cause                                                                                 |
| `views/Settings.tsx`                                                             | docstring still advertising an admin-group field           | corrected                                                                                                                    |

Three tests were regression coverage **for** the removed feature (`dashboard.test.tsx` rendered
`platformAdmin: false` and asserted a "Product administrator" label; `App.test.tsx` asserted
"Not authorized"). They now assert the opposite.

**Other UI promising behaviour the server refuses**, found in the same sweep and fixed:

- `views/Tiers.tsx` — the delete dialog said "licenses already assigned to this tier keep their
  settings, but the tier can no longer be assigned", describing a soft-retire that does not
  exist: `handlers/tiers.ts` 409s outright while `countLicensesUsingTier > 0`. Its 409 was also
  reported as "that id is already in use", which is the _create_ conflict, not the delete one.
- `views/Profiles.tsx` — same defect. `countLicensesUsingProfile` sums `license_profiles` **and**
  `tiers.profile_id`, so the two referrer classes the copy said would "fall back to their own
  settings" are exactly the two that block the delete.
- `views/Releases.tsx`, `views/Oidc.tsx` — the resync buttons were ungated. `release/resync.ts`
  returns "product is not linked to a repo" (422) for any product whose `release_source` is not
  `github`, so for every manually-created product these could only fail. Now disabled with a
  reason, matching the gate `Products.tsx` already applied to its menu item.

### Test status

| Item                                          | Done? | Test                                                                         |
| --------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| Residual 4 — uncapped `new RegExp` in the SPA | yes   | `validate — pattern is matched in linear time (R10 residual 4)` (5 tests)    |
| Residual 5 — workerd lane                     | yes   | `packages/worker/test-workerd/runtime.test.ts` (9 tests) + CI job `workerd`  |
| Phantom per-product admin in the SPA          | yes   | `dashboard.test.tsx` (2, inverted), `App.test.tsx` (1, inverted)             |
| Tier / profile delete copy inverted           | yes   | covered by existing `tiers.test.tsx` / `profiles.test.tsx` render assertions |
| Ungated resync for unlinked products          | yes   | `disables resync for a product that is not linked to a repo`                 |

`pnpm --filter @polaris-key/admin test` → **141 passed / 17 files** (was 134).
`pnpm --filter @polaris-key/worker test:workerd` → **9 passed / 1 file** (new lane).
`pnpm --filter @polaris-key/worker test` → **735 passed / 39 files**, unaffected by this lane.
Typecheck (`admin`, `test-workerd`) and prettier clean on every file touched; `ci.yml` parses.

### Reported, not fixed

1. **`RotateKeyResultDialog.tsx:38-39` instructs an action the console cannot perform.** It
   tells the operator to "activate [the staged key] after clients have had a trust-refresh
   window", and `Settings.tsx:471-474` and `Products.tsx:257` repeat it. The server supports
   `POST …/keys/{activate,retire,revoke}`, but `packages/admin/src/api.ts` exposes only
   `rotateProductKey`. A staged key can therefore be created from the UI and never activated
   from it. This is a missing feature, not stale copy — it needs three client methods and an
   affordance, which is a design decision, not a remediation.
2. **`api.ts` does not carry the server's error message.** `ApiError` keeps only
   `status`/`code`/`fields`, so every call site has to guess what a 409 meant. This lane made
   the two delete paths pass an explicit conflict message; the general fix is to thread the
   response body's message into `ApiError`.
3. **`api.ts:2-3` cites `packages/worker/src/manage/api.ts`** as the source of truth. That path
   does not exist; it is `packages/worker/src/admin/api.ts`.
4. **`Products.tsx:330` labels a tombstone as `Delete`** while its own confirm dialog says
   "Disable product". `admin/repo.ts:63-98` confirms tombstone semantics, so the dialog is
   right and the menu label is wrong.
5. The workerd lane's compat-date fallback, above — needs vitest 4 across the workspace.
