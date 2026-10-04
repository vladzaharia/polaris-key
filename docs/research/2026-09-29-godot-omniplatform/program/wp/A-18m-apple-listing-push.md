# A-18m Apple listing push: widen the App Store rule table to listing text and screenshot sets

| Field       | Value                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                                                |
| Size        | 1–2 engineer-weeks                                                                                                                                        |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md), [A-18d](A-18d-listing-asset-derivation.md), [A-17d](A-17d-asc-distribute.md) |
| Unblocks    | none                                                                                                                                                      |
| Role        | `pkey-implementer`                                                                                                                                        |
| Plan mode   | no: a Worker rule-table change, not a wire change                                                                                                         |
| Gates       | THREAT-MODEL review trigger (a `core/storefront/rules/*` change); spec classification; adapter conformance                                                |
| Human input | none (owner decision 1 approved it on 2026-10-04)                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                 |

## Goal

The shared listing model reaches the App Store. The Apple rule table allows the listing text and
screenshot writes of owner decision 1, with plain confirmation, and the Apple adapter's
`writeListingText` and `writeListingAssets` push A-18b's projection and A-18d's screenshots.

## Why

**Owner decision 1 (2026-10-04): yes.** Without it, Apple would be the one store whose listing is
not filled from the model; A-17d only writes `whatsNew` and `promotionalText`
([S-15 §7.5](../../notes/S-15-storefront-provisioning.md#75-how-apple-consumes-the-model)).

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§7.5**, §6.2, §11 (A-18m), §13
  decisions 1 and 2.
- `core/storefront/rules/appStore.ts` (A-17a's table, moved by A-18a) and the denied reasons
  `listingOutsideSurface` and `uploads` in its deny classification.
- A-17d's Distribute API (the version and localization reads).

## Scope

**In:**

- Allow rules for: `appStoreVersionLocalizations` `description`, `keywords`, `marketingUrl`,
  `supportUrl`; `appInfoLocalizations` `name`, `subtitle`, `privacyPolicyUrl`; `appScreenshotSets`
  and `appScreenshots` (reserve, PUT, commit). Move them from the deny classification to allow;
  the spec classification stays complete.
- The Apple adapter's `writeListingText` (from A-18b's Apple profile: keywords packed under 100
  bytes, comma-joined) and `writeListingAssets` (screenshots from the blob store, decision 2).
- Natural keys: existing localization per locale; screenshot by checksum within its set.
- THREAT-MODEL: record the widened surface under the §9 review trigger.

**Out:**

- Deleting screenshots or screenshot sets: denied, as every delete is. Replacing a set uploads new
  screenshots and leaves removal of old ones to a deep link, as on Play.
- App icon (it ships in the build, not as a listing asset). App Privacy (a legal declaration,
  stays in App Store Connect).

## Design notes

- Plain confirmation for text and screenshots (decision 1). Submit, release and price changes stay
  typed, unchanged.
- Never delete, never touch users, payments or signing keys: the conformance suite's never-list
  check must still pass with the widened table.
- Decision 2: screenshots go from the Worker out of the blob store; binaries never.

## Acceptance criteria

- [ ] The rule-table diff adds exactly the listed allows; no `DELETE` and no never-list path
      becomes reachable.
- [ ] The spec classification and the conformance suite pass for Apple.
- [ ] THREAT-MODEL records the change; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront asc
```

## Hand-off

A-18j's Listing editor offers "Push listing" for Apple once this lands.

The role agent sets `--set A-18m in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18m done`.
