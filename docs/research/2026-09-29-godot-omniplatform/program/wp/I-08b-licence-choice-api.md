# I-08b Licence choice at sign-in: the choice API, grant routes, Replace, key in the card and the first automatic licence

| Field       | Value                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (layer-1, phase-1a)                                                                                                                          |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                          |
| Depends on  | [I-08](I-08-app-passthrough.md)                                                                                                                                                                                 |
| Unblocks    | [I-10a](I-10a-sdk-identity-node-react-python.md), [I-10b](I-10b-sdk-identity-swift-kotlin-godot.md), [I-32](I-32-product-connections-absorbs-i-22.md), [I-34](I-34-granular-consent-connected-apps.md)          |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                           |
| Plan mode   | yes: executes the approved [`plans/I-08.md`](../plans/I-08.md) (lead, 2026-10-17) §3 and the licence-choice half of [`plans/I-04.md`](../plans/I-04.md) §C, §F, §G and [`plans/I-27.md`](../plans/I-27.md) §2.2 |
| Gates       | plan mode; `errors.json` (rule 3); transcripts (rule 1) with the Swift and Godot mirrors; `gen constants --check`; `parity:check`; rule 10 (OpenAPI + `routeCoverage`); THREAT-MODEL; `test:workerd`            |
| Human input | none                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                       |

## Goal

A person signing in to an app on the web redirect chooses a licence (or replaces a device, or enters a key) either on the card or, with `license_choice=app`, in the app through a pending sign-in grant. With no candidate licence and a granting policy, the Continue press mints the first licence once. All of it sits on I-08's `authorize` and `token`, behind the product's Identity toggle. Device code is not part of it (I-37).

## Why

This is the half of I-08 that decides which licence a device runs on ([I-04 §G](../plans/I-04.md)). It was split off because the grant, Replace and the mint are each a security surface of their own ([I-08 plan](../plans/I-08.md) D2, lead 2026-10-17).

## Read first

- `AGENTS.md` and `CLAUDE.md` (plan mode); [`plans/I-08.md`](../plans/I-08.md) (§0, §3, D2, D5); [`plans/I-04.md`](../plans/I-04.md) §C, §F, §G; [`plans/I-27.md`](../plans/I-27.md) §2.2.
- `packages/worker/src/core/licensing/anchor.ts` (`bindSignedInDevice`, `rankAnchorCandidates`), `core/licensing/issue.ts` (`issueLicense`, `identityIssuePolicy`), `core/licensing/keyEntries.ts`, `services/identity/portal/freeDevice.ts`, `services/identity/passthrough/`.

## Scope

**In:**

- **Licence choice (I-04 §C, §F, §G).** `GET /api/signin/requests/:handle/licenses` (`LicenseChoiceView`: `current`, `access` (`"seats" | "account"`, never a displayed type), `keep` only for a licence outside `choices`, `create` with `access`, `getLicense` with `keyEntry`) and `GET …/licenses/:licenseId/devices` (`ReplaceView`). The Continue `POST` takes `choice` (`license` with an optional `replaceDeviceId`, `keep`, `create`, or `{kind: "key", key}`) and stores it on every binding route's flow or code record. App mode: `license_choice=app` on `authorize` and the `licenseChoice` member on PX-W13's `request` with its echo; `token` answers `{status: "choose", grant, expiresIn, choices}`; the grant routes `POST /<p>/identity/choice/{licenses,devices,complete,cancel}` (nested Polaris errors, including `400 invalid_grant`), and `choice/complete` answers the same token response; discovery endpoints `choiceLicenses`, `choiceDevices`, `choiceComplete`, `choiceCancel`.
- **First automatic licence (I-27 §2.2, D4).** With no candidate licence and a policy that grants one, the card skips LicenseChoiceStep and always shows ConsentStep ("New: <Tier> license, created when you continue"); that press mints and then binds. Until LX-36 and LX-38: policy is P0-20's `identityIssuePolicy`; the mint is P0-20's `issueLicense(product, holder, via, target, device?)` with an account holder (origin `oidc`, `account_id` set, `sub` NULL, no key; I-08 adds the account arm if P0-20 ships only the identity holder), then I-09's `bindSignedInDevice(…, {kind: "create"})`; uniqueness is a `"license-mint"` `SingleUseKind` claim (`<product>:` plus a peppered hash of the account id, `putArtefact(…, 30, {ifAbsent: true})`). The winner re-reads `rankAnchorCandidates` and mints only if there is still no candidate; a loser answers `409 license_choice_required`; an unreachable store fails closed. Discover's `issueIdentityLicense` takes the same claim.
- **Replace a device.** `freeAccountDevice()` (`portal/freeDevice.ts`) returns its statements and the Continue appends the guarded seat claim in one D1 batch; `signin.replace.racedAfterFree` only if the claim cannot join. Replace shares the portal's `portalDeviceDisconnect` budget (20 per 60 s), audit row and `deviceRemovedNotice` email; a blocked Replace answers `429 rate_limited` with `retryAfter`.
- **Key entry in the card.** An app-mode `{kind: "key"}` choice through `choice/complete` records exactly one `app` key entry through PX-W9's `authorizeDevice(…, {keyEntry: {surface: "app"}})`, atomically with the seat claim, and refuses with `key_entry_limit` when the limit applies. Choosing a licence, Keep, Create and Replace are never counted.
- **Where the mint happens (plan D5).** The Continue press mints the account licence under the `"license-mint"` claim; the device is bound at `token` (no device exists at Continue). `token` answers `{status: "choose", grant, expiresIn, choices}` when `license_choice=app` and a choice is due, and `409 license_choice_required` when the step was shown and no choice arrived.
- **Contract artefacts.** `errors.json`: `license_choice_required` (409). Transcripts: `redirect-web-choose.json`, `redirect-web-choose-app.json`, `choice-replace-app.json`, `choice-key-app.json` (expects `keyEntries`), `choice-grant-errors.json`. Parity row `identity.choice`, `planned` in all six SDKs. Discovery endpoints `choiceLicenses`, `choiceDevices`, `choiceComplete`, `choiceCancel`. OpenAPI, `ServiceDescriptor.surface` and `routeCoverage` for the four `choice/*` routes and the two portal reads. If views change, `pnpm gen ui-matrix` (UK-02b §4.8).

**Out** (and where it belongs instead):

- `authorize`, `token`, Continue, Cancel and hints (→ I-08).
- Device code of any kind (→ I-37). SDK calls (→ I-10a, I-10b). LX-38's `accessFor()` swap and the unique index (→ LX-38).

## Design notes

- **The choice grant (I-04 §G.6).** 32 random bytes, hashed in the KV flow record, 300 s, bound to the product, account, subject, the redeeming `X-PKey-Device` and the PKCE verifier; one per flow, consumed by `complete` or `cancel`; one `404 not_found` for every licence outside the view or not replaceable; 30 reads per grant.
- **No grant outside the same-device channels.** Device code never issues one.
- **Check at start (plan D7):** whether P0-20's `issueLicense` has an account-holder arm; add it if missing.
- `PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2, `transcriptVersion` 1. Additive; no signed shape changes.

## Steps

1. `errors.json`, contract text and types for the choice views and grant requests.
2. The choice reads, Continue's `choice`, and `bindSignedInDevice` at `token`.
3. The grant routes, Replace and key-in-card.
4. The first automatic licence and the concurrency claim.
5. Transcripts, parity row, OpenAPI, THREAT-MODEL rows for the choice grant and Replace.

## Acceptance criteria

- [x] `choice/complete` and `token` answer the same shape (test).
- [x] A mint only at Continue; two concurrent Continue presses on one account, and a Continue racing a Discover add, leave exactly one licence; the loser answers `license_choice_required`; an unreachable store mints nothing (tests).
- [x] Sign-in never mints while the account holds a usable licence unless `choice.kind` is `create`; Continue without a choice answers 409 when the step was shown (tests).
- [x] A grant from another device id answers `invalid_grant`; `choice/devices` answers one `404` for unknown, foreign and non-replaceable licences (tests).
- [x] Replace and the portal's Remove share one budget and write the same audit row (test).
- [x] With the product's Identity toggle off, every choice route is refused and discovery lists none (test).
- [x] Transcripts and mirrors recorded; `errors.json`, parity row, OpenAPI and `routeCoverage` updated; `PROTOCOL_VERSION` unchanged.
- [x] Docs in this PR: its part of `features/sign-in/*`, `help/account` and `help/connected-apps`.
- [x] The green gate passes, including every drift gate listed in the header (one pre-existing admin failure, `approveRecipe.test.tsx`, is on `integ/next` and untouched).

## Corrections to the brief (code is the fact; 2026-10-17)

- **Account arm (D7).** P0-20's `issueLicense` has only the identity (`sub`) holder. The account arm is a sibling, `issueAccountLicense(db, product, accountId, identity, via, now)` in `core/licensing/issueAccount.ts`: same policy (`identityTier`), provisioning and audit, origin `oidc`, `account_id` set in the insert's batch (`stmtAttachNewLicense`), no `sub`, no key. `accountGrant` is its read-only twin.
- **Route rows.** The table forbids `bodyCap` on a non-CI row (`serviceRouteTables.test.ts`), so the four `choice/*` rows are `auth: code`, POST, and the handler reads its 4 KiB cap with `readCiJson`.
- **Key in Continue.** Continue refuses `{kind: "key"}` (and `keep`: a browser has no device): a key is never stored on a code. A key is entered through `choice/complete` only.
- **Replace on the card path.** Continue validates the intent dry and stores `replaceDeviceId` on the code; `token` runs `planFreeAccountDevice` and the seat claim in one batch (`claimDeviceSeat`'s new `freeing` option, `authorizeDevice`'s `replace`). `racedAfterFree` is the fallback only if the claim cannot join the batch.
- **`origin` of a choice row** is `signin` (no key, held), `free` (enrolled), `key` or `developer`; `purchase` and `store` need `licenseProvenance` and are a follow-up.
- **No choice at `complete`** (member absent) is `409 license_choice_required` and keeps the grant; a malformed choice is `400 bad_request`.
- **App-mode choice due.** A candidate, a Keep, or the no-licence state of a product that accepts keys. A product with License on, no licence and no grant therefore always answers `choose` (state `none`) in app mode; the app can cancel or enter a key.
- **Transcripts.** `choice-grant-errors.json` records the lapsed grant, a licence outside the view, no choice, and a second complete. The other-device grant and the 31st read need a second device id or 30 identical steps and are worker tests (`identityChoice.test.ts`). The replaced device's next 401 is a worker test too (the recorder has one device id).
- **Review notes taken (token.ts).** (1) A licence-less device row holding a credential is re-registered only with its own Bearer proof (`403 not_entitled` otherwise). (2) `configured` means only that `authorize` and `token` are served; WIRE-CONTRACT-V4 §12.6 now says clients gate on endpoints. (3) **Not done, follow-up (plan mode):** `redirect_uri` required at `token` when it was sent at authorize (RFC 6749 §4.1.3). The approved I-27 §2.1 and I-08 §3 say "compared exactly when sent"; making it required changes §12.5 rule 1 and the SDK request, so it needs its own plan (proposed owner: I-10a/I-10b for the SDK side, a one-line §12.5 change and a `token` check).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- identity choice grant
mise exec node@22 -- pnpm gen transcripts --check
```

## Hand-off

I-10a and I-10b implement the `choice.*` primitives against these transcripts; LX-38 swaps in `accessFor()` and deletes `"license-mint"`.

The role agent sets `--set I-08b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-08b done`.
