# DOC-05b Help: library and devices

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

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-05b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `library`, `add-a-license`, `discover`, `lost-key`, `license-status`, `remove-from-library`, `devices`, `new-computer`, `device-limit`, `offline-activation`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

portal Library, Discover, Product, Devices, `ActivateDialog.tsx`, `FreeDevicePage.tsx`; the 90-day dormant release; `keyReissueEnabled`; the kits' offline-activation screens and baselines

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Screen acceptance (brand transition, 2026-10-09)

N/A: no screen or state ships in this package (selected by the overview-04 rule on its gate or mention only).

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] The plain-language critic pass.
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

The role agent sets `--set DOC-05b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-05b done`.

## Corrections (2026-10-11)

Found while checking the brief against the code. Each is a plan claim the code contradicts; the pages say what the code does.

- **Lost key.** The plan says the portal shows the key's last 4 characters and offers **Get a new key**. Neither ships. The Worker never sends `last4` (no `last4` in `packages/worker/src`), so the License card shows `pkey_<app>_…` and says the full key can't be shown again (`LicenseCard.tsx`). `POST /api/licenses/<product>/<id>/keys` and `canGetNewKey` exist behind `keyReissueEnabled` (off by default), but no portal component calls them (`LicenseCard.tsx`: "Get a new key waits for G7"). The page sends the reader to the app's developer, who can mint a new key (console Keys tab). The package that ships the portal control adds it to the page.
- **Discover.** The plan lists agreeing to the app's terms (`terms_required`). Discover and the storefront page have no terms step; `terms_required` is the sign-in card's account creation (`services/identity/card/gate.ts`). Not written here.
- **Library.** The plan's **What's New** label cannot be quoted: the docs lint's time-word rule bans "what's new" in prose. The page says "release notes".
- **Screenshots.** No page carries one. `PortalShot` has no styles yet, so both themes would show at once, and only the two terminal kits record an OfflineActivation baseline while `<KitBaselines>` is a developer block (kit tabs, repository paths). Candidate states stay as the plan lists them for when the components are styled.
- **Anchor title.** The plan's `email_mismatch` anchor title "Email doesn't match" differs from the catalog title "Email not verified"; `site-map.json` now mirrors the catalog.
- **Tests.** `slugManifest.test.ts` used `add-a-license` as its stub fixture; it now reads whichever stubs the manifest holds. `devices` keeps the legacy `seat-limits` heading id because `help/messages/index.md` links to `/docs/users/devices/#seat-limits`.
- **Removal.** Only a Discover offer that needs no license (an `open` listing, tile **Free to use**) makes a library entry that **Remove from library** can take out (`RemoveEntryConfirm.tsx`). The default Discover paths mint a license, and the Worker never lets a Discover claim or a sign-in license be removed (`origin.ts` `notRemovableReason`; `ProductPage.tsx` passes `onRemove` only for `removable`). `remove-from-library` limits **Remove from library** to a free app that needs no license and names Discover licenses under "If there is no remove option".
- **Refusal buttons.** The dialog never shows **Sign in to that account**: no portal endpoint sends `signInUrl` (`selfService.ts` preview and `licenseOwned()`), and the portal client keeps no other error fields (`api.ts`). A `license_owned` refusal offers **Use a different key**; `email_mismatch` adds **Add and verify that email**. The worker only sends `signInUrl` on the app wire (`core/licensing/keyEntries.ts`).
- **Device limit.** The plan's "**Replace a device** in the app" is the control every kit shows on the key path when the Worker sent a link (`ui-core/src/models/activate.ts`, Kotlin `PolarisGate.kt`, React `theme.ts`, Godot `pkey_ui_copy.gd`); **Open in browser** is only DeviceLimit's browser-mode label. The link exists only while the product's customer portal is on (`core/licensing/manageUrl.ts`); otherwise the app says to sign out on another device (`deviceLimit.noManage`) and the library may not list the app. The page names the button and adds that branch.
- **Devices.** "Renaming happens in the app" holds only on the device in hand: a device token manages only its own device (`core/devices.ts`, "a device token may only manage its own device"), and several kits draw no rename control. A device unseen for 90 days stops counting, but activating it again skips the seat check, because its row is still authorized on the license (`core/devices.ts` `isNewAuthorization`; `releaseDormantSeats` ends its token), so the page says only that the app may ask to activate or sign in again and that it counts again.
- **Offline activation.** **Activate from file** exists in the shared copy catalog only. The shipped screens read **Load file…** (SwiftUI gate, which imports as soon as a file loads) and **Activate** (Godot); terminal apps use `offline-request` and `import-bundle`. The offline account view has no Sign out (`ui-core/src/models/settings.ts`), and a bundle install has no device row (`console/handlers/bundles.ts`), so Undo names the terminal `deactivate` command only.
- **License status.** **Renew** has no button the pages can name: the SwiftUI gate draws **Renew or manage** only when the host sets `GateOptions.renewURL` (`PolarisGate.swift`, `PolarisKitCopy.swift`), `ui-core` models a renew action, and Compose says "No renew link exists on the device side" (`PolarisGate.kt`), so the page points to the developer. **Works offline for** shows only when the license sets the days (`LicenseCard.tsx`). An ended license shows **Signed out** once the app can reach the service and **License expired** only when it cannot (`client-core/src/gate.ts`, `worker/src/core/devices.ts` `licenseUsable`).
