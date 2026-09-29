> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# E5 - Frontier tech for release + content distribution (cross-cutting, platform-agnostic)

Researched 2026-09-29. Scope: Polaris Key (Cloudflare Worker + D1/KV/DO, no R2 yet) extended to distribute a Godot 4.x game
(iOS/Android/macOS/Windows/Linux/Web) with self-updates and content packs (.pck, 5-70 MB, content-addressed, pinned per code
version) and release channels. Per-store specifics are covered by other agents; this file is the security / delta / HTTP /
rollout / data-model layer that sits under all of them.

Confidence legend: [V] = read on the primary source this session; [S] = from a search-result summary only (treat as likely,
re-verify before building); [I] = my inference or design recommendation (not a sourced fact).

Godot context [V]: Godot 4.6 shipped 2026-02-04, 4.7 on 2026-06-24, 4.7.1 on 2026-07-14 (search summary, [S]); delta-encoded patch
PCKs landed in 4.6 (GH-112011).

---

## 0. Ten-line executive summary

1. The single most important design move: split trust into TWO signers. A CI/offline-held key signs WHAT exists (release manifest:
   code artifacts + pack hashes + compat pins). The Worker-held key signs WHICH/WHEN (channel feed: freshness, sequence number,
   rollout %, halts, eligibility). This is exactly the Uptane "image repo vs director" split and TUF's "targets vs timestamp/
   snapshot" split. A Worker/KEK compromise then can no longer ship arbitrary code or a poisoned .pck.
2. This matters more for .pck than for store binaries: Godot has NO pack signature verification (only optional AES encryption that
   needs custom-compiled export templates [S]), and a .pck can carry GDScript, i.e. it is code. Stores code-sign the app, not your
   downloaded packs. Your signature is the only defence.
3. Use GitHub Actions OIDC as the CI->Polaris credential (no long-lived secret). Verify RS256 JWT against
   https://token.actions.githubusercontent.com/.well-known/jwks and pin numeric `repository_id`, `repository_owner_id`,
   `job_workflow_ref`, `environment`, `aud`. (Live-checked today: RS256, claims list below.)
4. Require GitHub immutable releases (GA 2025-10-28) at ingest and cross-check each asset's `digest` field (GitHub REST returns it)
   against your own sha256. Publish build-provenance attestations; verify them asynchronously (Workflow/Container), not in the
   request hot path.
5. Deltas: precompute in CI. `zstd --patch-from` (whole-file, offset-independent, fast) for code packs and for N-1 -> N of big
   packs; do NOT ask a Worker to compute them (128 MB isolate, 30 s default CPU / 5 min max). Prefer transport-level deltas that
   reconstruct the full signed pack on device over Godot's in-PCK delta encoding (which pays runtime cost forever and depends on
   non-deterministic re-exports).
6. Big rarely-changing asset packs: the win is pack granularity + content addressing (unchanged pack = same hash = zero bytes),
   not binary diffing. Optional chunk index + HTTP Range (zchunk/casync style) later.
7. R2 becomes the blob store: immutable `blobs/sha256/..` keys, bucket lock, `Cache-Control: public, max-age=31536000, immutable`,
   Range + Repr-Digest through a thin Worker gateway; egress is free. CI uploads via R2 temporary prefix-scoped credentials minted
   after OIDC verification.
8. RFC 9842 (Compression Dictionary Transport) is a browser-only optimisation: Chromium yes (130+), Firefox/Safari no,
   Cloudflare is "passthrough beta" (origin must generate deltas). Only useful for the Web export's engine/pck; native Godot
   clients never see it.
9. Rollout: client-side deterministic bucketing (`sha256(salt||installId) mod 10000 < percent_bp`) keeps the signed feed identical
   for all clients (cacheable) and device IDs off the server. Halting = publish a new signed feed; kill-switch latency = feed TTL.
   Health gate = client "confirm healthy or revert" + outcome events + Sentry release health.
10. Data model to adopt (Unity Addressables / Steam / Apple Background Assets synthesis): immutable Releases; mutable Channel
    pointers; per-release Catalog of content-addressed Packs with deps, variants, entitlement, download policy and delta hints;
    "flags select, manifests define".

---

## 1. Update-security frameworks

### 1.1 TUF (The Update Framework)

- Spec: v1.0.36, last modified 5 Aug 2026 [V] https://theupdateframework.github.io/specification/latest/
- Roles [V]: Root (trust anchor, delegates keys, kept offline), Targets (what files are authorised; can delegate by path pattern or
  succinct hash-bins), Snapshot (versions of all targets metadata -> stops mix-and-match), Timestamp (short-lived, frequently
  re-signed -> stops freeze; the only online role in the classic layout). Optional Mirrors.
- Attacks covered [V]: arbitrary install, rollback, freeze, mix-and-match, endless data, fast-forward (version rollover after key
  rotation), wrong software (hash mismatch), key compromise (thresholds + role separation).
- Key rotation [V]: root is versioned; clients fetch every intermediate root N+1, N+2...; each must be signed by a threshold of the
  previous root's keys AND of itself. Consistent snapshots: `VERSION.metadata.json`, `HASH.targetfile` naming lets repos publish
  new snapshots without breaking in-flight clients.
- Practical tooling [S]: TUF-on-CI (GitHub-hosted TUF repos; hardware-key or Sigstore-keyless signers; snapshot/timestamp signed
  automatically by GitHub Actions OIDC; used by Sigstore's own root-signing and by GitHub for attestation metadata)
  https://github.com/theupdateframework/tuf-on-ci ; RSTUF v1.0.0 (Repository Service for TUF, KMS/Vault online-key backends)
  https://repository-service-tuf.readthedocs.io/ ; TUF conformance suite https://github.com/theupdateframework/tuf-conformance
  (useful as a checklist of attack scenarios even if we do not use the TUF wire format).

### 1.2 Uptane - the closest analogue to Polaris' problem

Uptane 2.1.0 [V] https://uptane.org/docs/2.1.0/standard/uptane-standard

- Image repository: offline-signed metadata about which images exist (hashes, sizes), delegations to suppliers; changes rarely.
- Director repository: ONLINE, signs per-vehicle instructions ("this ECU should install image X now") from an inventory DB. Its
  targets role may not delegate.
- Full verification: the ECU checks that the Director's targets metadata matches the Image repo's targets metadata for the same
  image. Partial verification (Director only) is allowed for weak secondaries but is less resilient.
- Vehicle manifest: signed version report with nonces, so the director can detect replay and inconsistent state.
- Claim: an attacker must compromise two independent modules to breach the update mechanism.
  Mapping [I]: Polaris Worker = Director (per-device eligibility, rollout, channel, entitlements; online key). CI release key = Image
  repo (offline/CI; defines the universe of installable bits). Client = full verifier.

### 1.3 How the incumbents do it

| System                                                                                                                                     | Who signs what                                                                                                                                                                                                                       | Freshness / rollback                                                                                                                                                             | Takeaway for Polaris                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sparkle 2 [V] https://sparkle-project.org/documentation/publishing/                                                                        | Developer's Ed25519 key (`sign_update`, `SUPublicEDKey`) signs the archive; `SURequireSignedFeed` also signs the appcast + release notes (added in 2.9.x). Key lives with the developer, not the web host.                           | Version compare; `sparkle:minimumAutoupdateVersion`, `criticalUpdate`, `channel`, `phasedRolloutInterval` (7 client-side groups).                                                | Server compromise cannot forge updates because the server never holds the key. Polaris is different (Worker holds keys) -> needs the split.                             |
| Velopack [V] https://docs.velopack.io/packaging/deltas                                                                                     | `releases.{channel}.json` lists assets with SHA1/SHA256/size; trust comes from HTTPS + hashes + OS code-signing of binaries. Docs I read do not describe feed signing.                                                               | Delta chain (N deltas applied in sequence; heuristic vs full).                                                                                                                   | Good feed shape to render; not a security model to copy.                                                                                                                |
| Chrome Omaha / Chrome Updater "protocol 4" (draft) [V] https://raw.githubusercontent.com/chromium/chromium/main/docs/updater/protocol_4.md | CUP: client sends fresh nonce + key id; server signs the response bound to the request; "integrity of the update check is protected... even in the presence of compromised TLS". Payloads carry hashes; CRX3 signing for components. | Nonce = per-request anti-replay; pipelines (`download`, `puff`, `zucchini`, `xz`, `crx3`, `run`) selected by client `acceptformat`; cohorts/hints for server-controlled rollout. | Pipeline-of-operations response is a great extensible delta model. Nonce-echo is the right pattern for un-cacheable, high-assurance answers (entitlement, kill switch). |
| MSIX / App Installer [V] https://learn.microsoft.com/en-us/windows/msix/app-installer/how-to-create-appinstaller-file                      | Package signed by publisher cert; `.appinstaller` is just a pointer file (HTTPS) whose `MainBundle Publisher/Name/Version` must match the signed package identity. `AppxBlockMap.xml` = SHA-256 of every 64 KB block.                | `ForceUpdateFromAnyVersion` false by default -> only newer versions.                                                                                                             | Feed can be dumb because targets are signed by a separate identity. Block map = built-in delta/resume granularity.                                                      |
| Google Play / Apple                                                                                                                        | Store signs / re-signs; staged rollout + halt in console.                                                                                                                                                                            | -                                                                                                                                                                                | Other agents.                                                                                                                                                           |

### 1.4 Recommended trust model for Polaris Key [I, built on the sources above]

Three key classes, one client-embedded trust anchor:

| Key                                                         | Held by                                                                                                                                                                                                                                                                                                                                                                                                           | Signs                                                                                                                                                                                                                                                          | Lifetime / rotation                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root (per product), threshold 1-of-N at start, 2-of-3 later | Offline hardware keys (YubiKey) / maintainer laptops                                                                                                                                                                                                                                                                                                                                                              | (a) the KEYRING: which release-key ids and which online-key ids are currently valid, with notBefore/notAfter; (b) emergency revocations; (c) minimum trusted root version                                                                                      | ~12 months, TUF-style root chain (each new root signed by previous root threshold + itself). Public key(s) embedded in the game binary / client-core. |
| Release ("targets") key                                     | CI, ideally non-exportable: AWS KMS `ECC_NIST_EDWARDS25519` (Ed25519, announced 2025-11-07 [V] https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/) or Google Cloud KMS `EC_SIGN_ED25519` [S] https://docs.cloud.google.com/kms/docs/algorithms , reached from GitHub Actions via OIDC federation; fallback = GitHub Environment secret with required reviewers | The RELEASE MANIFEST (JWS): version + monotonic `seq`, per-platform code artifacts (sha256, size), the pack catalog (pack id -> sha256, size, deps, variants, entitlement id, delta hints, engine/pck-format compat), `min_supported_seq`, provenance pointers | Rotate via a new keyring signed by root; keep 2 valid at once.                                                                                        |
| Online ("director/timestamp") key                           | The Worker (existing per-product Ed25519 keys under KEK)                                                                                                                                                                                                                                                                                                                                                          | The CHANNEL FEED (JWS): `{product, channel, platform?, seq, iat, exp, manifest_sha256, rollout:{percent_bp,salt}, halted, freeze_windows, min_client_seq, entitlement grants}` and also today's config documents                                               | Rotate freely (quarterly) because the keyring, not the client binary, lists valid online kids.                                                        |

Client verification (TUF-lite, ordered) [I]:

1. Root chain: start from embedded root vR; fetch vR+1.. until 404; verify each against previous+self; check expiry; reject rollback.
2. Feed: verify JWS with an online kid listed in the current keyring; check `product/channel/platform`; `seq >= stored_seq`;
   `iat <= now + skew`; `exp > now` (else FREEZE mode: keep running current version, surface "update service stale", never
   auto-update). Persist `seq`.
3. Manifest: fetch by hash (`manifests/sha256/<feed.manifest_sha256>`) - this is the anti mix-and-match step; verify sha256 equals
   the feed's pin AND verify the release-key signature; enforce `manifest.seq >= highest_seen(channel)`.
4. Rollback = roll FORWARD to old bits: CI publishes a new manifest with higher `seq` that re-pins the old artifacts (same
   hashes). The client never accepts a lower `seq` (TUF fast-forward/rollback logic), and `min_supported_seq` lets CI revoke
   vulnerable releases.
5. Select artifact/packs for platform+variant; prefer delta if the installed sha256 matches a `from`; verify every download's
   sha256 against the manifest; verify reconstructed pack sha256 == manifest pin (so deltas need no separate trust).
6. Two-phase apply: stage -> verify -> atomic pointer swap -> "confirm healthy" or revert.

What each compromise can do [I]:

| Compromised                   | Can                                                                                                                                                                                             | Cannot                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Worker / KEK / D1 / R2 tamper | Withhold updates (DoS); choose among validly signed manifests for a channel (bounded rollback, bounded by client `seq` floor + `min_supported_seq`); target/exclude cohorts; freeze until `exp` | Introduce a new artifact or pack, alter a hash, mix a new pack with old code, extend freshness beyond `exp` |
| CI release key only           | Ship a malicious signed release (the real prize) - so protect with KMS/OIDC, environment approval, immutable releases, provenance                                                               | Change who is in the keyring; rotate roots                                                                  |
| Root threshold                | Everything                                                                                                                                                                                      | -                                                                                                           |

Additional rules [I]:

- Config documents must never introduce a new trust anchor or redirect the update/pack origin; anything that changes the fetch
  origin, keyring or trust roots is CI/root-signed.
- Separate delegations by path (TUF delegation idea): `packs/*` signable by CI alone; `code/*` and keyring changes need an extra
  human/offline signature (or GitHub environment approval) - because packs may contain scripts but native code has the larger
  blast radius.
- High-assurance calls (entitlement grant, kill-switch check, licence heartbeat) use Omaha-CUP-style nonce echo; cacheable feeds
  use `exp`.
- RFC 9421 (HTTP Message Signatures) is an alternative to JWS if you ever want to sign whole HTTP responses including
  `Content-Digest`; for a Godot client, compact JWS is simpler [I].
- Do not invent semantics: keep a table mapping each rule to the TUF spec section, and port TUF-conformance-style negative tests
  (rollback, freeze, mix-and-match, wrong hash, expired root, fast-forward) into the existing conformance corpus.

---

## 2. Supply-chain provenance and CI->server credentials

### 2.1 Landscape (dates)

- Sigstore Rekor v2 GA 2025-10-10 [V] https://blog.sigstore.dev/rekor-v2-ga/ : tile-backed log, CDN-cacheable reads, sharded by
  year; only `hashedrekord` and DSSE entry types; needs cosign >= 2.6.0 to verify, >= 3.1.0 to sign DSSE to v2 [S]. Bundles carry
  entry + inclusion proof + checkpoint -> offline verification.
- SLSA v1.2 released 2025-11-24 [V] https://slsa.dev/blog/2025/11/announce-slsa-v1.2 : adds Source track (levels 1-4) alongside
  Build track (0-3); backward compatible with 1.1.
- GitHub artifact attestations [V] https://docs.github.com/en/actions/concepts/security/artifact-attestations : Build L2 by
  themselves, L3 when built in a reusable workflow; public repos use Sigstore public-good (public tlog), private repos use GitHub's
  own Sigstore instance (no tlog). `actions/attest@v4` is the current action; `actions/attest-build-provenance@v4` is now only a
  wrapper and new work should use `actions/attest` [V] https://github.com/actions/attest-build-provenance . Perms:
  `id-token: write`, `contents: read`, `attestations: write`.
- `gh attestation verify` flags [V] https://cli.github.com/manual/gh_attestation_verify : `--owner/--repo`, `--signer-workflow`,
  `--signer-repo`, `--signer-digest`, `--source-ref`, `--source-digest`, `--cert-identity[-regex]`, `--cert-oidc-issuer`,
  `--deny-self-hosted-runners`, `--predicate-type` (default SLSA provenance v1), `--bundle` (offline), `--custom-trusted-root`,
  `--format json`.
- Attestations REST: `GET /repos/{owner}/{repo}/attestations/sha256:<digest>` returns `attestations[] {repository_id, bundle_url,
initiator}`, `predicate_type` filter = provenance | sbom | release [V]
  https://docs.github.com/en/rest/repos/attestations . GitHub's docs stress that signature + timestamp + signer identity must
  still be cryptographically verified.
- GitHub immutable releases: public preview 2025-08-26, GA 2025-10-28 [V]
  https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ . Assets cannot be added/modified/
  deleted after publish; tags protected and cannot be moved/deleted; tag names cannot be reused after deletion; protects against
  repository resurrection; release attestation in Sigstore bundle format; verify with `gh release verify <tag>` and
  `gh release verify-asset <tag> <asset>` [V] https://github.blog/changelog/2025-08-26-releases-now-support-immutability-in-public-preview/ .
  Recommended flow: create DRAFT -> attach all assets -> publish [V] https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases .
  Existing releases stay mutable unless republished. REST release objects include an `immutable` boolean and assets include a
  `digest` (`sha256:...`, string or null) [V] https://docs.github.com/en/rest/releases/releases . Repo-level status endpoint
  `GET /repos/{o}/{r}/immutable-releases` [S].
- Why it matters now: in March 2026 the `trivy-action` repo was compromised with stolen credentials and 76 of 77 tags were
  force-pushed; only the tag protected by immutable releases survived [V, single blog source]
  https://blogs.eclipse.org/post/mika%C3%ABl-barbero/dont-become-next-trivy-how-make-your-releases-tags-and-automation-resistant
- Trusted publishing is now the norm: npm trusted publishing GA 2025-07-31 (npm CLI >= 11.5.1; provenance by default) [V]
  https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ ; PyPI attestations (PEP 740)
  since 2024-11-14 [S] https://blog.pypi.org/posts/2024-11-14-pypi-now-supports-digital-attestations/ . Same pattern Polaris should
  offer: register a "trusted publisher" per product, exchange CI OIDC token for short-lived capability.

### 2.2 GitHub Actions OIDC as the CI->Polaris credential

Discovery doc fetched live 2026-09-29 [V] https://token.actions.githubusercontent.com/.well-known/openid-configuration :
issuer `https://token.actions.githubusercontent.com`, `jwks_uri` = `.../.well-known/jwks`, signing alg RS256 only. Claims
supported: sub, aud, exp, iat, iss, jti, nbf, ref, sha, repository, repository_id, repository_owner, repository_owner_id,
enterprise, enterprise_id, run_id, run_number, run_attempt, actor, actor_id, workflow, workflow_ref, workflow_sha, head_ref,
base_ref, event_name, ref_type, ref_protected, environment, environment_node_id, job_workflow_ref, job_workflow_sha,
repository_visibility, runner_environment, issuer_scope, check_run_id.
Docs [V] https://docs.github.com/en/actions/reference/security/oidc : job needs `permissions: id-token: write`; request with
`ACTIONS_ID_TOKEN_REQUEST_URL` + `&audience=...` or `core.getIDToken(aud)`; default `aud` = repo owner URL so ALWAYS set a custom
audience; `job_workflow_ref` identifies the (reusable) workflow actually running the job.
Immutable `sub` [V] https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-GitHub-actions-oidc-tokens/ : opt-in from
2026-04-23; automatic for repos created after 2026-07-15 and for renames/transfers after that date; format
`repo:octocat@123456/my-repo@456789:ref:refs/heads/main`. github.com only. => Pin numeric `repository_id` + `repository_owner_id`
claims (always present) rather than string-matching `sub`; protects against name-recycling.

Worker verification recipe [I]:

1. Parse JWT; require `alg=RS256`; select JWK by `kid` from a KV-cached JWKS (TTL ~1 h; refetch at most once/min on unknown kid).
2. `crypto.subtle.verify("RSASSA-PKCS1-v1_5", ...)` (WebCrypto is available in Workers).
3. Check `iss`, custom `aud` (e.g. `https://<polaris-host>/publish/<product>`), `exp/nbf` (+/-60 s), replay via `jti` in a DO/KV
   entry with TTL = token remaining life.
4. Product-level "trusted publisher" policy: `repository_id`, `repository_owner_id`, `job_workflow_ref` (pin the reusable release
   workflow at a protected ref, e.g. `org/infra/.github/workflows/release.yml@refs/heads/main`), `environment == "release"`,
   `ref_protected == "true"`, `runner_environment == "github-hosted"`, `event_name` in an allow-list, and `sha` equals the tag's
   commit (check via GitHub API).
5. On success mint a short-lived publish capability: R2 temporary credentials scoped to `staging/<run_id>/` prefix (see 4.5) plus
   a one-shot ticket for the manifest-submit call. No long-lived CI secret in the repo.
6. Generalise the issuer table (GitLab CI ID tokens etc.) so the same policy engine covers other CI later.

### 2.3 Should a release server verify attestations at ingest? [I]

Yes, but tiered - and it does not replace the CI release key:

- Tier 0 (cheap, synchronous, do now): OIDC publisher policy above + require `immutable: true` on the GitHub release + compare each
  asset's GitHub `digest` with the sha256 you compute/receive + refuse mutable releases and moved tags.
- Tier 1 (asynchronous, later): a Cloudflare Workflow/Queue job that runs real verification tooling (`gh attestation verify
--signer-workflow --source-ref --deny-self-hosted-runners` or sigstore-go/cosign) inside a Cloudflare Container (Containers GA
  2026-04-13 [V] https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ ), records `provenance:
verified|failed`, builder, source digest; stores the Sigstore bundle in R2 next to the manifest and exposes its URL in the feed so
  auditors can run `gh attestation verify --bundle` offline.
- Avoid reimplementing Sigstore verification in the Worker (X.509 + SCT + tlog inclusion proof + trusted-root TUF). The JS
  `sigstore` package targets Node; Worker compatibility is unproven [S].
- Clients do NOT verify Sigstore (too heavy for Godot); they verify the CI Ed25519 release signature. Attestations are for ops,
  auditors and store reviewers.

---

## 3. Delta / patch delivery

### 3.1 Technique survey

| Technique                                 | Granularity                                                                                                                                                                                                                                                       | Notes / numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fit                                                                                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zstd --patch-from=OLD NEW`               | whole file, offset-independent (LZ over old as dictionary)                                                                                                                                                                                                        | "effectively dictionary compression with windowSize > srcSize"; auto `--long`; decompress needs `--long=<windowLog>` / `-M` when window > 128 MiB; dictionary limit raised from 32 MB to 2 GB; levels <=15 best in single thread [V] https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md . Benchmarks: at level 19 comparable to bsdiff (better on larger patches); >200x/>100x faster at levels 1/3; much less memory [V, zstd 1.4.6/1.4.7 era] https://github.com/facebook/zstd/wiki/Zstandard-as-a-patching-engine                                                                                                                                                                                                                                                                                                                                                            | Best default for whole packs. Needs a zstd decoder on every client (Godot exposes zstd via `PackedByteArray.decompress`, but patch-from needs the reference dictionary - implement in client-core / GDExtension). |
| bsdiff                                    | byte-level                                                                                                                                                                                                                                                        | Memory ~ max(17n, 9n+m); slow; small patches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Legacy; only worth it for executables                                                                                                                                                                             |
| HDiffPatch                                | byte-level, stream & window modes                                                                                                                                                                                                                                 | Tested on 20 large files: bsdiff 8.17% / xdelta3 13.6% / hdiffz -BSD 7.74% / hdiffz zstd 6.74% of new size; supports bounded-memory patching, directory diff, bsdiff4/xdelta3 compatibility [V] https://github.com/sisong/HDiffPatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Strong alternative if zstd patch-from is too memory hungry at 70 MB+                                                                                                                                              |
| Godot 4.6+ delta-encoded patch PCK        | per file inside PCK                                                                                                                                                                                                                                               | Uses zstd `--patch-from` internally, flag `PACK_FILE_DELTA`; applied lazily on every load via `FileAccessPatched` (~66 us per patch per load); export options `patch_delta_encoding`, `patch_delta_compression_level_zstd` (default 19), `patch_delta_min_reduction` (default 10%), include/exclude filters [V] https://github.com/godotengine/godot/pull/112011 ; docs [V] https://docs.godotengine.org/en/4.7/tutorials/export/exporting_pcks.html : base packs must be the EXACT files loaded at runtime in EXACT order; re-exporting old versions may differ because of export non-determinism -> patching fails (delta patches only); each stacked patch increases load time; compression on patched assets defeats deltas. CLI: `--export-patch <preset> <path>` + `--patches <a.pck,b.pck>` [V] https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html | Good for shrinking what the STORE ships (e.g. store-delivered patch packs) but poor as our transport format (see 3.2)                                                                                             |
| Content-defined chunking: casync / desync | ~64 KB-ish CDC chunks, chunk id = hash, `.caibx` index, zstd chunks; "a chunk store is any static file host... a CDN can cache them indefinitely" [V] https://github.com/folbricht/desync                                                                         | Great dedup across many versions; object-count explosion; needs many small requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Later, for very large, slowly-mutating assets                                                                                                                                                                     |
| zchunk / zsync (AppImage)                 | chunk index + HTTP Range against ONE file; strong checksums [S] https://github.com/zchunk/zchunk/ ; AppImageUpdate needs a server that handles Range [S]                                                                                                          | No server logic at all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Fits R2 + Range; good "big pack" option                                                                                                                                                                           |
| Steam SteamPipe                           | ~1 MB chunks matched vs previous build [V] https://partner.steamgames.com/doc/sdk/uploading                                                                                                                                                                       | Advice: don't shuffle assets in pack files, keep packs 1-2 GB or less, group by feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Directly informs how to lay out .pck                                                                                                                                                                              |
| itch butler/wharf                         | rsync-style fixed-block patch first, then server regenerates a bsdiff+brotli patch (~30 min for big games) [V] https://itch.io/docs/butler/pushing.html                                                                                                           | "cheap patch now, optimal patch later"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Nice model for lazy re-optimisation                                                                                                                                                                               |
| Velopack                                  | per-file zstd patches; `BestSpeed` default, `BestSize` approaches bsdiff; multiple deltas chained; heuristic delta-vs-full; 2 GB per file limit [V] https://docs.velopack.io/packaging/deltas                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Sequential chain has amplification risk; cap chain length                                                                                                                                                         |
| Sparkle                                   | `generate_appcast` auto-creates binary deltas (BinaryDelta) [V] https://sparkle-project.org/documentation/publishing/                                                                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | macOS binary self-update (if not store)                                                                                                                                                                           |
| Chrome Courgette/Zucchini/Puffin          | Disassembly-aware executable diff (Courgette 9x smaller than bsdiff in Google's example: 78,848 vs 704,512 bytes) [S] https://www.chromium.org/developers/design-documents/software-updates-courgette ; `puff`/`zucchini` operations exist in Omaha pipelines [V] | Only for machine code / deflate archives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Skip; relevant only if you ship raw executables yourselves                                                                                                                                                        |
| Google Play file-by-file patching         | diff of uncompressed APK entries; ~65% smaller updates; ~2x patch-apply time [S] https://www.bleepingcomputer.com/news/mobile/google-shrinks-android-app-update-size-by-65-percent                                                                                | Store-side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | n/a                                                                                                                                                                                                               |
| MSIX block map                            | SHA-256 per 64 KB block; only changed blocks downloaded [S] https://learn.microsoft.com/windows/msix/overview                                                                                                                                                     | Store/OS side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | n/a                                                                                                                                                                                                               |

### 3.2 Recommendation

Important structural fact [I]: a Godot .pck stores files (mostly already-compressed imported resources such as VRAM-compressed
textures) back-to-back with a directory. An update usually leaves most files byte-identical but shifts offsets. Offset-independent
long-range matching (zstd `--patch-from`, HDiffPatch) therefore wins over anything positional and yields "~ size of changed files

- directory". Godot recommends not compressing assets you intend to patch.

(a) Small code packs that change every release (0.5-10 MB): ship the full pack (zstd/brotli via Content-Encoding is irrelevant
because it is already compressed) and add ONE precomputed `zstd --patch-from` delta from N-1 only when saving > ~30% and > ~1 MB.
Complexity beyond that is not worth it. Never chain more than 1-2 deltas; fall back to full.
(b) Large asset packs that rarely change (20-70 MB): the biggest lever is pack granularity - split by volatility and by feature (Steam
guidance), so unchanged packs keep the same hash and download nothing. When a big pack does change, precompute `zstd
    --patch-from` (level 15-19) for N-1 -> N in CI. Later, optionally publish a chunk index (zchunk/casync style) so clients can
Range-fetch only differing chunks from ANY older version.
Transport deltas vs Godot's in-PCK delta: prefer transport deltas that reconstruct the FULL pack on device and verify sha256 ==
manifest pin. Reasons [I, from docs]: no per-load patch cost, no cumulative load-time growth, no dependence on Godot export
determinism (the CI builds the pack once, hashes it, and deltas are computed between stored artifacts, never between re-exports),
and the signature covers exactly the bytes Godot mounts. Use Godot's patch PCKs only for the "layered patch" pattern (base pack
stays byte-identical; a small patch pack is mounted after it), with a cap on stack depth and periodic rebase.
Where to compute [V limits: https://developers.cloudflare.com/workers/platform/limits/ ]: Worker isolate = 128 MB memory, CPU 30 s
default / 5 min max, request body 100 MB (Free/Pro) - a 70 MB pack diff with a 128 MB zstd window cannot fit. `node:zlib` in Workers
documented gzip/deflate/brotli only (zstd binding was in progress) [S]. => CI precomputes and uploads
`deltas/<from_sha256>/<to_sha256>.zst` to R2; the manifest advertises `deltas:[{from,sha256,size,alg:"zstd-patch-from",
window_log}]`. For pairs not precomputed, R2 event notification (object-create, prefix/suffix filters, Queues [V]
https://developers.cloudflare.com/r2/buckets/event-notifications/ ) -> Queue -> Workflow -> Container (up to 12 GiB RAM instances
[S]) generating lazily (butler's "optimise later" pattern). Delta files are CI/root-trust-irrelevant: the manifest signature pins the
final sha256, so a bad delta simply fails verification and the client falls back to the full pack.

---

## 4. HTTP-level tech and Cloudflare platform facts

### 4.1 Compression Dictionary Transport (RFC 9842)

- RFC 9842, September 2025, IETF standards track (Meenan/Weiss) [V] https://www.rfc-editor.org/rfc/rfc9842.html . `Use-As-Dictionary`
  params: `match` (URLPattern, required), `match-dest`, `id` (<=1024 chars), `type`. Client sends single `Available-Dictionary`
  (SHA-256). Encodings `dcb` (Brotli, 36-byte header) and `dcz` (Zstd, 40-byte header); zstd window <= 128 MB; HTTPS only; CORS
  rules for cross-origin; cacheable responses MUST send `Vary: accept-encoding, available-dictionary`.
- Browser support 2026-09 [V] https://caniuse.com/wf-compression-dictionary-transport : Chrome/Edge 130+, Opera 115+, Samsung 28+,
  Chrome Android 154+; Firefox and Safari (desktop+iOS) NOT supported; caniuse global usage ~72%.
- Cloudflare: shared dictionaries public beta in PASSTHROUGH mode on all plans since 2026-04-30 (preview blog 2026-04-17): it
  forwards headers and varies cache, treats dcb/dcz as valid encodings, but "Cloudflare does not generate dictionaries or compute
  deltas" - the origin must [V] https://developers.cloudflare.com/speed/optimization/content/shared-dictionaries/ and
  https://developers.cloudflare.com/changelog/post/2026-04-30-shared-dictionaries-passthrough-beta/ . Example from Cloudflare: 272 KB
  JS bundle 92.1 KB gzip -> 2.6 KB delta-zstd [S].
- Implication [I]: irrelevant for native Godot HTTP clients (HTTPRequest will not send `Available-Dictionary`). Possibly useful
  for the Web export (engine `.wasm`/`.js`, `.pck`) served same-origin to Chromium browsers, and for the admin console. Do not
  build now; keep URLs of engine files stable-pattern-friendly (e.g. `/play/<product>/engine.<hash>.wasm` with a `match` on
  `/play/<product>/engine.*.wasm`) so it can be enabled later.

### 4.2 Range, resume, integrity headers

- RFC 9530 Digest Fields (Feb 2024) [V] https://www.rfc-editor.org/rfc/rfc9530.html : `Content-Digest` = digest of the transferred
  message content; `Repr-Digest` = digest of the selected representation (whole resource even for a 206 response);
  `Want-*` request headers are hints; active algorithms sha-256/sha-512 (md5, sha-1, crc etc. deprecated and MUST NOT be used
  adversarially); values are Structured Field byte sequences. => For pack blobs serve `Repr-Digest: sha-256=:<b64>:`, strong
  `ETag: "<sha256hex>"`, `Accept-Ranges: bytes`, and support `If-Range: "<etag>"` so a resumed download can never splice two
  versions. Client must still verify the final hash against the SIGNED manifest, not the header.
- `Cache-Control: public, max-age=31536000, immutable` on `blobs/sha256/**` (content-addressed => never changes). Feeds get short
  TTL + `stale-if-error` only if within your `exp` policy.
- Cloudflare Cache API cannot `put` 206 responses (throws); `match` does honour Range against a cached full 200 [V]
  https://developers.cloudflare.com/workers/runtime-apis/cache/ ; `cache.put` is incompatible with tiered caching; Cache Reserve
  is NOT eligible for Range/206 requests and needs TTL >= 10 h and Content-Length [V]
  https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/ .

### 4.3 R2 facts [V unless marked]

- Limits: 5 TiB/object, 5 GiB single-part PUT, 10,000 parts (multipart up to ~4.995 TiB), key <= 1,024 bytes, metadata 8,192 B, 1 M
  buckets/account, 100 custom domains/bucket, 1 concurrent write/sec to the SAME key (429) - fine for immutable keys
  https://developers.cloudflare.com/r2/platform/limits/
- Pricing: Standard $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, free 10 GB / 1 M A / 10 M B, free egress
  https://developers.cloudflare.com/r2/pricing/
- Presigned URLs: SigV4, GET/HEAD/PUT/DELETE, 1 s - 7 days, S3 endpoint ONLY (not custom domains); treat as bearer tokens
  https://developers.cloudflare.com/r2/api/s3/presigned-urls/ . For custom-domain gating use WAF token auth
  (`is_timed_hmac_valid_v0`, HMAC-SHA256 `?verify=<ts>-<mac>`, Pro/Business/Enterprise only)
  https://developers.cloudflare.com/waf/custom-rules/use-cases/configure-token-authentication/ ; if you use WAF/Access, disable the
  r2.dev URL https://developers.cloudflare.com/r2/buckets/public-buckets/
- Temporary credentials: short-lived, scoped S3 creds derived from a parent token, scoped by `prefixes`/`objects`, presets
  object-read-only / object-read-write / admin-\*, can be minted locally by signing a JWT (works from a Worker)
  https://developers.cloudflare.com/r2/api/s3/temporary-credentials/ -> ideal for "CI uploads only under staging/<run_id>/".
- Event notifications: object-create (Put/Copy/CompleteMultipartUpload) and object-delete (Delete/LifecycleDeletion) -> Queues;
  prefix/suffix filters, <= 100 rules/bucket, 5,000 msg/s/queue https://developers.cloudflare.com/r2/buckets/event-notifications/
- Bucket locks: prevent delete/overwrite by age/date/indefinite rules, prefix-scoped, GA
  https://developers.cloudflare.com/r2/buckets/bucket-locks/ -> lock `blobs/` and `manifests/`.
- Upload integrity: R2 bindings `put()` accept user-supplied SHA-1/256/384/512 and verify; S3-SDK default CRC32 checksums caused
  errors historically [S] https://developers.cloudflare.com/r2/platform/release-notes/ - test your uploader (`--checksum-algorithm`
  off or SHA256) rather than assume.
- Workers: static assets max 25 MiB per file, 20k (Free) / 100k (Paid) files; request body 100 MB Free/Pro (higher on Business/
  Enterprise); memory 128 MB; CPU 30 s default (<= 5 min); subrequests 10,000 (paid); 6 concurrent outbound connections; bundle
  64 MiB https://developers.cloudflare.com/workers/platform/limits/ . Consequence: .pck packs (5-70 MB) can NOT be Workers static
  assets when >25 MiB; put them in R2 and stream `object.body` from the gateway (streaming a response body does not burn CPU).
- Workers/DO/Queues/Workflows: Workflows step limit raised to 25k (2026-03-03) and instance state 1 GB paid [S]
  https://developers.cloudflare.com/changelog/post/2026-03-03-step-limits-to-25k/ . Containers + Sandboxes GA 2026-04-13,
  instance types lite 256 MiB ... standard-4 12 GiB, custom sizes allowed [S].

### 4.4 Serving design [I]

Two paths:

1. Public/ungated content-addressed blobs: custom domain bound directly to the R2 bucket (or a Worker doing `env.BLOBS.get(key,
{range})`), Cache Everything on `blobs/*`, immutable headers. Cheapest; hash-named objects need no auth because the manifest
   signature is what protects integrity.
2. Entitlement-gated packs (DLC): Worker authenticates the licence/entitlement, then either streams R2 through the gateway with
   `Cache-Control: private, no-store` on the gated response (simple, Worker request cost only) or returns a redirect to a
   time-limited URL (WAF HMAC token on a custom domain -> edge-cached, or R2 presigned on the S3 endpoint -> uncached). Never rely
   on hash secrecy; put the token in the cache key or bypass cache for gated paths.

### 4.5 CI upload flow [I]

OIDC token -> Worker verifies policy -> Worker returns R2 temp creds for `staging/<run_id>/` + upload ticket -> CI uploads packs
(multipart), deltas, manifest draft, Sigstore bundle -> CI signs manifest with release key (KMS) -> CI calls `POST /publish` with
the signed manifest -> Worker re-hashes objects via R2 `head`/sha256 metadata, checks against manifest, moves to
`blobs/sha256/..` (copy is atomic per object), records D1 rows, and only then can a channel be pointed at the release.

---

## 5. Rollout and operations

### 5.1 Staged / percentage rollouts

- Prior art: Sparkle `phasedRolloutInterval` - 7 client-side groups over time; ignored for critical updates and manual checks [V]
  https://sparkle-project.org/documentation/publishing/ . Apple phased release for automatic updates: 1/2/5/10/20/50/100% over 7
  days, pause up to 30 days [S] https://www.developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases .
  Google Play staged rollout with halt [S]. Omaha uses cohorts/hints [V].
- Deterministic bucketing: Unleash hashes user id + groupId with 32-bit MurmurHash3, normalises to 1-100 by modulo; the same users
  stay in as the percentage grows [V] https://docs.getunleash.io/concepts/stickiness ; Cloudflare's Flagship advertises consistent
  hashing too [V] https://developers.cloudflare.com/flagship/ .
- Recommendation [I]: `bucket = u32_be(sha256(salt || installId)[0..4]) mod 10000`; eligible iff `bucket < percent_bp`. Ramp only
  upward. `salt` per product by default (so ~the same 1% are always canaries - fine for beta channels) with an optional per-release
  salt for fairness. Put `{percent_bp, salt}` in the Worker-signed feed and let the CLIENT evaluate: the feed is byte-identical for
  everyone (edge-cacheable, no device id sent to the server, works offline). Server-side gating only for entitlements/beta
  passcodes (minted at download time). `installId` = random per-install UUID, not a hardware id.

### 5.2 Halt / kill switch / freeze

- Halt = new signed feed with `halted:true` or `percent_bp:0` for that manifest (clients that already staged but not applied
  discard it; applied clients are handled by `min_supported_seq`/rollback-forward manifest). Latency = feed `Cache-Control`/`exp`
  (choose 5-15 min for the "kill" document; allow separate fast `status` endpoint with nonce echo).
- Freeze windows (events, tournaments): `freeze:[{from,to,scope,allow_critical}]` in the feed; the Worker also refuses to advance
  channels in the window. Critical/security releases bypass rollout %, mirroring Sparkle `criticalUpdate` [V].
- Fail-safe on stale feed: if `exp` passes, clients stop taking updates but keep working (do not brick offline users).

### 5.3 Health signals for auto-halt

- Two-phase apply with health confirmation [I]: new version boots in "trial"; after N seconds of stable main loop / first
  scene, calls `confirm_healthy()`; if the process dies or the flag is never set, next launch reverts to the previous pack set +
  code (pin-per-code-version makes revert clean). Emit events `update_applied|confirmed|reverted{reason}` to a Polaris ingest
  endpoint -> Durable Object / Analytics Engine aggregates by (release, channel, platform) -> auto-halt when revert/crash-on-
  launch rate exceeds baseline by threshold with min sample size (sequential test, not fixed %). Free first-party signal that also
  works for Web/no-Sentry users.
- Sentry Godot SDK [V] https://docs.sentry.io/platforms/godot/ : Windows, Linux, macOS 12+, iOS 15+, Android and Web; native crash
  reports, GDScript stack traces, Release Health (crash-free users/sessions). Sentry Release Health defines crash-free sessions/users,
  adoption, session states healthy/errored/crashed/unhandled/abnormal [V] https://docs.sentry.io/product/releases/health/ ; REST
  `GET /api/0/organizations/{org}/sessions/` supports `crash_free_rate(session|user)` [S]
  https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics ; metric alerts on crash-free rate can call a
  webhook [S]. Wire: Sentry `release` = Polaris release id, `environment` = channel; a Sentry alert webhook (or a DO cron polling the
  sessions API) posts to Polaris "halt candidate" -> auto-halt or page a human. Godot itself only prints a backtrace from its
  built-in crash handler; there is no native minidump story without the Sentry GDExtension [I].

### 5.4 Feature flags vs content flags; OpenFeature

- OpenFeature: CNCF incubating; spec 1.0 in 2023; providers, evaluation context (`targetingKey`), typed flags, hooks, events,
  tracking; OFREP = HTTP protocol (single + bulk evaluate, ETag/If-None-Match) so any backend can be used by community providers
  (JS, Java, Go, .NET, Swift, Kotlin) [V] https://openfeature.dev/specification/ , https://github.com/open-feature/protocol .
  No Godot/GDScript OpenFeature SDK found [S]. Cloudflare launched Flagship (OpenFeature-based, edge-evaluated flags; announced
  2026-04-17, public beta 2026-05-26, SDKs TS/Python/Go) [S/V] https://developers.cloudflare.com/flagship/ - a signal that generic
  flag evaluation is being commoditised on Cloudflare.
- Recommendation [I]: do not compete on generic flag evaluation. Polaris' differentiator is SIGNED, offline-verifiable config for
  clients. Keep the `flag` catalog kind OpenFeature-shaped (boolean/string/number/object, variant, reason, flagMetadata) so a thin
  OpenFeature provider for the JS/Swift/Kotlin/.NET host shells is a weekend of work; add an OFREP bulk-evaluate endpoint later if a
  customer wants it. Not needed for Godot in v1.
- Principle: "flags select, manifests define." A flag may enable/disable a pack, route a cohort to a channel, or change a
  tunable, but only among items already present in a CI-signed manifest; a flag can never introduce a new hash or URL.

---

## 6. Game-engine content delivery patterns -> common data model

Sources: Unity Addressables remote content [V] https://docs.unity3d.com/Packages/com.unity.addressables@2.8/manual/remote-content-intro.html ;
Unity CCD (buckets, entries, releases, badges; "Promotion only" buckets) [S] https://docs.unity.com/ccd/dashboard ; Unreal
ChunkDownloader manifest [V] https://dev.epicgames.com/documentation/en-us/unreal-engine/hosting-a-manifest-and-assets-for-chunkdownloader-in-unreal-engine ;
Steam depots/branches [V] https://partner.steamgames.com/doc/sdk/uploading ; itch butler channels [V]
https://itch.io/docs/butler/pushing.html ; Apple Managed Background Assets [V]
https://developer.apple.com/documentation/backgroundassets/creating-managed-asset-packs.md ; Roblox/Epic launcher manifests [from
memory, NOT verified this session]: version-hash-addressed package manifests / chunk-GUID manifests with per-chunk hashes.

Observed shapes:

- Addressables: catalog `.json` + `.hash` (client polls the hash), bundles with CRC/hash, groups with build/load path, labels,
  "content update build" that only rebuilds changed bundles, profile-variable remote URL, custom URL evaluation for signed URLs.
  Weakness: the catalog hash is an integrity/cache check, not an authenticated signature.
- CCD: Bucket (container) -> Releases (immutable snapshots) -> Badges (mutable named pointers such as `latest`) -> promote release to
  another bucket; bucket write access "open" vs "promotion only".
- Unreal ChunkDownloader: tab-separated manifest of pak/utoc/ucas files: name, size, version string, chunk index, relative path;
  per-BuildID folder. Weakness: no content hash in the manifest lines (only size + free-form version).
- Steam: app -> depots (per platform/language/DLC) -> builds -> branches (default, betas, optional passwords); DLC = a depot linked
  to base app; ~1 MB chunk dedup.
- Apple Background Assets: manifest per asset pack `{assetPackID, downloadPolicy: essential|prefetch|onDemand (+installationEventTypes
firstInstallation/subsequentUpdate), fileSelectors, platforms}`; Apple-hosted up to 200 GB compressed; managed updates,
  compression handled by the system.

Synthesised model to adopt [I]:

```
Product
 ├─ Channel (mutable pointer; stable | beta | pr-N | custom; optional gate: passcode/entitlement)  == badge / branch
 │    └─ points at → Release (immutable, seq monotonic)
 ├─ Release (CI-signed manifest)
 │    ├─ code[]   : {platform, arch, format, url|store-id, sha256, size, signature/notarisation refs, delta[]}
 │    ├─ compat   : {min_client_seq, engine_version, pck_format_version, abi}
 │    ├─ catalog[] (== pack lock file, pinned per code version)
 │    │     Pack : {id (logical), variant (e.g. astc|etc2|s3tc, low|high, locale), sha256 (content id), size, uncompressed,
 │    │             deps[], entitlement?, policy: essential|prefetch|onDemand, mount:{order, replace_files},
 │    │             labels[], delta:[{from_sha256, sha256, size, alg}], chunk_index?}
 │    └─ provenance: {attestation_bundle_sha256?, builder, source digest}
 ├─ Blob store: blobs/sha256/<aa>/<hash> (immutable, locked); deltas/<from>/<to>
 └─ Signed feeds (Worker): channel feed {seq, exp, manifest_sha256, rollout, halted, freeze, grants}
```

Naming note: Godot exports platform-specific imports (texture compression variants), so a pack's identity = (logical id, variant).

Pitfalls to design against [I unless cited]:

1. Code/pack skew: a pack built for engine 4.6 may not load on 4.7; pin `engine_version`/`pck_format_version` in the signed manifest
   and choose the pack set atomically per code version; never mount mixed sets.
2. Godot export non-determinism: same content can hash differently between exports and delta-encoded patches fail if bases are
   re-exported [V docs]. Build once in CI, store by hash, never re-export an old release.
3. Unauthenticated catalogs (Addressables hash, ChunkDownloader manifest w/o hashes) turn CDN/host compromise into RCE. Sign
   the manifest; hash every blob.
4. Mutable "latest" URLs in caches: only pointer documents are mutable and short-TTL; blobs immutable.
5. `load_resource_pack` mounts before/while resources load; pack set must be decided in a bootstrap before the main scene; loaded
   resources can't be swapped safely afterwards. Layering order matters (later pack wins with `replace_files`) [from Godot docs
   knowledge; re-verify signature].
6. Cumulative Godot patch stacks increase load time [V]; cap depth and rebase.
7. GC vs pinned clients: never delete blobs referenced by any supported release (`min_supported_seq` defines the floor); bucket lock
   enforces that accidents cannot delete them.
8. Entitlement leakage via caches or guessable hashes; gate at URL-mint time; cache key includes token or bypass cache.
9. Disk space / partial downloads on mobile: check space, resume with `If-Range`, verify before swap, keep previous set until
   confirmed.
10. Thundering herd on release day: rollout % + jittered polling + immutable blobs (edge hits).
11. Store policy on downloaded code/scripts inside PCKs (Apple 2.5.2, Google Play "Device and Network Abuse"): covered by other
    agents; design so "content-only" packs can be enforced (export filters excluding scripts / no GDExtension libs inside packs).
12. Godot has no pack signature verification and PCK encryption requires custom export templates [S] - implement verification in
    client-core; Ed25519 is not in Godot's `Crypto` (RSA/HMAC only) so ship it via the existing GDExtension/client-core [S]
    https://docs.godotengine.org/en/4.2/classes/class_crypto.html .

---

## 7. Distribution-feed standards from one truth store

| Target                                                    | Format                                                                                                                                                                                                                          | Dynamic from Worker?                                         | Notes                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Sparkle / WinSparkle appcast                              | RSS + `sparkle:` ns; EdDSA `sparkle:edSignature`; deltas; `channel`, `phasedRolloutInterval`, `criticalUpdate`, `minimumAutoupdateVersion`                                                                                      | YES (already)                                                | Signature must come from CI/offline key, not Worker, if you want the split; appcast can be signed too (`SURequireSignedFeed`) [V] |
| Velopack                                                  | `releases.{channel}.json`: `Assets[] {PackageId, Version, Type Full/Delta, FileName, SHA1, SHA256, Size, NotesMarkdown/Html}` [S] https://docs.velopack.io/reference/cs/Velopack/ReleaseEntry ; custom `IUpdateSource` possible | YES                                                          | Render per channel; deltas map directly to our delta records                                                                      |
| MSIX `.appinstaller`                                      | XML; `MainPackage/MainBundle Uri`, `UpdateSettings/OnLaunch HoursBetweenUpdateChecks`, `ForceUpdateFromAnyVersion`, `UpdateUris`, `RepairUris` (max 10 each) [V]                                                                | YES                                                          | Serve HTTPS with correct MIME; package must be signed by the identity in the file                                                 |
| AltStore source                                           | JSON; `apps[].versions[]` with `version`, `buildVersion`, `downloadURL`, `size`, `sha256`, `minOSVersion`; first version = latest compatible [S] https://faq.altstore.io/developers                                             | YES                                                          | (AltStore PAL/marketplace has separate notarisation rules - other agents)                                                         |
| F-Droid index-v2                                          | `entry.json` (+`entry.jar`/`.asc`) lists `index-v2.json` and diff files; JAR/GPG signed with the repo key [S] https://f-droid.org/docs/All_our_APIs/                                                                            | Only if the repo signing key is NOT the Worker's             | Better: CI generates static index + signs, uploads to R2                                                                          |
| AppImage                                                  | zsync file + embedded update info (`zsync\|url` or `gh-releases-zsync\|owner\|repo\|latest\|*.zsync`); needs Range-capable host [S] https://appimage-builder.readthedocs.io/en/stable/advanced/updates.html                     | Static, CI-generated                                         | R2 supports Range                                                                                                                 |
| winget                                                    | (a) community repo PR to microsoft/winget-pkgs; (b) private REST source (`GET /information`, `POST /manifestSearch`, `GET /packageManifests/{id}`) [S] https://github.com/microsoft/winget-cli-restsource                       | REST source YES (custom); community repo must be pushed (PR) | Installer SHA256 in manifest                                                                                                      |
| Scoop                                                     | JSON manifest, can be installed from a URL; buckets are git repos                                                                                                                                                               | URL manifest YES                                             | `autoupdate`/`checkver` for buckets                                                                                               |
| Homebrew cask                                             | Ruby DSL in a tap (git); official casks are auto-bumped every 3 h by BrewTestBot from livecheck [S] https://docs.brew.sh/Autobump                                                                                               | Must be PUSHED (generate + commit to your tap from CI)       |                                                                                                                                   |
| Flatpak / Flathub                                         | OSTree repo (static) or Flathub manifest PR + `x-checker-data`                                                                                                                                                                  | Static/CI or PR                                              |                                                                                                                                   |
| Snap Store, Steam, itch, Google Play, App Store, MS Store | Vendor upload APIs/CLIs (`snapcraft upload`, `steamcmd +run_app_build`, `butler push`, etc.)                                                                                                                                    | NO - push                                                    | Model as "publish targets" fed by the same release record                                                                         |
| Obtainium                                                 | Reads GitHub/GitLab/F-Droid/HTML pages/direct APK links; import via `obtainium://app/<json>` deep links, config `{id,url,author,name,additionalSettings}` [S]                                                                   | Provide a stable release page/direct link + deep link        | Consumes what you already publish                                                                                                 |

Emerging "universal release metadata"? None authoritative. Closest building blocks [I]:

- AppStream MetaInfo `<releases><release version date type><artifacts><artifact type platform><location/><checksum type=sha256/>
<size type=download|installed/>` (freedesktop; AppStream 1.0 in 2025; consumed by Flathub/GNOME Software/KDE Discover) - the most
  complete vendor-neutral schema for per-platform artifacts + checksums; use its field vocabulary [S] https://www.freedesktop.org/software/appstream/docs/ .
- OCI 1.1 artifacts + referrers API (content-addressed manifests; signatures and attestations attach via `subject`) - a strong
  inspiration for pack storage and for hanging signatures/SBOMs/attestations off a hash [S].
- in-toto/SLSA for provenance, TUF for update metadata, CycloneDX/SPDX for SBOM, purl for identity.
  Recommendation: your canonical internal release record is a superset ("Polaris release manifest") with AppStream-flavoured
  field names; renderers are pure functions of that record; publish an OpenAPI document for it. Don't wait for a standard.

---

## 8. Best-in-class architecture for Polaris Key (recommendation)

### 8.1 Components

- Trust: embedded product root (offline) -> keyring (root-signed) -> release key (CI/KMS) + online key (Worker). Client-core does
  TUF-lite verification (Section 1.4). JWS compact + Ed25519 reused; add `typ`/`kid`/`seq`/`exp` header-body conventions and add
  the negative tests to the conformance corpus.
- Ingest: GitHub OIDC trusted publisher -> R2 temp creds -> CI uploads + KMS-signs manifest -> Worker validates (hash/size/
  digest/immutable) -> D1 rows -> channel pointer moves only by authenticated human/API call.
- Storage: R2 `blobs/sha256/**`, `deltas/**`, `manifests/sha256/**`, `bundles/**` (Sigstore); bucket lock; Worker gateway (Range,
  `Repr-Digest`, ETag=sha256, entitlement gate); optional custom-domain edge cache.
- Feeds: signed channel feed (Worker) + renderers (Sparkle, Velopack, MSIX, AltStore, winget REST, Scoop) generated from D1.
- Deltas: CI-precomputed zstd `--patch-from` (+ optional lazy Container job), advertised in manifest.
- Rollout/ops: client-evaluated bucketing, halt/kill via feed, freeze windows, two-phase apply, outcome events, Sentry webhook.
- Provenance: immutable GitHub releases + `actions/attest` provenance; async verification; bundle exposed.

### 8.2 Build NOW (v1 - closes the security gap and unlocks packs)

1. R2 blob store + Worker gateway (Range, `Repr-Digest`, immutable caching, bucket lock, entitlement gate).
2. CI-signed release manifest with pack catalog + Worker-signed channel feed (`seq`, `exp`, `manifest_sha256`, rollout, halted) and
   client verification incl. rollback/freeze/mix-and-match tests. Root can start as a single offline key.
3. GitHub OIDC trusted-publisher ingest; require immutable release and cross-check asset `digest`; R2 temporary credentials for CI.
4. Two-phase client apply with health confirm + revert; outcome events; client-side bucketing; halt endpoint.
5. Precomputed N-1 -> N `zstd --patch-from` deltas (code + big packs, savings threshold) with full-file fallback.
6. Feed renderers you already need (appcast, Velopack JSON, appinstaller, AltStore) reading the same release record; CI pushes
   Homebrew/winget/Scoop/Flathub artefacts.
7. Sentry Godot SDK + release/environment tagging; webhook -> "halt candidate".

### 8.3 Build LATER

- Async attestation verification service (Workflow + Container), SLSA L3 reusable workflow, expose bundle in feed.
- Threshold root ceremony (2-of-3 hardware keys), keyring rotation tooling, optional TUF-compatible static export (TUF-on-CI style)
  for third-party consumers.
- Chunk index + Range delta for very large assets; lazy on-demand delta jobs; delta chains with amplification limits.
- RFC 9842 for the Web export only when Chromium share and Cloudflare managed dictionaries justify it.
- OFREP endpoint / OpenFeature providers for JS/Swift/Kotlin/.NET.
- AppStream/F-Droid/Flatpak generators; Apple Background Assets and Play Asset Delivery as store-native transports for the same
  pack ids; auto-halt controller (DO + Sentry API/first-party health); optional per-entitlement pack encryption.

### 8.4 Wire-touching reminder (per repo CLAUDE.md)

Everything in 8.1's trust section changes signed document shapes -> enter plan mode; the plan must name corpus regeneration, every SDK
that must follow, and the drift gate (AGENTS.md rules 3, 9-10). New routes / docs pages have their own drift gates.

---

## 9. Open questions / items to re-verify before building

- R2 multi-range GET support (zchunk-style multi-range requests) - not confirmed; plan to coalesce adjacent chunks into one Range.
- R2 S3 checksum header behaviour (SHA-256 vs CRC64NVME) - docs disagree across pages; test the actual uploader.
- Whether `zstd` decode in Workers/`node:zlib` is now available (irrelevant if deltas are CI-only).
- Godot `load_resource_pack(pack, replace_files=true, offset=0)` semantics and 4.7 changes - I did not fetch the method doc (fetch
  returned the property table only).
- Chrome's dictionary size limit for RFC 9842 (large .pck as a dictionary) - not checked.
- Homebrew's current stance on installing casks from raw URLs (tap required?) - not checked.
- Sparkle release dates on the releases page fetch looked unreliable; only feature facts were used.
- Roblox/Epic launcher manifest details are from memory.
- Cloudflare Flagship status is inconsistent across sources (closed beta per InfoQ 2026-05-05; public beta per changelog 2026-05-26).

## 10. Source index (primary)

TUF spec https://theupdateframework.github.io/specification/latest/ | TUF-on-CI https://github.com/theupdateframework/tuf-on-ci |
RSTUF https://repository-service-tuf.readthedocs.io/ | tuf-conformance https://github.com/theupdateframework/tuf-conformance |
Uptane 2.1.0 https://uptane.org/docs/2.1.0/standard/uptane-standard | Omaha protocol 4 https://raw.githubusercontent.com/chromium/chromium/main/docs/updater/protocol_4.md |
Sparkle publishing https://sparkle-project.org/documentation/publishing/ | Velopack deltas https://docs.velopack.io/packaging/deltas |
MSIX App Installer https://learn.microsoft.com/en-us/windows/msix/app-installer/how-to-create-appinstaller-file |
GitHub OIDC https://docs.github.com/en/actions/reference/security/oidc | GitHub OIDC discovery https://token.actions.githubusercontent.com/.well-known/openid-configuration |
Immutable OIDC sub https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-GitHub-actions-oidc-tokens/ |
Artifact attestations https://docs.github.com/en/actions/concepts/security/artifact-attestations | gh attestation verify https://cli.github.com/manual/gh_attestation_verify |
Immutable releases GA https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ |
Releases REST https://docs.github.com/en/rest/releases/releases | Attestations REST https://docs.github.com/en/rest/repos/attestations |
Rekor v2 GA https://blog.sigstore.dev/rekor-v2-ga/ | SLSA v1.2 https://slsa.dev/blog/2025/11/announce-slsa-v1.2 |
npm trusted publishing https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ |
Trivy incident write-up https://blogs.eclipse.org/post/mika%C3%ABl-barbero/dont-become-next-trivy-how-make-your-releases-tags-and-automation-resistant |
AWS KMS Ed25519 https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/ |
Godot patch PCK docs https://docs.godotengine.org/en/4.7/tutorials/export/exporting_pcks.html | Godot delta PR https://github.com/godotengine/godot/pull/112011 |
Godot 4.6 dev5 https://godotengine.org/article/dev-snapshot-godot-4-6-dev-5/ | zstd man https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md |
zstd patching wiki https://github.com/facebook/zstd/wiki/Zstandard-as-a-patching-engine | HDiffPatch https://github.com/sisong/HDiffPatch |
desync https://github.com/folbricht/desync | Steam upload https://partner.steamgames.com/doc/sdk/uploading | butler https://itch.io/docs/butler/pushing.html |
RFC 9842 https://www.rfc-editor.org/rfc/rfc9842.html | caniuse CDT https://caniuse.com/wf-compression-dictionary-transport |
Cloudflare shared dictionaries https://developers.cloudflare.com/speed/optimization/content/shared-dictionaries/ |
RFC 9530 https://www.rfc-editor.org/rfc/rfc9530.html | R2 limits https://developers.cloudflare.com/r2/platform/limits/ |
R2 presigned https://developers.cloudflare.com/r2/api/s3/presigned-urls/ | R2 temp creds https://developers.cloudflare.com/r2/api/s3/temporary-credentials/ |
R2 events https://developers.cloudflare.com/r2/buckets/event-notifications/ | R2 bucket locks https://developers.cloudflare.com/r2/buckets/bucket-locks/ |
Workers limits https://developers.cloudflare.com/workers/platform/limits/ | Cache API https://developers.cloudflare.com/workers/runtime-apis/cache/ |
Cache Reserve https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/ | Containers GA https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ |
Sentry Godot https://docs.sentry.io/platforms/godot/ | Sentry release health https://docs.sentry.io/product/releases/health/ |
OpenFeature https://openfeature.dev/specification/ | OFREP https://github.com/open-feature/protocol | Flagship https://developers.cloudflare.com/flagship/ |
Unleash stickiness https://docs.getunleash.io/concepts/stickiness | Apple managed asset packs https://developer.apple.com/documentation/backgroundassets/creating-managed-asset-packs.md |
Unity Addressables https://docs.unity3d.com/Packages/com.unity.addressables@2.8/manual/remote-content-intro.html |
Unreal ChunkDownloader https://dev.epicgames.com/documentation/en-us/unreal-engine/hosting-a-manifest-and-assets-for-chunkdownloader-in-unreal-engine |
F-Droid APIs https://f-droid.org/docs/All_our_APIs/ | AltStore sources https://faq.altstore.io/developers | winget REST https://github.com/microsoft/winget-cli-restsource |
Homebrew autobump https://docs.brew.sh/Autobump | AppImage updates https://appimage-builder.readthedocs.io/en/stable/advanced/updates.html
