# R7 — Build-time & dependency supply chain

Red-team lane: CI/CD, publishing, lockfile integrity, developer toolchain. The path by which
an attacker gets code into a release **without touching the Worker**.

Tree audited: worktree `lewd-owl`, HEAD `bd26e0b`, tracked files only.
Toolchain used: Node 22 (`~/.local/share/mise/installs/node/22/bin`), pnpm 10.33.2.
No source, workflow, or config file was modified. All probes ran in `/tmp` scratch dirs.

| ID    | Severity | Title                                                                                            |
| ----- | -------- | ------------------------------------------------------------------------------------------------ |
| R7-01 | **High** | `pnpm/action-setup@v4` hard-fails on every CI/deploy/release run — the entire merge gate is dead |
| R7-02 | **High** | `.pkey/` manifest YAML parse is quadratic and uncapped, reachable from a GitHub push webhook     |
| R7-03 | **High** | Product-supplied JSON Schema `pattern` compiles to an unguarded `RegExp` — 54 s ReDoS measured   |
| R7-04 | **High** | Production deploy is triggered by a bare tag push with no branch/provenance constraint           |
| R7-05 | Medium   | No `permissions:` block on `ci.yml` or `deploy.yml`                                              |
| R7-06 | Medium   | No action is SHA-pinned; two write-capable third-party actions on mutable refs                   |
| R7-07 | Medium   | 19 open advisories from `pnpm audit`; one chain (`ajv > fast-uri`) is in the shipped Worker      |
| R7-08 | Medium   | npm publish has no `--provenance`, unlike the PyPI path                                          |
| R7-09 | Low      | Install-script allowlist is on a deprecation path and not migrated to `pnpm-workspace.yaml`      |
| R7-10 | Low      | Python SDK: unbounded `cryptography>=41`, `requires-python>=3.9`, no lockfile, no audit in CI    |
| R7-11 | Low      | `products/gen-seed.ts` interpolates "numeric" manifest fields into raw SQL unquoted              |
| R7-12 | Low      | Three JOSE implementations; edge-mint emits two different header shapes from one endpoint        |
| R7-13 | Low      | `.husky/pre-commit` has no secret scanning, and no CI job compensates                            |

Refuted: **9** (see the REFUTED section at the end).

---

## R7-01 — `pnpm/action-setup@v4` throws on every run; CI/deploy/release never execute

**Severity: High.** Not an availability bug — an _integrity_ bug. Every control this audit
otherwise assumes exists (build, typecheck, test, lint, conformance-drift gate, admin build)
is declared in a workflow that cannot reach its first `run:` step. The repo's own
`docs/security/findings/BASELINE.md` records 1158 green tests, but those were produced
**locally**, not by CI.

**Files**

- `.github/workflows/ci.yml:14-16` — `uses: pnpm/action-setup@v4` / `with: version: 10`
- `.github/workflows/deploy.yml:19-21` — same
- `.github/workflows/release.yml:21-23` — same
- `package.json:5` — `"packageManager": "pnpm@10.33.2"`

**Preconditions**: none. `actions/checkout@v4` runs first in all three workflows
(`ci.yml:13`, `deploy.yml:18`, `release.yml:20`), so `$GITHUB_WORKSPACE/package.json` is
present when the action reads it.

**Attack path / failure**: `pnpm/action-setup@v4`'s `readTarget()` compares the `version`
input against the `packageManager` field with a **plain string `!==`**, not a semver range
check. `"10.33.2" !== "10"` → throw.

**Evidence** — verbatim from `https://raw.githubusercontent.com/pnpm/action-setup/v4/dist/index.js`
(the exact code the `v4` tag runs today, 1 508 866 bytes):

```js
async function readTarget(e){const{version:t,packageJsonFile:n,standalone:i}=e;
const{GITHUB_WORKSPACE:o}=process.env;let d;
if(o){try{const e=(0,f.readFileSync)(y.default.join(o,n),"utf8");
({packageManager:d}=n.endsWith(".yaml")?M.default.parse(e,{merge:true}):JSON.parse(e))}
catch(e){...}}
if(t){if(typeof d==="string"&&d.startsWith("pnpm@")&&d.replace("pnpm@","")!==t){
  throw new Error(`Multiple versions of pnpm specified:\n  - version ${t} in the GitHub Action
  config with the key "version"\n  - version ${d} in the package.json with the key
  "packageManager"\nRemove one of these versions to avoid version mismatch errors like
  ERR_PNPM_BAD_PM_VERSION`)}
 return`${i?"@pnpm/exe":"pnpm"}@${t}`}
 ...
```

Simulating that function verbatim against this repo's real `package.json`:

```
$ node /tmp/r7_sim.mjs "$PWD"
THROWS:
Multiple versions of pnpm specified:
  - version 10 in the GitHub Action config with the key "version"
  - version pnpm@10.33.2 in the package.json with the key "packageManager"
```

`packageManager: "pnpm@10.33.2"` has been present since the **first commit**
(`dd54497 Scaffold monorepo and freeze the JWS conformance spine`, confirmed via
`git log -L 5,5:package.json`), and the workflows were added later in
`705ca58 Add Phase 9 CI/CD workflows + operations runbook`. The conflict has therefore
existed since the workflows landed; CI has most likely **never** passed in this repo.

_Caveat_: I cannot query GitHub Actions run history from this environment. The deterministic
conclusion above is derived from the tracked files plus the action's published `v4` code.
Verify by opening the repository's Actions tab.

**Secondary consequence**: `release-python.yml` and `release-swift.yml` do **not** use
`pnpm/action-setup` and are unaffected — so the two workflows that can publish artifacts to
public ecosystems still run, while the workflow that would have tested them does not.

**Fix direction**: delete `with: version: 10` from all three workflows and let
`pnpm/action-setup` read `packageManager` (this also removes the floating-major ambiguity),
**or** set `version: 10.33.2` to match exactly. Then SHA-pin the action (R7-06) so the next
mutable-tag behaviour change cannot silently repeat this.

---

## R7-02 — Quadratic YAML parse on `.pkey/` manifests, no size cap, webhook-reachable

**Severity: High.** Remote, unauthenticated-relative-to-Polaris CPU exhaustion of the
production Worker, triggered by a party who is _not_ a Polaris Key admin.

**Files**

- `packages/shared-manifest/src/index.ts:2` — `import { parse as parseYaml } from "yaml"`
- `packages/shared-manifest/src/index.ts:960-975` — `parseDocument()`: `JSON.parse` first,
  then `parseYaml(raw)` with **default options** and no byte cap
- `packages/worker/src/release/github.ts:168-197` — `fetchRepoFile()`: no `Content-Length`
  check, no truncation, no cap on the decoded string
- `packages/worker/src/release/resync.ts:54-67` — `readPkeyFile()` → `fetchRepoFile`
- `packages/worker/src/githubWebhook.ts:165` — `await resyncRepo(...)` on a `push` event
- `packages/worker/src/release/linkRepo.ts:91` — same fetch on admin link
- `packages/worker/wrangler.toml` — **no `[limits] cpu_ms`**, so the Workers default applies

**Preconditions**: write access to the default branch of a repo already linked as a Polaris
Key product. That is the _product owner's_ repo — a third party, not a Polaris operator. The
webhook is HMAC-verified (`githubWebhook.ts:107-122`), but the signature is over a legitimate
GitHub push event; the attacker does not need the secret, only commit rights.

**Attack path**

1. Push a commit touching `.pkey/product.yaml` to the linked repo's default branch
   (`githubWebhook.ts:136-143` requires exactly this).
2. GitHub delivers a signed `push` webhook. `resyncRepo` fetches `.pkey/schema.*`,
   `.pkey/product.*`, `.pkey/release.*` — up to **three** files.
3. Each file is handed to `parseYaml` with defaults. `yaml`'s `uniqueKeys` option defaults
   to `true`, which does an O(n) scan of already-seen keys for every new key in a map — O(n²)
   over a flat map with unique keys.

**Evidence** — measured against the repo's own `yaml@2.9.0` in `packages/worker`:

```
keys=  2500  bytes=   27780  parse=52ms
keys=  5000  bytes=   57780  parse=97ms
keys= 10000  bytes=  117780  parse=357ms
keys= 20000  bytes=  257780  parse=1172ms
keys= 40000  bytes=  537780  parse=5556ms
--- 1.67 MB flat map ---
bytes: 1668890
parse: 37674 ms
--- same 40 000-key input with { uniqueKeys: false } ---
parse: 161 ms
```

Doubling the input roughly quadruples the time — textbook quadratic. `uniqueKeys: false`
is **34× faster** on identical input, isolating the cause.

**Reachable size**: `fetchRepoFile` uses the GitHub _Contents_ API, which base64-encodes
`content` only for blobs ≤ 1 MB; above that it returns `encoding: "none"`, which
`github.ts:189-191` rejects. So there is an **incidental** ~1 MB ceiling per file — nothing
in Polaris Key enforces it. At 1 MB the quadratic curve above puts a single document in the
~15-20 s range, and a resync parses up to three. The Workers CPU limit is not configured in
`wrangler.toml`, so the platform default applies; a single crafted push can consume the
entire budget and kill the request, and each webhook delivery repeats it for **every**
product linked to that repo (`githubWebhook.ts:148-165` loops over
`listProductsByGithubRepo`).

**Fix direction**: cap the decoded body in `fetchRepoFile` (a `.pkey/` manifest has no
legitimate reason to exceed ~64 KB) and pass explicit hardening options to `parseYaml`
(`{ maxAliasCount: 100, uniqueKeys: false }` — or keep `uniqueKeys` and enforce the byte cap,
which is the cheaper fix). The same cap belongs on
`packages/worker/src/admin/handlers/products.ts:79`.

---

## R7-03 — Product-supplied JSON Schema `pattern` → unguarded `RegExp` (ReDoS)

**Severity: High.** Same trust boundary as R7-02: the schema is authored in a third party's
repo, and it is compiled into executable validation logic inside the Worker.

**Files**

- `packages/shared-catalog/src/catalog.ts:28` —
  `this.ajv = addFormats(new Ajv({ allErrors: true, strict: false }))`
- `packages/shared-catalog/src/catalog.ts:54` — `fn = this.ajv.compile(entry.schema)`
- `packages/worker/src/admin/handlers/products.ts:86-87` — `new Catalog(parsed).compileAll()`
  on YAML/JSON pasted or imported from `.pkey/schema.*`
- `packages/worker/src/admin/handlers/schema.ts:40` — same
- Source of `entry.schema`: `.pkey/schema.{json,yaml,yml}` fetched by
  `linkRepo.ts:61-64` / `resync.ts:48-52`

**Attack path**: publish a catalog entry whose schema fragment is
`{"type":"string","pattern":"^(a+)+$"}`. Ajv compiles `pattern` into a literal `RegExp` with
no complexity analysis and no timeout. Every subsequent config-value validation against that
key runs the catastrophic backtracking.

**Evidence** — measured against the repo's own `ajv@8.20.0` with the exact constructor
options from `catalog.ts:28`:

```
ReDoS pattern (a+)+ on 41 chars: 54197 ms -> false
compiled validator is Function: true | source uses codegen: function validate10(data, {instancePath="", parentData, pare
remote $ref: blocked -> can't resolve reference https://evil.example/schema.json from id #
```

**54 seconds** of pegged CPU for a 41-character input. Note the third line: remote `$ref`
resolution _is_ blocked by Ajv's default, so schema-driven SSRF is not available — the
`fast-uri` advisories in R7-07 are correspondingly hard to reach.

**Fix direction**: this is a `strict: false` + untrusted-schema combination. Either
whitelist the permitted JSON Schema keywords before `compile()` (reject `pattern`,
`patternProperties`, `format: regex`), or run patterns through a linear-time engine
(`re2`-style) or a static ReDoS check at catalog-import time, and bound total schema size
and entry count.

---

## R7-04 — Production deploy triggered by a bare tag push, with no branch or provenance constraint

**Severity: High.**

**Files**

- `.github/workflows/deploy.yml:3-5` — `on: push: tags: ["v*"]`
- `.github/workflows/deploy.yml:12` — `if: github.repository == 'vladzaharia/polaris-key'`
- `.github/workflows/deploy.yml:13` — `environment: production`
- `.github/workflows/deploy.yml:31-43` — validates only the tag's _name shape_
  (`^v[0-9]+\.[0-9]+\.[0-9]+(-...)?$`), never the commit it points at
- `.github/workflows/deploy.yml:44-58` — `wrangler d1 migrations apply --remote` and
  `wrangler deploy` with `CLOUDFLARE_API_TOKEN`

**Preconditions**: `contents: write` on the repo (any maintainer, any compromised
maintainer PAT, or any Actions token with write permission — see R7-05).

**Attack path**: a Git tag can point at **any** object in the repository, including a commit
that was never on `main`, never reviewed, and never merged. `git push origin
<arbitrary-sha>:refs/tags/v9.9.9` satisfies the semver regex at `:37`, satisfies the
repository guard at `:12`, and runs `wrangler deploy` plus **destructive D1 migrations**
against production. Branch protection on `main` provides zero coverage here, because the
workflow never asks whether the tagged commit is an ancestor of `main`.

The only remaining control is the `environment: production` gate at `:13`. Whether that
environment has required reviewers, a wait timer, or a deployment-branch/tag policy is a
repository setting I cannot read from the tree — **this must be verified out-of-band**. If
it is an unprotected environment (the default when created implicitly), the path is
unmitigated.

**Fix direction**: add a step asserting `git merge-base --is-ancestor $GITHUB_SHA origin/main`
before any credentialed step; configure the `production` environment with required reviewers
**and** a deployment-tag policy (`v*`); consider moving to `workflow_dispatch` with an
explicit ref input.

---

## R7-05 — No `permissions:` block on `ci.yml` or `deploy.yml`

**Severity: Medium** (the seeded hypothesis overstates the fork-PR half; see below).

**Files**

- `.github/workflows/ci.yml` — no `permissions:` key anywhere in the file
- `.github/workflows/deploy.yml` — no `permissions:` key anywhere in the file
- `.github/workflows/release.yml:15-18` — **does** declare
  `contents: write`, `pull-requests: write`, `packages: write`
- `.github/workflows/release-python.yml:13-15` — declares `id-token: write`, `contents: read`
- `.github/workflows/release-swift.yml:12-13` — declares `contents: write`

So three of five workflows are explicit; two inherit the repository/organisation default,
which is not readable from the tree and must be checked at
_Settings → Actions → General → Workflow permissions_.

**The fork-PR half of the hypothesis is refuted.** `ci.yml:6` is an unqualified
`pull_request` (not `pull_request_target`). For a `pull_request` event raised from a fork,
GitHub _forces_ `GITHUB_TOKEN` to read-only and withholds all repository secrets, regardless
of the repo/org default. A fork PR therefore gets arbitrary code execution on the runner
(via `pnpm build` / `pnpm test` / `pnpm lint` running the PR's own code) but **no**
write-capable token and **no** credentials.

**The residual exposure is real and is on the `push` side.** `ci.yml:4-5` also fires on
`push: branches: [main]`, and `deploy.yml` fires on tag push. Those runs are same-repo, so
`GITHUB_TOKEN` takes the repository default. If that default is "Read and write permissions",
then:

- `ci.yml` runs `pnpm install` (which executes the install scripts allowlisted at
  `package.json:26-31` — see R7-09), then `build`/`test`/`lint`, all in a job holding a
  `contents: write` token. A compromised dependency reaches a token that can push to `main`,
  creating a self-propagating loop.
- `deploy.yml` does the same, additionally on the runner that later executes
  `wrangler deploy` with `CLOUDFLARE_API_TOKEN`.

**On the credential-scoping detail in the seeded hypothesis**: `CLOUDFLARE_API_TOKEN` is
**step**-scoped (`deploy.yml:46` and `:54`), not job-scoped, so it is _not_ in the
environment of `pnpm install` at `:26`. That is a genuine mitigation the hypothesis
overlooked. It does **not** close the path: install-time code runs as the same user on the
same runner and can modify `packages/worker/node_modules/.bin/wrangler` (or plant a `wrangler`
earlier on `$PATH`), which steps `:51` and `:58` then execute _with_ the token in env. Same
outcome, one extra hop.

**Fix direction**: add `permissions: contents: read` at the top of both files and grant
per-job escalations only where needed. Separate the credentialed deploy steps into their own
job that does not run `pnpm install`, consuming a build artifact from an upstream job.

---

## R7-06 — No action is SHA-pinned; two write-capable third-party actions on mutable refs

**Severity: Medium.** R7-01 is the empirical proof that this class of risk is live in this
repo: a mutable tag's behaviour is already load-bearing and already producing an unnoticed
outcome.

Complete inventory of every `uses:` in the tree — **zero** are SHA-pinned:

| Ref                                          | Files                                                                       | Job permissions                                              | Secrets in scope                                      |
| -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `actions/checkout@v4`                        | ci:13,47,65 · deploy:18 · release:20 · release-python:17 · release-swift:15 | varies                                                       | varies                                                |
| `pnpm/action-setup@v4`                       | ci:14 · deploy:19 · release:21                                              | inherit / inherit / write                                    | —                                                     |
| `actions/setup-node@v4`                      | ci:17 · deploy:22 · release:24                                              | inherit / inherit / write                                    | —                                                     |
| `actions/setup-python@v5`                    | ci:48 · release-python:18                                                   | inherit / `id-token: write`                                  | —                                                     |
| **`changesets/action@v1`**                   | **release.yml:34**                                                          | `contents: write`, `pull-requests: write`, `packages: write` | `GITHUB_TOKEN`, `NODE_AUTH_TOKEN` (release.yml:38-39) |
| **`pypa/gh-action-pypi-publish@release/v1`** | **release-python.yml:44**                                                   | `id-token: write`                                            | PyPI OIDC (environment `pypi`)                        |

**`changesets/action@v1`** (`release.yml:34-39`) is the highest-value target. It runs on
every push to `main`, receives `secrets.GITHUB_TOKEN` twice (once as `GITHUB_TOKEN`, once as
`NODE_AUTH_TOKEN` for `https://npm.pkg.github.com`, wired at `release.yml:28`), and holds
`packages: write`. Anyone able to repoint the `v1` tag in the `changesets/action` repository
— a maintainer-account compromise, exactly the Codecov/`tj-actions` pattern — gets, on the
next push to `main`: the ability to publish arbitrary `@polaris-key/*` packages to the
private registry, to push commits to `main`, and to open/modify PRs.

**`pypa/gh-action-pypi-publish@release/v1`** (`release-python.yml:44`) is worse in kind: it
is a **branch** ref, mutable by design, not even a tag. It runs with `id-token: write`
(`release-python.yml:14`), so compromised action code can mint the PyPI OIDC token itself and
publish an arbitrary `polaris-key` wheel to the public index. PyPA does document this ref,
and the `environment: pypi` gate at `:12` plus PyPI's own trusted-publisher environment
binding are meaningful mitigations — but the ref is still mutable and unverified.

**Fix direction**: pin every `uses:` to a full 40-character commit SHA with the tag in a
trailing comment, and add Dependabot's `github-actions` ecosystem to keep the pins moving
(there is no `.github/dependabot.yml` today — see REFUTED item 8).

---

## R7-07 — 19 open advisories; one chain is inside the shipped Worker

**Severity: Medium** in aggregate. Reachability triage is what matters here — most of these
are dev-only.

`pnpm audit --json` (Node 22, pnpm 10.33.2), exit code 1. Metadata verbatim:

```json
{
  "vulnerabilities": {
    "info": 0,
    "low": 1,
    "moderate": 6,
    "high": 12,
    "critical": 0
  },
  "dependencies": 621,
  "devDependencies": 0,
  "optionalDependencies": 0,
  "totalDependencies": 621
}
```

| Severity | Package        | Advisory                                                       | CVSS | Path                                                             | Patched  |
| -------- | -------------- | -------------------------------------------------------------- | ---- | ---------------------------------------------------------------- | -------- |
| high     | fast-uri@3.1.2 | GHSA-v2hh-gcrm-f6hx                                            | 7.5  | `packages__shared-catalog>ajv>fast-uri`                          | >=3.1.4  |
| high     | fast-uri@3.1.2 | GHSA-7p8r-x3mc-p8w7                                            | 7.5  | `packages__shared-catalog>ajv>fast-uri`                          | >=3.1.5  |
| high     | fast-uri@3.1.2 | GHSA-4c8g-83qw-93j6                                            | 7.5  | `packages__shared-catalog>ajv>fast-uri`                          | >=3.1.3  |
| high     | js-yaml@4.2.0  | GHSA-52cp-r559-cp3m (CVE-2026-59869)                           | 7.5  | `.>@changesets/cli>@changesets/read>@changesets/parse>js-yaml`   | >=4.3.0  |
| high     | js-yaml@4.2.0  | GHSA-5p4m-2wfm-xmqj                                            | 7.5  | same                                                             | >=4.3.1  |
| high     | js-yaml@3.14.2 | GHSA-52cp-r559-cp3m                                            | 7.5  | `.>@changesets/cli>@manypkg/get-packages>read-yaml-file>js-yaml` | >=3.15.0 |
| high     | js-yaml@3.14.2 | GHSA-5p4m-2wfm-xmqj                                            | 7.5  | same                                                             | >=3.15.1 |
| high     | nanoid@3.3.15  | GHSA-28wg-ghj8-5hjv                                            | 5.9  | `packages__admin>postcss>nanoid`                                 | >=3.3.16 |
| high     | nanoid@3.3.15  | GHSA-2v37-7h3g-55p8                                            | 5.9  | same                                                             | >=3.3.18 |
| high     | postcss@8.5.15 | GHSA-r28c-9q8g-f849                                            | 7.5  | `packages__admin>postcss`                                        | >=8.5.18 |
| high     | sharp@0.34.5   | GHSA-f88m-g3jw-g9cj (libvips CVE-2026-33327/33328/35590/35591) | —    | `packages__worker>wrangler>miniflare>sharp`                      | >=0.35.0 |
| high     | undici@7.28.0  | GHSA-4cwx-7wf7-3272                                            | 7.4  | `packages__worker>wrangler>miniflare>undici`                     | >=7.29.0 |
| moderate | js-yaml@3.14.2 | GHSA-h67p-54hq-rp68 (CVE-2026-53550)                           | 5.3  | `.>@changesets/cli>...>js-yaml`                                  | >=3.15.0 |
| moderate | postcss@8.5.15 | GHSA-fxqj-rqcc-2cmp                                            | —    | `packages__admin>postcss`                                        | >=8.5.23 |
| moderate | undici@7.28.0  | GHSA-8xcm-r25x-g524                                            | 4.8  | `packages__worker>wrangler>miniflare>undici`                     | >=7.29.0 |
| moderate | undici@7.28.0  | GHSA-m8rv-5g2x-5cg5                                            | 4.2  | same                                                             | >=7.29.0 |
| moderate | undici@7.28.0  | GHSA-jr45-8vmc-qm54                                            | 5.9  | same                                                             | >=7.29.0 |
| moderate | undici@7.28.0  | GHSA-v3r7-h72x-cjcm                                            | 4.8  | same                                                             | >=7.29.0 |
| low      | esbuild@0.27.7 | GHSA-g7r4-m6w7-qqqr                                            | 2.5  | `.>tsup>esbuild`                                                 | >=0.28.1 |

**Reachability**

- **`ajv > fast-uri` (3 × high) — the only advisory in the production Worker runtime.**
  `@polaris-key/catalog` is a runtime `dependencies` entry of `@polaris-key/worker`
  (`packages/worker/package.json:16`), and `ajv`/`ajv-formats` are runtime deps of
  `packages/shared-catalog/package.json`. All three CVEs are host-confusion in URI parsing,
  exploitable when `fast-uri`'s host extraction is used for a security decision and the same
  URL is then handed to `fetch`. Ajv uses `fast-uri` only for `$id`/`$ref` resolution, and I
  confirmed above (R7-03 evidence, third line) that Ajv **refuses to resolve remote `$ref`s**
  — so there is no fetch on the other side of the desync. Practical impact today: low.
  Still, it ships in the Worker bundle and should be bumped.
- **`js-yaml` (2 × high + 1 × moderate) — dev/release-time only.** These are quadratic-CPU
  YAML bugs reached solely through `@changesets/cli`, i.e. `release.yml:34`. Note this is a
  _different_ library from the `yaml@2.9.0` used at runtime; the runtime finding is R7-02.
  The changesets input is the repo's own `.changeset/*.md` and `pnpm-workspace.yaml`, so an
  attacker would need commit access — at which point they have better options.
- **`undici` + `sharp` (1 high + 4 moderate, 1 high) — `wrangler > miniflare`, devDependency
  only** (`packages/worker/package.json:28`). Not in the deployed Worker; the runtime is
  workerd on Cloudflare's edge, not miniflare. Reachable only on a developer machine or CI
  runner during `wrangler dev`/tests.
- **`postcss` + `nanoid` (3 high + 1 moderate) — `packages/admin` build-time only**
  (Tailwind/Vite). The PostCSS `sourceMappingURL` path-traversal needs attacker-controlled
  CSS input, which the admin build does not have.
- **`esbuild` (low)** — dev server, Windows only. Not applicable.

**Fix direction**: `pnpm update ajv ajv-formats` (pulls a patched `fast-uri`) is the only
change that touches production and should be done first. Add `pnpm audit --audit-level=high`
to `ci.yml` once R7-01 is fixed. Adopt Dependabot/Renovate (absent — REFUTED item 8) so
transitive bumps are not manual.

---

## R7-08 — npm publish has no `--provenance`

**Severity: Medium.**

`.github/workflows/release.yml:35-36`:

```yaml
- uses: changesets/action@v1
  with:
    publish: pnpm changeset publish
```

`pnpm changeset publish` runs without `--provenance`, and there is no
`NPM_CONFIG_PROVENANCE: true` in the `env:` block at `:37-39`. `.changeset/config.json`
sets `"access": "restricted"`, and `.npmrc:2` points `@polaris-key` at
`https://npm.pkg.github.com`.

Consumers of `@polaris-key/*` therefore have no cryptographic link from a published tarball
back to the workflow run and source commit that produced it. Contrast with
`release-python.yml:43-45`, which uses PyPI OIDC trusted publishing — no long-lived token,
and an attestable publisher identity. The asymmetry is the finding: the JS path is the
_weaker_ one despite being the one that ships the Worker's own shared packages.

Combined with R7-06 (`changesets/action@v1` unpinned) and R7-05, a compromise of the release
job produces packages that are indistinguishable from legitimate ones.

**Fix direction**: set `NPM_CONFIG_PROVENANCE: true` in the `changesets/action` `env:` block
and confirm the registry accepts attestations; keep `id-token: write` scoped to that job
only.

---

## R7-09 — Install-script allowlist is honoured today but sits on a deprecation path

**Severity: Low.** Recorded because the seeded hypothesis assumed the allowlist was inert —
it is not, and the correction matters for how R7-05 is read.

`package.json:26-31`:

```json
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3", "esbuild", "workerd"]
  },
```

Every pnpm invocation in this repo emits:

```
[WARN] The "pnpm" field in package.json is no longer read by pnpm.
The following keys were ignored: "pnpm.onlyBuiltDependencies".
See https://pnpm.io/settings for the new home of each setting.
```

**The warning is wrong.** I tested it directly with a scratch package whose `postinstall`
writes a marker file, under a clean `HOME`/`XDG_CONFIG_HOME` (so no user-level pnpm rc could
interfere), using the exact pinned pnpm:

```
### case=pkgjson   (onlyBuiltDependencies: ["r7dep"] in package.json#pnpm)
    RESULT: postinstall RAN
### case=other     (onlyBuiltDependencies: ["something-else"])
    warn: │   Ignored build scripts: r7dep@file:dep.  │
    RESULT: postinstall BLOCKED
### case=none      (no allowlist)
    warn: │   Ignored build scripts: r7dep@file:dep.  │
    RESULT: postinstall BLOCKED
```

pnpm 10.33.2 still reads the field. So:

- The allowlist **is** an effective control right now — only `better-sqlite3`, `esbuild` and
  `workerd` can execute install scripts.
- It is nonetheless declared in a location pnpm has announced it will stop reading, and
  `pnpm-workspace.yaml` (the documented new home) contains only `packages:`. When pnpm
  eventually drops the field, the failure is **closed** — all scripts blocked, `better-sqlite3`
  fails to produce `better_sqlite3.node`, and roughly 160 worker tests break loudly
  (consistent with `docs/security/findings/BASELINE.md`'s Node-version note). Low severity
  precisely because it fails safe.
- The three allowlisted packages are exactly the ones whose install scripts run in
  `ci.yml:21`, `deploy.yml:26` and `release.yml:29`. That is the code-execution premise
  underneath R7-05, and it is real.

**Fix direction**: move `onlyBuiltDependencies` into `pnpm-workspace.yaml` to silence the
warning and survive the deprecation. Consider whether `esbuild` and `workerd` need it at all
— both ship platform binaries as optional dependencies and generally function without their
install script.

---

## R7-10 — Python SDK dependency posture

**Severity: Low** today (no live advisories), Medium as a trend.

`sdks/python/pyproject.toml`:

```toml
10 requires-python = ">=3.9"
21 dependencies = [
22   "cryptography>=41",
23   "httpx>=0.24",
24 ]
```

- **No upper bound on `cryptography`.** `>=41` currently resolves to **50.0.1** in this
  worktree (`.venv/bin/pip freeze`) — nine major versions past the floor, across which
  `cryptography` has made breaking API changes. A future major can silently break or subtly
  change the Ed25519 verification path with no code change on this side.
- **No lockfile.** There is no `requirements.txt`, `uv.lock`, or `poetry.lock` anywhere in
  `sdks/python/`. Both CI (`ci.yml:56`) and the release workflow (`release-python.yml:38`)
  run `pip install -e ".[dev]"`, resolving live from PyPI at job time. The JS side is fully
  locked (see REFUTED item 1); the Python side has no integrity pinning at all. A compromised
  release of any transitive dependency lands directly in the wheel-building job at
  `release-python.yml:42`, which runs in the same job as the `id-token: write` publish step
  at `:44`.
- **Version-matrix spread.** `requires-python = ">=3.9"` promises six interpreter versions;
  `ci.yml:50` and `release-python.yml:20` test exactly **one** (3.12). `BASELINE.md` records
  that the local venv actually resolved to **3.14**. Nothing exercises 3.9–3.11 or 3.13+.
- **No `pip-audit` step** in either Python workflow.

**Evidence — no live advisories.** `pip-audit` could not create its resolution venv in this
sandbox, so I queried OSV directly for all 21 pinned versions from `pip freeze`:

```
$ node -e '<batch query to https://api.osv.dev/v1/querybatch>'
OSV: no advisories for any of the 21 pinned packages
```

(installed set includes `cryptography==50.0.1`, `httpx==0.28.1`, `certifi==2026.7.22`,
`anyio==4.14.2`, `h11==0.16.0`, `idna==3.19`, `cffi==2.1.1`, `pytest==9.1.1`, …)

**Fix direction**: add an upper bound (`cryptography>=41,<51`), commit a hash-pinned
`requirements-dev.txt` for CI/release, split the build job from the publish job so the wheel
is an artifact handed to a minimal OIDC job, add `pip-audit` to CI, and expand the matrix to
at least `3.9` and the newest supported version.

---

## R7-11 — `products/gen-seed.ts` interpolates "numeric" manifest fields into raw SQL

**Severity: Low.** Operator tooling, not CI — but it is _documented_ operator tooling whose
output is applied to a real D1 database.

`products/gen-seed.ts:72-77`:

```ts
function q(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + v.replace(/'/g, "''") + "'";
}
const j = (v: unknown): string => q(JSON.stringify(v));
```

`q()` itself is correct for SQLite string literals. The problem is the fields that **bypass**
it. At `:99`, `:111`, `:121` and `:126`, every field typed as a number is interpolated raw:

```ts
`... VALUES (${q(p)},${q(product.name)},...,${product.defaultMaxOfflineDays},${product.defaultDeviceLimit},...)``... ${t.policyExpiryDays ?? "NULL"},${t.policyDeviceLimit ?? "NULL"} ...``... ${e.ttlSeconds} ...``... ${r.ghInstallationId} ...`;
```

The values come from `JSON.parse(readFileSync(join(dir,"product.json")))` cast
`as ProductDef` (`:87-89`) — a compile-time assertion with **no runtime validation**. A
product author who writes `"defaultDeviceLimit": "1); DROP TABLE products;--"` produces a
`seed.sql` containing that text verbatim. Strings routed through `q()` are safe; strings
sitting in number-typed fields are not.

**Confirmed dev-only, as hypothesised**:

- Not a `turbo.json` task. `turbo.json` declares only `build`, `typecheck`, `test`, `lint`,
  `dev`, `clean` — `gen-seed` is absent, so `turbo run build` never invokes it.
- Referenced only by `products/package.json:7` (`"gen-seed": "tsx gen-seed.ts"`); no
  workflow, no `.husky/pre-commit`, no root script calls it.
- Output is gitignored: `.gitignore:37` — `products/*/seed.sql`. Confirmed no build output is
  tracked (`git ls-files | grep -E 'dist/|\.node$|seed\.sql'` → empty).

But it _is_ a documented step — `docs/CONFIG-AUTHORING.md:167` and `products/README.md:25`
both instruct:

```
pnpm --filter @polaris-key/products gen-seed djdl > products/djdl/seed.sql
```

**Fix direction**: validate types at runtime before interpolation (or route numbers through a
`n()` helper that asserts `Number.isFinite`), and note in both docs that `product.json` is
trusted input.

---

## R7-12 — Three JOSE implementations; edge-mint emits two header shapes from one endpoint

**Severity: Low.** The seeded hypothesis says two implementations; there are three, and they
_can_ disagree, though not in a way I could turn into a signature-forgery primitive.

**Inventory**

1. **`jose@^5.9.6`** (`packages/worker/package.json:20`) — used **only** for OIDC ID-token
   verification: `createRemoteJWKSet` + `jwtVerify` at `packages/worker/src/oidc.ts:9`,
   `packages/worker/src/portal/auth.ts:1`, `packages/worker/src/admin/auth.ts:16`.
2. **`@polaris-key/jws`** (`packages/shared-jws/src/index.ts`) — Ed25519 compact JWS for
   license/config documents.
3. **Hand-rolled ES256 and RS256 signers inside the Worker** —
   `packages/worker/src/edgeMint.ts:88-112` (`signEs256`) and `:114-140` (`signRs256`), using
   `crypto.subtle` directly. `jose` is a direct dependency that does exactly this and is not
   used here.

**No alg-confusion in the verifier.** `verifyJws` (`packages/shared-jws/src/index.ts:138-186`)
is well built: hard equality `header.alg !== "EdDSA"` → `null` (`:159`), `kid` must be a
string _and_ present in the caller-supplied trust set (`:159-161`), a `MAX_DOC_BYTES` cap
before `JSON.parse` (`:152`), signature verified over the received `encHeader + "." +
encPayload` bytes without re-serialisation, and every failure path returns `null` rather than
throwing. There is no `none`, no JWK-embedded-in-header, no algorithm negotiation.

**Where they disagree.** `edgeMint.ts:218-231` dispatches one endpoint across all three
signers:

```ts
  switch (cfg.alg) {
    case "ES256":  minted = await signEs256(claims, pem, kid); break;   // header {alg,typ:"JWT",kid}
    case "RS256":  minted = await signRs256(claims, pem, kid); break;   // header {alg,typ:"JWT",kid}
    case "EdDSA":  minted = await signJws(claims, pem, kid ?? ""); break; // header {alg,kid} — NO typ
```

`signEs256` (`:94`) and `signRs256` (`:120`) both emit `{ alg, typ: "JWT", kid }`.
`signJws` (`:116` in shared-jws) emits `{ alg: "EdDSA", kid }` with **no `typ`**. So the same
`/edge-mint` endpoint returns structurally different tokens depending on a per-product config
value. A relying party that enforces `typ === "JWT"` silently rejects every EdDSA-configured
product; one that does not enforce it is accepting a bare Ed25519 JWS whose header is
byte-identical in shape to a Polaris **config/license document**. There is no `typ`, no
domain-separation claim, and no audience requirement (`cfg.audience` is optional at `:216`)
distinguishing the two document classes. If an operator ever points an edge-mint recipe's
`signing_key_secret` at the product signing key, the two trust domains collapse into one.

**Fix direction**: give `signJws` an optional `typ`/domain parameter and stamp a distinct
`typ` on edge-mint tokens; require `cfg.audience`; replace the two hand-rolled JWT signers
with `jose`'s `SignJWT` so one library owns header construction.

---

## R7-13 — `.husky/pre-commit` has no secret scanning, and nothing in CI compensates

**Severity: Low.**

`.husky/pre-commit` in full:

```sh
# Polaris Key pre-commit gate (husky v9).
# ... (comments) ...
# Escape hatch: `git commit --no-verify` skips this for trivial/docs-only commits.

pnpm gen:corpus -- --check
pnpm typecheck
```

Confirmed: two checks, neither of which is a secret scan. `--no-verify` is documented as an
escape hatch at line 9. The hook exists only after a local `pnpm install` (root
`package.json:18`, `"prepare": "husky"`), so a contributor who clones and commits without
installing has no gate at all.

More significant than the hook's weakness: **no CI job scans for secrets either.** There is
no gitleaks/trufflehog step in any of the five workflows, and GitHub's own push protection is
a repository setting not visible from the tree. `.gitignore:12-17` blocks the obvious
artefacts (`*.pem`, `secrets.created.json`, `.env*`), and `wrangler.toml:93-102` correctly
documents secrets as `wrangler secret put` values rather than inlining them — the hygiene is
good, but it is convention-enforced, not tool-enforced.

**Fix direction**: add a `gitleaks` step to `ci.yml` (it runs on `pull_request`, so it covers
fork PRs, where it is most needed), and enable GitHub secret-scanning push protection.

---

## REFUTED

1. **"All 608 lockfile entries have integrity hashes; no git/tarball/http resolutions; no
   alternate registries."** — **Confirmed clean**, exactly as claimed.

   ```
   resolution lines:      608
   with integrity sha512: 608
   with integrity sha1:   0
   tarball:               0
   git repo/commit:       0
   directory/link:        0
   --- any resolution WITHOUT integrity ---   (none)
   --- non-default registry / http refs ---   (none)
   ```

   `pnpm-lock.yaml:1` is `lockfileVersion: '9.0'`. Every one of the 608 resolutions carries a
   `sha512` integrity hash; there are zero `tarball:`, zero git, and zero `directory:`
   resolutions, and zero non-`registry.npmjs.org` URLs. `.npmrc:2` does add a scoped
   registry (`@polaris-key:registry = https://npm.pkg.github.com`) — technically an alternate
   registry, but a private scope for first-party packages that all resolve via `workspace:*`
   in this repo, and content integrity is pinned regardless of which registry serves it.

2. **`auto-install-peers = true` is a supply-chain risk.** — Refuted for CI. `.npmrc:1` sets
   it and `pnpm-lock.yaml:4-5` records `settings: autoInstallPeers: true`. The theoretical
   risk is that a transitive package declares an arbitrary `peerDependency` and gets it
   silently installed. All three JS workflows use `pnpm install --frozen-lockfile`
   (`ci.yml:21`, `deploy.yml:26`, `release.yml:29`), so the lockfile governs and any
   auto-added peer would fail the frozen check. Residual risk is confined to a developer
   running a bare `pnpm install`.

3. **YAML bombs / billion-laughs in the manifest path.** — Refuted. `yaml@2.9.0` blocks
   alias-expansion attacks by default:

   ```
   BILLION-LAUGHS: BLOCKED -> Excessive alias count indicates a resource exhaustion attack
   MERGE-CHAIN: threw     -> Excessive alias count indicates a resource exhaustion attack
   ```

   The library's default `maxAliasCount` catches both classic billion-laughs and the
   merge-key chain shape from the js-yaml CVEs. Note this also means the js-yaml advisories
   in R7-07 do **not** transfer to the runtime parser. The real DoS is a different mechanism
   entirely — see R7-02.

4. **Prototype pollution in the manifest parse path.** — Refuted.

   ```
   PROTO own keys: [ '__proto__', 'foo' ] | ({}).polluted = undefined | own __proto__ desc: true
   JSON own __proto__ desc: true          | ({}).polluted = undefined
   ctor path parsed: {"constructor":{"prototype":{"zz":1}}} | ({}).zz = undefined
   ```

   Both `parseYaml` and the `JSON.parse` fast path at `index.ts:965` create `__proto__` as an
   ordinary **own data property** rather than invoking the setter, so `Object.prototype` is
   untouched. `constructor.prototype` is likewise inert.

5. **Ajv resolves remote `$ref`s (schema-driven SSRF).** — Refuted:
   `remote $ref: blocked -> can't resolve reference https://evil.example/schema.json from id #`.
   This is why the three `fast-uri` host-confusion advisories in R7-07 are hard to reach in
   practice.

6. **`turbo.json` can execute untrusted code.** — Refuted. The file is 20 lines: `$schema`,
   `ui: "tui"`, and six task definitions (`build`, `typecheck`, `test`, `lint`, `dev`,
   `clean`) with only `dependsOn`, `outputs`, `cache` and `persistent` keys. No
   `remoteCache` block, no `signature`/`TURBO_REMOTE_CACHE_SIGNATURE_KEY`, no `globalEnv`
   or `passThroughEnv` that could funnel secrets into task environments, no custom task
   pointing at a script outside the workspace.

7. **`products/gen-seed.ts` runs in CI.** — Refuted; see R7-11. Not a turbo task, not in any
   workflow or hook, and its output is gitignored at `.gitignore:37` with no build artefacts
   tracked. (The `q()` quoter _does_ have a real weakness, which is why R7-11 exists — but
   the CI-exposure half of the hypothesis is wrong.)

8. **"No Dependabot/Renovate config exists."** — **Confirmed.** `.github/` contains only
   `workflows/`; there is no `dependabot.yml`, no `renovate.json`, and no `CODEOWNERS`
   anywhere in the tree. Listed here because it was posed as a claim to verify rather than a
   finding; its consequences are folded into R7-06 and R7-07.

9. **Fork PRs run with a possibly-write `GITHUB_TOKEN`.** — Refuted. `ci.yml:6` is
   `pull_request`, not `pull_request_target`; GitHub forces a read-only token and withholds
   secrets for fork-originated `pull_request` runs regardless of the repo/org default. The
   missing `permissions:` block is still a real finding (R7-05), but its exposure is on the
   same-repo `push` triggers, not on fork PRs.

10. **`npx wrangler` at `deploy.yml:51,58` fetches from the network with the Cloudflare token
    in scope.** — Refuted. `wrangler@^4.40.0` is a declared devDependency
    (`packages/worker/package.json:28`), is present in the lockfile with a sha512 integrity
    hash, and pnpm links it into `packages/worker/node_modules/.bin/wrangler`. Since both
    steps `cd packages/worker` first, `npx` resolves the local binary and performs no
    registry fetch. Worth noting as fragile rather than vulnerable: if the install were ever
    to not link it, `npx` would silently download and execute the newest `wrangler` from the
    registry with `CLOUDFLARE_API_TOKEN` in the environment. Using `pnpm exec wrangler`
    would make the failure loud.
