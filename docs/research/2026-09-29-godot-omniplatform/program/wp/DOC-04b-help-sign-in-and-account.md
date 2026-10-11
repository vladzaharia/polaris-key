# DOC-04b Help: sign-in and account

| Field       | Value                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Help)                  |
| Size        | 0.4 engineer-weeks                                                                                                           |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-06a](DOC-06a-portal-entry-points.md), [DOC-06b](DOC-06b-worker-entry-points.md) |
| Role        | `pkey-implementer`                                                                                                           |
| Plan mode   | no                                                                                                                           |
| Gates       | `docs-generated`, `docs-links`                                                                                               |
| Human input | none                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                    |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-04b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `sign-in`, `code-didnt-arrive`, `passkeys`, `approve-a-sign-in`, `secure-your-account`, `account`, `join-accounts`, `delete-account`, `your-data`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`components/signin/*`, `AccountPage.tsx`, `account/SessionsCard.tsx`; worker `identity/card/*`, `identity/passkeys/*`, `identity/portal/{selfService,notices}.ts`; `docs/PRIVACY.md`, REVIEW-NOTES.md; SIGN-IN.md

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Screen acceptance (brand transition, 2026-10-09)

N/A: no screen or state ships in this package (selected by the overview-04 rule on its gate or mention only).

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] As DOC-04a.
- [ ] Owner placeholders tracked on the owner-steps checklist.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
- [ ] A plain-language critic (a fresh subagent with no repo context, reading as someone who never chose Polaris Key) finds nothing blocking, citing `page#anchor` for each finding (§6.3).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-04b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-04b done`.

## Correction (2026-10-11)

The code differs from this brief and from docs plan §7.1 in these places. The pages say what the code does.

- **Sources moved.** The sign-in UI is `components/signin/{LoginCard,ProviderRow}.tsx` and `pages/SignInPage.tsx`; the account UI is `pages/AccountPage.tsx` and `components/account/*`; the worker code is under `packages/worker/src/services/identity/{card,passkeys,portal,accounts}/`; `REVIEW-NOTES.md` is `docs/legal/REVIEW-NOTES.md` and `SIGN-IN.md` is `docs/design/SIGN-IN.md`.
- **Passkeys.** The portal uses a passkey only to add one and to **Confirm it's you first**. The sign-in page has no passkey option (nothing calls `navigator.credentials.get` with conditional mediation), so `passkeys` covers add, use (confirm), remove and the last-method guard.
- **Apple, Google and Steam on the sign-in page.** `GET /api/capabilities` sends no `providers`, so the SPA draws no provider row. `sign-in` leaves it out; **Connect** in Account works and is on `account`.
- **Approve a sign-in.** The portal's "Approve a new device" (PX-W14) has no screen (PX-15), and "Didn't start this yourself? Cancel it" exists only in the kit catalog. `approve-a-sign-in` documents the Worker's device-code pages: "Connect a device to …", "Authorize …" and **Continue to sign in**.
- **Join and undo.** The join API and its 72-hour undo exist (PX-W12), but no portal screen offers them (PX-15's `LinkAccounts`; PX-21's email gate step). `join-accounts` covers **Add an email**, **Add your real email** and the `email_in_use` and `link_conflict` messages as the portal words them. Join and undo steps belong to PX-15's package.
- **Steam.** No code attaches a license through a Steam sign-in (LX-11 and CM-24 are todo), although the library's **Missing a license?** strip says "Add Steam under Sign-in methods". The page says only that **Connect** adds Steam as a sign-in method and points to **Restore purchase**. The strip's copy needs a fix.
- **Security check.** No widget is rendered and the Turnstile secret is deliberately unset (owner steps, "Already done for you"), so `code-didnt-arrive` quotes the `turnstile_failed` message and the portal's own wording and describes no check on screen.
- **Hide My Email.** The Worker refuses Apple relay recipients until `EMAIL_APPLE_RELAY` is `registered` (owner steps 1b.5), so the page says Polaris Key "may not be able to send" to them.
- **Data export.** None exists. `your-data` says nothing about one and sends "ask for a copy" to **Get help with an app**, which names no Polaris Key address (D4).
- **Notices.** "A new device signed in" is sent only after a device-login approval (API only), so `secure-your-account` does not promise it for ordinary sign-ins.
- **Cloud Sync.** The legacy page said deleting the account deletes Cloud Sync data. The Cloud Sync service registers no erasure store, so `delete-account` does not say it.
- **Style guide against the lint.** The style guide defines a passkey with "fingerprint", which Help's word list refuses; `passkeys` says "face or PIN".
- **Legacy anchors.** The rewrite removed `#signing-in`, `#downloading-releases`, `#package-access` and `#deleting-your-account` from `help/sign-in`, so one link each moved in `help/messages/index`, `help/update`, `features/ship-builds/packages/index` and `help/sync`.
- **Owner placeholders.** Support and privacy addresses and counsel sign-off are already items 8f.1 and 8f.2 of the owner's checklist (`~/Downloads/polaris-key-owner-steps.md`). The Apple relay registration (1b.5) and the Help text that depends on it are recorded as 8f.3 there.
- **Privacy source out of date.** `docs/PRIVACY.md:224-225` ("Not collected: Hostname … None of these are read by any SDK") is stale against `docs/security/WIRE-CONTRACT-V4.md:1483-1489` (the native SDKs send the device label, by default the host name; `packages/sdk-node/src/core/deviceLabel.ts:5-8`). `your-data` says apps usually send the computer's name. This package does not edit PRIVACY.md. DOC-12b (`reference/what-apps-collect`, which renders it) must fix the line before its page ships.
- **Plain system facts.** The CPU model, core count, total RAM and machine model reach the Worker as plain facts beside the scrambled fingerprint (`docs/PRIVACY.md:75-76`; `packages/sdk-node/src/devices/facts.ts:105-110`; `packages/worker/src/core/devices.ts:1384-1387`), and the console shows them (`packages/worker/src/core/console/deviceShape.ts:55-61`). Browser apps send processor cores and memory (`packages/sdk-react/src/browser/bearer/facts.ts:43-54`). A developer can turn off only the identifiers (`docs/legal/REVIEW-NOTES.md` item 2.10). `your-data` says so, and no longer says the app scrambles the model, processor and memory.
- **Deletion and developers.** `subject.deleted` goes into the developer's pull feed and push webhooks are not built (`packages/worker/src/services/identity/accounts/events.ts:1-5`), so `delete-account` says each developer's records show the deletion and that nobody is notified. Backups keep deleted rows for up to 30 days (`docs/PRIVACY.md:289-290`), and the page says that too. The deletion email's subject is "Your Polaris Key account has been deleted" and it has no **Wasn't you?** link (`packages/worker/src/services/identity/portal/notices.ts:337-348`); "Your account was deleted" is the portal's toast and the heading of the emails page, so `delete-account` quotes the subject and sends a reader who didn't delete to the emails page, not to `secure-your-account`.
- **Sign-in link.** In the browser that asked for the code, the email link opens a page headed "Sign in to Polaris Key" with **Continue as** the address and a **Sign in** button. Only another browser shows **Confirm sign-in** (`packages/worker/src/services/identity/card/emailSignIn.ts:701-739`). `sign-in` describes both.
- **Rate-limit wording.** The catalog's `rate_limited` ("Wait a moment and try again") and the sign-in page ("Too many codes. Try again in a few minutes.", `SignInPage.tsx:229-231`) differ, so `code-didnt-arrive` names both. The page's message comes only from the per-network start limit of 8 a minute (`packages/worker/src/services/identity/card/emailSignIn.ts:109-110,243-254`). The per-address hourly and daily limits and the lockout answer like a send (`emailSignIn.ts:350-357`), so the page says to wait a few minutes and then points to its list of silent limits.
- **Device records outlive removal.** Removing a device deletes its fingerprint and `device_facts` rows only (`packages/worker/src/core/repo.ts:1713-1743`). The device row keeps its name and `reported_json`, the last report with the system details (`packages/worker/src/core/devices.ts:1189-1211,1437-1447`), until the license is deleted (`packages/worker/src/core/licensing/licenseDelete.ts:217`; `docs/legal/REVIEW-NOTES.md` item 2.2). `your-data` says the scrambled identifiers go with the device and the name and last system details stay with the license. `docs/PRIVACY.md:25-28,231-232` say facts are "deleted with the device" and DOC-12b should say the same as the code when it renders them.
- **Where the address goes.** When owner item 8f.1 is done, replace "Polaris Key doesn't publish a help address." in `code-didnt-arrive`, `secure-your-account` and `delete-account`, and "Polaris Key doesn't publish a privacy address." in `your-data`, with the address. Each sits beside a **Who to contact** link to `/docs/help/contact/`.
