# PX-22 Account → Profile: `ProfileEditor`, `Avatar` everywhere (header, menu, consent, TV done), name chips, picture tiles, upload

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.1–0.2 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-07](PX-07-account-v1.md), [PX-W16](PX-W16-profile-avatars.md)                                                                                                                        |
| Unblocks    | none                                                                                                                                                                                     |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Goal

`#/account/profile` lets the person choose a display name and picture from linked providers, type or upload, with explicit-choice tags, and `Avatar` replaces initials everywhere it appears.

## Why

Owner decision: import profile data from identity providers ([PORTAL.md §4.30](../../../../design/PORTAL.md#430-account--profile)). PORTAL.md sizes this S (≤ 1 agent-day); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.30](../../../../design/PORTAL.md#430-account--profile)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `ProfileEditor`, `Avatar`, name chips, picture tiles, upload.

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- **Reuse first** (§5.1): build on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`; new components live in `packages/admin/src/portal/components/` unless the console can use them too. Everything stays CSP-safe: no inline styles or scripts, images same-origin only (`img-src 'self' data:`).

## Corrections (verified against the code, PX-22)

- **Consent and TV done do not exist in the portal yet.** The consent person row (frame 12) and the
  TV done row (frame 15) are PX-14's (`AppConsent`, the device-code done step), still `todo`. PX-22
  ships `Avatar` ready for them (`picture` from the signed-in session, never before
  authentication) and puts it in the header chip, the account menu and Account → Profile. PX-14
  must pass the session's `avatarUrl` to `Avatar` in those two rows.
- **The API is PX-W16's as built:** `GET /api/me` carries `avatarUrl` (256 px; the `-96` suffix
  names the small one), `GET /api/me/profile` returns `{ profile }` with `displayNameSource` /
  `pictureSource` (`provider` with `linkId`, `typed`, `upload`, `initials`), the explicit flags and
  `sources[]` (`linkId`, `provider`, `label`, `name`, `picture`). `PATCH` takes `name` or
  `nameFrom` and `picture: "initials" | {from} | {upload}`; refusals carry `reason`
  (`invalid_name`, `unknown_source`, `no_name`, `no_picture`, `unknown_upload`, `too_large`,
  `unsupported_type`, `unreadable_image`) and the editor's copy is chosen from it.
- **Copy.** UK-02a's catalog serves the SDK UI kits and the portal does not read it, so the
  strings live in `packages/admin/src/portal/copy/profile.ts` under the `profile.*` keys they move
  to, marked for the catalog.
- **`Avatar` stays in `portal/components/`.** It has no portal imports (the badge is a slot), so
  UX-13 can move it to `ui/` when the console's account chip adopts it (EXPERIENCE.md §0.6 P5).
- **Source line.** A persona names the account ("picture from Steam (marafox)", frame 36); an
  address is left out ("Name from Apple", frame 38), since it is often an Apple relay address and
  Sign-in methods lists it.

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-22:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-22 in-review`.

## Acceptance criteria

- [x] Explicit-choice test.
- [x] No picture is shown before authentication (test).
- [x] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [x] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [x] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [x] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- portal
```

## Hand-off

[PX-14](PX-14-passthrough-header.md): render `Avatar` with `picture={account.avatarUrl}` in the
AppConsent person row (frame 12) and the device-code done row (frame 15), never before
authentication. Recorded in PX-14's Amendments.

The role agent sets `--set PX-22 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-22 done`.
