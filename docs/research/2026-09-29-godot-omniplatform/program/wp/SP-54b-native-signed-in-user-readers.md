# SP-54b Native signed-in-user readers: Python, Swift, Kotlin and Godot decode `profile.user.subject`, replay `licenseUserCases`, parity row `license.signedInUser`

| Field       | Value                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                              |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                        |
| Depends on  | [SP-54](SP-54-signed-in-subject-in-licence-document.md)                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [I-24b](I-24b-named-user-seats-sdks.md), [UK-48](UK-48-python-terminal-kit-as-a-mountable-drop-in.md) |
| Role        | `pkey-sdk-porter`                                                                                                                             |
| Plan mode   | no: executes the approved [`plans/SP-54.md`](../plans/SP-54.md) §5 (row 4) and §8 Q3 and Q4 (2026-10-09)                                      |
| Gates       | `all-sdks`, `drift-gate`, `ci:macos`, `ci:kotlin`                                                                                             |
| Human input | none                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                     |

## Goal

The Python, Swift, Kotlin and Godot SDKs read the signed-in subject from the licence document with the same total rule as client-core `licenseUserOf`, replay `licenseUserCases`, and carry the parity row `license.signedInUser`. Python's terminal kit then derives "signed in" from that reader and no longer from the licence holder's email.

## Why

`profile.user` (SP-54) is the signed fact for "a person signed in on this device". The native SDKs already decode `profile` totally and ignore the member, so without a reader their kits keep guessing sign-in from `profile.email`, which is the licence holder's email and is set on key-activated devices too. The Python terminal kit has exactly this bug: `sdks/python/src/polaris_key/ui/terminal/flows.py:189` computes `signed_in = signed_in or bool(profile and profile.email)`, so a key-activated device reads as signed in. SP-54's plan decided the readers get their own small package (decisions Q3 and Q4, approved 2026-10-09) rather than waiting for I-24b.

## Read first

- `AGENTS.md` (always).
- [`plans/SP-54.md`](../plans/SP-54.md): §2 (the rule, the pattern), §4 (`licenseUserCases`, the 14 rows), §5 (the follower table) and §8 Q3 and Q4.
- The reference: `packages/client-core/src/license.ts` `licenseUserOf`, and `conformance/corpus/v2/cases.json` `licenseUserCases` (`expect: {accept, user: {subject}|null}`).
- Each SDK's licence decoder: `sdks/python/src/polaris_key/core/models.py` (`DocProfile.from_any`), `sdks/swift` `Models.swift`, `sdks/kotlin` `Models.kt`, `sdks/godot/addons/polaris_key/services/license.gd` (`PKeyClaims.matches_whole`).

## Scope

**In:**

- **The readers**, each a port of `licenseUserOf`: it returns the subject when `profile` is an object, `user` is an object and `subject` wholly matches `^ps_[A-Za-z0-9_-]{22}$` (whole string, no trailing newline, ASCII classes only); otherwise nothing. Unknown members of `user` are ignored; the member never refuses a document.
  - Python: `license_user()` and `DocProfile.user` (lenient, never raises), sync and `aio`.
  - Swift: `licenseUser()` and `DocProfile.user` in `PolarisKeyCore`.
  - Kotlin: `getLicenseUser()` (or the module's naming rule) and `DocProfile.user` in `:core`.
  - Godot: `get_license_user()` using `PKeyClaims.matches_whole`.
  - The pattern constant comes from the generated constants of each SDK, never a literal.
- **The corpus replay.** Each SDK's conformance runner replays `licenseUserCases` (all 14 rows) and the three SP-54 `licenseDocCases` rows through its reader. No corpus file changes in this package.
- **The parity row** `license.signedInUser` in `conformance/parity/features.json` (family `license`, proof `corpus` with `file: cases.json` and `family: licenseUserCases`), `implemented` in the four SDKs here and in Node and React (SP-54's type and `licenseUserOf` in client-core). Run `pnpm gen constants` so the feature id reaches every SDK.
- **The Python terminal kit fix.** `ui/terminal/flows.py:189` derives `signed_in` from `license_user()`, not from `profile.email`; a test with a key-activated document (a holder email, no `user`) proves it reads as not signed in. UK-48 builds the mount on top of this.

**Out** (and where it belongs instead):

- The signed document, `licenseUserOf` in client-core, the Worker and the corpus (→ SP-54). `licenseNamedUsersOf` and the named-user seat readers (→ I-24a, I-24b).
- Any change to a kit screen or to `requireSignIn()` (→ SP-55 to SP-57, SP-62, the kits' own packages).
- Regenerating the conformance corpus or transcripts. If a runner finds a gap in `licenseUserCases`, it goes back to SP-54 as a bug, not into a second regeneration.

## Design notes

- Corpus-free: the corpus lane is serial and this package only reads files that SP-54 already generated, so it runs in the SDK lane after SP-54 merges.
- A device that signed in just before the Worker deploy has no `user` until its next refresh (about an hour online); the reader returns nothing for it, which is correct.
- Typed N/A: none. React and Node get the type and the client-core reader from SP-54, so their rows are `implemented` by SP-54's type and need no code here.

## UX gate

N/A: no screen, no mockup item and no copy. The Python terminal kit change alters which state a function reports, not any rendered output; its existing goldens must pass unchanged. A UX review is not needed and no `ux-coverage.json` item names this package.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Confirm SP-54 is merged and `licenseUserCases` is in `conformance/corpus/v2/cases.json`.
3. Implement the four readers and runners, the feature row, and the Python kit fix; run each SDK's suite; hand off.

## Acceptance criteria

- [ ] Python, Swift, Kotlin and Godot return the same result as `licenseUserOf` on all 14 `licenseUserCases` rows and accept the three new `licenseDocCases` rows.
- [ ] `license.signedInUser` exists in `features.json`, is `implemented` in every `parity.json`, and `pnpm parity:check` and `pnpm gen constants --check` pass.
- [ ] The Python terminal kit reports `signed_in` false for a key-activated document that has a holder email and no `user`, and true when `user.subject` is present; `flows.py` no longer reads `profile.email` for this.
- [ ] No corpus, transcript or mirror file changes (`pnpm gen corpus --check` clean without regeneration).
- [ ] The green gate passes (`AGENTS.md`), including the SDK suites for what the branch touches.

## Verify

```sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen constants --check
mise exec node@22 -- pnpm gen corpus --check
# per SDK: sdks/python pytest; swift test --package-path sdks/swift; gradle :conformance:test; sdks/godot/tools/run_tests.sh
```

Then the full green gate in `AGENTS.md`.

## Hand-off

UK-48 relies on the Python reader and on `signed_in` no longer coming from the email. I-24b builds `seatHolder()` on these readers.

The role agent sets `--set SP-54b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-54b done`.
