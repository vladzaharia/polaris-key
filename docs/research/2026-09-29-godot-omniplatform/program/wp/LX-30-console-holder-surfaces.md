# LX-30 Console holder surfaces: Holder column and filters (holder, batch) on Licenses, the record's holder line with **Assign…**, **Send a new key…**, **Reassign…** and **Make floating…** (I-12's relink tool, typed confirmation), and the batch page with **Disable unused keys…**

| Field       | Value                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (S-24: licence holders)                            |
| Size        | 0.6–1 engineer-weeks                                                                                          |
| Depends on  | [LX-26](LX-26-licence-holders-worker.md), [LX-28](LX-28-bulk-floating-keys.md), [I-12](I-12-console-users.md) |
| Unblocks    | [LX-31](LX-31-holders-closeout.md)                                                                            |
| Role        | `pkey-implementer`                                                                                            |
| Plan mode   | no                                                                                                            |
| Gates       | console CSP parity; rule 10 (OpenAPI + `routeCoverage`, for Make floating); THREAT-MODEL; docsLinks           |
| Human input | none                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                     |

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`. Each item names the package whose review raised it.

- **Activity verbs for the holder actions** ([LX-26](LX-26-licence-holders-worker.md)). LX-26 writes
  two actions that have no phrase in `console/pages/core/activityVerbs.ts`, so they would show as
  raw codes:
  - `license.holder.assign`, in the product's console trail (`audit`), when a `PATCH` gives a floating
    licence an email (`services/license/admin/licenses.ts`);
  - `account.license.auto_attach_block`, in the account's own history (`portal_audit`), when a
    removal or a reassignment keeps the licence from re-attaching (`accounts/claim.ts`).

  Add both phrases. The Activity page, and the record's **View in activity**, read only `audit`,
  so the block row shows only where this package surfaces the account's history for the licence
  (the record's holder line or its history).

- **Make floating writes the block through `reassignLicense`** ([LX-26](LX-26-licence-holders-worker.md)).
  `reassignLicense(ctx, { product, licenseId, toAccountId: null, actor, expectedPreviousAccountId })`
  (`accounts/claim.ts`) already writes `license_auto_attach_blocks` (and its
  `account.license.auto_attach_block` row) for the account it moves the licence away from, and lifts
  the block of the account it moves a licence into, so the undo (`reassignLicense` back to
  `from_account_id`) deletes it. The Worker's Make floating is therefore I-12's relink with
  `toAccountId: null` (today's relink requires a target subject) plus clearing `name` and `email`,
  with the undo restoring them. It writes and deletes no block row of its own.
- **The "In an account" filter is `holder=inAccount`** ([LX-26](LX-26-licence-holders-worker.md)):
  `assigned` also covers a licence waiting on its email, so LX-26 added a fourth value. An unknown
  value is `400 bad_request` (`fields: ["holder"]`).

## Changed by plan PX-W9 (2026-10-06)

[`plans/PX-W9.md`](../plans/PX-W9.md) revision 2 was approved by the lead under the owner's delegation on 2026-10-06. These notes win over the text of this brief where they differ.

- **The "Key entries" row.** On a licence with no account, and with Identity on, the licence record shows "Key
  entries {used} of {limit}" from the `keyEntries` member PX-W9 adds to the admin licence read
  (`admin/lib/shape.ts`). It is `null` with Identity off, so hide the row. Show the true `used` even past the
  limit, with no negative "left". The row sits beside the holder line.
- **Not in scope.** No reset action and no per-licence limit (PX-W9 Q7). Operators raise the product's
  `identity.keyEntry.limit`.

## Corrections from the code (as built, 2026-10-06)

Where the brief and the code disagreed, the code was the fact:

- **Send a new key… and Assign's Email them the key are not built.** Both use LX-27's
  `POST …/licenses/<id>/send-key`, and LX-27 is still `todo` (it is not one of this package's
  dependencies). A console action may not call a route that does not exist, so the two entry points
  move to LX-27 (recorded in its brief). Assign sets the name and email only.
- **Reassign is by email, keyed by the licence.** I-12's relink names its target by a pairwise
  subject and needs the licence to be in an account; S-24 §5.2 and §5.5 reassign to another email,
  from an account or from a waiting address. So the Worker gains three Core admin routes beside
  I-12's relink (`admin/handlers/users.ts`, logic in Identity's `accounts/productUsers.ts`):
  `POST …/users/licenses/<id>/make-floating` `{reason, confirm, signOutDevices?}`,
  `POST …/users/licenses/<id>/reassign` `{email, name?, reason, confirm}` and
  `GET …/users/licenses/<id>/relinks` (the licence's moves with their undo). Both writes take the
  step-up, a reason, the daily per-operator alert and a `license_relinks` row; the existing
  `POST …/users/relinks/<id>/undo` undoes them, restoring the account, `name` and `email`. Make
  floating writes no block row of its own: `reassignLicense(toAccountId: null)` does, and the undo's
  move back lifts it. Reassign runs Core's `associateLicenseHolder` (S-24 D3) and answers the same
  whether or not the new address joined an account (D4). Audit actions `user.license.make_floating`
  and `user.license.reassign`.
- **The typed confirmation is the licence's name, else its id**, and the Worker compares it
  (`400 bad_request`, `reason: confirm_required`). There is no "key ending" to type: keys are
  stored only as peppered hashes, so nothing knows a key's last characters.
- **Storage:** one migration, `0104_license_relinks_holder.sql` (the lead's number), adding
  `license_relinks.holder_json` (the before and after name and email, for the undo); `LATEST_MIGRATION`
  names it. `to_subject` is `NOT NULL` in 0082, so a move that leaves the licence with no account
  writes `''`, read back as no subject.
- **"Also sign out its devices"** deauthorizes each device after the move (`deauthorizeDeviceAsAdmin`,
  one `device.deauthorize` audit row each), not in the same D1 batch.
- **LX-28's follow-ups are built here:** the batch list pages (`?limit=1..500&cursor=`, default 100,
  `nextCursor`), Disable unused keys checks an optional `confirm` against the batch label (the
  console always sends it), and the activity verbs `license.holder.assign`, `license.batch.create`,
  `license.batch.disable_unused`, `account.license.auto_attach_block` and the relink tool's verbs,
  with a `license_batch` target kind and a "Users and license holders" action group.
- **Batches get a collection page** (`#/p/<slug>/license/batches`, not in the sidebar) besides the
  batch page, reached from Licenses' **Batches** action and the Batch filter. The Licenses list's
  Batch column starts hidden below 1440 px (the layout lint's sideways-scroll rule).
- **Rule 10:** the three routes, the batch list's parameters and the disable-unused body are in the
  OpenAPI spec and `routeCoverage`'s `products` table (I-12's own relink routes stay narrative); the
  docs site's `admin/users.md` documents them.
- **Edit holder** stays on an assigned licence and edits the name only, and the Worker's `PATCH` now
  refuses what Edit holder no longer offers (review B3): changing the email of a licence that has one
  to another address is `400 bad_request` (`fields: ["email"]`, "use Reassign"). A case-only edit, a
  first email on a floating licence (Assign) and a first email on an in-account licence stay a PATCH.
  LX-26's test that edited a removed licence's email now expects the refusal and goes through
  Reassign instead.
- **Review fix round (2026-10-07):** a product deletion deletes its `license_relinks` rows (they
  hold names, emails and account ids); Make floating writes its relink row and the handler its
  audit row and alert BEFORE signing devices out, and a sign-out that fails partway answers 200
  with the count it reached (the undo and the audit stay); focus moves to the page heading after an
  undo removes its note; the Users page names a holder move's account-less side "an email address".

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Already stamped done on main (2eb10597c); the hygiene PR leaves it. Merged (5786044f1). Already the holder surface of the target model (in an account / waiting / floating).

## Goal

An operator can see who holds each licence (or that it is floating), filter by holder and batch,
assign a floating licence, send a fresh key, reassign or make a licence floating with a typed
confirmation, and contain a leaked batch.

## Why

[S-24](../../notes/S-24-licence-holders.md) §5.5, §5.6 and §8.8: the two holder states need to be
visible and changeable after creation, and reassignment must go through one audited primitive
(I-12's relink tool over `reassignLicense`) rather than an edit of the email (D20).

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §5.5, §5.6, §8.8 (D5, D19, D20); frames 76–77 in
  [`docs/design/licenses/`](../../../../design/licenses/).
- [I-12](I-12-console-users.md) (relink tool: step-up, reason, notice, 72-hour undo);
  `services/identity/accounts/claim.ts` (`reassignLicense`).
- [ADMIN.md](../../../../design/ADMIN.md) §6.5.1–§6.5.2 (amended); EXPERIENCE.md L1–L3.
- `packages/admin/src/console/pages/license/LicensesPage.tsx`, `LicenseRecord.tsx`,
  `LicenseDialogs.tsx` (Edit holder).

## Scope

**In:**

- **Licenses list**: a **Holder** column (name and email, **Floating** muted, or "Waiting ·
  ada@…"), filters **Holder** (Anyone, In an account, Waiting, Floating) and **Batch**; batch
  licences link to their batch.
- **Record header**: the holder line; **Assign…** on a floating licence (name, email, and **Email
  them the key**, which uses LX-27's `send-key`); overflow **Send a new key…** (assigned),
  **Reassign…** and **Make floating…** through I-12's tool, each L3 with the typed licence name or
  key ending; Make floating offers **Also sign out its devices** (off).
- **Make floating** on the Worker: I-12's relink with `toAccountId: null` that also clears `name`
  and `email`, its undo restoring them (and deleting LX-26's block row it created); OpenAPI if the
  relink route gains a member.
- **Batch page**: label, created, by whom, used of count, the sentence "Keys can't be downloaded
  again", **Disable unused keys…** (L3, typed batch label).
- Edit holder no longer edits the email of an assigned licence (that is Reassign); it edits the name
  and, on a floating licence, becomes **Assign…**.

**Out:**

- The wizard (→ LX-29); Worker holder model (→ LX-26); batches API (→ LX-28).

## Design notes

- Copy: "Floating · anyone with the key", "In an account", "Waiting for ada@example.com". The
  console never says whether a waiting email has an account (S-24 D4).
- Reassign's notice goes to the old and the new address; the undo window is I-12's 72 hours.

## Steps

1. List column and filters; record holder line.
2. Assign, Send a new key, Reassign and Make floating (with the Worker's Make floating).
3. Batch page and Disable unused; tests and screenshots.

## Acceptance criteria

- [x] Each holder state renders correctly on the list and the record (tests, screenshots in both
      themes).
- [x] Reassign and Make floating require step-up, a reason and the typed confirmation, and can be
      undone within 72 hours (tests).
- [x] Disable unused disables only never-used licences of the batch (test).
- [x] Console CSP parity and the green gate pass (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- relink license
```

## Hand-off

LX-31 documents the holder surfaces.

Follow-ups recorded by the LX-30 review (2026-10-07), none blocking:

- The undo is not one D1 batch (the owner move, the name and email restore and the undone mark are
  separate writes), the same class as I-12's relink.
- Notices go out before the compare-and-set, so a move that then answers `conflict` has already
  told both sides (I-12's class too).
- A keyless licence made floating (no key ever handed out) is unreachable by anyone once the 72-hour
  undo closes; consider a warning in Make floating when the licence has no active key.
- The Licenses table remounts once when the first batch read lands (its Batch column); focus
  inside the table at that instant is lost.

The role agent sets `--set LX-30 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-30
done`.
