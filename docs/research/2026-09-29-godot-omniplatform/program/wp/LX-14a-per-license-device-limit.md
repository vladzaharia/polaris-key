# LX-14a Per-license device limit: `licenses.device_limit` set through the admin API and a console **Device limit…** action (raise, lower, clear to inherit); the console shows the effective limit and its source; a license limit beats the tier

| Field       | Value                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (phase A: independent fixes)                        |
| Size        | 0.4–0.6 engineer-weeks                                                                                         |
| Depends on  | none                                                                                                           |
| Unblocks    | [LX-14](LX-14-console-licensing.md), [LX-27](LX-27-create-limit-delivery.md)                                   |
| Role        | `pkey-implementer`                                                                                             |
| Plan mode   | no                                                                                                             |
| Gates       | D1 migration; rule 10 (OpenAPI + `routeCoverage`); `TABLE_OWNERS`; console CSP parity; THREAT-MODEL; docsLinks |
| Human input | none                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                      |

## S-24 amendment (2026-10-06)

Refusing `deviceLimit` on create stays right for this package; [LX-27](LX-27-create-limit-delivery.md) lifts the refusal so the New License wizard can set a licence's device limit at creation, with the same validation and precedence ([S-24](../../notes/S-24-licence-holders.md) §8.4).

## Goal

An operator can raise or lower the device limit of one existing licence, from a key or from signing in, from
the console and the admin API, clear it to inherit again, and always see the limit the Worker
actually enforces and where it comes from.

## Why

Owner decision (2026-10-05): sign-in licenses stay device-limited (and, the same day, no
'Account-wide' label: every licence is account-bound; origin shown as plain words), and "an administrator can
change the numbers as needed" (SIGN-IN.md D-53, `plans/I-04.md` §F.6). On `main` the console
changes the number only for a whole product (Settings, "Default device limit") or a whole tier
(TierForm, "Device limit"). For one licence the only routes are **Change tier** or a `deviceLimit`
entitlement override (`PUT …/license/licenses/<id>/overrides`), which needs a catalog `deviceLimit`
flag, loses to any tier limit (`core/entitlements.ts` `injectAdminPolicy`), and is never shown: the
console's seat count reads tier, else product. This package is split out of LX-14 so the gap closes
now instead of after LX-06, LX-09, LX-10, LX-11 and LX-12. LX-14 keeps **Add seats…** (the
temporary raise through seat-pack grants).

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) D-53; [`plans/I-04.md`](../plans/I-04.md) §F.6.
- [`docs/design/EXPERIENCE.md`](../../../../design/EXPERIENCE.md) O1 (the licence record), item 5.
- [S-19 §7.2](../../notes/S-19-licensing-model.md) (seat packs are licence-held) and C2 (under `combined` the licence value wins over the tier).
- Code: `packages/worker/src/core/authz.ts` `licenseDeviceLimit` and `authorizeDevice`;
  `core/entitlements.ts` `injectAdminPolicy`; `core/payload.ts` `resolveMergedPayload`;
  `services/license/admin/licenses.ts` (PATCH, the `overLimit` answer of a tier change);
  `packages/shared-manifest/src/reservedNames.ts` (the `deviceLimit` precedence text);
  `packages/admin/src/console/pages/license/shared.tsx` `effectivePolicy`, `LicenseDevices.tsx`
  `seatLimitOf`, `LicensesPage.tsx`, `LicenseTerms.tsx`.

## Scope

**In:**

- **Column.** A D1 migration (next free number) adds `licenses.device_limit INTEGER NULL`, a
  positive integer or `NULL` (inherit). `TABLE_OWNERS` and the generated reference follow.
- **Precedence (decided here):** the licence's `device_limit`, else the tier's
  `policy_device_limit`, else a `deviceLimit` entitlement (profiles, store grants, licence
  overrides), else the product default. The licence value is the most specific, so it beats the
  tier. `licenseDeviceLimit` and `injectAdminPolicy` apply it, so the signed licence document's
  `deviceLimit` entitlement carries the same resolved number (its shape does not change; no
  device-wire change, `PROTOCOL_VERSION` 4, no corpus change). Update the `reservedNames.ts` text
  and ADMIN.md to match.
- **Admin API.** `PATCH /manage/api/products/<slug>/license/licenses/<id>` accepts
  `deviceLimit: <positive integer> | null` (`null` clears it). The licence read answers
  `deviceLimit` (the stored value), `effectiveDeviceLimit` and
  `deviceLimitSource: "license" | "tier" | "entitlement" | "product"`. Lowering below the active
  devices answers success with the `overLimit` shape the tier change already uses. OpenAPI and
  `routeCoverage` (rule 10).
- **Audit.** Each change writes `license.device_limit.set` with the old and new values (or
  "inherit").
- **Console.** On the licence record, **Device limit…** opens a sheet: a number field with the
  inherited value as placeholder ("Inherits 5 from Pro"), **Save** and **Use inherited limit**.
  Below the active device count it warns "4 devices are signed in. None is signed out; new devices
  are refused until the count is under 3." It never deauthorizes a device. The seat meter, the
  Effective policy row and the licences list show the effective limit with its source ("3 · set on
  this license", "5 · from Pro", "5 · product default"), replacing tier-else-product.
- Works for every licence, including sign-in licences; OIDC sign-in never resets the
  column (LX-02 already stops sign-in rewriting an existing licence's tier).

**Out** (and where it belongs instead):

- **Add seats…**, seat-pack grants and the Grants tab (→ LX-14, on LX-13's grants).
- The `combined` resolver (→ LX-09): it reads `licenses.device_limit` as the licence value of
  S-19 C2, with seat packs adding on top.
- Portal display (already reads `seats.limit` from the Worker).

## Design notes

- Positive integers only, the same rule as `invalidDeviceLimit` in `services/license/admin/tiers.ts`.
- The limit applies at the next authorization: existing devices keep their seats, as with a tier
  change.
- THREAT-MODEL: one line under licence administration (an operator with licence write can raise one
  licence's seats; audited).

**Corrections from the code (implementation, 2026-10-05):**

- Rule 10 does not apply: `packages/worker/openapi/polaris-key.v3.yaml` documents the device and
  portal surfaces only, never `/manage/api/*`, and this package adds no route (the field rides
  the existing licence `PATCH`). `routeCoverage` is unchanged; the admin API is documented in
  `admin/licenses-and-devices.md` instead.
- `TABLE_OWNERS` needs no entry: `licenses` is already License's; the generated data-model page
  picks up the column (`device_limit (0084)`).
- The licence read also answers `inheritedDeviceLimit` and `inheritedDeviceLimitSource`, which
  the sheet's placeholder ("Inherits 5 from Pro") and **Use inherited limit** need.
- `reservedNames.ts` is bundled into `actions/publish/dist`, so the bundle is regenerated with it.

## Steps

1. Migration, repo read/write, precedence in `licenseDeviceLimit` and `injectAdminPolicy`, tests.
2. Admin API field, read fields, audit, OpenAPI, `routeCoverage`.
3. Console sheet and effective-limit display; ADMIN.md and `reservedNames.ts` text.

## Acceptance criteria

- [ ] A licence limit beats the tier and product default for `authorizeDevice` and for the licence
      document's `deviceLimit`; `null` inherits again (tests, including a sign-in licence).
- [ ] Lowering below the active devices signs nobody out and refuses the next new device (test).
- [ ] Each change writes an audited event with old and new values (test).
- [ ] The console shows the effective limit and its source on the record, the meter and the list.
- [ ] Console CSP parity passes.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- LX-14 builds **Add seats…** on top and shows "4 · 3 set on this license + 1 comp until 4 Nov".
- LX-09 reads the column in the `combined` resolver.

The role agent sets `--set LX-14a in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-14a done`.
