# PX-23 Portal: add a floating key with its devices ("It's on 2 devices already. They come with it."), the licence card's origin wording ("Key ending …", "<Store> key ending …", "From <Developer>"), and **Remove from my library** saying it becomes floating and stays out

| Field       | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)   |
| Size        | 0.4–0.6 engineer-weeks                                                       |
| Depends on  | [PX-17](PX-17-activate-confirm.md), [LX-26](LX-26-licence-holders-worker.md) |
| Unblocks    | [LX-31](LX-31-holders-closeout.md)                                           |
| Role        | `pkey-implementer`                                                           |
| Plan mode   | no                                                                           |
| Gates       | portal e2e in both themes at 1440 and 390; console CSP parity                |
| Human input | none                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                    |

## Corrections (as built, 2026-10-06)

Where the brief and the code disagreed, the code was the fact; the lead's review follow-ups and an
owner request joined the scope:

- **The Remove copy says "not in an account", not "becomes a floating license".** LX-26 keeps a
  removed licence's email, so it is assigned and waiting, and customers never read "floating"
  (S-24 D5). The dialog words it per licence: "It won't be in an account, and it won't come back
  to this account by itself. To add it again, use its key." (the developer named someone), and
  "It won't be in an account: anyone with the key can add it, and it won't come back to this
  account by itself." (a key the person added to a licence nobody was named for).
- **There was no portal Remove on `main`.** PX-23 adds `DELETE /api/licenses/<p>/<id>` over
  LX-26's `detachLicense` (rule 10: OpenAPI and `routeCoverage`; `reference/routes.mdx`
  regenerated), and the UI: the last item of the product header's overflow menu (PORTAL.md
  §4.20), a confirmation dialog.
- **Lead decision on S-24 D19 (delegated, 2026-10-06):** after an explicit Remove, the removing
  account's devices lose their Cloud Sync principal for that licence. `resolveSyncPrincipal`
  (`core/accountSubjects.ts`) now reads the auto-attach block, with tests, THREAT-MODEL (U-02,
  LX-26 and the preview) and a dated amendment in S-24 §10.
- **Owner request (2026-10-06):** the card's origin moved from the meta line under the tier into
  the facts grid as **License source**, beside Activated, and the repeated term went ("Updates
  included" says it). Every product-page visual baseline changed with it.
- **Key endings ("Key ending {last6}") wait for G7.** The Worker stores keys only as peppered
  hashes and no last characters, so a key the person added reads "Added with a key" and a store
  key "Steam key"; the card already words an ending when a key carries one.
- **The preview also answers `cloudSync`**, so Done says "Sign in on them to turn on Cloud Sync."
  only for a product that runs it; `devices` is answered only for `addable`.
- **"From signing in"** keeps its existing rule (an OIDC-issued licence with no key), and an
  origin a portal build does not know reads by the older facts.

## Goal

Adding a floating key in Polaris Key says that the devices it is already on come with it, the
licence card names how the licence reached the person in plain words, and removing a licence from
the library says it becomes floating and will not come back by itself.

## Why

[S-24](../../notes/S-24-licence-holders.md) §10: the claim exists (PX-06, PX-17), but a floating
key with devices reads like a new licence, a developer-assigned licence reads "Key ending …" like a
key the person typed, and Remove is silently undone today (H5, fixed in LX-26).

## Read first

- AGENTS.md and CLAUDE.md.
- [S-24](../../notes/S-24-licence-holders.md) §10 (D19, D21, D22); frames 80–81 in
  [`docs/design/licenses/`](../../../../design/licenses/).
- [PORTAL.md](../../../../design/PORTAL.md) §4.17, §4.19, §4.20, §4.26 (amended); SIGN-IN.md O-11,
  O-17; [PX-17](PX-17-activate-confirm.md).
- `packages/admin/src/portal/components/ActivateDialog.tsx`, `LicenseCard`,
  `services/identity/portal/selfService.ts` (preview answer).

## Scope

**In:**

- The activate preview answers `devices: n` for a floating licence that is already bound somewhere
  (a count only, no labels); Confirm adds "It's on {n} devices already. They keep working and come
  with it."; Done adds "Its {n} devices came with it." and, when the product has Cloud Sync, "Sign in
  on them to turn on Cloud Sync."
- Licence card origins: "Key ending {last6}" (added by the person), "{Store} key ending {last6}",
  "From {Developer}" (a licence the developer assigned, `holder` assigned at creation), "From
  signing in"; the Worker reports which (`origin: "key" | "store-key" | "developer" | "signin" |
…`) in the portal's licence summary.
- **Remove from my library** gains "It becomes a floating license: anyone with the key can add it,
  and it won't come back to this account by itself."

**Out:** the Worker holder model and the block (→ LX-26).

## Steps

1. Preview `devices`, summary `origin`; tests.
2. Dialog and card copy; Remove copy; e2e and screenshots.

## Acceptance criteria

- [ ] Adding a floating key with devices shows the count on Confirm and Done (e2e).
- [ ] Each origin renders its wording (tests, screenshots in both themes).
- [ ] After Remove, the licence stays out of the library across reloads (e2e, with LX-26).
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- portal
```

## Hand-off

LX-31's e2e ends on this page.

The role agent sets `--set PX-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-23
done`.
