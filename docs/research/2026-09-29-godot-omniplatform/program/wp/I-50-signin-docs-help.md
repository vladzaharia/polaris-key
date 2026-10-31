# I-50 Automatic sign-in docs, Help and privacy pages (approve-a-sign-in, features/sign-in/nearby)

| Field       | Value                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16)                                       |
| Size        | 0.4–0.6 engineer-weeks                                                                                   |
| Depends on  | [I-13](I-13-exchange-endpoint.md), [I-43](I-43-link-offer.md), [I-40](I-40-account-initiated-pairing.md) |
| Unblocks    | none                                                                                                     |
| Role        | `pkey-implementer`                                                                                       |
| Plan mode   | no                                                                                                       |
| Gates       | docs-links, docs-generated, docs:privacy                                                                 |
| Human input | none                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                |

## Goal

Automatic sign-in docs, Help and privacy pages (approve-a-sign-in, features/sign-in/nearby). Scope, wire shapes, slices and tests: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md), see the work-package table. The program view is [`plans/CC-01.md`](../plans/CC-01.md) §4.

## Plan

- Plan: [`plans/CC-01-auto-sign-in.md`](../plans/CC-01-auto-sign-in.md) (section named in the graph row's `refs`).
- Combined plan, decisions R-1 to R-18 and owner answers: [`plans/CC-01.md`](../plans/CC-01.md).

## Acceptance criteria

[ ] see plan

## Handoff from I-49.16 (silent restore)

I-49.16 documented restore where the pages exist today. I-50 owns the pages that do not exist yet.
Link to these anchors; do not restate their facts.

Written by I-49.16:

- SDK sections: [Swift](/docs/build/sdks/swift/#restore-from-backup),
  [Kotlin](/docs/build/sdks/kotlin/#restore-from-backup), and a "planned" paragraph on the Godot page
  until I-49.15 lands (then replace it with a section like the other two).
- `build/manifest/product.md`: the `identity.restore` member.
- `help/emails.md`: the restore notice ("signed in on a new device from your backup", its **Sign
  out everywhere** action).
- `operate/platform/email.md`: the Apple relay sender must be registered (`EMAIL_APPLE_RELAY`)
  before `launch.identityRestore` goes on.
- `docs/PRIVACY.md` and `docs/security/THREAT-MODEL.md`: the restore rows.

I-50 still writes:

- `features/sign-in/automatic.mdx`: a restore section (what rung 2 is, where the key lives, used
  once, revoked at sign-out, the opt-out `AutoSignInOptions.restore` / `AndroidOptions.restore`,
  default on, and `identity.restore` for the product). Link the SDK anchors above. The settings
  reference already links `/docs/features/sign-in/` for `identity.restore`.
- `help/sign-in-automatically.mdx`: "Signed in from your backup" (what the email means, how to end
  it) and the shared Apple ID note: two people who share one Apple ID restore into the account that
  signed in last.
- Godot: when I-49.15 ships, add its restore section to `build/sdks/godot` and drop "planned".

Facts to keep consistent (all from `WIRE-CONTRACT-V5.md` §12.11.8): a key is used once, lives 180
days after its last check, and reaches one product and one account; Block Store reaches the cloud
only where it reports end-to-end encryption; Linux and Windows exports skip the rung.

Known behaviour, documented in the Swift section: with two or more Apple devices on one Apple ID the
shared iCloud Keychain item is rewritten by each device's daily check. It is harmless; the newest
key wins.
