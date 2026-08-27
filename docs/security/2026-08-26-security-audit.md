# Polaris Key — consolidated security audit

**Date:** 2026-08-26 · **Tree audited:** `bd26e0b` (branch `lewd-owl`, identical to `main` at audit
start) · **Audience:** the repository owner.

Every claim below carries a `file:line` or a test name. Where a citation comes from a lane document
rather than from source I re-read, it is marked. Where something is unproven, it says so.

---

## 1. Executive summary

> ## ⚠ CORRECTION (2026-08-26, post-publication)
>
> **This section originally claimed Polaris Key had never been deployed. That is wrong, and the
> error mattered.** Verified against the live account after `wrangler login`:
>
> - `https://key.plrs.im/` → **HTTP 200**, and `/djdl/.well-known/jwks.json` → **HTTP 200**.
> - `wrangler deployments list --env prod` shows deployed worker versions dated **2026-06-27**.
> - Production D1 had migrations `0001`–`0009` applied while the repo was at `0011`.
>
> What was true is narrower: **the deploy _workflow_ never ran** — zero tags, CI never passed. The
> worker was deployed **by hand** with `wrangler deploy`, bypassing the pipeline. The lagging
> migration state is the fingerprint of exactly that.
>
> **Therefore the claim "nothing in this report is an incident" below is withdrawn.** The vulnerable
> code is internet-reachable now. What limits the impact is the data, not the code: production holds
> **1 product, 0 licenses, 0 devices, 1 portal account, 5 audit rows** — there is no user base to
> harm yet, and the two tables the destructive migration drops (`customers`, `identity`) are empty.
>
> How the error happened is worth recording, because it is the audit's own methodological lesson:
> every deployment signal reachable **from inside the repository** — tags, CI history, workflow
> triggers — pointed at "never deployed", and all of them were consistent with each other. None of
> them could see a manual `wrangler deploy`. The audit ran without Cloudflare credentials and
> inferred production state from repository state. That inference was sound and the conclusion was
> still false. Absence of evidence in the repo was treated as evidence of absence in the account.
>
> One thing the correction confirms rather than undermines: `jwks.json` returning 200 proves
> `PLATFORM_KEK` is valid and the product signing key opens — the single most important precondition
> for a safe deploy.

**Polaris Key's CI has never passed, and its deploy workflow has never run.**

- `git tag -l | wc -l` → **0**, across 37 commits spanning 2026-06-23 to 2026-08-25.
  `.github/workflows/deploy.yml:3-5` triggers exclusively on `push: tags: ["v*"]`. The production
  deploy job has therefore never executed.
- Every GitHub Actions run in the repository's history has failed. `gh run list` returns **15 runs,
  15 `failure`, 0 successes** — CI, Deploy and Release SDKs alike, from the first workflow commit
  through 2026-08-26T05:36Z. The cause is `.github/workflows/ci.yml` (and `deploy.yml`,
  `release.yml`) passing `with: version: 10` to `pnpm/action-setup@v4` while `package.json:5`
  declares `"packageManager": "pnpm@10.33.2"`. The action's `readTarget()` compares the two with a
  plain string `!==`, not a semver range, and aborts with `Multiple versions of pnpm specified`
  before the first `run:` step. `packageManager` has been present since the first commit
  (`dd54497`); the workflows landed later (`705ca58`). This is finding **R7-01**.

~~The consequence that matters: **nothing in this report is an incident.** There is no production
deployment, no customer, no revenue and no data at risk.~~ **Withdrawn — see the correction above.**
The worker is live and was deployed manually. The accurate statement is:

> Every Critical is **live and internet-reachable**, and has been since 2026-06-27. What bounds the
> impact is that production holds **0 licenses and 0 devices** — the platform is exposed but
> unused. The findings are therefore urgent to deploy, not merely urgent to fix.

`docs/security/findings/VERIFY-R10-01.md:192-200` reached the "never deployed" conclusion
independently, by elimination from repository state — and was wrong for the same reason this
section was. Its technical finding (Ajv codegen fails under workerd) was separately confirmed by
booting real workerd and stands unaffected; only its deployment inference is retracted.

The second consequence is less comfortable: **the 1158 green tests recorded in
`docs/security/findings/BASELINE.md` were produced locally, never by CI.** Every control this audit
would otherwise have credited — build, typecheck, lint, conformance-drift gate — was declared in a
workflow that could not reach it. R10-01 in particular sat in `main` across 37 commits with a
green-looking test suite, because `packages/worker/vitest.config.ts` sets `environment: "node"`,
where the failing operation succeeds.

### Headline counts

|                                 |                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Red-team lanes                  | 12, run in parallel                                                             |
| Architecture lenses             | 4, graded                                                                       |
| Findings filed                  | **164**                                                                         |
| — Critical                      | **4** filed Critical, **+1** elevated here (R2-02) — see §4                     |
| — High                          | 34                                                                              |
| — Medium                        | 68                                                                              |
| — Low                           | 53                                                                              |
| — Informational                 | 5                                                                               |
| Hypotheses refuted              | **115** by each lane's own count (120 if you count enumerated entries — see §6) |
| Findings Fixed                  | **68**                                                                          |
| Findings Fixed-partial          | **25**                                                                          |
| Findings still Reported         | **62**                                                                          |
| Accepted risk (deliberate)      | **8**                                                                           |
| Fixed in tree, unverified in CI | **1** (R7-01 — see §3.2)                                                        |
| Test delta                      | 1158 → **1745** (+587), all green                                               |

### Verdict

The **server-side data plane is genuinely well built.** `product` is column 1 of every primary key
and index on all 25 product-scoped tables; every authorization decision is re-read from D1 per
request; the keyvault fails closed with AAD context binding; the algorithm-downgrade guard is
correct in all three SDKs; there is no unauthenticated path to `PLATFORM_KEK`, to a product signing
key, or to an admin session. Four separate lanes tried to break cross-tenant isolation on the hot
path and could not.

The **control plane and the client side are not at the same standard.** Five defects would each,
alone, block a release: a repo contributor can achieve RCE on every install-base machine
(`R6-01`); a non-secret OAuth `state` was a bearer credential (`R8-01`); a user-writable cache file
could substitute the key bytes behind a _pinned_ `kid` (`R2-01`/`R4-02`); a compromised signing key
was unrevocable on already-provisioned clients (`R2-02`); and the managed-config endpoint would
have returned HTTP 500 for every device on every poll the moment the first tag shipped (`R10-01`).

The recurring structural cause is that **a linked GitHub repository is a control-plane input, not a
data source.** After a one-time platform-admin `linkRepo`, the contents of `.pkey/` on the repo's
default branch are the authoritative source of truth for that product's tiers, OIDC issuer,
artifact policy, admin group and binary name — pushed by anyone with write access, with no admin
review, no diff approval and no field allowlist (`R6-release.md:16-19`). Three of the five
Criticals and both notable chains in §5 start there. That trust boundary is now written down in
`docs/security/THREAT-MODEL.md` §5, which is the document the codebase was missing.

---

## 2. Methodology

**Phase 1 — 12 parallel red-team lanes.** Each lane took one surface, seeded with hypotheses from
the Lead, and was required to produce a _passing_ proof-of-concept for anything it filed. Lanes:
R1 control plane · R2 cryptography and key custody · R3 licensing enforcement · R4 client SDKs ·
R5 tenant isolation · R6 release channel · R7 supply chain · R8 OIDC/OAuth · R9 injection and SSRF ·
R10 denial of service · R11 data layer · R12 secrets and privacy. Lanes ran against a read-only
tree; no lane modified source.

**Phase 2 — adversarial blue-team verification.** The single most consequential finding (R10-01,
Critical, 100% availability loss) was handed to a verifier whose stated goal was to _refute_ it.
`docs/security/findings/VERIFY-R10-01.md` records three refutation attempts, all failed, and two
material errors found in the original filing — one of which made the bug more certain, one of which
invalidated its proposed fix direction. This is the only finding that received this treatment.

**Phase 3 — 4 architecture lenses**, each graded: anti-piracy realism, business-model fit,
multi-tenant blast radius, operational resilience. These asked whether the _design_ is right, not
whether the code matches it.

**Phase 4 — remediation in isolated lanes**, one owner per file set, each required to invert its own
PoCs in place so that a test that previously demonstrated the attack now asserts its failure.

**Phase 5 — integration**, this document, plus `docs/security/THREAT-MODEL.md` and
`docs/security/WIRE-CONTRACT-V2.md` (both Lead-authored) and `SECURITY.md`.

### Limitations, stated plainly

1. **Static analysis and local proof-of-concept only.** Nothing touched production. No request was
   sent to `key.plrs.im`. There is no production to test against.
2. **No live penetration test.** No network-level testing, no TLS/certificate assessment, no
   Cloudflare-side configuration review, no social-engineering component.
3. **Worker tests run under Node, not workerd.** `packages/worker/vitest.config.ts` sets
   `environment: "node"`. This is itself finding-grade: it is the reason R10-01 survived 37 commits
   undetected, since Node permits the dynamic `Function(string)` construction that workerd forbids
   in-request. R10-01's verification had to build scratch workers in `/tmp` driven by
   `wrangler 4.104.0 --local` to observe real workerd behaviour. `@cloudflare/vitest-pool-workers` is
   still not a dependency (verified: absent from every `package.json`). Every other lane's results
   inherit this blind spot.
4. **Three lanes shipped no PoC test file at all.** R7 (supply chain) evidence is scratch-directory
   probes, a `pnpm/action-setup` simulator, timing harnesses and an OSV batch query. R2's Python
   signer divergence is a measured transcript. Several R4, R5 and R12 findings are marked
   _code-traced_ or _static_ — these are read, not run, and should be treated accordingly.
5. **Two GitHub-dependent findings could not be executed.** R5-03 (installation-token scope) and
   R10-05 (subrequest amplification against GitHub's quota) are reasoned from documented API
   behaviour, not demonstrated.
6. **Line numbers drift.** All `file:line` citations in the findings register are as of the audit
   snapshot `bd26e0b`. Remediation moved many of them (e.g. `pollAuthFlow` `oidc.ts:823-855` →
   `:1052-1093`). Where a fix location matters, §4 gives the post-remediation line.
7. **Three lane documents have no `## Remediation` section** (R5, R7, R9) and one has fix
   _directions_ only (R12). Their findings are nonetheless partly fixed, by adjacent lanes. The
   register below reports **verified tree state**, not document state, and flags each divergence.

---

## 3. Findings register

164 findings, grouped by severity, sorted by ID within each group.

**Reading the table.** `Where` is the audit-snapshot location. `Status` is the _verified current
state of the working tree_, which in several places differs from the lane document — those rows are
marked `†` and explained beneath their group. `Proof` names the test; unless a full path is given,
worker tests live in `packages/worker/test/attack/`.

**Two traps.** (a) In R2, R4, R5, R6, R10, R11 and R12, the `describe()` block IDs inside the PoC
files are **offset** from the finding IDs — e.g. R2-01 is proven by `describe("R2-02 · …")`, and
R10-09 by `describe("R10-07 …")`. Quote test names verbatim; never infer an ID from one. (b) Because
PoCs were inverted in place, several test names still read as the vulnerability while asserting the
fix. A green test named after an attack is evidence the attack _fails_.

### 3.1 Critical

| ID     | Title                                                                                  | Where                                                                                                 | Status    | Proof                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01  | Trust-set poisoning: the on-disk cache overrides a **pinned** kid                      | `packages/sdk-node/src/client.ts:184-186`; also `client.py:188-189`, `PolarisKeyClient.swift:168-170` | **Fixed** | `packages/sdk-node/test/R2-trust-attack.test.ts` → `describe("R2-02 · trust-set poisoning …")` ×3; corpus `trust-pinned-substitution`; Python `test_c2_manifest_cannot_substitute_the_bytes_behind_a_pinned_kid` |
| R6-01  | `install.sh` RCE — repo-controlled `binary_name` injected into the served shell script | `packages/worker/src/release/install.ts:46-143`; ingest `packages/shared-manifest/src/index.ts:752`   | **Fixed** | `R6-release.test.ts:344,371,394` incl. `it("END-TO-END: a push to .pkey/release.json rewrites binary_name and poisons install.sh")`                                                                              |
| R8-01  | `/auth/poll` mints a device token for an ATTACKER-CHOSEN device id                     | `packages/worker/src/oidc.ts:823-855` (`pollAuthFlow`)                                                | **Fixed** | `R8-oidc.test.ts:246` `it("ATTACK: knowing only \`state\`, an attacker mints a LIVE device token …")`; `:321`                                                                                                    |
| R10-01 | Ajv runtime codegen on `/config` ⇒ every managed-config request 500s on workerd        | `packages/shared-catalog/src/catalog.ts:28,54`; reached from `packages/worker/src/licensing.ts:514`   | **Fixed** | `R10-dos.test.ts` → `describe("R10-01 catalog validation no longer generates code at request time")` ×6; independently re-verified on real workerd (`VERIFY-R10-01.md`)                                          |

**Elevated to Critical by this report:**

| ID    | Title                                                         | Where                                                                    | Status    | Proof                                                                                                                                       |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-02 | No client-side key revocation — the trust set only ever grows | `packages/sdk-node/src/client.ts:535-547` (status ignored at `:536-540`) | **Fixed** | `R2-trust-attack.test.ts` → `describe("R2-03 · no client-side key revocation …")` ×2; corpus `key-status-revoked`, `trust-prune-on-absence` |

R2-02 is filed **High** in `R2-crypto.md` and is reproduced here as Critical. The justification is
`THREAT-MODEL.md:124-133`, which names it as one of the two properties that separate "piracy is
bounded" from "one compromise is permanent", and `WIRE-CONTRACT-V2.md:27-30`, which records that
R2-01/02/03 "are one defect wearing three hats and must be fixed together" — reversing the merge
order alone is worthless if anything installed is permanent. The lane's own severity is retained in
the count above (34 High includes it once); it is narrated in §4 because the Lead ranked it as a
release blocker, not because a lane graded it Critical.

### 3.2 High (34)

| ID     | Title                                                                                                   | Where                                                                                         | Status                                | Proof                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-09  | Any same-origin XSS defeats the whole admin cookie hardening story                                      | `packages/worker/src/admin/session.ts:1-19`                                                   | **Fixed**                             | Architectural; mechanism established by `R1-control-plane.test.ts` `R1-05a`, `R1-06b`, `R1-07b`, `R9-injection.test.ts` `R9-11`/`R9-12`                  |
| R2-02  | No client-side key revocation                                                                           | see §3.1                                                                                      | **Fixed**                             | see §3.1                                                                                                                                                 |
| R2-03  | The cached document is never re-verified on load                                                        | `packages/sdk-node/src/store.ts:194-202`                                                      | **Fixed**                             | `R2-trust-attack.test.ts` → `describe("R2-04 · the cached document is NEVER re-verified …")` ×2; Python `test_v1_cache_record_is_discarded_not_migrated` |
| R3-01  | Build gate enforced from attacker-controlled headers                                                    | `packages/worker/src/licensing.ts:525-526`; bypass at `packages/worker/src/gate.ts:127`       | **Fixed-partial**                     | `R3-licensing.test.ts` → `it("FIXED (R3-01): X-PKey-Version: 0.0.0-dev no longer defeats the version window")` ×3                                        |
| R3-02  | Seat-limit check is a non-atomic read-then-write                                                        | `packages/worker/src/licenseCore.ts:341-351`                                                  | **Fixed**                             | `R3-licensing.test.ts` → `it("FIXED: concurrent activations are capped at deviceLimit by the DB")`                                                       |
| R3-03  | One machine mints unlimited free licenses by varying the fingerprint subset                             | `packages/worker/src/fingerprint.ts:86-93`                                                    | **Fixed**                             | `R3-licensing.test.ts` → `it("FIXED (R3-03): varying the submitted component subset yields ONE license")`                                                |
| R3-04  | Hardware binding is never re-verified after activation                                                  | `packages/worker/src/licenseCore.ts:290`                                                      | **Fixed-partial**                     | `R3-licensing.test.ts` → `it("an exfiltrated device token works from any machine, on every authenticated surface")` — **still green**                    |
| R4-01  | Offline cache is not integrity-protected                                                                | `packages/sdk-node/src/client.ts:491-510`; reload `store.ts:194-202`                          | **Fixed**                             | `packages/sdk-node/test/R4-client-attack.test.ts` → `describe("R4-01: unauthenticated offline cache")` ×2                                                |
| R4-02  | Cache-planted `trustedKeys` grant permanent document-signing authority                                  | `packages/sdk-node/src/client.ts:184-186`                                                     | **Fixed**                             | `R4-client-attack.test.ts` → `describe("R4-02: trust-set injection via the cache file")`; corpus `trust-signed-by-non-pinned-key`                        |
| R4-03  | Anti-replay counters are attacker-writable in both directions                                           | `packages/sdk-node/src/verify.ts:27-32`, `client.ts:496,529-534`                              | **Fixed**                             | `R4-client-attack.test.ts` → `describe("R4-03: anti-replay counters are attacker-controlled …")` ×3                                                      |
| R5-01  | Cross-tenant license injection into any portal account via unverified OIDC email                        | `packages/worker/src/oidc.ts:674-681`; join at `portal/repo.ts:275-278`                       | **Fixed** †                           | `R5-isolation.test.ts` → `it("a license minted in a custom-issuer product no longer reaches an unrelated victim's portal")` ×2                           |
| R5-02  | The portal↔license `sub` join is qualified by neither product nor issuer                                | `packages/worker/src/portal/repo.ts:296-299`                                                  | **Fixed** †                           | `R5-isolation.test.ts` → `it("a tenant-controlled IdP subject can no longer link into a platform-IdP portal account")`                                   |
| R5-03  | GitHub App installation tokens are minted un-scoped; cache scope inconsistent                           | `packages/worker/src/release/githubApp.ts:218-228`; cache key `:210`                          | **Reported**                          | Code-traced only — needs a live GitHub App                                                                                                               |
| R5-04  | One `PLATFORM_KEK` unwraps every tenant's keys; no per-tenant derivation                                | `packages/worker/src/keyvault.ts:67-83`                                                       | **Reported**                          | Code-traced. `grep -rn "HKDF\|deriveKey\|deriveBits"` → 0 hits                                                                                           |
| R6-02  | `install.sh` performs no integrity verification of the downloaded binary                                | `packages/worker/src/release/install.ts:109-123`                                              | **Fixed**                             | `R6-release.test.ts:460`, `:498` `it("serves the published .sha256 sidecar so the installer can verify the download")`                                   |
| R6-03  | Sparkle `edSignature` relayed verbatim; pubkey decorative; repo can disable the requirement             | `packages/worker/src/release/index.ts:556-583`                                                | **Fixed**                             | `R6-release.test.ts:559`, `:602`, `:657`; new `packages/worker/src/release/sparkle.ts`                                                                   |
| R6-04  | Artifact streaming relays repo-chosen `Content-Type`, drops `Content-Disposition`, no `nosniff`         | `packages/worker/src/release/github.ts:145-157`                                               | **Fixed**                             | `R6-release.test.ts:722`, `:802`                                                                                                                         |
| R7-01  | `pnpm/action-setup@v4` hard-fails on every CI/deploy/release run                                        | `.github/workflows/ci.yml:14-16`, `deploy.yml:19-21`, `release.yml:21-23`, `package.json:5`   | **Fixed-in-tree, unverified in CI** † | Simulator `/tmp/r7_sim.mjs`; corroborated by `gh run list` → 15/15 failure                                                                               |
| R7-02  | `.pkey/` manifest YAML parse is quadratic and uncapped, reachable from a push webhook                   | `packages/shared-manifest/src/index.ts:960-975`                                               | **Reported**                          | Timing table vs `yaml@2.9.0`; no cap present in `fetchRepoFile` today                                                                                    |
| R7-03  | Product-supplied JSON Schema `pattern` compiles to unguarded `RegExp` — 54 s ReDoS                      | `packages/shared-catalog/src/catalog.ts:54`                                                   | **Fixed** †                           | `packages/shared-catalog/src/regex.test.ts` — linear-time NFA; `(x+x+)+y` × 4000 chars = 4 ms                                                            |
| R7-04  | Production deploy triggered by a bare tag push, no branch/provenance constraint                         | `.github/workflows/deploy.yml:3-5`                                                            | **Reported**                          | Static; no `merge-base`/ancestor guard present                                                                                                           |
| R8-02  | Device-code flow: CSRF-able GET disclosing `state`/`nonce`, non-secret user code, unenforced `interval` | `packages/worker/src/oidc.ts:624-635`                                                         | **Fixed-partial**                     | `R8-oidc.test.ts:478`, `:557`, `:587`                                                                                                                    |
| R8-04  | OIDC `state` is not single-use on the loopback path → flow injection                                    | `packages/worker/src/oidc.ts:814-816`                                                         | **Fixed**                             | `R8-oidc.test.ts:845` `it("ATTACK: a second callback on the same state overwrites the bound license …")`                                                 |
| R9-01  | OIDC `client_secret` exfiltration + SSRF via repo-controlled `oidc.issuer`                              | `packages/worker/src/oidc.ts:710-724`                                                         | **Reported**                          | `R9-injection.test.ts:215,252,297,327` incl. `it("POSTs the sealed client_secret to the attacker-chosen issuer host")`                                   |
| R10-02 | `aarch64` / `amd64` arch aliases ⇒ guaranteed unhandled `TypeError` (500)                               | `packages/worker/src/router.ts:51`; throw at `release/assets.ts:55`                           | **Fixed** †                           | `R6-release.test.ts:890` (4 parameterised cases); `normalizeArch()` at `release/assets.ts:28`                                                            |
| R10-03 | `rateLimitOk` has no fail mode — a DO blip becomes a licensing outage                                   | `packages/worker/src/rateLimit.ts:17-36`                                                      | **Fixed** †                           | Per-surface failure policy at `rateLimit.ts:25-57`; unknown buckets fail closed                                                                          |
| R10-04 | Single-shard `RateLimitDO` with unbounded, never-collected storage                                      | `packages/worker/src/rateLimitDo.ts:22-50`                                                    | **Fixed-partial** †                   | Storage half fixed — `alarm()` sweep at `rateLimitDo.ts:93`. Sharding half (`R10-04a`) explicitly unfixed                                                |
| R10-05 | Unauthenticated GitHub-subrequest amplifier on the public release surface                               | `packages/worker/src/release/index.ts:279-322`                                                | **Reported**                          | Partial only — `packages/worker/test/release.test.ts` call logs; quota exhaustion reasoned, not executed                                                 |
| R11-01 | `countLicensesUsingProfile` misses `tiers.profile_id`; deleting a profile strips a tier's payload       | `packages/worker/src/admin/repo.ts:236-249`                                                   | **Fixed**                             | `R11-data.test.ts` → `describe("R11-01 missing foreign keys / no ON DELETE anywhere")` ×7                                                                |
| R11-02 | Seat consumption is check-then-act; a `<= 0` device limit disables the check outright                   | `packages/worker/src/licenseCore.ts:336-352`                                                  | **Fixed-partial**                     | `R11-data.test.ts` → `describe("R11-03 seat-count race")` ×2. DB half shipped (`0014_device_seats.sql`); call site still check-then-act                  |
| R12-02 | Managed secret values stored PLAINTEXT in D1 while every other secret class is KEK-sealed               | `packages/worker/src/admin/lib/overrides.ts:40-66`                                            | **Fixed** †                           | `R12-secrets.test.ts` → `it("FIXED: kind:'secret' and secret-flagged config are sealed in profiles.payload_json")`; new `admin/lib/managedSecrets.ts`    |
| R12-03 | Live GitHub App installation token cached in KV unencrypted                                             | `packages/worker/src/release/githubApp.ts:230-238`                                            | **Reported**                          | `R12-secrets.test.ts` → `it("CONFIRMED: the raw bearer token is readable from a KV dump")`                                                               |
| R12-04 | Magic-link token / OIDC `state` / device code used verbatim as KV key names                             | `packages/worker/src/portal/auth.ts:353`; also `oidc.ts:508,584,626,814`, `admin/auth.ts:168` | **Fixed** †                           | `R12-secrets.test.ts` → `it("CONFIRMED: the magic-link token IS the KV key and the victim email is the value")`; fix marker `admin/auth.ts:36`           |
| R12-07 | Python README pins a COMMITTED test keypair as a production trust anchor                                | `sdks/python/README.md:28,34,109`                                                             | **Reported**                          | `R12-secrets.test.ts` → `it("CONFIRMED: a doc forged with the committed private key verifies against the README's TRUST map")`                           |

† **Divergences from the lane documents in this group.** R5 has no `## Remediation` section and
states "No source file was modified"; R5-01 and R5-02 are nonetheless fixed — verified at
`packages/worker/src/oidc.ts:852` (`payload.email_verified === true`) and by the absence of the
unscoped `SELECT product, id FROM licenses WHERE lower(email) = ?` / `WHERE sub = ?` queries from
`portal/repo.ts`. R7 likewise has no Remediation section; R7-01 is fixed in the working tree
(`version: 10` removed from all three workflows, comment added at `ci.yml:19-21`) but **the fix is
uncommitted and unpushed, so CI still has not passed** — do not mark it closed until a green run
exists. R7-03 was closed incidentally by the R10-01 remediation, which removed `ajv` entirely
(`packages/shared-catalog/package.json:23` is now `"dependencies": {}`); this also resolves the only
production-reachable advisory chain in R7-07. R10-02 was closed by the R6 lane, R10-03/R10-04b by
the R1 lane, R12-02/R12-04 by lanes that did not update `R12-secrets.md` (which has no Remediation
section at all — on its own terms all 17 of its findings read as open).

### 3.3 Medium (68)

| ID     | Title                                                                                          | Where                                                                            | Status              | Proof                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1-01  | Login CSRF / admin session fixation on `GET /manage/callback`                                  | `packages/worker/src/admin/auth.ts:146-232`                                      | **Reported**        | `R1-control-plane.test.ts` `R1-01a`/`b`/`c`                                                                                                                  |
| R1-02  | Admin + portal sessions share one HMAC key, no domain separation                               | `packages/worker/src/portal/session.ts:62`                                       | **Fixed**           | `R1-control-plane.test.ts` `R1-02a`, `R1-02d`; fix signs `"pkey.admin.v1\|"` vs `"pkey.portal.v1\|"`                                                         |
| R1-05  | `handleMintAuth` renders D1 HTML unauthenticated, no CSP                                       | `packages/worker/src/edgeMint.ts:254-257`                                        | **Fixed**           | `R1-control-plane.test.ts` `R1-05a`; `R9-injection.test.ts:955`                                                                                              |
| R1-07  | Device-code "user confirmation" is self-servable by the flow's starter                         | `packages/worker/src/oidc.ts:624-635`                                            | **Fixed-partial**   | `R1-control-plane.test.ts` `R1-07a`, `R1-07b` — only the framable-page half is closed                                                                        |
| R2-04  | Protected header has no size cap; the 64 KiB payload cap is bypassable                         | `packages/shared-jws/src/index.ts:149`                                           | **Fixed**           | `packages/shared-jws/src/attack.test.ts` → `describe("R2-01 · the protected header has NO size cap …")` ×3; corpus `header-oversized`                        |
| R2-05  | Python's lenient base64url accepts JWS that Node and Swift reject                              | `sdks/python/src/polaris_key/b64url.py:16-23`                                    | **Fixed**           | `attack.test.ts` → `describe("R2-05 · base64url decoding is LENIENT …")`; corpus `sig-out-of-alphabet-{stars,whitespace,padding}`                            |
| R2-06  | Duplicate JSON keys: Swift first-wins, TS/Python last-wins                                     | `sdks/swift/Sources/PolarisKey/JWSVerifier.swift:46`                             | **Fixed**           | `attack.test.ts` → `describe("R2-06 · duplicate JSON keys …")` ×2; corpus `duplicate-key-header-alg`                                                         |
| R2-07  | Python's `sign_jws` emits different bytes than Node's `signJws`                                | `sdks/python/src/polaris_key/verify.py:176-177`                                  | **Fixed**           | Measured transcript (no PoC test). Fix pinned by `test_python_signer_reproduces_the_non_ascii_corpus_vector_byte_for_byte`; corpus `valid-non-ascii-payload` |
| R2-08  | `verifyDoc` omits `iss`/`expiresAt`/`schemaVersion`/`licenseId`; zero clock skew               | `packages/sdk-node/src/verify.ts:22-33`                                          | **Fixed**           | `R2-trust-attack.test.ts` → `describe("R2-08 · verifyDoc omits …")` ×2; corpus `docCases` ×12                                                                |
| R2-09  | KEK rotation is impossible — single KEK, hard `kekId` equality, no migration                   | `packages/worker/src/keyvault.ts:135-138`                                        | **Reported**        | Code-traced. See §8 item 3                                                                                                                                   |
| R2-10  | One key signs both config docs and trust manifests; no `typ` domain separator                  | `packages/worker/src/jwks.ts:60-61`                                              | **Fixed-partial**   | Client half only; corpus `typ-wrong`, `trust-manifest-as-config`. Server still signs both with one key                                                       |
| R2-11  | Content-only ETag: a 304 never refreshes the signed validity window                            | `packages/worker/src/configDoc.ts:83-95`; SDK `client.ts:460-465`                | **Fixed**           | `R2-trust-attack.test.ts` → `it("R2-11: a 304 (content-only ETag) never refreshes the signed validity window")`                                              |
| R3-05  | OIDC claim/migrate re-frees `enroll_hwid`, re-arming the free-licence mint                     | `packages/worker/src/repo.ts:748`; `oidc.ts:398`                                 | **Fixed** †         | `R3-licensing.test.ts` → `it("an OIDC sign-in no longer re-frees enroll_hwid; the machine cannot enroll again")`; markers `oidc.ts:478-479`, `repo.ts:736`   |
| R3-06  | `/enroll` hardcodes `expires_at: null`, ignoring the tier's expiry policy                      | `packages/worker/src/enroll.ts:70`                                               | **Fixed-partial**   | `it("FIXED (R3-06): auto-issued licenses honour the tier's expiry policy")`. `admin/handlers/licenses.ts:112` and its PATCH arm unfixed                      |
| R3-07  | Worker/SDK disagree on `0.0.0-pr-N`; Worker classifies real PR builds as `stable`              | `packages/worker/src/gate.ts:65`                                                 | **Fixed**           | `it("FIXED (R3-07): 0.0.0-pr-N is the pr channel to the worker, as it already was to the SDK")`                                                              |
| R3-08  | `POST /<p>/session/license` has no rate limit — unthrottled key oracle                         | `packages/worker/src/browserSession.ts:250-292`                                  | **Fixed**           | `it("FIXED: the key oracle is now capped at the same 30/min budget as /activate")`                                                                           |
| R3-09  | Any device token can deauthorize or relabel every sibling device on the licence                | `packages/worker/src/licensing.ts:414-472` (target check `:442`)                 | **Fixed** †         | `it("a device token can no longer deauthorize or relabel a sibling")`; guard at `licensing.ts:445`                                                           |
| R3-10  | Release access mode `licensed` is identical to `authenticated`                                 | `packages/worker/src/release/index.ts:120-145`                                   | **Reported**        | Static only — needs a `release_config` row plus GitHub stubs                                                                                                 |
| R4-04  | Gate reads the raw wall clock; no monotonic floor, no server-time anchor                       | `packages/sdk-node/src/client.ts:115` → `gate.ts:45-53`                          | **Fixed-partial**   | `R4-client-attack.test.ts` → `describe("R4-04: clock rollback / grace extension")`. **The floor as built is inert — see §8 item 1**                          |
| R4-05  | Tamper _detection_ defeated — `/config/report` echoes the attacker's own forged map            | `packages/sdk-node/src/client.ts:574-596`                                        | **Fixed**           | `R4-client-attack.test.ts` → `describe("R4-05: forged cache is reported to the control plane as ground truth")`                                              |
| R4-06  | Desktop bridge is an ambient, unauthenticated global capability                                | `packages/sdk-react/src/desktop/bridge.ts:93-100`                                | **Reported**        | `describe("R4-07: desktop bridge has no handshake, capability token or origin check")` — **still green**                                                     |
| R4-07  | Every Python CLI front end defaults `--version` to `0.0.0-dev`                                 | `sdks/python/src/polaris_key/cli/argparse_cli.py:22` (+4 more)                   | **Reported**        | Static                                                                                                                                                       |
| R4-08  | Node/Swift transport: no scheme validation, no timeout, no in-flight guard                     | `packages/sdk-node/src/client.ts:145`; `fetch.ts:36`                             | **Fixed-partial**   | `describe("R4-06: transport hardening gaps")` ×2. 2 of 4 sub-issues fixed                                                                                    |
| R5-05  | Portal rate-limit buckets have no product dimension; one global DO shard                       | `packages/worker/src/portal/api.ts:264-285`                                      | **Fixed** †         | `R5-isolation.test.ts` → `it("a non-owner cannot spend the budget, and exhausting product A leaves product B untouched")`                                    |
| R5-06  | `portalAuthCapabilities` aggregates every tenant; one tenant overrides another's opt-out       | `packages/worker/src/portal/repo.ts:496-516`                                     | **Reported**        | `it("one tenant keeping magic-link on overrides every other tenant's opt-out")` — still green                                                                |
| R5-07  | No tenant-scoped admin role exists; the only admin role owns every tenant                      | `packages/worker/src/admin/authz.ts:21-27`                                       | **Reported**        | `it("a product's own admin_group grants nothing; a platform admin owns every tenant")` — still green                                                         |
| R5-08  | Edge-mint recipes are not entitlement-gated (intra-tenant IDOR)                                | `packages/worker/src/edgeMint.ts:185-192`                                        | **Reported**        | `it("a free-tier device mints the premium recipe it was never granted")`                                                                                     |
| R5-09  | A single global `GITHUB_WEBHOOK_SECRET` authenticates all tenants' repo webhooks               | `packages/worker/src/githubWebhook.ts:106-124`                                   | **Reported**        | Code-traced                                                                                                                                                  |
| R6-05  | Webhook resync applies `.pkey/` from an attacker-supplied `ref`; self-attested branch gate     | `packages/worker/src/githubWebhook.ts:171`                                       | **Fixed-partial**   | `R6-release.test.ts:928` (inverted), `:965` (new). `:1090` marked `// NOT FIXED` — the repo-may-own vs admin-only field split is open                        |
| R6-06  | No replay protection on `/webhooks/github`                                                     | `packages/worker/src/githubWebhook.ts:96-220`                                    | **Fixed**           | `R6-release.test.ts:1009` `it("REPLAY: re-posting one captured delivery re-runs the full destructive resync …")`                                             |
| R6-07  | `channel_workflow` interpolated raw into an installation-token-bearing GitHub API URL          | `packages/worker/src/release/index.ts:340-360`                                   | **Fixed**           | `R6-release.test.ts:828`; duplicate `R9-injection.test.ts` `R9-03` ×2 inverted                                                                               |
| R7-05  | No `permissions:` block on `ci.yml` or `deploy.yml`                                            | `.github/workflows/ci.yml` (absence)                                             | **Fixed** †         | Verified: `permissions:` now present in all five workflows                                                                                                   |
| R7-06  | No action is SHA-pinned; two write-capable third-party actions on mutable refs                 | `.github/workflows/release.yml:34` (`changesets/action@v1`)                      | **Reported**        | Verified still `@v4`/`@v1`                                                                                                                                   |
| R7-07  | 19 open `pnpm audit` advisories; one chain (`ajv > fast-uri`) in the shipped Worker            | `packages/worker/package.json:16`                                                | **Fixed-partial** † | The production-reachable chain is gone (`ajv` removed); the dev-tree advisories remain                                                                       |
| R7-08  | npm publish has no `--provenance`, unlike the PyPI path                                        | `.github/workflows/release.yml:35-36`                                            | **Reported**        | Verified: no `provenance` anywhere in `release.yml`                                                                                                          |
| R8-03  | Login CSRF / session fixation: no flow on any of three surfaces is bound to the browser        | `packages/worker/src/oidc.ts:73-83`                                              | **Reported**        | `R8-oidc.test.ts:668`, `:740`, `:792` — all three still green                                                                                                |
| R8-05  | Claim trust: empty `sub`, unverified `email`, truthiness-only provisioning, no `iat`/`azp`     | `packages/worker/src/oidc.ts:663-681`                                            | **Fixed-partial**   | `describe("R8-05 claim trust")` ×4. `azp`/`at_hash`/`hd` deferred                                                                                            |
| R8-08  | Portal magic link: 72-bit token in a URL query string, stored unhashed, unrate-limited verify  | `packages/worker/src/portal/auth.ts:348`                                         | **Reported**        | `R8-oidc.test.ts:1333`, `:1382`                                                                                                                              |
| R8-10  | No rate limiting anywhere in `src/oidc.ts`                                                     | `packages/worker/src/oidc.ts` (whole file; `grep -c rateLimit` → 0)              | **Fixed**           | `R8-oidc.test.ts:406`; `rateLimitOk` added to all six handlers                                                                                               |
| R9-02  | Unauthenticated open redirect to the manifest-controlled issuer                                | `packages/worker/src/oidc.ts:512-526`                                            | **Reported**        | `R9-injection.test.ts:362`                                                                                                                                   |
| R9-03  | `channel_workflow` path/query injection on an installation-token request                       | `packages/worker/src/release/index.ts:350`                                       | **Fixed** †         | `R9-injection.test.ts:389,427,456`; fix `encodeURIComponent` at `release/index.ts:394`                                                                       |
| R9-04  | `gh_owner`/`gh_repo` path injection; permissive `parseRepoUrl`                                 | `packages/worker/src/release/linkRepo.ts:67-80`                                  | **Reported**        | `R9-injection.test.ts:488`, `:509`. Verified `[^/]+` still present                                                                                           |
| R9-05a | `/download/<token>` 302s to any host in `release_artifacts.source_url`                         | `packages/worker/src/portal/api.ts:679-687`                                      | **Reported**        | `R9-injection.test.ts:621`                                                                                                                                   |
| R9-11  | `/<p>/mint/<id>/auth` serves stored HTML unauthenticated with no CSP                           | `packages/worker/src/edgeMint.ts:246-258`                                        | **Fixed** †         | `R9-injection.test.ts:955`; fix `staticHtmlSecurityHeaders(...)` at `edgeMint.ts:278-284`                                                                    |
| R10-06 | `POST /<p>/session/license` is an unrate-limited `/activate` clone                             | `packages/worker/src/browserSession.ts:250-292`                                  | **Fixed** †         | Closed by R3-08's rate limit; no R10-lane test was written                                                                                                   |
| R10-07 | Unauthenticated KV-write amplification on `/<p>/auth/*`                                        | `packages/worker/src/oidc.ts:508-510`                                            | **Fixed** †         | Closed by R8-10's limiter. PoC block is named `R10-05`                                                                                                       |
| R10-08 | `/webhooks/github` buffers the entire request body before authenticating it                    | `packages/worker/src/githubWebhook.ts:118-124`                                   | **Reported**        | PoC block `R10-06` ×2                                                                                                                                        |
| R10-09 | Manual-channel regex ReDoS — the 80-char cap is not a guard                                    | `packages/worker/src/release/channels.ts:38`                                     | **Fixed-partial**   | PoC block `R10-07` ×3. The _catalog_ half is fixed (`shared-catalog/src/regex.ts`); `channels.ts:38` still reproduces                                        |
| R10-10 | `GET /<p>/config` is unrate-limited and writes D1 on every poll                                | `packages/worker/src/licensing.ts:475-566`                                       | **Reported**        | `describe("R10-10 …")` ×2                                                                                                                                    |
| R10-11 | Uncapped request headers written verbatim into D1 device rows                                  | `packages/worker/src/licensing.ts:65-81`                                         | **Reported**        | PoC block `R10-08` ×2                                                                                                                                        |
| R10-12 | KV token records have no TTL and are resurrected by _rejected_ requests                        | `packages/worker/src/kv.ts:27-34`                                                | **Fixed** †         | PoC block `R10-09` ×2; fix `expirationTtl: TOKEN_RECORD_TTL_SECONDS` at `kv.ts:46`                                                                           |
| R10-13 | Portal API: two full `licenses` table scans + writes per request, unmetered                    | `packages/worker/src/portal/repo.ts:265-310`                                     | **Fixed-partial** † | Closed by R11-08's `idx_licenses_email_lower` / `idx_licenses_sub_global`; the per-request call count is unchanged                                           |
| R11-03 | `resyncRepo` mutates five tables outside any batch, then can bail                              | `packages/worker/src/release/resync.ts:186-197`                                  | **Reported**        | `R11-data.test.ts` → `describe("R11-09 … multi-step flows OUTSIDE batch() are not atomic")`                                                                  |
| R11-04 | Migrations are not re-runnable; a partial apply omits `idx_licenses_enroll_hwid`               | `packages/worker/migrations/0011_auto_issue.sql:28-30`                           | **Fixed-partial**   | `0012_replay_guard.sql` re-asserts five critical indexes idempotently; full replay-idempotency declined                                                      |
| R11-05 | Unauthenticated `GET /download/<token>` full-scans a never-purged table                        | `packages/worker/src/portal/repo.ts:607-617`                                     | **Fixed-partial**   | `describe("R11-06 unindexed hot queries")`. Index + CAS landed; **no cron, no rate limit**                                                                   |
| R11-06 | Unguarded `JSON.parse` of DB columns takes admin/OIDC/edge-mint handlers to a 500              | `packages/worker/src/admin/lib/shape.ts:117`                                     | **Fixed-partial**   | Four sites remain: `oidc.ts:251,266,299`, `edgeMint.ts:207`                                                                                                  |
| R11-07 | No `CHECK` on any status/origin column; retiring the **active** signing key bricks the product | `packages/worker/src/admin/handlers/products.ts:730-737`                         | **Fixed**           | `describe("R11-02 status vocabulary drift")` ×5; `0015_data_integrity.sql` + 409 guard                                                                       |
| R11-08 | `licenses` has no `email` index; the portal's cross-tenant sweep is a full scan per request    | `packages/worker/src/portal/repo.ts:265-311`                                     | **Fixed**           | `idx_licenses_email_lower`, `idx_licenses_sub_global`; both sweeps now `SEARCH licenses`                                                                     |
| R11-09 | Soft delete retains PII forever; `audit`, `portal_audit`, download tokens unbounded, no cron   | `packages/worker/src/admin/repo.ts:51-78`                                        | **Fixed-partial**   | `deleteProduct` now nulls PII atomically. No `scheduled()` handler — see §8 item 2                                                                           |
| R12-01 | `redactPayload()` fails OPEN when the active catalog is null or changed                        | `packages/worker/src/admin/lib/redact.ts:33-41`                                  | **Fixed** †         | `describe("R12-01 redactPayload now fails CLOSED without a catalog")` ×4; marker `redact.ts:37`                                                              |
| R12-05 | Magic-link token has only 72 bits of entropy                                                   | `packages/worker/src/portal/auth.ts:348`; `crypto.ts:42-44`                      | **Reported**        | `it("CONFIRMED: the magic token carries only 72 bits of entropy (randomId = 9 bytes)")`                                                                      |
| R12-06 | `KEY_HASH_PEPPER` optional; silent degradation to unsalted SHA-256                             | `packages/worker/src/crypto.ts:74-76`; `env.ts:19`                               | **Reported**        | `describe("R12-05 KEY_HASH_PEPPER silently optional")` ×2                                                                                                    |
| R12-08 | Credentials travel in query strings + Workers Logs persist at 100%                             | `packages/worker/wrangler.toml:11-15`                                            | **Reported**        | `it("CONFIRMED: Workers Logs persist invocation metadata at 100% sampling")`                                                                                 |
| R12-09 | PRIVACY.md omits `devices.ua`, client IP, and all non-device retention                         | `docs/PRIVACY.md:29-64` vs `packages/worker/src/licensing.ts:74`                 | **Reported**        | `describe("R12-06 device User-Agent is collected, stored and re-served")`                                                                                    |
| R12-10 | No retention bound and no data-subject deletion path for portal/audit PII                      | `packages/worker/src/index.ts:75`; `portal/api.ts:585-638`                       | **Fixed-partial** † | `0015_data_integrity.sql:49`, `0016_drop_dead_pii.sql`. No `DELETE /api/me`, no cron                                                                         |
| R12-11 | Delivered `payload.secrets` never reach the OS keyring, contra the protocol contract           | `packages/shared-protocol/src/index.ts:40-42` vs `sdk-node/src/store.ts:203-205` | **Reported**        | Verified by read                                                                                                                                             |
| R12-12 | Facts telemetry is unconditional and cannot be disabled; Swift silently sends none             | `packages/sdk-node/src/client.ts:591`; `facts.ts:86-116`                         | **Reported**        | Verified by read                                                                                                                                             |
| R12-13 | License key is a positional argv in five CLI entry points                                      | `packages/sdk-node/src/cli/commander.ts:74-79` (+4)                              | **Fixed-partial** † | Python side fixed (`cli/core.py:115` and the three front ends); Node CLIs unchanged                                                                          |

† Divergences in this group are the same three classes as §3.2: R5/R7/R9/R12 documents that predate
or omit their remediation. R10-06/R10-07/R10-13 were closed by other lanes' rate limits and indexes,
not by the R10 lane.

### 3.4 Low (53)

| ID     | Title                                                                                             | Where                                                              | Status              | Proof                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-03  | State-changing `GET`s bypass the CSRF gate                                                        | `packages/worker/src/admin/lib/respond.ts:57-60`                   | **Fixed-partial**   | `R1-03a`. Admin fixed; portal `GET /logout` mitigated via Fetch Metadata only                                                                                              |
| R1-04  | Audit-write amplification on the cross-product 403 path                                           | `packages/worker/src/admin/api.ts:68-82`                           | **Fixed**           | `R1-04a`, `R1-04b`                                                                                                                                                         |
| R1-06  | `/manage/*` asset proxy unauthenticated, escapes its prefix, strips the CSP                       | `packages/worker/src/admin/index.ts:48-52`                         | **Fixed**           | `R1-06b`, `R1-06c`; fix `isSafeAssetPath` rejects any path containing `%`                                                                                                  |
| R1-08  | Admin cookie has no `__Host-` prefix; first-match cookie parsing                                  | `packages/worker/src/admin/session.ts:178-185`                     | **Fixed**           | `R1-08a`, `R1-08b`. **Note: `Path=/manage` had to be dropped, invalidating pre-deploy sessions**                                                                           |
| R2-12  | `randomId()` is 72 bits and backs magic links, CSRF, and all typed ids                            | `packages/worker/src/crypto.ts:42-44`                              | **Reported**        | Code-traced                                                                                                                                                                |
| R2-13  | Device-flow `userCode` is a case-folded prefix of `deviceCode`                                    | `packages/worker/src/oidc.ts:198-203`                              | **Reported**        | Code-traced                                                                                                                                                                |
| R2-14  | CSRF checks use `!==` while session HMACs correctly use `safeEqual`                               | `packages/worker/src/browserSession.ts:304`                        | **Reported**        | Code-traced. The lane states plainly: "I am **not** inflating this to a real vulnerability"                                                                                |
| R2-15  | Edge-mint: no RSA modulus assertion; EdDSA path emits SDK-format JWS under arbitrary `kid`        | `packages/worker/src/edgeMint.ts:227`                              | **Reported**        | Code-traced; hand-rolled DER reviewed, no bug found                                                                                                                        |
| R2-16  | Conformance corpus covers none of R2-04…R2-08                                                     | `tools/sign-corpus.ts:163-565`                                     | **Fixed**           | `conformance/runners/node/corpus.test.ts` — 57 cases                                                                                                                       |
| R2-17  | Unsigned `.well-known/polaris.json` advertises `trust.pinnedKeys`                                 | `packages/sdk-node/src/discovery.ts:16-21`                         | **Reported**        | Code-traced; not a live bypass (`client.ts:148` reads only `opts.trust.pinnedKeys`)                                                                                        |
| R3-11  | No hwid-based seat dedupe: `findFingerprintByHwid` has zero callers                               | `packages/worker/src/repo.ts:1098-1109`                            | **Fixed**           | `it("FIXED (R3-11): one machine holds ONE seat however many device ids it invents")`                                                                                       |
| R3-12  | Entitlement bucket never pruned; stored `deviceLimit`/`channels` self-authoritative               | `packages/worker/src/configDoc.ts:33-55`; `licenseCore.ts:117-140` | **Accepted risk**   | `describe("R3-06 entitlement layer is unpruned and self-authoritative")` ×3 — deferred: changes the meaning of stored production overrides                                 |
| R3-13  | `normalizeChannel`'s unanchored `/^pr-?\d*/` misreads `prod`/`preview` as `pr`                    | `packages/worker/src/gate.ts:105`                                  | **Fixed**           | `it("FIXED (R3-13): ordinary words beginning with \`pr\` are no longer read as the pr channel")`                                                                           |
| R4-09  | Swift `writeSecure` creates the cache at 0644 then chmods, errors swallowed                       | `sdks/swift/Sources/PolarisKey/KeychainStore.swift:184-188`        | **Reported**        | Measured on macOS 26 / Swift 6.3; no test in this suite                                                                                                                    |
| R4-10  | No SDK repairs a pre-existing over-permissive dir; Python's `O_NOFOLLOW` degrades to 0 on Windows | `packages/sdk-node/src/store.ts:138-150`; `store.py:135`           | **Reported**        | Measured                                                                                                                                                                   |
| R4-11  | Node/Python silently downgrade keyring → plaintext file with no caller signal                     | `packages/sdk-node/src/store.ts:232-263`                           | **Reported**        | Static                                                                                                                                                                     |
| R4-12  | Swift discards `SecItemAdd`/`SecItemDelete` status; no token fallback                             | `sdks/swift/Sources/PolarisKey/KeychainStore.swift:145`            | **Reported**        | Static                                                                                                                                                                     |
| R4-13  | Python raises `TypeError` out of `refresh()`/`status()` where Node coerces                        | `sdks/python/src/polaris_key/models.py:176-189`                    | **Reported**        | Reproduced traces; no test                                                                                                                                                 |
| R4-14  | React browser adapter applies the `/session` doc with no `aud`/`iss`/`deviceId`/expiry check      | `packages/sdk-react/src/browser/browserAdapter.ts:216-230`         | **Reported**        | Static                                                                                                                                                                     |
| R4-15  | `pollUntilSettled` is an uncancellable infinite loop `dispose()` does not stop                    | `packages/sdk-react/src/desktop/desktopAdapter.ts:159-183`         | **Reported**        | Static                                                                                                                                                                     |
| R4-16  | License key passed as positional argv in all six CLI front ends                                   | `packages/sdk-node/src/cli/commander.ts:74-79`                     | **Fixed-partial** † | Python fixed; Node CLIs unchanged                                                                                                                                          |
| R5-10  | `getPortalDownloadToken` is not product-scoped; `row.product` trusted as scope                    | `packages/worker/src/portal/repo.ts:613-616`                       | **Fixed** †         | `it("a second tenant can no longer hold the same token_hash")`; `idx_release_download_tokens_hash`                                                                         |
| R5-11  | The rate-limit DO never reclaims storage, contradicting its own comment                           | `packages/worker/src/rateLimitDo.ts:5-7`                           | **Fixed** †         | Closed by R10-04b's `alarm()` sweep at `rateLimitDo.ts:93`                                                                                                                 |
| R6-08  | `aarch64` / `amd64` route aliases raise an unhandled `TypeError`                                  | `packages/worker/src/router.ts:51`                                 | **Fixed**           | `R6-release.test.ts:890` (4 cases)                                                                                                                                         |
| R6-09  | `streamAsset`/`fetchTextAsset`: relative `Location` → 500; second hop not redirect-guarded        | `packages/worker/src/release/github.ts:121-132`                    | **Accepted risk**   | `R6-release.test.ts:1152`, `:1186` left green — out of lane; needs a GitHub-chained redirect                                                                               |
| R6-10  | No downgrade/rollback protection on any release surface                                           | `packages/worker/src/release/channels.ts:142-168`                  | **Accepted risk**   | `:1266` left green — needs a migration and an admin surface                                                                                                                |
| R6-11  | Served `origin` is taken from the request Host header                                             | `packages/worker/src/release/index.ts:185`                         | **Accepted risk**   | `:779` marked `// NOT FIXED`. Partially mitigated: `ORIGIN_RE` + `shQuote` prevent shell injection                                                                         |
| R6-12  | Portal `/download/<token>` open redirect + single-use TOCTOU (dormant)                            | `packages/worker/src/portal/api.ts:679-687`                        | **Fixed-partial**   | TOCTOU half fixed by R9-05b/R11-05 (`:1398`); the open redirect (`:1321`) is open and dormant                                                                              |
| R7-09  | Install-script allowlist on a deprecation path, not migrated to `pnpm-workspace.yaml`             | `package.json:26-31`                                               | **Reported**        | Verified: still in `package.json`; `pnpm-workspace.yaml` has only `packages:`. **The pnpm warning is wrong** — 10.33.2 still reads the field, so the control is live today |
| R7-10  | Python SDK: unbounded `cryptography>=41`, `requires-python>=3.9`, no lockfile, no audit in CI     | `sdks/python/pyproject.toml:22`                                    | **Reported**        | OSV batch query — no advisories for the 21 pinned versions                                                                                                                 |
| R7-11  | `products/gen-seed.ts` interpolates "numeric" manifest fields into raw SQL unquoted               | `products/gen-seed.ts:72-77`                                       | **Reported**        | Static; confirmed dev-only (not a turbo task, not in any workflow)                                                                                                         |
| R7-12  | Three JOSE implementations; edge-mint emits two header shapes from one endpoint                   | `packages/worker/src/edgeMint.ts:218-231`                          | **Reported**        | Static. Verifier itself is sound — no alg confusion                                                                                                                        |
| R7-13  | `.husky/pre-commit` has no secret scanning, and no CI job compensates                             | `.husky/pre-commit`                                                | **Reported**        | Static                                                                                                                                                                     |
| R8-03b | `safeReturnTo` permits `/manage` paths in the PRODUCT flow                                        | `packages/worker/src/oidc.ts:205-215`                              | **Reported**        | `R8-oidc.test.ts:719`. Verified: `/manage` guard exists only at `portal/auth.ts:101`                                                                                       |
| R8-06  | Unguarded `JSON.parse` on config columns takes the sign-in path down                              | `packages/worker/src/oidc.ts:265-268`                              | **Fixed**           | `describe("R8-06 unguarded JSON.parse in the sign-in path")` ×4; `parseJsonColumn<T>()`                                                                                    |
| R8-07  | `redirect_uris_json` allowlist fails open when the column is NULL                                 | `packages/worker/src/oidc.ts:223-232`                              | **Accepted risk**   | `R8-oidc.test.ts:1298`. No shipped writer produces NULL (`repo.ts:452` writes `"[]"`)                                                                                      |
| R8-09  | `createRemoteJWKSet` constructed per request in all three verifiers                               | `packages/worker/src/oidc.ts:743-745`                              | **Reported**        | Code-verified; the suite mocks `createRemoteJWKSet` by design                                                                                                              |
| R9-05b | Single-use download token is read-then-write, not compare-and-swap                                | `packages/worker/src/portal/api.ts:649` vs `:678`                  | **Fixed** †         | `R9-injection.test.ts:648`; CAS at `portal/repo.ts:747-753`                                                                                                                |
| R9-06  | `safeReturnTo` allows `/manage` on the product flow, denies it on the portal                      | `packages/worker/src/oidc.ts:205-215` vs `portal/auth.ts:94-105`   | **Reported**        | `R9-injection.test.ts:704`                                                                                                                                                 |
| R9-07  | `stripMarkdown` is not an HTML sanitizer; raw `<script>` reaches `summary`                        | `packages/worker/src/release/changelog.ts:38-45`                   | **Reported**        | `R9-injection.test.ts:773`, `:783`. Latent: no in-repo consumer renders `summary` as HTML                                                                                  |
| R9-12c | Device-verify HTML page ships with no CSP / `X-Frame-Options`                                     | `packages/worker/src/oidc.ts:657-660`                              | **Fixed-partial** † | `R9-injection.test.ts:1002,1016,1025`. Dispatcher backstop covers it; per-page bundle still deferred                                                                       |
| R9-14  | `handleRelease`'s `NotFoundError → 404` mapping never fires (async return-in-`try`)               | `packages/worker/src/release/index.ts:197-259`                     | **Fixed** †         | `R9-injection.test.ts:1113`, `:1136`; fix `return harden(await handler(…))` at `release/index.ts:214-224`                                                                  |
| R9-15  | `linkRepo` scopes the installation-token KV cache by repo name, not product slug                  | `packages/worker/src/release/linkRepo.ts:123`                      | **Reported**        | `R9-injection.test.ts:932`                                                                                                                                                 |
| R10-14 | Admin API 403s write a D1 audit row, unmetered                                                    | `packages/worker/src/admin/api.ts:68-82`                           | **Fixed** †         | Closed by R1-04's budget                                                                                                                                                   |
| R10-15 | Unbounded `.sig` asset read inlined into the appcast XML                                          | `packages/worker/src/release/github.ts:200-222`                    | **Fixed** †         | Closed incidentally by R6-03's 256 MiB cap at `release/github.ts:283`                                                                                                      |
| R10-16 | No JWS _header_ size cap in any implementation (SDK-side)                                         | `packages/shared-jws/src/index.ts:143-152`                         | **Fixed** †         | Duplicate of R2-04                                                                                                                                                         |
| R11-10 | No `(product, license_id, status)` index — the seat count scans the device set                    | `packages/worker/src/repo.ts:918-922`                              | **Fixed**           | `idx_devices_license_status` in `0015_data_integrity.sql`                                                                                                                  |
| R11-11 | `SqliteDb` vs `D1Db` divergences: empty `batch()`, `ArrayBuffer` params, `r.results ?? []`        | `packages/worker/src/db/d1.ts:16-18`                               | **Accepted risk**   | Would change every hot-path read. `runChanges` uses `r.meta?.changes ?? 0`, which fails closed                                                                             |
| R11-12 | `getPortalDownloadToken` breaks the "every query is product-scoped" invariant                     | `packages/worker/src/portal/repo.ts:613-616`                       | **Fixed**           | `idx_release_download_tokens_hash` makes `token_hash` globally unique                                                                                                      |
| R12-14 | Licensee name + email printed to stdout by `status`                                               | `packages/sdk-node/src/cli/commands.ts:120-122`                    | **Reported**        | Verified by read                                                                                                                                                           |
| R12-15 | Prod Cloudflare D1/KV ids committed, contradicting the file's own comment                         | `packages/worker/wrangler.toml:54,58` (comment `:41-43`)           | **Reported**        | `it("CONFIRMED: prod KV + D1 ids are real while staging/dev keep placeholders")`                                                                                           |
| R12-16 | `keys_index.key_hash` served to the end user's browser                                            | `packages/worker/src/portal/api.ts:202-208`                        | **Reported**        | Verified by read                                                                                                                                                           |
| R12-17 | Swift `writeSecure` create-then-chmod race; no `O_NOFOLLOW`                                       | `sdks/swift/Sources/PolarisKey/KeychainStore.swift:195-199`        | **Reported**        | Verified by read                                                                                                                                                           |

### 3.5 Informational (5)

| ID     | Title                                                                           | Where                                                        | Status            | Proof                                                                                                    |
| ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------- |
| R6-13  | Latent CDATA breakout in `renderAppcast` `descriptionHtml`                      | `packages/worker/src/release/appcast.ts:65-67`               | **Accepted risk** | `R6-release.test.ts:1236` left green — one-line fix, but unreachable and flipping it churns another lane |
| R6-14  | Push `commits[]` truncation makes `.pkey` change detection lossy                | `packages/worker/src/githubWebhook.ts:68-81`                 | **Accepted risk** | No test. Fails closed (stale, not poisoned)                                                              |
| R9-08  | Appcast CDATA has no `]]>` neutralization                                       | `packages/worker/src/release/appcast.ts:64-67`               | **Reported**      | `R9-injection.test.ts:793`, `:813` (the second proves unreachability)                                    |
| R10-17 | GitHub-controlled sleep (≤5.25 s) inside the request path                       | `packages/worker/src/release/githubApp.ts:169-183`           | **Reported**      | "Noted, not a finding to fix on its own"                                                                 |
| R11-13 | `customers` and `identity` are dead PII-bearing schema with no reader or writer | `packages/worker/migrations/0007_backend_contracts.sql:6-31` | **Fixed**         | Grep-proven; `0016_drop_dead_pii.sql` drops both tables                                                  |

### 3.6 Refuted — kept on the record

**115 hypotheses were refuted**, using each lane's own stated count. This section exists because
"we checked X and it is fine" is load-bearing: it tells you which properties you may rely on, and
it is the part of an audit that a reader cannot reconstruct from a list of hits.

| Lane      | Refuted (lane's count) | Enumerated entries  | Note                                                                            |
| --------- | ---------------------- | ------------------- | ------------------------------------------------------------------------------- |
| R1        | 17                     | 17                  | Plus 4 further "checked and fine" statements outside the table                  |
| R2        | 9                      | 9                   | Plus 9 more items "verified sound and not reported"                             |
| R3        | 8                      | 8                   |                                                                                 |
| R4        | 9                      | 9                   | Plus 9 items classed INHERENT (not findings)                                    |
| R5        | 6 (seeded)             | 10 (`RF-1`…`RF-10`) | **Discrepancy** — header counts seeded hypotheses only                          |
| R6        | 8                      | 8                   |                                                                                 |
| R7        | 9                      | 10                  | **Discrepancy** — two entries are confirmations filed under the refuted heading |
| R8        | 10                     | 10                  | Only 6 have dedicated `REFUTED:` tests                                          |
| R9        | 5 (seeded)             | 6 (`RF-1`…`RF-6`)   | **Discrepancy** — `RF-6` is half of a hypothesis whose other half became R9-06  |
| R10       | 11                     | 11                  | 3 of the 11 are _confirmations_ filed for bookkeeping                           |
| R11       | 11                     | 11                  |                                                                                 |
| R12       | 12                     | 12                  | Preamble claims 9 have standing assertions; the PoC file has 6                  |
| **Total** | **115**                | **120**             | Both numbers are correct under their own definition                             |

The load-bearing refutations — the ones that should change how you read the rest of this report —
are narrated in §6.

Cross-cutting properties that were attacked and **held**, worth knowing you can rely on:

- **Algorithm downgrade is blocked in all three SDKs.** `packages/shared-jws/src/index.ts:158`,
  `verify.py:100-102`, `JWSVerifier.swift:52-54`. `none`, `HS256` and `ES256` are all rejected.
  There is no `none`, no JWK-in-header, no algorithm negotiation.
- **AES-GCM construction is sound.** 12 fresh random bytes per seal (`keyvault.ts:93-94`); AAD binds
  `pkey:v2:<product>:<kind>:<id>` (`:59-63`); `importKek` rejects non-32-byte KEKs (`:73-75`).
- **Session-cookie HMAC comparison is constant-time** (`admin/session.ts:70-75`,
  `portal/session.ts:53-58`), and `hashKey` is a sound HMAC-SHA-256 (`crypto.ts:75-90`).
- **PKCE, nonce binding and the asymmetric-alg allowlist all hold** in the OIDC flow
  (`oidc.ts:754-757`, `oidc.ts:36`), and the confidential-client path fails closed
  (`oidc.ts:141-156`).
- **`clientIp` cannot be spoofed.** `rateLimit.ts:44-46` reads `cf-connecting-ip` only and
  explicitly refuses to fall back to `x-forwarded-for`.
- **No SQL injection exists.** Both dynamic-`SET` builders (`admin/repo.ts:35-49`, `:152-166`) are
  driven by hardcoded literal keys with bound values; a PoC round-trips
  `x'); DROP TABLE products; --` intact. Only string interpolation anywhere in `src/` is generated
  `?` placeholders at `portal/repo.ts:536`.
- **No prototype pollution.** Both `parseYaml` and the `JSON.parse` fast path
  (`shared-manifest/src/index.ts:965`) create `__proto__` as an ordinary own data property.
- **YAML alias bombs are blocked** by `yaml@2.9.0`'s default `maxAliasCount`, and deep nesting
  throws a catchable `YAMLParseError` that both call sites wrap.
- **Ajv did not resolve remote `$ref`s**, so schema-driven SSRF was never reachable.
- **The lockfile is clean.** 608 resolutions, 608 `sha512` integrity hashes, zero git/tarball/
  directory resolutions, zero non-`registry.npmjs.org` registries.
- **No secrets in git history.** `git log --all -p` grep returns only material still in the working
  tree; no `.env`/`.dev.vars`/`.pem`/`.key`/`.p12` was ever tracked.
- **No `console.*` anywhere in `packages/worker/src`** — verified by exhaustive recursive walk.
- **Fork PRs are safe.** `ci.yml:6` is `pull_request`, not `pull_request_target`.
- **Server-side revocation works correctly.** See §6.

---

## 4. The five release blockers

Four of these are filed Critical by their lane. The fifth (R2-02) is filed High and is elevated
here for the reason given in §3.1. All five are fixed; all five would have blocked a release.

### R6-01 — `install.sh` RCE via a repo-controlled `binary_name`

**What it was.** `packages/shared-manifest/src/index.ts:752` read `binaryName` out of a linked
repository's `.pkey/release.{json,yaml,yml}` as `String(rel.binaryName ?? "")` — no character class,
no length cap, no validation of any kind. `packages/worker/src/release/resync.ts:202-215` wrote it
into `release_config.binary_name` on every webhook-triggered resync.
`packages/worker/src/release/install.ts:46-143` then interpolated it into a JavaScript template
literal at **13 sites**, including the top comment (`:49`), the three `case` arms (`:68-71`), the
unconditional `URL=` assignment (`:92`) and the `mktemp` template (`:106`), and
`release/index.ts:387-408` served the result as `text/x-shellscript` from a
`metadata_access: public` endpoint the product's own documentation tells users to pipe to `sh`.

**How it was proven.** Two independent vectors. A newline in `binaryName` places arbitrary shell on
its own line _above_ `set -eu`, where it runs unconditionally — no quote breakout needed. A double
quote breaks out of the `URL=` assignment and out of every `case` arm.
`R6-release.test.ts:344,371` demonstrate each; `:394` demonstrates the whole chain end to end —
a `push` event to `.pkey/release.json`, through `handleGithubWebhook`
(`packages/worker/src/githubWebhook.ts:96`) and `resyncRepo`, to a poisoned `GET /acme/install.sh`.

**Who has to be compromised.** One repo contributor. One leaked PAT with `contents:write`. One
maintainer account. **No Polaris Key admin involvement is required after the initial link.** Blast
radius is the entire install base of that product, at the privilege of the invoking user, and
`install.sh` targets `/usr/local/bin` when writable.

**What it took to fix.** Three layers, because one was not enough. (1) _Ingest_: a `releaseString()`
validator in `packages/shared-manifest/src/index.ts` requiring
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and **rejecting the whole manifest rather than coercing** — the
same treatment extended to `ghOwner`, `ghRepo`, `channelWorkflow`, `betaBranch`, `summaryMarker`
and `sparkleEd25519Pub`, several of which were also being interpolated unencoded into
`api.github.com` paths. (2) _Render_: a real POSIX `shQuote()` and a `validateInstallContext()` in
`release/install.ts`; `renderInstallScript()` now returns `null` for anything it cannot prove safe
and `handleInstall` serves a 404. (3) _Persist_: an `isSafeBinaryName()` gate on the `INSERT`/`UPDATE`
in `release/linkRepo.ts` and `release/resync.ts` — necessary because `binaryName` falls back to the
**repo name**, which never passes through the manifest validator. A side effect worth recording:
the WHATWG URL host grammar permits `` ` `` and `$`, so a hostile `Host` header could previously
have injected a command substitution into `ORIGIN="…"`. `shQuote` plus `ORIGIN_RE` close that even
though R6-11 itself remains unfixed.

### R8-01 — `/auth/poll` minted a device token for an attacker-chosen device id

**What it was.** `GET /<product>/auth/poll` was an unauthenticated credential-minting oracle keyed
on a value OAuth explicitly defines as non-secret. `pollAuthFlow`
(`packages/worker/src/oidc.ts:823-855`) took `device` straight off the query string and passed it to
`authorizeAndMint(env, db, product, flow.licenseId, deviceId, now)` **without ever comparing it to
`flow.deviceId`** — the exact binding its sibling `POST /auth/device/poll` enforces at `:903-904` —
and it also skipped the `confirmedAt` check. `FlowRecord.deviceId` was populated at `:507`/`:573`
and read once, at `:766-767`, purely to decide whether to merge an enrolled license. It was never an
authorization input.

**How it was proven.** `R8-oidc.test.ts:246` sends only a `state` inside the 600-second flow TTL
and receives `{"status":"ready","token":"pkeyt_…"}` — a live device token on the victim's license,
bound to a device id the attacker chose. `GET /djdl/config` with that bearer returns 200 and a
JWS-verified `ManagedConfigDoc` carrying the victim's tier, entitlements, provisioned secrets and
identity profile, plus a persistent device seat. `:321` shows the same flow refused with `401` on
`/auth/device/poll` and served a `ready` token on `/auth/poll` seconds later.

`state` is 128 bits, so it is not guessable — but it is non-secret by construction (RFC 6749 §10.12).
It rides on the IdP authorize URL and the callback URL, so it leaks through IdP access logs,
proxies, synced browser history, and the `Referer` from a callback page that set no
`Referrer-Policy` (`oidc.ts:817-820`). More directly, **R8-02 converted any `device_code` into
`state` + `nonce`**: `GET /djdl/auth/device/verify?device_code=…&confirm=1` (`oidc.ts:624-635`) was
an unauthenticated GET that mutated state and returned both in its `Location` header — and the
device code is the value the product is _designed to display to the user_. With zero rate limiting
anywhere in `oidc.ts` (R8-10, `grep -c rateLimit` → 0), this was an unbounded oracle. The endpoint
is not vestigial: it is advertised as `pollUrl` in the public discovery document
(`packages/worker/src/discovery.ts:103`).

**What it took to fix.** Three lines, placed after the `error`/`licenseId` checks so the surface
gained no new distinguishable answer — verified live at `packages/worker/src/oidc.ts:1074-1076`:

```ts
if (!flow.deviceId || flow.deviceId !== deviceId)
  return json({ status: "error" });
if (!flow.confirmedAt) return json({ status: "pending" });
```

`FlowRecord.confirmedAt` is new: device confirmation now stamps the _flow_ record, the one pollers
read. A stated consequence, deliberately accepted: a flow started by `GET /auth/start` without
`return_to` has no `deviceId` and can never complete through `/auth/poll` again. That is the
intended fail-closed direction — a bare `state` must not be a bearer token. The finding's other two
fix directions (a separate high-entropy poll secret; retiring `/auth/poll`) were not taken.

### R2-01 / R4-02 — the cache substituted the key bytes behind a pinned `kid`

**What it was.** The one security property the SDK advertises — _the verifying key is selected by
the header `kid` from a caller-supplied trust set, never from the document_ — was defeated by one
write to a plain JSON file. `packages/sdk-node/src/client.ts:184-186` merged the trust set with the
cache spread **after** the pins, so a `trustedKeys` entry read off disk overrode a `kid` the host
application had compiled into its binary. The same transposition existed in `client.py:188-189` and
`PolarisKeyClient.swift:168-170`. Two lanes reached it independently, from opposite directions:
R2 from the crypto side, R4 from the client-tampering side.

**How it was proven.** `packages/sdk-node/test/R4-client-attack.test.ts` →
`describe("R4-02: trust-set injection via the cache file")` writes an attacker key into
`~/.config/<product>/managed.json` and shows the client verifying and _applying_ a document signed
by that key, served over the network. `R2-trust-attack.test.ts` →
`describe("R2-02 · trust-set poisoning …")` covers the same defect at the trust-merge layer, ×3.
`R4-01` and `R4-03` showed the same file write also bypassed verification entirely (the JWS was
verified once on fetch, then discarded, and the decoded document reloaded with a bare `JSON.parse`)
and pinned forged replay counters. `WIRE-CONTRACT-V2.md:27-30` records the joint conclusion:
these are one defect wearing three hats, and reversing the merge order alone would have been
worthless.

**What it took to fix.** A design change, not a transposition. The persisted record is now v2 and
holds _only signed artifacts_ — `configJws` and `trustJws`, verbatim compact JWS. `doc`,
`trustedKeys`, `lastAcceptedIssuedAt`, `lastTrustIssuedAt` and `lastVerifiedAt` were **deleted from
disk**; every one of them was an unsigned field that a security decision read. On load, `trustJws`
is re-verified against the **pinned keys only**, the config JWS against the resulting set, and all
counters are re-derived from verified content. `mergeTrust()` is `{...discovered, ...pinned}` with
pins terminal, in `packages/sdk-node/src/trust.ts`, `sdks/python/src/polaris_key/trust.py` and
`sdks/swift/Sources/PolarisKey/Trust.swift:106-107` — all three verified present. A `v:1` record is
discarded, not migrated. The design principle is written down at `WIRE-CONTRACT-V2.md:35-38`:
_persist only signed artifacts; derive all security state from re-verified content_ — which removes
a class of bug rather than three instances of it.

One correction found during implementation and recorded rather than worked around
(`WIRE-CONTRACT-V2.md:198-204`): an earlier draft re-checked `expiresAt` on the reload path, which
silently **deleted offline grace** — a cached document is by definition past its one-hour expiry.
Freshness now applies on the network path only, behind an explicit `checkFreshness` flag, pinned by
corpus case `doc-expired-reload-path`.

### R2-02 — a compromised signing key was unrevocable on provisioned clients

**What it was.** Client trust sets only ever grew, and `key.status` was never read
(`packages/sdk-node/src/client.ts:535-547`, status ignored at `:536-540`). The server could stop
publishing a key; no client would notice. Combined with R2-01, a rogue key that reached a manifest
once was trusted **forever** — `THREAT-MODEL.md:146-147` draws the attack tree explicitly.

**How it was proven.** `R2-trust-attack.test.ts` → `describe("R2-03 · no client-side key revocation …")`
×2, and `R4-client-attack.test.ts` → `it("permanently disables trust-key rotation (the key-revocation
mechanism) by poisoning lastTrustIssuedAt")`, which shows the _unsigned counter_ on disk blocking a
genuine revocation while the client is online.

**The important nuance, established by refuting the obvious hypothesis:** the server side was never
broken. `listVerificationProductKeys` (`packages/worker/src/repo.ts:327-336`, filter at `:333`)
selects `status IN ('active','staged','retired')`, excluding `revoked`, and
`packages/worker/migrations/0006_hardening.sql:10` documents that `retired` is included by design.
The defect was entirely client-side. See §6.

**What it took to fix.** `key.status` is now normative (`WIRE-CONTRACT-V2.md:66-81`): `active`,
`staged` and `retired` may verify; `revoked` must not, and must be removed from the trust set _and
from disk_. Pruning is mandatory — after verifying a manifest the trust set becomes exactly
`pinned ∪ {manifest keys whose status ≠ revoked}`, so absence is revocation. A pinned key is never
pruned; pinning is the escape hatch for a total control-plane compromise. Implemented in all three
client languages and pinned by corpus cases `key-status-revoked`, `trust-prune-on-absence` and
`trust-prune-to-pins-only`.

One server-side companion change is **specified but not yet implemented**
(`WIRE-CONTRACT-V2.md:86-91`): revoking by omission makes the client's job impossible, because
absence is indistinguishable from a truncated manifest. The server must emit revoked keys
_explicitly_ with `status:"revoked"` for at least `2 × cacheSeconds`. Until it does, clients rely on
the prune-on-absence rule alone.

### R10-01 — Ajv codegen in workerd would have taken `/config` to 100% down

**What it was.** `packages/shared-catalog/src/catalog.ts:28` constructed `new Ajv(...)` and `:54`
called `ajv.compile()`; Ajv implements compilation with the dynamic `Function` constructor over
generated source text. workerd forbids that inside a request handler. `GET /<product>/config` reaches
it on every poll: `licenseCore.ts:157-183` seeds the payload from every catalog `config` entry with
a `default`, `licensing.ts:509-523` constructs a **fresh** `Catalog` inside `handleConfig`, and
`configDoc.ts:45` calls into the validator. The try/catch at `licensing.ts:516-522` converts the
resulting `EvalError` into **HTTP 500 `catalog_unavailable`**. `products/djdl/catalog.json` has 16
such entries. The module's own header at `catalog.ts:3-7` documented the required mitigation — cache
the `Catalog` per product+schemaVersion. It was never implemented; all six non-test construction
sites build a fresh instance inside a request handler.

**How it was proven — and the reason this one matters methodologically.** The original PoC could
not prove it. `packages/worker/vitest.config.ts` sets `environment: "node"`, where
`Function(string)` works; the five cited tests installed a stub to _simulate_ the restriction. A
blue-team verifier was assigned to refute the finding and built scratch workers under `/tmp` driven
by `wrangler 4.104.0 --local`, which runs the genuine workerd binary
(`docs/security/findings/VERIFY-R10-01.md`). Three refutation attempts failed. Real workerd, real
`Catalog`, real djdl catalog:

```
step2_handleConfig_validatePayload: "THREW: EvalError: Code generation from strings disallowed for this context"
simulated_http_status:              "500 catalog_unavailable"
```

Boundary conditions: **one** config key is enough (not a function of catalog size); it recurs on
every request in the same warm isolate (nothing is memoised); and no compatibility date rescues it —
`allow_eval_during_startup` (default from 2025-06-01) permits codegen at module scope only, and
request-phase codegen throws at every compat date from 2024-01-01 to 2026-04-07.

The verification found **two errors in the original filing**. First, the finding's own claim chain
was self-defeating: if every catalog publish 422s, no `schemas` row can exist, the `if (schemaRow)`
guard is skipped and `/config` returns 200. That refutation failed only because R10-01 had
enumerated two of the three publish paths — the third, which `docs/DEPLOYMENT.md` §9 explicitly
prescribes, writes `catalog_json` with no `Catalog` and no `compileAll()` at all
(`release/linkRepo.ts:210-215`, `release/resync.ts:184-194`). The repo-link flow succeeds and
installs an active catalog, after which `/config` 500s on every poll. **This made the bug more
certain, not less** — and surfaced an independent consistency defect: `linkRepo`/`resync` accept
catalogs that `PUT …/schema` and `POST …/products` would reject.

Second, **the finding's primary fix direction did not work.** It recommended caching `Catalog`
instances in module scope. Codegen is legal only during the startup window, and catalogs are read
asynchronously from D1, which is only possible once a request is in flight. A lazily-populated
module-scope map still compiles in request phase; it converts a per-request 500 into a per-isolate 500.

**What it took to fix.** Ajv was removed, not swapped. `@cfworker/json-schema` was explicitly
rejected because it delegates `pattern` to the host `RegExp` and would have shipped the ReDoS the
verification warned about. Two new dependency-free modules: `packages/shared-catalog/src/validate.ts`
(an interpreting validator for the catalog's schema subset, derived empirically by sweeping every
schema fragment in the repo) and `packages/shared-catalog/src/regex.ts` (a Thompson/Pike NFA
simulation for `pattern` — O(instructions × input), no backtracking, with backreferences, lookaround
and `\b` rejected at compile time rather than silently ignored). `packages/shared-catalog/package.json`
now declares `"dependencies": {}`.

**The ReDoS cap had to ship in the same change, not as a follow-up.** `VERIFY-R10-01.md:226-232`
states the sequencing constraint: the server-side `pattern` ReDoS was unreachable _because of_
R10-01, and becomes live the moment an interpreting validator lands. workerd permits
`new RegExp(source)` — that is not "code generation from strings". R10-09 had already proved a
source-length cap is not a guard: `(x+x+)+y` is eight characters, far under `channels.ts`'s
`MAX_REGEX_SOURCE = 80`, and measured **57 s** of pegged CPU against a 34-character input. The caps
that shipped are `MAX_PATTERN_SOURCE = 300`, `MAX_PATTERN_PROGRAM = 2000`, `MAX_PATTERN_REPEAT = 100`,
`MAX_PATTERN_INPUT = 4096` and `MAX_UNIQUE_ITEMS = 1000`, with semantics pinned by a differential
test against the host `RegExp`: 36 patterns × 41 inputs, 1476 comparisons, 0 mismatches. Same
pattern, post-fix: 4 ms.

Verified on real workerd after the fix: `step2` moved to `"OK: 16 config keys survived prune"` and
`simulated_http_status` to `"200 OK"`, while `request_dynamic_function` and `request_eval` **still
throw** — proving the test harness is not accidentally permissive.

**Two behaviour changes worth knowing about.** Unknown JSON Schema keywords now fail closed, where
Ajv's `strict: false` silently ignored them. And `format: "uri"` no longer uses ajv-formats'
RFC-3986 regex. All 20 pre-existing `catalog.test.ts` assertions pass unmodified.

---

## 5. Notable chains

Two findings that compose into something materially worse than either alone.

### Chain 1 — repo contributor → full platform admin

**R6-04 + R1-09.**

`packages/worker/src/release/github.ts:145-157` copied a fixed allowlist of upstream headers
verbatim when streaming a release artifact:

```ts
for (const h of ["Content-Type","Content-Length","Content-Range",
                 "Accept-Ranges","ETag","Last-Modified"]) { … }
```

The allowlist **copied the dangerous header and dropped the protective one** —
`Content-Disposition: attachment`, which GitHub sets on release-asset downloads, was discarded.
`release/index.ts:516-520` then added only `cache-control`: no `x-content-type-options`, no CSP, no
`x-frame-options`. `securityHeaders.ts` was applied to no release response at all.

A release asset's `content_type` is chosen by the uploader. Upload `acme-arm64` with
`content_type: text/html` and the platform serves attacker HTML from `https://key.plrs.im`.

That origin is shared. `packages/worker/wrangler.toml:47-49` declares a single custom domain, so the
admin SPA at `/manage`, the customer portal at `/`, and every product's licensing API all live
there. R1-09 is the observation that **any same-origin script execution defeats the entire admin
cookie hardening story**: `packages/worker/src/admin/session.ts:1-19` explicitly relies on "the API
is same-origin only", which is what makes the `X-PKey-CSRF` double-submit design safe. Same-origin
JavaScript reads the CSRF token and issues authenticated admin API calls with the operator's cookie
attached.

The full chain: **one contributor to any linked repo → an uploaded release asset with
`content_type: text/html` → script execution on `key.plrs.im` → the admin CSRF token → the admin
API → every tenant.** Cross-tenant, because product B's repo owner gets script execution in product
A's admin's browser. And per `THREAT-MODEL.md:20-22`, the admin plane reaches all three of the
licensing system, the remote-configuration system and the release channel at once — so the terminal
state of this chain is arbitrary code shipped to every installed client of every product.

The only thing that made it awkward rather than trivial was `SameSite=Strict`, which forces a
top-level navigation rather than a third-party iframe — but the missing `x-frame-options` meant the
response was framable anyway.

**Both ends are fixed.** `streamAsset` now takes a required `StreamAssetOptions`; `Content-Type` is
removed from the relay allowlist and set from the gateway's own allowlist
(`application/octet-stream`, `application/x-apple-diskimage`); `Content-Disposition: attachment` is
always sent with a `sanitizeFilename()`'d name; `nosniff` is always set. Separately —
and this is the part that makes it a property rather than a convention — `securityHeaders.ts` now
exports `secureResponse(res)`, applied to **every** response in `index.ts`, so "no CSP-less HTML on
this origin" is a dispatcher guarantee. `handleRelease` additionally wraps every return in
`harden()`. Proven by `R6-release.test.ts:722` and `:802`.

### Chain 2 — one repo push → a poisoned installer on every machine

**R6-05 + R6-01, with R6-06 as a persistence primitive.**

R6-01 needs a `.pkey/` change to land. R6-05 supplied the delivery: webhook resync applied `.pkey/`
from an attacker-supplied `ref`, behind a **self-attested** branch gate —
`packages/worker/src/githubWebhook.ts:171` passed `payload.after` straight through to `?ref=`, so a
PR head, an unreviewed branch or an old SHA all resynced as though they were the default branch.
R6-06 added durability: with no replay protection, one captured delivery was a permanent
state-rollback primitive that re-ran the full destructive resync and reverted operator edits
(`R6-release.test.ts:1009`). The composite is: land a commit on any branch → point a resync at it →
own `install.sh` → and keep re-owning it by replaying the delivery after each operator repair.

Fixed at all three points: `resyncRepo()`'s `ref` parameter was **deleted** (it now always reads the
default branch), `payload.installation.id` is now bound against `release_config.gh_installation_id`,
`X-GitHub-Delivery` is required and KV-deduped for 7 days, and R6-01's three validation layers stop
the payload regardless.

**What remains.** The largest item on this surface is deliberately open, with its PoC left green and
marked `// NOT FIXED`: `R6-release.test.ts:1090`
`it("a webhook push rewrites OIDC issuer/clientId, tiers, and admin_group from the repo")`.
Splitting `.pkey/` into "repo may own" versus "admin only" — `oidc`, `metadata_access`,
`artifacts_access`, `admin_group` — with an approval step is a design decision, not a patch. Note
that `admin_group` is currently inert for authorization (`admin/authz.ts:21-27` ignores it and
returns `isPlatformAdmin()`), which is the only reason this is Medium rather than High. It becomes
High the day product-level RBAC ships.

### A chain that does _not_ exist, and why that matters

`resync.ts:86-91` re-derives `owner`/`repo` from the product's own `release_config` rather than from
the webhook payload, `repo.ts:263-279` matches case-insensitively on the stored coordinates, and
`resync.ts:134-139` rejects a manifest whose `product.slug` mismatches. So a forged webhook payload
**cannot** make product A resync from product B's repo. The only attacker-controlled residue was the
`ref`, which is R6-05. Had that not held, R6-05 + R6-01 would have been a one-secret path to RCE on
every product's install base rather than one product's.

---

## 6. What the audit got wrong

A report that only lists hits is not trustworthy. Here is what did not survive contact.

**115 hypotheses were refuted** (§3.6). Several were seeded confidently by the Lead and were simply
wrong.

**H2 — "the GitHub webhook secret is held by repo owners."** False, and the correction changes the
threat model. `GITHUB_WEBHOOK_SECRET` is the **GitHub App's** webhook secret, a Worker secret held
only by the platform operator (`docs/DEPLOYMENT.md:136-155`, `docs/RUNBOOK.md:163-165`). Repo owners
install the App; they never receive or configure it. A repo owner cannot forge deliveries for
another tenant. What survived — and it survived as a real finding, not as the hypothesis — is that
one secret covers every installation with no per-installation binding: `payload.installation.id` was
never validated against `release_config.gh_installation_id`, and `githubWebhook.ts:10-21` did not
even model the field. That was folded into R6-05 and is now fixed.

**H1 cross-targeting — "a forged payload can make product A resync from product B's repo."**
Blocked by `resync.ts:86-91`, as described in §5. The related half — "the webhook can rewrite
`admin_group` to take over the product" — is also refuted for now: `resync.ts:152` does write
`products.admin_group`, but `admin/authz.ts:21-27` ignores it entirely. Its only effect today is
which products appear in `GET /manage/api/me`.

**H6 — "unauthenticated stored XSS via `auth_page_template`."** The route is real and the missing
security headers were real, but **no code path writes the column.** The only INSERT hardcodes `NULL`
(`packages/worker/src/repo.ts:591-592`); no admin handler writes it, no manifest field maps to it
(`ManifestEdgeMint` has no `authPage`), no migration seeds it. It is reachable only via direct D1
access. Downgraded from "unauthenticated stored XSS" to "latent sink plus missing headers" and filed
as R9-11 / R1-05 (Medium). The headers were fixed anyway; the sink was not, because there is nothing
to fix. Filed as `RF-4` in R9, not `H6` — the label in the brief does not match the lane's numbering.

**H8 — "portal account linking is identity theft."** It is injection, not extraction. The
distinction is the finding. R5's `RF-1` established that the root portal _does_ check
`email_verified` (`portal/auth.ts:113-128`, `:286`) and that `linkEmail` (`portal/repo.ts:219-228`)
never reassigns an `account_id`, so proving control of an inbox does **not** inherit foreign
licenses. What R5-01 and R5-02 actually showed is the reverse direction: an attacker could inject
_their own_ license into a victim's portal account, via an unverified OIDC email on the product flow
(`oidc.ts:674-681`) joined against an unscoped `SELECT` (`portal/repo.ts:275-278`). The lane states
it plainly: _"R5-01/R5-02 are injection primitives, not extraction primitives."_ The victim sees a
license they do not own; they do not lose one. That is spoofing, phishing surface and existence
disclosure — not data exfiltration. Both are now fixed, but had this been filed as theft the fix
would have been aimed at the wrong query.

**The `retired`/`revoked` "drift" — server-side revocation works correctly.** The seeded hypothesis
was that two spellings in two writers indicated a bug. They do not. `listVerificationProductKeys`
(`packages/worker/src/repo.ts:333`, verified directly) selects
`status IN ('active','staged','retired')`, excluding `revoked`, and
`packages/worker/migrations/0006_hardening.sql:10` says so in as many words: _"Staged and retired
keys can still verify."_ These are two different operations — `retire` means stop signing but keep
verifying, `revoke` means stop both — and `admin/handlers/products.ts:730-731` implements exactly
that distinction. The operational-resilience review reached the same conclusion independently and
put it more sharply: _"That is the finding; fix it with a CHECK constraint, not by unifying the two
writers."_ Which is what happened — R11-07's real defect turned out to be one layer down (no CHECK
constraint on any status column, and no guard against retiring the _active_ key, which bricks the
product because `idx_product_keys_one_active` enforces at-most-one and nothing enforces
at-least-one). If you take one thing from this section: **the revocation defect was entirely
client-side (R2-02). The server was never broken.**

**Other confident hypotheses that failed.** That `auto-install-peers = true` was a supply-chain risk
(all three workflows use `--frozen-lockfile`). That `npx wrangler` in `deploy.yml` fetches from the
network with the Cloudflare token in scope (it resolves to the lockfile-pinned devDependency —
fragile, not vulnerable). That fork PRs run with a write-capable token (`ci.yml:6` is
`pull_request`). That the pnpm `onlyBuiltDependencies` allowlist was inert — it is **live**; the
deprecation warning pnpm emits is wrong for 10.33.2, proven with a scratch package under a clean
`HOME`. That `clientIp` could be spoofed. That `hashKey` was a CPU-exhaustion vector. That
`escapeHtml` omitting `'` was exploitable — all 20 call sites were traced and every one passes a
string literal.

### The Lead's own spec had four errors, caught by implementers

`docs/security/WIRE-CONTRACT-V2.md` is normative for five independent implementations. Four of its
clauses were wrong as drafted and are corrected in place rather than quietly worked around, because
four other implementations read the document as authority.

1. **`schemaVersion` must not be allow-listed** (§3.1.1). The draft said "must be a known version,
   unknown ⇒ fail closed." That conflated two unrelated fields: a config doc's `schemaVersion` is
   the _per-product catalog version_ (`packages/worker/src/product.ts:114`), which increments every
   time an operator edits a catalog. An allow-list would have rejected every product that ever
   republished its schema. Caught by the Node SDK implementer.
2. **Freshness must not be re-checked on cache reload** (§3.1.2). Applying `expiresAt`/`issuedAt` on
   the reload path deletes offline grace entirely — the feature the cache exists to provide.
3. **`typ-missing` must be ACCEPTED during rollout** (§3.1.3). §6's case table said reject,
   contradicting §7 step 2 and the reference `verifyJws`. §7 was correct.
4. **The clock-rollback floor as first drafted was inert** (§4.3). The Python engineer showed that
   deriving `highWaterMark` from `configJws` alone is a no-op: with one cached document
   `highWaterMark === doc.issuedAt` by construction, and `graceUntil = issuedAt + maxOfflineDays ×
86400` is always greater, so the floor can never push `effectiveNow` past `graceUntil`. It still
   prevents replaying an _older_ document, so it is not worthless — it simply does not do the job it
   was written for. **This one is corrected in the spec but not in the code.** See §8 item 1.

### Two lane documents overstate the danger; several understate the fix

- R10's own note that server-side `pattern` ReDoS was "currently unreachable because of R10-01" was
  correct and load-bearing, but it means R10-03's and R10-09's severities were being read against a
  system that was already 100% down. Severities in the R10 lane should be read as post-R10-01-fix.
- **Four lane documents are stale relative to the tree.** R5 and R7 have no `## Remediation` section
  and state "no source file was modified"; R9 likewise; R12 has fix _directions_ only. Between them
  they carry 14 findings that are in fact fixed, by adjacent lanes. The register in §3 reports
  verified tree state and marks each divergence with `†`. If you read the lane documents directly,
  do not treat their status as current.
- **Test counts disagree between documents.** R10 reports 656 worker tests, R11 reports 647, R6
  reports 635. All three are true of different mid-remediation snapshots. `BASELINE.md`'s 667 is the
  final number and is the one to use.
- **One citation in `WIRE-CONTRACT-V2.md` is wrong.** §1.2's server-side companion note cites
  `repo.ts:329-331` for `listVerificationProductKeys`; the function is at `repo.ts:327-336` and the
  status filter is at `:333`. The substance is correct; the line numbers are not.

---

## 7. Architecture review synthesis

Four graded lenses. Grades are the reviews' own.

| Lens                      | Grade  | Top recommendation                                                    |
| ------------------------- | ------ | --------------------------------------------------------------------- |
| Anti-piracy realism       | **C−** | Propagate the trust boundary to integrators — 2–4 h                   |
| Business-model fit        | **C**  | Write down whether this is a product or personal infrastructure — 1 d |
| Multi-tenant blast radius | **C−** | KEK keyring + lazy re-seal — 1–2 d                                    |
| Operational resilience    | **D+** | Ship the dual-KEK keyring — 0.5 d                                     |

### Anti-piracy realism — C−

Per-question: trust boundary documented **D**; fingerprint machinery earns its cost **C−**; offline
grace design **D**; what the client gate promises **C**; comparison to mature systems **C+**.

The server side is right. The client side is built as though it were enforcement, is not, and nobody
wrote that down where an adopter would see it. The review's sharpest observation: _"the privacy
engineering around fingerprinting is better than the enforcement engineering it exists to serve.
That is an unusual and telling inversion."_ Fingerprinting is checked once, at activation, and never
joined again — privacy-excellent, enforcement-useless.

On what piracy resistance the design actually buys, the review is blunt. Against someone who can
patch the binary: _"Nothing. And that is the correct answer — it is not what the fix is for."_
Against casual sharing: everything, for about a day of work. _"That is an excellent ratio, and it is
the correct reason to do it — not because it makes the system 'secure.'"_ At the time of review the
design reached **tier 1 only** — honest-mistake correctness — because tier 2 _is_ the pasted-JSON
case and R4-01 was that attack, passing. R4-01 is now fixed, which moves it to tier 2.

The comparison that should sting: _"Adobe re-checks every 30 days and then grants up to 99 more.
Polaris Key grants 30 days and re-checks never. Measured as 'maximum time a revoked license keeps
working without contacting the server,' Polaris Key's default is more permissive than Adobe's,
despite looking stricter on paper."_

Top recommendation, ranked #1 explicitly because _"it prevents wrong decisions"_: add the asset
table and the enforcement-versus-presentation guidance to `ADOPTER-GUIDE.md`, fix `CONCEPTS.md:65`,
and resolve the contradiction in `THREAT-MODEL.md` §6. `SECURITY.md` and `THREAT-MODEL.md` now exist
and address most of this; `ADOPTER-GUIDE.md` and `CONCEPTS.md` do not yet.

### Business-model fit — C

Per-question: model coherence **C+**; free tier farmable **D+**; enforcement effort vs revenue at
risk **D**; offline-grace default **C−**; what it is selling **C**; competitive standing **C+**.

**The verdict, in the review's own words:** _"Is the licensing strategy sound? No — but not for the
reason the code review lane would suggest. The strategy is unsound because there is no strategy:
there is a well-built enforcement engine attached to a product that is given away to family and
friends, with no price, no biller, no second tier, and no written statement of who is ever expected
to pay."_ And: _"Revenue at risk today: zero. Not 'small' — zero. There is no mechanism by which any
human gives this system money."_

The measurements behind that: exactly one product registered (`products/` contains only `djdl/`);
that product has exactly **one tier**, `standard`, no expiry, 5 devices
(`products/djdl/product.json:20-28`), granted to the IdP groups `family` and `friends`
(`:14-18`); no billing, subscription, payment, invoice, price or trial-conversion code exists
anywhere in the tree; **no `LICENSE` file**, so the tree is strictly all-rights-reserved and
unadoptable; every package is `0.0.0` and nothing is published. Against that: **~47,400 lines of
source** and ~32,400 lines of tests, five languages, 43 distinct route kinds, 37 commits in nine
weeks. (Measured today, post-remediation, the non-test tree is 51,491 lines — the +8,079 insertions
this audit produced.)

The D on proportionality is explicitly a _ratio_ grade: _"the numerator is large while the
denominator is zero… It is emphatically not a code-quality grade — on quality alone this tree earns
a B."_ The free-tier farming question resolves the same way: `djdl` has one tier, so _"the free tier
and the paid tier would be the same tier… there is nothing to farm past."_

The most useful sentence in the review: **this platform's real product is signed managed
configuration and release delivery; licensing is the authorization layer for those two, and it has
been mistaken for the main event.** The evidence is that all three of the most recent feature
commits are licensing features — `ada5961` fingerprinting, `415dff8` auto-issue, `bd26e0b`
re-licensing — shipped to a product with zero revenue. And on being ahead of the market: _"When you
are ahead of the market leader on a mechanism the market leader chose not to build, the first
hypothesis should be that they were right."_

Highest return-on-effort item named anywhere in the four reviews: fix the 304 freshness bug (R2-11).
_"The product tells correctly-functioning paying customers that they are running in offline grace
mode, and tells them the wrong 'last verified' date, forever."_ That one is now fixed.

### Multi-tenant blast radius — C−

Per-question: compromise matrix **D**; one KEK for all tenants **D+**; shared-Worker/shared-D1
model **C** first-party / **F** untrusted tenant; isolation invariants that do exist **B+**; the two
locked decisions **B** / **C+**.

_"Polaris Key is a single-trust-domain system wearing multi-tenant clothing."_ Six of the seven
compromises in its matrix are total-platform events, because every control-plane credential is
singular: one KEK, one webhook secret, one GitHub App, one admin group, one session secret, one hash
pepper. _"The architecture is correct for the world it actually lives in today (one first-party
product, `djdl`) and would be negligent for the world its documentation advertises."_

The **B+** is real and should be protected through any refactor: `product` is column 1 of every PK
and index; a sweep of every `SELECT`/`DELETE` in `src/**` found a `product = ?` predicate on every
product-scoped table outside two deliberate portal exceptions and one gap; the keyvault fails closed
with AAD binding; exactly-one-active-signing-key is enforced by a partial unique index
(`0006_hardening.sql:11-13`) rather than by application logic; platform routes match before product
slugs and the slug alphabet `^[a-z0-9-]+$` leaves no traversal or confusable surface;
`test/isolation.test.ts` drives the real Worker and proves a bearer token from product A is rejected
401 at product B.

The review is candid where the reflexive recommendation would be wrong: _"Per-tenant KEKs stored the
same way as the platform KEK are theatre."_ It recommends a keyring plus HKDF-derived per-tenant
DEKs instead. And on the existing `kekId` field: _"worse than useless as it stands: it creates the
appearance of rotation readiness."_

Two items it raises that no lane covered: **there is no pre-production environment at all** —
`staging` and `dev` D1/KV ids are `REPLACE_ME_*` (`wrangler.toml:72,76,87,91`), so every migration
and keyvault change runs first against the environment holding all tenant data, called _"the single
most alarming line in the config"_ — and **comments describe a security control that does not
exist**: `admin/api.ts:12-13` and `admin/session.ts:3-4` claim per-product `admin_group` gating.
_"Comments that describe a security control which does not exist are worse than no comments."_

### Operational resilience — D+

Per-question: key-compromise runbooks **F**; dual-KEK rotation **F**; revocation SLA **D** (server
**A**, client **F**); fail-open vs fail-closed **C−**; backup/restore/pre-prod **D−**; detection
**F**.

_"Every failure I traced ends in one of three places: an undifferentiated 500 with no log line, a
misleading 404 with no log line, or a permanent condition. The platform can detect nothing, restore
nothing, and roll back nothing."_

The tell, and the reason this reads as oversight rather than decision: _"the one recovery mechanism
that is properly built — signing-key rotation, with a staged→active soak, a single-active DB index,
and a break-glass override — is excellent. It proves the author knows how to build this."_

The spine is `PLATFORM_KEK`. `keyvault.ts:135-138` accepts exactly one `kekId`, so rotating the KEK
makes every `open()` throw, `loadProduct` return `null` (`product.ts:118`), and **every product route
serve 404 with zero log output** — an outage indistinguishable from "someone deleted all the
products." _"Verdict: unrecoverable. This is the single worst scenario in the system."_ Worse, there
is an undocumented `PLATFORM_KEK_ID` env var (`env.ts:18`, referenced at `keyvault.ts:106,135`) that
appears in no documentation; an operator who finds it and reasonably concludes it is how you rotate
a KEK triggers exactly that outage. The fix — a keyring where acceptance becomes _"the blob's own
kid is present in the ring"_ — is costed at **half a day**, and shipping it is a no-op deploy on the
current secret set.

On backups: D1 Time Travel gives 30 days of point-in-time recovery _"that the operator has not
earned, does not know about, and has never tested."_ Nothing else has any backup. **If
`PLATFORM_KEK` is lost — not leaked, lost — every sealed value in D1 is permanently undecryptable,
and a D1 backup does not help.** The restore path has four sharp edges (the 10 GB / 5 GiB arithmetic
does not close; `BEGIN TRANSACTION` must be stripped; 100 KB max statement length; foreign keys need
import ordering), none discoverable during an incident. Two further traps: a running D1 export
_blocks other database requests_, so a badly-timed backup is a licensing outage; and
`wrangler rollback` silently un-rotates secrets, because secrets are bindings captured in a version.

Three findings here are genuinely new. **The production deploy smoke check cannot fail** —
`deploy.yml:60-66` curls `/manage`, a static asset with no D1/KV/DO access. **The disaster-recovery
path is already blocked** — `wrangler.toml:32-34` declares `RateLimitDO` with `new_classes`, the
KV-backed form Cloudflare no longer permits accounts to create, so "redeploy into a clean Cloudflare
account" fails on the DO migration. And **logs may not be ingesting at all**: `wrangler.toml:7-8`
sets `observability.enabled = false` while `:11-12` sets `observability.logs.enabled = true`, with
undocumented precedence — _"a five-minute check in the dashboard… and it gates everything in §6."_

Two operational bugs worth surfacing because they turn recoveries into second incidents: a 429 on
`/token` is conflated with revocation, so a NAT'd office tripping the 30/min IP cap makes _every
device behind that IP display "revoked"_; and a D1 restore makes devices created after the restore
point vanish, producing the same display. Both are called _"a live bug, not a hypothesis."_

**Where the reviews disagree.** Anti-piracy grades offline grace **D** on security grounds;
business-model-fit grades it **C−** and concludes 30 days is defensible. Operational resilience
would prefer 7, conceding _"if the owner disagrees, 14 is a defensible compromise. 30 is not."_
Both KEK recommendations are the same change costed differently (1–2 days vs half a day). All four
reviews converge on the KEK keyring and on standing up staging.

---

## 8. Residual risk and follow-ups, ranked

Ranked by _what breaks if you ignore it_, not by CVSS.

**1. Clock-rollback protection is specified but NOT implemented.** This is the item most likely to
be believed done when it is not. `WIRE-CONTRACT-V2.md` §4.3 mandates
`effectiveNow = max(systemClock, highWaterMark)`. The clause as first drafted derived
`highWaterMark` from `configJws` alone, and that is **inert**: with one cached document
`highWaterMark === doc.issuedAt` by construction, and `graceUntil = issuedAt + maxOfflineDays ×
86400` is always greater, so the floor can never push `effectiveNow` past `graceUntil`. Rolling the
clock back still extends grace indefinitely — precisely the attack (R4-04) the clause exists to
stop. The correct design raises the mark from the **trust manifest's** `issuedAt` as well:
`highWaterMark = max(verifiedConfigDoc.issuedAt, verifiedTrustManifest.issuedAt)`, which works
because `trustRefresh` is on by default and advances independently of the config document. The
Python engineer implemented it, then reverted to stay in lockstep with Node rather than let one of
five implementations diverge on a shared contract — the right call. Landing it means re-opening all
four SDKs plus the corpus. **Until it lands, treat clock-rollback protection as absent, not merely
weak, and do not claim it in user-facing documentation.** (`WIRE-CONTRACT-V2.md:252-276`.)

> **Correction, 2026-08-27 — item 1 is CLOSED.** The paragraph above is kept as written because it
> is the finding of record, but it no longer describes the code. Clock-rollback protection shipped
> in `6e7cad0` and was carried into wire contract v3 §4.2: `highWaterMark` folds over the WHOLE
> verified artifact set — license document, config document and trust manifest — rather than one
> document, and Core refreshes trust on its own schedule so the mark advances for any service mix
> (`packages/client-core/src/clock.ts`, mirrored in the Python and Swift cores). The defective
> single-document form is pinned as a corpus vector,
> `floor-config-doc-alone-does-not-stop-rollback`, so it cannot return silently. The rest of §8
> stands as ranked.

**2. There is no `scheduled()` handler.** Verified: `packages/worker/src/index.ts` exports `fetch`
only, and `packages/worker/wrangler.toml` declares no `[triggers]` / `crons`. There is no cron, no
queue and no DO alarm outside the rate limiter, so there is nowhere to hang a sweep, a backup or a
reconciliation job. Consequences already filed: `audit` and `portal_audit` grow without bound
(R11-09); `release_download_tokens` retention is opportunistic-on-read only
(`portal/repo.ts:759-764` says so in a comment); there is no `DELETE /api/me` and _"right-to-erasure
is structurally unimplementable in the current schema"_ (R11, R12-10); and the KEK reseal sweep in
§7 has to be an explicit admin endpoint rather than a background job. Adding the handler is small;
everything queued behind it is not.

**3. `PLATFORM_KEK` cannot be rotated.** R2-09 / R5-04, and the spine of the operational-resilience
review. `keyvault.ts:135-138` hard-equality-checks a single `kekId`. Both arch reviews independently
rank the keyring fix #1. Costed at 0.5–2 days. Related and cheaper: escrow `PLATFORM_KEK` and
`KEY_HASH_PEPPER` off-platform (1 hour), and either delete `PLATFORM_KEK_ID` or document it
(15 minutes) — as it stands it is a loaded gun that produces a silent total outage.

**4. `packages/admin/src/SchemaForm.tsx:66-70` is the last uncapped `new RegExp` in the repo.**
Verified: the construction is at `SchemaForm.tsx:68`, `!new RegExp(schema.pattern).test(s)`. Note
the path — `packages/admin/src/SchemaForm.tsx`, not `src/views/`. The other two remaining `RegExp`
sites are safe: `release/channels.ts:85` anchors and length-caps its source, and
`release/changelog.ts:60` escapes its only interpolated token. With `@polaris-key/catalog` now
interpreting patterns on a linear-time NFA the worker is safe, but the admin SPA still hands the raw
`pattern` to the JavaScript engine, so a catastrophic pattern hangs the operator's browser tab. The
injection route is mostly closed — `compileAll()` now screens `linkRepo`/`resync` — so residual risk
is a catalog installed before that change. Fix: route through `compileLinearPattern`, exported from
`@polaris-key/catalog`. Low severity, ~5 lines, and it is the only one left.

**5. There is no `@cloudflare/vitest-pool-workers` lane.** Verified absent from every
`package.json`. `packages/worker/vitest.config.ts` still sets `environment: "node"`. This is the
control gap that let R10-01 sit in `main` across 37 commits with a green suite, and it makes every
other lane's worker results conditional. The R10 lane recommended it and deliberately did not add it
unilaterally. Minimum viable alternative: a `wrangler dev --local` smoke test covering
`GET /<product>/config` in CI.

**6. Foreign keys.** Every FK in the schema references `products(slug)` and nothing else, and **not
one declares `ON DELETE` or `ON UPDATE`** — every reference is `NO ACTION`, proven by scanning
`sqlite_master`. `keys_index`, `devices`, `identity` and `license_profiles` have no FK to `licenses`
at all, so a `keys_index` row with a `license_id` that never existed inserts cleanly.
`portal_license_links` (`0008_portal.sql:37-46`) references `portal_accounts` and `products` but not
`licenses`, so a link to a nonexistent license persists forever, invisible behind a `JOIN`. And
`tiers.profile_id` (`0001_init.sql:51-61`) is a plain `TEXT` column with no FK — which is why R11-01
existed. The application-level guard is fixed; the schema-level one is not. SQLite cannot add an FK
to an existing table, so this needs a five-table rebuild under `PRAGMA defer_foreign_keys`
(`PRAGMA foreign_keys = off` is not available on D1). Note the related tidy-up: `PRAGMA
foreign_keys = ON` at `0001_init.sql:7`, `0010_fingerprint.sql:10` and `0011_auto_issue.sql:7` is an
effective no-op on D1 and should be deleted rather than relied on.

**7. `_admin` is a single global Durable Object shard.** Filed as R10-04a and explicitly not fixed
(the storage half, R10-04b, was — `rateLimitDo.ts:93` now sweeps). `admin/api.ts:38` declares
`ADMIN_RL_SHARD = "_admin"` and `admin/auth.ts:178` uses it; `_portal` is the same story across
`portal/auth.ts` and `portal/api.ts`. Product-scoped buckets shard correctly per product
(`rateLimit.ts:23`), but these two are literal single objects for the entire platform, so the
throughput ceiling of one DO is the ceiling of every tenant's admin console and customer portal
simultaneously. The buckets themselves are keyed by IP or account, so an attacker cannot lock a
specific user out. `rateLimitDo.ts:19` documents the problem in a comment. Availability only, and
the fix is ~half a day: shard by IP prefix or account hash.

**8. Open High findings, in the order I would take them.** R9-01 (OIDC `client_secret`
exfiltration + SSRF via repo-controlled `oidc.issuer` — verified still open; `isUrl` unchanged at
`shared-manifest/src/index.ts:1177-1185`, and R9-02's open redirect falls with it). R5-03 (GitHub
App installation tokens minted un-scoped — and fix the token cache key _first_, per the arch review,
or the scoping fix is defeated by the shared cache entry). R5-04 (single KEK — same as item 3).
R7-02 (uncapped YAML parse reachable from a push webhook; a `.pkey/` manifest has no legitimate
reason to exceed ~64 KB, and the same cap is needed at `admin/handlers/products.ts:79`). R7-04
(bare-tag deploy trigger with no ancestry check — verified: no `merge-base` guard exists). R3-04
(hardware binding never re-verified on the doc-issuing paths; PoC still green). R10-05
(unauthenticated GitHub-subrequest amplifier — _"a security-update delivery outage, achievable from
one laptop, with no credentials"_). R12-03 (GitHub installation token cached in KV in plaintext).
R12-07 (the Python README pins a committed test keypair as a production trust anchor — a
documentation fix, and the smallest High in the set).

**9. Before the first `v*` tag.** Get one green CI run — R7-01's fix is in the working tree,
uncommitted and unpushed, so the claim "CI passes" is still unproven. Verify that Workers Logs are
actually ingesting. Confirm the `production` environment protection rule out-of-band. Fix the
`new_classes` → `new_sqlite_classes` DO migration _alone_, not alongside other changes, or the
disaster-recovery path stays blocked. And rehearse a D1 restore against a scratch database once —
_"an untested restore is a hypothesis, and this one has four ways to fail that you will not want to
discover at 02:00."_

**10. Deliberately accepted, recorded so they are not mistaken for oversights.** R3-12
(entitlement bucket unpruned — changes the meaning of stored production overrides; wants the owner's
call). R6-09, R6-10, R6-11, R6-13, R6-14 (each with a stated reason in
`R6-release.md:858-868`; R6-10 and R6-11 need features, not patches — R6-12 is listed there too but
its TOCTOU half was fixed by another lane, so it is Fixed-partial in §3.4, not accepted). R8-07 (`redirect_uris_json`
NULL — no shipped writer produces one). R11-11 (`D1Db` divergences — would change every hot-path
read; `runChanges` fails closed). R11-04's full replay-idempotency (a five-table rebuild on D1 with
no wrapping transaction is riskier than the defect). R6-02's residual is worth restating in the
owner's own words: the `.sha256` sidecar _"defends against a GitHub release-asset swap and transport
tampering, not against a Worker or D1 compromise. That residual is called out here rather than
silently claimed as closed."_

**11. Two invalidations to note at deploy time.** R1-08's `__Host-` cookie prefix required dropping
`Path=/manage` (RFC 6265bis requires `__Host-` cookies to be `Path=/`), and both cookie renames
**invalidate every session issued before the deploy**. Since nothing has ever been deployed, this
costs nothing today.

---

## 9. Verification

### Gate table

From `docs/security/findings/BASELINE.md`, which is authoritative. Toolchain: **Node 22**
(`~/.local/share/mise/installs/node/22/bin`) — mandatory, because `better-sqlite3@11.10.0` cannot
build against this machine's default Node 26 and roughly 160 worker tests fail with a misleading
`NODE_MODULE_VERSION 127 vs 147` error.

| Gate              | Command                         | Baseline                | Final                        |
| ----------------- | ------------------------------- | ----------------------- | ---------------------------- |
| JS/TS tests       | `pnpm test`                     | 952 passed, 0 failed    | **1394 passed, 0 failed**    |
| Python            | `.venv/bin/python -m pytest -q` | 126 passed              | **231 passed**               |
| Swift             | `swift test`                    | 80 executed, 0 failures | **120 executed, 0 failures** |
| **Total**         |                                 | **1158**                | **1745**                     |
| Typecheck         | `pnpm typecheck`                | clean                   | **clean (17/17 tasks)**      |
| Lint              | `pnpm lint`                     | clean                   | **clean**                    |
| Conformance drift | `pnpm gen:corpus -- --check`    | no drift                | **no drift (5 artifacts)**   |

Per-package JS/TS movement:

| Package                         | Baseline | Final | Δ    |
| ------------------------------- | -------- | ----- | ---- |
| `@polaris-key/worker`           | 396      | 667   | +271 |
| `@polaris-key/catalog`          | 20       | 110   | +90  |
| `@polaris-key/conformance-node` | 34       | 68    | +34  |
| `@polaris-key/node`             | 133      | 162   | +29  |
| `@polaris-key/jws`              | 29       | 42    | +13  |
| `@polaris-key/manifest`         | 13       | 18    | +5   |
| `@polaris-key/admin`            | 134      | 134   | —    |
| `@polaris-key/react`            | 183      | 183   | —    |
| `@polaris-key/cli`              | 6        | 6     | —    |
| `@polaris-key/tools`            | 4        | 4     | —    |

**Every one of these numbers was produced locally.** CI has never run them. See §1.

### What the +587 tests actually are

The great majority are **inverted proofs of concept**. Each one demonstrated a working attack before
the fix and asserts its failure after, so the suite is now a regression corpus for this audit rather
than a set of assertions written from the fix's point of view. That distinction matters: a test
written after a fix tends to encode the fix's assumptions; a test written by an attacker before the
fix encodes the attack's.

The attack corpus, by file:

| File                                                                                       | Tests         | Lane              |
| ------------------------------------------------------------------------------------------ | ------------- | ----------------- |
| `packages/worker/test/attack/R11-data.test.ts`                                             | 44            | Data layer        |
| `packages/worker/test/attack/R9-injection.test.ts`                                         | 32            | Injection / SSRF  |
| `packages/worker/test/attack/R10-dos.test.ts`                                              | 28            | Denial of service |
| `packages/worker/test/attack/R8-oidc.test.ts`                                              | 28            | OIDC / OAuth      |
| `packages/worker/test/attack/R1-control-plane.test.ts`                                     | 26            | Control plane     |
| `packages/worker/test/attack/R6-release.test.ts`                                           | 26 (29 cases) | Release channel   |
| `packages/worker/test/attack/R12-secrets.test.ts`                                          | 21            | Secrets / privacy |
| `packages/worker/test/attack/R3-licensing.test.ts`                                         | 20            | Licensing         |
| `packages/worker/test/attack/R5-isolation.test.ts`                                         | 16            | Tenant isolation  |
| `packages/shared-jws/src/attack.test.ts`                                                   | 13            | JWS parsing       |
| `packages/sdk-node/test/R2-trust-attack.test.ts`                                           | 10            | Trust set         |
| `packages/sdk-node/test/R4-client-attack.test.ts`                                          | 11            | Client tampering  |
| `sdks/python/tests/test_wire_contract_v2.py`                                               | 69            | Wire contract v2  |
| `sdks/swift/Tests/PolarisKeyTests/{WireContractV2,TrustAndCache,StoreSecurity}Tests.swift` | (part of +40) | Wire contract v2  |

R7 (supply chain) has no attack test file at all — its evidence is scratch-directory probes, and
that is a real coverage gap, not an omission from this table.

The remainder of the +587 is the new interpreting validator and its differential corpus
(`packages/shared-catalog/src/{validate,regex}.test.ts`, +90) and the conformance corpus, which grew
from 22 raw cases to 34 plus two new sections — `docCases` (12, claim validation) and `trustCases`
(10, trust merge and prune) — all executed identically by the Node, Python and Swift runners.
`conformance/corpus/v1/cases.json` grew from 38 KB to 330 KB because `payload-at-cap` carries a real
64 KiB document.

**Nine PoCs are deliberately left green.** They are not failures; each marks a finding accepted as
risk or deferred by design, and each carries a `// NOT FIXED` comment naming the reason. The most
significant is `R6-release.test.ts:1090` — `it("a webhook push rewrites OIDC issuer/clientId, tiers,
and admin_group from the repo")` — which is the largest remaining item on the release surface (§5).
Others: `R4-client-attack.test.ts` `describe("R4-07: desktop bridge …")`, `R3-licensing.test.ts`
`it("an exfiltrated device token works from any machine …")`, `R5-isolation.test.ts` blocks for
R5-06/R5-07/R5-08, and `R6-release.test.ts` `:779`, `:1152`, `:1186`, `:1266`, `:1321`, `:1236`.

Working-tree state at the time of writing: **142 changed paths, 116 tracked files modified,
+8,079 / −1,319 lines, 26 new files**, including five migrations (`0012`–`0016`), three new SDK trust
modules, two new catalog modules, `packages/worker/src/release/sparkle.ts`,
`packages/worker/src/admin/lib/managedSecrets.ts`, and this document. None of it is committed.

---

_Sources: `docs/security/findings/R1`–`R12`, `docs/security/findings/BASELINE.md`,
`docs/security/findings/VERIFY-R10-01.md`, `docs/security/arch/{anti-piracy-realism,
business-model-fit,multi-tenant-blast-radius,operational-resilience}.md`,
`docs/security/THREAT-MODEL.md`, `docs/security/WIRE-CONTRACT-V2.md`, `SECURITY.md`. Claims marked
"verified" were re-derived from source or from `git`/`gh` during the writing of this report; all
others are attributed to the document that made them._
