# SP-09 Velopack package route drops `Authorization` on its cross-origin 302 under licensed or entitled delivery (wire item W9, S-11 §5.2 follow-up)

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (wire items)                                |
| Size        | 0.1–0.2 engineer-weeks                                                                     |
| Depends on  | [P3-09](P3-09-updater-feeds.md), [PX-W3](PX-W3-licensed-r2-downloads.md)                   |
| Unblocks    | none                                                                                       |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                      |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-09.md` first; no code before a human approves it |
| Gates       | plan mode; rule 10 (OpenAPI and `routeCoverage`); THREAT-MODEL; `test:workerd`             |
| Human input | none                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                  |

## Goal

The Velopack package route never forwards `Authorization` across its cross-origin 302 under
licensed or entitled delivery, and the Velopack drivers in Godot, Node, Python and Kotlin retry
correctly against it.

## Why

Wire item W9 in [`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §6, the S-11 §5.2 follow-up.
Approved to proceed through plan mode on 2026-10-05.

## Read first

- `AGENTS.md` and `CLAUDE.md`; [`notes/S-11`](../../notes/S-11-desktop-updaters.md) §5.2; the feeds code from P3-09.

## Scope

**In:** the route change, its OpenAPI text, a THREAT-MODEL row and a regression test; per the
approved plan (`plans/SP-09.md` §5, §6), also the Godot facade's retry (`native/pkey_velopack.gd`,
its `test_facades.gd` cases and the `parity.json` note) and the docs paragraphs
(`updater-feeds.md`, `godot-desktop.md`, the download-ticket glossary entry).

**Out:** driver work beyond retry (each SDK's SP task: SP-N09, SP-P09, SP-K12 build §5's rule in).

## Decisions recorded at implementation (2026-10-05, owner delegated to the lead)

The plan's §8 recommendations are taken as decided: **Q1** PX-W3's download ticket on the bytes
host; **Q2** reuse the label `pkey-download-ticket/1`; **Q3** PX-W3 is a dependency (added to the
graph); **Q4** no bytes host means no ticket, documented; **Q5** a 120 s revocation residual,
accepted; **Q6** App Installer and zsync stay out of scope (follow-up for the program README §9).

Corrections against the code, made in this branch:

- **PX-W3 was `in-review`, not merged**, when SP-09 started. This branch merges
  `wp/PX-W3-licensed-r2-downloads` (its `core/downloadTicket.ts` and the bytes route's ticket
  acceptance) so the two land together; review PX-W3 first.
- **Host check.** The plan named `isAllowedDownloadRedirectHost`, which also admits GitHub's
  storage hosts. A ticket verifies on the bytes host only, so the route mints only for a URL on
  the bytes host (`isBytesHost`), and only for a URL with no query.
- **Merge with main after PX-W3 (fix round 1).** Main's `fix/portal-download-404` reordered the
  portal's `downloadTarget` (public files go to the bytes host first; a GitHub URL only for a
  public repository) while PX-W3 added the ticket branch to the same function. The resolution
  keeps both: public → bytes host; GitHub URL only when the repository is public; a non-public
  file with no GitHub URL → bytes host with a ticket; a licensed file in a private repository
  stays `not_hosted` (PX-W3 plan Q7, now pinned by a test with tickets configured). PX-W3's
  fail-closed test now expects main's owner refusal (`409 not_hosted`) instead of `404`. PX-W3's
  own branch needs the same resolution when it re-merges main.
- **`referrer-policy: no-referrer`** is already on every answer (`harden` →
  `appSecurityHeaders`), so the redirect adds no header of its own; the tests assert it.
- **The workerd case** drives the route's minting half (`ticketedDeliveryUrl`) and verifies the
  `Location` the bytes host receives. Driving the whole route under workerd would need the signed
  release-record fixture that only the Node lane has; the Node lane follows the `Location` to the
  real bytes route (200, and 206 with `Range`).

## Steps

1. Plan, then Worker, then test.

## Acceptance criteria

- [x] A licensed Velopack download redirects without leaking the bearer (test:
      `test/updaterFeeds.test.ts`, "the Velopack package route under licensed or entitled
      delivery (SP-09)").
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

- The Velopack drivers in the SP tasks rely on this.

The role agent sets `--set SP-09 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-09 done`.
