# I-02 Atomic single-use store (Durable Object), sharded portal and admin rate limits, email send limits

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Phase       | I: Identity service (S-16) (phase-0, MVI)                                                |
| Size        | 0.6–0.85 engineer-weeks                                                                  |
| Depends on  | none                                                                                     |
| Unblocks    | [I-08](I-08-email-login.md), [I-21](I-21-email-delivery.md)                              |
| Role        | `pkey-implementer`                                                                       |
| Plan mode   | no: follows the approved [`plans/I-04.md`](../plans/I-04.md) where it names this package |
| Gates       | `test:workerd`; `wrangler.toml` bindings; THREAT-MODEL                                   |
| Human input | none                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                |

## Goal

Every single-use Identity artefact (portal magic links, email codes, OIDC flow records, device codes, and later WebAuthn challenges and auth codes) is consumed atomically through a Durable Object with per-code attempt counters; the `_portal` and `_admin` rate-limit buckets are sharded; and the email send-side limits S-16 specifies exist as reusable limiters.

## Why

KV `get` then `delete` is not atomic across regions (G15), and the `_portal` shard is a global chokepoint (R10-04a). Email sign-in (I-08) and its delivery operations (I-21) need the attempt counters and send limits from day one ([S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 4 and 8).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [S-16 owner decisions](../../notes/S-16-identity-service.md) (2026-10-04, the note's header).
- [S-16 §3.2](../../notes/S-16-identity-service.md#32-gaps) G15, [S-16 §5.1](../../notes/S-16-identity-service.md#51-concepts-and-data-model) (single-use store row), [S-16 §5.4](../../notes/S-16-identity-service.md#54-threat-model-deltas) items 4 and 8, [S-16 §8](../../notes/S-16-identity-service.md#8-work-packages) row I-02.
- `packages/worker/src/rateLimitDo.ts`, `packages/worker/src/core/rateLimit.ts`.
- `packages/worker/src/services/identity/portal/auth.ts` (magic-link verify), `services/identity/oidc.ts` (flow and device-code records).
- `packages/worker/wrangler.toml` (Durable Object bindings and migrations).

## Scope

**In:**

- A single-use Durable Object, sharded by artefact hash: `put(kind, hash, payload, ttl)`, `consume(kind, hash)` (atomic, at most once), `attempt(kind, hash)` (counts failures and kills the artefact at the cap).
- Move today's portal magic links, OIDC flow records and device codes onto it.
- Shard the `_portal` and `_admin` rate-limit buckets (R10-04a).
- Reusable email send limiters: per recipient (hashed) 5 an hour and 20 a day; per IP and per network; per device 3 starts an hour; per product daily cap (the value is configurable, I-21 sets the operational default).
- The verify-side limiter primitives I-08 uses: 6-digit codes, 10-minute lifetime, death after 5 wrong attempts, a new code for the same recipient and flow invalidating the old one, and a 15-minute recipient lockout after 10 wrong attempts across codes in an hour.

**Out** (and where it belongs instead):

- The email routes and pages themselves (→ I-08).
- Sending infrastructure, suppression and DNS (→ I-21).

## Design notes

- **Safety defaults carried from S-16 §5.4 item 4.** The numbers above are the specified defaults; with them an attacker gets at most 5 guesses in a million per code and about 10 codes a day per victim. Keep them as named constants that I-08 and its tests import.
- A lockout answers exactly like success (enumeration safety is I-08's, but the primitive must not leak state through its return shape to callers that echo it).
- workerd forbids runtime code generation; run `test:workerd`.

## Steps

1. Durable Object class, binding and tests (including a concurrent double-consume test).
2. Migrate the three existing artefact kinds.
3. Shard the rate-limit buckets.
4. Email limiter primitives with tests.

## Corrections from the code (implementation, 2026-10-04)

- **The console's OIDC flow moved too.** `admin/auth.ts` consumed its `admin:flow:` record with
  the same KV `get` then `delete`, so it is an "OIDC flow record" in the sense of G15 and moved
  with the portal and product flows (kind `admin-flow`).
- **The product flows are state machines, not plain single-use records.** A product flow is
  written by `/auth/start`, claimed by the callback (`consumedAt`), confirmed, polled and finally
  redeemed; a device-code record is re-written by every render and poll. So the store has, beside
  `put`, `consume` and `attempt`, an atomic compare-and-set `update` (which never creates a record,
  so nothing can be resurrected), `put … ifAbsent` (the user-code index), `redeem` (a code checked
  against its stored hash, counting a wrong one as an attempt) and `strike` (the recipient
  lockout's sliding window). The API is `(env, ref, …)` where `ref = artefactRef(kind, id)`
  (`src/core/singleUse.ts`); the object is `src/singleUseDo.ts`, binding `SINGLE_USE`, migration
  tag `v3`, 64 shards.
- **Per-IP and per-network send numbers** are not in S-16; the defaults chosen are 10 an hour per
  client address and 30 an hour per network (IPv4 /24, IPv6 /48), named constants in
  `src/core/emailLimits.ts`. The per-product daily cap defaults to 1,000 until I-21 sets it.
- **Rate-limit sharding** keeps a product's own limiter as one object (tenant-scoped already) and
  splits `_portal`, `_admin` and every `email*` bucket over 32 objects by a hash of
  `(bucket, id)`.

## Acceptance criteria

- [ ] Two concurrent `consume` calls for one artefact: exactly one succeeds (test).
- [ ] Portal magic links, OIDC flows and device codes no longer use KV get-then-delete.
- [ ] The `_portal` and `_admin` buckets are sharded; the rate-limit and portal suites pass.
- [ ] The send and verify limits exist with the S-16 default numbers as named constants and are unit-tested.
- [ ] `test:workerd` passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- rateLimit portal identity
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
```

## Hand-off

- I-08 uses `consume`/`attempt` and the verify limits for email codes and magic links.
- I-21 sets the per-product daily cap value and hooks throttling to `email_unavailable`.
- I-14 and I-16 store WebAuthn challenges and auth codes here.

The role agent sets `--set I-02 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-02 done`.
