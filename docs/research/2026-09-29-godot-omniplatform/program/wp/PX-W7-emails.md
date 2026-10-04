# PX-W7 Emails (G15c, G18, G23): "Polaris Key" sender and naming, deep links, security-notice templates for method and device changes, Email me the download

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase W: Worker additions)                                                         |
| Size        | 0.1–0.2 engineer-weeks                                                                                                          |
| Depends on  | [PX-01](PX-01-portal-shell.md)                                                                                                  |
| Unblocks    | [PX-09](PX-09-get-it-complete.md)                                                                                               |
| Role        | `pkey-implementer`                                                                                                              |
| Plan mode   | no                                                                                                                              |
| Gates       | the PORTAL.md §11 green gate; rule 10 (OpenAPI + `routeCoverage`); email snapshot tests; `typecheck:workerd` and `test:workerd` |
| Human input | none                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## Goal

Portal emails come from "Polaris Key", name products and devices, deep-link into the new routes (§3.4), include security-notice templates for sign-in method and device changes, and `POST /api/products/:p/email-download {platform}` sends a download link to the person's own address.

## Why

Email copy and links predate the redesign ([PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close) G18, G15c); phones need "Email me the download" (G23, [PORTAL.md §5.4](../../../../design/PORTAL.md#54-quick-action-resolution)). PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.2](../../../../design/PORTAL.md#112-phase-w-worker-additions) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §6.3](../../../../design/PORTAL.md#63-emails), [PORTAL.md §3.4](../../../../design/PORTAL.md#34-entry-points), [PORTAL.md §10.2](../../../../design/PORTAL.md#102-gaps-the-worker-must-close)
- `packages/worker/src/services/identity/portal/email.ts`

## Scope

**In:**

- Sender name "Polaris Key" and product/device names in every portal template.
- Deep links per §3.4 (`#/p/:product`, `#/p/:product/devices`, `#/account/methods`, `#/p/:product/download?platform=`).
- Security-notice templates for method and device changes.
- `POST /api/products/:p/email-download {platform}` with a per-account rate limit.

**Out** (and where it belongs instead):

- UI for Email me the download (→ PX-09)
- Sending-domain operations (→ I-18)

## Design notes

- **Naming and copy** (owner decisions, PORTAL.md header and Appendix C/E): the product is "Polaris Key" everywhere, never "Polaris Key Portal"; page titles read "<Page> · Polaris Key"; US "license" in UI copy; plain words per §6.1 (never "claim", "redeem", "OIDC", "entitlement").
- **Rule 10:** every new public route gets its OpenAPI operation and a `routeCoverage` entry in the same change (`test/routeCoverage.test.ts`).
- **Overlap with the re-cut S-16/S-17 graph:** I-18 also names the sender identity (its title says "<App> via Polaris Key" for app sign-in mail); portal mail uses "Polaris Key" per PORTAL.md. PORTAL.md is the approved UI and API spec for this surface; whichever package lands first owns the shared code and the other narrows its scope to what is left (the lead reconciles the briefs).

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-W7:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-W7 in-review`.

## Acceptance criteria

- [ ] Email snapshot tests for every changed template.
- [ ] OpenAPI and `routeCoverage` cover the email-download route; it sends only to the account's own verified address (test).
- [ ] `pnpm --filter @polaris-key/worker typecheck:workerd` and `test:workerd` pass; `gen:transcripts -- --check` stays green.
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- email
```

## Hand-off

PX-09 calls email-download; PX-W12 and PX-W14 reuse the notice templates.

The role agent sets `--set PX-W7 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-W7 done`.
