---
"@polaris-key/protocol": minor
"@polaris-key/manifest": minor
"@polaris-key/node": minor
"@polaris-key/react": minor
---

Add auto-issued free licenses and remote re-licensing.

**Auto-issued ("always free") licenses.** A product can opt into issuing a license with no key
and no sign-in, so software that mainly wants signed settings distribution doesn't have to gate
every install behind a credential. `POST /<product>/enroll` mints a license bound to the
machine's hwid and returns the same shape `/activate` does, so SDKs reuse their existing
activation result type. One license per machine per product is enforced by a partial unique
index, not by application logic, so concurrent first-runs converge on a single license instead
of racing. New `enroll()` on the Node, Python, and Swift clients, plus a `pkey enroll` CLI verb.

Enrollment requires a fingerprint: dedupe is impossible without one, and unbounded minting is
exactly the farming case the policy exists to bound.

**Merge on sign-in.** When a user of an auto-issued license signs in, the identity is attached
to the _same_ license row — devices, overrides, and local client state all survive. If that
identity already had a license, the enrolled row's devices migrate onto it and the enrolled row
is retired. Both outcomes are audited.

**Optional OIDC default tier.** A product can let any authenticated user who matches no IdP
group land on the free tier instead of a hard 403. With the policy unset, behavior is
byte-for-byte what it was.

**Remote re-licensing.** Changing a license's tier now surfaces to clients as `license.tier` and
`license.tierLabel` entitlements, gets its own `license.tier.change` audit entry recording
old → new, and reports when a downgrade lands below the active device count. Existing devices
are grandfathered; new activations are refused until the count drops.

To make that land without a restart, all four SDKs gained an **opt-in** refresh loop
(`refreshIntervalSeconds` / `startRefreshLoop()`) and an `onChange` callback. It is off by
default — enabling polling would silently add network traffic and background wakeups to every
already-shipped integration. Change detection reuses the ETag, which `computeETag()`
deliberately makes stable across a pure re-sign, so `onChange` fires only on real content
changes. Node and Python gained `close()` to stop the loop.

Also fixed: `authorizeDevice` used a lexicographic string comparator where the hot path uses
semver-correct ones from `gate.ts`.

The signed `ManagedConfigDoc` is unchanged and `PROTOCOL_VERSION` stays at 2.
