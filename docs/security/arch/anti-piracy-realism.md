# Anti-piracy realism — architecture review

**Lens.** Is the licensing enforcement design sound, and does its cost match what it protects?
This is a graded architecture review, not a bug list. Individual vulnerabilities are cited as
evidence for architectural claims, not enumerated for their own sake — for those, see
`docs/security/findings/`.

**Scope.** The enforcement path only: Worker authorization (`licenseCore.ts`, `licensing.ts`,
`enroll.ts`), the four client gates (Node/Python/Swift/React), the offline cache, and the
hardware-fingerprint subsystem.

**Method.** Static reading plus two empirical checks, both run on Node 22
(`~/.local/share/mise/installs/node/22/bin`, per `docs/security/findings/BASELINE.md`):

1. `packages/sdk-node/test/R4-client-attack.test.ts` — **11/11 attack PoCs pass**, i.e. all 11
   documented client-side exploits work against HEAD.
2. A throwaway probe (written, run, deleted) confirming a freshness defect described in §3.2
   that no existing test covers.

---

## Verdict at a glance

| #   | Question                                                             | Grade  |
| --- | -------------------------------------------------------------------- | :----: |
| 1   | Where is the real trust boundary? Is it documented?                  | **D**  |
| 2   | Does the fingerprint machinery earn its complexity and privacy cost? | **C−** |
| 3   | Is the offline-grace design right?                                   | **D**  |
| 4   | What should the client gate promise, and does it?                    | **C**  |
| 5   | How does this compare to mature licensing systems?                   | **C+** |
| 6   | Ranked recommendations                                               |   —    |

**Overall: C−.** The server-side half of this system is genuinely well built — every
authorization decision is re-read from D1 on every request, tenancy is enforced in the primary
key, and the payload is validated against the catalog _before_ signing. The client-side half is
built as if it were also enforcement, and it isn't. The gap between those two halves is written
down nowhere an adopter will ever see it, which is the single most expensive defect in this
review: it means nobody downstream can tell which guarantees they are allowed to rely on.

The most striking thing about this codebase is that the _privacy_ engineering around
fingerprinting is better than the _enforcement_ engineering it exists to serve. That is an
unusual and telling inversion.

---

## 0. What is actually being protected

Before grading the mechanisms, name the assets, because every grade below is a cost/benefit
ratio and the denominator matters.

| Asset                                      | Manufacturable by a bypassed client?         | Real protection                                 |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------- |
| Config values (`payload.config`)           | **Yes** — invent any JSON                    | None needed; these are settings                 |
| Entitlement flags (`payload.entitlements`) | **Yes** — `{"pro": true}`                    | None; flags are claims, not capabilities        |
| Version/channel gating                     | **Yes** — client-side status is cosmetic     | Server 403 at `licensing.ts:527-540`            |
| Seat count                                 | **Partly** — see §2.3                        | Server `countActiveDevices` (`repo.ts:913-924`) |
| `payload.secrets`                          | **No** — must be sent by the server          | The server, **once**. See §4.3                  |
| Edge-minted tokens (`edgeMint.ts`)         | **No** — signed with a sealed product secret | The server, continuously                        |
| Release artifacts / updates                | **No**                                       | The server                                      |

Only the bottom three rows are genuinely defensible. That should drive everything: the
enforcement budget belongs on **gating server-delivered value**, not on convincing a local
process to refuse to run. Roughly the opposite is true of where the effort has gone.

---

## 1. Where is the real trust boundary? — **Grade: D**

### 1.1 The one-sentence version

> **Trust boundary: the Worker's network edge. A decision is _enforced_ only if it is made by
> the Worker from D1/KV state during a live request; everything the SDK computes from its
> on-disk cache is _presentation_, and must be assumed attacker-controlled.**

That sentence is actionable: it tells a developer that `client.isEntitled("pro")` is a _hint_
for drawing a badge, and that anything they actually care about must be a `getSecret()`, an
edge-mint call, or a server-side check.

### 1.2 The boundary is drawn in a defensible place

This is real and worth crediting. `validateDeviceToken` (`licenseCore.ts:442-476`) re-reads the
device row, the license row, and the token binding on **every** request, and re-checks:

- token hash → KV record, with a product-scoping check (`:453`) and a D1 fallback (`:456`)
- device exists and `status === 'authorized'` (`:467`)
- `device.license_id === rec.licenseId && device.token_hash === tokenHash` (`:470`)
- `licenseUsable(license, now)` — status and expiry (`:474`, `:143-150`)

Version/channel gating is likewise a server 403 (`licensing.ts:527-540`), seat cap is a server
`COUNT(*)` (`repo.ts:913-924`), and the doc payload is pruned against the active catalog before
signing (`configDoc.ts:33-55`). Nothing here is delegated to the client. There is **no cached
authorization** anywhere on the hot path. That is the correct architecture and it is why this
question grades D and not F.

### 1.3 Where the boundary is genuinely misplaced (not merely undocumented)

One defect is _not_ an "advisory client" trade-off. It is a trust-anchor compromise:

```ts
// client.ts:184-186
this.cache = await this.store.readCache();
if (this.cache?.trustedKeys) {
  this.trust = { ...this.trust, ...this.cache.trustedKeys };
}
```

`readCache()` is a bare `JSON.parse` with a cast (`store.ts:194-202`). So an unauthenticated,
attacker-writable file **widens the SDK's pinned Ed25519 trust set**. R4-02 proves the
consequence: after one file write, the client verifies and applies a document signed by an
attacker key _served over the network_ — not a forged cache entry, a fully "valid" signed doc
under a key the vendor never issued. The compromise persists until the cache is cleared, and the
same file also controls `lastTrustIssuedAt`, so R4-03 shows key **rotation can be permanently
disabled** — disarming the revocation mechanism itself.

This inverts the entire point of pinning. A pinned trust set that a local file can extend is not
pinned. Everything else in §3 is a policy question about how much offline tolerance to grant;
this one is a straightforward architectural error.

### 1.4 It is documented nowhere in the shipped tree, and one doc contradicts the code

**In the tracked tree at HEAD `bd26e0b`:** across `README.md`, `CONTRIBUTING.md`, and all six
files in `docs/`, there are **zero** occurrences of "trust boundary", "advisory",
"authoritative", or "tamper". There is no `SECURITY.md` and no threat model. The closest
statement in the entire shipped repository is a source comment:

```ts
// gate.ts:1-3
// The client license gate. Computes the renderable status from the cached signed doc +
// current time + the last sync outcome. The server enforces version/channel (a 403 →
// `blocked`); the client reflects that plus offline grace.
```

"Renderable" and "reflects" are exactly right. They are in a file no adopter reads.

**As of this audit,** `docs/security/THREAT-MODEL.md` (untracked, produced by the same review
program) now states an equivalent boundary in its §3 — _"The server's decision to send something
is the only enforcement. Everything the client does with what it received is advisory."_ That is
the right sentence and this review endorses it. Two things remain true regardless:

- **Three audiences, two now served.** `THREAT-MODEL.md` serves _maintainers_; the new
  `SECURITY.md` §Scope serves _researchers_, and does so well — it declares client-side bypass on
  one's own machine an accepted property while keeping in scope "a bypass that yields something
  the **server** would not have sent," which is precisely the §0 framing. The audience still
  unserved is the _adopter_ integrating the SDK: neither `ADOPTER-GUIDE.md` nor `CONCEPTS.md`
  says which APIs are enforcement and which are presentation. Recommendation 1 in §6 is therefore
  about **propagation to integrators**, not authorship.
- **One substantive disagreement, flagged for resolution.** `THREAT-MODEL.md` §6 lists _"casual
  license sharing"_ under **does stop**. This review concludes it does **not** — see §4.2.
  Casual sharing is precisely the hand-written-`managed.json` case, and R4-01 passes today.
  This matters more than a wording nit because `SECURITY.md` now _formally accepts_ the
  client-bypass risk by reference to that section: accepting a risk is sound, but accepting it
  against an overstated description of what the control stops is how a gap gets closed on paper
  and left open in code. §4.1's three-tier table is the reconciliation this review proposes —
  tier 2 should move from "does stop" to "will stop once §6 rank 3 lands."

Worse, `docs/CONCEPTS.md:65` states that a `secret` catalog entry is _"redacted, delivered to
the OS keyring."_ It is not. Both the Node and Swift SDKs read secrets straight out of the
plaintext cache file:

- `client.ts:249-254` → `doc.payload.secrets[key]`
- `PolarisKeyClient.swift:251` → `cache?.doc?.payload.secrets[key]?.value.stringValue`

The keyring holds the _device token_ only (`store.ts:232-263`). Secrets sit in
`~/.config/<product>/managed.json` at mode 0600 — readable by every process running as that
user, and by anything that backs up or cloud-syncs a home directory. This is a documentation
claim that would cause an adopter to make a materially wrong security decision.

### 1.5 Recommendations

1. Write the §1.1 sentence into a new `SECURITY.md` and into `docs/ADOPTER-GUIDE.md`, with the
   §0 asset table beside it. **Highest value-per-hour change in this review.**
2. Fix `client.ts:184-186`: the pinned trust set must be a floor, not a seed. Only accept
   `trustedKeys` that arrived inside a JWS verified under an _already-pinned_ key, and never
   let the cache remove or supersede a pinned kid.
3. Correct `CONCEPTS.md:65`, or implement what it claims. Given §0, actually moving secrets to
   the keyring is worth doing — they are one of only three genuinely defensible assets.

---

## 2. Does the fingerprint machinery earn its complexity and privacy cost? — **Grade: C−**

Short answer: the privacy design earns an A, the enforcement design earns a D, and it ships
**on by default** (`fingerprint.ts:177-181`, `DEFAULT_FINGERPRINT_POLICY = { enabled: true,
defaultMode: "normal" }`), so every user pays the cost.

### 2.1 What it costs

- Seven hardware signals read from every native install (`sdk-node/src/fingerprint.ts:184-197`),
  including platform UUID, board serial, MAC, boot-volume UUID, CPU model, RAM bucket, model ID.
- Parallel implementations in Node, Python, and Swift, a Worker matcher, protocol constants, a
  migration (`0010_fingerprint.sql`), admin panel surfaces, and conformance vectors.
- A four-level policy ladder (`off`/`lenient`/`normal`/`strict`), per-tier override resolution
  (`fingerprint.ts:149-156`), asymmetric drift counting, and an anchor bonus that conditionally
  widens tolerance by one (`fingerprint.ts:137-145`).
- A `PRIVACY.md` that exists _only because_ this feature exists (`docs/PRIVACY.md:3-6` says so).

### 2.2 What it genuinely buys — credit where due

Three things, and they are real:

1. **Free-tier dedupe actually works.** `enroll.ts` computes the hwid server-side
   (`:170`) and one-license-per-machine is enforced by a partial unique index, not by
   application logic (`0011_auto_issue.sql:28-30`), with a correct read-then-insert-then-reread
   race handler (`enroll.ts:57-89`). This is the strongest engineering in the whole feature.
2. **Honest hardware-swap UX.** A replaced machine gets a precise `hardware_mismatch` instead of
   a baffling `device_limit`, the stale binding is retired so it stops holding a seat, and the
   retry rebinds cleanly (`licenseCore.ts:288-330`). That is thoughtful.
3. **The privacy engineering is genuinely good.** On-device hashing with product-scoped domain
   separation (`fingerprint.ts:211-214`) means a leak of one product's table cannot be joined
   against another's; the server recomputes the hwid and never trusts the client's copy
   (`worker/src/fingerprint.ts:61-65`, `licenseCore.ts:386-388`) — a real anti-collision measure;
   components are omitted, never substituted; the browser SDK is deliberately excluded; rows are
   purged with the device. The asymmetric drift rule (`worker/src/fingerprint.ts:129-133`) — a
   _missing_ component counts, a _newly present_ one does not — is subtle, correct, and closes
   the obvious "omit everything that doesn't match" bypass.

### 2.3 What it does not buy, and the dead-code proof

**It is checked exactly once, in one place, under a condition that excludes first activation.**

`matchFingerprint` has exactly one production call site — `licenseCore.ts:292` — guarded by:

```ts
// licenseCore.ts:289
if (presented && mode !== "off" && existing?.status === "authorized") {
```

So the check runs _only_ when an **already-authorized** device re-activates. Consequences:

- First activation of a device id never matches anything.
- A device that was deauthorized and reactivates skips the check entirely (and
  `setDeviceStatus` already purged its fingerprint row).
- Steady-state operation never touches it: `validateDeviceToken` (`licenseCore.ts:442-476`) —
  the hot path for `/config`, `/config/report`, `/token`, and edge-mint — makes no fingerprint
  call at all. `/config` is a GET carrying headers only (`sdk-node/src/fetch.ts:41-51`); the
  fingerprint is never even transmitted after activation.

This means **`strict` mode does not deliver what its name promises.** Its documented contract is
zero drift (`CONCEPTS.md:52`); in practice it is "zero drift, but only on re-activation of a
device that is already authorized, and never thereafter."

**`findFingerprintByHwid` (`repo.ts:1098-1109`) has zero callers.** This is the one query that
would answer the question the whole subsystem exists to answer — _are these N seats N machines,
or one machine with N device ids?_ It is written, correct, commented, and never invoked. Seat
multiplication is trivial and the stored fingerprints would expose it:

```
$ echo "any-string-i-like" > ~/.config/<product>/device   # FileStore.getDeviceId, store.ts:187-193,
                                                          # returns the file's contents verbatim
```

Each new device id consumes a seat with an **identical** fingerprint. The server stores N
identical hwids and never joins on them.

**And the anonymous-enroll dedupe key is re-freed on claim.** `claimEnrolledLicense` sets
`enroll_hwid = NULL` (`repo.ts:748`), and `oidc.ts:398` does the same when disabling. The
comment is honest about it — _"Clearing `enroll_hwid` frees the unique index so the machine can
enroll again later"_ — but that is the farming loop: enroll anonymously → sign in to claim →
index freed → enroll anonymously again, unbounded except by a per-IP hourly rate limit
(`enroll.ts:128-142`).

**Fundamentally, client-side hashing means the server can never verify a fingerprint
corresponds to real hardware.** The hash formula is public and unsalted
(`FINGERPRINT_HASH_PREFIX = "pkey-hw"`, `protocol/index.ts:164`), so a patched client emits any
seven 22-character base64url strings it likes. Recomputing the hwid server-side prevents
_collision forging_, which is the right defence — but against a determined attacker a
fingerprint is just a second, client-chosen device id. This is inherent to any client-side
fingerprint and is not a criticism of the implementation; it is a reason not to over-invest.

### 2.4 Keep / change / delete

| Component                                 | Verdict              | Why                                                                                                                                                                             |
| ----------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On-device hashing + domain separation     | **Keep unchanged**   | Best-in-class; costs nothing                                                                                                                                                    |
| Enroll hwid dedupe + partial unique index | **Keep**             | The one part that actually enforces something                                                                                                                                   |
| `hardware_mismatch` retire-and-rebind     | **Keep**             | Good UX, correctly frees seats                                                                                                                                                  |
| Asymmetric drift counting                 | **Keep**             | Subtle and correct                                                                                                                                                              |
| `findFingerprintByHwid`                   | **Wire it up**       | Dead code that is the feature's whole point (§6, rank 5)                                                                                                                        |
| Fingerprint on `/config/report`           | **Add**              | Report is already a POST on every refresh (`client.ts:431-437`); re-check costs one D1 read, zero round trips                                                                   |
| `enroll_hwid = NULL` on claim             | **Change**           | Move to a `claimed_hwid` column; keep the machine known without blocking legitimate re-enroll                                                                                   |
| **Four-mode ladder + anchor bonus**       | **DELETE**           | Two modes (`off`/`on`) is the honest surface for a check that runs once. `strict` currently over-promises; `lenient`(4-of-7) tolerates so much it is indistinguishable from off |
| **Default `enabled: true`**               | **CHANGE to opt-in** | Collecting seven hardware signals from every user by default is not justified by a check this thin. Flip once §6 rank 5 lands                                                   |

---

## 3. Is the offline-grace design right? — **Grade: D**

### 3.1 The problem is the combination, not any single number

Individually, none of these is indefensible:

| Property        | Value                                       | Site                                                         |
| --------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Doc expiry      | 3600 s                                      | `protocol/index.ts:268`, `configDoc.ts:66`                   |
| Offline grace   | 30 days default                             | `0001_init.sql:19`; per-license override at `:75`            |
| Auto-refresh    | **off** unless `refreshIntervalSeconds` set | `client.ts:72-74`, `:190-198`                                |
| Clock source    | `Date.now()`, no monotonic floor            | `client.ts:115`; no `hrtime`/`monotonic` anywhere in any SDK |
| Cache integrity | none — JWS discarded after verify           | `client.ts:492-510`, `store.ts:194-202`                      |

A 1-hour doc TTL is good. A 30-day grace is within normal industry range (§5). Server-side
`max_offline_days` per license is the right knob in the right place.

The _combination_ is the failure. The signature is verified on fetch and then thrown away:

```ts
// client.ts:492-509 — verifyDoc() returns the decoded payload; res.jws is never stored
const doc = await verifyDoc(res.jws, { trust: this.trust, expectedAud: this.product, ... });
if (!doc) return { applied: false };
this.cache = { doc, etag: res.etag ?? undefined, lastAcceptedIssuedAt: doc.issuedAt, ... };
await this.store.writeCache(this.cache);   // plain JSON.stringify
```

Reload is `JSON.parse` (`store.ts:194-202`). So `graceUntil` — a server-controlled field
inside a signed document — becomes a **user-editable integer**. R4-01 proves the whole chain:
a hand-written `managed.json` with no signature at all grants arbitrary entitlements, arbitrary
secrets, and a 300-year grace, and additionally shows that `aud` and `deviceId` binding are
enforced _only_ on the network path (`verify.ts:25-26`), never on load — so a doc issued for a
different product and a different device is accepted from cache.

The anti-replay counter is stored in the same file, so R4-03 shows it is attacker-controlled in
**both** directions: set `lastAcceptedIssuedAt` to the far future and a genuine, correctly-signed
server doc is rejected forever (a self-inflicted denial of updates, pinning a forged doc);
delete the file and replay protection resets to zero.

And with no monotonic floor, R4-04 shows the client re-enters `ok` when the system clock is moved
back inside a long-expired doc's window — and never notices that its own recorded
`lastVerifiedAt` is in the future.

**The 30-day number is therefore not the issue. The practical grace period is unbounded for
anyone willing to edit a JSON file — and auto-refresh being off by default means the honest path
never even re-checks.** With `refreshIntervalSeconds` unset, a long-running desktop app fetches
config once at `init()` and then relies on that doc for up to 30 days. Remote re-licensing
(`licenseCore.ts:108-115`) and revocation only take effect at the next `refresh()`, which by
default is the next process start.

### 3.2 The inverse failure: honest users are mislabelled too

A design can be unsound in both directions at once, and this one is. The 304 path never refreshes
the doc or the verification timestamp:

```ts
// client.ts:460-465
case "not-modified":
  await this.patchCache({ blocked: undefined, lastSyncUnauthorized: false });
  return { applied: false };
```

The cached doc keeps its original `expiresAt = issuedAt + 3600`. The gate then evaluates
`now > doc.expiresAt → "grace"` (`gate.ts:47-53`). So a client that is **fully online and
successfully re-validating every hour** reports `status: "grace"` as soon as its config has been
stable for an hour — and `lastVerifiedAt` freezes at the last content change, so any "last
verified …" UI is wrong indefinitely.

Verified empirically (throwaway probe, since removed):

```
STATUS AFTER 1h OF 304s: {"status":"grace","graceUntil":1790317776,"lastVerifiedAt":1787725777062}
```

The existing test (`client.test.ts:337-407`) only asserts the 304 case _inside_ the 3600 s
window, so it passes and the defect is invisible. `grace` is supposed to mean "we could not reach
the server." Here it means "your config has not changed." That is a semantic collision between
the ETag optimisation and the freshness signal, and it makes the one status that carries
security meaning unreliable for honest users.

Fix: on `not-modified`, refresh `lastVerifiedAt` and treat a successful 304 as extending
freshness — or, better, separate "content identity" (the ETag) from "liveness" (a
`lastSuccessfulContact` timestamp) and gate on the latter.

### 3.3 What the fix actually buys against someone who can patch the binary

Nothing. And that is the correct answer — it is not what the fix is for.

The realistic threat is not a reverse engineer. It is the distribution economics of a bypass.
Today a working bypass is **a JSON file**: it fits in a Gist, a forum post, or a Discord message;
it requires no tooling; it survives application updates because it lives in the config directory;
and a non-programmer can apply it by copy-paste. That is the R4 threat model verbatim — _"an
ordinary local user with write access to the SDK's own config directory but WITHOUT the ability
to patch the shipped application binary."_

Persisting the JWS, re-verifying on load, and adding a monotonic floor changes the cheapest
bypass from _edit a text file_ to _patch and re-sign the application binary_. On macOS that
breaks the notarised signature and Gatekeeper; on Windows it breaks Authenticode; on both it
must be redone for every release; and the artefact that has to be redistributed is a multi-hundred-
megabyte binary rather than 40 lines of JSON. Empirically, that is the difference between a crack
that spreads and one that does not.

So: the fix buys nothing against a determined cracker, buys **everything** against casual
sharing, and costs roughly a day. That is an excellent ratio, and it is the correct reason to do
it — not because it makes the system "secure."

One caveat worth stating plainly: re-verification does **not** protect `payload.secrets` at rest.
Those are plaintext in `managed.json` regardless (§1.4, §4.3). Re-verification protects the
_gate_, not the _payload_.

### 3.4 The right shape

| Knob                        | Today             | Recommended                                                           | Rationale                                                                                                                                                                                               |
| --------------------------- | ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doc TTL                     | 3600 s            | 3600 s                                                                | Correct                                                                                                                                                                                                 |
| Auto-refresh                | off               | **on**, 6–12 h with jitter                                            | Without it, revocation and re-licensing are inert. The comment at `client.ts:72-74` correctly worries about changing shipped behaviour — ship it as a new default for new integrations, opt-out for old |
| Grace, paid licenses        | 30 d              | 30 d                                                                  | In line with industry (§5)                                                                                                                                                                              |
| Grace, **auto-issued free** | 30 d (inherits)   | **24–72 h**                                                           | Free licenses have zero acquisition cost and no revocation lever; long grace on them protects nothing and only extends abuse windows                                                                    |
| Cache integrity             | none              | **persist JWS, re-verify on load**                                    | §3.3                                                                                                                                                                                                    |
| Bindings on load            | network only      | re-assert `aud` + `deviceId` on load                                  | `verify.ts:25-26` already has the logic; it just isn't run on the cache path                                                                                                                            |
| Clock                       | wall clock        | **monotonic floor** (persist max-seen time; refuse to move backwards) | Closes R4-04 for one persisted integer                                                                                                                                                                  |
| 304 handling                | freezes freshness | refresh liveness on 304                                               | §3.2                                                                                                                                                                                                    |

---

## 4. What should the client gate promise? — **Grade: C**

### 4.1 Three tiers, and where the line belongs

| Tier                      | Adversary                                                                                           | Achievable?                             | Should this system attempt it?                     |
| ------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| **1. Honest mistakes**    | Expired card, wrong build, revoked seat, clock drift                                                | Yes, cheaply                            | **Yes** — this is the product                      |
| **2. Casual sharing**     | A user pasting a "crack" someone posted; a shared license across an office; a copied home directory | Yes, for ~1 day of work                 | **Yes** — this is the economically meaningful tier |
| **3. Determined cracker** | Patches the binary, NOPs the check, MITMs with a swapped trust anchor                               | **No** — the code runs on their machine | **No.** Every hour spent here is wasted            |

The correct promise is short:

> The client gate guarantees **honest, correct UI state for a non-adversarial user**, and
> **fails shut when the server says no while the client is online**. It guarantees **nothing**
> against a user who edits their own files or patches their own binary. Anything of real value
> must be a server-delivered secret, an edge-minted token, or a server-side check.

### 4.2 Which tier this design actually achieves

**Tier 1 only.** It does not currently reach tier 2, because tier 2 _is_ the pasted-JSON case,
and R4-01 is exactly that attack, passing.

This is a smaller gap than it sounds. The mechanism is sound; it simply stops one step short.
Every ingredient for tier 2 already exists: `verifyDoc` (`verify.ts:15-34`) already checks
signature, audience, device binding, and monotonic `issuedAt`. It is called on the network path
and not on the cache path. The fix is to call the same function in `readCache()` — plus persist
the JWS to call it against. This is a wiring problem, not a design problem, and it is why this
question grades C rather than F.

The gate's _own_ internal logic is correct and admirably consistent: `gate.ts:34-59`,
`gateModel.ts:45-68`, `license.py:license_state`, and `Gate.swift:80-93` are exact mirrors, in
the same order, pinned by the conformance corpus. That cross-SDK discipline is a real asset — it
means one fix, applied four times, actually holds.

### 4.3 The secrets caveat, stated plainly

`payload.secrets` is correctly identified as the thing a bypassed gate cannot manufacture. But it
is only un-manufacturable **once**. After a single successful fetch on a single legitimately
licensed machine, every secret sits in plaintext in `managed.json` (`client.ts:249-254`), and
that file is as shareable as any JSON file. A secret is therefore not a per-seat control; it is a
**per-product** control that any one paying customer can leak permanently.

If secrets are load-bearing — and per §0 they are one of only three defensible assets — they need
to behave like the token does: OS keyring storage, short TTL, and ideally not embedded in the
long-lived config doc at all. The edge-mint pattern (`edgeMint.ts`) is the right model already
present in this codebase: short-lived, server-minted, per-request. Extending it to cover
high-value secrets, rather than shipping them in a 30-day-cacheable document, would be the
structurally correct answer.

### 4.4 A corollary worth naming: the detection surface is poisoned too

R4-05 proves something that matters more than it first appears. `reportSnapshotBody()`
(`client.ts:574-596`) reads the cached doc's config and entitlement maps and POSTs them to
`/config/report`, where the Worker stores them as the device's reported state
(`licensing.ts:592-599`). So a forged cache does not merely bypass the gate — it **writes the
forgery into the control plane as ground truth**, where the admin panel renders it as the
device's real configuration.

The practical consequence: the operator's only client-side telemetry is authored by the same
party they are trying to detect. A bypassed install looks, from the admin panel, exactly like a
legitimate one on a higher tier. This is worth internalising because §5 shows that mature
vendors lean heavily on _detection and reconciliation_ rather than on client enforcement — and
that strategy requires at least one signal the client cannot author. Today there is none.

Server-side signals the Worker already has, and which the client cannot forge, would be a much
better basis: `device_limit` rejection rates per license, activation churn per license,
`hardware_mismatch` frequency, and (once rank 5 lands) N-device-ids-per-hwid. Those come from
D1, not from the client, and cost nothing to start recording.

### 4.5 What to write down

Add to `docs/ADOPTER-GUIDE.md`, next to the existing `isLicensed()` example at `:72`:

- `isLicensed()`, `isEntitled()`, `getConfig()` → **presentation**. Use for UI. Never gate a
  feature whose value exceeds the license price on these alone.
- `getSecret()`, edge-mint endpoints, server-side checks → **enforcement**. Gate real value here.
- The macOS app currently delegates licensing to its own embedded engine
  (`ADOPTER-GUIDE.md:47-49`), so this guidance must reach that engine too, not just SDK adopters.

---

## 5. Comparative check — **Grade: C+**

Grounded in current vendor documentation (August 2026), not recollection. Sources at the end of
this section.

### 5.1 How the field actually draws the line

| System                      | Trust anchor                                      | Verified when?                                               | Offline tolerance                                                  | Hardware fingerprint                                            |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Sparkle** (macOS updates) | `SUPublicEDKey` in the **code-signed app bundle** | **Every install**, fail-closed                               | n/a                                                                | No                                                              |
| **Keygen**                  | Account public key; Ed25519 default               | **Every decode/load** of a license file                      | Policy-set file TTL; Relay for air-gapped                          | Optional, customer-defined                                      |
| **Adobe CC**                | Server                                            | Re-validates **every 30 days**                               | 30 d grace (monthly) / **99 d** (annual); 7-day enterprise warning | No (named-user)                                                 |
| **JetBrains**               | Server / JBA                                      | Re-validates **every 30 days**; License Vault **every 48 h** | 30 d (JBA); 48 h (Vault); offline activation codes for air-gapped  | No                                                              |
| **Lemon Squeezy**           | Server only                                       | **Every check is a live API call**                           | **None** — no signed artifact, no grace                            | **No** — instances tracked by a caller-supplied `instance_name` |
| **Paddle Billing**          | n/a                                               | n/a                                                          | n/a                                                                | No first-party licensing at all                                 |
| **Polaris Key**             | Pinned keys **+ whatever the cache adds** (§1.3)  | **Once, on fetch; never on load**                            | 30 d, **with no re-validation cadence by default**                 | **Yes — 7 components, 4 tolerance modes**                       |

### 5.2 What is genuinely standard here

Credit where it is due — several choices are squarely best practice:

- **Ed25519-signed documents verified against a pinned public key, private key never leaving the
  server.** Identical in shape to Keygen ("private keys are kept securely encrypted on Keygen's
  servers and are never shared… all that is needed to cryptographically verify a license is your
  account's public key") and to Sparkle. `configDoc.ts` / `verify.ts` are correct here.
- **A short signed-document TTL with a longer offline grace on top.** This is exactly Adobe's
  structure — a re-validation interval, then a grace period after it fails.
- **Server-side activation with a seat cap and remote deactivation.** Matches Lemon Squeezy's
  activate/validate/deactivate instance model and Keygen's machine model.
- **Per-license offline override** (`max_offline_days`). Adobe varies grace by plan type; having
  that as a per-license column is the right generalisation.
- **A 30-day figure for paid licenses.** Squarely mainstream: JetBrains JBA is 30 days, Adobe is
  30 days monthly / 99 days annual. **30 days is not the problem** — see 5.3.

### 5.3 Where it is under-built — and the comparison is unflattering

Two omissions are unanimous across every comparator:

**(a) Nobody else verifies once and then trusts the decoded copy forever.** Keygen's
documentation is explicit that `issued` and `expiry` "should be checked **any time** a license
file's contents are decoded and verified, before being used elsewhere in your application, since
not checking them could result in a license file being used longer than its TTL allows." Sparkle
re-validates the signature on every install and fails closed. Polaris Key verifies on fetch and
discards the signature (`client.ts:492-510`), then reloads with `JSON.parse` (`store.ts:194-202`).
This is the single clearest deviation from documented practice in the review.

**(b) Nobody else has a grace period with no re-validation cadence underneath it.** This is the
comparison that reframes the 30-day question entirely. Adobe's 30 days is a **check-in interval**;
the grace period starts _after_ a check-in fails. JetBrains JBA is a **30-day maximum before you
must reconnect**. License Vault is 48 hours. Polaris Key's 30 days is a grace period with
**auto-refresh off by default** (`client.ts:72-74`) — so a long-running desktop app may perform
_zero_ re-validations inside its 30-day window.

> Adobe's "30 days" and Polaris Key's "30 days" are not the same number. Adobe re-checks every 30
> days and _then_ grants up to 99 more. Polaris Key grants 30 days and re-checks never. Measured
> as "maximum time a revoked license keeps working without contacting the server," Polaris Key's
> default is **more permissive than Adobe's**, despite looking stricter on paper.

Two further gaps:

- **No clock-tamper check.** Keygen tells integrators to verify "that `issued` is not greater than
  the current time (indicating clock tampering)," and its Relay product ships HMAC response
  signatures specifically "to detect clock tampering and spoofing." Polaris Key has no such check
  in any SDK — hence R4-04.
- **A mutable trust anchor is worse than every comparator.** Sparkle's anchor lives in the
  code-signed application bundle and Sparkle deliberately fails closed when a key present in the
  old bundle is absent from the new update, "preventing downgrade-to-unsigned attacks." Polaris
  Key lets an ordinary JSON file **add** trusted keys (§1.3). Sparkle refuses to let an update
  weaken trust; Polaris Key lets an unauthenticated local file strengthen an attacker's. This is
  the one dimension on which the design is behind _all four_ comparators, and it is why
  recommendation 2 outranks the more visible cache-integrity work.

### 5.4 Where it is over-built

**The fingerprint subsystem exceeds every comparator in ambition and trails them all in payoff.**

Lemon Squeezy — a commercially successful licensing product — performs **no hardware detection at
all**: instances are tracked by a label the integrator supplies, "so you decide what identifies a
device," with a per-license activation limit and no offline validation whatsoever. Paddle Billing
ships no first-party licensing. Keygen supports machine fingerprints but treats them as a
customer-chosen identifier rather than a verified hardware assertion. **None of them ships a
four-level drift-tolerance policy engine with an anchor bonus.**

That is not an argument that fingerprinting is wrong — the free-tier dedupe use case (§2.2) is
real and Lemon Squeezy simply does not have that problem. It is an argument that the _elaboration_
is unjustified: Polaris Key built the most sophisticated fingerprint matcher in this comparison
set and then called it once per device lifetime (§2.3). A simpler mechanism, invoked in more
places, would dominate it on every axis.

### 5.5 The consensus this review is applying

The position taken throughout — that client checks are friction and accounting, not security — is
the mainstream view, including among licensing vendors selling the opposite: "all software
copy-protection techniques can be circumvented — it's simply a matter of how badly the hacker
wants it," and a licensing system "only helps keep honest people honest." The corollary is that
"online license enforcement is considerably more resistant to cracking than offline protection,"
which is precisely why §0 puts the budget on server-delivered value.

One point of tension worth flagging for a product decision rather than a security one: there is a
credible argument that licensing should **fail open**, because "denying access or shutting down a
system running licensed software is a drastic response." Polaris Key's 30-day grace is already a
deliberate fail-open, and that is defensible. The recommendation in §3.4 is not to shorten grace
for paying customers — it is to make the _free_ tier's grace proportionate and to ensure the
re-validation that grace is supposed to follow actually happens.

### 5.6 Verdict

**C+.** The cryptographic primitives match best practice; the _lifecycle_ design — when you
re-verify and when you re-check in — sits below every comparator; and the fingerprint design sits
above all of them in cost and below all of them in return. The two changes that would move this to
a B are the two things every single comparator already does: **re-verify on load** and
**re-validate on a cadence**.

**Sources:**
[Keygen — offline licensing / cryptography](https://keygen.sh/docs/api/cryptography/) ·
[Keygen — signatures](https://keygen.sh/docs/api/signatures/) ·
[Keygen — offline licensing model](https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses/) ·
[Keygen Relay](https://github.com/keygen-sh/keygen-relay) ·
[Adobe — internet connectivity & offline grace](https://helpx.adobe.com/creative-cloud/kb/internet-connection-creative-cloud-apps.html) ·
[Adobe — FRL offline deployment](https://helpx.adobe.com/enterprise/using/frl-offline-deployment-guide.html) ·
[JetBrains — internet access FAQ](https://sales.jetbrains.com/hc/en-gb/articles/206544169-Do-I-need-to-have-Internet-access-to-use-JetBrains-products-) ·
[JetBrains — offline activation codes](https://sales.jetbrains.com/hc/en-gb/articles/360016995379-Activating-JetBrains-IDEs-with-an-offline-activation-code) ·
[JetBrains License Vault](https://www.jetbrains.com/help/license-vault-cloud/Activating_a_license.html) ·
[Sparkle](https://github.com/sparkle-project/Sparkle) ·
[Sparkle — EdDSA migration](https://sparkle-project.org/documentation/eddsa-migration/) ·
[Sparkle CVE-2025-0509](https://advisories.gitlab.com/pkg/swift/github.com/sparkle-project/sparkle/CVE-2025-0509) ·
[Lemon Squeezy — License API](https://docs.lemonsqueezy.com/api/license-api) ·
[Lemon Squeezy — activate](https://docs.lemonsqueezy.com/api/license-api/activate-license-key) ·
[Paddle — API keys / Billing](https://developer.paddle.com/api-reference/about/api-keys) ·
[SoftwareKey — 5 blatant truths about licensing and piracy](https://www.softwarekey.com/blog/software-licensing-tips/5-blatant-truths-software-licensing-systems-and-piracy/) ·
[SoftwareKey — cryptography and security](https://www.softwarekey.com/help/plus5/Content/Security.htm)

> **Deployment note (outside this review's scope, worth routing).** Sparkle **CVE-2025-0509**
> (fixed in 2.6.4) lets an attacker replace a signed update with another payload, bypassing the
> (Ed)DSA check. Polaris Key serves Sparkle appcasts (`README.md:7`, `ADOPTER-GUIDE.md:43`), so
> adopters' embedded Sparkle version should be confirmed ≥ 2.6.4. _(Since superseded: the Swift
> SDK's floor is now **2.9.6**, which adds the 2.9.5/2.9.6 delta-patch symlink and
> privilege-escalation fixes; see `sdks/swift/Package.swift`.)_

---

## 6. Ranked recommendations

Ordered by (what it actually prevents) ÷ (effort). "Prevents" is deliberately narrow — each row
says what the change stops **and** what it does not.

| #     | Change                                                                                                                                                                                                                                                                                                                  | Effort    | Actually prevents                                                                                                                    | Explicitly does **not** prevent                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **1** | **Propagate the trust boundary to integrators.** `THREAT-MODEL.md` §3 and `SECURITY.md` §Scope already cover maintainers and researchers; add the §0 asset table and §4.5 enforcement-vs-presentation guidance to `ADOPTER-GUIDE.md`, fix `CONCEPTS.md:65`, and resolve the §1.4 contradiction in `THREAT-MODEL.md` §6. | **2–4 h** | Adopters building real enforcement on advisory APIs; a risk being formally accepted against an overstated description of the control | Any attack. It prevents _wrong decisions_, which is why it is #1               |
| **2** | **Stop the cache widening the trust set.** `client.ts:184-186`: pinned keys are a floor; accept rotations only inside a JWS verified under an already-pinned kid.                                                                                                                                                       | **4–6 h** | Attacker-signed docs being accepted as genuine (R4-02); permanent disarming of key rotation (R4-03)                                  | Local gate bypass. This is about the _anchor_, not the gate                    |
| **3** | **Persist the JWS; re-verify on load; re-assert `aud`/`deviceId`; add a monotonic floor.**                                                                                                                                                                                                                              | **1–2 d** | The entire text-file crack class: R4-01, R4-03, R4-04. Moves the cheapest bypass to binary patching (§3.3)                           | A patched binary. By design                                                    |
| **4** | **Auto-refresh on by default** (6–12 h, jittered), opt-out for existing integrations. Promoted above the fingerprint work by §5.3: today the default is _more permissive than Adobe's_.                                                                                                                                 | **4 h**   | Revocation and remote re-licensing being inert for up to 30 days — currently the system's weakest real-world property                | Offline abuse. It makes revocation _work_; it does not make grace tamper-proof |
| **5** | **Wire up `findFingerprintByHwid`.** On activation and on `/config/report`, flag/refuse N device ids sharing one hwid.                                                                                                                                                                                                  | **1 d**   | Seat multiplication on one machine — the only thing that makes fingerprint collection justifiable                                    | Sharing across N _real_ machines (that is what the seat cap is for)            |
| **6** | **Fix 304 freshness** (§3.2): refresh liveness on `not-modified`; separate ETag identity from contact liveness.                                                                                                                                                                                                         | **2–4 h** | Honest online users being labelled `grace`; permanently stale "last verified" UI                                                     | Nothing adversarial — this is a correctness fix                                |
| **7** | **Shorten grace for auto-issued licenses** to 24–72 h; keep 30 d for paid (§5.2 confirms 30 d is mainstream for paid).                                                                                                                                                                                                  | **2 h**   | Long-lived abuse of zero-cost licenses                                                                                               | Paid-license abuse                                                             |
| **8** | **Move `payload.secrets` to the keyring**, and prefer edge-mint for high-value material.                                                                                                                                                                                                                                | **1–2 d** | Casual exfiltration of the one genuinely un-manufacturable asset (§4.3)                                                              | A determined extractor. Raises cost from `cat` to code                         |
| **9** | **Track `claimed_hwid`** instead of `enroll_hwid = NULL` on claim (`repo.ts:748`, `oidc.ts:398`).                                                                                                                                                                                                                       | **4 h**   | The enroll → claim → re-enroll farming loop                                                                                          | Farming across genuinely different machines                                    |

**Sequencing.** Ranks 1, 2, 4 and 6 total under two days combined and require no schema change or
protocol change — that is the first pass. Rank 3 is the one substantial engineering item and
should follow immediately, because ranks 4 and 7 only shrink the _window_ of an offline bypass
while rank 3 is what makes the window mean anything. Ranks 5 and 9 are the fingerprint
subsystem's justification; if they are not going to be done, apply the §"What to remove" guidance
instead and stop collecting the data.

### What to remove

Removal is a recommendation, not an oversight. Each of these costs maintenance, surface area, or
user trust, and returns less than it costs:

| Remove                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The four-mode fingerprint ladder** (`off`/`lenient`/`normal`/`strict`) → collapse to `off`/`on` | Four tunable modes, a per-tier resolution path (`fingerprint.ts:149-156`), a tolerance table, and an anchor bonus that conditionally widens by one — all governing a check that runs at most once per device lifetime (§2.3). `strict` over-promises ("zero drift") and `lenient` (4 of 7 components may change) is not meaningfully different from `off`. This is a policy engine for a decision that is made once |
| **Default `fingerprint.enabled: true`** → opt-in                                                  | Seven hardware signals from every native user, by default, for a check with the coverage described in §2.3. Once rank 5 lands and the data is actually load-bearing, revisit — but shipping collection-by-default _ahead_ of the enforcement that justifies it is backwards                                                                                                                                         |
| **`lastAcceptedIssuedAt` as a bare cache field**                                                  | Attacker-controlled in both directions (R4-03) and currently a self-DoS vector. If rank 3 lands it becomes meaningful; if rank 3 is deferred, this field is a liability, not a protection, and should be dropped rather than left as false assurance                                                                                                                                                                |

### What to keep exactly as-is

Stated explicitly so a subsequent refactor does not "simplify" them away: server-side hwid
recomputation (`worker/src/fingerprint.ts:61-65`); asymmetric drift counting (`:129-133`); the
`enroll_hwid` partial unique index and its race handling (`0011_auto_issue.sql:28-30`,
`enroll.ts:57-89`); pre-signing catalog validation (`configDoc.ts:33-55`); full re-read of device
and license state on every request (`licenseCore.ts:442-476`); and the four mirrored, corpus-pinned
client gates. These are the parts that are right.

---

## Appendix — evidence index

| Claim                                                                   | Evidence                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server re-reads all authorization state per request                     | `packages/worker/src/licenseCore.ts:442-476`                                                                                                                 |
| Seat cap is a server `COUNT(*)`                                         | `packages/worker/src/repo.ts:913-924`; `licenseCore.ts:336-352`                                                                                              |
| Version/channel gating is a server 403                                  | `packages/worker/src/licensing.ts:525-540`                                                                                                                   |
| Client gate is a two-term comparison over cached values                 | `packages/sdk-node/src/gate.ts:34-59`                                                                                                                        |
| …mirrored in three other SDKs                                           | `sdk-react/src/core/gateModel.ts:45-68`; `sdks/python/src/polaris_key/license.py`; `sdks/swift/Sources/PolarisKey/Gate.swift:80-93`                          |
| JWS verified then discarded                                             | `packages/sdk-node/src/client.ts:492-510`                                                                                                                    |
| Cache reload is a bare `JSON.parse`                                     | `packages/sdk-node/src/store.ts:194-202`                                                                                                                     |
| Cache widens the pinned trust set                                       | `packages/sdk-node/src/client.ts:184-186`                                                                                                                    |
| Bindings checked on network path only                                   | `packages/sdk-node/src/verify.ts:25-26`                                                                                                                      |
| Auto-refresh off by default                                             | `packages/sdk-node/src/client.ts:72-74`, `:190-198`                                                                                                          |
| Doc TTL 3600 s; grace = `now + maxOfflineDays·86400`                    | `packages/shared-protocol/src/index.ts:268`; `worker/src/configDoc.ts:66-67`                                                                                 |
| 30-day default offline grace                                            | `packages/worker/migrations/0001_init.sql:19`                                                                                                                |
| No monotonic clock floor in any SDK                                     | grep for `monotonic`/`hrtime`/`performance.now` across all SDK sources: no enforcement use                                                                   |
| 304 never refreshes doc or `lastVerifiedAt`                             | `packages/sdk-node/src/client.ts:460-465`; probe output in §3.2                                                                                              |
| `matchFingerprint`: one production call site                            | `packages/worker/src/licenseCore.ts:292`, guarded at `:289`                                                                                                  |
| `findFingerprintByHwid`: zero callers                                   | `packages/worker/src/repo.ts:1098-1109`                                                                                                                      |
| Device id file is returned verbatim                                     | `packages/sdk-node/src/store.ts:187-193`                                                                                                                     |
| `enroll_hwid` cleared on claim / disable                                | `packages/worker/src/repo.ts:748`; `packages/worker/src/oidc.ts:398`                                                                                         |
| Enroll dedupe enforced by partial unique index                          | `packages/worker/migrations/0011_auto_issue.sql:28-30`                                                                                                       |
| Fingerprinting on by default at `normal`                                | `packages/worker/src/fingerprint.ts:177-181`                                                                                                                 |
| Secrets read from plaintext cache, not keyring                          | `packages/sdk-node/src/client.ts:249-254`; `sdks/swift/Sources/PolarisKey/PolarisKeyClient.swift:251`; contradicted by `docs/CONCEPTS.md:65`                 |
| No threat model / `SECURITY.md` / boundary language in the shipped tree | grep across `README.md`, `CONTRIBUTING.md`, `docs/*.md` at HEAD `bd26e0b`: zero hits. `docs/security/THREAT-MODEL.md` is an untracked artefact of this audit |
| Forged cache is reported to the control plane as truth                  | `packages/sdk-node/src/client.ts:574-596`; `packages/worker/src/licensing.ts:592-599`; R4-05                                                                 |
| 11/11 client-side attack PoCs pass at HEAD                              | `packages/sdk-node/test/R4-client-attack.test.ts` (run under Node 22)                                                                                        |
