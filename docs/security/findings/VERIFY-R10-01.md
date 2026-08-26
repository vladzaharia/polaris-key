# VERIFY-R10-01 — Blue-team verification of "Ajv runtime codegen ⇒ `/config` always 500s on workerd"

**Verdict: CONFIRMED (severity Critical retained, reclassified as a release blocker, not an
active production incident).**

Verifier posture: adversarial. The goal was to refute. Three independent refutation attempts
were made and all three failed. Two material errors in the original finding were found, one of
which makes the bug _more_ certain than filed, and one of which invalidates its fix direction.

---

## 1. The claim under test

`docs/security/findings/R10-dos.md` §R10-01 asserts:

1. Ajv's `compile()` runs inside request handlers (`packages/shared-catalog/src/catalog.ts:54`,
   reached from `packages/worker/src/licensing.ts:514` → `packages/worker/src/configDoc.ts:45`).
2. workerd forbids runtime code generation outside the startup window.
3. Therefore `GET /<product>/config` returns HTTP 500 `catalog_unavailable` for every device on
   every poll, with no attacker involved.
4. Every admin catalog publish 422s, and every override PATCH 500s.

**Why the original PoC was insufficient.** `packages/worker/vitest.config.ts` sets
`environment: "node"`. Node permits dynamic `Function(string)` construction. The 5 vitest tests
cited as proof install a stub/proxy to _simulate_ the workerd restriction; they are consistent
with the claim but cannot demonstrate anything about workerd's actual behaviour.
`@cloudflare/vitest-pool-workers` is not installed in this repo. The runtime premise was
therefore unverified.

## 2. Method

All evidence below is from **real workerd** (`workerd 2026-06-23`, driven by
`wrangler 4.104.0` in `--local` mode, which runs the genuine workerd binary), not from Node and
not from a simulation. Scratch workers were built in `/tmp` (nothing under `packages/`,
`sdks/`, or `conformance/` was modified). No request was sent to `key.plrs.im`; all
production reasoning is from the repository.

Three experiments:

- **E1** — isolated runtime probe: dynamic `Function(string)` construction, `eval`, and
  `Ajv#compile`, each at module scope vs. inside `fetch()`, under the worker's exact
  `compatibility_date` and `compatibility_flags`.
- **E2** — the real thing: the actual `@polaris-key/catalog` `Catalog` class (built `dist`) and
  the actual `products/djdl/catalog.json`, driven through verbatim copies of
  `licenseCore.ts#catalogDefaultPayload`, `configDoc.ts#validatePayload`, and the
  `licensing.ts:509-522` try/catch, inside a workerd `fetch()` handler.
- **E3** — compatibility-date sweep, to test whether any compat setting rescues the code path.

## 3. Raw evidence

### E1 — isolated runtime probe

`/tmp/wd-r1001/wrangler.toml` used `compatibility_date = "2026-04-07"` and
`compatibility_flags = ["nodejs_compat"]`, copied from `packages/worker/wrangler.toml`.

```
$ curl -s http://127.0.0.1:8797/
{
  "startup_new_Function":          "OK:42",
  "startup_ajv_compile":           "OK: validate('x')=true",
  "request_new_Function":          "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_eval":                  "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_ajv_compile_trivial":   "THREW: EvalError: Code generation from strings disallowed for this context",
  "request_ajv_compile_complex":   "THREW: EvalError: Code generation from strings disallowed for this context"
}
```

workerd also logged the generated source it refused to evaluate, confirming the throw is Ajv's
codegen and not an import/bundling artifact:

```
✘ [ERROR] Error compiling schema, function code: const schema2 = scope.schema[2]; …
          return function validate1(data, {instancePath="", …}){ … }
```

Premise 2 is true, and the startup/request split is exactly as the finding describes. Note
`startup_ajv_compile` succeeds — codegen is permitted at module scope, forbidden in-request.

### E2 — the real `Catalog` and the real djdl catalog, under workerd

```
$ curl -s http://127.0.0.1:8798/
{
  "step1_catalogDefaultPayload":        "OK: seeded 16 config keys",
  "step2_handleConfig_validatePayload": "THREW: EvalError: Code generation from strings disallowed for this context",
  "simulated_http_status":              "500 catalog_unavailable",
  "step3_adminPublish_compileAll":      "THREW: EvalError: Code generation from strings disallowed for this context",
  "simulated_publish_status":           "422 invalid catalog",
  "step4_overrides_uncaught":           "THREW (uncaught in real code => 500): EvalError: Code generation from strings disallowed for this context"
}
```

This is the decisive result. `products/djdl/catalog.json` has 28 entries, 17 of kind `config`,
**16 with a `default`**. `catalogDefaultPayload` seeds all 16 into `payload.config` without
compiling; `handleConfig` then constructs a second `Catalog` and calls `validatePayload`, whose
`prune` invokes `validateKeyValue` → `validatorFor` → `ajv.compile` → `EvalError`. The
`try/catch` at `licensing.ts:516-522` converts it to **500 `catalog_unavailable`**. Claims 1,
3 and 4 hold.

### E2b — boundary conditions

```
A_djdl_catalog_with_16_defaults : 500 catalog_unavailable <- EvalError: Code generation from strings disallowed for this context
B_djdl_catalog_empty_payload    : 200 OK (0 config keys signed)
C_empty_catalog_empty_payload   : 200 OK (0 config keys signed)
D_single_config_key             : 500 catalog_unavailable <- EvalError: Code generation from strings disallowed for this context
E_repeat_same_request           : 500 catalog_unavailable <- EvalError: Code generation from strings disallowed for this context
```

The failure is not a function of catalog size — **one** config key in the payload is enough (D).
It is not first-request-only: it recurs on every request in the same warm isolate (E), because
nothing is memoised. It is _not_ triggered when the effective payload has zero `config` and zero
`secret` entries (B, C), since `prune` never enters the loop — this is the only safe case.

### E3 — no compatibility setting rescues it

```
compat_date=2024-01-01 -> {"startup":"THREW: EvalError: …","request":"THREW: EvalError: …"}
compat_date=2025-05-01 -> {"startup":"THREW: EvalError: …","request":"THREW: EvalError: …"}
compat_date=2025-06-01 -> {"startup":"OK:1",              "request":"THREW: EvalError: …"}
compat_date=2026-04-07 -> {"startup":"OK:1",              "request":"THREW: EvalError: …"}
```

`allow_eval_during_startup` (default from `2025-06-01`) enables codegen at module scope only.
Request-phase codegen throws at **every** compat date tested. Rolling the compat date backwards
strictly worsens things. There is no opt-out, and `packages/worker/wrangler.toml` declares no
`unsafe_eval` binding. Refutation avenue (d) is closed.

## 4. Reachability — is a `Catalog` really built per request?

Yes. No memoisation exists anywhere. Every non-test construction site builds a fresh instance
inside a request handler:

| Site                                                | Context                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| `packages/worker/src/licensing.ts:514`              | `handleConfig` — the hot path                         |
| `packages/worker/src/licenseCore.ts:165`            | `catalogDefaultPayload` (constructs only; no compile) |
| `packages/worker/src/browserSession.ts:189`         | browser session config                                |
| `packages/worker/src/portal/api.ts:117`             | portal API                                            |
| `packages/worker/src/admin/lib/shape.ts:88`         | `loadCatalog`, used by override PATCH                 |
| `packages/worker/src/admin/handlers/schema.ts:39`   | `PUT …/schema` + `compileAll()`                       |
| `packages/worker/src/admin/handlers/products.ts:86` | `compileSchema` + `compileAll()`                      |

The only `compileAll()` call outside a request handler is `products/gen-seed.ts:90`, an offline
Node build script, where codegen is legal and therefore proves nothing about production.

The module header at `packages/shared-catalog/src/catalog.ts:3-7` documents the required
mitigation ("call `compileAll()` when a catalog is first loaded, cache the Catalog per
product+schemaVersion"). It was never implemented. The finding is correct on this point.

## 5. Reconciliation — the two errors in the original finding

### 5a. The finding's own claim chain is self-defeating; it is rescued by a path the finding missed

Attempted refutation: if claim 4 is true and _every_ catalog publish 422s, then no `schemas`
row can ever exist, `getActiveSchema` returns `null`, `handleConfig`'s `if (schemaRow)` guard is
skipped, and `/config` returns **200**. Claims 3 and 4 would be mutually exclusive and the
"100% down" impact would be unreachable.

That refutation fails, because R10-01 enumerated only two of the three publish paths. The third
— **the one `docs/DEPLOYMENT.md` §9 explicitly prescribes** ("DJDL should be linked through the
admin portal, not seeded directly") — writes `catalog_json` with no `Catalog` and no
`compileAll()` at all:

- `packages/worker/src/release/linkRepo.ts:210-215` — `stmtInsertSchema({ … catalog_json:
JSON.stringify(manifest.catalog), active: 1 … })`. No validation, no codegen.
- `packages/worker/src/release/resync.ts:184-194` — same, on `.pkey/` resync.

So the repo-link flow **succeeds** under workerd and installs an active catalog, after which
`/config` 500s on every poll. The finding's impact is real; its reasoning about how the catalog
gets there was incomplete. This makes the bug more certain, not less. It is also an independent
consistency defect worth filing separately: `linkRepo`/`resync` accept catalogs that
`PUT …/schema` and `POST …/products` would reject, so the two onboarding paths do not enforce
the same invariant.

### 5b. The finding's primary fix direction does not work

R10-01 recommends "cache `Catalog` instances keyed by `(product, catalog_version)` in module
scope so parse+compile happens once per isolate, not once per request."

E1 refutes this. Codegen is legal only during the **startup window**, and catalogs are read
asynchronously from D1, which is only possible once a request is in flight. A module-scope map
populated lazily on the first request still compiles in request phase and still throws — it
merely converts a per-request 500 into a per-isolate 500. Caching is a valid _CPU_ optimisation
but is not a fix for the outage. Only the finding's other two directions are viable: replace Ajv
with an interpreting validator (e.g. `@cfworker/json-schema`, absent from this repo today), or
precompile catalogs to standalone modules at build time — the latter being incompatible with
operator-supplied catalogs arriving at runtime.

### 5c. Why the operator has not noticed

Not because the claim is wrong. **The production deploy has never run.**
`.github/workflows/deploy.yml` triggers exclusively on `push: tags: ["v*"]`, and the repository
has **zero tags** (`git tag -l | wc -l` → `0`) across 37 commits spanning 2026-06-23 to
2026-08-25. `docs/DEPLOYMENT.md` is a forward-looking bootstrap runbook: its §10 line "Schema
returns DJDL catalog version 1" is a _verification step to be performed_, not a recorded
observation. Refutation avenue (a) fails, (c) fails, (d) fails; avenue **(b) — the deployment is
not yet serving this code — is the correct explanation.**

This is a latent defect that fires on the first real production cut, not an ongoing incident.

## 6. Verdict and corrected severity

**CONFIRMED.** Premise (workerd blocks request-phase codegen), code path (per-request
`ajv.compile` with no memoisation), and impact (500 `catalog_unavailable`) are all directly
demonstrated on real workerd under the worker's own compat configuration.

**Severity: Critical — retained**, with the classification sharpened to **release blocker**
rather than active outage. Justification for retaining Critical: the moment a `v*` tag ships,
`GET /<product>/config` is 100% down for every device of every product with a non-empty
effective config payload; the admin API cannot publish or repair a catalog; and override PATCH
returns an unhandled 500. There is no attacker and no workaround.

### Exact conditions

|                   |                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Affected routes   | `GET /<product>/config` (500 `catalog_unavailable`); `PUT /manage/api/products/<slug>/schema` (422); `POST /manage/api/products` with a schema (422); license/profile override `PATCH` (unhandled 500, `admin/lib/overrides.ts:55` is outside any catch); `POST /<product>/session/license` (fails **open** — see below) |
| Unaffected        | `linkRepo` / `resync` publishing (no compile); `/config` when the effective payload has zero `config` **and** zero `secret` entries (empty catalog, or catalog with no defaults and no overrides)                                                                                                                        |
| Trigger threshold | one config or secret key in the effective payload; djdl has 16                                                                                                                                                                                                                                                           |
| Frequency         | every request, warm or cold — nothing is cached                                                                                                                                                                                                                                                                          |
| Compat flags      | irrelevant; reproduced at compat dates 2024-01-01 → 2026-04-07                                                                                                                                                                                                                                                           |
| Environments      | all workerd (production and `wrangler dev`). Not reproducible under `vitest environment: "node"`, which is why it survived CI                                                                                                                                                                                            |

## 7. Knock-on effects on other findings

- **R10 §"server-side `pattern` ReDoS"** (`R10-dos.md:448-451`) — that note claims server-side
  Ajv `pattern` ReDoS is currently unreachable _because of_ R10-01. Since R10-01 is CONFIRMED,
  the note **stands**: the ReDoS is genuinely unreachable today and must not be promoted. It
  becomes live the moment R10-01 is fixed with an interpreting validator, so the ReDoS mitigation
  (a cap on `pattern` complexity) is a **required part of the R10-01 fix**, not a separate
  follow-up. Sequencing these two fixes independently would open the ReDoS.
- **`browserSession.ts:184-195` fails open** — confirmed by E2 step 4's mechanism. That handler
  catches the `EvalError` and proceeds _without_ catalog validation, so the defence-in-depth
  prune documented at `configDoc.ts:28-32` silently never runs on the browser-session lane. This
  is an integrity finding, not availability, and is currently masked by R10-01. Fixing R10-01
  closes it incidentally, but the fail-open catch should be tightened on its own merits.
- **New, not previously filed** — `linkRepo.ts:210-215` and `resync.ts:184-194` insert
  operator-supplied catalogs into `schemas` with no structural validation whatsoever, while the
  two admin API paths validate via `compileAll()`. Whatever replaces Ajv must be wired into all
  three paths or the inconsistency persists after the fix.
- **CI gap** — `packages/worker/vitest.config.ts` uses `environment: "node"`, which cannot catch
  this class of defect. Any fix should land with `@cloudflare/vitest-pool-workers` (currently not
  a dependency) or a `wrangler dev` smoke test covering `/config`, otherwise the same failure
  mode can regress undetected.

---

_Verified on real workerd 2026-06-23 via wrangler 4.104.0 `--local`. Scratch workers:
`/tmp/wd-r1001` (isolated probe), `/tmp/wd-real` (real `Catalog` + real djdl catalog),
`/tmp/wd-compat` (compat-date sweep). No repository source was modified; no request was made to
`key.plrs.im`._
