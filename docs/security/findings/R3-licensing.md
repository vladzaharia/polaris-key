# R3 — Server-side licensing bypass, seat abuse, entitlement escalation

**Lane.** A paying-or-not customer trying to obtain more than they bought, **from the network
side only**. On-device tampering (patching the SDK, editing the keychain, forging a doc) is out
of scope and covered elsewhere. Every claim below was read in source and, except where the PoC
column says otherwise, proven by an executable test.

**PoC.** `packages/worker/test/attack/R3-licensing.test.ts` — 18 tests, all green against the
unpatched tree (`pnpm --filter @polaris-key/worker test`, Node 22). Tests assert the _current,
vulnerable_ behaviour so they document the exposure; they must be inverted when fixes land.

**Summary.**

| ID    | Title                                                                                                                          | Severity | PoC    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| R3-01 | Build gate (version window + channel entitlement) is enforced from attacker-controlled headers                                 | High     | Yes    |
| R3-02 | Seat-limit check is a non-atomic read-then-write; concurrent activations blow past `deviceLimit`                               | High     | Yes    |
| R3-03 | One machine mints unlimited free licenses by varying the reported fingerprint subset                                           | High     | Yes    |
| R3-04 | Hardware binding is never re-verified after activation — a copied device token is a portable licence                           | High     | Yes    |
| R3-05 | OIDC claim/migrate re-frees `enroll_hwid`, re-arming the free-licence mint                                                     | Medium   | Yes    |
| R3-06 | `/enroll` hardcodes `expires_at: null`, ignoring the tier's expiry policy                                                      | Medium   | Yes    |
| R3-07 | Worker/SDK disagree on `0.0.0-pr-N`; the Worker classifies real PR builds as `stable`                                          | Medium   | Yes    |
| R3-08 | `POST /<p>/session/license` has no rate limit — unthrottled key oracle + cost amplification                                    | Medium   | Yes    |
| R3-09 | Any device token can deauthorize or relabel every sibling device on the licence                                                | Medium   | Yes    |
| R3-10 | Release access mode `licensed` is identical to `authenticated`; channel entitlement is never checked at the distribution layer | Medium   | Static |
| R3-11 | No hwid-based seat dedupe: `findFingerprintByHwid` has zero callers                                                            | Low      | Yes    |
| R3-12 | Entitlement bucket is never pruned or reconciled; stored `deviceLimit`/`channels` are self-authoritative                       | Low      | Yes    |
| R3-13 | `normalizeChannel`'s unanchored `/^pr-?\d*/` misreads `prod`/`production`/`preview` as the `pr` channel                        | Low      | Yes    |

---

## R3-01 — The build gate is enforced from attacker-controlled headers

**Severity: High.** `checkBuildGate` is the _only_ server-side enforcement of a licence's
version window (`app.minVersion`/`app.maxVersion`, i.e. the remote forced-upgrade control
shipped in `bd26e0b`) and of the `channels` pre-release entitlement. Both of its inputs are
request headers with no corroborating signal, so both controls are advisory.

**Where.**

- `packages/worker/src/licensing.ts:525-526` — `version` and `channel` come straight from
  `X-PKey-Version` / `X-PKey-Channel`.
- `packages/worker/src/gate.ts:127` — `if (isDevBuild(version)) return { ok: true };` returns
  **before** the window and channel checks.
- `packages/worker/src/gate.ts:69-71` — `isDevBuild` is `version.startsWith("0.0.0-dev")`.
- `packages/worker/src/gate.ts:148-155` — the channel entitlement check is skipped whenever the
  normalized channel is `stable` **or** `dev`; `normalizeChannel` (`gate.ts:103-108`) maps every
  unrecognised header to `stable`.
- Same pattern on the browser surface: `packages/worker/src/browserSession.ts:198-204`.

**Preconditions.** A valid device token (any tier, including a free auto-issued one).

**Exploit.**

1. `GET /<product>/config` with `Authorization: Bearer <device token>` and
   `X-PKey-Version: 0.0.0-dev+anything` — the signed doc is returned regardless of the
   licence's or tier's `min_version` / `max_version`. An operator who pinned a licence to
   `>= 5.0.0` to force an upgrade off a vulnerable build has no enforcement at all.
2. Same request with `X-PKey-Channel: staging` on a licence entitled only to `["stable"]` →
   normally 403 `channel-not-entitled`; add `X-PKey-Version: 0.0.0-dev` → 200.
3. No dev build needed: a genuine staging build simply sends `X-PKey-Channel: stable` (or
   `staging-2`, `STAGING`, `beta` — anything unrecognised normalises to `stable`) and the
   channel entitlement is never evaluated.

**PoC.** `R3-01 build gate is attacker-controlled` — three tests. The bypassed response is the
full signed `ManagedConfigDoc`, i.e. `payload.entitlements` **and** `payload.secrets`.

**Note on intent.** `conformance/corpus/v1/gate-matrix.json` pins
_"dev build bypasses the gate despite an out-of-range window + non-entitled channel"_ as
expected behaviour. That is defensible for the **client-side** gate (the SDK compares its own
compiled-in version). It is not defensible for the **server-side** gate, which is fed the same
value over the wire. The two uses need to be separated.

**Fix direction.** Treat the headers as telemetry, not authorization. Server-side: derive the
channel from a signed/attested build identifier, or bind version/channel into the device row at
activation and refuse to re-derive it per request; gate `isDevBuild` on a per-product
`allowDevBuilds` flag that is off in production. At minimum, stop letting the _header_ override
`channelForVersion(version)`, and drop the `dev` short-circuit from the server path entirely.

---

## R3-02 — Seat-limit check is a non-atomic read-then-write (TOCTOU)

**Severity: High.** Seat counts are the product's core monetisation control and they are not
enforced under concurrency.

**Where.**

- `packages/worker/src/licenseCore.ts:341-351` — `resolveEffective` → `resolveDeviceLimit` →
  `countActiveDevices` (`:347`), then the row is written at `:379` (`upsertDevice`).
- `packages/worker/src/repo.ts:913-924` / `:926-955` — a plain `SELECT COUNT(*)` and a separate
  `INSERT … ON CONFLICT DO UPDATE`.
- `packages/worker/src/db/d1.ts:1-34` — the `Db` abstraction exposes `all/first/run/batch` and
  **no transaction**, so there is no primitive available to make the pair atomic.

Between the count and the write sit `mintToken()` and `hashKey()` (`licenseCore.ts:354-355`);
`hashKey` awaits WebCrypto, guaranteeing a yield point. Every concurrent activation therefore
reads the pre-burst count.

**Preconditions.** One valid licence key (or one enrolment). No special privileges.

**Exploit.** Fire N `POST /<product>/activate` in parallel with N distinct `X-PKey-Device`
values. All N are admitted.

**PoC.** `R3-02 seat-limit TOCTOU` — 10 concurrent activations against a `deviceLimit` of 2.
**Observed: all 10 admitted** (`granted === seats === 10`); the assertion is loosened to `> 2`
only so the proof is not scheduler-dependent. The sequential control test confirms the limit is
correct when requests do not overlap (`[200, 200, 403, 403, 403]`).

**Fix direction.** Make the seat claim atomic. Options, in order of preference: (a) a
per-licence Durable Object that owns seat allocation (the codebase already uses this shape for
`RateLimitDO`); (b) a conditional insert —
`INSERT INTO devices … SELECT … WHERE (SELECT COUNT(*) FROM devices WHERE …) < ?` — then
re-read and reject if the row was not created; (c) `Db.batch()` with a guard statement, if a
formulation that fails the whole batch can be found. A post-write reconciliation sweep is not
sufficient on its own but is a reasonable second layer.

---

## R3-03 — One machine mints unlimited free licences by varying the fingerprint subset

**Severity: High.** The whole point of `enroll_hwid` + the partial unique index is
one-free-licence-per-machine. The dedupe key is computed only over the components the client
chose to send.

**Where.**

- `packages/worker/src/fingerprint.ts:86-93` — `computeHwid` iterates `FINGERPRINT_COMPONENTS`
  and skips any component that is `undefined`, so the digest covers **only what was submitted**.
- `packages/worker/src/fingerprint.ts:66-83` — `parseFingerprint` accepts any non-empty subset
  of known components (unknown names are dropped, not rejected).
- `packages/worker/src/enroll.ts:159-178` — the hwid from that subset is the sole dedupe key.

**Preconditions.** `auto_issue_json` enabled with `mode: "anonymous"` or `"both"`. The only
bound is `rateLimitPerHour` per `cf-connecting-ip` (default 10).

**Exploit.** Enrol repeatedly from one machine, omitting a different component each time. With
7 components there are 2^7 − 1 = 127 distinct subsets, hence 127 distinct "machines", each
receiving its own free licence with its own full seat pool. Rotating source IPs removes the
rate-limit bound entirely.

**PoC.** `varying the submitted component subset mints a fresh license per attempt` — 7
enrolments from one component set produce 7 distinct licence ids.

**Fix direction.** Derive the dedupe key from a **fixed, required** component projection (e.g.
the anchor `machineUuid` plus a canonical placeholder for every absent component, so omission
changes nothing), and reject enrolment when the anchor is absent. Additionally, index and check
each _individual_ component hash against `device_fingerprints` at enrolment so a subset still
collides with the machine's existing rows.

---

## R3-04 — Hardware binding is never re-verified after activation

**Severity: High.** The fingerprint is a one-shot check at activation. Every subsequent
authenticated surface accepts the bearer token alone, so a copied token is a fully portable
licence that consumes no additional seat.

**Where.** `matchFingerprint` has exactly one call site in `src/`:
`packages/worker/src/licenseCore.ts:290`, inside `authorizeDevice`, and only when the device
row is already `authorized`. None of `handleConfig` (`licensing.ts:475`), `handleToken`
(`:354`), `handleAccount` (`:387`), `handleDevices` (`:414`), `handleReport` (`:569`) or
`handleDeauthorize` (`:608`) accepts — let alone checks — a fingerprint.

**Preconditions.** Possession of a device token (`pkeyt_…`). Realistic sources: a shared
credential file, a backup, a sync folder, or a customer who simply redistributes it.

**Exploit.** Copy the token to any machine. `GET /config` returns the signed doc — entitlements
and secrets — from arbitrary hardware; `POST /token` rotates it, so the copied session survives
indefinitely; the stored `device_fingerprints` row is never even read.

**PoC.** `an exfiltrated device token works from any machine, on every authenticated surface` —
activates with a full fingerprint, then drives `/config`, `/account`, `/devices` and `/token`
with a completely different platform/arch/UA, all 200, and asserts `components_json` is
byte-identical afterwards.

**Fix direction.** Require and verify a fingerprint on the doc-issuing path, not only on
activation: accept an optional fingerprint on `GET /config` (or move config issuance to a POST)
and run `matchFingerprint` against the bound row, re-binding on drift and 409-ing on mismatch
exactly as `authorizeDevice` does. Failing that, at least verify on `POST /token`, so a stolen
token cannot be kept alive from foreign hardware.

---

## R3-05 — OIDC claim/migrate re-frees `enroll_hwid`

**Severity: Medium** (High in combination with R3-03).

**Where.**

- `packages/worker/src/repo.ts:748` — `claimEnrolledLicense` sets `enroll_hwid = NULL`
  (the comment states this is deliberate: _"frees the unique index so the machine can enroll
  again later"_).
- `packages/worker/src/oidc.ts:398` — the migrate arm likewise sets `enroll_hwid = NULL` while
  disabling the enrolled row.
- Both are reached from `activateFromIdentity` (`oidc.ts:355-417`), driven by the ordinary
  `/auth/device/*` sign-in flow.

**Preconditions.** Anonymous enrolment enabled and OIDC configured (`mode: "both"`), plus one
IdP account.

**Exploit.** enrol → sign in (licence claimed, hwid freed) → enrol again → sign in again
(licence migrated, hwid freed again) → enrol again … a single identity on a single machine
farms an unbounded number of free licences.

**PoC.** `an OIDC sign-in re-frees enroll_hwid so the same machine enrolls again` — three
distinct licence ids from one machine and one identity.

**Fix direction.** Keep the machine binding after the claim. Either retain `enroll_hwid` on the
claimed/disabled row (the partial unique index then continues to block re-enrolment), or move
the binding to a dedicated `enrolled_machines(product, hwid)` table that is never cleared, and
have `/enroll` consult it before minting.

---

## R3-06 — `/enroll` ignores the tier's expiry policy

**Severity: Medium.** A time-boxed trial tier is permanent when auto-issued.

**Where.** `packages/worker/src/enroll.ts:70` hardcodes `expires_at: null` in the
`insertLicense` call, while the OIDC path honours the policy at
`packages/worker/src/oidc.ts:326-331` (`expiresAt = now + tier.policy_expiry_days * 86400`).

**Preconditions.** A product whose auto-issue tier carries `policy_expiry_days`.

**Exploit.** `POST /<product>/enroll`. The resulting licence has `expires_at = NULL`, so
`licenseUsable` (`licenseCore.ts:143-150`) never expires it.

**PoC.** `R3-04 auto-issued licenses ignore the tier's expiry policy` — asserts
`expires_at === null` via `/enroll` and `expires_at === NOW + 7 * 86400` via
`activateFromIdentity` on the _same_ tier.

**Fix direction.** Read the tier once in `handleEnroll` (it is already fetched at
`enroll.ts:148`) and pass `policy_expiry_days` into `locateOrMintLicense`. Better: factor the
"licence fields implied by a tier" computation into one helper shared by `enroll.ts` and
`oidc.ts` so the two paths cannot drift again.

---

## R3-07 — Worker and SDK disagree on `0.0.0-pr-N` (fail-open)

**Severity: Medium.**

**Where.**

- `packages/worker/src/gate.ts:65` — `/^0\.0\.0-pr\d+/` (digit must follow `pr`).
- `packages/sdk-node/src/semver.ts:56` — `/^0\.0\.0-pr-?\d+/` (optional hyphen).
- `packages/sdk-node/test/semver.test.ts:92` explicitly pins
  `channelForVersion("0.0.0-pr-42+abc") === "pr"`, so `pr-N` is a _supported_ naming; the
  Worker has no equivalent case and classifies it as `stable`.

**Exploit.** A PR build named `0.0.0-pr-42` that sends no `X-PKey-Channel` header is treated as
a stable build by the server, so the `channels` entitlement is never evaluated. This requires no
lying by the client — a correctly-behaving SDK triggers it.

**PoC.** `omitting the channel header lets 0.0.0-pr-N pass as stable (worker/SDK divergence)` —
reads the SDK source to confirm the regex still differs, asserts
`channelForVersion("0.0.0-pr-42+abc") === "stable"` vs `"0.0.0-pr42+abc" === "pr"`, and shows
end-to-end that `/config` returns 200 for `pr-42` and 403 for `pr42` on the same licence.

**Fix direction.** Move `channelForVersion`/`isDevBuild`/`compareSemver` into
`@polaris-key/protocol` (or generate them from one spec) so the Worker and all four SDKs cannot
hold different regexes, and add the `pr-N` row to `conformance/corpus/v1/gate-matrix.json`.

---

## R3-08 — `POST /<product>/session/license` has no rate limit

**Severity: Medium.**

**Where.** `packages/worker/src/browserSession.ts:250-292` — `handleBrowserSessionLicense` calls
`hashKey` + `getKey` with no `rateLimitOk` call, unlike `/activate` (`licensing.ts:298-307`,
30/60s per IP), `/token` (`:363-371`), `/enroll` (`enroll.ts:128-142`) and the portal's key
claim (`portal/api.ts:358-366`, 10/window).

**Preconditions.** None — unauthenticated.

**Exploit.** Unlimited key-validity probing (a clean 401/201 oracle), plus unbounded HMAC +
D1-read amplification against the account's usage bill. Brute-forcing the key space itself is
**not** practical: `mintLicenseKey` (`crypto.ts:32-34`) is 128 bits of CSPRNG. The realistic
impact is credential-stuffing leaked/guessed keys at unlimited rate and cost amplification, not
key recovery — which is why this is Medium rather than High.

**PoC.** `accepts unlimited key guesses while /activate 429s after 30` — 120 invalid-key
requests return `401` with zero `429`, against 40 `/activate` attempts that produce exactly 10
`429`s.

**Fix direction.** Add `rateLimitOk(env, product, { bucket: "sessionLicense", id: clientIp(req),
limit: 30, windowSec: 60 })` at the top of the handler, matching `/activate`. Consider a
per-key-prefix bucket as well so a distributed guesser is also bounded.

---

## R3-09 — Any device token can evict or relabel every sibling device

**Severity: Medium.**

**Where.** `packages/worker/src/licensing.ts:414-472` — `handleDevices` authenticates the caller
with `validateDeviceToken`, then selects the target from `listDevicesByLicense` with the only
check being `device_id === deviceId` (`:442`). `DELETE` deauthorizes it and purges its
fingerprint + facts (`:463-469` → `repo.ts:957-974` → `purgeDeviceData`). `PATCH` sets an
arbitrary label.

**Preconditions.** A device token on a shared licence — a team/site licence, or any licence
whose key has been distributed to several people.

**Exploit.** One member (or anyone who obtained one token, cf. R3-04) can 401 every colleague
on the licence at will, destroying their hardware bindings in the process. There is no rate
limit on `handleDevices`, so this is a repeatable one-request-per-victim DoS. The same primitive
lets an attacker relabel colleagues' devices, which is the only signal an operator has in the
admin UI.

**PoC.** `a single device token deauthorizes every other device on the license`.

**Fix direction.** Restrict self-service `DELETE`/`PATCH` to the caller's own `device_id`
(`valid.device.device_id`), and route "manage other devices" through the portal, which already
authenticates a licence _owner_ and rate-limits the action (`portal/api.ts:420-470`). If
cross-device management must stay on this surface, rate-limit it and audit it.

---

## R3-10 — Release access mode `licensed` is indistinguishable from `authenticated`

**Severity: Medium. PoC: static (no executable proof — driving the release handler needs a
`release_config` row plus GitHub API stubs; the code path is unambiguous).**

**Where.** `packages/worker/src/release/index.ts:120-145` — `enforceReleaseAccess` returns early
for `public`, and for **both** `authenticated` and `licensed` does exactly one thing:
`validateDeviceToken`. `readAccessMode` (`:86-90`) offers three modes; only two behaviours
exist. Defaults are `public` for both metadata and artifacts (`:96-99`).

**Impact, and why it matters to R3-01/R3-07.**

1. An operator who selects `licensed` for artifacts gets no more than `authenticated`. Any
   device token satisfies it — including one minted by `POST /enroll` for a free auto-issued
   licence (R3-03 shows how cheap those are). Neither the tier nor any entitlement is
   consulted; `validateDeviceToken` only requires the licence row to be `active` and unexpired.
2. The `channels` entitlement is **never** consulted here. Pre-release artifacts are served from
   `/<product>/<channel>/appcast.xml` and `/cli/<version>/…` with no channel check, so the only
   place `channels` is enforced at all is `/config` — where R3-01 defeats it with a header.
   Net effect: the pre-release/beta entitlement is unenforceable end to end.

**Fix direction.** Make `licensed` mean something: resolve the caller's effective payload and
require an entitlement (at minimum a usable licence with the right tier). Gate channel-scoped
artifact routes on the `channels` entitlement of the presenting token, and default
`artifacts_access` to `licensed` rather than `public` for products that declare channels.

---

## R3-11 — No hwid-based seat dedupe; `findFingerprintByHwid` has zero callers

**Severity: Low.**

**Where.** `packages/worker/src/repo.ts:1098-1109` defines `findFingerprintByHwid`; a repo-wide
grep finds no call site in `src/` (only its own definition). The seat check keys purely on
`device_id`, which is a client-chosen header (`X-PKey-Device`, `licensing.ts:310`) with no
format or uniqueness validation.

**Impact.** The server computes a trustworthy composite hwid for every fingerprinted device and
then never uses it to notice that N seats belong to one machine. This does not by itself exceed
a paid seat count, which is why it is Low; it matters because it removes the only signal that
would detect R3-03/R3-04 style abuse, and because `matchFingerprint` compares strictly against
the _same_ `device_id`'s row (`licenseCore.ts:284-296`), so a fresh `device_id` sidesteps the
mismatch path entirely — the "retire the binding" logic at `licenseCore.ts:303` can always be
avoided by picking a new device id instead of retrying with the old one.

**PoC.** `one machine holds N seats under N device ids with N identical fingerprints` — 5 seats,
5 identical server-computed hwids, and `findFingerprintByHwid` resolves that hwid, proving the
query works and is simply never called.

**Fix direction.** Either call it (reject or coalesce a new `device_id` whose hwid already has an
active seat on the same licence) or delete it, so the codebase does not imply a control it does
not have. Also validate `X-PKey-Device` shape/length.

---

## R3-12 — The entitlement bucket is never pruned or reconciled

**Severity: Low — and explicitly _not_ client-reachable** (see Refuted #1).

**Where.**

- `packages/worker/src/configDoc.ts:33-55` — `validatePayload` prunes `config` and `secrets`
  against the active catalog and passes `entitlements` through untouched (`:53`).
- `packages/worker/src/licenseCore.ts:117-140` — `injectAdminPolicy` overwrites `channels` only
  when the tier/licence union is non-empty, `deviceLimit` only when
  `tier.policy_device_limit` is a number, and `app.min/maxVersion` only when set. Otherwise a
  merged-layer value survives and **is** the policy.
- `packages/worker/src/licenseCore.ts:152-155` — `resolveDeviceLimit` reads the merged
  entitlement, falling back to the product default only when absent.
- `packages/worker/src/oidc.ts:237-282` — `applyProvisioning` writes
  `payload.entitlements[h.entitlement_key]` with **no catalog validation**, and that payload is
  stored as the licence's `overrides_json` (`oidc.ts:421-435`, `:443-461`). This is the one
  writer that can put an arbitrary entitlement key/value into a licence.

**Impact.** A licence with no tier and a stored `deviceLimit` entitlement has that value as its
seat cap, overriding the product default; a stored `channels` entitlement grants pre-release
access with no tier or licence policy behind it; an entitlement key unknown to the catalog is
minted into the signed doc verbatim. Reaching this requires an operator to configure a
provisioning hook (or a stale override to survive a catalog change) — it is a
misconfiguration-amplifier, not a client bypass.

**PoC.** Three tests in `R3-06 entitlement layer is unpruned and self-authoritative`: 8 devices
admitted against a product default of 5 via a stored `deviceLimit: 99`; a stored
`channels: ["staging"]` passing the gate; and an undeclared entitlement key surviving into the
signed doc while an undeclared _config_ key is correctly pruned.

**Fix direction.** Give `injectAdminPolicy` unconditional authority over the keys it owns —
`deviceLimit`, `channels`, `app.minVersion`, `app.maxVersion`, `license.tier*` — deleting them
from the merged payload first and writing only the tier/licence-derived values. Separately,
validate `provisioning_config.entitlement_key` against the catalog at write time (admin API),
and namespace server-policy entitlements (e.g. `policy.deviceLimit`) so a user-facing flag can
never collide with an enforcement key.

---

## R3-13 — `normalizeChannel`'s unanchored `/^pr-?\d*/` misclassifies ordinary words

**Severity: Low (fails closed → availability, not a bypass).**

**Where.** `packages/worker/src/gate.ts:105` — `/^pr-?\d*/` has no end anchor and `\d*` allows
zero digits, so it matches any header beginning with `pr`.

**Impact.** `X-PKey-Channel: prod`, `production`, `preview`, `prerelease` all normalise to `pr`
and are refused with `channel-not-entitled` for a licence entitled to `["stable"]`. A client
that reasonably reports `prod` is locked out of `/config`. The symmetric direction is worse in
principle but is already covered by R3-01: unrecognised headers fall through to `stable`.

**PoC.** `normalizeChannel's unanchored /^pr-?\d*/ misreads ordinary words as the pr channel`.

**Fix direction.** Anchor and require a digit: `/^pr-?\d+$/`, and reject (400) rather than
silently coercing an unrecognised channel header.

---

# Refuted

1. **"A client can reach the stored entitlement override" (seeded hypothesis 6).** **Refuted.**
   Every writer of `licenses.overrides_json` is privileged: the admin API routes through
   `applyOverrides` (`admin/lib/overrides.ts:35-39`), which rejects any key absent from the
   catalog; `admin/handlers/profiles.ts:96` uses the same helper. `devices.overrides_json` is
   written by **no handler at all** — it is only carried through in `upsertDevice`. The portal
   API (`portal/api.ts`) exposes only licence reads, key claim, device disconnect and release
   downloads; it has no override write. The one unvalidated writer is OIDC provisioning, which
   is admin-configured. Downgraded to R3-12 (Low).

2. **"Seat check uses a different layer stack than `/config`" (seeded hypothesis 7).** The
   divergence is **real and demonstrated** (`licenseCore.ts:341` passes `device = null`;
   `licensing.ts:497-504` passes `valid.device`) — the PoC test
   `R3-07 the seat check ignores the device layer that /config merges` shows a doc reporting
   `deviceLimit: 1` while a second device is admitted. But it is **not exploitable**: no code
   path writes `devices.overrides_json`, and even if one did, the direction fails closed for the
   attacker (a device-layer value that _raises_ the limit is ignored by the seat check).
   Informational.

3. **"`/config/report` data influences the merge."** **Refuted.** `handleReport`
   (`licensing.ts:569-605`) writes only `devices.reported_json` (`repo.ts:1212-1224`) and
   `device_facts` (`repo.ts:1162+`). `resolveEffective` (`licenseCore.ts:185-227`) reads
   `license.overrides_json` and `device.overrides_json` — never `reported_json` or
   `device_facts`. The report allowlist contains `entitlements` and `config` keys, but they are
   stored as inert telemetry only. No influence on the signed doc.

4. **"A forged `hwid` in the activation body can collide with another device's dedupe key."**
   **Refuted.** `parseFingerprint` (`fingerprint.ts:66-83`) reads only `components` and discards
   the client's `hwid`; the server recomputes it at `licenseCore.ts:388` and `enroll.ts:170`.
   Verified by the existing test `recomputes the hwid rather than trusting the client's`
   (`fingerprintActivation.test.ts:103`). The _subset_ attack (R3-03) is a different weakness in
   the same function and remains valid.

5. **"Rate limits can be evaded by spoofing the client IP."** **Refuted.** `clientIp`
   (`rateLimit.ts:44-46`) reads only `cf-connecting-ip`, which the edge sets and a client cannot
   override; there is deliberately no `x-forwarded-for` fallback. Rotating real source IPs still
   works, which is what makes R3-03's per-IP bound weak, but header spoofing does not.

6. **"`POST /deauthorize` is a seat-release abuse primitive."** **Refuted for the caller.**
   `handleDeauthorize` (`licensing.ts:608-634`) only ever acts on the bearer token's own device,
   and freeing your own seat is net-zero for you. The abusable variant is R3-09 (evicting
   _siblings_ via `DELETE /devices/<id>`).

7. **"A device token can be replayed against another product."** **Refuted.**
   `validateDeviceToken` (`licenseCore.ts:452-471`) rejects a token record whose
   `rec.product !== product.slug`, every repo call is product-scoped, and the doc carries
   `aud = product.slug`.

8. **"The OIDC migrate path silently upgrades an existing device onto a richer licence."**
   **Refuted.** `moveDevices` (`repo.ts:763-775`) repoints `devices.license_id`, but the KV
   token record still carries the old `licenseId`, so `validateDeviceToken`'s
   `device.license_id !== rec.licenseId` check (`licenseCore.ts:470`) 401s the existing token
   and forces re-activation. Worth noting as an availability wart (migrated devices are silently
   logged out), not a privilege gain.

---

# Remediation

Applied on branch `lewd-owl` by the remediation lane owning `licenseCore.ts`, `enroll.ts`,
`gate.ts`, `fingerprint.ts` and `kv.ts`.

Full worker suite: **656 passed / 656** (`pnpm --filter @polaris-key/worker test`, Node 22) —
647 before this lane started, plus one new R12-02 regression guard, four new gate cases and one
split enrolment case. `npx tsc --noEmit` clean; `npx prettier --check src test` clean. Every PoC
whose attack stopped working was inverted in place and renamed `FIXED (<id>)`, so a regression
fails loudly instead of silently re-passing.

## Hand-offs completed from other lanes

### R3-02 / R11-02 — the seat claim is now arbitrated by the database (High)

`licenseCore.authorizeDevice` no longer does `countActiveDevices()` … `await` … `upsertDevice()`.
It calls the data lane's `claimDeviceSeat` (`repo.ts`), which takes the lowest free ordinal under
`idx_devices_seat` — `UNIQUE (product, license_id, seat_no) WHERE status = 'authorized'`. Two
isolates that compute the same ordinal cannot both commit; the loser retries against the ordinal
set as it now stands and eventually finds every ordinal taken. The R3-02 PoC's ten concurrent
activations against `deviceLimit: 2` now yield **exactly 2** (was: all 10).

`countActiveDevices` is kept as a pre-check ahead of the claim for two reasons: it reports a true
`deviceCount` in the `device_limit` error, and it still refuses rows written before `seat_no`
existed (a legacy authorized device holds no ordinal, so the seat map alone would under-count).

`limit <= 0` now **denies** instead of meaning "unlimited" — the fail-open half of R11-02.
`test/licensingEdge.test.ts` contained a contract test (`treats a deviceLimit of 0 as unlimited`)
pinning the vulnerable behaviour; it is inverted and renamed. The tier and product _columns_ now
reject `<= 0` at the DB, but a stored `deviceLimit` entitlement is JSON, so the code has to fail
closed on its own.

**Required out-of-lane edit — `repo.ts moveDevices`.** Wiring the claim made the OIDC migrate arm
throw `UNIQUE constraint failed: devices.seat_no`: `moveDevices` re-points `devices.license_id` in
bulk, and an ordinal carried across licenses collides the moment the destination already holds it,
which — once seats are claimed at all — is the ordinary case. The statement now also clears
`seat_no`. The moved device stays `authorized`, so `countActiveDevices` still counts it against the
destination's limit; it simply holds no ordinal until its next new authorization. Two tokens, no
behaviour change beyond making the data lane's own primitive wireable.

### R12-02 — sealed managed secrets survive the read path (functional, blocking)

`resolveEffective` takes an **optional** trailing `env`; when present it returns
`openManagedPayload(env, product, payload)` from `admin/lib/managedSecrets.ts`. Opening happens
after the merge (a sealed value in a lower layer that a higher layer overrides is never decrypted)
and after `injectAdminPolicy` (server policy is authored in plaintext and must not be mistaken for
an envelope). `browserSession.ts` passes it.

The parameter is optional rather than required because the remaining caller is out of lane and the
tree must compile either way — **see REPORTED #1: `licensing.ts handleConfig` is one appended
argument away and is the primary surface.** Until that lands, a newly-written managed secret is
sealed at rest but pruned from the signed doc by `configDoc.validatePayload` (fail-closed — the
ciphertext fails the catalog schema, so the key is dropped rather than delivered). Existing
plaintext rows are unaffected. `portal/api.ts entitlementView` needs no change: it reads only
`payload.entitlements`, and entitlements are never sealed.

## R3 findings fixed

### R3-01 — the dev bypass is opt-in, and the channel header can no longer launder a build (High)

Three changes in `gate.ts`, per the owner's decision to keep the bypass but default it OFF:

1. **`isDevBuild` no longer short-circuits on its own.** `GateInput` gains
   `allowDevBuilds?: boolean`; left undefined, the bypass is granted only when the license is
   entitled to the `dev` channel. Both default to OFF, so the Python CLIs that default
   `--version` to `0.0.0-dev` (R4-07) no longer ship a bypass to every install. `dev` was also
   removed from the set of channels the entitlement check skips, so an unentitled dev build inside
   the compat window is now `channel-not-entitled` rather than waved through.
2. **The build's own channel always applies.** `channelForVersion(version)` is evaluated
   unconditionally and the declared header can only _add_ a channel to check, never replace one.
   Previously `channelHeader` won outright, so a pre-release build simply declared `stable`.
3. **An unrecognised header is a refusal, not a free pass.** `normalizeChannel` returns `null`
   for anything it does not know instead of mapping it onto `stable` — the one channel that is
   never entitlement-checked. `staging-2`, `STAGING` and `beta` are now 403.

**No new DB column was added, and none is needed for the default-OFF posture.** The existing
per-tier/per-license `channels` entitlement already flows into `gate.ts` and is already settable
from the admin API (`tiers.channels_json`, `licenses.channels_json`), so "this license may run dev
builds" is expressed the same way "this license may run staging builds" already is. If a
product-wide switch is wanted later, the column is
`ALTER TABLE products ADD COLUMN allow_dev_builds INTEGER NOT NULL DEFAULT 0`, surfaced on
`Product` and passed as `allowDevBuilds` — the parameter is already in place and already wins over
the entitlement when set (proven by a test).

**Follow-up (P0-04, the channel vocabulary).** The gate now lives in `core/gate.ts` and reads
channels through `core/channels.ts` (WIRE-CONTRACT-V3 §5.1). Change 3 still holds, in a refined
form: a _malformed_ header (`STAGING`, `Beta.2`) is refused outright, and an unknown
_well-formed_ name (`staging-2`, `nightly`) is checked as a grant of exactly that name, so it is
never a free pass. `beta` is now a known channel and `staging` its legacy alias; a `staging` grant
covers `beta`. The bypass is still opt-in by the `dev` grant. gate-matrix v2 retired the carried
row that pinned the pre-R3-01 bypass and pins the opt-in behaviour instead, and the Worker now
replays every gate-matrix row through `checkBuildGate` (`test/gateMatrixCorpus.test.ts`).

### R3-07 — worker and SDK agree on `0.0.0-pr-N` (Medium)

`channelForVersion`'s regex is now `/^0\.0\.0-pr-?\d+/`, matching `sdks/*` (whose form is pinned by
`sdk-node/test/semver.test.ts:92`, so the **worker** moved). A digit is still required, so
`0.0.0-prfoo` stays `stable`. Combined with change 2 above, `0.0.0-pr-42` is channel-checked
whether it sends no header or claims `stable`.

### R3-13 — `normalizeChannel` is anchored (Low)

`/^pr-?\d+$/` — anchored at both ends, at least one digit. `prod`, `production`, `preview` and
`prerelease` are no longer misfiled into the `pr` channel (where a `pr` entitlement would wrongly
have satisfied them); they are unrecognised, and therefore refused per change 3.

**Follow-up (P0-04).** `normalizeChannel` became `normalizeChannelHeader` in
`core/channels.ts`, built on `PR_CHANNEL_PATTERN` (`^pr-?([0-9]+)$`, still anchored with at least
one digit). A PR header is narrowed to `pr-<n>`, which a `pr` grant covers. `prod` and friends
are well-formed names now, so they must be granted by name, and a `pr` grant still does not
satisfy them.

### R3-03 — the enrolment dedupe key is a fixed projection (High)

`fingerprint.ts` gains `computeEnrollHwid`, used by `enroll.ts` in place of `computeHwid`. It
digests **only the anchor** (`machineUuid`) under its own domain-separation prefix, and returns
`null` when the anchor is absent — `handleEnroll` then refuses with `fingerprint_required` rather
than minting an undedupable license. Every subset of one machine's components that contains the
anchor now yields the same key, so the 127 reachable subsets collapse to one license (PoC: was 7
distinct licenses from one machine, now 1, with a different machine still getting its own).

`computeHwid` itself is **unchanged** — it is pinned by `conformance/corpus/v1/fingerprint.json`
and is still the right function for a device _binding_, where a partial read should degrade match
precision rather than collide with every other partial reader. Only the dedupe key moved.

### R3-06 — `/enroll` honours the tier's expiry policy (Medium)

`locateOrMintLicense` takes the `TierRow` (already fetched at `enroll.ts:156`) instead of a bare
tier id and computes `expires_at = now + policy_expiry_days * 86400`, matching `oidc.ts:390-391`.
A time-boxed trial tier is no longer permanent when auto-issued. See REPORTED #4 for the other
creation paths.

### R3-11 / R3-04 — one machine, one seat (Low / High-partial)

**Policy decided: one machine holds one seat per license, and the newest device id wins.**
`findFingerprintByHwid` had zero callers; it is now called from `authorizeDevice` on every new
authorization that carries a fingerprint. If the server-computed hwid already belongs to a
_different_ device id that holds an authorized seat **on the same license**, that stale id is
deauthorized (freeing its ordinal and purging its fingerprint/facts rows through the same
`setDeviceStatus` path the hardware-mismatch arm uses) and an audit row `device.seat.coalesced` is
written.

Coalescing rather than refusing is deliberate: a reinstall or a cleared config legitimately
produces a fresh device id, and refusing would strand a customer on a seat they can no longer
reach. It also closes the escape noted in R3-11 — "the retire-the-binding logic can always be
avoided by picking a new device id" — because a new device id now inherits the machine's single
seat instead of opening a second one. Scoped to the same license on purpose: one machine may
legitimately hold this product's free enrolled license _and_ a purchased one.

**Trade-off, deliberately accepted:** containers sharing a host's machine UUID will now evict each
other. The escape hatch is the existing fingerprint policy — coalescing is gated on
`mode !== "off"`, so a product (or a single tier) that turns fingerprint enforcement off keeps
independent device ids. This is why the enrolment test that asserted "a third device id from one
machine hits the tier's limit of 2" was replaced: from one machine the limit is now unreachable,
and the limit case is proven with genuinely distinct hardware instead.

**R3-04 is only partly addressed.** The seat/dedupe half is fixed; re-verifying hardware on the
_doc-issuing_ paths is not, because those handlers are out of lane — see REPORTED #2.

### R10-12 — token records expire, and a revoked token cannot resurrect one (Medium)

Both halves:

- `kv.ts` exports `TOKEN_RECORD_TTL_SECONDS` (30 days) and `putTokenRecord` passes
  `{ expirationTtl }`. The namespace was previously append-only: every token ever minted,
  including every rotated-away and revoked one, persisted for the life of the deployment. D1 is
  the authority — `validateDeviceToken` falls back to `getDeviceByTokenHash` and re-populates —
  so expiry costs one indexed read and never a false 401.
- `validateDeviceToken` back-fills the cache **only after every check has passed**. It previously
  wrote the record as soon as the device row was found, i.e. before the `status !== "authorized"`
  check, so replaying a just-revoked token silently recreated the record `deleteTokenRecord` had
  purged. Both R10-09 PoCs are inverted.

## REPORTED, not fixed

1. **[licensing lane — R12-02, BLOCKING] `licensing.ts handleConfig` must pass `env`.** This is the
   primary config-doc surface and the last unfixed reader. One appended argument at
   `licensing.ts:497-504`:
   ```ts
   let payload = await resolveEffective(
     db,
     product.slug,
     valid.license,
     valid.device,
     now,
     { tighterMin, tighterMax },
     env, // ← add
   );
   ```
   Not applied here only because `licensing.ts` is held by another engineer. Until it lands,
   managed secrets written through the admin API after R12-02 are sealed at rest and then pruned
   out of the signed doc — fail-closed, but the feature is silently off.
2. **[licensing lane — R3-04] The fingerprint is still activation-only.** `matchFingerprint` has
   one call site. `handleConfig` (`licensing.ts:475`), `handleToken` (`:354`), `handleAccount`
   (`:387`), `handleDevices` (`:414`) and `handleReport` (`:569`) neither accept nor check one, so
   a copied `pkeyt_…` remains a portable license and `POST /token` keeps it alive indefinitely.
   Minimum viable fix: have `handleToken` call `readFingerprint(req)` and, when the device has a
   `verified` row, run `matchFingerprint` against it before rotating — `rotateDeviceToken` is in
   this lane and can take the check, but the handler must supply the fingerprint.
3. **[licensing lane — R3-09] Any device token can evict or relabel every sibling.**
   `handleDevices` (`licensing.ts:414-472`) resolves the target with
   `devices.find((device) => device.device_id === deviceId)` over `listDevicesByLicense`, then
   `PATCH` → `setDeviceLabel(db, product.slug, deviceId, label)` and `DELETE` →
   `setDeviceStatus(db, product.slug, deviceId, "deauthorized")`. Neither compares `deviceId` to
   `valid.device.device_id`. Fix: after the `target` lookup and before the `PATCH`/`DELETE` arms,
   `if (deviceId !== valid.device.device_id) return errorResponse(403, ErrorCode.Forbidden, …)`.
   The `GET` listing is fine as it stands. Cross-device management belongs on the portal, which
   already authenticates a license _owner_ and rate-limits the action
   (`portal/api.ts:420-470`).
4. **[R3-06 — the other creation paths] `policy_expiry_days` is honoured on 2 of 3 insert sites.**
   `enroll.ts` (fixed) and `oidc.ts:390-391` honour it. `admin/handlers/licenses.ts:112` takes
   `body.expiresAt` verbatim, so `POST /api/products/<slug>/licenses` with a trial `tier` and no
   `expiresAt` mints a permanent license on a time-boxed tier. The same handler's `PATCH` arm
   (`:~240-256`) lets an operator move a license onto a trial tier without recomputing
   `expires_at`. Both want the shared "license fields implied by a tier" helper the finding asks
   for; that helper should live next to `licenseUsable` in `licenseCore.ts` once the admin lane
   can take the call-site change.
5. **[R3-05 — `repo.ts` / `oidc.ts`] The OIDC claim/migrate arms still re-free `enroll_hwid`.**
   `repo.ts:748` (`claimEnrolledLicense`) and `oidc.ts:398` both `SET enroll_hwid = NULL`, so the
   partial unique index is released and the machine enrols again — unbounded free licenses from
   one identity on one machine. Nothing in `enroll.ts` can close this: after the claim the license
   belongs to an identity, so reusing it for a later anonymous enrolment would be wrong, and there
   is no surviving record that the machine ever enrolled. The fix is a durable binding the claim
   does not clear — either keep `enroll_hwid` on the claimed/disabled row (the index then keeps
   blocking re-enrolment) or add `enrolled_machines(product, hwid)` that is never cleared and have
   `handleEnroll` consult it before minting. **Note the interaction with R3-03:** the dedupe key is
   now `computeEnrollHwid`, so whichever column stores it must store _that_ value, and existing
   `licenses.enroll_hwid` rows carry the old `computeHwid` value — they will not match a new
   submission, so the first enrolment after deploy mints one fresh license per machine, once.
6. **[business model — `repo.ts`] Seats are never reclaimed from dormant devices.**
   `countActiveDevices` (`repo.ts:916-927`) has no `last_seen` predicate and `claimDeviceSeat`'s
   ordinal map has none either, so a device that has not checked in for a year still holds its
   seat and its ordinal. `idx_devices_status(product, status, last_seen DESC)` already exists to
   support the sweep. Two candidate shapes: add `AND last_seen > ?` to both the count and the
   ordinal exclusion (a reclaimed seat is then re-granted silently, and the dormant device 401s on
   its next check-in via the `token_hash` comparison), or a `scheduled()` job that deauthorizes
   dormant rows properly so `releaseDeviceSeat` and `purgeDeviceData` run. The second is cleaner
   but needs the cron handler R11-09 reports as still missing.
7. **[R3-08, R3-10, R3-12] Untouched by this lane.** R3-08 was fixed by the browser-session lane
   (PoC inverted there). R3-10 (`licensed` access mode ≡ `authenticated`) is `release/**`. R3-12
   (`injectAdminPolicy` should own its keys unconditionally and delete them from the merged
   payload first) is a `licenseCore.ts` change this lane could make, but it changes the meaning of
   every stored `deviceLimit`/`channels` override in production and wants the owner's call before
   it ships; it is a misconfiguration-amplifier, not a client bypass.
8. **[gate.ts] The gate is still fed two client-chosen strings.** Changes 2 and 3 above remove the
   _laundering_ — a build can no longer declare its way into a looser channel — but a client that
   simply lies about its `X-PKey-Version` still gets the window evaluated against the lie. Closing
   that needs a signed or attested build identifier, or binding version/channel into the device row
   at activation and refusing to re-derive it per request. Out of scope for a regex fix; recorded
   so the residual is not mistaken for closed.
