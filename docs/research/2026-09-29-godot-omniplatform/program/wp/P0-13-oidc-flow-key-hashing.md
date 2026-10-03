# P0-13 Hash product OIDC `state` and device-code KV key names (finish R12-04)

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                        |
| Size        | 0.25–0.5 engineer-weeks                                                           |
| Depends on  | none                                                                              |
| Unblocks    | [P1-06](P1-06-rfc8628-page.md)                                                    |
| Role        | `pkey-implementer`                                                                |
| Plan mode   | no                                                                                |
| Gates       | threat model / security-audit status; worker tests including the R12 attack suite |
| Human input | a deploy; in-flight sign-ins at deploy time need a retry (flows live 600 s)       |
| Repo        | `vladzaharia/polaris-key`                                                         |

## Goal

No product sign-in credential appears verbatim in a KV key name. The product OIDC flow key and the
device-flow key are derived as a peppered hash of the secret, exactly as the admin flow key already
is. The security audit's R12-04 row is then true for every flow it names.

## Why

Security finding R12-04 ("OIDC `state` / device code used verbatim as KV key names") is listed as
**Fixed** in the 2026-08-26 security audit (the §3 table, and the note under it that
the R12 lanes did not update the R12 audit findings). The fix landed for admin sign-in only:

- `packages/worker/src/admin/auth.ts:33-45` hashes the admin `state` under `KEY_HASH_PEPPER` and
  explains why: anyone who can list the HOT namespace would otherwise read live `state` values and
  device codes from key names alone.
- The product identity flows still build the keys from the secret itself, in
  `packages/worker/src/services/identity/oidc.ts:295-301`:
  - `flowKey(product, state)` → `p:<product>:flow:<state>`;
  - `deviceFlowKey(product, code)` → `p:<product>:device-flow:<code>`.

  About twenty call sites use them (the `HOT.get`, `put` and `delete` calls near lines 681, 772,
  830–889 and 983–1093).

The Godot SDK makes device-code sign-in a primary path ([P1-06](P1-06-rfc8628-page.md),
[P1-07](P1-07-godot-identity.md)). P1-06's brief deliberately leaves these keys alone and points
here.

## Read first

- `AGENTS.md`; the audit row and note for R12-04; `packages/worker/src/admin/auth.ts:28-48`;
  `hashKey` in `packages/worker/src/crypto.ts:107`.
- `packages/worker/src/services/identity/oidc.ts`: every use of `flowKey` and `deviceFlowKey`.
- The R12 attack tests (`packages/worker/test/attack/R12-*.test.ts`) and the identity tests.

## Scope

**In:**

- Make `flowKey` and `deviceFlowKey` async, and derive them as
  `p:<product>:flow:<hashKey(state, env.KEY_HASH_PEPPER)>` and the device-flow equivalent. Thread
  `env` through the call sites.
- Anything else in the product identity service or portal that still uses a bearer secret as a key
  name. Grep for `HOT.put(` and `HOT.get(` with template keys; the audit also names
  `portal/auth.ts` for the magic-link token, so re-check it.
- A regression test in the R12 suite: list the HOT keys during a product sign-in and a device-code
  flow, and assert that neither the `state` nor the device code appears in any key name.
- Update the audit row's proof column to point at the new test.

**Out:**

- The RFC 8628 user-code page and its index key (→ [P1-06](P1-06-rfc8628-page.md), which already
  hashes its own index).
- Changing flow TTLs or the flow record shape.

## Design notes

- **Deploy behaviour.** Flows live for 600 s. A plain switch makes sign-ins in flight at deploy time
  fail once, and users retry. That is acceptable, so no dual-read is needed. If a dual-read window is
  wanted anyway, read the hashed key first and then the legacy key for one TTL, and write only the
  hashed key. State which choice was made in the PR.
- **The device-flow status endpoints** look the flow up by device code, so they must hash the same
  way. Keep the comparisons that exist today. (Correction, P0-13: they are plain `!==` checks on
  the CSRF token and device id, not timing-safe ones; the device code itself is never compared,
  it only addresses the record.)
- The device `user_code` shown to people is derived from the device code (`deviceUserCode`, called
  with `deviceCode` in `handleAuthDeviceStart`), not from `state` as this brief first said. Nothing
  here changes it.
- **Correction, P0-13:** the portal OIDC flow key (`portal:oidc-flow:<state>` in
  `services/identity/portal/auth.ts`) was also verbatim, alongside the magic-link key. Both are
  hashed here under the "anything else" scope line. The audit's old R12-04 proof cited a
  `CONFIRMED:` test that asserted the magic-link token was still the key name.

## Steps

1. Add the async key helpers and convert the call sites.
2. Re-check the portal magic-link and any other identity keys; fix them the same way.
3. Add the R12 regression test and run the identity, portal and attack suites.
4. Update the audit document's proof column for R12-04.

## Acceptance criteria

- [ ] No KV key written during product OIDC sign-in, device-code sign-in or magic-link sign-in
      contains the corresponding secret; the new R12 test proves it.
- [ ] All identity, portal and attack tests pass; `test:workerd` passes.
- [ ] The audit row for R12-04 cites the new test.
- [ ] The green gate passes.

## Verify

The identity tests are `oidc*.test.ts` and `portal*.test.ts`; a bare `identity` filter matches only
`identitySessionDoc.test.ts` (correction, P0-13).

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- oidc portal R12
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

P1-06 relies on the device-flow key being hashed. Set the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-13 in-review` when handing off for review.
