# Security plan: bounded console-group assertions and targeted admin-session revocation

| Field                     | Value                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brief                     | None yet. This is an unowned security finding; approval creates the implementation work package(s).                                                                                                                                                               |
| Status                    | awaiting approval: merging this plan is the approval                                                                                                                                                                                                              |
| Basis                     | `main` at `d27467ef8`; current code is `packages/worker/src/core/console/session.ts`, `sessionRevocation.ts`, `console/api.ts`, `console/auth.ts`, and `core/rbac/principal.ts`. The assignment's `src/console/session.ts` path is stale after the layering move. |
| Wire change               | **None.** No device route, signed document, `typ`, claim, SDK API, `PROTOCOL_VERSION`, `corpusVersion`, `shared-protocol`, or `shared-jws` change.                                                                                                                |
| Corpus / SDKs             | None. This is an operator-cookie and console-RBAC change only.                                                                                                                                                                                                    |
| Existing decision amended | `plans/ST-28.md` Q3 accepts an 8-hour IdP-group assertion. This plan proposes a one-hour bound plus an immediate targeted revoke control; the owner must explicitly approve that amendment.                                                                       |

## 1. Summary and scope

Today a console cookie contains the IdP `groups` claim and lasts eight hours
(`ADMIN_SESSION_TTL_SECONDS`, `core/console/session.ts:54-57`; claim issuance at `:160-177`).
`resolvePrincipal` grants the root Superadmin role from that signed snapshot
(`core/rbac/principal.ts:36-57`). Removing a person from `PLATFORM_ADMIN_GROUP` at the IdP
therefore does not end an already-issued cookie. The current maximum is eight hours.

The Worker already has a per-subject server-side revocation mark:
`sessionFromRequest` reads it for every valid cookie (`session.ts:240-253`) and self-logout
writes it (`console/routes.ts:62-79`). It has no operator-facing way to revoke a different
operator, and it receives no IdP group-change signal.

This plan makes two deliberately small changes:

1. **Bound automatic group-removal lag to one hour.** Issue an explicit cookie `iat`, reduce the
   admin cookie lifetime from eight hours to one hour, and refuse every pre-cutover cookie rather
   than deriving its issue time with the new TTL. The ordinary login callback re-fetches the IdP
   token and therefore re-evaluates the `groups` claim. A person removed from the group cannot
   obtain the next cookie.
2. **Provide immediate, targeted containment.** Add a platform, step-up-protected endpoint that
   writes the existing `admin-revoked` mark for a named OIDC subject, padded so that clock skew
   cannot let a just-minted cookie survive (§6.2). It is the mandatory offboarding/incident step
   after removing that subject from the IdP group. ST-31 owns the later Members-page control; this
   endpoint is its stable backend contract.

An optional third piece, decided separately by the owner (§6.7), is a break-glass recovery path for
an IdP outage, because the one-hour bound makes the IdP a renewal dependency.

Out of scope: storing OIDC refresh tokens, polling an IdP admin API, back-channel logout, changing
portal sessions, and changing any product or device protocol behavior.

## 2. Contract and hard rules

There is no Polaris Key wire-contract change. The admin HMAC cookie is an internal browser-session
format, not a signed licence/config/trust/bundle/feed/release document. `PROTOCOL_VERSION` remains
4 and `corpusVersion` remains 2.

- **Hard rule 1:** no corpus or generated corpus/mirror file changes.
- **Hard rule 2:** no wire change and no version bump.
- **Hard rule 6:** session code remains in `core/console`; the dispatcher remains the single
  cookie reader (`console/api.ts:78-99`).
- **Hard rule 10:** the targeted-revoke route is a new route, so it is pinned like the other
  step-up platform routes (U-03’s `override-migration/run`): its OpenAPI path and the
  `ADMIN_KIND_PATHS` entry in `routeCoverage.test.ts` change together, and the route-area fixture
  (`rbac-route-areas.json`), the step-up table (`console/stepUp.ts`) and the RBAC matrix’s step-up
  list change with it.
- Generated docs/reference output and the admin route tests are regenerated/updated through their
  normal owners; `workpackages.json` and generated `INDEX.md` are not touched by this plan-only PR.

## 3. Catalog and manifests

None. The session duration and assertion bound remain code constants, not product/catalog settings:
a runtime-widenable session duration is explicitly disallowed by the current rationale
(`session.ts:54-56`). There is no manifest validator, schema, mutation-table, or catalog change.

## 4. Corpus, transcripts, and mirrors

None. The browser cookie is not part of the frozen device wire and no recorded device transcript
contains it.

## 5. SDKs

None. Browser console behavior changes only in `packages/admin`; Node, React SDK, Python, Swift,
Godot, Kotlin, and the conformance runners do not consume the admin cookie.

## 6. Worker and admin design

### 6.1 Exact cookie cutover

`AdminSession` gains a required `iat` (epoch seconds). `issueSession` writes `iat: now`; the
current `authAt` stays unchanged because it is the IdP's interactive `auth_time`, not the time
that the IdP asserted the group claim.

- `ADMIN_SESSION_TTL_SECONDS` becomes **3,600 seconds**.
- `buildSessionCookie` and `exp` use that same constant; so do its other consumers, which follow it
  with no logic change: the signed-in-operators window in `console/handlers/access.ts` and the
  settings display in `console/handlers/platformSettings.ts`. THREAT-MODEL’s admin-session section,
  which states eight hours, is updated.
- `verifySession` requires integer `iat`, `iat <= now + SESSION_CLOCK_SKEW_SECONDS` (60),
  `iat + TTL === exp`, and `exp > now`. It rejects legacy cookies without `iat`; this is an
  intentional one-time re-login, not a fallback to `exp - newTTL`.
- `isAdminSessionRevoked` reads `session.iat` instead of deriving mint time from `exp - TTL`.
  This avoids the transition bug where an old 8-hour cookie is misread as newly minted after the
  TTL is shortened and can survive a later revocation mark.
- The HMAC domain remains `pkey.admin.v1|`: an added authenticated member is backward compatible
  cryptographically, while new verification deliberately rejects legacy bodies. ST-30 retains its
  planned cookie-v2 domain bump when it replaces this cookie with `memberId`/`sid`.

The resulting automatic guarantee is: after an IdP removes an operator from the configured group,
their existing console authority ends no later than one hour after the cookie was minted; a new
login is rejected by the existing callback gate (`console/auth.ts:369-389`). One named constant,
`SESSION_CLOCK_SKEW_SECONDS = 60` (the allowance `isSteppedUp` already uses), is the only skew
allowance in this design. The verifier’s future-`iat` check and the revocation write in §6.2 both
use it, because revocation correctness depends on the two numbers being the same.

### 6.2 Immediate targeted revoke

Add one platform route:

```text
POST /manage/api/platform/console-sessions/revoke
body: { "subject": "<OIDC sub>" }
```

It is `area: "platform"`, requires `stepUp: true`, validates a non-empty bounded subject string
(the cookie’s `sub`), then calls `revokeAdminSessions(env, subject, now, { padSkew: true })`. It
never accepts a subject from a cookie or URL path. The handler:

- writes the existing `admin-revoked` artefact with the skew-safe mark below, for the one-hour
  session TTL plus the skew allowance, and answers 5xx, never `{ ok: true }`, if the store write
  fails;
- records a platform audit/security event naming the verified actor and target subject, without
  returning any session material;
- answers `{ ok: true }` regardless of whether the target currently has a cookie, so it is not an
  oracle for operator presence;
- is documented as the required second step after IdP group removal. Removing the group first
  prevents immediate re-login; this route kills every cookie minted at or before the revocation
  instant, within the skew bound below.

**Skew-safe ordering.** The verifier accepts a cookie whose `iat` is up to 60 seconds ahead of its
own clock, and `isAdminSessionRevoked` compares that authenticated `iat` with the mark. A cookie
minted just _before_ a revocation on an isolate whose clock runs ahead can therefore carry an `iat`
greater than a mark written from the revoking isolate’s `now`, and would survive to its expiry. The
targeted route closes this by writing `mark = now + SESSION_CLOCK_SKEW_SECONDS` with a TTL of
`ADMIN_SESSION_TTL_SECONDS + SESSION_CLOCK_SKEW_SECONDS`. The comparison stays `iat <= mark`, so the
artefact format is unchanged. The assumption is pairwise, the one the future-`iat` check already
makes between a minting and a verifying isolate: no two of the minting, revoking, verifying and
store clocks differ by more than `SESSION_CLOCK_SKEW_SECONDS`. Under it the two pads do separate
jobs. The value pad covers a minter running up to 60 seconds ahead of the revoker, so every cookie
minted at or before the revocation instant has `iat <= mark` and is refused. The TTL pad covers a
minter running up to 60 seconds ahead of the verifier and the store: the mark (3,660 seconds from
the write, on the store’s clock) reaches `mark + 3,600`, the latest `exp` of any cookie it covers,
so a revoked cookie never becomes valid again. Both hold with zero margin at the bound; skew beyond
it is outside the supported envelope and is not covered.

The consequences are stated rather than hidden:

- a cookie minted in the minute _after_ the revocation is refused too. Left alone, the sign-in
  callback would mint it and the SPA would loop login, callback, 401, so the callback evaluates the
  same mark against the session it is about to mint (`isAdminSessionRevoked`, one extra single-use
  read at login only) and, when it is revoked, renders a try-again page without minting a cookie. It
  records `admin.signin.refused` (naming the revocation window and the actor’s `sub`, so a
  just-revoked identity’s retry stays visible) and never `admin.signin`, which keeps the signed-in
  list truthful. That is intended for offboarding and incident use (the callback already refuses a
  removed operator) and means ST-31’s “Sign out everywhere” has a one-minute re-login delay for its
  own user;
- the write is monotonic: it never lowers an existing mark and keeps the later expiry. A later self
  sign-out (exact `now`) must not undo a padded mark, so the single-use store’s `put` gains one
  numeric keep-max option, executed inside the shard’s input gate because a get-then-put pair is
  not atomic;
- the self sign-out (`console/routes.ts:62-79`) keeps its exact `now` mark and TTL. Padding it
  would void the cookie of an immediate re-login, which is the common case. Its residual, now
  documented: a cookie minted within the final 60 seconds before a self sign-out, on an isolate
  whose clock runs ahead, can outlive that sign-out for up to its one-hour life. The targeted route
  is the containment control; self sign-out is not;
- the revocation read fails open when the single-use store is unreachable (the store’s existing
  policy, `sessionRevocation.ts`), so during a store outage a revoked cookie lives until its
  expiry, at most one hour. `ADMIN_SESSION_SECRET` rotation is the unconditional fallback, and the
  runbook says so.

The first UI is intentionally not added here. Until ST-31's Members page exists, the platform
operator invokes the endpoint from the documented emergency procedure. ST-31 consumes this route
for its planned “Sign out everywhere” action instead of inventing another revocation mechanism.

### 6.3 Shared call paths and admin UX

Both protected surfaces already use the same reader:

- `/manage/api/*` → `resolveConsoleCaller` → `sessionFromRequest`;
- gated `/docs` pages → the same `resolveConsoleCaller` (`docs.ts:242-249`).

No second group-check implementation is permitted. A one-hour expiry therefore protects the docs
gate too.

`packages/admin/src/api.ts` currently sends ordinary 401s to `/manage/login` without `returnTo`
(`:4215-4224`), while step-up preserves the hash route. The implementation changes ordinary-login
redirects to preserve `/manage/<hash>` through the existing allowlisted `returnTo` mechanism. It
does not promise to retain unsaved form state; the UI must show the effective expiry returned by
`/api/me` so users can finish a form before a re-login. `handleMe` continues returning
`sessionExpiresAt`, now one hour after issue.

### 6.4 Measured request cost and rejected alternatives

A throwaway test using the existing SQLite/real-DO-mock harness measured the current code path;
it was deleted and is not part of this PR. Counts below are exact mock operation counts for one
request. Node in-memory CPU timing was only indicative and is not a production latency claim.

| Current request                 | Measured D1 |                                         Measured DO calls | KV / outbound | Result relevant to this plan                      |
| ------------------------------- | ----------: | --------------------------------------------------------: | ------------: | ------------------------------------------------- |
| `resolveConsoleCaller` only     |           0 |                                        1 `SINGLE_USE.get` |         0 / 0 | session HMAC + revocation mark only               |
| `GET /manage/api/me`            |     2 reads |                     1 `SINGLE_USE.get`, 1 rate-limit call |         0 / 0 | normal console bootstrap                          |
| gated `/docs/operate/platform/` |           0 |                                        1 `SINGLE_USE.get` |         0 / 0 | same cookie reader, no D1 principal lookup today  |
| revoked cookie                  |           0 |                                        1 `SINGLE_USE.get` |         0 / 0 | immediate denial already works once marked        |
| `POST /api/logout`              |           0 | 1 `SINGLE_USE.get`, 1 rate-limit call, 1 `SINGLE_USE.put` |         0 / 0 | targeted revoke has the same one-time write shape |

The chosen one-hour TTL plus `iat` adds **zero D1/KV/DO/outbound operations per authenticated
request**: one integer validation/comparison is added during existing HMAC verification. The
revoke endpoint adds one existing-store write and one audit write only when used.

A genuine re-login has a known one-time cost rather than a request-path cost: login/callback uses
rate-limit and single-use operations; the production verifier performs discovery (cached one hour),
a token exchange, and a JWKS fetch (cached). Its real network latency must be measured in staging;
it was not fabricated here. At one hour, an eight-hour active day causes at most about eight such
reassertions per operator rather than one. That UX/availability cost is the reason the duration is
a human decision below.

Rejected alternatives:

| Alternative                                      | Why it is not the smallest enforceable design                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-request IdP `userinfo`/introspection         | Needs a retained access/refresh token and adds a remote dependency to the request path.                                                                         |
| Refresh-token renewal in the Worker              | Needs `offline_access`, sealed per-session refresh-token custody, rotation/race handling, and proof that Pocket ID refresh responses carry fresh groups.        |
| Back-channel logout / SCIM / an IdP admin poller | No confirmed Pocket ID group-change signal; logout does not necessarily accompany group removal. An admin poller adds a standing high-privilege IdP credential. |
| Only the targeted revoke route                   | Immediate when invoked, but not an automatic upper bound if offboarding procedure is missed.                                                                    |
| One global session epoch                         | Duplicates the existing secret-rotation emergency lever and adds a platform-wide read or deploy coupling without solving group freshness.                       |

### 6.5 ST-30 / ST-31 hand-off

This plan amends the future implementation, not its account model:

- **ST-30:** its `account_links.asserted_at` root-rule check uses the approved one-hour
  `ROOT_ASSERTION_MAX_AGE_SECONDS`, not the former eight-hour `ADMIN_SESSION_TTL_SECONDS` rule.
  Its v2 cookie/session row may remain eight hours for non-root account state, but a stale root
  assertion returns reauthentication-required rather than a root grant.
- **ST-31:** calls the stable revoke endpoint from Members “Sign out everywhere”; it must not add a
  second session store or revocation format.
- **ST-35/RUNBOOK:** state that group removal is “remove group, revoke sessions, verify 401; the
  automatic maximum is one hour,” replacing the stale statement that rotating the secret is the
  only containment, that the revoked operator cannot sign back in for one minute after the revoke
  (§6.2), and that during a single-use store outage the revoke does not take effect and
  `ADMIN_SESSION_SECRET` rotation is the fallback.
- **ST-30 and the recovery script (§6.7, if accepted):** ST-30’s v2 cookie (`pkey.admin.v2|`, body
  `{sub: memberId, …}` with no `groups`) changes what the script must mint, and ST-28 §2.6 defines
  the break-glass principal rules. ST-30 owns porting the script and its rehearsal, and its cookie-v2
  release is not complete without a ported, rehearsed recovery mint (or an explicit, owner-signed
  removal of the path): once the signing tag moves, every v1 cookie the script mints is refused.

### 6.6 Tests

1. Unit tests at exact boundaries: `iat + 3,599` succeeds; `iat + 3,600` fails; `iat = now + 60`
   is accepted and `now + 61` refused; mismatched `iat`/`exp`, missing `iat`, and malformed values
   fail closed.
2. Deploy-cutover test: an old body lacking `iat` is refused, proving no old eight-hour cookie can
   exploit new TTL-derived revocation arithmetic.
3. Targeted-revoke route: a target’s two cookies and no other subject’s cookie are rejected; a
   re-login after the IdP group is removed is refused; the response is not a target-presence
   oracle; the audit event names the verified actor and target and carries no session material; an
   empty, oversized or non-string subject is rejected; a failed store write answers 5xx; the route
   requires platform authority, CSRF, and fresh step-up.
4. **Skew boundary** (injected clocks, real store). With the revoking isolate reading `N`: a cookie
   minted just _before_ the revoke by an isolate running 60 seconds ahead (`iat = N + 60`) is
   refused after it, as is one minted at `N`; a cookie with `iat = N + 61` is outside the supported
   skew and not covered by the mark (presented at `now = N + 2`, so the verifier’s own future-`iat`
   check passes); cookies minted at `N + 1` and `N + 30` are refused (the one-minute re-login delay)
   while one minted at `N + 61` is accepted. The callback inside the window renders the try-again
   page, mints nothing and records `admin.signin.refused` (not `admin.signin`); after the window it
   signs in. The pairwise envelope is exercised at its two extremes, each with its 61-second
   negative: minter +60 with revoker and verifier at 0 (coverage: the value pad refuses the
   cookie), and verifier −60 with minter and revoker at 0 and the store on the revoker’s clock
   (lifetime: the TTL pad keeps the mark alive until the verifier’s own `exp` check ends the
   cookie). The combined case (minter +60, verifier −60) is outside the envelope; if kept it is
   labelled so and asserts only the 60-second tail.
5. Mark lifetime: a padded cookie (`iat = N + 60`) is still refused at `N + 3,659`, and at
   `N + 3,660` the mark and the cookie both end, so a revoked cookie never becomes valid again.
6. Monotonic write: a later self sign-out (`mark = now`) neither lowers a padded mark nor shortens
   its expiry; a higher later mark replaces it. Store-level tests cover the keep-max option
   (non-numeric input refused, a plain `put` still replaces), and the concurrent-write race runs in
   the workerd lane (`test-workerd/singleUse.test.ts`), because the unit mock serialises requests
   and cannot show the input-gate property.
7. Self sign-out regression: it still writes an exact `now` mark with the session TTL, and the
   cookie of an immediate re-login (at `N + 1`) is accepted.
8. Regression tests for both `/manage/api/*` and gated docs prove they share the one-hour reader.
9. Admin SPA tests prove generic 401 redirect carries an allowlisted `returnTo`; `/me` displays the
   effective one-hour deadline.
10. Route pins and gates: `routeCoverage` (the OpenAPI path and the `ADMIN_KIND_PATHS` entry),
    route-area drift (`rbacRouteAreas`), the RBAC matrix and its step-up list, the step-up route
    table, admin CSP parity, and the existing sign-out replay tests are updated for the new row and
    stay green.
11. Add a focused request-cost regression test: resolving a valid console caller must retain one
    `admin-revoked` store read and no D1 read. It counts calls through real test DO mocks, not a
    reimplementation.
12. If §6.7 is accepted: the recovery-session script mints a cookie that `verifySession` accepts
    only under the matching secret and only with `exp = iat + 3,600`; a `recovery` session never
    satisfies `isSteppedUp`, even when its body carries a `stepUpAt`, so it cannot call the targeted
    revoke; its audit event is written once per `(sub, iat)` across repeated requests, a docs-first
    request (no database, so the first API request records it) and a failed first write (the next
    request retries); the login callback never sets `recovery`.

### 6.7 Optional: break-glass recovery when the IdP is down (owner decision)

Renewal now needs the IdP at least once an hour. If Pocket ID is unreachable when a cookie expires,
no operator can sign in, possibly during the incident that caused the outage. This plan proposes
no refresh token and no fail-open grace. (This is unrelated to ST-20’s manifest “break-glass
claims”, to the signing-key break-glass activation, and to ST-28 §2.6’s IdP-verified
`/manage/login?breakGlass=1` session, whose cookie member is `bg`. That one needs the IdP to be up;
this option exists for when it is down and uses a different member, `recovery`, so the two never
share rules.)

**Default if the owner declines.** Recovery is infrastructure access, not the console: whoever can
write Worker secrets can end every console session (`wrangler secret put ADMIN_SESSION_SECRET`,
RUNBOOK “Who can use the console, and lockout recovery (ST-29)”), roll the Worker back or
redeploy, and reach D1 and the Cloudflare dashboard. Console-only actions wait for the IdP.

**The option: an offline-minted recovery session.** It adds no route, no standing credential and no
environment variable. It formalizes what a Worker-secret writer can already do, so that it is
rehearsed instead of improvised:

1. **Trigger and authority.** The incident commander confirms the IdP outage (the sign-in callback
   or discovery fails) and records the approval; the operator holds Worker-secret write access.
   Whether a second person must approve is the owner’s decision.
2. `wrangler secret put ADMIN_SESSION_SECRET --env <env>` with a fresh random value that stays in
   the operator’s shell. This ends every other console session, so all operators see the event, and
   nobody else can forge a cookie.
3. A repo script under `packages/worker/scripts/` mints one cookie from that secret through the
   production `issueSession`: the operator’s real OIDC `sub` (audit attribution stays correct),
   `groups = [<the configured group>]` (production’s `PLATFORM_ADMIN_GROUP` is a write-only Worker
   secret, so the recovery runbook records its value or the script takes it as a required input),
   `iat = now`, `exp = iat + 3,600`, an authenticated `recovery: true` member (`SessionIdentity`
   gains `recovery`; the login callback never sets it), and **no** `stepUpAt`. It reads the secret
   from stdin or the environment, never argv, and prints the cookie value for the browser’s
   `__Host-pkey_admin`.
4. Work. Each cookie the script mints lives about an hour: the verifier’s `iat`/`exp` rules cap it
   at `now + 3,660` seconds even when forged by a secret holder. `isSteppedUp` refuses `recovery`
   sessions, so step-up routes (relink, targeted revoke, …) stay unavailable. Recovery restores
   _access_, never _step-up_; the global lever for revoking an operator remains the secret rotation
   in step 2.
5. After-action. When the IdP is back, rotate `ADMIN_SESSION_SECRET` again to a value nobody holds,
   which ends the capability and any outstanding recovery cookie. Never `wrangler rollback` to a
   version created between steps 2 and 5: the version list identifies them (each carries the
   recovery secret), the runbook names them as off limits, and if a rollback to one happens anyway,
   rotate `ADMIN_SESSION_SECRET` again at once (a rollback restores the previous secret value and
   revives outstanding recovery cookies, the hazard §7 cites). Record the incident and review the
   audit event below and the actions taken.

**Visibility, honestly stated.** The first request of a `recovery` session records one platform
audit/security event per `(sub, iat)`: the dispatcher writes the audit row with an id derived from
that pair as an insert-or-ignore (`recordPlatformSecurityEvent` gains an optional id for it), so
repeats are no-ops and a failed write is retried by the next request. It does so only when it has a
database (the docs gate calls the reader with none, so the first `/manage/api/*` request records
it), and only `recovery` sessions pay that extra write per request, so the request-cost test above
still holds for ordinary sessions. Honest use therefore leaves a timeline. A forger who holds the
signing secret can omit `recovery`, so this is visibility, not a control. The controls are
infrastructure custody, the all-sessions-die side effect, the Cloudflare account audit trail (the
rehearsal confirms it records the secret write), and the after-action rotation.

**Cost.** Anyone with Worker-secret write access can already forge a cookie by reading this
repository. The option adds no privilege: one small script, one authenticated claim and one
idempotent audit write. It does not weaken the one-hour bound or the step-up gate.

## 7. Rollout and rollback

1. **Before deploy:** owner confirms the Pocket ID client reissues current `groups` claims on an
   ordinary authorization-code login, confirms the operator SSO-session policy supports the
   selected one-hour experience, and decides the break-glass option (§6.7). If it is accepted, its
   staging rehearsal passes before the one-hour cookie ships, so the shorter bound never lands
   without a recovery path.
2. **Deploy once:** code rejects legacy cookies without `iat`; every operator signs in again. This
   is intentional and avoids the old-TTL revocation bypass.
3. **Runbook:** immediately after IdP group removal, invoke the targeted revoke endpoint and verify
   the target receives 401 on a pre-existing cookie; expect the target’s own re-login to be refused
   for one minute (§6.2). If the single-use store is degraded the revoke may not take effect, and
   `ADMIN_SESSION_SECRET` rotation is the global emergency fallback.
4. **Observe:** alert/record stale-session re-logins, callback refusals (removed operators and
   revocation-window retries), and revoke actions. Review operator friction after one week before
   considering a different bound.
5. **ST-30 integration:** retain the one-hour root assertion rule when its session-row design lands.

Rollback before a security incident means restoring the prior code only if the owner accepts the
old eight-hour exposure. Do **not** roll back an incident response after rotating
`ADMIN_SESSION_SECRET`: Worker version rollback can restore old secret bindings, as documented in
`docs/security/arch/operational-resilience.md` §1.3. The targeted revoke marks stay in the store
across a code rollback because their artefact format is unchanged, but the old code reads them
differently: it derives `iat = exp - 8 hours`, so under it a padded mark refuses every cookie of
that subject while the mark lives (conservative, not “the same”), and the old verifier accepts
unexpired pre-cutover eight-hour cookies that the new verifier refused for lacking `iat`. Once a
mark lapses (at most 3,660 seconds after the revoke) such a cookie validates again, so a rollback
across the cutover while any revoke is in force must be followed by an `ADMIN_SESSION_SECRET`
rotation, made after the rollback to avoid the un-rotation hazard above.

## 8. Risks and decisions for the human

1. **Assertion window — decide 1 hour, 2 hours, or retain 8 hours.**
   - **Recommend one hour.** It reduces automatic group-removal and stolen-cookie authority from
     eight hours to one hour with zero added request I/O.
   - Cost: top-level SSO return approximately once per active hour; unsaved SPA form data is not
     retained. The route is retained, not form drafts.
2. **Pocket ID behavior — required input.** Confirm ordinary authorization-code SSO is silent when
   its session is alive and always emits current `groups`; supply the client/session-duration
   policy. Do not rely on unverified `prompt=none`, refresh-token, back-channel-logout, or SCIM
   behavior.
3. **Targeted revoke now — decide yes/no.**
   - **Recommend yes.** It reuses a live, tested revocation primitive, costs no additional request
     read, and eliminates the need to rotate every admin secret for one known compromise.
   - Cost: the mark is skew-padded, so the revoked subject’s own re-login is refused for one
     minute (§6.2), and the primitive gains one monotonic keep-max option in the single-use store.
   - If declined, the runbook must state that `ADMIN_SESSION_SECRET` rotation is the only immediate
     containment action until ST-31.
4. **Approved-plan amendment.** Accept the one-hour root-assertion rule as an amendment to
   `plans/ST-28.md` Q3 and require ST-30 to inherit it, including (if decision 6 is accepted) a
   ported, rehearsed recovery mint in its cookie-v2 release. Keeping the prior eight-hour decision
   is a conscious residual-risk acceptance, not an implementation default.
5. **Availability.** A Pocket ID outage can block renewal after one hour. Confirm whether the
   platform accepts that tighter dependency or wants a two-hour bound instead; no unsafe
   fail-open grace is proposed. The recovery path is decision 6.
6. **IdP-outage break-glass recovery (§6.7) — decide yes/no.**
   - **Recommend yes, as the rehearsed offline-minted recovery session in §6.7.** It adds no route,
     standing credential or environment variable, cannot satisfy step-up, and an improvised version
     written under incident pressure is the riskier one.
   - If declined, the runbook states that an IdP outage longer than the cookie lifetime leaves
     infrastructure access (`wrangler`, the Cloudflare dashboard) as the only recovery path;
     consider the two-hour bound in decision 1.
   - Owner inputs if accepted: who may run it, whether a second person must approve, how often it is
     rehearsed, and that ST-30’s cookie-v2 release carries the ported mint (decision 4).

## 9. Acceptance

```sh
mise exec node@22 -- pnpm build
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test adminSessions
mise exec node@22 -- pnpm --filter @polaris-key/worker test singleUse
mise exec node@22 -- pnpm --filter @polaris-key/worker test rbacRouteMatrix
mise exec node@22 -- pnpm --filter @polaris-key/worker test rbacRouteAreas
mise exec node@22 -- pnpm --filter @polaris-key/worker test routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm gen --check
mise exec node@22 -- pnpm format
```

Plus the full green gate in `AGENTS.md` at implementation hand-off. Before marking an
implementation ready, exercise a real staging Pocket ID sign-in after group removal and record the
measured callback/cookie result; unit mocks cannot prove IdP claim freshness. If §6.7 is accepted,
its staging rehearsal (set the secret, mint a cookie, reach a non-step-up route, confirm step-up is
refused, rotate the secret again, confirm the cookie now gets 401, and confirm from the version list
which versions carry the recovery secret and that the runbook names them as never to roll back to)
is recorded before the one-hour cookie ships.
