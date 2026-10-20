# LK-03 Customer host, `customerOrigin()`, `customer.host`, `/signin` made host-aware (A2), `/device` `/tv` served on it, reserved slugs

| Field       | Value                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | LK: Polaris Locker                                                                                                                                                                                                                                                       |
| Size        | 1–1.25 engineer-weeks                                                                                                                                                                                                                                                    |
| Depends on  | none                                                                                                                                                                                                                                                                     |
| Unblocks    | [LK-04](LK-04-cross-host-sign-in.md), [LK-05](LK-05-passkeys-related-origins.md), [LK-06](LK-06-locker-shell-portal-card.md), [LK-07](LK-07-worker-pages-and-mail.md), [LK-10](LK-10-console-locker-words.md), [LK-11](LK-11-cutover.md), [LK-17](LK-17-hard-cutover.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                                       |
| Gates       | rule-9, rule-10, drift-gate, workerd, threat-model                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                |

## Goal

Customer host, `customerOrigin()`, `customer.host`, `/signin` made host-aware (A2), `/device` `/tv` served on it, reserved slugs. Executes `plans/LK-00.md` §4, §7.1–7.5, §7.13; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §4, §7.1–7.5, §7.13 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §4, §7.1–7.5, §7.13. Anything else is another package's row in §9.

## Acceptance criteria

- [ ] `pnpm gen --check` settings, platform-inventory, transcripts clean
- [ ] `pnpm --filter @polaris-key/manifest test` (reserved slugs, schema parity)
- [ ] `pnpm --filter @polaris-key/worker test` (customerHost, customerOrigin, the switch, routeCoverage, adminCspParity); `test:workerd`
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-03 in-review` when it hands off; the lead sets `done` after review.

## Progress and continuation (2026-10-19, complete)

Done (slice 1 and most of slice 2):

- [x] `customer` host kind in `core/hosts.ts`; `customerOrigin()`; async `customerHostMode()` and `customerOriginOf()` in `core/licensing/manageUrl.ts` (no DB read while `CUSTOMER_ORIGIN` is unusable). `portalOriginOf`/`portalOriginFor` stay as the `off` wrappers.
- [x] `customer.host` setting (`off`/`on`/`permanent`, ceiling, L2 `change`), `CUSTOMER_ORIGIN` in `DENIED_PLATFORM_NAMES`, Env members, `wrangler.toml` comment only (no `[vars]` until LK-11); `pnpm gen settings|platform-inventory|docs-reference` run.
- [x] Call sites moved: `buildManageUrl`, `buildSignInUrl` (now async, takes `db`), `accountPortalUrl`, `licenseOwnedResponse`, key email, attach, licence-admin link, choice view links, legacy chooser, identity-off card redirect, maintenance mail origin, device start `verificationUri` (`<customer>/device` while on).
- [x] Host confinement (`core/customerHost.ts`, `dispatch.ts`); `/.well-known/polaris-host.json` and `/robots.txt`; `/device` on the customer host redirects to the API host's product page (absolute, from `CONSOLE_ORIGIN`).
- [x] Reserved slugs `signin`, `device`, `tv` were already shipped with A1/A2 (validator, schema, parity).
- [x] Rule 10: spec path + `CUSTOMER_PATHS` in `routeCoverage`; tests `customerHost`, `customerOrigin`; THREAT-MODEL and DEPLOYMENT entries.

Not done, by design (other packages): `authorize`'s 303 to `/signin` stays on the request origin (bind hop, LK-04; allow-listed in `customerOrigin.test.ts`); `/.well-known/webauthn` (LK-05); `/docs/help/*` and `/<slug>` on the customer host (D7, LK-12); old-URL redirects and cookie expiry (LK-11); `send.ts` asset origin stays on the console (images already sent). RUNBOOK and DEPLOYMENT text done. `/.well-known/webauthn` is left to LK-05 (it is the ROR work of §7.7).
