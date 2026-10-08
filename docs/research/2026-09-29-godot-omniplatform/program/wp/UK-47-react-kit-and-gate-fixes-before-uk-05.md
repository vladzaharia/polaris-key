# UK-47 React kit and gate fixes before UK-05

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 1.2–1.6 engineer-weeks                                                                                    |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                    |
| Role        | `pkey-implementer`                                                                                        |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`, `modernity-lint`                                                                          |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Goal

React kit and gate fixes before UK-05, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-47) and §10.4.

## Scope

**In:** no wire change, no new names (additive fields only once SP-35 names them). The bearer device-code hand-off from the `signInWithOidc` handle (code, open, copy, QR, expiry, cancel) with every rejection in the card; refusals stay on login with the typed key, the custom slot and "Replace a device"; refreshes never clear an activation refusal; revoked gets three actions and 401 backoff; typed update codes, never "up to date" after a failure, one shared check; a StrictMode-safe Provider; a development-only error for missing pins or an origin missing from `web.origins`; `React.JSX.Element` and a React 18 and 19 consumer typecheck; `lastVerifiedAt` in seconds; one discovery fetch per load; hard-coded strings into `theme.copy`; copy helpers re-exported from the root; `PolarisLogout` visible on a light host; React added to kit-lint with its debt recorded, and Playwright baselines of today's kit.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No wire change and no new names; additive fields only once SP-35 names them.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Jsdom tests over transcripts: bearer sign-in shows the code and URL and Cancel stops polling.
- [ ] A refused key keeps the screen, the key and the message across a refresh.
- [ ] Device-limit shows "Replace a device" with a `manageUrl`.
- [ ] Revoked has at least two actions and backs off.
- [ ] A 404 on `/update/version` never shows "up to date".
- [ ] `onConfigChange` fires under StrictMode.
- [ ] The corpus and transcripts are unchanged.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-47 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-47 done`.
