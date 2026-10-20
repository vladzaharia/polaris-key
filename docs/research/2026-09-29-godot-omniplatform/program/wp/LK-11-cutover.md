# LK-11 Cutover: wrangler routes and vars, old-URL redirects, cookie expiry, RUNBOOK, smoke

| Field       | Value                                                                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | LK: Polaris Locker                                                                                                                                                                                                                                        |
| Size        | 0.5 engineer-weeks                                                                                                                                                                                                                                        |
| Depends on  | [LK-03](LK-03-customer-host-and-origin.md), [LK-04](LK-04-cross-host-sign-in.md), [LK-05](LK-05-passkeys-related-origins.md), [LK-06](LK-06-locker-shell-portal-card.md), [LK-07](LK-07-worker-pages-and-mail.md), [LK-10](LK-10-console-locker-words.md) |
| Unblocks    | [LK-12](LK-12-locker-badges-in-use.md)                                                                                                                                                                                                                    |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                        |
| Plan mode   | no                                                                                                                                                                                                                                                        |
| Gates       | wrangler, workerd, threat-model                                                                                                                                                                                                                           |
| Human input | Owner steps O2–O10 (plans/LK-00.md §12)                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                 |

## Goal

Cutover: wrangler routes and vars, old-URL redirects, cookie expiry, RUNBOOK, smoke. Executes `plans/LK-00.md` §7.10, §10, §12; do not restate the plan.

## Read first

- `AGENTS.md`, `CLAUDE.md`, and `plans/LK-00.md` §7.10, §10, §12 (plus its §0, §1, A1 and A2 notes).

## Scope

Exactly `plans/LK-00.md` §7.10, §10, §12. Anything else is another package's row in §9.

Deferred until: O2–O10 done.

## Acceptance criteria

- [ ] the per-environment smoke in §13 returns the listed results (portal 200, `/manage` 404, webauthn origins, `/activate` 302)
- [ ] The relevant `plans/LK-00.md` §13 commands pass; the green gate passes (AGENTS.md).

## Hand-off

The role agent sets `--set LK-11 in-review` when it hands off; the lead sets `done` after review.

## Progress and continuation

2026-10-19, slice 1 (wiring) done; the switch stays off. The `polaris.locker` zone is Active in the Worker's account.

- `wrangler.toml`: custom-domain routes `polaris.locker`, `staging.polaris.locker`, `dev.polaris.locker` and `CUSTOMER_ORIGIN` in each env's `[vars]`; `CUSTOMER_HOST` stays unset.
- `CUSTOMER_ORIGIN` joins the https-origin checks (`scripts/check-config.mjs`, `core/configGuard.ts`).
- `deploy.yml` smoke (prod, the only environment the workflow deploys): polls the customer host up to about 5 minutes for first-certificate issuance; checks `/` 200 with a CSP and no cookie, `polaris-host.json`, `/manage` 404 and the API host's `/.well-known/webauthn`. Pinned in `packages/cli/test/releaseWorkflows.test.ts`.
- `docs/DEPLOYMENT.md` and `docs/RUNBOOK.md`: attached and inert, the rollback floor (never below LK-03 while the domain exists), emergency detach.

Remaining LK-11: old-URL redirects, cookie expiry, the switch steps, and the `/activate` 302 smoke line, after LK-04, LK-06, LK-07, LK-10 and O5-O10. Status stays in-progress.
