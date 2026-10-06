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

> **Corrections from implementation (2026-10-04).** The code is the fact; where this brief and
> the branch disagree, the branch wins.
>
> - **The PUT is not a rule-table entry.** The upload operations' PUT goes to Apple's presigned
>   upload hosts, not to an App Store Connect API path, so it cannot be an `ASC_WRITE_ALLOW` rule
>   (the spec classification would reject it). It is one upload rule, `ASC_SCREENSHOT_UPLOAD`, on
>   A-18a's upload matcher, checked by `checkAscUpload` (`rules/appStore.ts`) from
>   `core/asc/upload.ts` before any byte is read: `PUT` only, `https` on an `apple.com` host, PNG or
>   JPEG within 32 MiB. The PUT carries no `Authorization`. The allows added to the table are
>   exactly the listed ones: the four version-localization attributes, `POST`/`PATCH
appInfoLocalizations`, `POST appScreenshotSets`, `POST appScreenshots` (reserve) and `PATCH
appScreenshots/{id}` (commit, `uploaded: true` only).
> - **The set's membership `PATCH` stays denied.** `PATCH appScreenshotSets/{id}/relationships/
appScreenshots` replaces the set and so drops screenshots; it stays in `uploads`. New
>   screenshots are appended; removal and reordering are the deep link, as on Play.
> - **Display types.** The model's Apple size classes map to `APP_IPHONE_67` (iPhone 6.9″ and
>   6.7″), `APP_IPAD_PRO_3GEN_129` (iPad 13″ and 12.9″) and `APP_DESKTOP` (Mac); the gate admits
>   those three on a version localization only. A-18b's Apple column gained the three image slots.
> - **Where the push lives.** Two connector controls beside A-17d's Distribute,
>   `listing/text` `{versionId, locale}` and `listing/screenshots` `{versionId, locale,
sizeClass}` (`connectors/asc/listingPush.ts`), on A-17d's flow plumbing. The text push includes the
>   model's promotional text (already allowed) but not What's New, which stays the release's
>   (`distribute/version-localization`). The name, subtitle and privacy URL need an editable app
>   information (`app_info_not_editable` otherwise).
> - **Natural key of a screenshot.** Apple's `sourceFileChecksum` is an MD5, which the Worker
>   computes by streaming the blob (`node:crypto`); the file name also carries the SHA-256, so
>   either identifies the screenshot within its set.

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

- [x] The rule-table diff adds exactly the listed allows; no `DELETE` and no never-list path
      becomes reachable.
- [x] The spec classification and the conformance suite pass for Apple.
- [x] THREAT-MODEL records the change; the green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront asc
```

## Hand-off

A-18j's Listing editor offers "Push listing" for Apple once this lands.

The role agent sets `--set A-18m in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18m done`.
