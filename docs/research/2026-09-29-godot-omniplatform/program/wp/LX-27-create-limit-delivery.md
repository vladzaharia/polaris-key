# LX-27 Create a licence with a device limit and delivery: `deviceLimit` and `delivery.email` on create (lifting LX-14a's create refusal), the "Your <Product> license" key email sent in the create request, and **Send a new key** (`POST …/licenses/<id>/send-key`)

| Field       | Value                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                                     |
| Size        | 0.5–0.8 engineer-weeks                                                                                                 |
| Depends on  | [LX-14a](LX-14a-per-license-device-limit.md), [LX-26](LX-26-licence-holders-worker.md), [I-18](I-18-email-delivery.md) |
| Unblocks    | [LX-29](LX-29-new-license-wizard.md)                                                                                   |
| Role        | `pkey-implementer`                                                                                                     |
| Plan mode   | no                                                                                                                     |
| Gates       | rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; email snapshots; workerd                                            |
| Human input | none (the sending domain is I-18's)                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                              |

## Goal

An operator creates a licence with its own device limit and, for an assigned licence, has Polaris
Key email the key to the holder in the same request; later they can send a fresh key without ever
seeing the old one again.

## Why

The New License wizard's Limits and Delivery steps ([S-24](../../notes/S-24-licence-holders.md)
§8.4) need both. LX-14a adds `licenses.device_limit` but refuses it on create (its commit
`e755e88f1`), and nothing is sent on create today (H3). Keys exist in plaintext only in the create
response (`W/crypto.ts`), so the email must be sent there or with a newly minted key (D12).

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §6.3, §7.1, §8.4 (D11, D12).
- [LX-14a](LX-14a-per-license-device-limit.md) (precedence, validation) on `wp/LX-14a-device-limit`.
- `packages/worker/src/services/license/admin/licenses.ts`, `services/identity/portal/email.ts`,
  `portal/notices.ts` (templates and sender, PX-W7), I-18's sender setup.

## Scope

**In:**

- `POST …/license/licenses` accepts `deviceLimit` (positive integer or absent; LX-14a's rule) and
  `delivery: {email: boolean}`, valid only with an `email`. The answer gains
  `delivered: {email: "sent" | "queued" | "failed"}`.
- The **"Your <Product> license"** email: sender "<Product> via Polaris Key" (I-18), the holder's
  name when given, the key, **Open in Polaris Key** (a portal sign-in link for that email, never a
  link that signs in by itself), the product's download link when it has one, and one line on what
  to do with the key. Plain-text and HTML parts; snapshot tests.
- `POST …/licenses/<id>/send-key` `{revokeOthers?: boolean}`: mints a new key (label "Sent by
  email"), emails it to the licence's `email`, optionally revokes the other active keys in the same
  batch; one per 10 minutes per licence (`429 rate_limited` with `retryAfter`); refused on a floating licence with the existing `400 bad_request`.
- Audit: `license.create` records `delivery`; `license.key.send` with the key's label and whether
  others were revoked.
- OpenAPI and `routeCoverage`.

**Out:**

- The console steps (→ LX-29) and the record action (→ LX-30).
- Emailing a floating key (never; D11). Scheduled emails (later).

## Design notes

- A failed send never rolls back the licence: the answer says `failed`, the console offers **Try
  again** through `send-key`, which mints a new key (the first one stays valid unless revoked).
- The key appears only in the email body and the one response; never in logs, audit summaries or
  the email's subject.
- THREAT-MODEL: one row under licence administration ("an operator can email a key to the
  licence's address; rate-limited and audited").

## Steps

1. Lift LX-14a's create refusal; validate and store `deviceLimit`.
2. Template, snapshot tests, the create-time send.
3. `send-key` route, rate limit, audit, OpenAPI.

## Acceptance criteria

- [ ] Create with `deviceLimit` stores it and the effective limit follows LX-14a's precedence (test).
- [ ] Create with `delivery.email` sends exactly one email containing the key; without an email it
      is refused (tests, snapshot).
- [ ] `send-key` mints, emails and optionally revokes, at most once per 10 minutes (tests).
- [ ] No key appears in audit rows or logs (test).
- [ ] The green gate passes (AGENTS.md), including OpenAPI and `routeCoverage`.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- license email routeCoverage
```

## Hand-off

LX-29 calls create with `deviceLimit` and `delivery`; LX-30 offers **Send a new key…**.

The role agent sets `--set LX-27 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-27
done`.
