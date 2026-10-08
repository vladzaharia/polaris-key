# UK-49 SwiftUI kit and Swift SDK 0.8.x correctness pass

| Field       | Value                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (SDK usability review (2026-10-08)) |
| Size        | 1–1.5 engineer-weeks                                                                                      |
| Depends on  | none                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                    |
| Role        | `pkey-sdk-porter`                                                                                         |
| Plan mode   | no                                                                                                        |
| Gates       | `ui-snapshots`, `ci:macos`                                                                                |
| Human input | none                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                 |

## Goal

SwiftUI kit and Swift SDK 0.8.x correctness pass, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (UK-49) and §10.4.

## Scope

**In:** terminal gate states get actions (use a different key, sign in, renew or manage, a host slot) with matching copy; `.polarisKey(client, theme:, options: GateOptions)` keeps the device-limit manage URL and return URL, key entry and offline activation (off on iOS); `ActivationResult` redacts its token; `StoreError` is a `LocalizedError`; the accent through `PolarisAccent.resolve`; Return submits and refusals are announced; the default name from `CFBundleDisplayName`; no activation card before the first reload; "Signed in as" with "Not you?" on ready; the `WebAuthenticationSignInBrowser` isolation fix; no `try?` in `client.update`; update-not-configured copy; `LicenseClient.deactivate()` emits the licence event; `JSONValue` descriptions; the five README snippets, `platforms:` and `from:`.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism this package names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] UI tests drive a licence to expired and to revoked and reach the activation form through "Use a different key" and through Sign in without relaunching.
- [ ] A device-limit refusal shows a working "Replace a device".
- [ ] No `pkeyt_` in `String(describing:)`, `String(reflecting:)` or `dump`.
- [ ] Contrast at least 4.5:1 on `#FF6A3D` in both schemes.
- [ ] A licensed cold launch never renders the activation card (first-frame snapshot).
- [ ] The README blocks compile in SP-45b's lane.
- [ ] `pkey-ux-reviewer` passes every changed screen.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set UK-49 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-49 done`.
