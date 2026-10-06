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

- [ ] Each holder state renders correctly on the list and the record (tests, screenshots in both
      themes).
- [ ] Reassign and Make floating require step-up, a reason and the typed confirmation, and can be
      undone within 72 hours (tests).
- [ ] Disable unused disables only never-used licences of the batch (test).
- [ ] Console CSP parity and the green gate pass (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- relink license
```

## Hand-off

LX-31 documents the holder surfaces.

The role agent sets `--set LX-30 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-30
done`.
