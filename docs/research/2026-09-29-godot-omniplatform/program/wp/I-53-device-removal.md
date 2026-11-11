# I-53 Remove a licence-less device in Polaris Locker, 'Signed in from backup', and the notice's Remove action (DEVICE-REMOVAL)

| Field       | Value                          |
| ----------- | ------------------------------ |
| Phase       | I: Identity (S-16)             |
| Size        | 0.4–0.8 engineer-weeks         |
| Depends on  | [I-49](I-49-silent-restore.md) |
| Unblocks    | none                           |
| Role        | `pkey-implementer`             |
| Plan mode   | no                             |
| Gates       | security-review                |
| Human input | none                           |
| Repo        | vladzaharia/polaris-key        |

## Goal

Account to Devices: GET and DELETE /api/me/devices, DR.1 on the A5 base.

## Plan

plans/DEVICE-REMOVAL.md (lead plan, 2026-10-31; lives in the lead directory, not in the repo)

## Acceptance criteria

- [x] DR.1 to DR.5 and their follow-ups were already on `next` (commits `DEVICE-REMOVAL.1` to `.7`, merged as `3c6e3749c6`, Linux baselines `652672e4bd`); verified, no further code.
- [x] Correction to the plan: the routes are `GET /api/me/devices` and `DELETE /api/me/devices/{product}/{deviceId}` (not `/api/account/devices`); the plan's `releaseAccountDevice` signature became `(req, env, db, actor, product, device, now, opts)`, with `freeLicenselessDevice` as the licence-less entry point.
