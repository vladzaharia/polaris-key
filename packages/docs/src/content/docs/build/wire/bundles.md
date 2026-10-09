---
title: "Offline bundles"
description: "pkey-bundle+jws — the air-gapped activation artifact, its three time bounds, the four ordered refusal steps that make import all-or-nothing, and the reload profile that re-verifies it at every start."
sidebar:
  order: 9
---

An offline activation bundle is the air-gapped path: an operator mints one against a device's
request code, carries it across on a USB stick, and the client imports it with **no network at
all**. It is the classic request-code flow, signed.

A bundle wraps up to three inner compact JWSs — a license document, an optional config
document, and the trust manifest needed to verify them — inside one `pkey-bundle+jws`. That is
why its payload cap is 262 144 bytes rather than the 64 KiB every other artifact gets.

Spec reference: §7. Implementation: `packages/client-core/src/bundle.ts` (the verifier),
`packages/sdk-node/src/core/bundle.ts` (the host write), `packages/worker/src/core/bundles.ts`
(the mint).

## The payload

```jsonc
{
  "bundleId": "01J…", // ULID — the audit anchor
  "aud": "<product-slug>",
  "deviceId": "<the requesting device's id>",
  "issuedAt": 1756252800,
  "expiresAt": 1758844800, // the IMPORT window for the bundle itself
  "docs": {
    "license": "<pkey-license+jws>", // optional by design
    "config": "<pkey-config+jws>", // optional
  },
  "trust": "<pkey-trust+jws>", // required
}
```

`bundleId` is a ULID: a 48-bit millisecond timestamp plus 80 bits of randomness, Crockford
base32. Lexicographic ordering by mint time is the point — the mint is audit-logged under this
string, the importing client keeps the bundle itself (and so its `bundleId`), and an operator
correlating a support ticket to an audit row has only this string to do it with.

`deviceId` is 32 base64url characters, copied by the operator out of the app's offline
activation screen.

## The three time bounds

Three timestamps, three different meanings. Getting these confused is the most common way to
misread a bundle.

| Bound              | Value                                                                                                                                                                                                                      | Profile it is checked on                    | What it means                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| Inner `expiresAt`  | `issuedAt + DOC_EXPIRY_SECONDS` (1 hour)                                                                                                                                                                                   | **Reload** — not asserted                   | Exactly what the online path mints. Deliberate |
| Inner `graceUntil` | `issuedAt + graceDays × 86 400`, `graceDays ≤ 365`; no later than the licence's expiry (never earlier than `expiresAt`) while `licensing.clampGraceToExpiry` is on ([§3.6](/docs/services/license/document/#the-envelope)) | Enforced by the gate against `effectiveNow` | How long the imported install runs             |
| Bundle `expiresAt` | `issuedAt + BUNDLE_IMPORT_WINDOW_SECONDS` = 2 592 000 s (30 days)                                                                                                                                                          | **Network** — a stale bundle is refused     | How long this file may sit on a USB stick      |

### Why the inner documents expire in an hour

Because that is what makes an imported bundle **indistinguishable from a cache** written by a
device that went offline the moment it synced. Step 4 verifies inner documents on the reload
profile, which is the same profile a cached document gets: a document arriving on a machine
weeks after it was signed is _expected_ to be past `expiresAt`, and its real outer bound is
`graceUntil`. The client gate therefore needs no bundle-specific branch at all.

Stretching the inner `expiresAt` to cover the offline window instead would create a document
that passes **network**-path freshness for the entire grace period — one a replay could present
at any freshness-checking call site. That is refused at mint.

### Why the import window is separate and short

The import window bounds how long a **stolen bundle file** stays useful to someone who did not
have it at mint time. `graceUntil` bounds how long the **install it creates** keeps working.
Making the two equal would mean a 365-day grace also handed out a 365-day replay window for the
file.

Thirty days is the shortest window that survives the physical process the artifact exists for:
minted by an operator, attached to a ticket or written to media, hand-carried to a machine that
by definition cannot ask for a fresh one.

## Import: four ordered steps, all-or-nothing

The order is the contract. The corpus pins **which step** refuses for each vector, not merely
that something did — "the bundle was addressed to another device" and "the license document
inside it was addressed to another device" are different failures with different operator
remedies.

**Step 1 — the bundle JWS, against the usable pinned keys only.**
`typ` must be `pkey-bundle+jws`; payload cap 262 144, taken from the protocol constant rather
than from the caller. Refusal: `bundle-jws-rejected`.

**Step 2 — the bundle's own claims, on network-path freshness.**
`aud` equals the product; `deviceId` equals the **local** device id; `issuedAt <= now + skew`;
`now <= expiresAt + skew`. Also refused here: a bundle with an **empty** `docs` — it can grant
nothing and configure nothing, so importing it would write a bundle with no content behind it,
an install that looks provisioned and is not. Refusal: `bundle-claims-rejected`.

**Step 3 — the inner trust manifest, against the pins, on the reload profile.**
Reload, not network: a bundle minted weeks ago carries a manifest whose minutes-long
`expiresAt` passed long before it reached the air-gapped machine. Everything else still
applies — signature, `aud`/`iss`/`typ`, and above all the pinned-substitution rule, which is
what stops a bundle from shipping its own roots. Refusal: `bundle-trust-rejected`.

**Step 4 — each inner document, against the effective set, on the reload profile.**
Bound to the **local** device id, not to the bundle's own claim: step 2 has only proved that
the _bundle_ claims this device, and a document inside it may claim another. **Per-type
floors:** each inner document must be strictly newer than the verified cached document of its
type, when the device holds one, so an old bundle cannot roll a device back to an earlier grant.
Refusal: `inner-doc-rejected`.

**Step 5 — the host writes.** And only now.

Nothing is returned until every step has passed, which is the mechanical form of
all-or-nothing: a caller physically **cannot** write half a bundle, because a failure at step 4
hands back no documents at all — not even the ones that verified before it.

```ts
type BundleRefusalReason =
  | "bundle-jws-rejected" // step 1 — signature, typ, or the 262 144-byte cap
  | "bundle-claims-rejected" // step 2 — aud / deviceId / import window / vacuous docs
  | "bundle-trust-rejected" // step 3 — the inner manifest failed against the PINS
  | "inner-doc-rejected"; // step 4 — a carried document failed against the effective set
```

`verifyBundle` returns the verified contents or `null` — the shape a host wants when it just
needs to know whether to write. `inspectBundle` is the same walk with the step attributed; use
it when the reason matters, because "get a bundle minted for THIS machine" is a materially
better error than "invalid".

### Pins only, everywhere

Both the bundle **and** the manifest it carries are verified against the compiled-in pins,
minus any a verified manifest has revoked ([tombstones](/docs/build/wire/trust/)). An air-gapped
device must not be the one place where a planted key set is accepted.

### Two profiles: import and reload

The steps above are the **import** profile: the operator's act, once. The cached bundle is then
re-verified at every start on the **reload** profile: steps 1–3 without step 2's two
import-window comparisons, and step 4 with no floors (its documents are the cached ones).
Everything else in step 2 still binds. A bundle imported on day 29 therefore still activates on
day 300, and a clock wound back below the bundle's `issuedAt` does not strand the install.

A byte-identical re-import of the bundle an install runs on is a success with no write.

### What step 5 writes

The record is **replaced**, not merged:

```jsonc
{
  "v": 3,
  "bundle": "<the pkey-bundle+jws, verbatim>",
  "trustJws": "<the bundle's inner manifest, unless the held one is newer>",
  "docs": { "license": "<inner jws>", "config": "<inner jws>" },
  // carried: "feeds", "releaseRecords", "pinRevocations"
}
```

Merging would let a stale license slice survive an air-gapped re-provisioning — a device
running on a license its operator deliberately replaced. Three things are carried: the update
slices (each channel's `seq` floor), the pin revocations' evidence, and the held trust manifest
when it is newer than the bundle's, so an old bundle cannot re-teach a key the device has seen
revoked. **No ETags** are written: these
documents did not come from a conditional GET, and inventing validators for them would make the
next online sync send an `If-None-Match` the server never issued.

A well-behaved host then re-runs its normal load path over what it just wrote, rather than
trusting the in-memory objects. The imported install must reach exactly the state a **restart**
would reach, and the only way to be sure of that is to take the same route.

## What a bundle does and does not create

- **`activation: "bundle"`.** The gate reads `activation: "bundle"` only when no token is held,
  the cached `bundle` re-verifies on the reload profile, and the cached licence document is
  byte-identical to the bundle's own. Nothing unsigned decides it: there is no import marker. If
  the device later activates online, the token path supersedes it with `activation: "token"`.
- **No token.** A bundle-activated install has no credential and never talks to the server.
- **No device row, no fingerprint check.** Fingerprint enforcement is skipped for bundle
  activation — there is no server to dedupe against. The mint side likewise creates no device
  row: inventing one would put a seat holder in the console that nothing can ever reconcile,
  deactivate, or hear from again.
- **`docs.license` is optional by design.** A config-only product air-gaps with a bundle
  carrying only `docs.config` and `trust`. Importing a bundle with **no** license document has
  **no activation effect** — for a license-enabled product the gate stays `needs-activation`;
  for a license-disabled product it stays `not-applicable`. `activation: "bundle"` arises only
  from a bundle whose license document verified.

## Minting

Two front doors onto one endpoint, `POST /manage/api/products/<slug>/bundles`. It is an admin
surface: authenticated, CSRF-protected, rate-limited with the rest of the admin API, and
**audit-logged** — the audit row is the only record that a mint happened, since the artifact
itself is stored nowhere.

From the console, or from the CLI:

```sh
pkey bundle --product <slug> --device <id> --grace-days <n> \
  [--no-config] [--license <id>] [--base-url <url>] [--out <file>] [--force]
```

The CLI authenticates with a live console session cookie read from `PKEY_ADMIN_COOKIE`; there
is no API-token surface yet. It writes the compact JWS to a single file — by default
`<product>-<first 8 chars of deviceId>.pkeybundle` — with no trailing newline, so a naive read
feeds a verifier directly.

What the server decides rather than the caller:

| Input               | Rule                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceId`          | 32 base64url characters. Validated client-side too, so a typo pasted off an offline screen costs a local error rather than a round trip                                                                                                           |
| `graceDays`         | An integer from 1 to **365**. The ceiling is enforced at mint **and** at verify                                                                                                                                                                   |
| license document    | Included if and only if the License service is enabled — and then `licenseId` is **required**. There is no authenticated device here to infer a license from, and guessing would silently mint the wrong grant on the day a second license exists |
| config document     | Included if and only if the Config service is enabled and `includeConfig` is not `false`. Asking for config on a product that does not run it is not an error; the answer is a bundle without it                                                  |
| `signerKid`         | Optional. Signs the bundle, and its inner trust manifest, with that active, staged or retired key, for a device whose app pins only that key. A revoked or unknown `kid` is a 400                                                                 |
| no documents at all | Refused. §7 makes such a bundle vacuous at import, so minting one produces a file whose only possible outcome is an error on a machine with no way to report it                                                                                   |

The inner documents are built by the **same** assembly the network routes use, over the same
entitlement resolution and the same payload merge. Nothing about a bundle re-derives a grant —
if it did, a bundle-activated install would be entitled to something subtly different from the
same install online, and the difference would only ever be discovered by a customer.

One deliberate difference: there is **no build gate** at mint. `/license/document` gates on the
client's version and channel headers, and there is no client here. The version window and
channels still ride along as enforced entitlements (`app.minVersion`, `app.maxVersion`,
`channels`), but no SDK evaluates them locally yet: the window is enforced by the server only, so
an install that imports a bundle and never goes online is not held to it. Client-side evaluation
of the signed window is a planned follow-up.

The response is `bundleId` plus the compact `bundle` JWS.

## Corpus coverage

The `bundleCases` vectors for this page, each asserting the **step** that refuses (the
claim-level cases are on [Conformance corpus v2](/docs/reference/corpus/)):

| Case                                                                 | Expected outcome                              |
| -------------------------------------------------------------------- | --------------------------------------------- |
| `bundle-valid-full`                                                  | Accept — license, config and trust            |
| `bundle-valid-license-only`                                          | Accept — config is optional                   |
| `bundle-typ-missing`                                                 | Step 1                                        |
| `bundle-over-cap`                                                    | Step 1                                        |
| `bundle-deviceId-mismatches-local`                                   | Step 2                                        |
| `bundle-expired`                                                     | Step 2 — the import window is network-profile |
| `bundle-inner-trust-pinned-substitution`                             | Step 3                                        |
| `bundle-tampered-inner-license-signature`                            | Step 4                                        |
| `bundle-inner-deviceId-mismatches-bundle`                            | Step 4 — inner docs bind to the local device  |
| `bundle-floor-license-not-newer`, `bundle-floor-config-not-newer`    | Step 4 — the per-type floors                  |
| `bundle-floor-newer-imports`                                         | Accept — strictly newer documents             |
| `bundle-reload-past-import-window`, `bundle-reload-issued-in-future` | Accept — the reload profile has no window     |
| `bundle-reload-wrong-device`                                         | Step 2 — everything else still binds          |
| `bundle-signed-by-tombstoned-pin-refused`                            | Step 1 — a revoked pin signs nothing          |

The fixtures use the same 30-day window this server mints, so a client tested against them sees
the real one. Full counts at [Conformance corpus v2](/docs/reference/corpus/).
